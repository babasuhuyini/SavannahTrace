-- ════════════════════════════════════════════════════════════════════════════
-- Authorization helpers (private schema, not exposed through the Data API) and
-- Row Level Security for every public table.
--
-- Model
--  • Identity: auth.uid(). Authorization: profiles.status + app_user_roles +
--    user_location_assignments (+ user_client_assignments for Commercial).
--    Nothing is read from user-editable auth user_metadata.
--  • Suspension is checked inside every helper, so it takes effect on the very
--    next query — not only when the UI refreshes.
--  • Reads: RLS policies below. Writes: NO table write grants for clients at all;
--    every write goes through a SECURITY DEFINER workflow function that checks
--    role, location, stock, chronology and idempotency atomically.
-- ════════════════════════════════════════════════════════════════════════════

grant usage on schema private to authenticated;

-- SECURITY DEFINER helpers: fixed empty search_path, fully-qualified names, and they
-- only ever answer questions about the *calling* user.

create or replace function private.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.status = 'active');
$$;

create or replace function private.my_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select ur.role
  from public.app_user_roles ur
  join public.profiles p on p.user_id = ur.user_id and p.status = 'active'
  where ur.user_id = (select auth.uid()) and ur.active
  limit 1;
$$;

create or replace function private.has_role(r public.app_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() = r, false);
$$;

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role('it_admin');
$$;

create or replace function private.my_location_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select ula.location_id
  from public.user_location_assignments ula
  join public.profiles p on p.user_id = ula.user_id and p.status = 'active'
  where ula.user_id = (select auth.uid())
    and ula.active
    and ula.starts_on <= current_date
    and (ula.ends_on is null or ula.ends_on >= current_date);
$$;

create or replace function private.is_assigned(loc uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.my_location_ids() l where l = loc);
$$;

-- Central event visibility rule (mirrors src/domain/access.ts eventVisible):
--  admin → all · commercial → none (handoffs only) · auditor → assigned audit scope
--  officers → own entries, activity at assigned locations, and the shipment
--  hand-off exception: a shipment addressed to an assigned location.
create or replace function private.event_visible(e_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.app_role := private.my_role();
begin
  if r is null then
    return false; -- no active profile/role (uninvited, suspended, removed)
  elsif r = 'it_admin' then
    return true;
  elsif r = 'commercial' then
    return false;
  end if;
  return exists (
    select 1 from public.events e
    where e.id = e_id
      and (
        (r <> 'auditor' and e.actor_id = (select auth.uid()))
        or private.is_assigned(e.location_id)
        or exists (select 1 from public.shipment_events s where s.event_id = e.id and private.is_assigned(s.destination_id))
      )
  );
end;
$$;

create or replace function private.handoff_visible(h_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.app_role := private.my_role();
begin
  if r is null then return false; end if;
  if r = 'it_admin' then return true; end if;
  if r = 'commercial' then
    return exists (
      select 1 from public.commercial_handoffs h
      join public.user_client_assignments uca on uca.client_id = h.client_id and uca.active
      where h.id = h_id and uca.user_id = (select auth.uid())
    );
  end if;
  if r in ('supply_chain', 'auditor') then
    return exists (select 1 from public.commercial_handoffs h where h.id = h_id and private.is_assigned(h.location_id));
  end if;
  return false;
end;
$$;

create or replace function private.lot_visible(l_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.app_role := private.my_role();
begin
  if r is null then return false; end if;
  if r = 'it_admin' then return true; end if;
  if r = 'commercial' then
    return exists (select 1 from public.commercial_handoffs h where h.lot_id = l_id and private.handoff_visible(h.id));
  end if;
  return exists (select 1 from public.inventory_ledger il where il.lot_id = l_id and private.is_assigned(il.location_id))
      or exists (select 1 from public.shipment_items si where si.lot_id = l_id and private.event_visible(si.shipment_event_id))
      or exists (select 1 from public.lots x where x.id = l_id and private.event_visible(x.created_by_event))
      or exists (select 1 from public.transformation_inputs ti where ti.lot_id = l_id and private.event_visible(ti.event_id));
end;
$$;

-- Collector personal data: nut officers for their assigned areas, auditors in scope, admins.
create or replace function private.collector_pii_visible(c_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin()
      or exists (
        select 1 from public.collectors c
        where c.id = c_id
          and private.is_assigned(c.collection_area_id)
          and (private.has_role('nut_officer') or private.has_role('auditor'))
      );
$$;

revoke all on all functions in schema private from public, anon;
grant execute on function
  private.is_active(), private.my_role(), private.has_role(public.app_role), private.is_admin(),
  private.my_location_ids(), private.is_assigned(uuid), private.event_visible(uuid),
  private.handoff_visible(uuid), private.lot_visible(uuid), private.collector_pii_visible(uuid)
to authenticated;

-- ── grants: default deny ─────────────────────────────────────────────────────
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- Signed-in users may SELECT (rows filtered by the policies below). No INSERT,
-- UPDATE or DELETE is granted on any table: writes go through workflow functions.
grant select on
  public.locations, public.collection_areas, public.collection_area_geometry, public.collectors,
  public.collector_personal, public.processing_groups, public.clients, public.profiles,
  public.app_user_roles, public.user_location_assignments, public.user_client_assignments,
  public.user_invitations, public.invitation_locations, public.invitation_clients,
  public.events, public.lots, public.purchase_events, public.purchase_prices,
  public.shipment_events, public.shipment_items, public.receipt_events, public.receipt_items,
  public.group_issue_events, public.group_issue_items, public.transformation_events,
  public.transformation_inputs, public.transformation_outputs, public.inventory_ledger,
  public.event_corrections, public.commercial_handoffs, public.customer_trace_grants,
  public.documents, public.audit_log, public.access_log
to authenticated;

-- ── enable RLS on every table ────────────────────────────────────────────────
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ── SELECT policies (per table) ──────────────────────────────────────────────
create policy locations_read on public.locations for select to authenticated using (private.is_active());
create policy collection_areas_read on public.collection_areas for select to authenticated using (private.is_active());
create policy area_geometry_read on public.collection_area_geometry for select to authenticated
  using (private.is_admin() or private.is_assigned(location_id));
create policy collectors_read on public.collectors for select to authenticated
  using (private.is_admin() or private.is_assigned(collection_area_id));
create policy collector_personal_read on public.collector_personal for select to authenticated
  using (private.collector_pii_visible(collector_id));
create policy groups_read on public.processing_groups for select to authenticated
  using (private.is_admin() or private.is_assigned(centre_id));
create policy clients_read on public.clients for select to authenticated
  using (
    private.is_admin()
    or private.has_role('supply_chain')
    or exists (select 1 from public.user_client_assignments u where u.client_id = id and u.user_id = (select auth.uid()) and u.active and private.is_active())
  );

create policy profiles_read on public.profiles for select to authenticated using (user_id = (select auth.uid()) or private.is_admin());
create policy roles_read on public.app_user_roles for select to authenticated using (user_id = (select auth.uid()) or private.is_admin());
create policy locations_assign_read on public.user_location_assignments for select to authenticated using (user_id = (select auth.uid()) or private.is_admin());
create policy clients_assign_read on public.user_client_assignments for select to authenticated using (user_id = (select auth.uid()) or private.is_admin());
create policy invitations_read on public.user_invitations for select to authenticated using (private.is_admin());
create policy invitation_locations_read on public.invitation_locations for select to authenticated using (private.is_admin());
create policy invitation_clients_read on public.invitation_clients for select to authenticated using (private.is_admin());

create policy events_read on public.events for select to authenticated using (private.event_visible(id));
create policy lots_read on public.lots for select to authenticated using (private.lot_visible(id));
create policy purchases_read on public.purchase_events for select to authenticated using (private.event_visible(event_id));
create policy prices_read on public.purchase_prices for select to authenticated
  using (
    private.is_admin()
    or (private.has_role('auditor') and private.event_visible(event_id))
    or exists (select 1 from public.events e where e.id = event_id and e.actor_id = (select auth.uid()) and private.is_active())
  );
create policy shipments_read on public.shipment_events for select to authenticated using (private.event_visible(event_id));
create policy shipment_items_read on public.shipment_items for select to authenticated using (private.event_visible(shipment_event_id));
create policy receipts_read on public.receipt_events for select to authenticated using (private.event_visible(event_id));
create policy receipt_items_read on public.receipt_items for select to authenticated using (private.event_visible(receipt_event_id));
create policy issues_read on public.group_issue_events for select to authenticated using (private.event_visible(event_id));
create policy issue_items_read on public.group_issue_items for select to authenticated using (private.event_visible(event_id));
create policy transforms_read on public.transformation_events for select to authenticated using (private.event_visible(event_id));
create policy transform_inputs_read on public.transformation_inputs for select to authenticated using (private.event_visible(event_id));
create policy transform_outputs_read on public.transformation_outputs for select to authenticated using (private.event_visible(event_id));
create policy ledger_read on public.inventory_ledger for select to authenticated using (private.is_admin() or private.is_assigned(location_id));
create policy corrections_read on public.event_corrections for select to authenticated
  using (private.is_admin() or (private.has_role('auditor') and private.event_visible(original_event_id)));
create policy handoffs_read on public.commercial_handoffs for select to authenticated using (private.handoff_visible(id));
create policy grants_read on public.customer_trace_grants for select to authenticated using (private.is_admin());
create policy documents_read on public.documents for select to authenticated
  using (
    private.is_admin()
    or (lot_id is not null and private.lot_visible(lot_id) and (customer_visible or not private.has_role('supply_chain')))
  );
create policy audit_read on public.audit_log for select to authenticated using (private.is_admin() or private.has_role('auditor'));
create policy access_log_read on public.access_log for select to authenticated using (private.is_admin());

-- INSERT / UPDATE / DELETE: intentionally no grants and no permissive policies.
-- With RLS enabled and no permissive policy, any direct write is refused even if a
-- grant were added by mistake later. Corrections append history via
-- public.record_correction(); committed events are never deleted.

-- Stock view respects the caller's RLS on the ledger and lots.
create view public.v_stock with (security_invoker = true) as
select l.code as lot_code, l.product, l.lot_kind, loc.code as location_code, g.code as group_code, il.bucket,
       sum(il.quantity_kg) as quantity_kg
from public.inventory_ledger il
join public.lots l on l.id = il.lot_id
join public.locations loc on loc.id = il.location_id
left join public.processing_groups g on g.id = il.group_id
group by l.code, l.product, l.lot_kind, loc.code, g.code, il.bucket
having sum(il.quantity_kg) <> 0;
grant select on public.v_stock to authenticated;
