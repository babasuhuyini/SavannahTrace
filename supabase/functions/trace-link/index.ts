// trace-link — returns the customer trace URL for a handoff the CALLER may see.
// The token is derived as HMAC(TRACE_LINK_SECRET, grant_id): the database stores
// only its SHA-256 hash, yet Commercial can re-display the same link/QR any time.
// Rotating TRACE_LINK_SECRET invalidates every link (use with care).
import { APP_URL, adminClient, cors, hmacToken, json, sha256Hex, userClient } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  const secret = Deno.env.get('TRACE_LINK_SECRET');
  if (!secret || secret.length < 32) return json(req, { error: 'TRACE_LINK_SECRET is not configured (min 32 chars).' }, 500);
  const { handoff_id } = await req.json().catch(() => ({}));
  if (!handoff_id) return json(req, { error: 'handoff_id is required' }, 400);

  // Authorisation: RLS decides whether the caller can read this handoff.
  const { data: visible, error } = await userClient(req).from('commercial_handoffs').select('id').eq('id', handoff_id).maybeSingle();
  if (error || !visible) return json(req, { error: 'Not found' }, 404);

  const admin = adminClient();
  const { data: grantId, error: e1 } = await admin.rpc('service_trace_grant', { p_handoff: handoff_id, p_token_hash: null });
  if (e1 || !grantId) return json(req, { error: 'No trace grant for this handoff.' }, 404);
  const token = await hmacToken(secret, String(grantId));
  const { error: e2 } = await admin.rpc('service_trace_grant', { p_handoff: handoff_id, p_token_hash: await sha256Hex(token) });
  if (e2) return json(req, { error: e2.message }, 500);
  const base = (APP_URL || req.headers.get('origin') || '').replace(/\/$/, '');
  return json(req, { url: `${base}/#/t/${token}` });
});
