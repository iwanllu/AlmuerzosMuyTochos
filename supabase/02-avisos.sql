-- =====================================================================
-- Almuerzos Muy Tochos · 02 · avisos (notificaciones push + bandeja)
-- Requiere 01-base.sql. Idempotente.
--
-- Cómo funciona:
--   1. Cada móvil que activa los avisos guarda su suscripción push.
--   2. Cuando pasa algo (batalla, cambio de fase…), la base de datos deja
--      el aviso en push_outbox, apuntando quién lo provocó (actor).
--   3. La web del actor llama a la función "push", que recoge SOLO los
--      avisos que ha provocado ese usuario y los envía.
--   Nadie puede leer avisos ajenos ni las suscripciones de otros.
-- =====================================================================

create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  endpoint   text not null unique check (endpoint like 'https://%'),
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table if not exists public.push_outbox (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,  -- destinatario
  actor_id   uuid references public.profiles (id) on delete set null,          -- quién lo provocó
  title      text not null,
  body       text not null default '',
  url        text not null default '#/',
  tag        text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at    timestamptz
);
create index if not exists push_outbox_pending_idx on public.push_outbox (actor_id) where sent_at is null;

alter table public.push_subscriptions enable row level security;
alter table public.push_outbox        enable row level security;
revoke all on public.push_subscriptions, public.push_outbox from anon, authenticated;

-- ---------- Encolar avisos (internas) ----------
create or replace function public._notify(p_user uuid, p_title text, p_body text, p_url text default '#/', p_tag text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null then return; end if;
  -- Solo si ese usuario tiene algún móvil con avisos activados
  if exists (select 1 from public.push_subscriptions where user_id = p_user) then
    insert into public.push_outbox (user_id, actor_id, title, body, url, tag)
    values (p_user, auth.uid(), p_title, coalesce(p_body, ''), coalesce(p_url, '#/'), p_tag);
  end if;
end $$;

create or replace function public._notify_all(p_title text, p_body text, p_url text default '#/', p_tag text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare u uuid;
begin
  for u in select id from public.profiles where id is distinct from auth.uid() loop
    perform public._notify(u, p_title, p_body, p_url, p_tag);
  end loop;
end $$;

-- Cosas pendientes de un usuario (para el numerito del icono de la app)
create or replace function public._pending_count(p_user uuid)
returns int language plpgsql stable security definer set search_path = '' as $$
declare n int := 0; s record;
begin
  select count(*) into n
  from public.battle_players bp join public.battles b on b.id = bp.battle_id
  where bp.user_id = p_user
    and ((b.status = 'spin' and b.challenger_id = p_user) or (b.status = 'playing' and not bp.finished));

  select * into s from public.sessions where phase <> 'closed' limit 1;
  if found then
    if (s.phase = 'proposals' and not exists (select 1 from public.proposals where session_id = s.id and user_id = p_user))
       or (s.phase = 'voting' and not exists (select 1 from public.session_votes where session_id = s.id and user_id = p_user))
       or (s.phase = 'rating' and not exists (select 1 from public.ratings where session_id = s.id and user_id = p_user)) then
      n := n + 1;
    end if;
    if s.lunch_date is null and not exists (select 1 from public.date_answers where session_id = s.id and user_id = p_user) then
      n := n + 1;
    end if;
  end if;
  return n;
end $$;

-- ---------- Funciones públicas ----------
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  if p_endpoint is null or p_endpoint not like 'https://%' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Suscripción no válida';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = now();
end $$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end $$;

create or replace function public.my_push_devices()
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.push_subscriptions where user_id = auth.uid();
$$;

-- La función de envío recoge los avisos provocados por quien la llama
create or replace function public.push_claim()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare res jsonb;
begin
  if auth.uid() is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  with c as (
    update public.push_outbox o set claimed_at = now()
    where o.id in (
      select x.id from public.push_outbox x
      where x.actor_id = auth.uid() and x.sent_at is null
        and (x.claimed_at is null or x.claimed_at < now() - interval '2 minutes')
        and x.created_at > now() - interval '1 day'
      order by x.id limit 200
      for update skip locked)
    returning o.*
  )
  select jsonb_build_object(
    'ids', coalesce((select jsonb_agg(c.id) from c), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
        'payload', jsonb_build_object('title', c.title, 'body', c.body, 'url', c.url, 'tag', c.tag,
                                      'badge', public._pending_count(c.user_id))))
      from c join public.push_subscriptions s on s.user_id = c.user_id), '[]'::jsonb)
  ) into res;
  return res;
end $$;

create or replace function public.push_done(p_ids bigint[], p_gone text[] default '{}')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  update public.push_outbox set sent_at = now()
  where id = any(p_ids) and actor_id = auth.uid();
  -- Borra móviles que ya no aceptan avisos (solo destinatarios de avisos recién enviados por este usuario)
  delete from public.push_subscriptions s
  where s.endpoint = any(coalesce(p_gone, '{}'))
    and exists (select 1 from public.push_outbox o
                where o.actor_id = auth.uid() and o.user_id = s.user_id and o.claimed_at > now() - interval '10 minutes');
  -- Limpieza
  delete from public.push_outbox where created_at < now() - interval '7 days';
end $$;

-- Aviso de prueba a mis propios dispositivos
create or replace function public.push_test()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  if not exists (select 1 from public.push_subscriptions where user_id = auth.uid()) then
    raise exception 'Este usuario no tiene avisos activados en ningún dispositivo';
  end if;
  perform public._notify(auth.uid(), '🔔 Aviso de prueba', '¡Los avisos de Almuerzos Muy Tochos funcionan!', '#/perfil', 'test');
end $$;

revoke execute on function public._notify(uuid, text, text, text, text), public._notify_all(text, text, text, text),
                           public._pending_count(uuid)
  from public, anon, authenticated;
revoke execute on function public.save_push_subscription(text, text, text), public.delete_push_subscription(text),
                           public.my_push_devices(), public.push_claim(), public.push_done(bigint[], text[]),
                           public.push_test()
  from public, anon;
grant execute on function public.save_push_subscription(text, text, text), public.delete_push_subscription(text),
                          public.my_push_devices(), public.push_claim(), public.push_done(bigint[], text[]),
                          public.push_test()
  to authenticated;
