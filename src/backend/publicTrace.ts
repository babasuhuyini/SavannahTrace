// Customer trace in live mode: calls the `public-trace` Edge Function, which
// validates the token server-side and returns only approved, generalised fields.
// No database access is granted to anonymous visitors.
import type { DemoDB, Handoff } from '../data/types';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';
import { snapshotToDb, type Snapshot } from './snapshot';

export async function fetchPublicTrace(token: string): Promise<{ db?: DemoDB; handoff?: Handoff; error?: string }> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return { error: 'invalid' };
  const res = await fetch(`${SUPABASE_URL}/functions/v1/public-trace?token=${encodeURIComponent(token)}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) return { error: res.status === 404 ? 'not-found' : 'unavailable' };
  const body = (await res.json()) as { db: Snapshot; handoff: Handoff };
  return { db: snapshotToDb(body.db), handoff: { ...body.handoff, token } };
}
