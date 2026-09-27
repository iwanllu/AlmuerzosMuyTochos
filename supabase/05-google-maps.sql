-- =====================================================================
-- Almuerzos Muy Tochos · 05 · Google Maps
-- Requiere 01. Idempotente.
--
-- La clave de navegador de Google Maps la pega el admin desde la web
-- (Perfil → Google Maps). Es una clave pública por diseño (va en el
-- navegador) y debe estar restringida en Google Cloud a:
--   · Sitios web: https://iwanllu.github.io/*
--   · APIs: Maps JavaScript API y Places API (New)
-- Solo la pueden leer usuarios con sesión; solo el admin la cambia.
-- =====================================================================

create table if not exists public.app_config (
  id         int primary key default 1 check (id = 1),
  maps_key   text check (maps_key is null or maps_key ~ '^[A-Za-z0-9_-]{20,60}$'),
  updated_at timestamptz not null default now()
);
insert into public.app_config (id) values (1) on conflict (id) do nothing;

alter table public.app_config enable row level security;
revoke all on public.app_config from anon;
revoke insert, update, delete on public.app_config from authenticated;
grant  update (maps_key, updated_at) on public.app_config to authenticated;

drop policy if exists "leer config" on public.app_config;
create policy "leer config" on public.app_config for select to authenticated using (true);
drop policy if exists "admin config" on public.app_config;
create policy "admin config" on public.app_config for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_config') then
    alter publication supabase_realtime add table public.app_config;
  end if;
end $$;
