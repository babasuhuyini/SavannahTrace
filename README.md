# Savannah Trace

<img src="docs/brand/savannah-trace-logo.svg" alt="Savannah Trace" height="40">

Savannah Fruits Company's own organic-shea chain-of-custody system: purchases → post-harvest → butter centres → warehouse SFCL aggregation → export → destination, with backward/forward genealogy, an interactive trace map, Commercial handoffs and a customer-safe trace page. It is an independent system and does **not** integrate with the current vendor platform.

It runs in two modes:

| Mode | When | Data & sign-in |
|---|---|---|
| **Demo** (default) | No Supabase settings in `.env.local` | Fictional sample data in the browser's `localStorage`. A **Demo** menu switches between simulated users. Sign-in screens are previews; nothing is emailed. Not secure — for walkthroughs only. |
| **Live** | `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` set | Supabase Auth (invitation-only, email code or Google). Every read is filtered by Postgres Row Level Security; every write goes through transactional SQL functions. **Not yet run against a hosted project** — see *Status* below. |

## Run locally

Requires Node.js 18+.

```bash
npm install
npm run dev            # http://localhost:5173  (demo mode)
npm run dev:lan        # also on your Wi-Fi address, to scan customer QR codes from a phone
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | Type-check and build to `dist/` |
| `npm run typecheck` | TypeScript only |
| `npm run verify:rls` | Runs all Supabase migrations in an in-process Postgres (PGlite) and checks 100+ allowed/denied access cases with synthetic users for every role |
| `npm run seed:sql` | Regenerates `supabase/seed.sql` from the fictional demo master data |

## Reports and exports

**Reports** (every role) downloads CSV files that open directly in Excel (UTF-8 with BOM; formula-safe):

- **Trace report** for any SFCL or finished product in your scope: every step (events CSV) and the input → output lineage.
- **Registers**, filtered by event date: purchases, shipments and receipts, transformations, SFCL summary, stock position, handoffs, validation findings and audit history.

Each file contains only what the signed-in role can see. Collector names and prices appear only for IT Admin, Auditor and the Nut officer for their own areas. The Trace explorer, the Commercial handoffs and the customer page also offer a trace CSV.

## Using the demo

Open the **Demo** menu (top right) to sign in as a different fictional user:

- **Nut Field Officer A / B** — purchases and upstream movement for their own areas only.
- **Butter Officer (Tamba)** / **(Kalbe + warehouse)** — inbound consignments for their centre, receipt or discrepancy, issue to groups, LPO processing; the Kalbe user also owns warehouse SFCL aggregation and dispatch.
- **Supply Chain** — export legs, arrival, refining/filtering, *Arrived and ready for pickup*.
- **Commercial** — handoffs for assigned clients, trace link + QR, illustrative invoice reference.
- **IT Admin** — users & access (invite, role/location assignment, suspend, recovery), master data, audit, full trace.
- **Auditor** — read-only audit and trace within an assigned scope.

The same menu has *Preview sign-in & invitation screens*, the sample locations/geometry editor, and *Reset demo data*.

## Project layout

```
src/
  data/            types, fictional geography (replace with approved data), seed scenario, demo users
  domain/          engine (validation, custody, mass balance), trace/genealogy, access rules, stores
  backend/         Supabase client, live store, snapshot mapping, public trace fetch (live mode only)
  components/      map (MapLibre, lazy-loaded), timeline, genealogy, QR, UI primitives
  pages/           role homes, lots, trace explorer, handoffs, users & access, audit, master data, auth
supabase/
  migrations/      schema, RLS policies, workflow functions, identity/admin, snapshot, public trace
  functions/       Edge Functions: admin-users, trace-link, public-trace
  seed.sql         synthetic master data (generated)
  tests/           PGlite-only stub of the Supabase auth schema used by verify:rls
scripts/           verify-rls.ts, generate-seed-sql.ts
docs/              SUPABASE_SETUP.md, SECURITY.md
```

## Status (what is and isn't proven)

- **Works now (demo):** all screens, role-specific panels, forms with live validation, trace map/timeline/genealogy, customer page and QR, user-management and sign-in UI states.
- **Verified offline:** the SQL schema, RLS policies and workflow functions, using `npm run verify:rls` against real Postgres (PGlite) with a stand-in for Supabase's `auth` schema.
- **Written but not yet run against Supabase:** Supabase Auth flows (email code, Google, invitations), the live store, Edge Functions, Realtime. These need a Supabase project — see [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).

## Replacing demo data

Facility coordinates: `DEMO_LOCATIONS` in `src/data/geography.ts`. Collection-area polygons: `DEMO_COLLECTION_AREAS` (GeoJSON `[lng, lat]`). In live mode, master data lives in the database and is edited by IT Admin. Precise polygons and collector names are sensitive and are kept in separate, stricter tables.

## Brand

Name, logo, palette, typography and interface rules: [docs/BRAND.md](docs/BRAND.md), with a visual sheet at [docs/brand/brand-guidelines.html](docs/brand/brand-guidelines.html) and logo files in [docs/brand/](docs/brand/). Tokens live in `src/styles.css`; the React mark is `src/components/Brand.tsx`.

## Keeping the Free plan awake

`.github/workflows/keepalive.yml` calls `public.keepalive()` every two days so the Free-plan project is not paused while customer links are in use. It needs the repository secrets `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` — see [docs/SUPABASE_SETUP.md §12](docs/SUPABASE_SETUP.md). Move to a paid plan before customer links are printed.

## Git

This folder is ready for a **private** GitHub repository (`.gitignore` excludes `node_modules`, `dist`, `.env*` and spreadsheets). No remote is configured and nothing has been pushed. GitHub stores source code only; sign-in, invitations and data need the Supabase project. A static host (e.g. GitHub Pages) can serve the front end, but it is not an authentication backend.
