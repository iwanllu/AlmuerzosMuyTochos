-- OPCIONAL: borra las tablas de la primera versión (votaciones sueltas), que la web ya no usa.
-- Borra también los datos que tuvieran. No se puede deshacer.
drop function if exists public.create_poll(text, text, text, text[]);
drop table if exists public.votes, public.poll_options, public.polls cascade;
drop function if exists public.validate_vote(), public.touch_poll();
