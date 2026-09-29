-- Fecha del almuerzo elegida entre todos, en paralelo a las propuestas de sitio.
-- Calendario de fines de semana: cada uno marca los sábados/domingos que puede («seguro» o «si hace falta»)
-- o «ninguna me va bien». Cuando han respondido todos se fija sola la fecha con más gente
-- (empate: más «seguro»; después, la más cercana). El admin puede fijarla antes.
-- Idempotente. No borra datos.

alter table public.sessions alter column lunch_date drop not null;

create table if not exists public.date_answers (
  session_id bigint  not null references public.sessions (id) on delete cascade,
  user_id    uuid    not null references public.profiles (id) on delete cascade,
  no_dates   boolean not null default false,              -- «ninguna fecha me va bien»
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create table if not exists public.date_choices (
  session_id bigint   not null references public.sessions (id) on delete cascade,
  user_id    uuid     not null references public.profiles (id) on delete cascade,
  day        date     not null,
  level      smallint not null check (level in (1, 2)),   -- 2 = seguro · 1 = si hace falta
  primary key (session_id, user_id, day)
);
-- Sin acceso directo: solo mediante las funciones de abajo
alter table public.date_answers enable row level security;
alter table public.date_choices enable row level security;
revoke all on public.date_answers, public.date_choices from anon, authenticated;

-- ---------- Internas ----------
create or replace function public._best_date(p_session bigint)
returns date language sql stable security definer set search_path = '' as $$
  select c.day from public.date_choices c
  where c.session_id = p_session and c.day >= current_date
  group by c.day
  order by count(*) desc, count(*) filter (where c.level = 2) desc, c.day asc
  limit 1;
$$;

create or replace function public._weekday_es(p_day date)
returns text language sql immutable set search_path = '' as $$
  select (array['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'])[extract(isodow from p_day)::int];
$$;

create or replace function public._fix_date(p_session bigint, p_day date)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.sessions;
begin
  if p_day is null then return; end if;
  update public.sessions set lunch_date = p_day, version = version + 1
  where id = p_session and lunch_date is null
  returning * into s;
  if not found then return; end if;
  perform public._notify_all('📅 ¡Ya hay fecha!',
    format('Almuerzo %s: será el %s %s.', s.number, public._weekday_es(p_day), to_char(p_day, 'DD/MM')),
    format('#/s/%s', p_session), 'session');
end $$;

create or replace function public._date_poll(p_session bigint, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', c.day, 'yes', c.yes, 'maybe', c.maybe) order by c.day)
      from (select day, count(*) filter (where level = 2) as yes, count(*) filter (where level = 1) as maybe
            from public.date_choices where session_id = p_session and day >= current_date group by day) c), '[]'::jsonb),
    'mine', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'level', level) order by day)
      from public.date_choices where session_id = p_session and user_id = p_user), '[]'::jsonb),
    'answered', exists (select 1 from public.date_answers where session_id = p_session and user_id = p_user),
    'my_none', coalesce((select a.no_dates from public.date_answers a where a.session_id = p_session and a.user_id = p_user), false),
    'missing', coalesce((
      select jsonb_agg(pr.id order by lower(pr.display_name)) from public.profiles pr
      where not exists (select 1 from public.date_answers a where a.session_id = p_session and a.user_id = pr.id)), '[]'::jsonb),
    'none_count', (select count(*) from public.date_answers where session_id = p_session and no_dates),
    'best', public._best_date(p_session)
  );
$$;

create or replace function public._date_poll_check(p_session bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select lunch_date from public.sessions where id = p_session) is not null then return; end if;
  if (select count(*) from public.date_answers where session_id = p_session) >= public._members_count() then
    perform public._fix_date(p_session, public._best_date(p_session));
  end if;
end $$;

-- ---------- Públicas ----------
-- Guarda mis fechas (sustituye las anteriores). p_days = [{"day": "2026-10-10", "level": 2}, …]
create or replace function public.save_dates(p_session bigint, p_days jsonb, p_none boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  s public.sessions;
  x jsonb;
  d date;
  lv int;
  n int := jsonb_array_length(coalesce(p_days, '[]'::jsonb));
begin
  if uid is null then raise exception 'Tienes que entrar con tu usuario'; end if;
  select * into s from public.sessions where id = p_session for update;
  if not found then raise exception 'Ese almuerzo no existe'; end if;
  if s.phase = 'closed' then raise exception 'Este almuerzo ya está cerrado'; end if;
  if s.lunch_date is not null then raise exception 'La fecha de este almuerzo ya está decidida'; end if;
  if coalesce(p_none, false) and n > 0 then raise exception 'Elige fechas o marca que no te va ninguna, no las dos cosas'; end if;
  if not coalesce(p_none, false) and n = 0 then raise exception 'Elige al menos una fecha'; end if;
  if n > 40 then raise exception 'Demasiadas fechas'; end if;

  delete from public.date_choices where session_id = p_session and user_id = uid;
  for x in select * from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) loop
    begin
      d := (x ->> 'day')::date;
      lv := coalesce((x ->> 'level')::int, 2);
    exception when others then
      raise exception 'Fecha no válida';
    end;
    if d is null or extract(isodow from d) not in (6, 7) then raise exception 'Solo se pueden elegir sábados y domingos'; end if;
    if d < current_date or d > current_date + 130 then raise exception 'Esa fecha queda fuera del calendario'; end if;
    if lv not in (1, 2) then raise exception 'Disponibilidad no válida'; end if;
    insert into public.date_choices (session_id, user_id, day, level) values (p_session, uid, d, lv)
    on conflict (session_id, user_id, day) do update set level = excluded.level;
  end loop;

  insert into public.date_answers (session_id, user_id, no_dates, updated_at)
  values (p_session, uid, coalesce(p_none, false), now())
  on conflict (session_id, user_id) do update set no_dates = excluded.no_dates, updated_at = now();

  update public.sessions set version = version + 1 where id = p_session;   -- refresca a todos en directo
  perform public._date_poll_check(p_session);
end $$;

-- El admin fija la fecha cuando quiera
create or replace function public.fix_date(p_session bigint, p_day date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Solo el admin puede fijar la fecha'; end if;
  if p_day is null then raise exception 'Elige una fecha'; end if;
  if (select lunch_date from public.sessions where id = p_session) is not null then
    raise exception 'La fecha de este almuerzo ya está decidida';
  end if;
  perform public._fix_date(p_session, p_day);
end $$;

revoke execute on function public._best_date(bigint), public._fix_date(bigint, date), public._date_poll(bigint, uuid),
                           public._date_poll_check(bigint), public._weekday_es(date)
  from public, anon, authenticated;
revoke execute on function public.save_dates(bigint, jsonb, boolean), public.fix_date(bigint, date) from public, anon;
grant execute on function public.save_dates(bigint, jsonb, boolean), public.fix_date(bigint, date) to authenticated;


-- ---------- Funciones existentes actualizadas ----------

-- _advance
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
    -- Si la fecha sigue sin decidir, se fija ya la que más gente puede
    if s.lunch_date is null then
      perform public._fix_date(p_session, public._best_date(p_session));
    end if;
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

-- create_session
create or replace function public.create_session(p_date date, p_time time default null, p_note text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare new_id bigint;
begin
  if not public.is_admin() then raise exception 'Solo el admin puede crear almuerzos'; end if;
  if p_date is not null and p_date < current_date then raise exception 'Esa fecha ya ha pasado'; end if;
  if exists (select 1 from public.sessions where phase <> 'closed') then
    raise exception 'Ya hay un almuerzo en marcha. Termínalo antes de crear otro';
  end if;
  insert into public.sessions (number, lunch_date, lunch_time, note)
  values ((select coalesce(max(number), 0) + 1 from public.sessions), p_date, p_time,
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into new_id;
  perform public._notify_all(format('🍽️ Almuerzo %s', (select number from public.sessions where id = new_id)),
                             case when p_date is null then 'Proponed sitio y marcad en el calendario qué días podéis.'
                                  else format('Será el %s. ¡Propón tu sitio desde tu pool!', to_char(p_date, 'DD/MM')) end,
                             format('#/s/%s', new_id), 'session');
  return new_id;
end $$;

-- get_session
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
    'date_poll', case when s.lunch_date is null and s.phase <> 'closed' then public._date_poll(s.id, uid) end,
    'host_points', lg.host_points,
    'final_revealed', lg.final_revealed,
    'score', case when lg.final_revealed and s.phase = 'closed'
                  then (select sc.score from public.session_scores sc where sc.session_id = s.id) end
  );
end $$;

-- _pending_count
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
