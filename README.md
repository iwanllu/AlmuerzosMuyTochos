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

### Pool privado y batallas ⚔️
- Cada uno tiene su **pool privado** de sitios (nadie más lo ve) y en la fase de propuestas elige uno de ahí.
- Si añades a tu pool un sitio que ya tiene otro → **batalla**. Quien la provoca gira la **ruleta**, que elige un minijuego: 🥪 Bocata tocho, 🫒 Hueso de oliva, 🥜 Los cacaos del gasto o 🥖 Corta la barra.
- Si más gente añade el mismo sitio antes de que se resuelva, entra en la misma batalla. Tras resolverse, un nuevo interesado reta al que lo tiene.
- Rivales anónimos: solo se sabe cuántos son. 3 intentos cada uno, cuenta el mejor; todos juegan la misma partida (misma semilla). Empate total → revancha.
- Quien gana se queda el sitio; los demás lo pierden. Mientras dura la batalla, nadie puede proponerlo.
- Todo el grupo ve cuántas batallas hay por jugar.

### Avisos 🔔
Notificaciones push (Android e iPhone con la web añadida a la pantalla de inicio, iOS 16.4+) y avisos dentro de la web. Sin teléfono ni email. Se activan en Perfil → Avisos.

Las reglas de puntos están en la tabla `league` y las categorías en `rating_categories` (editables desde Supabase → Table Editor).

## Tareas de admin (Supabase → SQL Editor / Authentication)
| Tarea | Cómo |
|---|---|
| Añadir un amigo | Authentication → Users → Add user → Create new user → `nombre@almuerzosmuytochos.app`, contraseña, **Auto Confirm User** marcado |
| Resetear contraseña | `supabase/reset-password.sql` (cambia usuario y clave) |
| Hacer admin a alguien | `supabase/make-admin.sql` |
| Cambiar categorías de puntuación | Table Editor → `rating_categories` (label, emoji, peso, activa) |
| Cambiar reglas de puntos | Table Editor → `league` |
| Desatascar una batalla | Web → Mi pool → sección Admin (girar ruleta / resolver ya) |
| Quitar a un amigo | Authentication → Users → ⋯ → Delete user (se borran también sus votos) |

Los registros públicos están desactivados: solo existen los usuarios que crea el admin.

## Seguridad
- Todas las tablas tienen RLS (`supabase/*.sql`). La web usa solo la *publishable key*; nunca pongas la secret/service_role en el código.
- Cada usuario solo puede editar su nombre y su foto, y solo votar por sí mismo.
- Propuestas, votos y notas no se pueden leer directamente: solo a través de funciones que devuelven lo permitido en cada fase.

## Archivos
- `index.html`, `styles.css`, `app.js` — la web
- `games.js` — minijuegos y ruleta · `sw.js` — recibe las notificaciones
- `config.js` — URL del proyecto y publishable key
- `supabase/01-base.sql` — perfiles, admin, fotos (idempotente)
- `supabase/03-sesiones.sql` — sesiones, propuestas, votos, puntuaciones, liga y funciones seguras (idempotente)
- `supabase/04-batallas.sql` — pool privado y batallas
- `supabase/functions/push/index.ts` — función que envía las notificaciones (Web Push sin dependencias; claves derivadas en el servidor, sin service_role)
- `supabase/opcional-borrar-votaciones-antiguas.sql` — limpia las tablas de la primera versión
