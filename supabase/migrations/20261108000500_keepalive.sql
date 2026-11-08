-- ════════════════════════════════════════════════════════════════════════════
-- Keep-alive for the Supabase Free plan.
-- Free projects are paused after a week without sufficient *database* activity.
-- A scheduled job (.github/workflows/keepalive.yml) calls public.keepalive()
-- every two days. It performs a real write — at most one row per hour, so it
-- cannot be abused to fill the database — and returns nothing but a timestamp.
-- No operational data is read or exposed.
-- ════════════════════════════════════════════════════════════════════════════

create table private.heartbeat (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  source text not null default 'keepalive'
);

create or replace function public.keepalive() returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare v_last timestamptz;
begin
  select max(at) into v_last from private.heartbeat;
  if v_last is null or v_last < now() - interval '1 hour' then
    insert into private.heartbeat (source) values ('keepalive');
    delete from private.heartbeat where at < now() - interval '30 days';
  end if;
  return now();
end $$;

revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;
