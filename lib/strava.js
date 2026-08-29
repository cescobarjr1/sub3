const { getSupabaseClient } = require('./supabase');

const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

// Returns a valid (non-expired) access token, refreshing it via Strava
// and rewriting strava_tokens in Supabase if the old one has expired.
async function getValidAccessToken() {
  const supabase = getSupabaseClient();

  const { data: row, error } = await supabase
    .from('strava_tokens')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !row) {
    throw new Error('No strava_tokens row found — complete the OAuth step first.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  // Strava tokens are valid for 6 hours. Refresh a bit early (5 min buffer).
  if (row.expires_at - 300 > nowSeconds) {
    return row.access_token;
  }

  const resp = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Strava token refresh failed: ${resp.status} ${text}`);
  }

  const fresh = await resp.json();

  const { error: updateError } = await supabase
    .from('strava_tokens')
    .update({
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token,
      expires_at: fresh.expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (updateError) {
    throw new Error(`Failed to save refreshed token: ${updateError.message}`);
  }

  return fresh.access_token;
}

// Fetches full activity detail from Strava for a given activity id.
async function fetchActivity(activityId, accessToken) {
  const resp = await fetch(`${STRAVA_API_BASE}/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Strava activity fetch failed: ${resp.status} ${text}`);
  }

  return resp.json();
}

// Fetches the raw time/distance/heartrate streams for an activity, used to
// build per-mile splits. Not every activity has every stream (no HR device,
// or a non-GPS activity with no distance/time), so callers must handle a
// response missing one or more keys.
async function fetchActivityStreams(activityId, accessToken) {
  const resp = await fetch(
    `${STRAVA_API_BASE}/activities/${activityId}/streams?keys=time,distance,heartrate&key_by_type=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Strava streams fetch failed: ${resp.status} ${text}`);
  }

  return resp.json();
}

const METERS_PER_MILE = 1609.34;
const MIN_TRAILING_MILE = 0.2; // drop a trailing sliver shorter than this

// Buckets aligned time/distance/heartrate streams into 1-mile splits.
// Pace per split is derived from that split's own elapsed time (not
// averaged instantaneous velocity), since that's what actually answers
// "was this mile run at X pace." avg_hr/max_hr are computed from whichever
// heartrate samples fall inside the split; both are null if the activity
// has no heartrate stream.
function computeMileSplits(streams) {
  const distanceData = streams && streams.distance && streams.distance.data;
  const timeData = streams && streams.time && streams.time.data;
  const hrData = (streams && streams.heartrate && streams.heartrate.data) || null;

  if (!distanceData || !timeData || distanceData.length < 2) {
    return [];
  }

  const splits = [];
  let bucketStartIdx = 0;
  let nextBoundary = METERS_PER_MILE;
  const lastIdx = distanceData.length - 1;

  for (let i = 0; i < distanceData.length; i++) {
    const isLast = i === lastIdx;
    if (distanceData[i] >= nextBoundary || isLast) {
      const bucketDistMeters = distanceData[i] - distanceData[bucketStartIdx];
      const bucketMiles = bucketDistMeters / METERS_PER_MILE;

      // Only keep this bucket if it's a full mile, or a trailing partial
      // mile long enough to be meaningful.
      if (bucketMiles >= MIN_TRAILING_MILE) {
        const bucketTimeSec = timeData[i] - timeData[bucketStartIdx];
        const hrSlice = hrData ? hrData.slice(bucketStartIdx, i + 1) : [];
        const avgHr = hrSlice.length
          ? Math.round(hrSlice.reduce((a, b) => a + b, 0) / hrSlice.length)
          : null;
        const maxHr = hrSlice.length ? Math.max(...hrSlice) : null;

        splits.push({
          mile: Number((distanceData[i] / METERS_PER_MILE).toFixed(2)),
          pace_sec: bucketMiles > 0 ? Math.round(bucketTimeSec / bucketMiles) : null,
          avg_hr: avgHr,
          max_hr: maxHr,
        });
      }

      bucketStartIdx = i;
      nextBoundary += METERS_PER_MILE;
    }
  }

  return splits;
}

// Maps a Strava activity object to the shape of our `runs` table.
// Only syncs actual runs — everything else (rides, swims, weight
// training) is skipped by the caller before this is used.
//
// Classification priority:
//   1. Strava's own workout_type flag, when the athlete has set it
//      (1 = Race, 2 = Long Run) — most reliable signal available.
//   2. Distance >= 10mi — treated as a long run regardless of pace,
//      since that's how long runs are defined for training purposes.
//   3. Otherwise, average pace against personal training zones:
//      faster than 6:20/mi = speed/interval work, 6:20-6:50/mi =
//      tempo/threshold, slower = easy. These bands are calibrated to
//      a ~6:52/mi marathon goal pace — adjust PACE_SPEED_MAX and
//      PACE_TEMPO_MAX below if the goal pace changes.
const PACE_SPEED_MAX = 380; // sec/mi — faster than this = speed
const PACE_TEMPO_MAX = 410; // sec/mi — faster than this = tempo

function mapActivityToRun(activity) {
  const distanceMiles = activity.distance / 1609.34;
  const dateOnly = activity.start_date_local
    ? activity.start_date_local.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  let type = 'easy';

  if (activity.workout_type === 1) {
    type = 'race';
  } else if (activity.workout_type === 2 || distanceMiles >= 10) {
    type = 'long';
  } else if (activity.moving_time && distanceMiles > 0) {
    const paceSecPerMile = activity.moving_time / distanceMiles;
    if (paceSecPerMile < PACE_SPEED_MAX) {
      type = 'speed';
    } else if (paceSecPerMile < PACE_TEMPO_MAX) {
      type = 'tempo';
    }
  }

  return {
    strava_id: String(activity.id),
    date: dateOnly,
    type,
    distance: Number(distanceMiles.toFixed(2)),
    time: activity.moving_time,
    notes: activity.name || null,
    source: 'strava',
    avg_heartrate: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
  };
}
module.exports = {
  getValidAccessToken,
  fetchActivity,
  fetchActivityStreams,
  computeMileSplits,
  mapActivityToRun,
};
