-- ════════════════════════════════════════════════════════════════════════════
-- Savannah Trace — core schema
-- Operational identifiers (lot / ODK batch / LPO / SFCL codes) are stored exactly
-- as officers enter them. Internal keys are UUIDs. Lineage is explicit
-- (transformation inputs/outputs). Stock is derived from an append-only ledger.
-- No real collector data, prices, coordinates or polygons belong in migrations.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists private;
revoke all on schema private from public;

-- ── enums ────────────────────────────────────────────────────────────────────
create type public.app_role as enum ('nut_officer', 'butter_officer', 'supply_chain', 'commercial', 'it_admin', 'auditor');
create type public.account_status as enum ('active', 'suspended');
create type public.invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');
create type public.location_kind as enum ('collection_area', 'phc', 'butter_centre', 'warehouse', 'port', 'terminal', 'destination_warehouse', 'refiner', 'filterer', 'client');
create type public.product_code as enum ('OFN', 'ODK', 'OSB', 'ORSB', 'OFSB', 'OFSB-FFL');
create type public.event_type as enum ('purchase', 'shipment', 'receipt', 'group_issue', 'transformation', 'ready_for_pickup', 'delivery');
create type public.event_status as enum ('draft', 'committed', 'superseded');
create type public.transform_kind as enum ('ofn_to_odk', 'odk_to_osb', 'sfcl_aggregation', 'refining', 'filtering');
create type public.receipt_outcome as enum ('accepted', 'discrepancy');
create type public.shipment_state as enum ('in_transit', 'received', 'received_with_discrepancy');
create type public.handoff_status as enum ('new', 'acknowledged');
create type public.invoice_status as enum ('not_started', 'in_preparation', 'recorded');
-- full = the client sees the entire SFCL trace (exact places, lot IDs); never collector names or prices
create type public.disclosure_mode as enum ('full', 'generalized', 'masked');
create type public.stock_bucket as enum ('on_hand', 'in_transit', 'issued');
create type public.lot_kind as enum ('purchase', 'kernel_batch', 'lpo', 'sfcl', 'refined', 'filtered');

-- ── master data ──────────────────────────────────────────────────────────────
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9-]{2,64}$'),
  name text not null,
  kind public.location_kind not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  public_label text not null,
  country text not null,
  account_code text,
  public_place boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A collection area is a location of kind collection_area plus area metadata.
create table public.collection_areas (
  location_id uuid primary key references public.locations (id) on delete restrict,
  area_code text not null unique, -- operational-area prefix + CA code, e.g. DX01-CA9101
  operational_area text not null,
  public_polygon jsonb, -- customer-approved generalised geometry ([lng,lat] ring)
  certification jsonb not null default '{}'::jsonb
);

-- Precise boundaries are sensitive: separate table, stricter policy.
create table public.collection_area_geometry (
  location_id uuid primary key references public.collection_areas (location_id) on delete restrict,
  polygon jsonb not null check (jsonb_typeof(polygon) = 'array'),
  geometry_source text not null,
  accuracy_m numeric,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table public.collectors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique, -- area code + collector number
  collection_area_id uuid not null references public.collection_areas (location_id),
  active boolean not null default true
);

-- Personal data kept apart so most roles never receive it.
create table public.collector_personal (
  collector_id uuid primary key references public.collectors (id) on delete cascade,
  full_name text not null
);

create table public.processing_groups (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  centre_id uuid not null references public.locations (id),
  name text not null,
  members integer not null default 0 check (members >= 0),
  active boolean not null default true,
  unique (centre_id, name)
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

-- ── identity & access (authorization lives here, never in auth user_metadata) ─
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete restrict,
  display_name text not null,
  status public.account_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id),
  role public.app_role not null,
  active boolean not null default true,
  granted_by uuid references public.profiles (user_id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index app_user_roles_one_active on public.app_user_roles (user_id) where active;

create table public.user_location_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id),
  location_id uuid not null references public.locations (id),
  active boolean not null default true,
  assigned_by uuid references public.profiles (user_id),
  starts_on date not null default current_date,
  ends_on date,
  created_at timestamptz not null default now()
);
create unique index user_location_assignments_active on public.user_location_assignments (user_id, location_id) where active;
create index user_location_assignments_user on public.user_location_assignments (user_id) where active;

create table public.user_client_assignments (
  user_id uuid not null references public.profiles (user_id),
  client_id uuid not null references public.clients (id),
  active boolean not null default true,
  primary key (user_id, client_id)
);

create table public.user_invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name text not null,
  role public.app_role not null,
  status public.invitation_status not null default 'pending',
  expires_at timestamptz not null,
  invited_by uuid references public.profiles (user_id),
  accepted_by uuid references auth.users (id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index user_invitations_one_pending on public.user_invitations (email) where status = 'pending';

create table public.invitation_locations (
  invitation_id uuid not null references public.user_invitations (id) on delete cascade,
  location_id uuid not null references public.locations (id),
  primary key (invitation_id, location_id)
);
create table public.invitation_clients (
  invitation_id uuid not null references public.user_invitations (id) on delete cascade,
  client_id uuid not null references public.clients (id),
  primary key (invitation_id, client_id)
);

-- ── traceability ─────────────────────────────────────────────────────────────
create table public.events (
  id uuid primary key default gen_random_uuid(),
  event_type public.event_type not null,
  occurred_at timestamptz not null,
  occurred_tz text not null check (occurred_tz ~ '^[+-][0-9]{2}:[0-9]{2}$'),
  recorded_at timestamptz not null default now(),
  actor_id uuid not null references public.profiles (user_id),
  actor_role public.app_role not null, -- frozen at write time for audit
  location_id uuid not null references public.locations (id),
  status public.event_status not null default 'committed',
  supersedes_event_id uuid references public.events (id),
  idempotency_key text not null check (length(idempotency_key) between 8 and 120),
  notes text,
  schema_version integer not null default 1,
  version integer not null default 1,
  unique (actor_id, idempotency_key)
);
create index events_actor on public.events (actor_id);
create index events_location on public.events (location_id);
create index events_occurred on public.events (occurred_at);
create index events_status on public.events (status);

create table public.lots (
  id uuid primary key default gen_random_uuid(),
  code text not null unique, -- officer-supplied, stored exactly as entered
  product public.product_code not null,
  unit text not null default 'kg' check (unit = 'kg'),
  lot_kind public.lot_kind not null,
  created_by_event uuid not null references public.events (id),
  created_at_location uuid not null references public.locations (id),
  created_at timestamptz not null, -- event time of creation
  sfcl_stage text check (sfcl_stage in ('in_progress', 'finalized')),
  check ((lot_kind = 'sfcl') = (sfcl_stage is not null))
);
create index lots_created_by on public.lots (created_by_event);

create table public.purchase_events (
  event_id uuid primary key references public.events (id),
  collector_id uuid not null references public.collectors (id),
  collection_area_id uuid not null references public.collection_areas (location_id),
  lot_id uuid not null unique references public.lots (id),
  product public.product_code not null check (product in ('OFN', 'ODK')),
  quantity_kg numeric(12, 3) not null check (quantity_kg > 0),
  purchase_date date not null,
  constraint one_purchase_per_collector_per_day unique (collector_id, purchase_date)
);
create index purchase_events_area on public.purchase_events (collection_area_id);

create table public.purchase_prices (
  event_id uuid primary key references public.purchase_events (event_id),
  price_per_kg numeric(12, 4) not null check (price_per_kg >= 0),
  currency text not null default 'GHS'
);

create table public.shipment_events (
  event_id uuid primary key references public.events (id),
  origin_id uuid not null references public.locations (id),
  destination_id uuid not null references public.locations (id),
  shipment_ref text,
  container_no text,
  vessel text,
  eta date,
  route_leg integer,
  client_id uuid references public.clients (id),
  order_ref text,
  state public.shipment_state not null default 'in_transit',
  check (origin_id <> destination_id)
);
create index shipment_events_destination on public.shipment_events (destination_id);
create index shipment_events_origin on public.shipment_events (origin_id);

create table public.shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_event_id uuid not null references public.shipment_events (event_id),
  lot_id uuid not null references public.lots (id),
  quantity_kg numeric(12, 3) not null check (quantity_kg > 0),
  unique (shipment_event_id, lot_id)
);
create index shipment_items_lot on public.shipment_items (lot_id);

create table public.receipt_events (
  event_id uuid primary key references public.events (id),
  shipment_event_id uuid not null unique references public.shipment_events (event_id),
  outcome public.receipt_outcome not null,
  discrepancy_note text,
  resolved_at timestamptz,
  resolution_note text,
  resolved_by uuid references public.profiles (user_id),
  check (outcome = 'accepted' or discrepancy_note is not null)
);

create table public.receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_event_id uuid not null references public.receipt_events (event_id),
  lot_id uuid not null references public.lots (id),
  quantity_kg numeric(12, 3) not null check (quantity_kg >= 0),
  unique (receipt_event_id, lot_id)
);

create table public.group_issue_events (
  event_id uuid primary key references public.events (id),
  group_id uuid not null references public.processing_groups (id)
);
create table public.group_issue_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.group_issue_events (event_id),
  lot_id uuid not null references public.lots (id),
  quantity_kg numeric(12, 3) not null check (quantity_kg > 0),
  unique (event_id, lot_id)
);

create table public.transformation_events (
  event_id uuid primary key references public.events (id),
  kind public.transform_kind not null,
  group_id uuid references public.processing_groups (id),
  check ((kind = 'odk_to_osb') = (group_id is not null))
);
create table public.transformation_inputs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.transformation_events (event_id),
  lot_id uuid not null references public.lots (id),
  quantity_kg numeric(12, 3) not null check (quantity_kg > 0),
  unique (event_id, lot_id)
);
create index transformation_inputs_lot on public.transformation_inputs (lot_id);
create table public.transformation_outputs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.transformation_events (event_id),
  lot_id uuid not null unique references public.lots (id),
  quantity_kg numeric(12, 3) not null check (quantity_kg > 0)
);

-- Immutable stock movements. Current stock = SUM(quantity_kg) per lot/location/bucket(/group).
create table public.inventory_ledger (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events (id),
  lot_id uuid not null references public.lots (id),
  location_id uuid not null references public.locations (id),
  group_id uuid references public.processing_groups (id),
  bucket public.stock_bucket not null,
  quantity_kg numeric(12, 3) not null check (quantity_kg <> 0),
  created_at timestamptz not null default now(),
  check ((bucket = 'issued') = (group_id is not null))
);
create index inventory_ledger_lot_loc on public.inventory_ledger (lot_id, location_id, bucket);
create index inventory_ledger_location on public.inventory_ledger (location_id);
create index inventory_ledger_event on public.inventory_ledger (event_id);

create table public.event_corrections (
  id uuid primary key default gen_random_uuid(),
  original_event_id uuid not null references public.events (id),
  reason text not null check (length(trim(reason)) > 0),
  requested_by uuid not null references public.profiles (user_id),
  approved_by uuid references public.profiles (user_id),
  approved_at timestamptz,
  before jsonb not null,
  after jsonb not null,
  created_at timestamptz not null default now()
);

create table public.commercial_handoffs (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.lots (id),
  ready_event_id uuid not null unique references public.events (id),
  location_id uuid not null references public.locations (id),
  client_id uuid not null references public.clients (id),
  order_ref text not null,
  quantity_kg numeric(12, 3) not null check (quantity_kg > 0),
  status public.handoff_status not null default 'new',
  acknowledged_by uuid references public.profiles (user_id),
  acknowledged_at timestamptz,
  invoice_ref text,
  invoice_status public.invoice_status not null default 'not_started',
  disclosure public.disclosure_mode not null default 'full',
  created_at timestamptz not null default now(),
  unique (lot_id, location_id)
);
create index commercial_handoffs_client on public.commercial_handoffs (client_id);
create index commercial_handoffs_location on public.commercial_handoffs (location_id);

-- Customer links: only a hash of the token is stored. The token itself is derived
-- server-side (HMAC with an Edge Function secret) so Commercial can re-display it.
create table public.customer_trace_grants (
  id uuid primary key default gen_random_uuid(),
  handoff_id uuid not null unique references public.commercial_handoffs (id),
  token_hash bytea unique,
  allowed_fields jsonb not null default '["product","origin_region","stages","destination_status","public_documents"]'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles (user_id),
  created_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  storage_bucket text not null default 'trace-documents',
  storage_path text not null,
  title text not null,
  kind text not null check (kind in ('certificate', 'analysis', 'shipping', 'receipt', 'photo')),
  lot_id uuid references public.lots (id),
  customer_visible boolean not null default false,
  uploaded_by uuid references public.profiles (user_id),
  created_at timestamptz not null default now()
);

-- Append-only audit trail (invites, role changes, suspensions, corrections, writes).
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  action text not null,
  target_table text,
  target_id text,
  summary text not null,
  details jsonb
);
create index audit_log_at on public.audit_log (at desc);

-- Reads of full traces by auditors/admins are logged ("record its use").
create table public.access_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid not null,
  action text not null,
  target text not null
);
