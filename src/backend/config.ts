// Backend selection. Live mode is enabled only when BOTH browser-safe Supabase
// settings are present. The publishable key is designed to be public and is safe
// only because every table is protected by Row Level Security. Never put a
// secret/service key in a VITE_ variable — anything prefixed VITE_ ships to browsers.

export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
export const SUPABASE_PUBLISHABLE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() || '';
export const LIVE = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
/** Public URL of the app (used for auth redirects and customer links). Defaults to the current origin. */
export const APP_URL = (import.meta.env.VITE_APP_URL as string | undefined)?.trim() || '';
