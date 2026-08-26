const { createClient } = require('@supabase/supabase-js');

// Uses the SECRET/SERVICE key — full access, backend only.
// Never import this file into any frontend code.
function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
  }

  return createClient(url, key);
}

module.exports = { getSupabaseClient };
