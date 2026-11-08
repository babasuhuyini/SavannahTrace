-- ════════════════════════════════════════════════════════════════════════════
-- Identity lifecycle, IT administration, workspace snapshot and public trace.
-- ════════════════════════════════════════════════════════════════════════════

-- ── front-end mapping helpers (pure) ─────────────────────────────────────────
create or replace function private.fe_role(r public.app_role) returns text
language sql immutable set search_path = '' as $$
  select case r when 'nut_officer' then 'nut-fo' when 'butter_officer' then 'butter-fo' when 'supply_chain' then 'supply-chain'
                when 'commercial' then 'commercial' when 'it_admin' then 'it-admin' else 'auditor' end;
$$;
create or replace function private.be_role(r text) returns public.app_role
language sql immutable set search_path = '' as $$
  select (case r when 'nut-fo' then 'nut_officer' when 'butter-fo' then 'butter_officer' when 'supply-chain' then 'supply_chain'
                 when 'it-admin' then 'it_admin' else r end)::public.app_role;
$$;
create or replace function private.fe_time(at timestamptz, tz text) returns text
language sql immutable set search_path = '' as $$
  select to_char(at at time zone tz::interval, 'YYYY-MM-DD"T"HH24:MI:SS') || tz;
$$;
create or replace function private.fe_kind(k public.location_kind) returns text
language sql immutable set search_path = '' as $$ select replace(k::text, '_', '-'); $$;
create or replace function private.fe_transform(k public.transform_kind) returns text
language sql immutable set search_path = '' as $$
  select case k when 'ofn_to_odk' then 'kernel' when 'odk_to_osb' then 'butter' when 'sfcl_aggregation' then 'aggregation' when 'refining' then 'refine' else 'filter' end;
$$;
grant execute on function private.fe_role(public.app_role), private.fe_time(timestamptz, text), private.fe_kind(public.location_kind), private.fe_transform(public.transform_kind) to authenticated;

-- ── invitations & the signed-in user's context ───────────────────────────────
-- Called after sign-in (email code, magic link or Google). Activates the pending
-- invitation that matches the caller's VERIFIED email. With p_display_name null it
-- only previews the invitation so the UI can show "Activate your account".
create or replace function public.accept_invitation(p_display_name text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_confirmed timestamptz;
  v_inv public.user_invitations;
begin
  if v_uid is null then raise exception 'Not signed in.' using errcode = '42501'; end if;
  if exists (select 1 from public.profiles where user_id = v_uid) then return jsonb_build_object('status', 'already_active'); end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
  if v_confirmed is null then return jsonb_build_object('status', 'unverified'); end if;
  select * into v_inv from public.user_invitations where email = v_email and status = 'pending' order by created_at desc limit 1 for update;
  if not found then
    if exists (select 1 from public.user_invitations where email = v_email and status in ('expired', 'revoked')) then
      return jsonb_build_object('status', 'expired');
    end if;
    return jsonb_build_object('status', 'no_invitation'); -- uninvited Google/OTP identity: no profile, no role, no data
  end if;
  if v_inv.expires_at < now() then
    update public.user_invitations set status = 'expired' where id = v_inv.id;
    return jsonb_build_object('status', 'expired');
  end if;
  if p_display_name is null then
    return jsonb_build_object('status', 'pending', 'invitation', jsonb_build_object(
      'id', v_inv.id, 'email', v_inv.email, 'display_name', v_inv.display_name, 'role', private.fe_role(v_inv.role),
      'location_names', coalesce((select jsonb_agg(l.name order by l.name) from public.invitation_locations il join public.locations l on l.id = il.location_id where il.invitation_id = v_inv.id), '[]')));
  end if;
  insert into public.profiles (user_id, display_name) values (v_uid, coalesce(nullif(trim(p_display_name), ''), v_inv.display_name));
  insert into public.app_user_roles (user_id, role, granted_by) values (v_uid, v_inv.role, v_inv.invited_by);
  insert into public.user_location_assignments (user_id, location_id, assigned_by)
    select v_uid, location_id, v_inv.invited_by from public.invitation_locations where invitation_id = v_inv.id;
  insert into public.user_client_assignments (user_id, client_id)
    select v_uid, client_id from public.invitation_clients where invitation_id = v_inv.id;
  update public.user_invitations set status = 'accepted', accepted_by = v_uid, accepted_at = now() where id = v_inv.id;
  insert into public.audit_log (actor_id, action, target_table, target_id, summary)
  values (v_uid, 'user.activated', 'profiles', v_uid::text, format('%s verified their email and accepted the invitation (%s)', v_email, v_inv.role));
  return jsonb_build_object('status', 'activated');
end $$;

create or replace function public.get_my_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_p public.profiles;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;
  select lower(email) into v_email from auth.users where id = v_uid;
  select * into v_p from public.profiles where user_id = v_uid;
  if not found then return jsonb_build_object('signed_in', true, 'email', v_email, 'profile', null); end if;
  return jsonb_build_object(
    'signed_in', true,
    'email', v_email,
    'user_id', v_uid,
    'display_name', v_p.display_name,
    'status', v_p.status,
    'role', (select private.fe_role(role) from public.app_user_roles where user_id = v_uid and active limit 1),
    'locations', coalesce((select jsonb_agg(l.code order by l.code) from public.user_location_assignments a join public.locations l on l.id = a.location_id
                           where a.user_id = v_uid and a.active and (a.ends_on is null or a.ends_on >= current_date)), '[]'),
    'clients', coalesce((select jsonb_agg(c.name order by c.name) from public.user_client_assignments a join public.clients c on c.id = a.client_id
                         where a.user_id = v_uid and a.active), '[]'));
end $$;

-- ── IT administration (authorization checked here; Auth admin calls in Edge Functions) ─
create or replace function public.admin_list_users() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.user_id, 'name', p.display_name, 'email', lower(u.email), 'status', p.status, 'lastSignInAt', u.last_sign_in_at,
      'role', (select private.fe_role(role) from public.app_user_roles where user_id = p.user_id and active limit 1),
      'locationIds', coalesce((select jsonb_agg(l.code) from public.user_location_assignments a join public.locations l on l.id = a.location_id where a.user_id = p.user_id and a.active), '[]'),
      'clientNames', coalesce((select jsonb_agg(c.name) from public.user_client_assignments a join public.clients c on c.id = a.client_id where a.user_id = p.user_id and a.active), '[]'),
      'demo', false) order by p.display_name)
    from public.profiles p join auth.users u on u.id = p.user_id), '[]');
end $$;

create or replace function public.admin_list_invitations() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', i.id, 'email', i.email, 'name', i.display_name, 'role', private.fe_role(i.role),
      'status', case when i.status = 'pending' and i.expires_at < now() then 'expired' else i.status::text end,
      'createdAt', i.created_at, 'expiresAt', i.expires_at, 'invitedBy', i.invited_by, 'acceptedAt', i.accepted_at,
      'locationIds', coalesce((select jsonb_agg(l.code) from public.invitation_locations il join public.locations l on l.id = il.location_id where il.invitation_id = i.id), '[]'),
      'clientNames', coalesce((select jsonb_agg(c.name) from public.invitation_clients ic join public.clients c on c.id = ic.client_id where ic.invitation_id = i.id), '[]'),
      'demo', false) order by i.created_at desc)
    from public.user_invitations i), '[]');
end $$;

-- Creates the protected invitation record. The Edge Function calls this with the
-- caller's own JWT (so this check is authoritative), then sends the Auth invite email.
create or replace function public.admin_prepare_invitation(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p ->> 'email'));
  v_role public.app_role := private.be_role(p ->> 'role');
  v_id uuid;
  v_missing text;
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid work email.'; end if;
  if exists (select 1 from auth.users u join public.profiles pr on pr.user_id = u.id where lower(u.email) = v_email) then
    raise exception 'An account with this email already exists.';
  end if;
  update public.user_invitations set status = 'expired' where email = v_email and status = 'pending' and expires_at < now();
  if exists (select 1 from public.user_invitations where email = v_email and status = 'pending') then raise exception 'There is already a pending invitation for this email.'; end if;
  select string_agg(x, ', ') into v_missing from jsonb_array_elements_text(coalesce(p -> 'location_codes', '[]')) x where not exists (select 1 from public.locations l where l.code = x);
  if v_missing is not null then raise exception 'Unknown location(s): %', v_missing; end if;
  if v_role = 'commercial' and jsonb_array_length(coalesce(p -> 'client_names', '[]')) = 0 then raise exception 'Assign at least one client to a Commercial user.'; end if;
  if v_role not in ('commercial', 'it_admin') and jsonb_array_length(coalesce(p -> 'location_codes', '[]')) = 0 then raise exception 'Assign at least one location.'; end if;
  insert into public.user_invitations (email, display_name, role, expires_at, invited_by)
  values (v_email, coalesce(nullif(trim(p ->> 'name'), ''), v_email), v_role, now() + interval '7 days', (select auth.uid())) returning id into v_id;
  insert into public.invitation_locations (invitation_id, location_id)
    select v_id, l.id from public.locations l where l.code in (select jsonb_array_elements_text(coalesce(p -> 'location_codes', '[]')));
  insert into public.invitation_clients (invitation_id, client_id)
    select v_id, c.id from public.clients c where c.name in (select jsonb_array_elements_text(coalesce(p -> 'client_names', '[]')));
  perform private.audit('user.invited', 'user_invitations', v_id::text, format('Invitation created for %s as %s', v_email, v_role));
  return jsonb_build_object('ok', true, 'invitation_id', v_id, 'email', v_email);
end $$;

create or replace function public.admin_update_invitation(p_id uuid, p_action text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_inv public.user_invitations;
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  select * into v_inv from public.user_invitations where id = p_id for update;
  if not found then raise exception 'Unknown invitation.'; end if;
  if p_action = 'resend' then
    if v_inv.status = 'accepted' then raise exception 'Already accepted.'; end if;
    update public.user_invitations set status = 'pending', expires_at = now() + interval '7 days', revoked_at = null where id = p_id;
    perform private.audit('user.invitation-resent', 'user_invitations', p_id::text, format('Invitation re-issued for %s', v_inv.email));
  elsif p_action = 'revoke' then
    if v_inv.status <> 'pending' then raise exception 'Only pending invitations can be revoked.'; end if;
    update public.user_invitations set status = 'revoked', revoked_at = now() where id = p_id;
    perform private.audit('user.invitation-revoked', 'user_invitations', p_id::text, format('Invitation revoked for %s', v_inv.email));
  else
    raise exception 'Unknown action.';
  end if;
  return jsonb_build_object('ok', true, 'email', v_inv.email);
end $$;

-- Suspension denies database access immediately (every policy checks status).
-- The Edge Function additionally bans the Auth user so refresh tokens stop working.
create or replace function public.admin_set_user_status(p_user uuid, p_status public.account_status) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  if p_user = (select auth.uid()) then raise exception 'You cannot change your own account status.'; end if;
  update public.profiles set status = p_status, updated_at = now() where user_id = p_user;
  if not found then raise exception 'Unknown user.'; end if;
  perform private.audit(case when p_status = 'suspended' then 'user.suspended' else 'user.reactivated' end, 'profiles', p_user::text,
    case when p_status = 'suspended' then 'Access suspended; records kept for audit' else 'Access reactivated' end);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_set_user_access(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user uuid := (p ->> 'user_id')::uuid;
  v_role public.app_role := private.be_role(p ->> 'role');
  v_before jsonb;
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  if not exists (select 1 from public.profiles where user_id = v_user) then raise exception 'Unknown user.'; end if;
  if v_user = (select auth.uid()) and v_role <> 'it_admin' then raise exception 'You cannot remove your own admin role.'; end if;
  v_before := jsonb_build_object(
    'role', (select role from public.app_user_roles where user_id = v_user and active limit 1),
    'locations', (select jsonb_agg(location_id) from public.user_location_assignments where user_id = v_user and active));
  update public.app_user_roles set active = false, revoked_at = now() where user_id = v_user and active and role <> v_role;
  insert into public.app_user_roles (user_id, role, granted_by)
    select v_user, v_role, (select auth.uid()) where not exists (select 1 from public.app_user_roles where user_id = v_user and active);
  update public.user_location_assignments set active = false, ends_on = current_date
   where user_id = v_user and active and location_id not in (select l.id from public.locations l where l.code in (select jsonb_array_elements_text(coalesce(p -> 'location_codes', '[]'))));
  insert into public.user_location_assignments (user_id, location_id, assigned_by)
    select v_user, l.id, (select auth.uid()) from public.locations l
    where l.code in (select jsonb_array_elements_text(coalesce(p -> 'location_codes', '[]')))
      and not exists (select 1 from public.user_location_assignments a where a.user_id = v_user and a.location_id = l.id and a.active);
  update public.user_client_assignments set active = false where user_id = v_user;
  insert into public.user_client_assignments (user_id, client_id)
    select v_user, c.id from public.clients c where c.name in (select jsonb_array_elements_text(coalesce(p -> 'client_names', '[]')))
  on conflict (user_id, client_id) do update set active = true;
  perform private.audit('user.access-changed', 'profiles', v_user::text, 'Role/location access changed', jsonb_build_object('before', v_before, 'after', p - 'user_id'));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_upsert_location(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  insert into public.locations (code, name, kind, lat, lng, public_label, country, account_code, public_place)
  values (p ->> 'code', p ->> 'name', (replace(p ->> 'kind', '-', '_'))::public.location_kind, (p ->> 'lat')::float8, (p ->> 'lng')::float8,
          p ->> 'public_label', coalesce(p ->> 'country', ''), nullif(p ->> 'account_code', ''), coalesce((p ->> 'public_place')::boolean, false))
  on conflict (code) do update set name = excluded.name, kind = excluded.kind, lat = excluded.lat, lng = excluded.lng, public_label = excluded.public_label,
     country = excluded.country, account_code = excluded.account_code, public_place = excluded.public_place, updated_at = now()
  returning id into v_id;
  perform private.audit('master.updated', 'locations', v_id::text, format('Location %s saved', p ->> 'code'), p);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.admin_upsert_group(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_centre public.locations;
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  v_centre := private.location_by_code(p ->> 'centre_code');
  insert into public.processing_groups (code, centre_id, name, members) values (p ->> 'code', v_centre.id, trim(p ->> 'name'), coalesce((p ->> 'members')::int, 0))
  on conflict (code) do update set centre_id = excluded.centre_id, name = excluded.name, members = excluded.members;
  perform private.audit('master.updated', 'processing_groups', p ->> 'code', format('Processing group %s saved', p ->> 'name'), p);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_upsert_collection_area(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_loc uuid;
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  if jsonb_array_length(coalesce(p -> 'polygon', '[]')) < 4 then raise exception 'A collection area polygon needs at least 3 vertices (closed ring).'; end if;
  insert into public.locations (code, name, kind, lat, lng, public_label, country)
  values (p ->> 'code', p ->> 'name', 'collection_area', (p ->> 'lat')::float8, (p ->> 'lng')::float8, 'Certified forest-reserve collection area', coalesce(p ->> 'country', 'Ghana'))
  on conflict (code) do update set name = excluded.name, lat = excluded.lat, lng = excluded.lng, updated_at = now()
  returning id into v_loc;
  insert into public.collection_areas (location_id, area_code, operational_area, public_polygon) values (v_loc, p ->> 'area_code', p ->> 'operational_area', p -> 'public_polygon')
  on conflict (location_id) do update set area_code = excluded.area_code, operational_area = excluded.operational_area, public_polygon = coalesce(excluded.public_polygon, public.collection_areas.public_polygon);
  insert into public.collection_area_geometry (location_id, polygon, geometry_source) values (v_loc, p -> 'polygon', coalesce(p ->> 'geometry_source', 'entered by IT'))
  on conflict (location_id) do update set polygon = excluded.polygon, geometry_source = excluded.geometry_source, version = public.collection_area_geometry.version + 1, updated_at = now();
  perform private.audit('master.updated', 'collection_areas', v_loc::text, format('Collection area %s saved (geometry version bumped)', p ->> 'area_code'));
  return jsonb_build_object('ok', true);
end $$;

-- One-time bootstrap of the first IT Admin. NOT callable by signed-in users.
-- Run from the SQL editor (as postgres) after inviting/creating that Auth user in
-- the Dashboard:  select private.bootstrap_first_admin('it.lead@example.org', 'Name');
create or replace function private.bootstrap_first_admin(p_email text, p_name text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid;
begin
  if exists (select 1 from public.app_user_roles where role = 'it_admin' and active) then
    raise exception 'An IT Admin already exists. Use the Users & access screen to invite more people.';
  end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then raise exception 'Create or invite % in Supabase Auth first.', p_email; end if;
  insert into public.profiles (user_id, display_name) values (v_uid, p_name);
  insert into public.app_user_roles (user_id, role) values (v_uid, 'it_admin');
  insert into public.audit_log (actor_id, action, target_table, target_id, summary) values (v_uid, 'user.bootstrap-admin', 'profiles', v_uid::text, 'First IT Admin bootstrapped from the SQL editor');
  return 'First IT Admin created for ' || p_email;
end $$;
revoke all on function private.bootstrap_first_admin(text, text) from public, anon, authenticated;

-- ── events → front-end JSON (shared by the snapshot and the public trace) ────
-- p_ids must already be filtered (by RLS for the snapshot, by lineage for public).
-- Field privacy is applied explicitly here: prices and collector codes are only
-- included when the caller may see them, and never in public output.
create or replace function private.events_json(p_ids uuid[], p_public boolean, p_lot_alias jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_price_ok boolean := not p_public and (private.is_admin() or private.has_role('auditor'));
begin
  -- defence in depth: the public (sanitised) form is for the service role only, and
  -- the internal form re-checks visibility of every requested event.
  if p_public and coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  return coalesce((
    with e as (
      select ev.*, loc.code as loc_code from public.events ev join public.locations loc on loc.id = ev.location_id
      where ev.id = any (p_ids) and (p_public or private.event_visible(ev.id))
    ),
    lot_items as (
      select x.event_id, x.role, jsonb_agg(jsonb_build_object('lotId', coalesce(p_lot_alias ->> l.code, l.code), 'product', l.product, 'qty', x.quantity_kg) order by l.code) as items
      from (
        select si.shipment_event_id as event_id, 'item' as role, si.lot_id, si.quantity_kg from public.shipment_items si where si.shipment_event_id = any (p_ids)
        union all select ri.receipt_event_id, 'item', ri.lot_id, ri.quantity_kg from public.receipt_items ri where ri.receipt_event_id = any (p_ids)
        union all select gi.event_id, 'item', gi.lot_id, gi.quantity_kg from public.group_issue_items gi where gi.event_id = any (p_ids)
        union all select ti.event_id, 'in', ti.lot_id, ti.quantity_kg from public.transformation_inputs ti where ti.event_id = any (p_ids)
        union all select tout.event_id, 'out', tout.lot_id, tout.quantity_kg from public.transformation_outputs tout where tout.event_id = any (p_ids)
      ) x join public.lots l on l.id = x.lot_id
      group by x.event_id, x.role
    )
    select jsonb_agg(j) from (
      select jsonb_build_object(
        'id', e.id,
        'eventTime', private.fe_time(e.occurred_at, e.occurred_tz),
        'recordedAt', case when p_public then private.fe_time(e.occurred_at, e.occurred_tz) else to_char(e.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'recordedBy', private.fe_role(e.actor_role),
        'actorId', case when p_public then null else e.actor_id end,
        'locationId', e.loc_code,
        'version', e.version,
        'notes', case when p_public then null else e.notes end,
        'demo', false
      ) || case e.event_type
        when 'purchase' then (
          select jsonb_build_object('type', 'commission', 'collectorId', case when p_public then 'withheld' else c.code end, 'purchaseDate', pe.purchase_date,
            'pricePerKg', case when v_price_ok or (not p_public and e.actor_id = (select auth.uid())) then pp.price_per_kg end, 'currency', coalesce(pp.currency, 'GHS'),
            'outputs', jsonb_build_array(jsonb_build_object('lotId', coalesce(p_lot_alias ->> l.code, l.code), 'product', pe.product, 'qty', pe.quantity_kg)))
          from public.purchase_events pe join public.lots l on l.id = pe.lot_id join public.collectors c on c.id = pe.collector_id
          left join public.purchase_prices pp on pp.event_id = pe.event_id where pe.event_id = e.id)
        when 'shipment' then (
          select jsonb_build_object('type', 'ship', 'fromId', o.code, 'toId', d.code, 'shipmentRef', case when p_public then null else s.shipment_ref end,
            'items', coalesce((select items from lot_items li where li.event_id = e.id and li.role = 'item'), '[]'),
            'exportDetails', case when p_public then null else jsonb_strip_nulls(jsonb_build_object('containerNo', s.container_no, 'vessel', s.vessel, 'eta', s.eta, 'clientName', cl.name, 'orderRef', s.order_ref)) end)
          from public.shipment_events s join public.locations o on o.id = s.origin_id join public.locations d on d.id = s.destination_id
          left join public.clients cl on cl.id = s.client_id where s.event_id = e.id)
        when 'delivery' then (
          select jsonb_build_object('type', 'deliver', 'toId', d.code, 'items', coalesce((select items from lot_items li where li.event_id = e.id and li.role = 'item'), '[]'))
          from public.shipment_events s join public.locations d on d.id = s.destination_id where s.event_id = e.id)
        when 'receipt' then (
          select jsonb_build_object('type', 'receive', 'shipEventId', r.shipment_event_id, 'fromId', o.code, 'outcome', r.outcome,
            'discrepancyNote', case when p_public then null else r.discrepancy_note end,
            'discrepancyResolution', case when r.resolved_at is null or p_public then null else jsonb_build_object('at', r.resolved_at, 'note', r.resolution_note) end,
            'items', coalesce((select items from lot_items li where li.event_id = e.id and li.role = 'item'), '[]'))
          from public.receipt_events r join public.shipment_events s on s.event_id = r.shipment_event_id join public.locations o on o.id = s.origin_id where r.event_id = e.id)
        when 'group_issue' then (
          select jsonb_build_object('type', 'issue', 'groupId', g.code, 'items', coalesce((select items from lot_items li where li.event_id = e.id and li.role = 'item'), '[]'))
          from public.group_issue_events gi join public.processing_groups g on g.id = gi.group_id where gi.event_id = e.id)
        when 'transformation' then (
          select jsonb_build_object('type', 'transform', 'kind', private.fe_transform(t.kind), 'groupId', g.code,
            'inputs', coalesce((select items from lot_items li where li.event_id = e.id and li.role = 'in'), '[]'),
            'outputs', coalesce((select items from lot_items li where li.event_id = e.id and li.role = 'out'), '[]'),
            'sfclStage', case when t.kind = 'sfcl_aggregation' then (select case l.sfcl_stage when 'finalized' then 'finalized' else 'in-progress' end
                                                                      from public.transformation_outputs tout join public.lots l on l.id = tout.lot_id where tout.event_id = e.id limit 1) end)
          from public.transformation_events t left join public.processing_groups g on g.id = t.group_id where t.event_id = e.id)
        when 'ready_for_pickup' then (
          select jsonb_build_object('type', 'ready', 'handoffId', h.id,
            'items', jsonb_build_array(jsonb_build_object('lotId', l.code, 'product', l.product, 'qty', h.quantity_kg)))
          from public.commercial_handoffs h join public.lots l on l.id = h.lot_id where h.ready_event_id = e.id)
      end as j
      from e
    ) q where j ? 'type'), '[]');
end $$;

-- RLS-scoped workspace for the signed-in user, shaped like the front-end DemoDB.
-- SECURITY INVOKER: every table read below is filtered by the caller's policies.
create or replace function public.get_workspace_snapshot() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_ids uuid[];
  v_admin boolean := private.is_admin();
begin
  if (select auth.uid()) is null or not private.is_active() then raise exception 'No active access.' using errcode = '42501'; end if;
  select coalesce(array_agg(id), '{}') into v_ids from public.events; -- RLS applies
  return jsonb_build_object(
    'schemaVersion', 4,
    'seededAt', now(),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.code, 'name', l.name, 'kind', private.fe_kind(l.kind), 'lat', l.lat, 'lng', l.lng,
        'publicLabel', l.public_label, 'country', l.country, 'accountCode', l.account_code, 'publicPlace', l.public_place, 'demo', false))
      from public.locations l where l.kind <> 'collection_area' and l.active), '[]'),
    'collectionAreas', coalesce((select jsonb_agg(jsonb_build_object('id', l.code, 'code', ca.area_code, 'name', l.name, 'operationalArea', ca.operational_area,
        'polygon', coalesce(g.polygon, ca.public_polygon, '[]'::jsonb), 'demo', false, 'geometrySource', coalesce(g.geometry_source, 'Generalised (customer-safe) geometry')))
      from public.collection_areas ca join public.locations l on l.id = ca.location_id left join public.collection_area_geometry g on g.location_id = ca.location_id), '[]'),
    'collectors', coalesce((select jsonb_agg(jsonb_build_object('id', c.code, 'code', c.code, 'name', coalesce(cp.full_name, 'Collector ' || c.code),
        'collectionAreaId', l.code, 'demo', false))
      from public.collectors c join public.locations l on l.id = c.collection_area_id left join public.collector_personal cp on cp.collector_id = c.id), '[]'),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.code, 'centreId', l.code, 'name', g.name, 'members', g.members, 'demo', false))
      from public.processing_groups g join public.locations l on l.id = g.centre_id where g.active), '[]'),
    'routes', '[]'::jsonb,
    'events', private.events_json(v_ids, false),
    'lots', coalesce((select jsonb_agg(jsonb_build_object('lotId', l.code, 'product', l.product, 'kind', replace(l.lot_kind::text, '_', '-'),
        'createdAt', to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'locationId', loc.code))
      from public.lots l join public.locations loc on loc.id = l.created_at_location), '[]'),
    'handoffs', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'lotId', l.code, 'qty', h.quantity_kg, 'product', l.product, 'locationId', loc.code,
        'readyEventId', h.ready_event_id, 'token', '', 'clientName', c.name, 'orderRef', h.order_ref, 'createdAt', h.created_at, 'status', h.status,
        'acknowledgedAt', h.acknowledged_at, 'invoiceRef', h.invoice_ref,
        'invoiceStatus', case h.invoice_status when 'not_started' then 'not-started' when 'in_preparation' then 'in-preparation' else 'recorded-demo' end,
        'disclosure', h.disclosure, 'demo', false))
      from public.commercial_handoffs h join public.lots l on l.id = h.lot_id join public.locations loc on loc.id = h.location_id join public.clients c on c.id = h.client_id), '[]'),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'kind', d.kind,
        'appliesTo', case when d.lot_id is null then '"*"'::jsonb else jsonb_build_array((select code from public.lots where id = d.lot_id)) end,
        'public', d.customer_visible, 'demo', false))
      from public.documents d), '[]'),
    'audit', coalesce((select jsonb_agg(jsonb_build_object('id', a.id::text, 'at', a.at, 'actor', 'system', 'actorId', a.actor_id, 'action', a.action,
        'targetId', a.target_id, 'summary', a.summary, 'details', a.details) order by a.at)
      from public.audit_log a), '[]'),
    'users', case when v_admin then public.admin_list_users() else '[]'::jsonb end,
    'invitations', case when v_admin then public.admin_list_invitations() else '[]'::jsonb end
  );
end $$;

-- ── customer trace (anonymous) — server-side only ────────────────────────────
-- Edge Function `trace-link` (caller JWT checked by RLS first) gets the grant id,
-- derives the token as HMAC(secret, grant_id) and stores only its SHA-256 hash.
create or replace function public.service_trace_grant(p_handoff uuid, p_token_hash bytea default null) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_g public.customer_trace_grants;
begin
  select * into v_g from public.customer_trace_grants where handoff_id = p_handoff for update;
  if not found then raise exception 'No trace grant for that handoff.'; end if;
  if p_token_hash is not null then
    if v_g.token_hash is null then update public.customer_trace_grants set token_hash = p_token_hash where id = v_g.id;
    elsif v_g.token_hash <> p_token_hash then raise exception 'Token mismatch (secret rotated?).';
    end if;
  end if;
  return v_g.id;
end $$;

-- Returns ONLY approved, generalised fields for a valid, unexpired, unrevoked token hash.
create or replace function public.service_public_trace(p_token_hash bytea) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_g public.customer_trace_grants;
  v_h public.commercial_handoffs;
  v_lots uuid[];
  v_ids uuid[];
  v_alias jsonb;
  v_step numeric;
  v_full boolean;
begin
  select * into v_g from public.customer_trace_grants where token_hash = p_token_hash;
  if not found or v_g.revoked_at is not null or (v_g.expires_at is not null and v_g.expires_at < now()) then return null; end if;
  select * into v_h from public.commercial_handoffs where id = v_g.handoff_id;
  v_full := v_h.disclosure = 'full';
  v_step := case v_h.disclosure when 'masked' then 0.5 else 0.25 end;
  -- lineage: the handoff lot and all its ancestors
  with recursive anc(lot_id) as (
    select v_h.lot_id
    union
    select ti.lot_id from anc join public.transformation_outputs tout on tout.lot_id = anc.lot_id join public.transformation_inputs ti on ti.event_id = tout.event_id
  ) select array_agg(lot_id) into v_lots from anc;
  select array_agg(distinct id) into v_ids from (
    select l.created_by_event as id from public.lots l where l.id = any (v_lots)
    union select si.shipment_event_id from public.shipment_items si where si.lot_id = any (v_lots)
    union select ri.receipt_event_id from public.receipt_items ri where ri.lot_id = any (v_lots)
    union select gi.event_id from public.group_issue_items gi where gi.lot_id = any (v_lots)
    union select v_h.ready_event_id
  ) x;
  -- full trace keeps real lot IDs; reduced modes replace purchase lot codes (which embed
  -- collector numbers) with opaque aliases
  if v_full then
    v_alias := '{}'::jsonb;
  else
    select coalesce(jsonb_object_agg(l.code, 'origin-lot-' || row_number), '{}') into v_alias
    from (select l.code, row_number() over (order by l.created_at, l.code) from public.lots l where l.id = any (v_lots) and l.lot_kind = 'purchase') l;
  end if;
  return jsonb_build_object(
    'handoff', jsonb_build_object('id', v_h.id, 'lotId', (select code from public.lots where id = v_h.lot_id), 'qty', v_h.quantity_kg,
      'product', (select product from public.lots where id = v_h.lot_id), 'locationId', (select code from public.locations where id = v_h.location_id),
      'readyEventId', v_h.ready_event_id, 'token', '', 'clientName', (select name from public.clients where id = v_h.client_id), 'orderRef', '',
      'createdAt', v_h.created_at, 'status', 'new', 'invoiceStatus', 'not-started', 'disclosure', v_h.disclosure, 'demo', false),
    'db', jsonb_build_object(
      'schemaVersion', 4, 'seededAt', now(), 'routes', '[]'::jsonb, 'collectors', '[]'::jsonb, 'audit', '[]'::jsonb,
      'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.code, 'centreId', l.code, 'name', 'Processing group', 'members', 0, 'demo', false))
        from public.processing_groups g join public.locations l on l.id = g.centre_id
        where g.id in (select group_id from public.transformation_events where event_id = any (v_ids) union select group_id from public.group_issue_events where event_id = any (v_ids))), '[]'),
      'users', '[]'::jsonb, 'invitations', '[]'::jsonb, 'handoffs', '[]'::jsonb,
      -- full: exact facility names and points; reduced modes: public label + rounded coordinates
      'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.code, 'name', case when v_full or l.public_place then l.name else l.public_label end,
          'kind', private.fe_kind(l.kind),
          'lat', case when v_full or l.public_place then l.lat else round(l.lat::numeric / v_step) * v_step end,
          'lng', case when v_full or l.public_place then l.lng else round(l.lng::numeric / v_step) * v_step end,
          'publicLabel', l.public_label, 'country', l.country, 'publicPlace', true, 'demo', false))
        from public.locations l where l.kind <> 'collection_area' and l.id in (select location_id from public.events where id = any (v_ids)
                                                                              union select destination_id from public.shipment_events where event_id = any (v_ids))), '[]'),
      'collectionAreas', coalesce((select jsonb_agg(jsonb_build_object('id', l.code, 'code', case when v_full then ca.area_code else '' end,
          'name', case when v_full then l.name else 'Certified forest-reserve collection area' end,
          'operationalArea', case when v_full then ca.operational_area else '' end,
          'polygon', case v_h.disclosure when 'masked' then '[]'::jsonb when 'full' then coalesce(g.polygon, ca.public_polygon, '[]'::jsonb) else coalesce(ca.public_polygon, '[]'::jsonb) end,
          'demo', false, 'geometrySource', case when v_full then 'Approved for this client' else 'Generalised for customers' end))
        from public.collection_areas ca join public.locations l on l.id = ca.location_id left join public.collection_area_geometry g on g.location_id = ca.location_id
        where ca.location_id in (select location_id from public.events where id = any (v_ids))), '[]'),
      'events', private.events_json(v_ids, true, v_alias),
      'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'kind', d.kind, 'appliesTo', '*', 'public', true, 'demo', false))
        from public.documents d where d.customer_visible and (d.lot_id is null or d.lot_id = any (v_lots))), '[]')
    )
  );
end $$;

-- Grants for this file
revoke all on function
  public.accept_invitation(text), public.get_my_context(), public.admin_list_users(), public.admin_list_invitations(),
  public.admin_prepare_invitation(jsonb), public.admin_update_invitation(uuid, text), public.admin_set_user_status(uuid, public.account_status),
  public.admin_set_user_access(jsonb), public.admin_upsert_location(jsonb), public.admin_upsert_group(jsonb), public.admin_upsert_collection_area(jsonb),
  public.get_workspace_snapshot(), public.service_trace_grant(uuid, bytea), public.service_public_trace(bytea)
from public, anon;
grant execute on function
  public.accept_invitation(text), public.get_my_context(), public.admin_list_users(), public.admin_list_invitations(),
  public.admin_prepare_invitation(jsonb), public.admin_update_invitation(uuid, text), public.admin_set_user_status(uuid, public.account_status),
  public.admin_set_user_access(jsonb), public.admin_upsert_location(jsonb), public.admin_upsert_group(jsonb), public.admin_upsert_collection_area(jsonb),
  public.get_workspace_snapshot()
to authenticated;
-- service_* functions: Edge Functions only (service role), never browsers
revoke all on function public.service_trace_grant(uuid, bytea), public.service_public_trace(bytea) from authenticated;
grant execute on function public.service_trace_grant(uuid, bytea), public.service_public_trace(bytea) to service_role;
grant execute on function private.events_json(uuid[], boolean, jsonb) to authenticated;
revoke all on function private.be_role(text) from public, anon, authenticated;

-- Realtime: let destination users get a nudge when a shipment addressed to them
-- changes. postgres_changes respects RLS, so nobody receives others' shipments.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.shipment_events';
  end if;
end $$;
