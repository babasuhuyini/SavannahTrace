// Supabase invitation links (and any implicit-flow redirect) come back with the session
// in the URL fragment: #access_token=…&refresh_token=…&type=invite, or with
// #error=…&error_description=… when the link has expired. That fragment collides with
// the app's hash router, and the PKCE client does not read it. So it is captured once,
// synchronously, before the router or the Supabase client sees the URL, and the address
// bar is cleaned so tokens never stay in the browser history.
// No Supabase import here: this file is safe to load in demo mode.

export interface AuthFragment {
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

let captured: AuthFragment | null = null;

export function captureAuthFragment(): void {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!/(^|&)(access_token|error|error_description)=/.test(raw)) return;
  const p = new URLSearchParams(raw);
  const access_token = p.get('access_token') ?? undefined;
  const refresh_token = p.get('refresh_token') ?? undefined;
  captured =
    access_token && refresh_token
      ? { access_token, refresh_token }
      : { error: p.get('error_description') ?? p.get('error') ?? 'The sign-in link could not be used.' };
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);
}

/** Returns the captured fragment once; later calls return null. */
export function takeAuthFragment(): AuthFragment | null {
  const c = captured;
  captured = null;
  return c;
}
