-- Textos: las «sesiones» pasan a llamarse «almuerzos» (avisos y mensajes de error).
-- Solo redefine funciones (create or replace): no toca datos ni permisos. Se puede ejecutar varias veces.

-- de 02-avisos.sql
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

-- de 02-avisos.sql
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

-- de 02-avisos.sql
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

-- de 02-avisos.sql
create or replace function public.push_test()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  if not exists (select 1 from public.push_subscriptions where user_id = auth.uid()) then
    raise exception 'Este usuario no tiene avisos activados en ningún dispositivo';
  end if;
  perform public._notify(auth.uid(), '🔔 Aviso de prueba', '¡Los avisos de Almuerzos Muy Tochos funcionan!', '#/perfil', 'test');
end $$;

-- de 03-sesiones.sql
create or replace function public._advance(p_session bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions;
  w record;
begin
  select * into s from public.sessions where id = p_session for update;
  if not found then raise exception 'Ese almuerzo no existe'; end if;

  if s.phase = 'proposals' then
    if (select count(*) from public.proposals where session_id = p_session) < 2 then
      raise exception 'Hacen falta al menos 2 propuestas para pasar a votar';
    end if;
    update public.sessions set phase = 'voting', phase_changed_at = now(), version = version + 1
    where id = p_session;
    perform public._notify_all('🗳️ ¡A votar!', format('Almuerzo %s: ya están las propuestas. Elige dónde almorzamos.', s.number),
                               format('#/s/%s', p_session), 'session');
    return 'voting';

  elsif s.phase = 'voting' then
    -- Ganador: más votos; si hay empate, sorteo entre los empatados
    with counts as (
      select p.id, p.name, count(v.user_id) as n
      from public.proposals p
      left join public.session_votes v on v.proposal_id = p.id
      where p.session_id = p_session
      group by p.id, p.name
    )
    select c.id, c.name, (select count(*) from counts c2 where c2.n = c.n) as tied
    into w
    from counts c
    order by c.n desc, random()
    limit 1;

    update public.sessions set
      phase = 'rating', winner_proposal_id = w.id, winner_name = w.name,
      winner_by_draw = coalesce(w.tied, 0) > 1, phase_changed_at = now(), version = version + 1
    where id = p_session;
    perform public._notify_all(format('🏆 Ganador: %s', w.name), format('Almuerzo %s: ya sabemos dónde se almuerza.', s.number),
                               format('#/s/%s', p_session), 'session');
    return 'rating';

  elsif s.phase = 'rating' then
    -- Nota del sitio: media de la nota (ponderada por categoría) de cada persona. Queda guardada en secreto.
    insert into public.session_scores (session_id, score, raters)
    select p_session, round(avg(u.s), 2), count(*)
    from (
      select r.user_id, sum(r.score * c.weight) / sum(c.weight) as s
      from public.ratings r
      join public.rating_categories c on c.id = r.category_id
      where r.session_id = p_session
      group by r.user_id
    ) u
    on conflict (session_id) do update
      set score = excluded.score, raters = excluded.raters, computed_at = now();

    -- Se revela el anfitrión (quien propuso el sitio ganador)
    update public.sessions set
      phase = 'closed',
      host_id = (select user_id from public.proposals where id = s.winner_proposal_id),
      phase_changed_at = now(), version = version + 1
    where id = p_session;
    perform public._notify_all('🎉 Revelación', format('Descubre quién propuso %s.', s.winner_name),
                               format('#/s/%s', p_session), 'session');
    return 'closed';
  end if;

  raise exception 'Ese almuerzo ya está cerrado';
end $$;

-- de 03-sesiones.sql
create or replace function public.create_session(p_date date, p_time time default null, p_note text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare new_id bigint;
begin
  if not public.is_admin() then raise exception 'Solo el admin puede crear almuerzos'; end if;
  if p_date is null then raise exception 'Pon la fecha del almuerzo'; end if;
  if exists (select 1 from public.sessions where phase <> 'closed') then
    raise exception 'Ya hay un almuerzo en marcha. Termínalo antes de crear otro';
  end if;
  insert into public.sessions (number, lunch_date, lunch_time, note)
  values ((select coalesce(max(number), 0) + 1 from public.sessions), p_date, p_time,
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into new_id;
  perform public._notify_all(format('🍽️ Almuerzo %s', (select number from public.sessions where id = new_id)),
                             format('Será el %s. ¡Propón tu sitio desde tu pool!', to_char(p_date, 'DD/MM')),
                             format('#/s/%s', new_id), 'session');
  return new_id;
end $$;

-- de 03-sesiones.sql
create or replace function public.propose(p_session bigint, p_name text, p_note text default null, p_place_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  ph text;
  nm text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  if char_length(nm) < 2 then raise exception 'Escribe el nombre del sitio'; end if;
  if char_length(nm) > 80 then raise exception 'El nombre es demasiado largo'; end if;
  if char_length(coalesce(p_note, '')) > 200 then raise exception 'El comentario es demasiado largo'; end if;

  select phase into ph from public.sessions where id = p_session for update;
  if ph is null then raise exception 'Ese almuerzo no existe'; end if;
  if ph <> 'proposals' then raise exception 'El plazo de propuestas ya está cerrado'; end if;

  begin
    insert into public.proposals (session_id, user_id, name, note, place_id)
    values (p_session, uid, nm, nullif(btrim(coalesce(p_note, '')), ''), p_place_id)
    on conflict (session_id, user_id) do update set name = excluded.name, note = excluded.note, place_id = excluded.place_id;
  exception when unique_violation then
    raise exception 'Ese sitio ya está propuesto. Elige otro';
  end;

  perform public._auto_advance(p_session);
end $$;

-- de 03-sesiones.sql
create or replace function public.withdraw_proposal(p_session bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); ph text;
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  select phase into ph from public.sessions where id = p_session for update;
  if ph is distinct from 'proposals' then raise exception 'Ya no se pueden retirar propuestas'; end if;
  delete from public.proposals where session_id = p_session and user_id = uid;
  perform public._refresh_session(p_session);
end $$;

-- de 03-sesiones.sql
create or replace function public.cast_vote(p_session bigint, p_proposal bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); ph text; v_owner uuid;
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  select phase into ph from public.sessions where id = p_session for update;
  if ph is null then raise exception 'Ese almuerzo no existe'; end if;
  if ph <> 'voting' then raise exception 'La votación no está abierta'; end if;

  select user_id into v_owner from public.proposals where id = p_proposal and session_id = p_session;
  if not found then raise exception 'Esa propuesta no es de este almuerzo'; end if;
  if v_owner = uid then raise exception 'No puedes votar tu propia propuesta'; end if;

  insert into public.session_votes (session_id, user_id, proposal_id)
  values (p_session, uid, p_proposal)
  on conflict do nothing;
  if not found then raise exception 'Ya has votado en este almuerzo'; end if;

  perform public._auto_advance(p_session);
end $$;

-- de 03-sesiones.sql
create or replace function public.rate_session(p_session bigint, p_scores jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); ph text; c record; v int;
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  select phase into ph from public.sessions where id = p_session for update;
  if ph is null then raise exception 'Ese almuerzo no existe'; end if;
  if ph <> 'rating' then raise exception 'Ahora no se puede puntuar este almuerzo'; end if;

  for c in select id, key, label from public.rating_categories where active order by position loop
    begin
      v := (p_scores ->> c.key)::int;
    exception when others then
      v := null;
    end;
    if v is null or v < 1 or v > 10 then raise exception 'Falta puntuar: %', c.label; end if;
    insert into public.ratings (session_id, user_id, category_id, score)
    values (p_session, uid, c.id, v)
    on conflict (session_id, user_id, category_id) do update set score = excluded.score, updated_at = now();
  end loop;

  perform public._auto_advance(p_session);
end $$;

-- de 03-sesiones.sql
create or replace function public.get_session(p_session bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  s public.sessions;
  lg public.league;
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  select * into s from public.sessions where id = p_session;
  if not found then return null; end if;
  select * into lg from public.league where id = 1;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', s.id, 'number', s.number, 'lunch_date', s.lunch_date, 'lunch_time', s.lunch_time,
      'note', s.note, 'phase', s.phase, 'proposals_count', s.proposals_count,
      'votes_count', s.votes_count, 'ratings_count', s.ratings_count,
      'winner_proposal_id', s.winner_proposal_id, 'winner_name', s.winner_name,
      'winner_by_draw', s.winner_by_draw,
      'host_id', case when s.phase = 'closed' then s.host_id end,
      'phase_changed_at', s.phase_changed_at, 'version', s.version),
    'members', public._members_count(),
    -- Pool anónimo. Orden: en propuestas, alfabético; después, por votos (sin enseñar cuántos)
    'proposals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'name', x.name, 'note', x.note, 'place_id', x.place_id,
               'mine', x.user_id = uid, 'winner', coalesce(x.id = s.winner_proposal_id, false))
             order by x.first desc, x.n desc, lower(x.name))
      from (
        select p.id, p.name, p.note, p.place_id, p.user_id,
          (s.phase in ('rating', 'closed') and p.id = s.winner_proposal_id) as first,
          case when s.phase = 'proposals' then 0
               else (select count(*) from public.session_votes v where v.proposal_id = p.id) end as n
        from public.proposals p
        where p.session_id = s.id
      ) x), '[]'::jsonb),
    'my_proposal', (select jsonb_build_object('id', p.id, 'name', p.name, 'note', p.note, 'place_id', p.place_id)
                    from public.proposals p where p.session_id = s.id and p.user_id = uid),
    'my_vote', (select v.proposal_id from public.session_votes v where v.session_id = s.id and v.user_id = uid),
    'my_ratings', (select jsonb_object_agg(c.key, r.score)
                   from public.ratings r join public.rating_categories c on c.id = r.category_id
                   where r.session_id = s.id and r.user_id = uid),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('key', c.key, 'label', c.label, 'hint', c.hint, 'emoji', c.emoji)
                                             order by c.position)
                            from public.rating_categories c where c.active), '[]'::jsonb),
    'host_points', lg.host_points,
    'final_revealed', lg.final_revealed,
    'score', case when lg.final_revealed and s.phase = 'closed'
                  then (select sc.score from public.session_scores sc where sc.session_id = s.id) end
  );
end $$;

-- de 03-sesiones.sql
create or replace function public.get_league()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare lg public.league;
begin
  if auth.uid() is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  select * into lg from public.league where id = 1;
  return jsonb_build_object(
    'final_revealed', lg.final_revealed,
    'host_points', lg.host_points,
    'best_site_bonus', lg.best_site_bonus,
    'score_weight', lg.score_weight,
    'closed_count', (select count(*) from public.sessions where phase = 'closed'),
    'standings', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', pr.id, 'wins', w.wins, 'points', w.wins * lg.host_points)
                       order by w.wins desc, lower(pr.display_name))
      from public.profiles pr
      cross join lateral (select count(*)::int as wins from public.sessions s
                          where s.phase = 'closed' and s.host_id = pr.id) w), '[]'::jsonb),
    'final', case when lg.final_revealed then public._final_board() end
  );
end $$;

-- de 04-batallas.sql
create or replace function public.add_to_pool(p_name text, p_note text default null, p_place_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  nm text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  nt text := nullif(btrim(coalesce(p_note, '')), '');
  gp text := nullif(btrim(coalesce(p_place_id, '')), '');
  k text;
  b public.battles;
  holders uuid[];
  pid bigint;
  n int;
  u uuid;
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  if char_length(nm) < 2 then raise exception 'Escribe el nombre del sitio'; end if;
  if char_length(nm) > 80 then raise exception 'El nombre es demasiado largo'; end if;
  if char_length(coalesce(nt, '')) > 200 then raise exception 'El comentario es demasiado largo'; end if;
  if gp is not null and (gp !~ '^[A-Za-z0-9_-]+$' or char_length(gp) not between 10 and 300) then raise exception 'Sitio de Google Maps no válido'; end if;
  k := case when gp is not null then 'g:' || gp else public._name_key(nm) end;
  if char_length(k) < 2 then raise exception 'Escribe un nombre válido'; end if;

  perform pg_advisory_xact_lock(hashtext('pool:' || k));   -- evita carreras con el mismo sitio

  if exists (select 1 from public.pool_places where user_id = uid and name_key = k) then
    raise exception 'Ya tienes ese sitio en tu pool';
  end if;

  -- Batalla sin resolver por este sitio → te unes
  select * into b from public.battles where name_key = k and status <> 'resolved';
  if found then
    insert into public.pool_places (user_id, name, name_key, note, battle_id, place_id) values (uid, nm, k, nt, b.id, gp) returning id into pid;
    insert into public.battle_players (battle_id, user_id) values (b.id, uid);
    select count(*) into n from public.battle_players where battle_id = b.id;
    for u in select public._battle_players_except(b.id, uid) loop
      perform public._notify(u, '⚔️ Se une otro rival', format('La batalla por «%s» ahora es de %s jugadores.', b.place_name, n), '#/pool', 'battle-' || b.id);
    end loop;
    perform public._battles_changed();
    return jsonb_build_object('result', 'joined', 'battle_id', b.id, 'pool_id', pid, 'rivals', n - 1, 'place_name', b.place_name, 'status', b.status);
  end if;

  select array_agg(user_id order by created_at) into holders from public.pool_places where name_key = k;
  if holders is null then
    insert into public.pool_places (user_id, name, name_key, note, place_id) values (uid, nm, k, nt, gp) returning id into pid;
    return jsonb_build_object('result', 'added', 'pool_id', pid);
  end if;

  -- Lo tiene otro → nueva batalla; quien la provoca gira la ruleta
  insert into public.battles (name_key, place_name, place_id, challenger_id)
  values (k, (select name from public.pool_places where name_key = k order by created_at limit 1), gp, uid)
  returning * into b;
  update public.pool_places set battle_id = b.id where name_key = k;
  insert into public.pool_places (user_id, name, name_key, note, battle_id, place_id) values (uid, nm, k, nt, b.id, gp) returning id into pid;
  insert into public.battle_players (battle_id, user_id) select b.id, x from unnest(holders || uid) x;
  n := array_length(holders, 1) + 1;
  foreach u in array holders loop
    perform public._notify(u, '⚔️ ¡Te han retado!', format('Alguien más quiere «%s». Sois %s en la batalla.', b.place_name, n), '#/pool', 'battle-' || b.id);
  end loop;
  perform public._battles_changed();
  return jsonb_build_object('result', 'battle', 'battle_id', b.id, 'pool_id', pid, 'rivals', n - 1, 'place_name', b.place_name, 'status', 'spin');
end $$;

-- de 04-batallas.sql
create or replace function public.propose_place(p_session bigint, p_place bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare pl public.pool_places;
begin
  if auth.uid() is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  select * into pl from public.pool_places where id = p_place and user_id = auth.uid();
  if not found then raise exception 'Ese sitio no está en tu pool'; end if;
  if pl.battle_id is not null then raise exception 'Ese sitio está en batalla: podrás proponerlo cuando la ganes'; end if;
  perform public.propose(p_session, pl.name, pl.note, pl.place_id);
end $$;

-- de 04-batallas.sql
create or replace function public.spin_roulette(p_battle bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare b public.battles; g text; u uuid;
begin
  if auth.uid() is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  select * into b from public.battles where id = p_battle for update;
  if not found then raise exception 'La batalla no existe'; end if;
  if b.status <> 'spin' then raise exception 'La ruleta ya se ha girado'; end if;
  if b.challenger_id is distinct from auth.uid() and not public.is_admin() then
    raise exception 'Solo quien ha provocado la batalla puede girar la ruleta';
  end if;
  g := (array['bocata', 'cacaos', 'barra'])[1 + floor(random() * 3)::int];
  update public.battles set status = 'playing', game = g, seed = 1 + floor(random() * 2147483646)::int, spun_at = now()
  where id = p_battle;
  for u in select public._battle_players_except(p_battle, auth.uid()) loop
    perform public._notify(u, format('🎰 Minijuego: %s', public._game_name(g)),
                           format('¡Ya puedes jugar la batalla por «%s»!', b.place_name), '#/pool', 'battle-' || p_battle);
  end loop;
  perform public._battles_changed();
  return g;
end $$;

-- de 04-batallas.sql
create or replace function public.start_attempt(p_battle bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); b public.battles; bp public.battle_players; n int;
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
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

-- de 04-batallas.sql
create or replace function public.finish_attempt(p_battle bigint, p_score int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); b public.battles; bp public.battle_players;
  maxs int; sc int; resolved boolean;
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
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

-- de 04-batallas.sql
create or replace function public.my_battles()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  return jsonb_build_object(
    'stats', (select jsonb_build_object('open_battles', open_battles, 'fighters', fighters, 'resolved_total', resolved_total)
              from public.battle_stats where id = 1),
    'battles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'place_name', b.place_name, 'place_id', b.place_id, 'status', b.status, 'game', b.game, 'parent_id', b.parent_id,
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
