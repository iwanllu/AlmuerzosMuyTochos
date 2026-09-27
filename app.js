import { SUPABASE_URL, SUPABASE_KEY, EMAIL_DOMAIN } from './config.js';

// ===========================================================================
// Almuerzos Muy Tochos
// Sesiones mensuales: propuestas anónimas → votación secreta → puntuación → revelación
// ===========================================================================

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'almuerzos-auth', detectSessionInUrl: false },
});

const $app = document.getElementById('app');
const state = {
  session: null,          // sesión de login
  me: null,
  profiles: new Map(),
  sessions: [],           // sesiones de almuerzo (tabla pública)
  league: null,           // clasificación (función get_league)
  boards: new Map(),      // id sesión → get_session
  moves: new Map(),       // id sesión → { idPropuesta: {dir, until} }
  loaded: false,
  channel: null,
  drafts: { proposal: {}, rating: {}, newSession: null },
};

const PHASES = [
  { key: 'proposals', label: 'Propuestas', emoji: '💡' },
  { key: 'voting', label: 'Votación', emoji: '🗳️' },
  { key: 'rating', label: 'Almuerzo', emoji: '⭐' },
  { key: 'closed', label: 'Revelación', emoji: '🎉' },
];
const phaseIndex = (p) => PHASES.findIndex((x) => x.key === p);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.length > 40 ? 'abrir enlace ↗' : u}</a>`);
const num = (n, d = 1) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('es', { maximumFractionDigits: d, minimumFractionDigits: 0 }));

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 13v4M8 21h8M9 17h6"/></svg>',
};

const AV_COLORS = ['#e8590c', '#c2255c', '#6741d9', '#1971c2', '#0c8599', '#2f9e44', '#e67700', '#862e9c', '#d6336c', '#5c940d'];
function avatarColor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}
function avatar(profile, size = '') {
  const p = profile || { display_name: '?', username: '?' };
  const cls = `avatar ${size}`;
  const title = esc(p.display_name);
  if (p.avatar_url) return `<img class="${cls}" src="${esc(p.avatar_url)}" alt="${title}" title="${title}" loading="lazy">`;
  return `<span class="${cls}" style="--av:${avatarColor(p.username)}" title="${title}" aria-label="${title}">${esc(initials(p.display_name))}</span>`;
}
const person = (id) => state.profiles.get(id);
const nameOf = (id) => person(id)?.display_name ?? 'Alguien';

function parseDate(d) {
  const [y, m, day] = String(d).split('-').map(Number);
  return new Date(y, m - 1, day);
}
const fmtLong = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
const longDate = (d) => { const s = fmtLong.format(parseDate(d)); return s[0].toUpperCase() + s.slice(1); };
const shortDate = (d) => fmtShort.format(parseDate(d));
const hhmm = (t) => (t ? String(t).slice(0, 5) : '');
function isoDate(date) {
  const z = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${z(date.getMonth() + 1)}-${z(date.getDate())}`;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 2800);
}

function friendlyError(err) {
  const m = (err && (err.message || err.error_description || String(err))) || 'Error';
  if (/Invalid login credentials/i.test(m)) return 'Usuario o contraseña incorrectos';
  if (/Email not confirmed/i.test(m)) return 'Este usuario aún no está confirmado';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Sin conexión. Inténtalo de nuevo';
  if (/JWT|expired/i.test(m)) return 'La sesión ha caducado, vuelve a entrar';
  return m;
}

function sheet(html, bind) {
  return new Promise((resolve) => {
    const root = document.getElementById('sheet-root');
    root.innerHTML = `<div class="sheet-backdrop" data-close><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
    const done = (v) => { root.innerHTML = ''; resolve(v); };
    root.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', (e) => { if (e.target === el) done(null); }));
    bind(root, done);
  });
}
function confirmSheet({ title, text, okLabel = 'Aceptar', danger = false }) {
  return sheet(`
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      <div class="btn-row">
        <button class="btn ghost" data-close>Cancelar</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button>
      </div>`,
    (root, done) => { root.querySelector('[data-ok]').onclick = () => done(true); })
    .then((v) => v === true);
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------
const SESSION_COLS = 'id, number, lunch_date, lunch_time, note, phase, proposals_count, votes_count, ratings_count, winner_name, winner_by_draw, winner_proposal_id, host_id, version, phase_changed_at';
const activeSession = () => state.sessions.find((s) => s.phase !== 'closed');
const isAdmin = () => !!state.me?.is_admin;

async function loadAll() {
  const [pr, se, lg] = await Promise.all([
    sb.from('profiles').select('id, username, display_name, avatar_url, is_admin'),
    sb.from('sessions').select(SESSION_COLS).order('number', { ascending: false }),
    sb.rpc('get_league'),
  ]);
  const err = pr.error || se.error || lg.error;
  if (err) throw err;
  state.profiles = new Map(pr.data.map((p) => [p.id, p]));
  state.me = state.profiles.get(state.session.user.id) || null;
  state.sessions = se.data;
  state.league = lg.data;

  const ids = new Set();
  const act = activeSession();
  if (act) ids.add(act.id);
  const r = route();
  if (r.name === 'session') ids.add(r.id);
  for (const id of state.boards.keys()) if (!state.sessions.some((s) => s.id === id)) state.boards.delete(id);
  await Promise.all([...ids].filter((id) => state.sessions.some((s) => s.id === id)).map(loadBoard));
  state.loaded = true;
}

async function loadBoard(id) {
  const { data, error } = await sb.rpc('get_session', { p_session: id });
  if (error) throw error;
  if (!data) { state.boards.delete(id); return; }
  const prev = state.boards.get(id);
  // Detecta qué sitios suben o bajan en la votación (sin saber cuántos votos tienen)
  if (prev && prev.session.phase === 'voting' && data.session.phase === 'voting') {
    const before = new Map(prev.proposals.map((p, i) => [p.id, i]));
    const mv = state.moves.get(id) || {};
    const until = Date.now() + 6000;
    let changed = false;
    data.proposals.forEach((p, i) => {
      const b = before.get(p.id);
      if (b !== undefined && b !== i) { mv[p.id] = { dir: i < b ? 'up' : 'down', until }; changed = true; }
    });
    state.moves.set(id, mv);
    if (changed) setTimeout(render, 6100);
  }
  state.boards.set(id, data);
}

let reloadTimer;
function scheduleReload(delay = 250) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try { await loadAll(); render(); } catch (e) { console.warn(e); }
  }, delay);
}

const pendingBoards = new Set();
async function ensureBoard(id) {
  if (pendingBoards.has(id)) return;          // evita cargas repetidas / bucles
  pendingBoards.add(id);
  try { await loadBoard(id); } catch (e) { toast(friendlyError(e), true); }
  finally { pendingBoards.delete(id); }
  if (state.boards.has(id)) render();
}

function subscribe() {
  if (state.channel) return;
  state.channel = sb.channel('almuerzos-live');
  for (const table of ['sessions', 'league', 'profiles', 'rating_categories']) {
    state.channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => scheduleReload());
  }
  state.channel.subscribe();
}
function unsubscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session) scheduleReload(0);
});

async function call(fn, args, okMsg) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) { toast(friendlyError(error), true); return { ok: false }; }
  if (okMsg) toast(okMsg);
  await loadAll().catch(() => {});
  render();
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Router: #/  #/s/12  #/clasificacion  #/perfil  #/nueva
// ---------------------------------------------------------------------------
function route() {
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (name === 's' && id) return { name: 'session', id: Number(id) };
  if (name === 'clasificacion') return { name: 'ranking' };
  if (name === 'perfil') return { name: 'profile' };
  if (name === 'nueva') return { name: 'new' };
  return { name: 'home' };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

function topbar(title, back = false) {
  return `
    <header class="topbar">
      ${back ? `<button class="icon-btn" data-go="${back === true ? '#/' : back}" aria-label="Volver">${ICON.back}</button>` : ''}
      <h1>${title}</h1>
    </header>`;
}
function tabbar(active) {
  const t = (key, href, icon, label) => `<a href="${href}" class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></a>`;
  return `
    <nav class="tabbar" aria-label="Secciones"><div class="tabs">
      ${t('home', '#/', ICON.home, 'Inicio')}
      ${t('ranking', '#/clasificacion', ICON.trophy, 'Clasificación')}
      ${t('profile', '#/perfil', `<span class="tab-avatar">${avatar(state.me)}</span>`, 'Perfil')}
    </div></nav>`;
}
function bindCommon() {
  $app.querySelectorAll('[data-go]').forEach((el) => (el.onclick = () => go(el.dataset.go)));
}

// Animación de reordenación (FLIP) y conservación del foco al re-pintar en directo
function captureLayout() {
  const rects = new Map();
  $app.querySelectorAll('[data-flip]').forEach((el) => rects.set(el.dataset.flip, el.getBoundingClientRect().top));
  const a = document.activeElement;
  const focus = a && a.id && $app.contains(a) ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  return { rects, focus };
}
function restoreLayout({ rects, focus }) {
  if (focus) {
    const el = document.getElementById(focus.id);
    if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(focus.s, focus.e); } catch { /* no aplica */ } }
  }
  $app.querySelectorAll('[data-flip]').forEach((el) => {
    const before = rects.get(el.dataset.flip);
    if (before === undefined) return;
    const dy = before - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 2 && el.animate) {
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 550, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  });
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------
function render() {
  if (!state.session) return renderLogin();
  if (!state.loaded) { $app.innerHTML = '<div class="splash"><div class="spinner" aria-label="Cargando"></div></div>'; return; }
  if (!state.me) return renderNoProfile();
  const layout = captureLayout();
  const r = route();
  if (r.name === 'session') renderSession(r.id);
  else if (r.name === 'ranking') renderRanking();
  else if (r.name === 'profile') renderProfile();
  else if (r.name === 'new' && isAdmin()) renderNew();
  else renderHome();
  restoreLayout(layout);
}

function renderLogin() {
  $app.innerHTML = `
    <section class="login">
      <img class="logo" src="icon.svg" alt="">
      <h1>Almuerzos <span>Muy Tochos</span></h1>
      <p class="sub">Un almuerzo al mes. Propón, vota, puntúa… y gana una cena.</p>
      <form id="login-form" novalidate>
        <div class="field">
          <label for="user">Usuario</label>
          <div class="input-prefix">
            <input class="input" id="user" name="user" autocomplete="username" autocapitalize="none"
                   autocorrect="off" spellcheck="false" placeholder="ana" required>
          </div>
        </div>
        <div class="field">
          <label for="pass">Contraseña</label>
          <input class="input" id="pass" name="pass" type="password" autocomplete="current-password" required>
        </div>
        <div class="error-text" id="login-error" role="alert"></div>
        <button class="btn primary block" type="submit">Entrar</button>
      </form>
    </section>`;
  const form = document.getElementById('login-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const user = form.user.value.trim().toLowerCase().replace(/^@/, '').replace(/@.*$/, '');
    const pass = form.pass.value;
    const errEl = document.getElementById('login-error');
    if (!user || !pass) { errEl.textContent = 'Escribe tu usuario y contraseña'; return; }
    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'Entrando…'; errEl.textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: `${user}@${EMAIL_DOMAIN}`, password: pass });
    if (error) { errEl.textContent = friendlyError(error); btn.disabled = false; btn.textContent = 'Entrar'; }
  };
}

function renderNoProfile() {
  $app.innerHTML = `
    <section class="login">
      <div style="font-size:56px">🤔</div>
      <h1>Falta tu perfil</h1>
      <p class="sub">Tu usuario existe pero no tiene perfil. Avisa al admin.</p>
      <button class="btn ghost block" id="logout">Salir</button>
    </section>`;
  document.getElementById('logout').onclick = () => sb.auth.signOut();
}

// ---------- Piezas comunes de sesión ----------
function stepper(phase) {
  const cur = phaseIndex(phase);
  return `<div class="stepper" aria-label="Fase: ${esc(PHASES[cur]?.label)}">
    ${PHASES.map((p, i) => `<div class="step ${i < cur || phase === 'closed' ? 'done' : ''} ${i === cur && phase !== 'closed' ? 'current' : ''}"><span class="dot"></span>${p.label}</div>`).join('')}
  </div>`;
}
function whenText(s) {
  return `${longDate(s.lunch_date)}${s.lunch_time ? ` · ${hhmm(s.lunch_time)}` : ''}`;
}
function pending(b) {
  const s = b.session;
  const done = s.phase === 'proposals' ? s.proposals_count : s.phase === 'voting' ? s.votes_count : s.ratings_count;
  const verb = s.phase === 'proposals' ? 'proponer' : s.phase === 'voting' ? 'votar' : 'puntuar';
  return { done, total: b.members, missing: Math.max(0, b.members - done), verb };
}
function counter(b) {
  const p = pending(b);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return `
    <div class="card counter" aria-live="polite">
      <div class="row">
        <span class="big ${p.missing === 0 ? 'ok' : ''}">${p.missing}</span>
        <span class="label">${p.missing === 1 ? `falta 1 por ${p.verb}` : `faltan por ${p.verb}`}</span>
      </div>
      <div class="bar ${p.missing === 0 ? 'ok' : ''}"><i style="width:${pct}%"></i></div>
      <span class="hint">Nadie sabe quién falta. Cuando estéis todos, se pasa de fase automáticamente.</span>
    </div>`;
}
function myStatus(b) {
  const s = b.session;
  if (s.phase === 'proposals') return b.my_proposal
    ? { done: true, ico: '✅', text: `Has propuesto «${esc(b.my_proposal.name)}»` }
    : { done: false, ico: '💡', text: 'Te falta proponer tu sitio' };
  if (s.phase === 'voting') return b.my_vote
    ? { done: true, ico: '✅', text: 'Ya has votado' }
    : { done: false, ico: '🗳️', text: '¡Te toca votar!' };
  if (s.phase === 'rating') return b.my_ratings
    ? { done: true, ico: '✅', text: `Has puntuado ${esc(s.winner_name)}` }
    : { done: false, ico: '⭐', text: `Puntúa ${esc(s.winner_name)}` };
  return { done: true, ico: '🎉', text: 'Sesión terminada' };
}

// ---------- Inicio ----------
function renderHome() {
  const act = activeSession();
  const b = act && state.boards.get(act.id);
  const past = state.sessions.filter((s) => s.phase === 'closed');
  const nextNum = (state.sessions[0]?.number || 0) + 1;

  let hero = '';
  if (act && b) {
    const st = myStatus(b);
    const p = pending(b);
    hero = `
      <a class="card session-hero" href="#/s/${act.id}">
        <div class="eyebrow">Sesión ${act.number} · ${PHASES[phaseIndex(act.phase)].label}</div>
        <h2>${esc(whenText(act))}</h2>
        ${act.note ? `<div class="hint">${esc(act.note)}</div>` : ''}
        ${stepper(act.phase)}
        <div class="todo ${st.done ? 'done' : ''}">
          <span class="ico">${st.ico}</span><span class="grow">${st.text}</span>
          ${st.done ? '' : '<span class="go">Ir →</span>'}
        </div>
        <p class="hint" style="margin:10px 2px 0">${p.missing === 0 ? 'Todo el grupo ha participado' : `Faltan ${p.missing} por ${p.verb}`}</p>
      </a>`;
  } else if (act) {
    hero = '<div class="card"><div class="splash" style="min-height:120px"><div class="spinner"></div></div></div>';
  } else {
    hero = `
      <div class="card empty">
        <div class="big">🍽️</div>
        <strong>No hay ninguna sesión en marcha</strong>
        <p class="hint">${isAdmin() ? 'Crea la próxima cuando tengáis fecha.' : 'Cuando el admin cree la próxima, aparecerá aquí.'}</p>
        ${isAdmin() ? `<button class="btn primary" data-go="#/nueva">${ICON.plus} Crear sesión ${nextNum}</button>` : ''}
      </div>`;
  }

  $app.innerHTML = `
    ${topbar('Almuerzos <span>Muy Tochos</span>')}
    <main>
      ${hero}
      ${past.length ? `
        <div class="section-title">Sesiones anteriores</div>
        <div class="past">
          ${past.map((s) => `
            <a class="past-item" href="#/s/${s.id}">
              <span class="num">${s.number}</span>
              <span class="grow">
                <strong>🏆 ${esc(s.winner_name || 'Sin ganador')}</strong>
                <span class="hint">${esc(shortDate(s.lunch_date))} · propuesto por ${esc(s.host_id ? nameOf(s.host_id) : '—')}</span>
              </span>
              ${s.host_id ? avatar(person(s.host_id), 'sm') : ''}
            </a>`).join('')}
        </div>` : ''}
    </main>
    ${tabbar('home')}`;
  bindCommon();
}

// ---------- Sesión ----------
function renderSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) {
    $app.innerHTML = `${topbar('Sesión', true)}<main><div class="empty"><div class="big">🫥</div>Esta sesión no existe.</div></main>${tabbar('home')}`;
    bindCommon();
    return;
  }
  const b = state.boards.get(id);
  if (!b) {
    $app.innerHTML = `${topbar(`Sesión ${s.number}`, true)}<main><div class="splash"><div class="spinner"></div></div></main>${tabbar('home')}`;
    bindCommon();
    ensureBoard(id);
    return;
  }

  const phase = b.session.phase;
  const body = phase === 'proposals' ? proposalsView(b)
    : phase === 'voting' ? votingView(b)
    : phase === 'rating' ? ratingView(b)
    : closedView(b);

  $app.innerHTML = `
    ${topbar(`Sesión ${b.session.number}`, true)}
    <main>
      <div class="session-head">
        <div class="eyebrow">${PHASES[phaseIndex(phase)].emoji} ${PHASES[phaseIndex(phase)].label}${phase !== 'closed' ? ' · <span class="live">en directo</span>' : ''}</div>
        <h2>${esc(whenText(b.session))}</h2>
        ${b.session.note ? `<p class="note">${linkify(b.session.note)}</p>` : ''}
        ${stepper(phase)}
      </div>
      ${body}
      ${isAdmin() ? adminBox(b) : ''}
    </main>
    ${tabbar('home')}`;
  bindCommon();
  bindSession(b);
}

function proposalsView(b) {
  const id = b.session.id;
  const d = (state.drafts.proposal[id] ||= { name: '', note: '', editing: false });
  const mp = b.my_proposal;
  const showForm = !mp || d.editing;
  const form = `
    <form class="card" id="prop-form" novalidate>
      <div class="field">
        <label for="prop-name">${mp ? 'Cambiar mi propuesta' : 'Tu propuesta'}</label>
        <input class="input" id="prop-name" maxlength="80" placeholder="Nombre del bar o restaurante" value="${esc(d.name)}" autocomplete="off">
      </div>
      <div class="field">
        <label for="prop-note">Comentario <span class="hint">(opcional)</span></label>
        <textarea class="input" id="prop-note" maxlength="200" placeholder="Dónde está, enlace de Maps, por qué mola…">${esc(d.note)}</textarea>
      </div>
      <div class="error-text" id="prop-error" role="alert"></div>
      <div class="btn-row">
        ${mp ? '<button type="button" class="btn ghost" id="prop-cancel">Cancelar</button>' : ''}
        <button class="btn primary" type="submit">${mp ? 'Guardar cambio' : 'Enviar propuesta'}</button>
      </div>
      <p class="hint" style="margin:12px 0 0">🤫 Es anónima: nadie verá que es tuya. Solo se sabrá si gana, cuando todos hayan puntuado.</p>
    </form>`;
  const mine = mp ? `
    <div class="card">
      <div class="section-title" style="margin-top:0">Tu propuesta</div>
      <div style="font:800 20px/1.2 var(--display)">${esc(mp.name)}</div>
      ${mp.note ? `<p class="hint" style="margin:4px 0 0">${linkify(mp.note)}</p>` : ''}
      <div class="btn-row" style="margin-top:14px">
        <button class="btn ghost small" id="prop-edit">Cambiar</button>
        <button class="btn danger small" id="prop-withdraw">Retirar</button>
      </div>
    </div>` : '';

  return `
    ${showForm ? form : mine}
    <div class="section-title" style="margin-top:20px"></div>
    ${counter(b)}
    <div class="section-title"><span class="grow">El pool · ${b.proposals.length} ${b.proposals.length === 1 ? 'sitio' : 'sitios'}</span><span class="chip">anónimo</span></div>
    ${b.proposals.length ? `<ul class="pool">
      ${b.proposals.map((p) => `
        <li class="pool-item ${p.mine ? 'mine' : ''}">
          <span class="ico">🍽️</span>
          <span class="body">
            <span class="name">${esc(p.name)}</span>
            ${p.note ? `<span class="note">${linkify(p.note)}</span>` : ''}
            ${p.mine ? '<span class="hint">Tu propuesta · solo tú lo sabes</span>' : ''}
          </span>
        </li>`).join('')}
    </ul>` : '<div class="card empty" style="padding:24px">Aún no hay propuestas. ¡Sé el primero!</div>'}`;
}

function votingView(b) {
  const id = b.session.id;
  const mv = state.moves.get(id) || {};
  const now = Date.now();
  const voted = b.my_vote;
  const votedName = voted && b.proposals.find((p) => p.id === voted)?.name;
  return `
    <div class="card" style="margin-top:14px">
      ${voted
        ? `<strong>✅ Has votado «${esc(votedName)}»</strong><p class="hint" style="margin:4px 0 0">Tu voto es secreto y definitivo. Mira cómo se mueve la lista.</p>`
        : `<strong>¿Dónde quieres almorzar?</strong><p class="hint" style="margin:4px 0 0">Un solo voto, secreto y definitivo. No puedes votar tu propia propuesta.</p>`}
    </div>
    <div class="section-title" style="margin-top:20px"></div>
    ${counter(b)}
    <div class="section-title"><span class="grow">Clasificación en directo</span><span class="live">en directo</span></div>
    <ul class="rank">
      ${b.proposals.map((p, i) => {
        const m = mv[p.id] && mv[p.id].until > now ? mv[p.id] : null;
        const isVote = voted === p.id;
        let action = '';
        if (isVote) action = '<span class="chip ok">Tu voto</span>';
        else if (p.mine) action = '<span class="chip">Tuya</span>';
        else if (!voted) action = `<button class="btn primary small" data-vote="${p.id}" data-name="${esc(p.name)}">Votar</button>`;
        return `
          <li data-flip="p${p.id}">
            <div class="rank-item ${isVote ? 'voted' : ''} ${p.mine ? 'mine' : ''}">
              <span class="pos">${i + 1}</span>
              <span class="body">
                <span class="name">${esc(p.name)}</span>
                ${p.note ? `<span class="note">${linkify(p.note)}</span>` : ''}
              </span>
              ${m ? `<span class="move ${m.dir}" aria-label="${m.dir === 'up' ? 'sube' : 'baja'}">${m.dir === 'up' ? '▲' : '▼'}</span>` : ''}
              ${action}
            </div>
          </li>`;
      }).join('')}
    </ul>
    <p class="hint center" style="margin-top:12px">La lista se ordena por votos, pero nadie ve cuántos tiene cada sitio.</p>`;
}

function ratingView(b) {
  const id = b.session.id;
  const d = (state.drafts.rating[id] ||= { ...(b.my_ratings || {}) });
  const cats = b.categories;
  const complete = cats.every((c) => d[c.key] >= 1);
  const vals = cats.map((c) => d[c.key]).filter(Boolean);
  const avg = vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : null;
  return `
    <div class="card winner-card" style="margin-top:14px">
      <div class="trophy">🏆</div>
      <div class="label">Sitio ganador</div>
      <h3>${esc(b.session.winner_name)}</h3>
      ${b.session.winner_by_draw ? '<span class="chip gold">Empate resuelto por sorteo 🎲</span>' : ''}
      <div class="mystery">🤫 ¿Quién lo propuso? Se desvelará cuando todo el grupo haya puntuado.</div>
    </div>
    <div class="section-title" style="margin-top:20px"></div>
    ${counter(b)}
    <div class="section-title"><span class="grow">${b.my_ratings ? 'Tu puntuación (puedes corregirla)' : 'Puntúa el almuerzo'}</span></div>
    <form class="card" id="rate-form" novalidate>
      ${cats.map((c) => `
        <div class="cat">
          <div class="cat-head">
            <span class="emoji" aria-hidden="true">${esc(c.emoji || '•')}</span>
            <span class="grow"><strong>${esc(c.label)}</strong>${c.hint ? `<span class="hint">${esc(c.hint)}</span>` : ''}</span>
            <span class="val">${d[c.key] ?? '–'}</span>
          </div>
          <div class="ten" role="radiogroup" aria-label="${esc(c.label)}">
            ${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => `
              <button type="button" role="radio" aria-checked="${d[c.key] === n}" data-cat="${esc(c.key)}" data-val="${n}"
                class="${d[c.key] === n ? 'on' : d[c.key] > n ? 'in' : ''}">${n}</button>`).join('')}
          </div>
        </div>`).join('')}
      <div class="my-avg"><span>Tu nota media</span><strong>${num(avg)}</strong></div>
      <button class="btn primary block" type="submit" ${complete ? '' : 'disabled'}>
        ${b.my_ratings ? 'Actualizar mi puntuación' : complete ? 'Enviar puntuación' : `Te faltan ${cats.length - vals.length} categorías`}
      </button>
    </form>`;
}

function closedView(b) {
  const s = b.session;
  const host = s.host_id ? person(s.host_id) : null;
  const others = b.proposals.filter((p) => !p.winner);
  const cats = b.categories;
  return `
    <div class="card winner-card" style="margin-top:14px">
      <div class="trophy">🏆</div>
      <div class="label">Sitio ganador</div>
      <h3>${esc(s.winner_name || 'Sin ganador')}</h3>
      ${s.winner_by_draw ? '<span class="chip gold">Ganó por sorteo 🎲</span>' : ''}
      <div class="reveal">
        <span class="by">Lo propuso…</span>
        ${host ? avatar(host, 'lg') : '<div style="font-size:40px">🤷</div>'}
        <span class="who">${esc(host ? host.display_name : 'Alguien que ya no está en el grupo')}</span>
        ${host ? `<span class="points-badge">+${b.host_points} puntos de victoria</span>` : ''}
      </div>
    </div>
    <div class="card center">
      ${b.final_revealed && b.score !== null
        ? `<div class="hint">Nota del sitio</div><div class="score-big">${num(b.score, 2)}</div><div class="hint">sobre 10</div>`
        : '<strong>🤫 La nota del sitio es secreta</strong><p class="hint" style="margin:4px 0 0">Se desvelará en la gran final.</p>'}
    </div>
    ${b.my_ratings ? `
      <div class="section-title">Tu puntuación</div>
      <div class="card"><div class="my-scores">
        ${cats.map((c) => `<div class="s"><b>${b.my_ratings[c.key] ?? '–'}</b>${esc(c.emoji || '')} ${esc(c.label)}</div>`).join('')}
      </div></div>` : ''}
    ${others.length ? `
      <div class="section-title"><span class="grow">Resto de propuestas</span><span class="chip">anónimas</span></div>
      <ul class="pool">
        ${others.map((p) => `<li class="pool-item ${p.mine ? 'mine' : ''}"><span class="ico">🍽️</span><span class="body"><span class="name">${esc(p.name)}</span>${p.mine ? '<span class="hint">La tuya</span>' : ''}</span></li>`).join('')}
      </ul>` : ''}`;
}

function adminBox(b) {
  const s = b.session;
  const p = s.phase !== 'closed' ? pending(b) : null;
  const next = {
    proposals: 'Cerrar propuestas y empezar a votar',
    voting: 'Cerrar la votación',
    rating: 'Cerrar puntuación y revelar',
  }[s.phase];
  return `
    <div class="admin-box">
      <div class="section-title">Admin</div>
      <div class="btn-col">
        ${next ? `<button class="btn ghost" id="adm-next">${next}</button>
          <p class="hint" style="margin:-4px 2px 4px">${p.missing ? `Faltan ${p.missing} por ${p.verb}. Normalmente se avanza solo; úsalo si alguien no va a participar.` : 'Se avanzará solo en un momento.'}</p>` : ''}
        <div class="btn-row">
          <button class="btn ghost" id="adm-edit">Editar fecha</button>
          <button class="btn danger" id="adm-del">Borrar</button>
        </div>
      </div>
    </div>`;
}

function bindSession(b) {
  const id = b.session.id;
  const phase = b.session.phase;

  if (phase === 'proposals') {
    const d = state.drafts.proposal[id];
    const f = document.getElementById('prop-form');
    if (f) {
      const nameEl = f.querySelector('#prop-name');
      const noteEl = f.querySelector('#prop-note');
      nameEl.oninput = () => (d.name = nameEl.value);
      noteEl.oninput = () => (d.note = noteEl.value);
      const cancel = f.querySelector('#prop-cancel');
      if (cancel) cancel.onclick = () => { d.editing = false; render(); };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const err = document.getElementById('prop-error');
        if (d.name.trim().length < 2) { err.textContent = 'Escribe el nombre del sitio'; return; }
        const btn = f.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await sb.rpc('propose', { p_session: id, p_name: d.name, p_note: d.note });
        if (error) { err.textContent = friendlyError(error); btn.disabled = false; return; }
        state.drafts.proposal[id] = { name: '', note: '', editing: false };
        toast(b.my_proposal ? 'Propuesta cambiada 🤫' : 'Propuesta enviada 🤫');
        await loadAll().catch(() => {});
        render();
      };
    }
    const edit = document.getElementById('prop-edit');
    if (edit) edit.onclick = () => { Object.assign(d, { editing: true, name: b.my_proposal.name, note: b.my_proposal.note || '' }); render(); document.getElementById('prop-name')?.focus(); };
    const wd = document.getElementById('prop-withdraw');
    if (wd) wd.onclick = async () => {
      if (await confirmSheet({ title: '¿Retirar tu propuesta?', text: 'Podrás proponer otro sitio mientras siga abierto el plazo.', okLabel: 'Retirar', danger: true })) {
        call('withdraw_proposal', { p_session: id }, 'Propuesta retirada');
      }
    };
  }

  if (phase === 'voting') {
    $app.querySelectorAll('[data-vote]').forEach((btn) => (btn.onclick = async () => {
      const ok = await confirmSheet({
        title: `¿Votar «${btn.dataset.name}»?`,
        text: 'Tu voto es secreto y no se puede cambiar.',
        okLabel: 'Votar',
      });
      if (!ok) return;
      const r = await call('cast_vote', { p_session: id, p_proposal: Number(btn.dataset.vote) }, '¡Voto registrado! 🗳️');
      if (r.ok && navigator.vibrate) navigator.vibrate(15);
    }));
  }

  if (phase === 'rating') {
    const d = state.drafts.rating[id];
    $app.querySelectorAll('[data-cat]').forEach((btn) => (btn.onclick = () => { d[btn.dataset.cat] = Number(btn.dataset.val); render(); }));
    const f = document.getElementById('rate-form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const had = !!b.my_ratings;
      const r = await call('rate_session', { p_session: id, p_scores: d }, had ? 'Puntuación actualizada' : '¡Gracias por puntuar! ⭐');
      if (r.ok) state.drafts.rating[id] = null;
    };
  }

  if (isAdmin()) {
    const nx = document.getElementById('adm-next');
    if (nx) nx.onclick = async () => {
      const p = pending(b);
      const ok = await confirmSheet({
        title: nx.textContent.trim() + '?',
        text: p.missing ? `Faltan ${p.missing} por ${p.verb} y ya no podrán hacerlo.` : 'Se pasará a la siguiente fase.',
        okLabel: 'Sí, avanzar',
      });
      if (ok) call('advance_session', { p_session: id }, 'Fase cambiada');
    };
    document.getElementById('adm-edit').onclick = () => editSessionSheet(b.session);
    document.getElementById('adm-del').onclick = async () => {
      const ok = await confirmSheet({ title: `¿Borrar la sesión ${b.session.number}?`, text: 'Se borrarán sus propuestas, votos y puntuaciones. No se puede deshacer.', okLabel: 'Borrar', danger: true });
      if (!ok) return;
      const { error } = await sb.from('sessions').delete().eq('id', id);
      if (error) return toast(friendlyError(error), true);
      toast('Sesión borrada');
      state.boards.delete(id);
      await loadAll().catch(() => {});
      go('#/');
    };
  }
}

function sessionFields(v) {
  return `
    <div class="grid-2">
      <div class="field"><label for="f-date">Fecha</label><input class="input" type="date" id="f-date" value="${esc(v.date)}" required></div>
      <div class="field"><label for="f-time">Hora <span class="hint">(opc.)</span></label><input class="input" type="time" id="f-time" value="${esc(v.time)}"></div>
    </div>
    <div class="field"><label for="f-note">Nota <span class="hint">(opcional)</span></label>
      <textarea class="input" id="f-note" maxlength="300" placeholder="Dónde quedamos, quién conduce…">${esc(v.note)}</textarea></div>`;
}

function editSessionSheet(s) {
  sheet(`
    <h3>Editar sesión ${s.number}</h3>
    <form id="edit-form" novalidate>
      ${sessionFields({ date: s.lunch_date, time: hhmm(s.lunch_time), note: s.note || '' })}
      <div class="error-text" id="edit-error"></div>
      <div class="btn-row"><button type="button" class="btn ghost" data-close>Cancelar</button><button class="btn primary" type="submit">Guardar</button></div>
    </form>`, (root, done) => {
    root.querySelector('#edit-form').onsubmit = async (e) => {
      e.preventDefault();
      const date = root.querySelector('#f-date').value;
      if (!date) { root.querySelector('#edit-error').textContent = 'Pon la fecha'; return; }
      const { error } = await sb.from('sessions').update({
        lunch_date: date,
        lunch_time: root.querySelector('#f-time').value || null,
        note: root.querySelector('#f-note').value.trim() || null,
      }).eq('id', s.id);
      if (error) { root.querySelector('#edit-error').textContent = friendlyError(error); return; }
      done(true);
      toast('Sesión actualizada');
      await loadAll().catch(() => {});
      render();
    };
  });
}

// ---------- Nueva sesión (admin) ----------
function renderNew() {
  const nextNum = (state.sessions[0]?.number || 0) + 1;
  const inAWeek = new Date(Date.now() + 7 * 86400000);
  const v = (state.drafts.newSession ||= { date: isoDate(inAWeek), time: '', note: '' });
  const busy = activeSession();
  $app.innerHTML = `
    ${topbar(`Nueva sesión ${nextNum}`, true)}
    <main>
      ${busy ? `<div class="card"><strong>Ya hay una sesión en marcha</strong><p class="hint">Termina la sesión ${busy.number} antes de crear otra.</p></div>` : `
      <form class="card" id="new-form" novalidate>
        ${sessionFields(v)}
        <div class="error-text" id="new-error" role="alert"></div>
        <button class="btn primary block" type="submit">Crear sesión ${nextNum}</button>
        <p class="hint" style="margin:12px 0 0">Se abrirá el plazo de propuestas para todo el grupo.</p>
      </form>`}
    </main>
    ${tabbar('home')}`;
  bindCommon();
  const f = document.getElementById('new-form');
  if (!f) return;
  ['date', 'time', 'note'].forEach((k) => (f.querySelector(`#f-${k}`).oninput = (e) => (v[k] = e.target.value)));
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!v.date) { document.getElementById('new-error').textContent = 'Pon la fecha'; return; }
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    const { data, error } = await sb.rpc('create_session', { p_date: v.date, p_time: v.time || null, p_note: v.note || null });
    if (error) { document.getElementById('new-error').textContent = friendlyError(error); btn.disabled = false; return; }
    state.drafts.newSession = null;
    toast(`Sesión ${nextNum} creada`);
    await loadAll().catch(() => {});
    go(`#/s/${data}`);
  };
}

// ---------- Clasificación y gran final ----------
function renderRanking() {
  const lg = state.league;
  const me = state.me.id;
  const rules = `
    <div class="card">
      <strong>Cómo se gana la cena 🍽️</strong>
      <ol class="rules" style="margin-top:10px">
        <li>Si tu propuesta gana una sesión, eres el anfitrión: <b>+${lg.host_points} puntos de victoria</b>.</li>
        <li>En la gran final, a cada anfitrión se le suma la nota de su sitio${Number(lg.score_weight) !== 1 ? ` × ${num(lg.score_weight, 2)}` : ''}.</li>
        <li>Quien propuso el mejor sitio de todas las sesiones gana <b>+${lg.best_site_bonus} de bonus</b>.</li>
        <li>El que más puntos sume… ¡está invitado a cenar!</li>
      </ol>
    </div>`;

  let content;
  if (lg.final_revealed && lg.final) {
    const f = lg.final;
    const champ = f.ranking[0] && f.ranking[0].total > 0 ? f.ranking[0] : null;
    content = `
      ${champ ? `
        <div class="card champion">
          <div class="eyebrow">🎉 Gran final</div>
          ${avatar(person(champ.user_id), 'xl')}
          <h2>¡${esc(nameOf(champ.user_id))} está invitado a cenar!</h2>
          <span class="points-badge">${num(champ.total, 2)} puntos</span>
        </div>` : '<div class="card empty">Todavía no hay puntos para decidir un ganador.</div>'}
      <div class="section-title">Mejores sitios</div>
      <div class="stack-gap">
        ${f.sites.map((st, i) => `
          <div class="card site-row">
            <div class="top">
              <span style="font-size:24px">${['🥇', '🥈', '🥉'][i] || `${i + 1}.`}</span>
              <span class="grow">
                <strong>${esc(st.name)}</strong>
                <span class="hint">Sesión ${st.number} · ${esc(shortDate(st.lunch_date))} · de ${esc(st.host_id ? nameOf(st.host_id) : '—')}</span>
              </span>
              <span class="score">${num(st.score, 2)}</span>
            </div>
            ${st.categories.length ? `<div class="cat-bars">
              ${st.categories.map((c) => `<div class="cb"><span class="l"><span>${esc(c.emoji || '')} ${esc(c.label)}</span><b>${num(c.avg)}</b></span><div class="bar"><i style="width:${c.avg * 10}%"></i></div></div>`).join('')}
            </div>` : '<span class="hint">Nadie lo puntuó</span>'}
          </div>`).join('') || '<div class="card empty">Sin sitios puntuados</div>'}
      </div>
      <div class="section-title">Clasificación final</div>
      <div class="card standings">
        ${f.ranking.map((r, i) => `
          <div class="stand-row ${r.user_id === me ? 'me' : ''}">
            <span class="pos">${i + 1}</span>
            ${avatar(person(r.user_id), 'sm')}
            <span class="grow">
              <span class="name">${esc(nameOf(r.user_id))}</span>
              <span class="breakdown">${r.victory_points} victoria + ${num(r.score_points, 2)} nota${r.bonus ? ` + ${r.bonus} bonus 🥇` : ''}</span>
            </span>
            <span class="pts">${num(r.total, 2)}</span>
          </div>`).join('')}
      </div>
      ${rules}`;
  } else {
    content = `
      <div class="section-title"><span class="grow">Puntos de victoria</span><span class="chip">${lg.closed_count} ${lg.closed_count === 1 ? 'sesión cerrada' : 'sesiones cerradas'}</span></div>
      <div class="card standings">
        ${lg.standings.map((r, i) => `
          <div class="stand-row ${r.user_id === me ? 'me' : ''}">
            <span class="pos">${i + 1}</span>
            ${avatar(person(r.user_id), 'sm')}
            <span class="grow">
              <span class="name">${esc(nameOf(r.user_id))}</span>
              <span class="breakdown">${r.wins ? '🏆'.repeat(Math.min(r.wins, 6)) + ` ${r.wins} ${r.wins === 1 ? 'sesión ganada' : 'sesiones ganadas'}` : 'Sin victorias aún'}</span>
            </span>
            <span class="pts">${r.points}<small> pts</small></span>
          </div>`).join('')}
      </div>
      <div class="card center" style="margin-top:12px">
        <strong>🤫 Las notas de los sitios son secretas</strong>
        <p class="hint" style="margin:4px 0 0">Se desvelarán en la gran final, junto al ganador de la cena.</p>
      </div>
      <div class="section-title"></div>
      ${rules}`;
  }

  $app.innerHTML = `
    ${topbar('Clasificación')}
    <main>
      ${content}
      ${isAdmin() ? `
        <div class="admin-box">
          <div class="section-title">Admin</div>
          ${lg.final_revealed
            ? '<button class="btn ghost block" id="adm-final">Ocultar la gran final</button>'
            : `<button class="btn primary block" id="adm-final" ${lg.closed_count ? '' : 'disabled'}>🎉 Revelar la gran final</button>
               <p class="hint" style="margin:8px 2px 0">${lg.closed_count ? 'Todo el grupo verá las notas y quién gana la cena.' : 'Necesitas al menos una sesión cerrada.'}</p>`}
        </div>` : ''}
    </main>
    ${tabbar('ranking')}`;
  bindCommon();

  const btn = document.getElementById('adm-final');
  if (btn) btn.onclick = async () => {
    const reveal = !lg.final_revealed;
    const ok = await confirmSheet(reveal
      ? { title: '¿Revelar la gran final?', text: 'Se mostrarán a todos las notas de los sitios y la clasificación final.', okLabel: 'Revelar' }
      : { title: '¿Ocultar la gran final?', text: 'Las notas volverán a ser secretas.', okLabel: 'Ocultar' });
    if (!ok) return;
    const { error } = await sb.from('league').update({ final_revealed: reveal }).eq('id', 1);
    if (error) return toast(friendlyError(error), true);
    toast(reveal ? '¡Gran final revelada! 🎉' : 'Final oculta');
    await loadAll().catch(() => {});
    render();
  };
}

// ---------- Perfil ----------
function renderProfile() {
  const me = state.me;
  const members = [...state.profiles.values()].sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));
  $app.innerHTML = `
    ${topbar('Mi perfil')}
    <main>
      <div class="profile-top">
        <button class="photo-btn" id="photo" aria-label="Cambiar foto">
          ${avatar(me, 'xl')}
          <span class="badge">${ICON.camera}</span>
        </button>
        <input type="file" id="file" accept="image/*" class="sr-only" tabindex="-1">
        <span class="handle">@${esc(me.username)}${me.is_admin ? ' · admin' : ''}</span>
      </div>
      <form id="profile-form" class="card" novalidate>
        <div class="field">
          <label for="name">Nombre</label>
          <input class="input" id="name" maxlength="40" value="${esc(me.display_name)}" autocomplete="nickname" required>
          <span class="hint">Así te verá el resto del grupo.</span>
        </div>
        <button class="btn primary block" type="submit">Guardar</button>
      </form>
      <div class="section-title">El grupo · ${state.profiles.size}</div>
      <div class="card who-list">
        ${members.map((m) => `<div class="who-row">${avatar(m, 'sm')}<span class="name">${esc(m.display_name)}</span><span class="hint">@${esc(m.username)}</span></div>`).join('')}
      </div>
      <div style="margin-top:24px"><button class="btn ghost block" id="logout">Cerrar sesión</button></div>
    </main>
    ${tabbar('profile')}`;
  bindCommon();

  const file = document.getElementById('file');
  document.getElementById('photo').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      toast('Subiendo foto…');
      const blob = await squareJpeg(f, 320);
      const path = `${me.id}/avatar.jpg`;
      const up = await sb.storage.from('avatars').upload(path, blob, { upsert: true, contentType: 'image/jpeg', cacheControl: '3600' });
      if (up.error) throw up.error;
      const url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl + `?v=${Date.now()}`;
      const { error } = await sb.from('profiles').update({ avatar_url: url }).eq('id', me.id);
      if (error) throw error;
      me.avatar_url = url;
      toast('Foto actualizada');
      render();
    } catch (e) {
      toast(friendlyError(e), true);
    } finally {
      file.value = '';
    }
  };

  const form = document.getElementById('profile-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return toast('El nombre no puede estar vacío', true);
    const { error } = await sb.from('profiles').update({ display_name: name }).eq('id', me.id);
    if (error) return toast(friendlyError(error), true);
    me.display_name = name;
    toast('Guardado');
    render();
  };

  document.getElementById('logout').onclick = async () => {
    const ok = await confirmSheet({ title: '¿Cerrar sesión?', text: 'Tendrás que volver a escribir tu usuario y contraseña.', okLabel: 'Cerrar sesión' });
    if (ok) await sb.auth.signOut();
  };
}

// Recorta la foto en cuadrado y la reduce (fotos ligeras aunque vengan del móvil)
async function squareJpeg(file, size) {
  const bitmap = await (window.createImageBitmap
    ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file))
    : new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }));
  const s = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - s) / 2, (bitmap.height - s) / 2, s, s, 0, 0, size, size);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo procesar la imagen'))), 'image/jpeg', 0.85));
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function onSession(session) {
  const prevUser = state.session?.user?.id;
  state.session = session;
  if (!session) {
    unsubscribe();
    Object.assign(state, { me: null, loaded: false, sessions: [], league: null, profiles: new Map(), boards: new Map(), moves: new Map() });
    render();
    return;
  }
  if (prevUser === session.user.id && state.loaded) return; // solo se ha renovado el token
  state.loaded = false;
  render();
  try {
    await loadAll();
    subscribe();
  } catch (e) {
    toast(friendlyError(e), true);
  }
  render();
}

sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => onSession(session), 0);
});
