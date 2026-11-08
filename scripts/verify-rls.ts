// Verifies the Supabase migrations — schema, RLS policies and workflow functions —
// against a real Postgres engine (PGlite, in-process, no Docker) using synthetic
// users for every role and two locations per role where it matters.
//
//   npm run verify:rls
//
// What this proves: the SQL policies and functions behave as designed on Postgres.
// What it does NOT prove: a hosted Supabase project's Auth emails, Google OAuth,
// PostgREST, Edge Functions or Realtime — those need a configured project.

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { snapshotToDb, type Snapshot } from '../src/backend/snapshot';
import { analyze } from '../src/domain/engine';

const root = new URL('../supabase/', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
const results: { ok: boolean; name: string; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ ok, name, detail });

const db = new PGlite();
await db.exec(read('tests/pglite_supabase_stub.sql'));
for (const f of readdirSync(new URL('migrations/', root)).sort()) await db.exec(read(`migrations/${f}`));
await db.exec(read('seed.sql'));

// ── synthetic identities ─────────────────────────────────────────────────────
const U = {
  admin: '00000000-0000-4000-8000-000000000001',
  nutA: '00000000-0000-4000-8000-000000000002', // Kulaa + PHC
  nutB: '00000000-0000-4000-8000-000000000003', // Sabon + Tingbaa
  butterTamba: '00000000-0000-4000-8000-000000000004',
  butterKalbe: '00000000-0000-4000-8000-000000000005', // Kalbe + warehouse
  supply: '00000000-0000-4000-8000-000000000006',
  commercialL: '00000000-0000-4000-8000-000000000007', // client Lumière
  commercialN: '00000000-0000-4000-8000-000000000008', // client Nordhavn
  auditorTamba: '00000000-0000-4000-8000-000000000009', // audit scope: Tamba only
  uninvited: '00000000-0000-4000-8000-00000000000a',
  unverified: '00000000-0000-4000-8000-00000000000b',
};
const email = (k: string) => `${k.toLowerCase()}@verify-sfcl.invalid`;
for (const [k, id] of Object.entries(U))
  await db.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)`, [id, email(k), k === 'unverified' ? null : new Date().toISOString()]);

// Signed-in sessions default to aal2 (password + authenticator code), like a fully signed-in user.
async function as<T>(uid: string | null, role: 'authenticated' | 'anon' | 'service_role', fn: (q: Q) => Promise<T>, aal: 'aal1' | 'aal2' = 'aal2'): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true), set_config('request.jwt.claims', $3, true)`, [
      uid ?? '',
      role,
      JSON.stringify(uid ? { sub: uid, role, aal } : { role }),
    ]);
    await tx.query(`set local role ${role}`);
    return fn((sql, params) => tx.query(sql, params) as Promise<{ rows: Record<string, unknown>[] }>);
  });
}
const rpc = (uid: string, fn: string, p: unknown) => as(uid, 'authenticated', async (q) => (await q(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)])).rows[0].r as Record<string, unknown>);
const count = (uid: string, table: string, role: 'authenticated' | 'anon' = 'authenticated') => as(uid, role, async (q) => Number((await q(`select count(*)::int as n from ${table}`)).rows[0].n));
async function fails(name: string, p: Promise<unknown>, expect?: RegExp) {
  try {
    await p;
    check(name, false, 'expected an error, but it succeeded');
  } catch (e) {
    const msg = (e as Error).message;
    check(name, !expect || expect.test(msg), msg);
  }
}
async function succeeds<T>(name: string, p: Promise<T>): Promise<T | undefined> {
  try {
    const r = await p;
    check(name, true);
    return r;
  } catch (e) {
    check(name, false, (e as Error).message);
    return undefined;
  }
}
let k = 0;
const idem = () => `verify-key-${String(++k).padStart(4, '0')}`;
const T = (d: string, t: string, tz = '+00:00') => ({ occurred_at: `${d}T${t}:00${tz}`, occurred_tz: tz });

// ── bootstrap + invitations ──────────────────────────────────────────────────
await db.query(`select private.bootstrap_first_admin($1, 'Verify Admin')`, [email('admin')]);
await fails('Bootstrap cannot run twice', db.query(`select private.bootstrap_first_admin($1, 'x')`, [email('nutA')]), /already exists/);
await fails('Signed-in users cannot call the bootstrap function', as(U.nutA, 'authenticated', (q) => q(`select private.bootstrap_first_admin('a@b.c','x')`)), /permission denied/);

const invites: [keyof typeof U, string, string[], string[]][] = [
  ['nutA', 'nut-fo', ['ca-kulaa', 'phc-nayiri'], []],
  ['nutB', 'nut-fo', ['ca-sabon', 'ca-tingbaa'], []],
  ['butterTamba', 'butter-fo', ['bc-tamba'], []],
  ['butterKalbe', 'butter-fo', ['bc-kalbe', 'wh-central'], []],
  ['supply', 'supply-chain', ['port-tema', 'nl-terminal', 'nl-zaan'], []],
  ['commercialL', 'commercial', [], ['DEMO Lumière Naturals B.V.']],
  ['commercialN', 'commercial', [], ['DEMO Nordhavn Personal Care A/S']],
  ['auditorTamba', 'auditor', ['bc-tamba'], []],
  ['unverified', 'nut-fo', ['ca-kulaa'], []],
];
for (const [who, role, locs, clients] of invites)
  await rpc(U.admin, 'admin_prepare_invitation', { email: email(who), name: `Verify ${who}`, role, location_codes: locs, client_names: clients });
await fails('Non-admin cannot create invitations', rpc(U.nutA, 'admin_prepare_invitation', { email: 'x@y.invalid', role: 'it-admin' }), /cannot perform|no active access/);
await fails('Duplicate pending invitation refused', rpc(U.admin, 'admin_prepare_invitation', { email: email('nutA'), name: 'x', role: 'nut-fo', location_codes: ['ca-kulaa'] }), /pending invitation/);

const preview = await as(U.nutA, 'authenticated', async (q) => (await q(`select public.accept_invitation(null) as r`)).rows[0].r as { status: string });
check('Invited user sees a pending invitation preview before activating', preview.status === 'pending', JSON.stringify(preview));
for (const [who] of invites) {
  if (who === 'unverified') continue;
  await as(U[who], 'authenticated', (q) => q(`select public.accept_invitation($1)`, [`Verify ${who}`]));
}
const unv = await as(U.unverified, 'authenticated', async (q) => (await q(`select public.accept_invitation('x') as r`)).rows[0].r as { status: string });
check('Unverified email cannot activate an invitation', unv.status === 'unverified', JSON.stringify(unv));
const unin = await as(U.uninvited, 'authenticated', async (q) => (await q(`select public.accept_invitation('x') as r`)).rows[0].r as { status: string });
check('Uninvited identity (e.g. Google) gets no profile', unin.status === 'no_invitation', JSON.stringify(unin));
check('Uninvited identity reads no events', (await count(U.uninvited, 'public.events')) === 0);
check('Uninvited identity reads no locations', (await count(U.uninvited, 'public.locations')) === 0);
await fails('Uninvited identity cannot write', rpc(U.uninvited, 'record_purchase', { collector_code: 'DX01-CA9101-001' }), /no active access/);

// ── anonymous & direct writes ────────────────────────────────────────────────
await fails('Anonymous role cannot read events', count('', 'public.events', 'anon'), /permission denied/);
await fails('Anonymous role cannot read collectors', count('', 'public.collector_personal', 'anon'), /permission denied/);
await fails('Anonymous role cannot call workflow functions', as(null, 'anon', (q) => q(`select public.record_purchase('{}'::jsonb)`)), /permission denied/);
await fails('Signed-in users cannot INSERT into events directly', as(U.nutA, 'authenticated', (q) => q(`insert into public.events (event_type) values ('purchase')`)), /permission denied/);
await fails('Signed-in users cannot UPDATE the ledger directly', as(U.admin, 'authenticated', (q) => q(`update public.inventory_ledger set quantity_kg = 1`)), /permission denied/);
await fails('Signed-in users cannot DELETE events', as(U.admin, 'authenticated', (q) => q(`delete from public.events`)), /permission denied/);
await fails('Signed-in users cannot read the public-trace service function', as(U.admin, 'authenticated', (q) => q(`select public.service_public_trace('\\x00'::bytea)`)), /permission denied/);
await fails('Signed-in users cannot call events_json in public mode', as(U.admin, 'authenticated', (q) => q(`select private.events_json('{}'::uuid[], true)`)), /Not allowed/);

// ── Nut officers: own purchases at assigned areas ────────────────────────────
const p1 = { collector_code: 'DX01-CA9101-001', product: 'OFN', quantity_kg: 1000, purchase_date: '2026-07-14', lot_code: 'DX01-CA9101-001-071426', price_per_kg: 1.85, ...T('2026-07-14', '08:00'), idempotency_key: idem() };
await succeeds('Nut officer A records a purchase at an assigned area', rpc(U.nutA, 'record_purchase', p1));
const dup = await rpc(U.nutA, 'record_purchase', p1);
check('Retry with the same idempotency key returns the first result (no duplicate)', dup.duplicate === true, JSON.stringify(dup));
await fails('Same collector + same date is one commission record', rpc(U.nutA, 'record_purchase', { ...p1, lot_code: 'X-1', idempotency_key: idem() }), /already has a purchase/);
const warn = await rpc(U.nutA, 'record_purchase', { ...p1, collector_code: 'DX01-CA9101-002', lot_code: 'DX01-CA9101-2-071426', idempotency_key: idem() });
check('Unexpected lot ID pattern is saved as entered with a warning (never rewritten)', JSON.stringify(warn.warnings).includes('Saved exactly as entered'), JSON.stringify(warn));
await fails('Nut officer B cannot purchase in an unassigned area', rpc(U.nutB, 'record_purchase', { ...p1, collector_code: 'DX01-CA9101-003', lot_code: 'Z', idempotency_key: idem() }), /not assigned/);
check('Nut officer B cannot read Nut officer A purchases', (await count(U.nutB, 'public.purchase_events')) === 0);
check('Nut officer B cannot read Nut officer A events', (await count(U.nutB, 'public.events')) === 0);
check('Nut officer A sees collector names for own areas', (await count(U.nutA, 'public.collector_personal')) === 6);
check('Nut officer B sees collector names only for own areas', (await count(U.nutB, 'public.collector_personal')) === 12);
await fails('Future event time refused', rpc(U.nutA, 'record_purchase', { ...p1, collector_code: 'DX01-CA9101-004', lot_code: 'F-1', ...T('2099-01-01', '08:00'), idempotency_key: idem() }), /future/);
const dry = await rpc(U.nutA, 'record_purchase', { ...p1, collector_code: 'DX01-CA9101-005', lot_code: 'DRY-1', idempotency_key: idem(), dry_run: true });
check('Dry run validates without writing', dry.dry_run === true && (await count(U.admin, `public.lots where code = 'DRY-1'`)) === 0, JSON.stringify(dry));

// ODK purchase route (bypasses the PHC) → Tamba
await rpc(U.nutB, 'record_purchase', { collector_code: 'DX02-CA9204-011', product: 'ODK', quantity_kg: 2000, purchase_date: '2026-07-18', lot_code: 'DX02-CA9204-011-071826', ...T('2026-07-18', '08:00'), idempotency_key: idem() });
await fails('OFN cannot ship anywhere but a PHC', rpc(U.nutA, 'record_shipment', { origin_code: 'ca-kulaa', destination_code: 'bc-tamba', items: [{ lot_code: 'DX01-CA9101-001-071426', quantity_kg: 100 }], ...T('2026-07-15', '10:00'), idempotency_key: idem() }), /Post Harvest Centre/);
await fails('Cannot ship more than is held', rpc(U.nutB, 'record_shipment', { origin_code: 'ca-sabon', destination_code: 'bc-tamba', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 2500 }], ...T('2026-07-19', '07:30'), idempotency_key: idem() }), /only 2000/);
await fails('Cannot ship before the lot existed', rpc(U.nutB, 'record_shipment', { origin_code: 'ca-sabon', destination_code: 'bc-tamba', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 100 }], ...T('2026-07-17', '07:30'), idempotency_key: idem() }), /before or at the time it was created/);
await fails('Unknown identifiers are refused, never guessed', rpc(U.nutB, 'record_shipment', { origin_code: 'ca-sabon', destination_code: 'bc-tamba', items: [{ lot_code: 'DX02-CA9204-011-71826', quantity_kg: 100 }], ...T('2026-07-19', '07:30'), idempotency_key: idem() }), /never guessed/);
const shipKey = idem();
const s1 = await succeeds('Nut officer B ships purchased ODK to Tamba', rpc(U.nutB, 'record_shipment', { origin_code: 'ca-sabon', destination_code: 'bc-tamba', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 2000 }], ...T('2026-07-19', '07:30'), idempotency_key: shipKey }));
const ledgerBefore = await count(U.admin, 'public.inventory_ledger');
await rpc(U.nutB, 'record_shipment', { origin_code: 'ca-sabon', destination_code: 'bc-tamba', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 2000 }], ...T('2026-07-19', '07:30'), idempotency_key: shipKey });
check('Retried shipment writes no extra stock movements', (await count(U.admin, 'public.inventory_ledger')) === ledgerBefore);

// ── the shipment hand-off ────────────────────────────────────────────────────
check('Destination (Tamba) officer sees the inbound shipment', (await count(U.butterTamba, 'public.shipment_events')) === 1);
check('Destination officer sees the shipment lines (lot, qty)', (await count(U.butterTamba, 'public.shipment_items')) === 1);
check('Destination officer can resolve the lot code', (await count(U.butterTamba, `public.lots where code = 'DX02-CA9204-011-071826'`)) === 1);
check('Destination officer does NOT see the purchase', (await count(U.butterTamba, 'public.purchase_events')) === 0);
check('Destination officer does NOT see collector names', (await count(U.butterTamba, 'public.collector_personal')) === 0);
check('Destination officer does NOT see prices', (await count(U.butterTamba, 'public.purchase_prices')) === 0);
check('Other centre (Kalbe) does NOT see the shipment', (await count(U.butterKalbe, 'public.shipment_events')) === 0);
const shipId = (s1 as { event_id: string }).event_id;
await fails('Kalbe officer cannot receive a shipment addressed to Tamba', rpc(U.butterKalbe, 'receive_shipment', { shipment_event_id: shipId, items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 2000 }], ...T('2026-07-19', '12:00'), idempotency_key: idem() }), /not assigned/);
await fails('A short receipt cannot be recorded as fully accepted', rpc(U.butterTamba, 'receive_shipment', { shipment_event_id: shipId, outcome: 'accepted', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 1900 }], ...T('2026-07-19', '12:00'), idempotency_key: idem() }), /discrepancy/);
await fails('Receipt before shipment time refused', rpc(U.butterTamba, 'receive_shipment', { shipment_event_id: shipId, items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 2000 }], ...T('2026-07-19', '07:00'), idempotency_key: idem() }), /after the shipment left/);
await succeeds('Tamba officer receives with a recorded discrepancy', rpc(U.butterTamba, 'receive_shipment', { shipment_event_id: shipId, outcome: 'discrepancy', discrepancy_note: '2 bags short', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 1950 }], ...T('2026-07-19', '12:50'), idempotency_key: idem() }));
const stock = await as(U.butterTamba, 'authenticated', async (q) => (await q(`select quantity_kg::float as kg from public.v_stock where lot_code = 'DX02-CA9204-011-071826' and location_code = 'bc-tamba' and bucket = 'on_hand'`)).rows[0]?.kg);
check('Accepted quantity becomes stock at the destination (1,950 kg)', stock === 1950, String(stock));
check('Sender (Nut B) still sees own shipment after receipt', (await count(U.nutB, 'public.shipment_events')) === 1);
check('Sender does NOT see the receiving centre’s workspace', (await count(U.nutB, `public.events where event_type = 'receipt'`)) === 0);

// ── issue, processing, double spend ──────────────────────────────────────────
await succeeds('Tamba officer issues ODK to its group', rpc(U.butterTamba, 'issue_to_group', { centre_code: 'bc-tamba', group_code: 'grp-tamba-a', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 1500 }], ...T('2026-08-01', '07:30'), idempotency_key: idem() }));
await fails('Second issue cannot spend the same stock twice', rpc(U.butterTamba, 'issue_to_group', { centre_code: 'bc-tamba', group_code: 'grp-tamba-b', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 1000 }], ...T('2026-08-02', '07:30'), idempotency_key: idem() }), /only 450/);
await fails('Back-dated issue cannot overdraw what later events used', rpc(U.butterTamba, 'issue_to_group', { centre_code: 'bc-tamba', group_code: 'grp-tamba-b', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 1000 }], ...T('2026-07-25', '07:30'), idempotency_key: idem() }), /later recorded events|only 450/);
await fails('Cannot issue to another centre’s group', rpc(U.butterTamba, 'issue_to_group', { centre_code: 'bc-tamba', group_code: 'grp-kalbe-a', items: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 10 }], ...T('2026-08-02', '07:30'), idempotency_key: idem() }), /not registered/);
await fails('Group processing uses only kernel issued to that group', rpc(U.butterTamba, 'record_transformation', { kind: 'odk_to_osb', location_code: 'bc-tamba', group_code: 'grp-tamba-b', inputs: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 100 }], outputs: [{ lot_code: 'LPO-T0', product: 'OSB', quantity_kg: 40 }], ...T('2026-08-03', '16:00'), idempotency_key: idem() }), /not held|available/);
const tf = (await succeeds('(step) butter transformation call', rpc(U.butterTamba, 'record_transformation', { kind: 'odk_to_osb', location_code: 'bc-tamba', group_code: 'grp-tamba-a', inputs: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 1500 }], outputs: [{ lot_code: 'LPO-T1', product: 'OSB', quantity_kg: 600 }], ...T('2026-08-03', '16:00'), idempotency_key: idem() }))) ?? {};
check('Group processing ODK → OSB creates the officer-supplied LPO', tf.ok === true, JSON.stringify(tf));
await fails('Output batch IDs must be new', rpc(U.butterTamba, 'record_transformation', { kind: 'odk_to_osb', location_code: 'bc-tamba', group_code: 'grp-tamba-a', inputs: [{ lot_code: 'DX02-CA9204-011-071826', quantity_kg: 10 }], outputs: [{ lot_code: 'LPO-T1', product: 'OSB', quantity_kg: 4 }], ...T('2026-08-04', '16:00'), idempotency_key: idem() }), /not held|available|already exists/);
await fails('A Nut officer cannot record butter processing', rpc(U.nutA, 'record_transformation', { kind: 'odk_to_osb', location_code: 'bc-tamba', group_code: 'grp-tamba-a', inputs: [], outputs: [], ...T('2026-08-04', '16:00'), idempotency_key: idem() }), /cannot perform/);

// ── a full 21,000 kg chain through Kalbe + warehouse → Tema → Amsterdam ──────
await rpc(U.nutB, 'record_purchase', { collector_code: 'DX03-CA9307-021', product: 'ODK', quantity_kg: 60000, purchase_date: '2026-07-24', lot_code: 'DX03-CA9307-021-072426', ...T('2026-07-24', '08:00'), idempotency_key: idem() });
const s2 = await rpc(U.nutB, 'record_shipment', { origin_code: 'ca-tingbaa', destination_code: 'bc-kalbe', items: [{ lot_code: 'DX03-CA9307-021-072426', quantity_kg: 60000 }], ...T('2026-07-25', '07:30'), idempotency_key: idem() });
await rpc(U.butterKalbe, 'receive_shipment', { shipment_event_id: s2.event_id, items: [{ lot_code: 'DX03-CA9307-021-072426', quantity_kg: 60000 }], ...T('2026-07-25', '13:00'), idempotency_key: idem() });
await rpc(U.butterKalbe, 'issue_to_group', { centre_code: 'bc-kalbe', group_code: 'grp-kalbe-a', items: [{ lot_code: 'DX03-CA9307-021-072426', quantity_kg: 60000 }], ...T('2026-08-01', '07:30'), idempotency_key: idem() });
const y = await rpc(U.butterKalbe, 'record_transformation', { kind: 'odk_to_osb', location_code: 'bc-kalbe', group_code: 'grp-kalbe-a', inputs: [{ lot_code: 'DX03-CA9307-021-072426', quantity_kg: 60000 }], outputs: [{ lot_code: 'LPO-K1', product: 'OSB', quantity_kg: 21500 }], ...T('2026-08-05', '16:00'), idempotency_key: idem() });
check('Yield inside the proposed band produces no warning', Array.isArray(y.warnings) && (y.warnings as unknown[]).length === 0, JSON.stringify(y));
const w = await rpc(U.butterKalbe, 'record_shipment', { origin_code: 'bc-kalbe', destination_code: 'wh-central', items: [{ lot_code: 'LPO-K1', quantity_kg: 21500 }], ...T('2026-08-06', '06:30'), idempotency_key: idem() });
await rpc(U.butterKalbe, 'receive_shipment', { shipment_event_id: w.event_id, items: [{ lot_code: 'LPO-K1', quantity_kg: 21500 }], ...T('2026-08-06', '13:30'), idempotency_key: idem() });
await fails('SFCL can never exceed 21,000 kg', rpc(U.butterKalbe, 'save_sfcl_aggregation', { sfcl_code: 'SFCL 99001', warehouse_code: 'wh-central', draws: [{ lot_code: 'LPO-K1', quantity_kg: 21500 }], ...T('2026-09-01', '10:00'), idempotency_key: idem() }), /over the 21,000/);
const inprog = await rpc(U.butterKalbe, 'save_sfcl_aggregation', { sfcl_code: 'SFCL 99001', warehouse_code: 'wh-central', draws: [{ lot_code: 'LPO-K1', quantity_kg: 3000 }], ...T('2026-09-01', '10:00'), idempotency_key: idem() });
check('Aggregation saved in progress below 21,000 kg', inprog.stage === 'in_progress', JSON.stringify(inprog));
await fails('An in-progress SFCL cannot ship', rpc(U.butterKalbe, 'record_shipment', { origin_code: 'wh-central', destination_code: 'port-tema', items: [{ lot_code: 'SFCL 99001', quantity_kg: 3000 }], ...T('2026-09-02', '06:00'), idempotency_key: idem() }), /in progress/);
await fails('Finalize only at exactly 21,000 kg', rpc(U.butterKalbe, 'save_sfcl_aggregation', { sfcl_code: 'SFCL 99001', warehouse_code: 'wh-central', draws: [{ lot_code: 'LPO-K1', quantity_kg: 20000 }], finalize: true, ...T('2026-09-03', '10:00'), idempotency_key: idem() }), /exactly 21,000/);
await fails('A draw can never exceed the LPO’s available balance', rpc(U.butterKalbe, 'save_sfcl_aggregation', { sfcl_code: 'SFCL 99002', warehouse_code: 'wh-central', draws: [{ lot_code: 'LPO-K1', quantity_kg: 19000 }], ...T('2026-09-03', '10:00'), idempotency_key: idem() }), /only 18500/);
const fin = await rpc(U.butterKalbe, 'save_sfcl_aggregation', { sfcl_code: 'SFCL 99001', warehouse_code: 'wh-central', draws: [{ lot_code: 'LPO-K1', quantity_kg: 21000 }], finalize: true, ...T('2026-09-04', '10:00'), idempotency_key: idem() });
check('Finalized at exactly 21,000 kg; draw above 3,000 kg is a warning, not a block', fin.stage === 'finalized' && JSON.stringify(fin.warnings).includes('3,000'), JSON.stringify(fin));
const ledgerSfcl = await as(U.admin, 'authenticated', async (q) => (await q(`select quantity_kg::float as kg from public.v_stock where lot_code = 'SFCL 99001' and bucket = 'on_hand'`)).rows[0]?.kg);
check('Re-saved aggregation keeps the ledger balanced (SFCL = 21,000 kg)', ledgerSfcl === 21000, String(ledgerSfcl));
const lpoLeft = await as(U.admin, 'authenticated', async (q) => (await q(`select quantity_kg::float as kg from public.v_stock where lot_code = 'LPO-K1' and location_code = 'wh-central' and bucket = 'on_hand'`)).rows[0]?.kg);
check('LPO remaining balance after the draw is 500 kg (split carried forward)', lpoLeft === 500, String(lpoLeft));
const x1 = await rpc(U.butterKalbe, 'record_shipment', { origin_code: 'wh-central', destination_code: 'port-tema', items: [{ lot_code: 'SFCL 99001', quantity_kg: 21000 }], container_no: 'TEST 000001 0', ...T('2026-09-10', '06:00'), idempotency_key: idem() });
await fails('Supply Chain cannot ship from the warehouse', rpc(U.supply, 'record_shipment', { origin_code: 'wh-central', destination_code: 'port-tema', items: [], ...T('2026-09-10', '06:00'), idempotency_key: idem() }), /not assigned|export legs/);
check('Supply Chain sees the inbound SFCL at Tema', (await count(U.supply, 'public.shipment_events')) === 1);
check('Supply Chain sees no purchases or collector data', (await count(U.supply, 'public.purchase_events')) + (await count(U.supply, 'public.collector_personal')) === 0);
await rpc(U.supply, 'receive_shipment', { shipment_event_id: x1.event_id, items: [{ lot_code: 'SFCL 99001', quantity_kg: 21000 }], ...T('2026-09-11', '13:00'), idempotency_key: idem() });
const x2 = await rpc(U.supply, 'record_shipment', { origin_code: 'port-tema', destination_code: 'nl-terminal', items: [{ lot_code: 'SFCL 99001', quantity_kg: 21000 }], vessel: 'MV Verify', ...T('2026-09-20', '18:00'), idempotency_key: idem() });
await rpc(U.supply, 'receive_shipment', { shipment_event_id: x2.event_id, items: [{ lot_code: 'SFCL 99001', quantity_kg: 21000 }], ...T('2026-10-18', '09:00', '+02:00'), idempotency_key: idem() });
await fails('Ready for pickup is refused at the terminal (refine or filter first)', rpc(U.supply, 'mark_ready_for_pickup', { location_code: 'nl-terminal', lot_code: 'SFCL 99001', quantity_kg: 21000, client_name: 'DEMO Lumière Naturals B.V.', order_ref: 'PO-1', ...T('2026-10-19', '10:00', '+02:00'), idempotency_key: idem() }), /refiner or filterer/);
const x3 = await rpc(U.supply, 'record_shipment', { origin_code: 'nl-terminal', destination_code: 'nl-zaan', items: [{ lot_code: 'SFCL 99001', quantity_kg: 21000 }], client_name: 'DEMO Lumière Naturals B.V.', order_ref: 'PO-1', ...T('2026-10-19', '08:00', '+02:00'), idempotency_key: idem() });
await rpc(U.supply, 'receive_shipment', { shipment_event_id: x3.event_id, items: [{ lot_code: 'SFCL 99001', quantity_kg: 21000 }], ...T('2026-10-19', '11:00', '+02:00'), idempotency_key: idem() });
await succeeds('Supply Chain records refining in Amsterdam', rpc(U.supply, 'record_transformation', { kind: 'refining', location_code: 'nl-zaan', inputs: [{ lot_code: 'SFCL 99001', quantity_kg: 21000 }], outputs: [{ lot_code: 'ORSB 99001-R1', product: 'ORSB', quantity_kg: 20160 }], ...T('2026-10-20', '16:00', '+02:00'), idempotency_key: idem() }));
const ready = await rpc(U.supply, 'mark_ready_for_pickup', { location_code: 'nl-zaan', lot_code: 'ORSB 99001-R1', quantity_kg: 20160, client_name: 'DEMO Lumière Naturals B.V.', order_ref: 'PO-1', ...T('2026-10-22', '10:00', '+02:00'), idempotency_key: idem() });
check('Ready for pickup at the refiner creates a Commercial handoff', typeof ready.handoff_id === 'string', JSON.stringify(ready));
const again = await rpc(U.supply, 'mark_ready_for_pickup', { location_code: 'nl-zaan', lot_code: 'ORSB 99001-R1', quantity_kg: 20160, client_name: 'DEMO Lumière Naturals B.V.', order_ref: 'PO-1', ...T('2026-10-22', '11:00', '+02:00'), idempotency_key: idem() });
check('Marking ready again reuses the same handoff', again.handoff_id === ready.handoff_id, JSON.stringify(again));

// ── Commercial scope ─────────────────────────────────────────────────────────
check('Commercial (Lumière) sees its client’s handoff', (await count(U.commercialL, 'public.commercial_handoffs')) === 1);
check('Commercial (Nordhavn) does not see another client’s handoff', (await count(U.commercialN, 'public.commercial_handoffs')) === 0);
check('Commercial sees no events, purchases or collector data', (await count(U.commercialL, 'public.events')) + (await count(U.commercialL, 'public.collector_personal')) === 0);
await succeeds('Commercial acknowledges and records an illustrative invoice reference', rpc(U.commercialL, 'update_handoff', { handoff_id: ready.handoff_id, acknowledge: true, invoice_ref: 'INV-TEST-1', invoice_status: 'in_preparation' }));
await fails('Commercial cannot update another client’s handoff', rpc(U.commercialN, 'update_handoff', { handoff_id: ready.handoff_id, acknowledge: true }), /not found/);

// ── Auditor: read-only, explicit scope ───────────────────────────────────────
check('Auditor (Tamba scope) sees Tamba events', (await count(U.auditorTamba, 'public.events')) > 0);
check('Auditor does not see events outside the audit scope (Kalbe)', (await count(U.auditorTamba, `public.events e where e.location_id = (select id from public.locations where code = 'bc-kalbe')`)) === 0);
await fails('Auditor cannot write', rpc(U.auditorTamba, 'record_purchase', { collector_code: 'DX01-CA9101-006' }), /cannot perform/);
await fails('Auditor cannot administer users', rpc(U.auditorTamba, 'admin_prepare_invitation', { email: 'a@b.invalid', role: 'it-admin' }), /cannot perform/);

// ── suspension takes effect immediately ──────────────────────────────────────
await as(U.admin, 'authenticated', (q) => q(`select public.admin_set_user_status($1, 'suspended')`, [U.butterTamba]));
check('Suspended user immediately reads no events', (await count(U.butterTamba, 'public.events')) === 0);
check('Suspended user immediately reads no stock', (await count(U.butterTamba, 'public.inventory_ledger')) === 0);
await fails('Suspended user cannot write', rpc(U.butterTamba, 'issue_to_group', { centre_code: 'bc-tamba' }), /no active access/);
check('Suspended user’s history is preserved for audit', (await count(U.admin, `public.events where actor_id = '${U.butterTamba}'`)) > 0);
await as(U.admin, 'authenticated', (q) => q(`select public.admin_set_user_status($1, 'active')`, [U.butterTamba]));
check('Reactivated user regains access', (await count(U.butterTamba, 'public.events')) > 0);
await fails('Admin cannot suspend themselves', as(U.admin, 'authenticated', (q) => q(`select public.admin_set_user_status($1, 'suspended')`, [U.admin])), /own account/);

// ── corrections append history ───────────────────────────────────────────────
const anyEvent = await as(U.admin, 'authenticated', async (q) => (await q(`select id from public.events order by occurred_at limit 1`)).rows[0].id as string);
await fails('Corrections need a reason', rpc(U.admin, 'record_correction', { event_id: anyEvent, notes: 'x', reason: ' ' }), /reason/);
await rpc(U.admin, 'record_correction', { event_id: anyEvent, notes: 'Weighbridge ticket attached', reason: 'Ticket found' });
check('Correction stored with before/after and version bumped', (await count(U.admin, `public.event_corrections where original_event_id = '${anyEvent}'`)) === 1);
await fails('Officers cannot record corrections', rpc(U.nutA, 'record_correction', { event_id: anyEvent, reason: 'x' }), /cannot perform/);

// ── public customer trace (service role only, sanitised) ─────────────────────
const tokenHash = createHash('sha256').update('verify-token').digest();
const hashHex = new Uint8Array(tokenHash);
await as(null, 'service_role', (q) => q(`select public.service_trace_grant($1::uuid, $2::bytea)`, [ready.handoff_id, hashHex]));
const fetchPub = () => as(null, 'service_role', async (q) => (await q(`select public.service_public_trace($1::bytea) as r`, [hashHex])).rows[0].r as { db: Snapshot; handoff: { lotId: string } });
const pub = await fetchPub();
const pubText = JSON.stringify(pub);
check('Public trace resolves for a valid token (full trace by default)', !!pub && pub.handoff.lotId === 'ORSB 99001-R1');
check('Full trace includes the whole SFCL lineage (purchase lot, LPO, SFCL)', pubText.includes('DX03-CA9307-021-072426') && pubText.includes('LPO-K1') && pubText.includes('SFCL 99001'));
check('Full trace never contains collector names', !pubText.includes('Zenabu') && !pubText.includes('Asana'));
check('Full trace never contains prices, notes or user ids', !/"pricePerKg":\s*[0-9]/.test(pubText) && !pubText.includes('Ticket found') && !pubText.includes('"actorId":"0'));
await rpc(U.commercialL, 'update_handoff', { handoff_id: ready.handoff_id, disclosure: 'generalized' });
const gen = JSON.stringify(await fetchPub());
check('Generalized mode hides facility names and aliases purchase lots', !gen.includes('DEMO Kalbe Butter Centre') && !gen.includes('DX03-CA9307-021-072426') && gen.includes('origin-lot-1'));
const exactPoly = JSON.stringify((await as(U.admin, 'authenticated', async (q) => (await q(`select polygon from public.collection_area_geometry g join public.locations l on l.id = g.location_id where l.code = 'ca-tingbaa'`)).rows[0].polygon)) as unknown).slice(0, 30);
check('Generalized mode has no exact collection boundary', !gen.includes(exactPoly));
await rpc(U.commercialL, 'update_handoff', { handoff_id: ready.handoff_id, disclosure: 'full' });
const bad = await as(null, 'service_role', async (q) => (await q(`select public.service_public_trace('\\x00'::bytea) as r`)).rows[0].r);
check('Unknown token returns nothing', bad === null);

// ── snapshot → front-end engine (live mapping layer) ─────────────────────────
for (const [label, uid] of [['Butter (Tamba)', U.butterTamba], ['Supply Chain', U.supply], ['Nut B', U.nutB], ['IT Admin', U.admin]] as const) {
  const snap = await as(uid, 'authenticated', async (q) => (await q(`select public.get_workspace_snapshot() as r`)).rows[0].r as Snapshot);
  const a = analyze(snapshotToDb(snap));
  const blocking = a.findings.filter((f) => f.severity === 'blocking');
  check(`Snapshot for ${label} maps to the app with no false blocking findings`, blocking.length === 0, blocking.map((f) => f.message).join(' | '));
  if (label === 'Butter (Tamba)') check('Butter snapshot exposes no purchase events or collector names', !snap.events.some((e) => e.type === 'commission') && !JSON.stringify(snap.collectors).includes('Zenabu'));
  if (label === 'Nut B') check('Nut snapshot includes own collectors’ names', JSON.stringify(snap.collectors).includes('Zenabu'));
}
const pubDb = snapshotToDb(pub.db);
check('Public payload builds a trace with no blocking findings', analyze(pubDb).findings.filter((f) => f.severity === 'blocking').length === 0, analyze(pubDb).findings.map((f) => f.message).join(' | '));

// ── keep-alive (Free plan) ──────────────────────────────────────────────────
const ka = await as(null, 'anon', async (q) => (await q(`select public.keepalive() as r`)).rows[0].r);
check('Anonymous keep-alive call works (no data returned, only a timestamp)', ka instanceof Date || typeof ka === 'string');
await as(null, 'anon', (q) => q(`select public.keepalive()`));
check('Keep-alive writes at most one heartbeat per hour', Number((await db.query(`select count(*)::int as n from private.heartbeat`)).rows[0] && ((await db.query(`select count(*)::int as n from private.heartbeat`)).rows[0] as { n: number }).n) === 1);
await fails('Anonymous role still cannot read the heartbeat table', as(null, 'anon', (q) => q(`select * from private.heartbeat`)), /permission denied/);

// ── password sign-in + mandatory authenticator (MFA) ─────────────────────────
const aal1 = <T>(uid: string, fn: (q: Q) => Promise<T>) => as(uid, 'authenticated', fn, 'aal1');
const n1 = async (uid: string, table: string) => Number((await aal1(uid, (q) => q(`select count(*)::int as n from ${table}`))).rows[0].n);
check('Password only (no authenticator code yet): admin reads no events', (await n1(U.admin, 'public.events')) === 0);
check('Password only: officer reads no locations, lots or ledger', (await n1(U.nutA, 'public.locations')) + (await n1(U.nutA, 'public.lots')) + (await n1(U.nutA, 'public.inventory_ledger')) === 0);
check('Password only: no collector personal data', (await n1(U.nutB, 'public.collector_personal')) === 0);
await fails('Password only: workflow functions refuse', aal1(U.nutA, (q) => q(`select public.record_purchase($1::jsonb)`, [JSON.stringify({ ...p1, idempotency_key: idem() })])), /authenticator/);
await fails('Password only: admin functions refuse', aal1(U.admin, (q) => q(`select public.admin_list_users()`)), /authenticator/);
await fails('Password only: workspace snapshot refused', aal1(U.admin, (q) => q(`select public.get_workspace_snapshot()`)), /No active access/);
const ctx1 = (await aal1(U.nutA, (q) => q(`select public.get_my_context() as r`))).rows[0].r as Record<string, unknown>;
check('Sign-in state is readable before the authenticator step (to choose the next screen)', ctx1.user_id === U.nutA && ctx1.aal === 'aal1' && ctx1.has_password === false && ctx1.mfa_enrolled === false, JSON.stringify(ctx1));
await db.query(`update auth.users set encrypted_password = '$2a$10$hash' where id = $1`, [U.nutA]);
await db.query(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [U.nutA]);
const ctx2 = (await aal1(U.nutA, (q) => q(`select public.get_my_context() as r`))).rows[0].r as Record<string, unknown>;
check('has_password / mfa_enrolled come from Auth itself', ctx2.has_password === true && ctx2.mfa_enrolled === true, JSON.stringify(ctx2));
check('get_my_context never returns the password hash', !JSON.stringify(ctx2).includes('$2a$'));
const sec = await as(U.admin, 'authenticated', async (q) => (await q(`select public.admin_user_security($1, 'mfa_reset') as r`, [U.nutA])).rows[0].r as { email: string });
check('IT Admin can authorise an authenticator reset (audited)', sec.email === email('nutA') && (await count(U.admin, `public.audit_log where action = 'user.mfa-reset'`)) === 1);
await fails('IT Admin cannot reset their own authenticator', as(U.admin, 'authenticated', (q) => q(`select public.admin_user_security($1, 'mfa_reset')`, [U.admin])), /another IT Admin/);
await fails('Non-admin cannot issue password reset links', as(U.nutB, 'authenticated', (q) => q(`select public.admin_user_security($1, 'password_reset')`, [U.nutA])), /cannot perform/);
await fails('Password-only admin cannot issue reset links', aal1(U.admin, (q) => q(`select public.admin_user_security($1, 'password_reset')`, [U.nutA])), /authenticator/);

// ── master data: collectors + bulk upload (all rows or none) ─────────────────
await succeeds('IT Admin adds a collector to an existing area', rpc(U.admin, 'admin_upsert_collector', { code: 'DX01-CA9101-801', name: 'Verify Collector', area_code: 'DX01-CA9101' }));
await fails('Collector code must start with its area code (never repaired)', rpc(U.admin, 'admin_upsert_collector', { code: 'DX02-CA9101-802', name: 'X', area_code: 'DX01-CA9101' }), /does not start with/);
await fails('Collector in an unknown area is refused', rpc(U.admin, 'admin_upsert_collector', { code: 'ZZ01-CA0000-001', name: 'X', area_code: 'ZZ01-CA0000' }), /Unknown collection area/);
await fails('Non-admin cannot add collectors', rpc(U.nutA, 'admin_upsert_collector', { code: 'DX01-CA9101-803', name: 'X', area_code: 'DX01-CA9101' }), /cannot perform/);
const bulkOk = await as(U.admin, 'authenticated', async (q) =>
  (await q(`select public.admin_bulk_upsert('collectors', $1::jsonb) as r`, [JSON.stringify([{ _row: 2, code: 'DX01-CA9101-901', name: 'Bulk One', area_code: 'DX01-CA9101' }, { _row: 3, code: 'DX01-CA9101-902', name: 'Bulk Two', area_code: 'DX01-CA9101' }])])).rows[0].r as { count: number });
check('Bulk upload saves every row', bulkOk.count === 2 && (await count(U.admin, `public.collectors where code like 'DX01-CA9101-90_'`)) === 2);
await fails(
  'Bulk upload with one bad row is refused and names the row',
  as(U.admin, 'authenticated', (q) => q(`select public.admin_bulk_upsert('collectors', $1::jsonb)`, [JSON.stringify([{ _row: 2, code: 'DX01-CA9101-903', name: 'Fine', area_code: 'DX01-CA9101' }, { _row: 3, code: 'BAD-1', name: 'Bad', area_code: 'DX01-CA9101' }])])),
  /Row 3/,
);
check('…and nothing from that file was saved (all or nothing)', (await count(U.admin, `public.collectors where code = 'DX01-CA9101-903'`)) === 0);
const ring = [[-1.0, 9.0], [-0.99, 9.0], [-0.99, 9.01], [-1.0, 9.0]];
await succeeds('Bulk upload of collection areas (polygon + operational area)', as(U.admin, 'authenticated', (q) => q(`select public.admin_bulk_upsert('collection_areas', $1::jsonb)`, [JSON.stringify([{ _row: 2, code: 'ca-vf01-ca0001', area_code: 'VF01-CA0001', name: 'Verify Area', operational_area: 'Verify', polygon: ring, lat: 9.003, lng: -0.995, geometry_source: 'verify' }])])));
await fails('Non-admin cannot bulk upload', as(U.nutA, 'authenticated', (q) => q(`select public.admin_bulk_upsert('collectors', '[{}]'::jsonb)`)), /cannot perform/);
await fails('Unknown bulk type refused', as(U.admin, 'authenticated', (q) => q(`select public.admin_bulk_upsert('users', '[{}]'::jsonb)`)), /Unknown import type/);

// ── report ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `\n      ↳ ${r.detail}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
