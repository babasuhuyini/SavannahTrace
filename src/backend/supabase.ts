// Browser Supabase client. Uses ONLY the publishable key — safe in a browser
// because every table is protected by RLS and every write goes through
// SECURITY DEFINER workflow functions. Never import a secret key here.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  client ??= createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      flowType: 'pkce', // code in the query string; compatible with the app's hash router
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}

/** Turn a PostgREST / Postgres error into a sentence for the user. */
export function errorText(e: { message?: string; details?: string; hint?: string; code?: string } | null | undefined): string {
  if (!e) return 'Something went wrong.';
  if (e.code === '42501' || /permission denied/i.test(e.message ?? '')) return e.message?.replace(/^permission denied.*$/i, 'You do not have access to do that.') || 'You do not have access to do that.';
  if (/Failed to fetch|NetworkError/i.test(e.message ?? '')) return 'You appear to be offline. Nothing was saved — try again when connected.';
  return e.message ?? 'Something went wrong.';
}
