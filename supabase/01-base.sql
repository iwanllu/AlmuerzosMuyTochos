-- =====================================================================
-- Almuerzos Muy Tochos · 01 · base: perfiles, admin y fotos
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

-- ---------- SEGURIDAD (RLS) ----------
alter table public.profiles enable row level security;
revoke all on public.profiles from anon;

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
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles') then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;
