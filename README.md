# Almuerzos Muy Tochos

App de votaciones para el grupo → **https://iwanllu.github.io/AlmuerzosMuyTochos/**

Web estática (HTML + JS, sin build) sobre Supabase (proyecto `almuerzos`, Central EU · Frankfurt).

## Qué hace
- Login con usuario y contraseña (se escribe `ana`; por dentro es `ana@almuerzosmuytochos.app`). La sesión se queda guardada en el móvil.
- Perfil con nombre y foto.
- Votaciones de dos tipos: **elegir opción** o **puntuar del 1 al 10**. Un voto por persona (se puede cambiar mientras está abierta). Resultados en directo.
- Solo el admin crea, cierra/reabre y borra votaciones.

## Tareas de admin (Supabase → SQL Editor / Authentication)
| Tarea | Cómo |
|---|---|
| Añadir un amigo | Authentication → Users → Add user → Create new user → `nombre@almuerzosmuytochos.app`, contraseña, **Auto Confirm User** marcado |
| Resetear contraseña | `supabase/reset-password.sql` (cambia usuario y clave) |
| Hacer admin a alguien | `supabase/make-admin.sql` |
| Quitar a un amigo | Authentication → Users → ⋯ → Delete user (se borran también sus votos) |

Los registros públicos están desactivados: solo existen los usuarios que crea el admin.

## Seguridad
- Todas las tablas tienen RLS (`supabase/schema.sql`). La web usa solo la *publishable key*; nunca pongas la secret/service_role en el código.
- Cada usuario solo puede editar su nombre y su foto, y solo votar por sí mismo.
- Los votos son visibles para todo el grupo (así se ven los resultados en directo).

## Archivos
- `index.html`, `styles.css`, `app.js` — la web
- `config.js` — URL del proyecto y publishable key
- `supabase/schema.sql` — tablas, políticas RLS, storage de fotos y tiempo real (idempotente)
