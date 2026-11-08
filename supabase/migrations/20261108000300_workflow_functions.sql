-- ════════════════════════════════════════════════════════════════════════════
-- Workflow functions: the ONLY write path for operational data.
--
-- Each function runs in one transaction and:
--   • verifies the caller's active account, role and assigned location(s)
--   • locks the lots it consumes (ordered by id) so concurrent requests cannot
--     spend the same stock twice
--   • checks stock as of the event time AND now (no back-dated over-draw)
--   • checks chronology on full timestamps, product flow and identifiers
--   • never invents or rewrites an identifier — mismatches are errors or warnings
--   • is idempotent per (actor, idempotency_key): a retry returns the first result
--   • writes event + detail rows + ledger movements + audit entry atomically
--   • supports {"dry_run": true}: full validation, then everything is rolled back
-- ════════════════════════════════════════════════════════════════════════════

-- ── internal helpers ─────────────────────────────────────────────────────────
create or replace function private.require_role(allowed public.app_role[]) returns public.app_role
language plpgsql stable security definer set search_path = '' as $$
declare r public.app_role;
begin
  if (select auth.uid()) is null then raise exception 'Not signed in.' using errcode = '42501'; end if;
  r := private.my_role();
  if r is null then raise exception 'Your account has no active access (not invited, suspended or no role).' using errcode = '42501'; end if;
  if not (r = any (allowed)) then raise exception 'Your role (%) cannot perform this action.', r using errcode = '42501'; end if;
  return r;
end $$;

create or replace function private.require_assigned(loc uuid, what text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_assigned(loc) then
    raise exception 'You are not assigned to %.', what using errcode = '42501';
  end if;
end $$;

create or replace function private.location_by_code(c text) returns public.locations
language plpgsql stable security definer set search_path = '' as $$
declare l public.locations;
begin
  select * into l from public.locations where code = c and active;
  if not found then raise exception 'Unknown location "%".', c using errcode = 'P0001'; end if;
  return l;
end $$;

create or replace function private.lot_by_code(c text) returns public.lots
language plpgsql stable security definer set search_path = '' as $$
declare l public.lots;
begin
  select * into l from public.lots where code = c;
  if not found then
    raise exception 'Unknown identifier "%". Identifiers are matched exactly and never guessed or repaired.', c using errcode = 'P0001';
  end if;
  return l;
end $$;

create or replace function private.check_time(at timestamptz, tz text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if at is null then raise exception 'Event time is required (when the activity actually happened).'; end if;
  if tz is null or tz !~ '^[+-][0-9]{2}:[0-9]{2}$' then raise exception 'Event time zone offset is required, e.g. +00:00.'; end if;
  if at > now() + interval '5 minutes' then raise exception 'Event time % is in the future.', at; end if;
end $$;

create or replace function private.existing_event(idem text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.events where actor_id = (select auth.uid()) and idempotency_key = idem;
$$;

create or replace function private.begin_event(etype public.event_type, at timestamptz, tz text, loc uuid, idem text, notes text, st public.event_status default 'committed')
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v uuid;
begin
  if idem is null or length(idem) < 8 then raise exception 'An idempotency key is required.'; end if;
  insert into public.events (event_type, occurred_at, occurred_tz, actor_id, actor_role, location_id, idempotency_key, notes, status)
  values (etype, at, tz, (select auth.uid()), private.my_role(), loc, idem, nullif(trim(notes), ''), st)
  returning id into v;
  return v;
end $$;

create or replace function private.audit(action text, tbl text, target text, summary text, details jsonb default null) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, action, target_table, target_id, summary, details)
  values ((select auth.uid()), action, tbl, target, summary, details);
$$;

-- Stock of a lot at a location/bucket(/group), optionally only from events strictly before `as_of`.
create or replace function private.stock(lot uuid, loc uuid, b public.stock_bucket, grp uuid, as_of timestamptz)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(il.quantity_kg), 0)
  from public.inventory_ledger il
  join public.events e on e.id = il.event_id
  where il.lot_id = lot and il.location_id = loc and il.bucket = b
    and il.group_id is not distinct from grp
    and (as_of is null or e.occurred_at < as_of);
$$;

create or replace function private.lock_lots(codes text[]) returns void
language sql volatile security definer set search_path = '' as $$
  select 1 from public.lots where code = any (codes) order by id for update;
$$;

-- Take stock out of a bucket. Fails if not held, not enough at that time, or if it
-- would overdraw what later (already recorded) events depend on.
create or replace function private.consume(l public.lots, loc uuid, b public.stock_bucket, grp uuid, qty numeric, at timestamptz, ev uuid, place text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_asof numeric; v_now numeric;
begin
  if qty is null or qty <= 0 then raise exception 'Quantity for % must be a positive number of kg.', l.code; end if;
  if l.created_at >= at then
    raise exception '% is used at %, before or at the time it was created (%).', l.code, at, l.created_at;
  end if;
  v_asof := private.stock(l.id, loc, b, grp, at);
  v_now := private.stock(l.id, loc, b, grp, null);
  if v_asof <= 0 then raise exception '% is not held at % at that time.', l.code, place; end if;
  if qty > v_asof then raise exception 'Uses % kg of %, but only % kg was available at % at that time.', qty, l.code, v_asof, place; end if;
  if qty > v_now then raise exception 'Uses % kg of %, but later recorded events leave only % kg at %.', qty, l.code, v_now, place; end if;
  insert into public.inventory_ledger (event_id, lot_id, location_id, group_id, bucket, quantity_kg) values (ev, l.id, loc, grp, b, -qty);
end $$;

create or replace function private.codes(items jsonb, key text default 'lot_code') returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(x ->> key), '{}') from jsonb_array_elements(coalesce(items, '[]'::jsonb)) x;
$$;

-- ── purchase (Commission) ────────────────────────────────────────────────────
create or replace function public.record_purchase(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.app_role := private.require_role(array['nut_officer']::public.app_role[]);
  v_existing uuid := private.existing_event(p ->> 'idempotency_key');
  v_col public.collectors;
  v_at timestamptz := (p ->> 'occurred_at')::timestamptz;
  v_tz text := p ->> 'occurred_tz';
  v_qty numeric := (p ->> 'quantity_kg')::numeric;
  v_product public.product_code := (p ->> 'product')::public.product_code;
  v_date date := (p ->> 'purchase_date')::date;
  v_code text := p ->> 'lot_code';
  v_ev uuid;
  v_lot uuid;
  v_expected text;
  v_warn text[] := '{}';
begin
  if v_existing is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', v_existing); end if;
  begin
    select * into v_col from public.collectors where code = p ->> 'collector_code' and active;
    if not found then raise exception 'Collector "%" is not on the collector register.', p ->> 'collector_code'; end if;
    perform private.require_assigned(v_col.collection_area_id, 'this collection area');
    perform private.check_time(v_at, v_tz);
    if v_product not in ('OFN', 'ODK') then raise exception 'A purchase must be OFN or ODK.'; end if;
    if v_qty is null or v_qty <= 0 then raise exception 'Quantity must be a positive number of kg.'; end if;
    if v_date is null then raise exception 'Purchase date is required.'; end if;
    if coalesce(trim(v_code), '') = '' then raise exception 'Lot ID is required (supplied by the officer).'; end if;
    if exists (select 1 from public.lots where code = v_code) then raise exception 'Lot ID % already exists. Each purchase lot ID must be unique.', v_code; end if;
    if exists (select 1 from public.purchase_events where collector_id = v_col.id and purchase_date = v_date) then
      raise exception 'This collector already has a purchase on %. Same collector + same date is one commission record.', v_date;
    end if;
    v_expected := v_col.code || '-' || to_char(v_date, 'MMDDYY');
    if v_code <> v_expected then
      v_warn := v_warn || format('Lot ID "%s" does not match the expected pattern "%s". Saved exactly as entered.', v_code, v_expected);
    end if;
    if (v_at at time zone v_tz::interval)::date <> v_date then
      v_warn := v_warn || 'Event date differs from the purchase date.'::text;
    end if;

    v_ev := private.begin_event('purchase', v_at, v_tz, v_col.collection_area_id, p ->> 'idempotency_key', p ->> 'notes');
    insert into public.lots (code, product, lot_kind, created_by_event, created_at_location, created_at)
    values (v_code, v_product, 'purchase', v_ev, v_col.collection_area_id, v_at) returning id into v_lot;
    insert into public.purchase_events (event_id, collector_id, collection_area_id, lot_id, product, quantity_kg, purchase_date)
    values (v_ev, v_col.id, v_col.collection_area_id, v_lot, v_product, v_qty, v_date);
    if nullif(p ->> 'price_per_kg', '') is not null then
      insert into public.purchase_prices (event_id, price_per_kg, currency) values (v_ev, (p ->> 'price_per_kg')::numeric, coalesce(p ->> 'currency', 'GHS'));
    end if;
    insert into public.inventory_ledger (event_id, lot_id, location_id, bucket, quantity_kg) values (v_ev, v_lot, v_col.collection_area_id, 'on_hand', v_qty);
    perform private.audit('event.recorded', 'events', v_ev::text, format('Purchase %s: %s kg %s', v_code, v_qty, v_product));
    if coalesce((p ->> 'dry_run')::boolean, false) then raise exception using errcode = 'P0D01', message = 'dry run'; end if;
  exception when sqlstate 'P0D01' then
    return jsonb_build_object('ok', true, 'dry_run', true, 'warnings', to_jsonb(v_warn));
  end;
  return jsonb_build_object('ok', true, 'event_id', v_ev, 'warnings', to_jsonb(v_warn));
end $$;

-- ── shipment ─────────────────────────────────────────────────────────────────
create or replace function public.record_shipment(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.app_role := private.require_role(array['nut_officer', 'butter_officer', 'supply_chain']::public.app_role[]);
  v_existing uuid := private.existing_event(p ->> 'idempotency_key');
  v_from public.locations;
  v_to public.locations;
  v_at timestamptz := (p ->> 'occurred_at')::timestamptz;
  v_tz text := p ->> 'occurred_tz';
  v_ev uuid;
  v_client uuid;
  v_item jsonb;
  v_lot public.lots;
  v_qty numeric;
begin
  if v_existing is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', v_existing); end if;
  begin
    v_from := private.location_by_code(p ->> 'origin_code');
    v_to := private.location_by_code(p ->> 'destination_code');
    perform private.require_assigned(v_from.id, 'the shipment origin');
    perform private.check_time(v_at, v_tz);
    if v_from.id = v_to.id then raise exception 'Origin and destination are the same location.'; end if;
    if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'A shipment needs at least one lot.'; end if;
    -- each role ships only along its own stage of the chain
    if v_role = 'nut_officer' and not (v_from.kind in ('collection_area', 'phc') and v_to.kind in ('phc', 'butter_centre')) then
      raise exception 'Nut officers ship from collection areas/PHCs to a PHC or butter centre.';
    elsif v_role = 'butter_officer' and not (v_from.kind in ('butter_centre', 'warehouse') and v_to.kind in ('warehouse', 'port')) then
      raise exception 'Butter officers ship from butter centres/warehouse to the warehouse or Tema.';
    elsif v_role = 'supply_chain' and not (v_from.kind in ('port', 'terminal', 'destination_warehouse', 'refiner', 'filterer') and v_to.kind in ('port', 'terminal', 'destination_warehouse', 'refiner', 'filterer', 'client')) then
      raise exception 'Supply Chain records export legs from Tema onwards.';
    end if;
    if nullif(p ->> 'client_name', '') is not null then
      select id into v_client from public.clients where name = p ->> 'client_name';
      if v_client is null then raise exception 'Unknown client "%".', p ->> 'client_name'; end if;
    end if;

    perform private.lock_lots(private.codes(p -> 'items'));
    v_ev := private.begin_event('shipment', v_at, v_tz, v_from.id, p ->> 'idempotency_key', p ->> 'notes');
    insert into public.shipment_events (event_id, origin_id, destination_id, shipment_ref, container_no, vessel, eta, route_leg, client_id, order_ref)
    values (v_ev, v_from.id, v_to.id, nullif(p ->> 'shipment_ref', ''), nullif(p ->> 'container_no', ''), nullif(p ->> 'vessel', ''), nullif(p ->> 'eta', '')::date,
            nullif(p ->> 'route_leg', '')::int, v_client, nullif(p ->> 'order_ref', ''));
    for v_item in select * from jsonb_array_elements(p -> 'items') loop
      v_lot := private.lot_by_code(v_item ->> 'lot_code');
      v_qty := (v_item ->> 'quantity_kg')::numeric;
      if v_lot.product = 'OFN' and v_to.kind <> 'phc' then
        raise exception '% is fresh nut (OFN): it must go to a Post Harvest Centre first.', v_lot.code;
      end if;
      if v_lot.lot_kind = 'sfcl' and v_lot.sfcl_stage <> 'finalized' then
        raise exception '% is still in progress and cannot ship until finalized at 21,000 kg.', v_lot.code;
      end if;
      perform private.consume(v_lot, v_from.id, 'on_hand', null, v_qty, v_at, v_ev, v_from.name);
      insert into public.shipment_items (shipment_event_id, lot_id, quantity_kg) values (v_ev, v_lot.id, v_qty);
      -- in-transit stock is booked against the destination so its assignees see what is coming
      insert into public.inventory_ledger (event_id, lot_id, location_id, bucket, quantity_kg) values (v_ev, v_lot.id, v_to.id, 'in_transit', v_qty);
    end loop;
    perform private.audit('event.recorded', 'events', v_ev::text, format('Shipment %s → %s (%s lots)', v_from.code, v_to.code, jsonb_array_length(p -> 'items')));
    if coalesce((p ->> 'dry_run')::boolean, false) then raise exception using errcode = 'P0D01', message = 'dry run'; end if;
  exception when sqlstate 'P0D01' then
    return jsonb_build_object('ok', true, 'dry_run', true);
  end;
  return jsonb_build_object('ok', true, 'event_id', v_ev);
end $$;

-- ── receipt (the hand-off) ───────────────────────────────────────────────────
create or replace function public.receive_shipment(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.app_role := private.require_role(array['nut_officer', 'butter_officer', 'supply_chain']::public.app_role[]);
  v_existing uuid := private.existing_event(p ->> 'idempotency_key');
  v_ship public.shipment_events;
  v_ship_at timestamptz;
  v_at timestamptz := (p ->> 'occurred_at')::timestamptz;
  v_tz text := p ->> 'occurred_tz';
  v_outcome public.receipt_outcome := coalesce(p ->> 'outcome', 'accepted')::public.receipt_outcome;
  v_ev uuid;
  r record;
  v_recv numeric;
  v_short boolean := false;
begin
  if v_existing is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', v_existing); end if;
  begin
    select * into v_ship from public.shipment_events where event_id = (p ->> 'shipment_event_id')::uuid for update;
    if not found then raise exception 'Unknown shipment.'; end if;
    -- only users assigned to the destination may receive (the shipment hand-off)
    perform private.require_assigned(v_ship.destination_id, 'the shipment destination');
    if exists (select 1 from public.receipt_events where shipment_event_id = v_ship.event_id) then
      raise exception 'This shipment has already been received.';
    end if;
    perform private.check_time(v_at, v_tz);
    select occurred_at into v_ship_at from public.events where id = v_ship.event_id;
    if v_at <= v_ship_at then raise exception 'Receipt time must be after the shipment left (%).', v_ship_at; end if;
    if v_outcome = 'discrepancy' and coalesce(trim(p ->> 'discrepancy_note'), '') = '' then raise exception 'Describe the discrepancy.'; end if;

    perform 1 from public.lots l join public.shipment_items si on si.lot_id = l.id where si.shipment_event_id = v_ship.event_id order by l.id for update of l;
    v_ev := private.begin_event('receipt', v_at, v_tz, v_ship.destination_id, p ->> 'idempotency_key', p ->> 'notes');
    insert into public.receipt_events (event_id, shipment_event_id, outcome, discrepancy_note) values (v_ev, v_ship.event_id, v_outcome, nullif(p ->> 'discrepancy_note', ''));
    for r in select si.lot_id, si.quantity_kg, l.code from public.shipment_items si join public.lots l on l.id = si.lot_id where si.shipment_event_id = v_ship.event_id loop
      select (x ->> 'quantity_kg')::numeric into v_recv from jsonb_array_elements(coalesce(p -> 'items', '[]')) x where x ->> 'lot_code' = r.code;
      if v_recv is null then raise exception 'Enter the received quantity for %.', r.code; end if;
      if v_recv < 0 then raise exception 'Received quantity for % cannot be negative.', r.code; end if;
      if v_recv > r.quantity_kg then raise exception 'Received % kg of % but only % kg was shipped.', v_recv, r.code, r.quantity_kg; end if;
      if v_recv < r.quantity_kg then
        v_short := true;
        if v_outcome = 'accepted' then raise exception 'Received less of % than shipped: record this as a discrepancy, not a full receipt.', r.code; end if;
      end if;
      insert into public.receipt_items (receipt_event_id, lot_id, quantity_kg) values (v_ev, r.lot_id, v_recv);
      insert into public.inventory_ledger (event_id, lot_id, location_id, bucket, quantity_kg) values (v_ev, r.lot_id, v_ship.destination_id, 'in_transit', -r.quantity_kg);
      if v_recv > 0 then
        insert into public.inventory_ledger (event_id, lot_id, location_id, bucket, quantity_kg) values (v_ev, r.lot_id, v_ship.destination_id, 'on_hand', v_recv);
      end if;
    end loop;
    update public.shipment_events set state = (case when v_outcome = 'discrepancy' then 'received_with_discrepancy' else 'received' end)::public.shipment_state where event_id = v_ship.event_id;
    perform private.audit('event.recorded', 'events', v_ev::text, format('Receipt (%s)%s', v_outcome, case when v_short then ' with shortfall' else '' end));
    if coalesce((p ->> 'dry_run')::boolean, false) then raise exception using errcode = 'P0D01', message = 'dry run'; end if;
  exception when sqlstate 'P0D01' then
    return jsonb_build_object('ok', true, 'dry_run', true);
  end;
  return jsonb_build_object('ok', true, 'event_id', v_ev);
end $$;

-- ── issue accepted ODK to a processing group ─────────────────────────────────
create or replace function public.issue_to_group(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.app_role := private.require_role(array['butter_officer']::public.app_role[]);
  v_existing uuid := private.existing_event(p ->> 'idempotency_key');
  v_centre public.locations;
  v_group public.processing_groups;
  v_at timestamptz := (p ->> 'occurred_at')::timestamptz;
  v_tz text := p ->> 'occurred_tz';
  v_ev uuid;
  v_item jsonb;
  v_lot public.lots;
  v_qty numeric;
begin
  if v_existing is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', v_existing); end if;
  begin
    v_centre := private.location_by_code(p ->> 'centre_code');
    perform private.require_assigned(v_centre.id, 'this butter centre');
    select * into v_group from public.processing_groups where code = p ->> 'group_code' and active;
    if not found or v_group.centre_id <> v_centre.id then raise exception 'That processing group is not registered at %.', v_centre.name; end if;
    perform private.check_time(v_at, v_tz);
    if jsonb_array_length(coalesce(p -> 'items', '[]')) = 0 then raise exception 'Issue at least one ODK lot.'; end if;
    perform private.lock_lots(private.codes(p -> 'items'));
    v_ev := private.begin_event('group_issue', v_at, v_tz, v_centre.id, p ->> 'idempotency_key', p ->> 'notes');
    insert into public.group_issue_events (event_id, group_id) values (v_ev, v_group.id);
    for v_item in select * from jsonb_array_elements(p -> 'items') loop
      v_lot := private.lot_by_code(v_item ->> 'lot_code');
      v_qty := (v_item ->> 'quantity_kg')::numeric;
      if v_lot.product <> 'ODK' then raise exception 'Only dried kernel (ODK) is issued to groups (% is %).', v_lot.code, v_lot.product; end if;
      perform private.consume(v_lot, v_centre.id, 'on_hand', null, v_qty, v_at, v_ev, v_centre.name);
      insert into public.group_issue_items (event_id, lot_id, quantity_kg) values (v_ev, v_lot.id, v_qty);
      insert into public.inventory_ledger (event_id, lot_id, location_id, group_id, bucket, quantity_kg) values (v_ev, v_lot.id, v_centre.id, v_group.id, 'issued', v_qty);
    end loop;
    perform private.audit('event.recorded', 'events', v_ev::text, format('Issued ODK to %s at %s', v_group.name, v_centre.code));
    if coalesce((p ->> 'dry_run')::boolean, false) then raise exception using errcode = 'P0D01', message = 'dry run'; end if;
  exception when sqlstate 'P0D01' then
    return jsonb_build_object('ok', true, 'dry_run', true);
  end;
  return jsonb_build_object('ok', true, 'event_id', v_ev);
end $$;

-- ── transformation (OFN→ODK, ODK→OSB/LPO, refining, filtering) ───────────────
create or replace function public.record_transformation(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_kind public.transform_kind := (p ->> 'kind')::public.transform_kind;
  v_role public.app_role;
  v_existing uuid := private.existing_event(p ->> 'idempotency_key');
  v_loc public.locations;
  v_group public.processing_groups;
  v_at timestamptz := (p ->> 'occurred_at')::timestamptz;
  v_tz text := p ->> 'occurred_tz';
  v_ev uuid;
  v_item jsonb;
  v_lot public.lots;
  v_new uuid;
  v_qty numeric;
  v_in numeric := 0;
  v_out numeric := 0;
  v_in_products public.product_code[];
  v_out_products public.product_code[];
  v_place_kind public.location_kind;
  v_lot_kind public.lot_kind;
  v_band numeric[];
  v_warn text[] := '{}';
begin
  if v_kind = 'sfcl_aggregation' then raise exception 'Use save_sfcl_aggregation for SFCL aggregation.'; end if;
  v_role := private.require_role(case v_kind when 'ofn_to_odk' then array['nut_officer'] when 'odk_to_osb' then array['butter_officer'] else array['supply_chain'] end::public.app_role[]);
  if v_existing is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', v_existing); end if;
  case v_kind
    when 'ofn_to_odk' then v_in_products := '{OFN}'; v_out_products := '{ODK}'; v_place_kind := 'phc'; v_lot_kind := 'kernel_batch'; v_band := '{0.28,0.40}';
    when 'odk_to_osb' then v_in_products := '{ODK}'; v_out_products := '{OSB}'; v_place_kind := 'butter_centre'; v_lot_kind := 'lpo'; v_band := '{0.30,0.48}';
    when 'refining' then v_in_products := '{OSB}'; v_out_products := '{ORSB}'; v_place_kind := 'refiner'; v_lot_kind := 'refined'; v_band := '{0.85,1.0}';
    else v_in_products := '{OSB,ORSB}'; v_out_products := '{OFSB,OFSB-FFL}'; v_place_kind := 'filterer'; v_lot_kind := 'filtered'; v_band := '{0.90,1.0}';
  end case;
  begin
    v_loc := private.location_by_code(p ->> 'location_code');
    if v_loc.kind <> v_place_kind then raise exception 'This transformation must be recorded at a % location, not %.', v_place_kind, v_loc.name; end if;
    perform private.require_assigned(v_loc.id, v_loc.name);
    perform private.check_time(v_at, v_tz);
    if v_kind = 'odk_to_osb' then
      select * into v_group from public.processing_groups where code = p ->> 'group_code' and active;
      if not found or v_group.centre_id <> v_loc.id then raise exception 'Butter processing needs a group registered at %.', v_loc.name; end if;
    end if;
    if jsonb_array_length(coalesce(p -> 'inputs', '[]')) = 0 then raise exception 'A transformation needs at least one Input row.'; end if;
    if jsonb_array_length(coalesce(p -> 'outputs', '[]')) = 0 then raise exception 'A transformation needs at least one Output row (the batch ID supplied by the officer).'; end if;

    perform private.lock_lots(private.codes(p -> 'inputs'));
    v_ev := private.begin_event('transformation', v_at, v_tz, v_loc.id, p ->> 'idempotency_key', p ->> 'notes');
    insert into public.transformation_events (event_id, kind, group_id) values (v_ev, v_kind, v_group.id);
    for v_item in select * from jsonb_array_elements(p -> 'inputs') loop
      v_lot := private.lot_by_code(v_item ->> 'lot_code');
      v_qty := (v_item ->> 'quantity_kg')::numeric;
      if not (v_lot.product = any (v_in_products)) then raise exception 'Inputs must be % (% is %).', v_in_products, v_lot.code, v_lot.product; end if;
      if v_kind = 'odk_to_osb' then
        perform private.consume(v_lot, v_loc.id, 'issued', v_group.id, v_qty, v_at, v_ev, v_group.name || ' (issued kernel)');
      else
        perform private.consume(v_lot, v_loc.id, 'on_hand', null, v_qty, v_at, v_ev, v_loc.name);
      end if;
      insert into public.transformation_inputs (event_id, lot_id, quantity_kg) values (v_ev, v_lot.id, v_qty);
      v_in := v_in + v_qty;
    end loop;
    for v_item in select * from jsonb_array_elements(p -> 'outputs') loop
      v_qty := (v_item ->> 'quantity_kg')::numeric;
      if coalesce(trim(v_item ->> 'lot_code'), '') = '' then raise exception 'Every Output row needs the batch ID supplied by the officer.'; end if;
      if v_qty is null or v_qty <= 0 then raise exception 'Output quantity must be positive.'; end if;
      if not ((v_item ->> 'product')::public.product_code = any (v_out_products)) then raise exception 'Outputs must be %.', v_out_products; end if;
      if exists (select 1 from public.lots where code = v_item ->> 'lot_code') then raise exception 'Output ID % already exists. Output batch IDs must be new.', v_item ->> 'lot_code'; end if;
      insert into public.lots (code, product, lot_kind, created_by_event, created_at_location, created_at)
      values (v_item ->> 'lot_code', (v_item ->> 'product')::public.product_code, v_lot_kind, v_ev, v_loc.id, v_at) returning id into v_new;
      insert into public.transformation_outputs (event_id, lot_id, quantity_kg) values (v_ev, v_new, v_qty);
      insert into public.inventory_ledger (event_id, lot_id, location_id, bucket, quantity_kg) values (v_ev, v_new, v_loc.id, 'on_hand', v_qty);
      v_out := v_out + v_qty;
    end loop;
    if v_out / v_in < v_band[1] or v_out / v_in > v_band[2] then
      v_warn := v_warn || format('Yield %s%% is outside the proposed %s–%s%% band.', round(v_out / v_in * 100, 1), v_band[1] * 100, v_band[2] * 100);
    end if;
    perform private.audit('event.recorded', 'events', v_ev::text, format('%s at %s: %s kg in → %s kg out', v_kind, v_loc.code, v_in, v_out));
    if coalesce((p ->> 'dry_run')::boolean, false) then raise exception using errcode = 'P0D01', message = 'dry run'; end if;
  exception when sqlstate 'P0D01' then
    return jsonb_build_object('ok', true, 'dry_run', true, 'warnings', to_jsonb(v_warn));
  end;
  return jsonb_build_object('ok', true, 'event_id', v_ev, 'warnings', to_jsonb(v_warn));
end $$;

-- ── SFCL aggregation: LPO Input rows → one SFCL Output row (a Transform) ─────
-- 3,000 kg per LPO is a review norm (warning), not a cap. Hard rules: no draw beyond
-- the LPO's available balance; never above 21,000 kg; finalize only at exactly 21,000 kg.
create or replace function public.save_sfcl_aggregation(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.app_role := private.require_role(array['butter_officer']::public.app_role[]);
  v_existing uuid := private.existing_event(p ->> 'idempotency_key');
  v_wh public.locations;
  v_code text := trim(p ->> 'sfcl_code');
  v_final boolean := coalesce((p ->> 'finalize')::boolean, false);
  v_at timestamptz := (p ->> 'occurred_at')::timestamptz;
  v_tz text := p ->> 'occurred_tz';
  v_sfcl public.lots;
  v_ev uuid;
  v_total numeric := 0;
  v_old_total numeric := 0;
  v_item jsonb;
  v_lot public.lots;
  v_qty numeric;
  r record;
  v_warn text[] := '{}';
  v_before jsonb;
begin
  if v_existing is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', v_existing); end if;
  begin
    v_wh := private.location_by_code(p ->> 'warehouse_code');
    if v_wh.kind <> 'warehouse' then raise exception 'SFCL aggregation happens at the warehouse.'; end if;
    perform private.require_assigned(v_wh.id, 'this warehouse');
    perform private.check_time(v_at, v_tz);
    if coalesce(v_code, '') = '' then raise exception 'SFCL number is required (assigned at the warehouse).'; end if;
    select coalesce(sum((x ->> 'quantity_kg')::numeric), 0) into v_total from jsonb_array_elements(coalesce(p -> 'draws', '[]')) x;
    if v_total <= 0 then raise exception 'Add at least one LPO draw.'; end if;
    if v_total > 21000 then raise exception '% would total % kg, over the 21,000 kg limit.', v_code, v_total; end if;
    if v_final and v_total <> 21000 then raise exception '% can only be finalized at exactly 21,000 kg (currently % kg).', v_code, v_total; end if;

    perform private.lock_lots(private.codes(p -> 'draws') || v_code);
    select * into v_sfcl from public.lots where code = v_code;
    if found then
      if v_sfcl.lot_kind <> 'sfcl' then raise exception 'ID % already exists and is not an SFCL.', v_code; end if;
      if v_sfcl.sfcl_stage = 'finalized' then raise exception '% is already finalized.', v_code; end if;
      v_ev := v_sfcl.created_by_event;
      if v_at < (select occurred_at from public.events where id = v_ev) then raise exception 'An update cannot be dated before the aggregation started.'; end if;
      select to_jsonb(e) into v_before from public.events e where e.id = v_ev;
      -- reverse previous draws with compensating ledger rows (the ledger is never edited)
      for r in select ti.lot_id, ti.quantity_kg from public.transformation_inputs ti where ti.event_id = v_ev loop
        insert into public.inventory_ledger (event_id, lot_id, location_id, bucket, quantity_kg) values (v_ev, r.lot_id, v_wh.id, 'on_hand', r.quantity_kg);
        v_old_total := v_old_total + r.quantity_kg;
      end loop;
      insert into public.inventory_ledger (event_id, lot_id, location_id, bucket, quantity_kg) values (v_ev, v_sfcl.id, v_wh.id, 'on_hand', -v_old_total);
      delete from public.transformation_inputs where event_id = v_ev; -- draft rows only
      update public.events set occurred_at = v_at, occurred_tz = v_tz, version = version + 1, status = (case when v_final then 'committed' else 'draft' end)::public.event_status where id = v_ev;
      update public.lots set sfcl_stage = case when v_final then 'finalized' else 'in_progress' end where id = v_sfcl.id;
      update public.transformation_outputs set quantity_kg = v_total where event_id = v_ev;
    else
      v_ev := private.begin_event('transformation', v_at, v_tz, v_wh.id, p ->> 'idempotency_key', p ->> 'notes', case when v_final then 'committed' else 'draft' end::public.event_status);
      insert into public.transformation_events (event_id, kind) values (v_ev, 'sfcl_aggregation');
      insert into public.lots (code, product, lot_kind, created_by_event, created_at_location, created_at, sfcl_stage)
      values (v_code, 'OSB', 'sfcl', v_ev, v_wh.id, v_at, case when v_final then 'finalized' else 'in_progress' end) returning * into v_sfcl;
      insert into public.transformation_outputs (event_id, lot_id, quantity_kg) values (v_ev, v_sfcl.id, v_total);
    end if;

    for v_item in select * from jsonb_array_elements(p -> 'draws') loop
      v_lot := private.lot_by_code(v_item ->> 'lot_code');
      v_qty := (v_item ->> 'quantity_kg')::numeric;
      if v_lot.lot_kind <> 'lpo' then raise exception '% is not an LPO crude-butter batch.', v_lot.code; end if;
      perform private.consume(v_lot, v_wh.id, 'on_hand', null, v_qty, v_at + interval '1 microsecond', v_ev, v_wh.name);
      insert into public.transformation_inputs (event_id, lot_id, quantity_kg) values (v_ev, v_lot.id, v_qty);
      if v_qty > 3000 then
        v_warn := v_warn || format('%s contributes %s kg, above the usual 3,000 kg draw — allowed to close a shortfall; flagged for review.', v_lot.code, v_qty);
      end if;
    end loop;
    insert into public.inventory_ledger (event_id, lot_id, location_id, bucket, quantity_kg) values (v_ev, v_sfcl.id, v_wh.id, 'on_hand', v_total);
    perform private.audit(case when v_final then 'sfcl.finalized' else 'sfcl.saved' end, 'events', v_ev::text,
      format('%s %s at %s kg', v_code, case when v_final then 'finalized' else 'saved in progress' end, v_total),
      case when v_before is null then null else jsonb_build_object('before', v_before) end);
    if coalesce((p ->> 'dry_run')::boolean, false) then raise exception using errcode = 'P0D01', message = 'dry run'; end if;
  exception when sqlstate 'P0D01' then
    return jsonb_build_object('ok', true, 'dry_run', true, 'warnings', to_jsonb(v_warn), 'total_kg', v_total);
  end;
  return jsonb_build_object('ok', true, 'event_id', v_ev, 'warnings', to_jsonb(v_warn), 'total_kg', v_total, 'stage', case when v_final then 'finalized' else 'in_progress' end);
end $$;

-- ── arrived & ready for pickup → Commercial handoff + customer trace grant ───
create or replace function public.mark_ready_for_pickup(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.app_role := private.require_role(array['supply_chain']::public.app_role[]);
  v_existing uuid := private.existing_event(p ->> 'idempotency_key');
  v_loc public.locations;
  v_lot public.lots;
  v_client uuid;
  v_at timestamptz := (p ->> 'occurred_at')::timestamptz;
  v_tz text := p ->> 'occurred_tz';
  v_qty numeric := (p ->> 'quantity_kg')::numeric;
  v_ev uuid;
  v_h uuid;
  v_held numeric;
begin
  if v_existing is not null then
    select id into v_h from public.commercial_handoffs where ready_event_id = v_existing;
    return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', v_existing, 'handoff_id', v_h);
  end if;
  v_loc := private.location_by_code(p ->> 'location_code');
  v_lot := private.lot_by_code(p ->> 'lot_code');
  perform private.require_assigned(v_loc.id, v_loc.name);
  select id into v_h from public.commercial_handoffs where lot_id = v_lot.id and location_id = v_loc.id;
  if v_h is not null then
    return jsonb_build_object('ok', true, 'existing', true, 'handoff_id', v_h); -- one handoff per lot+place, even on retry
  end if;
  -- In Amsterdam a shipment is refined or filtered (Supply Chain); it is ready for pickup there.
  if v_loc.kind not in ('refiner', 'filterer', 'destination_warehouse') then
    raise exception 'Ready for pickup is recorded at the refiner or filterer.';
  end if;
  perform private.check_time(v_at, v_tz);
  select id into v_client from public.clients where name = p ->> 'client_name';
  if v_client is null then raise exception 'Unknown client "%".', p ->> 'client_name'; end if;
  if coalesce(trim(p ->> 'order_ref'), '') = '' then raise exception 'Client order reference is required.'; end if;
  v_held := private.stock(v_lot.id, v_loc.id, 'on_hand', null, v_at);
  if v_held <= 0 then raise exception '% has not been received at % by that time.', v_lot.code, v_loc.name; end if;
  if v_qty is null or v_qty <= 0 or v_qty > v_held then raise exception 'Ready quantity must be positive and at most the % kg held here.', v_held; end if;
  v_ev := private.begin_event('ready_for_pickup', v_at, v_tz, v_loc.id, p ->> 'idempotency_key', p ->> 'notes');
  insert into public.commercial_handoffs (lot_id, ready_event_id, location_id, client_id, order_ref, quantity_kg)
  values (v_lot.id, v_ev, v_loc.id, v_client, trim(p ->> 'order_ref'), v_qty) returning id into v_h;
  insert into public.customer_trace_grants (handoff_id, created_by) values (v_h, (select auth.uid()));
  perform private.audit('handoff.created', 'commercial_handoffs', v_h::text, format('%s (%s kg) ready for pickup at %s', v_lot.code, v_qty, v_loc.code));
  return jsonb_build_object('ok', true, 'event_id', v_ev, 'handoff_id', v_h);
end $$;

-- ── direct delivery to a client ──────────────────────────────────────────────
create or replace function public.record_delivery(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role public.app_role := private.require_role(array['supply_chain']::public.app_role[]);
  v_existing uuid := private.existing_event(p ->> 'idempotency_key');
  v_from public.locations;
  v_to public.locations;
  v_at timestamptz := (p ->> 'occurred_at')::timestamptz;
  v_tz text := p ->> 'occurred_tz';
  v_ev uuid;
  v_item jsonb;
  v_lot public.lots;
begin
  if v_existing is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', v_existing); end if;
  v_from := private.location_by_code(p ->> 'origin_code');
  v_to := private.location_by_code(p ->> 'client_location_code');
  perform private.require_assigned(v_from.id, v_from.name);
  if v_to.kind <> 'client' then raise exception 'Delivery destination must be a client location.'; end if;
  perform private.check_time(v_at, v_tz);
  perform private.lock_lots(private.codes(p -> 'items'));
  v_ev := private.begin_event('delivery', v_at, v_tz, v_from.id, p ->> 'idempotency_key', p ->> 'notes');
  insert into public.shipment_events (event_id, origin_id, destination_id, state) values (v_ev, v_from.id, v_to.id, 'received');
  for v_item in select * from jsonb_array_elements(p -> 'items') loop
    v_lot := private.lot_by_code(v_item ->> 'lot_code');
    perform private.consume(v_lot, v_from.id, 'on_hand', null, (v_item ->> 'quantity_kg')::numeric, v_at, v_ev, v_from.name);
    insert into public.shipment_items (shipment_event_id, lot_id, quantity_kg) values (v_ev, v_lot.id, (v_item ->> 'quantity_kg')::numeric);
    insert into public.inventory_ledger (event_id, lot_id, location_id, bucket, quantity_kg) values (v_ev, v_lot.id, v_to.id, 'on_hand', (v_item ->> 'quantity_kg')::numeric);
  end loop;
  perform private.audit('event.recorded', 'events', v_ev::text, format('Delivery %s → %s', v_from.code, v_to.code));
  return jsonb_build_object('ok', true, 'event_id', v_ev);
end $$;

-- ── discrepancy resolution, corrections, handoff updates ─────────────────────
create or replace function public.resolve_discrepancy(p_receipt_event_id uuid, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_loc uuid;
begin
  perform private.require_role(array['nut_officer', 'butter_officer', 'supply_chain', 'it_admin']::public.app_role[]);
  select e.location_id into v_loc from public.receipt_events r join public.events e on e.id = r.event_id
  where r.event_id = p_receipt_event_id and r.outcome = 'discrepancy' and r.resolved_at is null;
  if v_loc is null then raise exception 'No open discrepancy for that receipt.'; end if;
  if not (private.is_admin() or private.is_assigned(v_loc)) then raise exception 'You are not assigned to that location.' using errcode = '42501'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Describe how the discrepancy was resolved.'; end if;
  update public.receipt_events set resolved_at = now(), resolution_note = trim(p_note), resolved_by = (select auth.uid()) where event_id = p_receipt_event_id;
  perform private.audit('discrepancy.resolved', 'receipt_events', p_receipt_event_id::text, 'Receipt discrepancy resolved', jsonb_build_object('note', p_note));
  return jsonb_build_object('ok', true);
end $$;

-- Corrections append history (reason + before/after) and bump the version.
-- This version corrects event time and notes; quantity/identifier changes are
-- handled as superseding entries (not implemented in the prototype).
create or replace function public.record_correction(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.events;
  v_after public.events;
  v_at timestamptz := coalesce((p ->> 'occurred_at')::timestamptz, null);
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  if coalesce(trim(p ->> 'reason'), '') = '' then raise exception 'A reason is required for every correction.'; end if;
  select * into v_before from public.events where id = (p ->> 'event_id')::uuid for update;
  if not found then raise exception 'Unknown event.'; end if;
  if v_at is not null then perform private.check_time(v_at, coalesce(p ->> 'occurred_tz', v_before.occurred_tz)); end if;
  update public.events
     set occurred_at = coalesce(v_at, occurred_at),
         occurred_tz = coalesce(p ->> 'occurred_tz', occurred_tz),
         notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end,
         version = version + 1
   where id = v_before.id
  returning * into v_after;
  insert into public.event_corrections (original_event_id, reason, requested_by, approved_by, approved_at, before, after)
  values (v_before.id, trim(p ->> 'reason'), (select auth.uid()), (select auth.uid()), now(), to_jsonb(v_before), to_jsonb(v_after));
  perform private.audit('event.corrected', 'events', v_before.id::text, format('Event corrected (version %s → %s)', v_before.version, v_after.version), jsonb_build_object('reason', p ->> 'reason'));
  return jsonb_build_object('ok', true, 'version', v_after.version);
end $$;

create or replace function public.update_handoff(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_h public.commercial_handoffs;
begin
  perform private.require_role(array['commercial']::public.app_role[]);
  select * into v_h from public.commercial_handoffs where id = (p ->> 'handoff_id')::uuid for update;
  if not found or not private.handoff_visible(v_h.id) then raise exception 'Handoff not found for your assigned clients.' using errcode = '42501'; end if;
  update public.commercial_handoffs set
    status = case when coalesce((p ->> 'acknowledge')::boolean, false) then 'acknowledged' else status end,
    acknowledged_by = case when coalesce((p ->> 'acknowledge')::boolean, false) and acknowledged_by is null then (select auth.uid()) else acknowledged_by end,
    acknowledged_at = case when coalesce((p ->> 'acknowledge')::boolean, false) and acknowledged_at is null then now() else acknowledged_at end,
    invoice_ref = case when p ? 'invoice_ref' then nullif(trim(p ->> 'invoice_ref'), '') else invoice_ref end,
    invoice_status = coalesce((p ->> 'invoice_status')::public.invoice_status, invoice_status),
    disclosure = coalesce((p ->> 'disclosure')::public.disclosure_mode, disclosure)
  where id = v_h.id;
  perform private.audit('handoff.updated', 'commercial_handoffs', v_h.id::text, 'Handoff updated by Commercial (illustrative invoice reference only; nothing is issued)', p - 'handoff_id');
  return jsonb_build_object('ok', true);
end $$;

-- ── grants: workflow RPCs for signed-in users only ───────────────────────────
revoke all on function
  public.record_purchase(jsonb), public.record_shipment(jsonb), public.receive_shipment(jsonb), public.issue_to_group(jsonb),
  public.record_transformation(jsonb), public.save_sfcl_aggregation(jsonb), public.mark_ready_for_pickup(jsonb), public.record_delivery(jsonb),
  public.resolve_discrepancy(uuid, text), public.record_correction(jsonb), public.update_handoff(jsonb)
from public, anon;
grant execute on function
  public.record_purchase(jsonb), public.record_shipment(jsonb), public.receive_shipment(jsonb), public.issue_to_group(jsonb),
  public.record_transformation(jsonb), public.save_sfcl_aggregation(jsonb), public.mark_ready_for_pickup(jsonb), public.record_delivery(jsonb),
  public.resolve_discrepancy(uuid, text), public.record_correction(jsonb), public.update_handoff(jsonb)
to authenticated;
-- internal helpers are callable only from the SECURITY DEFINER functions above
revoke all on function
  private.require_role(public.app_role[]), private.require_assigned(uuid, text), private.location_by_code(text), private.lot_by_code(text),
  private.check_time(timestamptz, text), private.existing_event(text), private.begin_event(public.event_type, timestamptz, text, uuid, text, text, public.event_status),
  private.audit(text, text, text, text, jsonb), private.stock(uuid, uuid, public.stock_bucket, uuid, timestamptz), private.lock_lots(text[]),
  private.consume(public.lots, uuid, public.stock_bucket, uuid, numeric, timestamptz, uuid, text), private.codes(jsonb, text)
from public, anon, authenticated;
