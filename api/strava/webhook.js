const { getSupabaseClient } = require('../../lib/supabase');
const { getValidAccessToken, fetchActivity, mapActivityToRun } = require('../../lib/strava');

module.exports = async (req, res) => {
  // --- Strava's one-time subscription verification (GET) ---
  // Strava calls this once, right after you register the webhook,
  // to prove you control this URL. Must echo back hub.challenge.
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
    // Strava expects a fast 200 response — acknowledge immediately,
    // then do the work. If Strava doesn't get a quick response it
    // will retry, which could cause duplicate processing (harmless
    // here since we upsert on strava_id, but best avoided).
    res.status(200).send('EVENT_RECEIVED');

    const event = req.body;

    try {
      // Only care about newly created activities.
      if (event.object_type !== 'activity' || event.aspect_type !== 'create') {
        return;
      }

      const accessToken = await getValidAccessToken();
      const activity = await fetchActivity(event.object_id, accessToken);

      // Only sync runs — skip rides, swims, weight training, etc.
      if (activity.type !== 'Run' && activity.sport_type !== 'Run') {
        return;
      }

      const run = mapActivityToRun(activity);
      const supabase = getSupabaseClient();

      const { error } = await supabase
        .from('runs')
        .upsert(run, { onConflict: 'strava_id' });

      if (error) {
        console.error('Failed to upsert run:', error.message);
      }
    } catch (err) {
      // Response is already sent — just log for debugging in Vercel's
      // function logs.
      console.error('Webhook processing error:', err.message);
    }

    return;
  }

  res.status(405).send('Method not allowed');
};
