-- Deja la app como recién estrenada: borra sesiones, propuestas, votos, notas, pools y batallas.
-- Se mantienen: cuentas de usuario, nombres y fotos, categorías de puntuación, reglas de puntos,
-- clave de Google Maps y dispositivos con avisos activados.
-- ⚠️ No se puede deshacer. Pégalo en Supabase → SQL Editor → Run → «Run query».
begin;
truncate table public.session_votes, public.ratings, public.session_scores, public.proposals, public.sessions restart identity;
truncate table public.battle_players, public.pool_places, public.battles restart identity;
truncate table public.push_outbox restart identity;
update public.battle_stats
   set open_battles = 0, fighters = 0, resolved_total = 0, version = version + 1, updated_at = now()
 where id = 1;
commit;

-- Comprobación: todo a 0 salvo app_config, battle_stats, league, profiles y rating_categories
select string_agg(tabla || '=' || filas, ', ' order by tabla) as despues from (
  select table_name as tabla,
    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as filas
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
) t;
