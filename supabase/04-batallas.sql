-- =====================================================================
-- Almuerzos Muy Tochos · 04 · pool privado y batallas
-- Requiere 01, 02 y 03. Idempotente.
--
--   · Cada usuario tiene su pool privado de sitios (nadie más lo ve).
--   · Si añades un sitio que ya tiene otro → batalla. Tú giras la ruleta.
--   · Si alguien más lo añade antes de que se resuelva, se une a la misma batalla.
--   · Tras resolverse, si otro lo añade, nueva batalla contra el que lo tiene.
--   · Minijuego asíncrono: 3 intentos, cuenta el mejor, misma partida (semilla) para todos.
--   · Los rivales son anónimos: solo se sabe cuántos son.
--   · Todo el grupo ve cuántas batallas hay por jugar.
-- =====================================================================

-- ---------- Nombre normalizado (sin mayúsculas, tildes ni signos) ----------
create or replace function public._name_key(p text)
returns text language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(p, '')), 'áàäâãåéèëêíìïîóòöôõúùüûñçœæ', 'aaaaaaeeeeiiiiooooouuuuncoa'),
    '[^a-z0-9]+', ' ', 'g'));
$$;

create or replace function public._game_name(g text)
returns text language sql immutable set search_path = '' as $$
  select case g when 'bocata' then 'Bocata tocho' when 'oliva' then 'Hueso de oliva'
                when 'cacaos' then 'Los cacaos del gasto' when 'barra' then 'Corta la barra' else g end;
$$;

-- ---------- Tablas ----------
create table if not exists public.battles (
  id            bigint generated always as identity primary key,
  name_key      text not null,
  place_name    text not null,
  status        text not null default 'spin' check (status in ('spin', 'playing', 'resolved')),
  game          text check (game in ('bocata', 'oliva', 'cacaos', 'barra')),
  seed          int,
  challenger_id uuid references public.profiles (id) on delete set null,   -- quien la provocó (gira la ruleta)
  parent_id     bigint references public.battles (id) on delete set null,  -- revancha de…
  winner_id     uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  spun_at       timestamptz,
  resolved_at   timestamptz
);
-- Una sola batalla abierta por sitio
create unique index if not exists battles_one_open on public.battles (name_key) where status <> 'resolved';

create table if not exists public.pool_places (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  name       text not null check (char_length(name) between 2 and 80),
  name_key   text not null,
  note       text check (char_length(note) <= 200),
  battle_id  bigint references public.battles (id) on delete set null,   -- en disputa mientras no sea null
  created_at timestamptz not null default now(),
  unique (user_id, name_key)
);
create index if not exists pool_places_key_idx on public.pool_places (name_key);

create table if not exists public.battle_players (
  battle_id          bigint not null references public.battles (id) on delete cascade,
  user_id            uuid not null references public.profiles (id) on delete cascade,
  joined_at          timestamptz not null default now(),
  attempts           int not null default 0,
  scores             int[] not null default '{}',
  open_attempt       boolean not null default false,
  attempt_started_at timestamptz,
  finished           boolean not null default false,
  result             text check (result in ('win', 'lose', 'rematch')),
  primary key (battle_id, user_id)
);
create index if not exists battle_players_user_idx on public.battle_players (user_id);

-- Contador público para el salseo (y señal de tiempo real)
create table if not exists public.battle_stats (
  id             int primary key default 1 check (id = 1),
  open_battles   int not null default 0,
  fighters       int not null default 0,
  resolved_total int not null default 0,
  version        int not null default 0,
  updated_at     timestamptz not null default now()
);
insert into public.battle_stats (id) values (1) on conflict (id) do nothing;

-- ---------- Seguridad ----------
alter table public.battles        enable row level security;
alter table public.pool_places    enable row level security;
alter table public.battle_players enable row level security;
alter table public.battle_stats   enable row level security;
revoke all on public.battles, public.pool_places, public.battle_players from anon, authenticated;
revoke all on public.battle_stats from anon;
revoke insert, update, delete on public.battle_stats from authenticated;
drop policy if exists "leer salseo" on public.battle_stats;
create policy "leer salseo" on public.battle_stats for select to authenticated using (true);

-- ---------- Internas ----------
create or replace function public._battles_changed()
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.battle_stats set
    open_battles   = (select count(*) from public.battles where status <> 'resolved'),
    fighters       = (select count(*) from public.battle_players bp join public.battles b on b.id = bp.battle_id
                      where b.status <> 'resolved'),
    resolved_total = (select count(*) from public.battles where status = 'resolved'),
    version = version + 1, updated_at = now()
  where id = 1;
end $$;

create or replace function public._battle_players_except(p_battle bigint, p_user uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select user_id from public.battle_players where battle_id = p_battle and user_id is distinct from p_user;
$$;

-- Decide la batalla cuando todos han terminado (o el admin la fuerza)
create or replace function public._resolve(p_battle bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b public.battles;
  tied uuid[];
  top int[];
  winner uuid;
  nb bigint;
  u uuid;
  r record;
begin
  select * into b from public.battles where id = p_battle for update;
  if not found or b.status = 'resolved' then return; end if;

  -- Intentos abandonados cuentan 0
  update public.battle_players
     set scores = case when open_attempt then scores || 0 else scores end,
         open_attempt = false, finished = true
   where battle_id = p_battle;

  if not exists (select 1 from public.battle_players where battle_id = p_battle) then
    update public.battles set status = 'resolved', resolved_at = now() where id = p_battle;
    perform public._battles_changed();
    return;
  end if;

  -- Mejor intento; desempate: segundo mejor, luego tercero
  select array_agg(q.user_id), max(q.best) into tied, top
  from (
    select s.user_id, s.sorted as best, max(s.sorted) over () as top
    from (
      select bp.user_id,
             (select array_agg(y order by y desc)
                from (select x as y from unnest(bp.scores || array[0, 0, 0]) x order by x desc limit 3) t) as sorted
      from public.battle_players bp where bp.battle_id = p_battle
    ) s
  ) q
  where q.best = q.top;

  if array_length(tied, 1) = 1 then
    winner := tied[1];
  elsif top = array[0, 0, 0] then
    -- Nadie ha puntuado: se lo queda quien lo tenía primero
    select pp.user_id into winner from public.pool_places pp
    where pp.battle_id = p_battle and pp.user_id = any(tied) order by pp.created_at limit 1;
    winner := coalesce(winner, tied[1]);
  else
    -- Empate total → revancha entre los empatados (mismo juego, partida nueva)
    update public.battles set status = 'resolved', resolved_at = now() where id = p_battle;
    update public.battle_players set result = case when user_id = any(tied) then 'rematch' else 'lose' end
     where battle_id = p_battle;
    for r in select user_id from public.battle_players where battle_id = p_battle and not (user_id = any(tied)) loop
      perform public._notify(r.user_id, format('💥 Has perdido «%s»', b.place_name), 'Otro jugador se lo queda.', '#/pool', 'battle-' || p_battle);
    end loop;
    delete from public.pool_places where battle_id = p_battle and not (user_id = any(tied));
    insert into public.battles (name_key, place_name, status, game, seed, challenger_id, parent_id, spun_at)
    values (b.name_key, b.place_name, 'playing', b.game, 1 + floor(random() * 2147483646)::int, b.challenger_id, p_battle, now())
    returning id into nb;
    update public.pool_places set battle_id = nb where battle_id = p_battle;
    insert into public.battle_players (battle_id, user_id) select nb, x from unnest(tied) x;
    foreach u in array tied loop
      perform public._notify(u, '🤝 ¡Empate! Hay revancha', format('Revancha por «%s»: mismo juego, partida nueva.', b.place_name), '#/pool', 'battle-' || nb);
    end loop;
    perform public._battles_changed();
    return;
  end if;

  update public.battles set status = 'resolved', resolved_at = now(), winner_id = winner where id = p_battle;
  update public.battle_players set result = case when user_id = winner then 'win' else 'lose' end where battle_id = p_battle;
  update public.pool_places set battle_id = null, name = b.place_name where battle_id = p_battle and user_id = winner;
  delete from public.pool_places where battle_id = p_battle;   -- los perdedores lo pierden
  for r in select user_id from public.battle_players where battle_id = p_battle loop
    if r.user_id = winner then
      perform public._notify(r.user_id, format('🏆 ¡Has ganado «%s»!', b.place_name), 'El sitio es tuyo. Ya puedes proponerlo.', '#/pool', 'battle-' || p_battle);
    else
      perform public._notify(r.user_id, format('💥 Has perdido «%s»', b.place_name), 'Otro jugador se lo queda.', '#/pool', 'battle-' || p_battle);
    end if;
  end loop;
  perform public._battles_changed();
end $$;

create or replace function public._try_resolve(p_battle bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.battles where id = p_battle and status = 'playing')
     and not exists (select 1 from public.battle_players where battle_id = p_battle and not finished) then
    perform public._resolve(p_battle);
    return true;
  end if;
  return false;
end $$;

-- ---------- Pool privado ----------
create or replace function public.add_to_pool(p_name text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  nm text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  nt text := nullif(btrim(coalesce(p_note, '')), '');
  k text;
  b public.battles;
  holders uuid[];
  pid bigint;
  n int;
  u uuid;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if char_length(nm) < 2 then raise exception 'Escribe el nombre del sitio'; end if;
  if char_length(nm) > 80 then raise exception 'El nombre es demasiado largo'; end if;
  if char_length(coalesce(nt, '')) > 200 then raise exception 'El comentario es demasiado largo'; end if;
  k := public._name_key(nm);
  if char_length(k) < 2 then raise exception 'Escribe un nombre válido'; end if;

  perform pg_advisory_xact_lock(hashtext('pool:' || k));   -- evita carreras con el mismo sitio

  if exists (select 1 from public.pool_places where user_id = uid and name_key = k) then
    raise exception 'Ya tienes ese sitio en tu pool';
  end if;

  -- Batalla sin resolver por este sitio → te unes
  select * into b from public.battles where name_key = k and status <> 'resolved';
  if found then
    insert into public.pool_places (user_id, name, name_key, note, battle_id) values (uid, nm, k, nt, b.id) returning id into pid;
    insert into public.battle_players (battle_id, user_id) values (b.id, uid);
    select count(*) into n from public.battle_players where battle_id = b.id;
    for u in select public._battle_players_except(b.id, uid) loop
      perform public._notify(u, '⚔️ Se une otro rival', format('La batalla por «%s» ahora es de %s jugadores.', b.place_name, n), '#/pool', 'battle-' || b.id);
    end loop;
    perform public._battles_changed();
    return jsonb_build_object('result', 'joined', 'battle_id', b.id, 'place_id', pid, 'rivals', n - 1, 'place_name', b.place_name, 'status', b.status);
  end if;

  select array_agg(user_id order by created_at) into holders from public.pool_places where name_key = k;
  if holders is null then
    insert into public.pool_places (user_id, name, name_key, note) values (uid, nm, k, nt) returning id into pid;
    return jsonb_build_object('result', 'added', 'place_id', pid);
  end if;

  -- Lo tiene otro → nueva batalla; quien la provoca gira la ruleta
  insert into public.battles (name_key, place_name, challenger_id)
  values (k, (select name from public.pool_places where name_key = k order by created_at limit 1), uid)
  returning * into b;
  update public.pool_places set battle_id = b.id where name_key = k;
  insert into public.pool_places (user_id, name, name_key, note, battle_id) values (uid, nm, k, nt, b.id) returning id into pid;
  insert into public.battle_players (battle_id, user_id) select b.id, x from unnest(holders || uid) x;
  n := array_length(holders, 1) + 1;
  foreach u in array holders loop
    perform public._notify(u, '⚔️ ¡Te han retado!', format('Alguien más quiere «%s». Sois %s en la batalla.', b.place_name, n), '#/pool', 'battle-' || b.id);
  end loop;
  perform public._battles_changed();
  return jsonb_build_object('result', 'battle', 'battle_id', b.id, 'place_id', pid, 'rivals', n - 1, 'place_name', b.place_name, 'status', 'spin');
end $$;

create or replace function public.remove_from_pool(p_place bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.pool_places where id = p_place and user_id = auth.uid() and battle_id is null;
  if not found then raise exception 'No se puede quitar: está en batalla o no es tuyo'; end if;
end $$;

create or replace function public.my_pool()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', pp.id, 'name', pp.name, 'note', pp.note, 'battle_id', pp.battle_id,
           'proposed', exists (select 1 from public.proposals pr join public.sessions s on s.id = pr.session_id
                               where s.phase <> 'closed' and pr.user_id = pp.user_id
                                 and public._name_key(pr.name) = pp.name_key))
         order by lower(pp.name)), '[]'::jsonb)
  from public.pool_places pp where pp.user_id = auth.uid();
$$;

-- Proponer en la sesión un sitio de mi pool
create or replace function public.propose_place(p_session bigint, p_place bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare pl public.pool_places;
begin
  if auth.uid() is null then raise exception 'No has iniciado sesión'; end if;
  select * into pl from public.pool_places where id = p_place and user_id = auth.uid();
  if not found then raise exception 'Ese sitio no está en tu pool'; end if;
  if pl.battle_id is not null then raise exception 'Ese sitio está en batalla: podrás proponerlo cuando la ganes'; end if;
  perform public.propose(p_session, pl.name, pl.note);
end $$;

-- ---------- Batallas ----------
create or replace function public.spin_roulette(p_battle bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare b public.battles; g text; u uuid;
begin
  if auth.uid() is null then raise exception 'No has iniciado sesión'; end if;
  select * into b from public.battles where id = p_battle for update;
  if not found then raise exception 'La batalla no existe'; end if;
  if b.status <> 'spin' then raise exception 'La ruleta ya se ha girado'; end if;
  if b.challenger_id is distinct from auth.uid() and not public.is_admin() then
    raise exception 'Solo quien ha provocado la batalla puede girar la ruleta';
  end if;
  g := (array['bocata', 'oliva', 'cacaos', 'barra'])[1 + floor(random() * 4)::int];
  update public.battles set status = 'playing', game = g, seed = 1 + floor(random() * 2147483646)::int, spun_at = now()
  where id = p_battle;
  for u in select public._battle_players_except(p_battle, auth.uid()) loop
    perform public._notify(u, format('🎰 Minijuego: %s', public._game_name(g)),
                           format('¡Ya puedes jugar la batalla por «%s»!', b.place_name), '#/pool', 'battle-' || p_battle);
  end loop;
  perform public._battles_changed();
  return g;
end $$;

create or replace function public.start_attempt(p_battle bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); b public.battles; bp public.battle_players; n int;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  select * into b from public.battles where id = p_battle for update;
  if not found or b.status <> 'playing' then raise exception 'Esta batalla no está en juego'; end if;
  select * into bp from public.battle_players where battle_id = p_battle and user_id = uid for update;
  if not found then raise exception 'No participas en esta batalla'; end if;
  if bp.finished then raise exception 'Ya has terminado tus intentos'; end if;

  if bp.open_attempt then   -- intento abandonado (cerraste la app): cuenta 0
    update public.battle_players set scores = scores || 0, open_attempt = false
    where battle_id = p_battle and user_id = uid returning * into bp;
  end if;
  if bp.attempts >= 3 then
    update public.battle_players set finished = true where battle_id = p_battle and user_id = uid;
    perform public._try_resolve(p_battle);
    perform public._battles_changed();
    return jsonb_build_object('ok', false, 'reason', 'Ya no te quedan intentos');
  end if;

  update public.battle_players set attempts = attempts + 1, open_attempt = true, attempt_started_at = now()
  where battle_id = p_battle and user_id = uid returning attempts into n;
  return jsonb_build_object('ok', true, 'game', b.game, 'seed', b.seed, 'attempt', n);
end $$;

create or replace function public.finish_attempt(p_battle bigint, p_score int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); b public.battles; bp public.battle_players;
  maxs int; sc int; resolved boolean;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  select * into b from public.battles where id = p_battle for update;
  if not found then raise exception 'La batalla no existe'; end if;
  if b.status <> 'playing' then return jsonb_build_object('ok', false, 'reason', 'La batalla ya se ha resuelto'); end if;
  select * into bp from public.battle_players where battle_id = p_battle and user_id = uid for update;
  if not found or not bp.open_attempt then raise exception 'No tienes ningún intento en marcha'; end if;

  -- Controles anti-trampa básicos
  maxs := case b.game when 'bocata' then 12000 when 'oliva' then 500 else 600 end;
  sc := greatest(0, least(coalesce(p_score, 0), maxs));
  if now() - bp.attempt_started_at < interval '3 seconds' or now() - bp.attempt_started_at > interval '30 minutes' then
    sc := 0;
  end if;

  update public.battle_players set scores = scores || sc, open_attempt = false, finished = (attempts >= 3)
  where battle_id = p_battle and user_id = uid returning * into bp;
  resolved := public._try_resolve(p_battle);
  perform public._battles_changed();
  return jsonb_build_object('ok', true, 'score', sc, 'best', (select max(x) from unnest(bp.scores) x),
                            'attempts_left', 3 - bp.attempts, 'finished', bp.finished, 'resolved', resolved);
end $$;

-- "Me planto": me quedo con mi mejor intento sin gastar los que me quedan
create or replace function public.stop_playing(p_battle bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare bp public.battle_players;
begin
  select * into bp from public.battle_players where battle_id = p_battle and user_id = auth.uid() for update;
  if not found then raise exception 'No participas en esta batalla'; end if;
  if bp.attempts < 1 or bp.open_attempt then raise exception 'Juega al menos un intento completo'; end if;
  update public.battle_players set finished = true where battle_id = p_battle and user_id = auth.uid();
  perform public._try_resolve(p_battle);
  perform public._battles_changed();
end $$;

-- Rendirse: pierdes el sitio y sales de la batalla
create or replace function public.forfeit_battle(p_battle bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); b public.battles; remaining int; u uuid;
begin
  select * into b from public.battles where id = p_battle for update;
  if not found or b.status = 'resolved' then raise exception 'Esta batalla ya ha terminado'; end if;
  delete from public.battle_players where battle_id = p_battle and user_id = uid;
  if not found then raise exception 'No participas en esta batalla'; end if;
  delete from public.pool_places where battle_id = p_battle and user_id = uid;
  select count(*) into remaining from public.battle_players where battle_id = p_battle;

  for u in select public._battle_players_except(p_battle, uid) loop
    perform public._notify(u, '🏳️ Un rival se ha rendido', format('Batalla por «%s»: quedáis %s.', b.place_name, remaining), '#/pool', 'battle-' || p_battle);
  end loop;

  if remaining <= 1 then
    -- Queda uno (o nadie): se resuelve ya
    update public.battles set status = 'playing' where id = p_battle and status = 'spin';
    perform public._resolve(p_battle);
  elsif b.status = 'spin' and b.challenger_id = uid then
    -- La ruleta pasa al último que se unió
    update public.battles set challenger_id = (select user_id from public.battle_players where battle_id = p_battle
                                               order by joined_at desc limit 1)
    where id = p_battle;
  else
    perform public._try_resolve(p_battle);
  end if;
  perform public._battles_changed();
end $$;

-- Admin: desatascar una batalla (gira la ruleta o la resuelve con lo jugado)
create or replace function public.admin_force_battle(p_battle bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  if not public.is_admin() then raise exception 'Solo el admin'; end if;
  select status into st from public.battles where id = p_battle;
  if st = 'spin' then return public.spin_roulette(p_battle); end if;
  if st = 'playing' then perform public._resolve(p_battle); return 'resolved'; end if;
  raise exception 'Esta batalla ya ha terminado';
end $$;

-- Lo que ve cada usuario de sus batallas (rivales anónimos)
create or replace function public.my_battles()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  return jsonb_build_object(
    'stats', (select jsonb_build_object('open_battles', open_battles, 'fighters', fighters, 'resolved_total', resolved_total)
              from public.battle_stats where id = 1),
    'battles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'place_name', b.place_name, 'status', b.status, 'game', b.game, 'parent_id', b.parent_id,
        'created_at', b.created_at, 'resolved_at', b.resolved_at,
        'challenger', b.challenger_id = uid,
        'players', (select count(*) from public.battle_players x where x.battle_id = b.id),
        'rivals_done', (select count(*) from public.battle_players x where x.battle_id = b.id and x.user_id <> uid and x.finished),
        'attempts', me.attempts, 'scores', to_jsonb(me.scores), 'open_attempt', me.open_attempt,
        'best', (select max(v) from unnest(me.scores) v), 'finished', me.finished, 'result', me.result,
        'board', case when b.status = 'resolved' then (
          select jsonb_agg(jsonb_build_object('best', t.best, 'me', t.user_id = uid, 'win', t.result = 'win')
                           order by t.best desc nulls last)
          from (select x.user_id, x.result, (select max(v) from unnest(x.scores) v) as best
                from public.battle_players x where x.battle_id = b.id) t) end)
        order by (b.status <> 'resolved') desc, coalesce(b.resolved_at, b.created_at) desc)
      from public.battles b
      join public.battle_players me on me.battle_id = b.id and me.user_id = uid
      where b.status <> 'resolved' or b.resolved_at > now() - interval '14 days'), '[]'::jsonb),
    'admin', case when public.is_admin() then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'status', b.status, 'game', b.game, 'created_at', b.created_at,
        'players', (select count(*) from public.battle_players x where x.battle_id = b.id),
        'done', (select count(*) from public.battle_players x where x.battle_id = b.id and x.finished))
        order by b.created_at)
      from public.battles b where b.status <> 'resolved'), '[]'::jsonb) end
  );
end $$;

-- ---------- Permisos ----------
revoke execute on function public._battles_changed(), public._battle_players_except(bigint, uuid),
                           public._resolve(bigint), public._try_resolve(bigint)
  from public, anon, authenticated;
revoke execute on function public.add_to_pool(text, text), public.remove_from_pool(bigint), public.my_pool(),
                           public.propose_place(bigint, bigint), public.spin_roulette(bigint),
                           public.start_attempt(bigint), public.finish_attempt(bigint, int),
                           public.stop_playing(bigint), public.forfeit_battle(bigint),
                           public.admin_force_battle(bigint), public.my_battles()
  from public, anon;
grant execute on function public.add_to_pool(text, text), public.remove_from_pool(bigint), public.my_pool(),
                          public.propose_place(bigint, bigint), public.spin_roulette(bigint),
                          public.start_attempt(bigint), public.finish_attempt(bigint, int),
                          public.stop_playing(bigint), public.forfeit_battle(bigint),
                          public.admin_force_battle(bigint), public.my_battles()
  to authenticated;

-- ---------- Tiempo real (solo el contador público) ----------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'battle_stats') then
    alter publication supabase_realtime add table public.battle_stats;
  end if;
end $$;
