// Shared helpers for Savannah Trace Edge Functions (Deno).
// Secrets come from the Edge Function environment — never from the browser.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const APP_URL = Deno.env.get('APP_URL') ?? '';
const URL_ = Deno.env.get('SUPABASE_URL')!;
// Supabase injects SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY automatically. If the project
// has its legacy API keys disabled, set SB_PUBLISHABLE_KEY / SB_SECRET_KEY as function secrets
// instead (`supabase secrets set` refuses names that start with SUPABASE_).
const PUBLIC_KEY = Deno.env.get('SB_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!;
const SECRET_KEY = Deno.env.get('SB_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY')!;

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? APP_URL).split(',').map((s) => s.trim()).filter(Boolean);

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

export const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Client acting AS the caller: RLS and the SQL role checks apply. */
export function userClient(req: Request): SupabaseClient {
  return createClient(URL_, PUBLIC_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Secret-key client: bypasses RLS. Use only AFTER the caller has been authorised. */
export function adminClient(): SupabaseClient {
  return createClient(URL_, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return '\\x' + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacToken(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
