const { getSupabaseClient } = require('../../lib/supabase');

const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

// Visit this URL once in your browser (via the Strava authorize link)
// to grant access and store your first refresh token in Supabase.
// After this runs successfully, the webhook can refresh tokens on its
// own — you should never need to hit this endpoint again unless you
// revoke access on Strava's side.
module.exports = async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    res.status(400).send(`Strava authorization was denied: ${error}`);
    return;
  }

  if (!code) {
    res.status(400).send('Missing ?code param — this endpoint should only be hit via the Strava OAuth redirect.');
    return;
  }

  try {
    const resp = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      res.status(500).send(`Strava token exchange failed: ${resp.status} ${text}`);
      return;
    }

    const tokenData = await resp.json();
    const supabase = getSupabaseClient();

    const { error: upsertError } = await supabase
      .from('strava_tokens')
      .upsert({
        id: 1,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_at,
        updated_at: new Date().toISOString(),
      });

    if (upsertError) {
      res.status(500).send(`Saved token exchange but failed to write to Supabase: ${upsertError.message}`);
      return;
    }

    res.status(200).send(
      'Strava connected. Your tokens are stored — you can close this tab. Next step: register the webhook subscription.'
    );
  } catch (err) {
    res.status(500).send(`Unexpected error: ${err.message}`);
  }
};
