-- =====================================================================
-- Almuerzos Muy Tochos · 03 · sesiones, propuestas, votación y puntuación
-- Requiere 01-base.sql y 02-avisos.sql. Idempotente: se puede volver a ejecutar.
--
-- Secreto garantizado por el servidor:
--   · Nadie (ni leyendo la API) puede ver quién propuso cada sitio,
--     cuántos votos lleva cada uno, ni quién falta por votar o puntuar.
--   · Las tablas proposals / session_votes / ratings / session_scores
--     NO son accesibles directamente; todo pasa por funciones que solo
--     devuelven lo permitido en cada fase.
-- =====================================================================

-- ---------- LIGA: reglas de puntos y gran final ----------
create table if not exists public.league (
  id              int primary key default 1 check (id = 1),
  final_revealed  boolean not null default false,
  host_points     int not null default 10 check (host_points >= 0),       -- por proponer el sitio ganador de una sesión
  best_site_bonus int not null default 5  check (best_site_bonus >= 0),   -- extra en la final al que propuso el mejor sitio
  score_weight    numeric not null default 1 check (score_weight >= 0),   -- la nota de tus sitios ganadores suma × este peso
  updated_at      timestamptz not null default now()
);
insert into public.league (id) values (1) on conflict (id) do nothing;

-- ---------- CATEGORÍAS DE PUNTUACIÓN (editables) ----------
create table if not exists public.rating_categories (
  id       bigint generated always as identity primary key,
  key      text not null unique,
  label    text not null,
  hint     text,
  emoji    text,
  weight   numeric not null default 1 check (weight > 0),
  position int not null default 0,
  active   boolean not null default true
);
insert into public.rating_categories (key, label, hint, emoji, position) values
  ('bocadillo', 'Bocadillo',           'Sabor, pan y calidad del producto',            '🥖', 1),
  ('tochez',    'Tochez',              'Tamaño y cantidad: ¿fue muy tocho?',           '💪', 2),
  ('gasto',     'Gasto',               'Olivas, cacahuetes, altramuces, encurtidos…',  '🫒', 3),
  ('cremaet',   'Cremaet / café',      'El remate del almuerzo',                       '☕', 4),
  ('precio',    'Precio',              'Relación calidad-precio',                      '💶', 5),
  ('servicio',  'Servicio y ambiente', 'Trato, rapidez y el sitio en sí',              '🙌', 6)
on conflict (key) do nothing;

-- ---------- SESIONES ----------
create table if not exists public.sessions (
  id                 bigint generated always as identity primary key,
  number             int not null unique,
  lunch_date         date not null,
  lunch_time         time,
  note               text check (char_length(note) <= 300),
  phase              text not null default 'proposals'
                     check (phase in ('proposals', 'voting', 'rating', 'closed')),
  proposals_count    int not null default 0,
  votes_count        int not null default 0,
  ratings_count      int not null default 0,
  version            int not null default 0,          -- sube con cada cambio: dispara el tiempo real
  winner_proposal_id bigint,
  winner_name        text,
  winner_by_draw     boolean not null default false,
  host_id            uuid references public.profiles (id) on delete set null,  -- solo se rellena al cerrar
  created_at         timestamptz not null default now(),
  phase_changed_at   timestamptz not null default now()
);
-- Solo puede haber una sesión en marcha a la vez
create unique index if not exists sessions_one_active on public.sessions ((true)) where phase <> 'closed';

create table if not exists public.proposals (
  id         bigint generated always as identity primary key,
  session_id bigint not null references public.sessions (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  name       text not null check (char_length(name) between 2 and 80),
  note       text check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  unique (session_id, user_id)                                   -- una propuesta por persona y sesión
);
create unique index if not exists proposals_unique_name on public.proposals (session_id, lower(name));

create table if not exists public.session_votes (
  session_id  bigint not null references public.sessions (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  proposal_id bigint not null references public.proposals (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (session_id, user_id)                              -- un voto por persona y sesión
);
create index if not exists session_votes_proposal_idx on public.session_votes (proposal_id);

create table if not exists public.ratings (
  session_id  bigint not null references public.sessions (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  category_id bigint not null references public.rating_categories (id) on delete cascade,
  score       int not null check (score between 1 and 10),
  updated_at  timestamptz not null default now(),
  primary key (session_id, user_id, category_id)
);

create table if not exists public.session_scores (
  session_id  bigint primary key references public.sessions (id) on delete cascade,
  score       numeric(4, 2),
  raters      int not null default 0,
  computed_at timestamptz not null default now()
);

-- ---------- SEGURIDAD ----------
alter table public.league            enable row level security;
alter table public.rating_categories enable row level security;
alter table public.sessions          enable row level security;
alter table public.proposals         enable row level security;
alter table public.session_votes     enable row level security;
alter table public.ratings           enable row level security;
alter table public.session_scores    enable row level security;

revoke all on public.league, public.rating_categories, public.sessions,
              public.proposals, public.session_votes, public.ratings, public.session_scores from anon;
-- Tablas secretas: sin acceso directo para nadie
revoke all on public.proposals, public.session_votes, public.ratings, public.session_scores from authenticated;

-- Liga: todos la leen; el admin cambia reglas y revela la final
revoke insert, update, delete on public.league from authenticated;
grant  update (final_revealed, host_points, best_site_bonus, score_weight) on public.league to authenticated;
drop policy if exists "leer liga" on public.league;
create policy "leer liga" on public.league for select to authenticated using (true);
drop policy if exists "admin liga" on public.league;
create policy "admin liga" on public.league for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Categorías: todos las leen; el admin las gestiona
drop policy if exists "leer categorias" on public.rating_categories;
create policy "leer categorias" on public.rating_categories for select to authenticated using (true);
drop policy if exists "admin categorias" on public.rating_categories;
create policy "admin categorias" on public.rating_categories for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Sesiones: todos las leen (no contienen nada secreto); el admin edita fecha/nota y borra.
-- Crear y cambiar de fase solo mediante funciones.
revoke insert, update on public.sessions from authenticated;
grant  update (lunch_date, lunch_time, note) on public.sessions to authenticated;
drop policy if exists "leer sesiones" on public.sessions;
create policy "leer sesiones" on public.sessions for select to authenticated using (true);
drop policy if exists "admin edita sesiones" on public.sessions;
create policy "admin edita sesiones" on public.sessions for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "admin borra sesiones" on public.sessions;
create policy "admin borra sesiones" on public.sessions for delete to authenticated
  using ((select public.is_admin()));

-- ---------- FUNCIONES INTERNAS (no invocables desde la web) ----------
create or replace function public._members_count()
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.profiles;
$$;

create or replace function public._refresh_session(p_session bigint)
returns public.sessions language plpgsql security definer set search_path = '' as $$
declare s public.sessions;
begin
  update public.sessions set
    proposals_count = (select count(*) from public.proposals     where session_id = p_session),
    votes_count     = (select count(*) from public.session_votes where session_id = p_session),
    ratings_count   = (select count(distinct user_id) from public.ratings where session_id = p_session),
    version         = version + 1
  where id = p_session
  returning * into s;
  return s;
end $$;

-- Pasa a la siguiente fase y hace los cálculos de cada paso
create or replace function public._advance(p_session bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions;
  w record;
begin
  select * into s from public.sessions where id = p_session for update;
  if not found then raise exception 'La sesión no existe'; end if;

  if s.phase = 'proposals' then
    if (select count(*) from public.proposals where session_id = p_session) < 2 then
      raise exception 'Hacen falta al menos 2 propuestas para pasar a votar';
    end if;
    update public.sessions set phase = 'voting', phase_changed_at = now(), version = version + 1
    where id = p_session;
    perform public._notify_all('🗳️ ¡A votar!', format('Sesión %s: ya están las propuestas. Elige dónde almorzamos.', s.number),
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
    perform public._notify_all(format('🏆 Ganador: %s', w.name), format('Sesión %s: ya sabemos dónde se almuerza.', s.number),
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

  raise exception 'La sesión ya está cerrada';
end $$;

-- Recalcula contadores y avanza sola cuando ha participado todo el grupo
create or replace function public._auto_advance(p_session bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions;
  m int := public._members_count();
begin
  s := public._refresh_session(p_session);
  if (s.phase = 'proposals' and s.proposals_count >= greatest(m, 2))
     or (s.phase = 'voting' and s.votes_count >= m)
     or (s.phase = 'rating' and s.ratings_count >= m) then
    perform public._advance(p_session);
  end if;
end $$;

-- Tablero de la gran final
create or replace function public._final_board()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  lg public.league;
  best_session bigint;
  res jsonb;
begin
  select * into lg from public.league where id = 1;

  select s.id into best_session
  from public.sessions s join public.session_scores sc on sc.session_id = s.id
  where s.phase = 'closed' and sc.score is not null
  order by sc.score desc, s.lunch_date asc
  limit 1;

  with sites as (
    select s.id, s.number, s.lunch_date, s.winner_name, s.host_id, sc.score, sc.raters,
      (select jsonb_agg(jsonb_build_object('key', c.key, 'label', c.label, 'emoji', c.emoji, 'avg', round(a.avg, 1))
                        order by c.position)
       from public.rating_categories c
       cross join lateral (select avg(r.score) as avg from public.ratings r
                           where r.session_id = s.id and r.category_id = c.id) a
       where a.avg is not null) as cats
    from public.sessions s
    join public.session_scores sc on sc.session_id = s.id
    where s.phase = 'closed'
  ),
  people as (
    select pr.id as user_id,
      count(st.id)::int as wins,
      coalesce(sum(st.score), 0) as score_sum,
      coalesce(bool_or(st.id = best_session), false) as has_best
    from public.profiles pr
    left join sites st on st.host_id = pr.id
    group by pr.id
  ),
  totals as (
    select *, wins * lg.host_points as victory_points,
      round(score_sum * lg.score_weight, 2) as score_points,
      case when has_best then lg.best_site_bonus else 0 end as bonus
    from people
  )
  select jsonb_build_object(
    'best_session_id', best_session,
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'session_id', id, 'number', number, 'lunch_date', lunch_date, 'name', winner_name,
        'host_id', host_id, 'score', score, 'raters', raters, 'categories', coalesce(cats, '[]'::jsonb))
        order by score desc nulls last, lunch_date)
      from sites), '[]'::jsonb),
    'ranking', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', user_id, 'wins', wins, 'victory_points', victory_points,
        'score_points', score_points, 'bonus', bonus,
        'total', victory_points + score_points + bonus)
        order by victory_points + score_points + bonus desc, score_sum desc)
      from totals), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- ---------- FUNCIONES PÚBLICAS ----------

-- Admin: crear sesión (número automático)
create or replace function public.create_session(p_date date, p_time time default null, p_note text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare new_id bigint;
begin
  if not public.is_admin() then raise exception 'Solo el admin puede crear sesiones'; end if;
  if p_date is null then raise exception 'Pon la fecha del almuerzo'; end if;
  if exists (select 1 from public.sessions where phase <> 'closed') then
    raise exception 'Ya hay una sesión en marcha. Termínala antes de crear otra';
  end if;
  insert into public.sessions (number, lunch_date, lunch_time, note)
  values ((select coalesce(max(number), 0) + 1 from public.sessions), p_date, p_time,
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into new_id;
  perform public._notify_all(format('🍽️ Sesión %s', (select number from public.sessions where id = new_id)),
                             format('Almuerzo el %s. ¡Propón tu sitio desde tu pool!', to_char(p_date, 'DD/MM')),
                             format('#/s/%s', new_id), 'session');
  return new_id;
end $$;

-- Admin: forzar el paso a la siguiente fase (por si alguien no participa)
create or replace function public.advance_session(p_session bigint)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Solo el admin puede cambiar de fase'; end if;
  perform public._refresh_session(p_session);
  return public._advance(p_session);
end $$;

-- Proponer (o cambiar) mi sitio
create or replace function public.propose(p_session bigint, p_name text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  ph text;
  nm text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  if char_length(nm) < 2 then raise exception 'Escribe el nombre del sitio'; end if;
  if char_length(nm) > 80 then raise exception 'El nombre es demasiado largo'; end if;
  if char_length(coalesce(p_note, '')) > 200 then raise exception 'El comentario es demasiado largo'; end if;

  select phase into ph from public.sessions where id = p_session for update;
  if ph is null then raise exception 'La sesión no existe'; end if;
  if ph <> 'proposals' then raise exception 'El plazo de propuestas ya está cerrado'; end if;

  begin
    insert into public.proposals (session_id, user_id, name, note)
    values (p_session, uid, nm, nullif(btrim(coalesce(p_note, '')), ''))
    on conflict (session_id, user_id) do update set name = excluded.name, note = excluded.note;
  exception when unique_violation then
    raise exception 'Ese sitio ya está propuesto. Elige otro';
  end;

  perform public._auto_advance(p_session);
end $$;

-- Retirar mi propuesta (solo en fase de propuestas)
create or replace function public.withdraw_proposal(p_session bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); ph text;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  select phase into ph from public.sessions where id = p_session for update;
  if ph is distinct from 'proposals' then raise exception 'Ya no se pueden retirar propuestas'; end if;
  delete from public.proposals where session_id = p_session and user_id = uid;
  perform public._refresh_session(p_session);
end $$;

-- Votar (definitivo, un voto, no a la propia propuesta)
create or replace function public.cast_vote(p_session bigint, p_proposal bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); ph text; v_owner uuid;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  select phase into ph from public.sessions where id = p_session for update;
  if ph is null then raise exception 'La sesión no existe'; end if;
  if ph <> 'voting' then raise exception 'La votación no está abierta'; end if;

  select user_id into v_owner from public.proposals where id = p_proposal and session_id = p_session;
  if not found then raise exception 'Esa propuesta no es de esta sesión'; end if;
  if v_owner = uid then raise exception 'No puedes votar tu propia propuesta'; end if;

  insert into public.session_votes (session_id, user_id, proposal_id)
  values (p_session, uid, p_proposal)
  on conflict do nothing;
  if not found then raise exception 'Ya has votado en esta sesión'; end if;

  perform public._auto_advance(p_session);
end $$;

-- Puntuar el sitio ganador (se puede corregir hasta que puntúe todo el grupo)
create or replace function public.rate_session(p_session bigint, p_scores jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); ph text; c record; v int;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
  select phase into ph from public.sessions where id = p_session for update;
  if ph is null then raise exception 'La sesión no existe'; end if;
  if ph <> 'rating' then raise exception 'Ahora no se puede puntuar esta sesión'; end if;

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

-- Todo lo que un usuario puede ver de una sesión
create or replace function public.get_session(p_session bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  s public.sessions;
  lg public.league;
begin
  if uid is null then raise exception 'No has iniciado sesión'; end if;
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
               'id', x.id, 'name', x.name, 'note', x.note,
               'mine', x.user_id = uid, 'winner', coalesce(x.id = s.winner_proposal_id, false))
             order by x.first desc, x.n desc, lower(x.name))
      from (
        select p.id, p.name, p.note, p.user_id,
          (s.phase in ('rating', 'closed') and p.id = s.winner_proposal_id) as first,
          case when s.phase = 'proposals' then 0
               else (select count(*) from public.session_votes v where v.proposal_id = p.id) end as n
        from public.proposals p
        where p.session_id = s.id
      ) x), '[]'::jsonb),
    'my_proposal', (select jsonb_build_object('id', p.id, 'name', p.name, 'note', p.note)
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

-- Clasificación: puntos de victoria (siempre) y gran final (cuando el admin la revela)
create or replace function public.get_league()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare lg public.league;
begin
  if auth.uid() is null then raise exception 'No has iniciado sesión'; end if;
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

-- Aviso a todos al revelar la gran final
create or replace function public._league_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.final_revealed and not old.final_revealed then
    perform public._notify_all('🎉 ¡Gran final!', 'Ya se sabe quién gana la cena. Entra a verlo.', '#/clasificacion', 'final');
  end if;
  return new;
end $$;
drop trigger if exists league_notify on public.league;
create trigger league_notify after update on public.league for each row execute function public._league_notify();
revoke execute on function public._league_notify() from public, anon, authenticated;

-- ---------- PERMISOS DE FUNCIONES ----------
revoke execute on function public._members_count(), public._refresh_session(bigint), public._advance(bigint),
                           public._auto_advance(bigint), public._final_board()
  from public, anon, authenticated;

-- propose() queda interna: se propone desde el pool privado con propose_place() (04-batallas.sql)
revoke execute on function public.propose(bigint, text, text) from public, anon, authenticated;

revoke execute on function public.create_session(date, time, text), public.advance_session(bigint),
                           public.withdraw_proposal(bigint),
                           public.cast_vote(bigint, bigint), public.rate_session(bigint, jsonb),
                           public.get_session(bigint), public.get_league()
  from public, anon;
grant execute on function public.create_session(date, time, text), public.advance_session(bigint),
                          public.withdraw_proposal(bigint),
                          public.cast_vote(bigint, bigint), public.rate_session(bigint, jsonb),
                          public.get_session(bigint), public.get_league()
  to authenticated;

-- ---------- TIEMPO REAL (solo tablas sin secretos) ----------
do $$
declare t text;
begin
  foreach t in array array['sessions', 'league', 'rating_categories'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
