-- ════════════════════════════════════════════════════════════════════════════
-- Password sign-in with mandatory authenticator-app MFA, and master-data bulk import.
--
-- Sign-in model (replaces email one-time codes):
--  • IT invites → the person opens a one-time link → sets their own password →
--    sets up an authenticator app (TOTP) → signs in with email + password + 6-digit code.
--  • Passwords are stored by Supabase Auth (bcrypt). No table here ever holds one,
--    and IT can never read or set one — IT can only issue a one-time reset link.
--  • MFA is enforced HERE, in the database, not just by the screens: every access
--    helper requires an `aal2` session (password + authenticator). A stolen password,
--    or a stolen email inbox, is not enough to read or write any operational data.
-- ════════════════════════════════════════════════════════════════════════════

-- ── MFA gate ─────────────────────────────────────────────────────────────────
-- `aal2` appears in the JWT only after the user verified a TOTP code in this session.
create or replace function private.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2';
$$;

-- The three root helpers every policy and workflow function builds on. Adding the
-- MFA gate to them closes every read and write path at once (fail closed).
create or replace function private.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.mfa_ok()
     and exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.status = 'active');
$$;

create or replace function private.my_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select ur.role
  from public.app_user_roles ur
  join public.profiles p on p.user_id = ur.user_id and p.status = 'active'
  where ur.user_id = (select auth.uid()) and ur.active and private.mfa_ok()
  limit 1;
$$;

create or replace function private.my_location_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select ula.location_id
  from public.user_location_assignments ula
  join public.profiles p on p.user_id = ula.user_id and p.status = 'active'
  where ula.user_id = (select auth.uid())
    and private.mfa_ok()
    and ula.active
    and ula.starts_on <= current_date
    and (ula.ends_on is null or ula.ends_on >= current_date);
$$;

revoke all on function private.mfa_ok() from public, anon;
grant execute on function private.mfa_ok() to authenticated;

-- Clearer message when the only thing missing is the authenticator step.
create or replace function private.require_role(allowed public.app_role[]) returns public.app_role
language plpgsql stable security definer set search_path = '' as $$
declare r public.app_role;
begin
  if (select auth.uid()) is null then raise exception 'Not signed in.' using errcode = '42501'; end if;
  if not private.mfa_ok() then raise exception 'Confirm your sign-in with your authenticator app first.' using errcode = '42501'; end if;
  r := private.my_role();
  if r is null then raise exception 'Your account has no active access (not invited, suspended or no role).' using errcode = '42501'; end if;
  if not (r = any (allowed)) then raise exception 'Your role (%) cannot perform this action.', r using errcode = '42501'; end if;
  return r;
end $$;

-- ── the signed-in user's own sign-in state ───────────────────────────────────
-- Works at aal1 on purpose: the app needs it to decide which step comes next
-- (set password → set up authenticator → enter code). It only describes the caller.
-- `has_password` is derived from Auth itself, so it cannot drift from reality.
create or replace function public.get_my_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_has_password boolean;
  v_mfa boolean;
  v_p public.profiles;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;
  select lower(u.email), coalesce(u.encrypted_password, '') <> '' into v_email, v_has_password from auth.users u where u.id = v_uid;
  v_mfa := exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified');
  select * into v_p from public.profiles where user_id = v_uid;
  if not found then
    return jsonb_build_object('signed_in', true, 'email', v_email, 'profile', null, 'has_password', v_has_password, 'mfa_enrolled', v_mfa,
                              'aal', coalesce((select auth.jwt()) ->> 'aal', 'aal1'));
  end if;
  return jsonb_build_object(
    'signed_in', true,
    'email', v_email,
    'user_id', v_uid,
    'display_name', v_p.display_name,
    'status', v_p.status,
    'has_password', v_has_password,
    'mfa_enrolled', v_mfa,
    'aal', coalesce((select auth.jwt()) ->> 'aal', 'aal1'),
    'role', (select private.fe_role(role) from public.app_user_roles where user_id = v_uid and active limit 1),
    'locations', coalesce((select jsonb_agg(l.code order by l.code) from public.user_location_assignments a join public.locations l on l.id = a.location_id
                           where a.user_id = v_uid and a.active and (a.ends_on is null or a.ends_on >= current_date)), '[]'),
    'clients', coalesce((select jsonb_agg(c.name order by c.name) from public.user_client_assignments a join public.clients c on c.id = a.client_id
                         where a.user_id = v_uid and a.active), '[]'));
end $$;

-- ── IT: password reset link / authenticator reset (authorisation + audit) ────
-- The admin-users Edge Function calls this with the IT Admin's own JWT first, and only
-- then uses the Auth admin API. IT never sees or sets a password: a reset link lets the
-- user choose a new one, and the authenticator step is still required afterwards.
create or replace function public.admin_user_security(p_user uuid, p_action text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text;
  v_status public.account_status;
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  select lower(u.email), p.status into v_email, v_status from public.profiles p join auth.users u on u.id = p.user_id where p.user_id = p_user;
  if not found then raise exception 'Unknown user.'; end if;
  if p_action = 'password_reset' then
    if v_status <> 'active' then raise exception 'Reactivate the account first.'; end if;
    perform private.audit('user.password-reset-issued', 'profiles', p_user::text, format('Password reset link issued for %s (IT never sees or sets the password)', v_email));
  elsif p_action = 'mfa_reset' then
    if p_user = (select auth.uid()) then raise exception 'Ask another IT Admin to reset your own authenticator.'; end if;
    perform private.audit('user.mfa-reset', 'profiles', p_user::text, format('Authenticator removed for %s; a new one must be set up at the next sign-in', v_email));
  else
    raise exception 'Unknown action.';
  end if;
  return jsonb_build_object('ok', true, 'email', v_email, 'status', v_status);
end $$;

-- ── collectors (master data) ─────────────────────────────────────────────────
-- Collector code = area code + collector number, e.g. NE06-CA1332-014. The code is
-- matched exactly and never repaired: a code that does not start with its area code
-- is refused, not "fixed".
create or replace function public.admin_upsert_collector(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text := trim(p ->> 'code');
  v_name text := trim(p ->> 'name');
  v_area public.collection_areas;
  v_id uuid;
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  if coalesce(v_code, '') = '' then raise exception 'Collector code is required.'; end if;
  if coalesce(v_name, '') = '' then raise exception 'Collector name is required for %.', v_code; end if;
  select * into v_area from public.collection_areas where area_code = trim(p ->> 'area_code');
  if not found then raise exception 'Unknown collection area code "%" for collector %. Import the collection areas first.', p ->> 'area_code', v_code; end if;
  if left(v_code, length(v_area.area_code) + 1) <> v_area.area_code || '-' then
    raise exception 'Collector code % does not start with its area code %-. Codes are matched exactly and never repaired.', v_code, v_area.area_code;
  end if;
  insert into public.collectors (code, collection_area_id, active)
  values (v_code, v_area.location_id, coalesce((p ->> 'active')::boolean, true))
  on conflict (code) do update set collection_area_id = excluded.collection_area_id, active = excluded.active
  returning id into v_id;
  insert into public.collector_personal (collector_id, full_name) values (v_id, v_name)
  on conflict (collector_id) do update set full_name = excluded.full_name;
  perform private.audit('master.updated', 'collectors', v_code, format('Collector %s saved', v_code));
  return jsonb_build_object('ok', true);
end $$;

-- ── bulk import of master data: one transaction, all rows or none ────────────
create or replace function public.admin_bulk_upsert(p_kind text, p_rows jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_row jsonb;
  v_i integer := 0;
  v_n integer;
begin
  perform private.require_role(array['it_admin']::public.app_role[]);
  if p_kind not in ('locations', 'collection_areas', 'collectors', 'groups') then raise exception 'Unknown import type "%".', p_kind; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'Rows must be a list.'; end if;
  v_n := jsonb_array_length(p_rows);
  if v_n = 0 then raise exception 'Nothing to import.'; end if;
  if v_n > 5000 then raise exception 'At most 5,000 rows per upload (this one has %). Split the file.', v_n; end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    begin
      case p_kind
        when 'locations' then perform public.admin_upsert_location(v_row);
        when 'collection_areas' then perform public.admin_upsert_collection_area(v_row);
        when 'collectors' then perform public.admin_upsert_collector(v_row);
        when 'groups' then perform public.admin_upsert_group(v_row);
      end case;
    exception when others then
      -- Any failing row aborts the whole upload, so a file is never half-imported.
      raise exception 'Row %: %', coalesce(v_row ->> '_row', v_i::text), sqlerrm using errcode = sqlstate;
    end;
  end loop;
  perform private.audit('master.imported', p_kind, null, format('Bulk upload: %s %s row(s) saved in one transaction', v_n, replace(p_kind, '_', ' ')));
  return jsonb_build_object('ok', true, 'count', v_n);
end $$;

revoke all on function public.admin_user_security(uuid, text), public.admin_upsert_collector(jsonb), public.admin_bulk_upsert(text, jsonb) from public, anon;
grant execute on function public.admin_user_security(uuid, text), public.admin_upsert_collector(jsonb), public.admin_bulk_upsert(text, jsonb) to authenticated;
