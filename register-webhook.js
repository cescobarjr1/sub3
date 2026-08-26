// Run this ONCE, locally, after your backend is deployed to Vercel and
// the OAuth callback has been completed at least once.
//
// Usage:
//   STRAVA_CLIENT_ID=xxx STRAVA_CLIENT_SECRET=xxx STRAVA_VERIFY_TOKEN=xxx \
//   CALLBACK_URL=https://your-app.vercel.app/api/strava/webhook \
//   node scripts/register-webhook.js

async function main() {
  const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_VERIFY_TOKEN, CALLBACK_URL } = process.env;

  if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET || !STRAVA_VERIFY_TOKEN || !CALLBACK_URL) {
    console.error('Missing one of: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_VERIFY_TOKEN, CALLBACK_URL');
    process.exit(1);
  }

  const params = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    callback_url: CALLBACK_URL,
    verify_token: STRAVA_VERIFY_TOKEN,
  });

  const resp = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
    method: 'POST',
    body: params,
  });

  const text = await resp.text();

  if (!resp.ok) {
    console.error(`Failed (${resp.status}):`, text);
    process.exit(1);
  }

  console.log('Webhook subscription created:', text);
}

main();
