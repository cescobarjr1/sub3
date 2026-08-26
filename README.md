# sub3-strava-sync backend

Syncs new Strava runs into Supabase automatically, so the tracker app can
read live data instead of local device storage.

## What's here

- `api/strava/callback.js` — one-time OAuth endpoint, run once to connect your account
- `api/strava/webhook.js` — the endpoint Strava calls every time you save a run
- `lib/strava.js` — token refresh + activity fetching
- `lib/supabase.js` — Supabase client (service/secret key, backend only)
- `scripts/register-webhook.js` — one-off script to tell Strava where to send events

## Setup steps

### 1. Push this to GitHub
Create a new repo (e.g. `sub3-strava-sync`) and push this folder to it.

### 2. Deploy to Vercel
- Import the GitHub repo in Vercel
- No build settings needed — Vercel auto-detects the `/api` folder as serverless functions
- Deploy. You'll get a URL like `https://sub3-strava-sync.vercel.app`

### 3. Set environment variables in Vercel
Project Settings -> Environment Variables. Add everything listed in `.env.example`:
- `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` — from your Strava API app settings
- `STRAVA_VERIFY_TOKEN` — make up any random string (e.g. run `openssl rand -hex 16`)
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_SECRET_KEY` — the Secret key (or legacy `service_role` key) from Supabase, never the publishable/anon key

Redeploy after adding env vars so the functions pick them up.

### 4. Update your Strava API app's "Authorization Callback Domain"
In Strava's API settings, set the callback domain to your Vercel domain
(just the domain, no path — e.g. `sub3-strava-sync.vercel.app`).

### 5. Do the one-time OAuth handshake
Build this URL, replacing `YOUR_CLIENT_ID` and `YOUR_VERCEL_DOMAIN`:

```
https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=https://YOUR_VERCEL_DOMAIN/api/strava/callback&approval_prompt=force&scope=activity:read_all
```

Visit it in your browser, approve access. You should land on a page that
says "Strava connected." That means your `strava_tokens` row in Supabase
now has a real access/refresh token pair.

### 6. Register the webhook subscription
Run this once from your own machine (needs Node 18+ installed):

```
STRAVA_CLIENT_ID=xxx \
STRAVA_CLIENT_SECRET=xxx \
STRAVA_VERIFY_TOKEN=xxx \
CALLBACK_URL=https://YOUR_VERCEL_DOMAIN/api/strava/webhook \
node scripts/register-webhook.js
```

Use the exact same `STRAVA_VERIFY_TOKEN` you set in Vercel. If it works,
Strava will hit your webhook's GET endpoint to verify, and you'll see
`Webhook subscription created` printed.

### 7. Test it
Log a run in Strava (or edit an existing one's title to trigger an event
— note only new activities trigger `aspect_type: create`). Within a few
seconds, check the `runs` table in Supabase — a new row should appear.

## Notes
- Only activities with type/sport_type `Run` are synced — rides, swims, etc. are ignored.
- Runs are upserted by `strava_id`, so re-processing the same event twice never creates a duplicate.
- If you ever revoke access on Strava's side, repeat step 5 to reconnect.
