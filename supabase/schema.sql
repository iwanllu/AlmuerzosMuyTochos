-- =====================================================================
-- Almuerzos Muy Tochos · esquema de base de datos (Supabase / Postgres)
-- Ejecutar entero en: SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- =====================================================================

-- ---------- PERFILES ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null unique,
  display_name text not null,
  avatar_url   text,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint display_name_len check (char_length(display_name) between 1 and 40)
);

-- Crea el perfil automáticamente cuando das de alta un usuario en Authentication
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  u text := lower(split_part(new.email, '@', 1));
begin
  insert into public.profiles (id, username, display_name)
  values (new.id, u, initcap(u))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Perfiles para usuarios que ya existieran antes de ejecutar este script
insert into public.profiles (id, username, display_name)
select id, lower(split_part(email, '@', 1)), initcap(split_part(email, '@', 1))
from auth.users
on conflict (id) do nothing;

-- ¿El usuario actual es admin?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- ---------- VOTACIONES ----------
create table if not exists public.polls (
  id          bigint generated always as identity primary key,
  title       text not null check (char_length(title) between 1 and 120),
  description text check (char_length(description) <= 500),
  kind        text not null check (kind in ('choice', 'score')),
  is_open     boolean not null default true,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);

create table if not exists public.poll_options (
  id       bigint generated always as identity primary key,
  poll_id  bigint not null references public.polls (id) on delete cascade,
  label    text not null check (char_length(label) between 1 and 80),
  position int not null default 0
);
create index if not exists poll_options_poll_idx on public.poll_options (poll_id);

create table if not exists public.votes (
  id         bigint generated always as identity primary key,
  poll_id    bigint not null references public.polls (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  option_id  bigint references public.poll_options (id) on delete cascade,
  score      int check (score between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (poll_id, user_id)                -- un voto por persona y votación
);
create index if not exists votes_poll_idx on public.votes (poll_id);

-- Valida cada voto: votación abierta, tipo correcto y opción de esa votación
create or replace function public.validate_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.polls;
begin
  if tg_op = 'UPDATE' and (new.poll_id <> old.poll_id or new.user_id <> old.user_id) then
    raise exception 'No se puede mover un voto';
  end if;

  select * into p from public.polls where id = new.poll_id;
  if not found then raise exception 'La votación no existe'; end if;
  if not p.is_open then raise exception 'La votación está cerrada'; end if;

  if p.kind = 'choice' then
    if new.option_id is null or new.score is not null then
      raise exception 'Esta votación es de elegir opción';
    end if;
    if not exists (select 1 from public.poll_options o
                   where o.id = new.option_id and o.poll_id = new.poll_id) then
      raise exception 'Opción no válida';
    end if;
  else
    if new.score is null or new.option_id is not null then
      raise exception 'Esta votación es de puntuar del 1 al 10';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists validate_vote on public.votes;
create trigger validate_vote
  before insert or update on public.votes
  for each row execute function public.validate_vote();

-- Rellena closed_at al cerrar
create or replace function public.touch_poll()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_open is distinct from old.is_open then
    new.closed_at := case when new.is_open then null else now() end;
  end if;
  return new;
end;
$$;

drop trigger if exists touch_poll on public.polls;
create trigger touch_poll
  before update on public.polls
  for each row execute function public.touch_poll();

-- Crear votación + opciones en una sola operación (solo admin)
create or replace function public.create_poll(
  p_title text, p_description text, p_kind text, p_options text[]
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_id bigint;
  i int;
begin
  if not public.is_admin() then raise exception 'Solo el admin puede crear votaciones'; end if;
  if p_kind = 'choice' and coalesce(array_length(p_options, 1), 0) < 2 then
    raise exception 'Hacen falta al menos 2 opciones';
  end if;

  insert into public.polls (title, description, kind)
  values (trim(p_title), nullif(trim(coalesce(p_description, '')), ''), p_kind)
  returning id into new_id;

  if p_kind = 'choice' then
    for i in 1 .. array_length(p_options, 1) loop
      insert into public.poll_options (poll_id, label, position)
      values (new_id, trim(p_options[i]), i);
    end loop;
  end if;

  return new_id;
end;
$$;

-- ---------- SEGURIDAD (RLS) ----------
alter table public.profiles     enable row level security;
alter table public.polls        enable row level security;
alter table public.poll_options enable row level security;
alter table public.votes        enable row level security;

-- Nada para usuarios anónimos
revoke all on public.profiles, public.polls, public.poll_options, public.votes from anon;
revoke execute on function public.create_poll(text, text, text, text[]) from anon, public;
grant  execute on function public.create_poll(text, text, text, text[]) to authenticated;

-- Perfiles: todos los del grupo los ven; cada uno solo edita su nombre y foto
drop policy if exists "perfiles visibles" on public.profiles;
create policy "perfiles visibles" on public.profiles
  for select to authenticated using (true);

drop policy if exists "editar mi perfil" on public.profiles;
create policy "editar mi perfil" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

revoke insert, update, delete on public.profiles from authenticated;
grant  update (display_name, avatar_url) on public.profiles to authenticated;   -- is_admin/username no editables

-- Votaciones y opciones: todos leen; solo admin crea, cierra y borra
drop policy if exists "leer votaciones" on public.polls;
create policy "leer votaciones" on public.polls
  for select to authenticated using (true);

drop policy if exists "admin gestiona votaciones" on public.polls;
create policy "admin gestiona votaciones" on public.polls
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "leer opciones" on public.poll_options;
create policy "leer opciones" on public.poll_options
  for select to authenticated using (true);

drop policy if exists "admin gestiona opciones" on public.poll_options;
create policy "admin gestiona opciones" on public.poll_options
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Votos: todos ven los votos (resultados en directo); cada uno solo el suyo
drop policy if exists "leer votos" on public.votes;
create policy "leer votos" on public.votes
  for select to authenticated using (true);

drop policy if exists "votar" on public.votes;
create policy "votar" on public.votes
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "cambiar mi voto" on public.votes;
create policy "cambiar mi voto" on public.votes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke delete on public.votes from authenticated;

-- ---------- FOTOS DE PERFIL (Storage) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "avatar leer" on storage.objects;
create policy "avatar leer" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');

drop policy if exists "avatar subir" on storage.objects;
create policy "avatar subir" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatar actualizar" on storage.objects;
create policy "avatar actualizar" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "avatar borrar" on storage.objects;
create policy "avatar borrar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------- TIEMPO REAL ----------
do $$
declare t text;
begin
  foreach t in array array['profiles', 'polls', 'poll_options', 'votes'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
