# Access model and security boundaries

The database is the security boundary. The React app hides screens for convenience only.

## Identity

- Supabase Auth handles identity: **email + password + a 6-digit code from an authenticator app (TOTP MFA)**, mandatory for every account.
- MFA is enforced in the database, not only on screen: `private.is_active()`, `private.my_role()` and `private.my_location_ids()` all require an `aal2` session, so every RLS policy, workflow function and admin function refuses a session that has only passed the password step.
- Accounts are by invitation only. Public sign-up is disabled.
- Authorization comes from protected tables, never from user-editable `user_metadata`:
  - `profiles.status` (active/suspended)
  - `app_user_roles` (one active role per user)
  - `user_location_assignments`
  - `user_client_assignments` (Commercial)
- Passwords are stored only by Supabase Auth (bcrypt). IT can never see or set one: IT issues one-time links (invitation or password reset, single use, 24 h) with which the person chooses their own password. After a reset, the authenticator code is still required.
- Password rules: server-side at least 12 characters with letters and digits; in the app additionally not a common/guessable password, not containing the person's name or email, and not found in known data breaches (Have I Been Pwned range API with k-anonymity: only 5 characters of the SHA-1 hash leave the browser).
- Password handling in the app: inputs are `type=password` with no reveal button; the value is never kept in app state, storage, logs or URLs — it is read from the field once on submit and the field is cleared; forms use `method=post` so a failed script can never put a password in the address bar. A Content-Security-Policy allows only the app's own scripts, and `Referrer-Policy: no-referrer` is set.
- One-time links carry their token in the URL fragment (never sent to servers), are removed from the address bar on arrival, and are only used after the person presses **Continue**, so email link scanners cannot consume them.
- Sign-in errors never reveal whether an email has an account. Supabase rate-limits sign-in attempts and code checks per IP address.
- Lost phone: IT **Reset authenticator** (audited); the user sets it up again at their next sign-in. An IT Admin cannot reset their own authenticator.

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
| MFA (aal2) enforcement, password-state context, reset authorisation, bulk master-data upload | `npm run verify:rls` |
| Sign-in / invite / authenticator / password screens, bulk upload of CSV and .xlsx | Browser end-to-end test on the demo build (CSP on) |
| Supabase Auth password + TOTP against the hosted project, invitation emails | Needs the 9 Nov deployment (SUPABASE_SETUP.md step 6b) |
| Edge Functions (Deno) | Written; not executed |
| PostgREST exposure, Realtime filtering | Needs a hosted project |

## Before production

- Run the acceptance checks in `docs/SUPABASE_SETUP.md` §7.
- Add rate limiting in front of `public-trace`.
- Configure custom SMTP and scheduled database dumps (the Free plan has no PITR).
- Do a privacy review of cross-border hosting and collector data retention.
