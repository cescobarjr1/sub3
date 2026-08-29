const { getSupabaseClient } = require('../../lib/supabase');
const {
  getValidAccessToken,
  fetchActivity,
  fetchActivityStreams,
  computeMileSplits,
  mapActivityToRun,
} = require('../../lib/strava');

module.exports = async (req, res) => {
  // --- Strava's one-time subscription verification (GET) ---
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
      res.status(200).json({ 'hub.challenge': challenge });
    } else {
      res.status(403).send('Verification token mismatch.');
    }
    return;
  }

  // --- Real-time activity events (POST) ---
  if (req.method === 'POST') {
    const event = req.body;
    console.log('DEBUG webhook body:', typeof req.body, JSON.stringify(req.body));

    try {
      if (event.object_type === 'activity' && event.aspect_type === 'create') {
        const accessToken = await getValidAccessToken();
        const activity = await fetchActivity(event.object_id, accessToken);

        console.log('DEBUG fetched activity type:', activity.type, activity.sport_type);

        if (activity.type === 'Run' || activity.sport_type === 'Run') {
          const run = mapActivityToRun(activity);

          // Splits are a bonus on top of the base sync — never let a
          // streams failure stop the run itself from being saved.
          try {
            const streams = await fetchActivityStreams(activity.id, accessToken);
            run.splits = computeMileSplits(streams);
          } catch (splitsErr) {
            console.error('Failed to fetch/compute splits:', splitsErr.message);
            run.splits = null;
          }

          const supabase = getSupabaseClient();

          const { error } = await supabase
            .from('runs')
            .upsert(run, { onConflict: 'strava_id' });

          if (error) {
            console.error('Failed to upsert run:', error.message);
          } else {
            console.log('DEBUG run upserted successfully:', run.strava_id);
          }
        }
      }
    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }

    // Respond only after the work above has actually finished, so the
    // function isn't torn down mid-flight.
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  res.status(405).send('Method not allowed');
};
