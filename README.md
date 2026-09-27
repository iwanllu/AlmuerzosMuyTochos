# Almuerzos Muy Tochos

App de votaciones para el grupo → **https://iwanllu.github.io/AlmuerzosMuyTochos/**

Web estática (HTML + JS, sin build) sobre Supabase (proyecto `almuerzos`, Central EU · Frankfurt).

## Cómo funciona
Un almuerzo al mes = una **sesión**. Cada sesión pasa por 4 fases (avanzan solas cuando ha participado todo el grupo; el admin puede forzarlas):

1. **Propuestas** — cada uno propone un sitio (uno por persona). El pool es anónimo.
2. **Votación** — un voto secreto y definitivo por persona (no a la propia propuesta). La lista se reordena en directo sin mostrar votos; solo se ve cuántos faltan. Empate → sorteo.
3. **Almuerzo** — se puntúa el sitio ganador por categorías (1–10). Se puede corregir hasta que puntúe todo el grupo.
4. **Revelación** — se descubre quién lo propuso (anfitrión, +10 puntos de victoria). La nota del sitio queda en secreto.

**Gran final** (la revela el admin): ranking de sitios por nota y clasificación final = puntos de victoria + nota de tus sitios + 5 de bonus al mejor sitio. El primero gana una cena.

Las reglas de puntos están en la tabla `league` y las categorías en `rating_categories` (editables desde Supabase → Table Editor).

## Tareas de admin (Supabase → SQL Editor / Authentication)
| Tarea | Cómo |
|---|---|
| Añadir un amigo | Authentication → Users → Add user → Create new user → `nombre@almuerzosmuytochos.app`, contraseña, **Auto Confirm User** marcado |
| Resetear contraseña | `supabase/reset-password.sql` (cambia usuario y clave) |
| Hacer admin a alguien | `supabase/make-admin.sql` |
| Cambiar categorías de puntuación | Table Editor → `rating_categories` (label, emoji, peso, activa) |
| Cambiar reglas de puntos | Table Editor → `league` |
| Quitar a un amigo | Authentication → Users → ⋯ → Delete user (se borran también sus votos) |

Los registros públicos están desactivados: solo existen los usuarios que crea el admin.

## Seguridad
- Todas las tablas tienen RLS (`supabase/schema.sql`). La web usa solo la *publishable key*; nunca pongas la secret/service_role en el código.
- Cada usuario solo puede editar su nombre y su foto, y solo votar por sí mismo.
- Propuestas, votos y notas no se pueden leer directamente: solo a través de funciones que devuelven lo permitido en cada fase.

## Archivos
- `index.html`, `styles.css`, `app.js` — la web
- `config.js` — URL del proyecto y publishable key
- `supabase/01-base.sql` — perfiles, admin, fotos (idempotente)
- `supabase/02-sesiones.sql` — sesiones, propuestas, votos, puntuaciones, liga y funciones seguras (idempotente)
- `supabase/opcional-borrar-votaciones-antiguas.sql` — limpia las tablas de la primera versión
