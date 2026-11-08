// public-trace — anonymous customer trace resolver (deploy with verify_jwt = false).
// Validates the token by hash, checks expiry/revocation in SQL, and returns ONLY
// the approved, generalised payload built by public.service_public_trace.
// Anonymous visitors never get table access. Add rate limiting at the edge/CDN.
import { adminClient, cors, json, sha256Hex } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'GET') return json(req, { error: 'Method not allowed' }, 405);
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return json(req, { error: 'Not found' }, 404);
  const { data, error } = await adminClient().rpc('service_public_trace', { p_token_hash: await sha256Hex(token) });
  if (error) return json(req, { error: 'Unavailable' }, 503);
  if (!data) return json(req, { error: 'Not found' }, 404);
  return json(req, data);
});
