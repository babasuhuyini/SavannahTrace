# Access model and security boundaries

The database is the security boundary. The React app hides screens for convenience only.

## Identity

- Supabase Auth handles identity: email one-time code, or Google whose verified email matches an invitation.
- Accounts are by invitation only. Public sign-up is disabled.
- Authorization comes from protected tables, never from user-editable `user_metadata`:
  - `profiles.status` (active/suspended)
  - `app_user_roles` (one active role per user)
  - `user_location_assignments`
  - `user_client_assignments` (Commercial)
- There are no passwords, so nobody (including IT) can see or set one. "Recovery" sends a fresh verified sign-in email.

## Reads: Row Level Security

- RLS is enabled on every `public` table, and anonymous users have no table grants.
- Signed-in users have `SELECT` only, filtered by these helpers in the non-exposed `private` schema:

| Helper | Rule |
|---|---|
| `event_visible(e)` | IT Admin: all. Commercial: none. Auditor: assigned audit scope. Officers: own entries, plus activity at assigned locations, plus **shipments addressed to an assigned location** (the hand-off exception) |
| `lot_visible(l)` | Lots with stock at, inbound to, or created at the user's locations; Commercial only their handoff lots |
| `handoff_visible(h)` | Commercial: assigned clients. Supply Chain/Auditor: assigned locations. IT Admin: all |
| `collector_pii_visible(c)` | Collector names: IT Admin, plus Nut Officers/Auditors assigned to that collection area |

- Prices: IT Admin, Auditor in scope, and the officer who recorded the purchase.
- Exact collection boundaries are in a separate table: IT Admin and users assigned to that area only.
- Every helper checks `profiles.status = 'active'`, so **suspension takes effect on the next query**. The `admin-users` function also bans the Auth user so refresh tokens stop working.

## Writes: workflow functions

There are no `INSERT`/`UPDATE`/`DELETE` grants on any table. All writes go through `SECURITY DEFINER` functions with `search_path = ''`. Each function:

- checks the caller's role and assigned origin, destination or processing location
- locks the lots involved (ordered by id) to stop concurrent double spending
- checks stock as of the event time **and** now, chronology, product route, and that identifiers exist (never guessed or repaired)
- enforces one purchase per collector per day, the SFCL 21,000 kg rule (finalize at exactly 21,000; never above), and LPO draws within available balance (above 3,000 kg is a warning only)
- is idempotent per (user, idempotency key)
- writes event + details + immutable ledger rows + audit entry atomically
- supports `dry_run` validation

Corrections append history (reason, before/after) and bump the version. Committed events are never deleted.

## Customer links

- `mark_ready_for_pickup` is allowed only at the refiner or filterer. In Amsterdam a shipment is either refined or filtered, and Supply Chain records both steps. It creates one handoff and one trace grant per lot and place.
- The `trace-link` function (caller authorised by RLS) derives the token as `HMAC(TRACE_LINK_SECRET, grant_id)`. The database stores only `SHA-256(token)`.
- The anonymous `public-trace` function resolves the hash through `service_public_trace`. What it returns depends on the handoff's disclosure setting, which Commercial picks per client:

| Setting | What the client sees |
|---|---|
| **full** (default, SFCL decision 8 Nov 2026) | The entire SFCL trace: every step, facility, lot/batch ID, quantity, date, the genealogy and the collection-area boundaries |
| generalized | Stage summaries, rounded locations, generalised origin circles, purchase lots replaced by aliases |
| masked | As generalized, with coarser rounding and no origin shapes |

In **every** mode the payload excludes collector names, prices, internal notes, validation findings and user identities.

- Grants support expiry and revocation.

## Verified vs. not yet verified

| Area | Status |
|---|---|
| Schema, RLS, workflow functions, admin RPCs, public payload | `npm run verify:rls` (PGlite / real Postgres engine, Supabase auth schema emulated) |
| Supabase Auth email OTP, Google OAuth, invitation emails | Needs a hosted project |
| Edge Functions (Deno) | Written; not executed |
| PostgREST exposure, Realtime filtering | Needs a hosted project |

## Before production

- Run the acceptance checks in `docs/SUPABASE_SETUP.md` §7.
- Add rate limiting in front of `public-trace`.
- Configure custom SMTP and scheduled database dumps (the Free plan has no PITR).
- Do a privacy review of cross-border hosting and collector data retention.
