-- Límite de la fecha: como mucho un mes después del último almuerzo celebrado.
-- Para el primer almuerzo se toma como «anterior» el 27/09/2026 (límite: 27/10/2026).
-- Solo redefine funciones de 07-fechas.sql. No borra datos. Se puede ejecutar varias veces.

create or replace function public._date_window_end()
returns date language sql stable security definer set search_path = '' as $$
  select (coalesce((select max(lunch_date) from public.sessions where phase = 'closed' and lunch_date is not null),
                   date '2026-09-27') + interval '1 month')::date;
$$;

create or replace function public._best_date(p_session bigint)
returns date language sql stable security definer set search_path = '' as $$
  select c.day from public.date_choices c
  where c.session_id = p_session and c.day >= current_date and c.day <= public._date_window_end()
  group by c.day
  order by count(*) desc, count(*) filter (where c.level = 2) desc, c.day asc
  limit 1;
$$;

create or replace function public._date_poll(p_session bigint, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', c.day, 'yes', c.yes, 'maybe', c.maybe) order by c.day)
      from (select day, count(*) filter (where level = 2) as yes, count(*) filter (where level = 1) as maybe
            from public.date_choices
            where session_id = p_session and day >= current_date and day <= public._date_window_end()
            group by day) c), '[]'::jsonb),
    'mine', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'level', level) order by day)
      from public.date_choices where session_id = p_session and user_id = p_user), '[]'::jsonb),
    'answered', exists (select 1 from public.date_answers where session_id = p_session and user_id = p_user),
    'my_none', coalesce((select a.no_dates from public.date_answers a where a.session_id = p_session and a.user_id = p_user), false),
    'missing', coalesce((
      select jsonb_agg(pr.id order by lower(pr.display_name)) from public.profiles pr
      where not exists (select 1 from public.date_answers a where a.session_id = p_session and a.user_id = pr.id)), '[]'::jsonb),
    'none_count', (select count(*) from public.date_answers where session_id = p_session and no_dates),
    'best', public._best_date(p_session),
    'max_day', public._date_window_end(),
    'prev_day', (public._date_window_end() - interval '1 month')::date
  );
$$;

create or replace function public.save_dates(p_session bigint, p_days jsonb, p_none boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  s public.sessions;
  x jsonb;
  d date;
  lv int;
  n int := jsonb_array_length(coalesce(p_days, '[]'::jsonb));
  lim date := public._date_window_end();
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
    if d < current_date then raise exception 'Esa fecha ya ha pasado'; end if;
    if d > lim then
      raise exception 'Demasiado tiempo sin volver a almorzar con tus panas: como mucho hasta el %', to_char(lim, 'DD/MM');
    end if;
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

revoke execute on function public._date_window_end() from public, anon, authenticated;
