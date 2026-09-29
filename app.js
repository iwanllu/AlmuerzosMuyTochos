import { SUPABASE_URL, SUPABASE_KEY, EMAIL_DOMAIN } from './config.js';
import { GAMES, runGame, rouletteScreen, gameScreen, closeOverlay } from './games.js?v=9';
import { pickPlace, placeInfo, placeLinks, mapsSearchURL, onMapsAuthError, carouselHTML, bindCarousel, descHTML } from './maps.js?v=9';

// ===========================================================================
// Almuerzos Muy Tochos
// Almuerzos mensuales: propuestas anónimas → votación secreta → puntuación → revelación
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
  pool: [],               // mi pool privado (my_pool)
  battles: null,          // mis batallas + contador del grupo (my_battles)
  pushOn: false,
  mapsKey: null,          // clave de navegador de Google Maps (la pone el admin)
  drafts: { proposal: {}, rating: {}, dates: {}, newSession: null, pool: { name: '', note: '' } },
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
  pool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.3"/><circle cx="4.5" cy="12" r="1.3"/><circle cx="4.5" cy="18" r="1.3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/></svg>',
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
const longDate = (d) => { if (!d) return 'Fecha por decidir'; const s = fmtLong.format(parseDate(d)); return s[0].toUpperCase() + s.slice(1); };
const shortDate = (d) => (d ? fmtShort.format(parseDate(d)) : 'sin fecha');
const fmtDay = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric', month: 'short' });
const dayLabel = (d) => { const s = fmtDay.format(parseDate(d)).replace(',', '').replace(/\.(?=\s|$)/g, ''); return s[0].toUpperCase() + s.slice(1); };
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
  if (/JWT|expired/i.test(m)) return 'Tu acceso ha caducado, vuelve a entrar';
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
  const [pr, se, lg, po, bt, cf] = await Promise.all([
    sb.from('profiles').select('id, username, display_name, avatar_url, is_admin'),
    sb.from('sessions').select(SESSION_COLS).order('number', { ascending: false }),
    sb.rpc('get_league'),
    sb.rpc('my_pool'),
    sb.rpc('my_battles'),
    sb.from('app_config').select('maps_key').eq('id', 1),
  ]);
  const err = pr.error || se.error || lg.error || po.error || bt.error;
  if (err) throw err;
  state.mapsKey = (!cf.error && cf.data?.[0]?.maps_key) || null;
  state.pool = po.data || [];
  detectBattleEvents(state.battles, bt.data);
  state.battles = bt.data;
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
  updateAppBadge();
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
  for (const table of ['sessions', 'league', 'profiles', 'rating_categories', 'battle_stats', 'app_config']) {
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
  flushPush();
  await loadAll().catch(() => {});
  render();
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Explicaciones en bocadillo: ⓘ junto al título de cada apartado
// ---------------------------------------------------------------------------
const INFO_TEXT = new Map();
function info(key, html, label = 'Más información') {
  INFO_TEXT.set(key, html);
  return `<button type="button" class="info-btn" data-info="${esc(key)}" aria-label="${esc(label)}" aria-expanded="false">${ICON.info}</button>`;
}
function infoPop() {
  let pop = document.getElementById('info-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'info-pop'; pop.setAttribute('role', 'tooltip'); pop.hidden = true;
    pop.innerHTML = '<div class="ip-body"></div><span class="ip-arrow" aria-hidden="true"></span>';
    document.body.appendChild(pop);
  }
  return pop;
}
function positionInfo(btn) {
  const pop = infoPop();
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const w = Math.min(300, vw - 24);
  pop.style.width = `${w}px`;
  const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, vw - 12 - w));
  const h = pop.offsetHeight;
  const above = r.bottom + 10 + h > window.innerHeight - 84 && r.top - 10 - h > 70;
  pop.classList.toggle('above', above);
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${(above ? r.top - 10 - h : r.bottom + 10) + window.scrollY}px`;
  pop.style.setProperty('--ax', `${Math.max(14, Math.min(r.left + r.width / 2 - left, w - 14))}px`);
}
function closeInfo() {
  const pop = document.getElementById('info-pop');
  if (!pop || pop.hidden) return;
  pop.hidden = true; delete pop.dataset.key;
  document.querySelectorAll('.info-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
function openInfo(btn) {
  const pop = infoPop();
  const key = btn.dataset.info;
  if (!pop.hidden && pop.dataset.key === key) { closeInfo(); return; }
  closeInfo();
  pop.querySelector('.ip-body').innerHTML = INFO_TEXT.get(key) || '';
  pop.dataset.key = key; pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  positionInfo(btn);
}
// Tras re-pintar (p. ej. en directo) el bocadillo sigue abierto si su ⓘ sigue en pantalla
function syncInfo() {
  const pop = document.getElementById('info-pop');
  if (!pop || pop.hidden) return;
  const btn = document.querySelector(`.info-btn[data-info="${CSS.escape(pop.dataset.key)}"]`);
  if (!btn) { closeInfo(); return; }
  pop.querySelector('.ip-body').innerHTML = INFO_TEXT.get(pop.dataset.key) || '';
  btn.setAttribute('aria-expanded', 'true');
  positionInfo(btn);
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.info-btn');
  if (btn) { e.preventDefault(); e.stopPropagation(); openInfo(btn); return; }
  const pop = document.getElementById('info-pop');
  if (!pop || pop.hidden || e.target.closest('#info-pop')) return;
  closeInfo();
  // Con el bocadillo abierto, tocar fuera solo lo cierra (no vota ni abre webs sin querer);
  // las barras de arriba y abajo sí navegan a la primera
  if (!e.target.closest('.tabbar, .topbar')) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInfo(); });
window.addEventListener('resize', closeInfo);
window.addEventListener('hashchange', closeInfo);

// ---------------------------------------------------------------------------
// Router: #/  #/s/12  #/pool  #/clasificacion  #/perfil  #/nueva
// ---------------------------------------------------------------------------
function route() {
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (name === 's' && id) return { name: 'session', id: Number(id) };
  if (name === 'clasificacion') return { name: 'ranking' };
  if (name === 'pool') return { name: 'pool' };
  if (name === 'perfil') return { name: 'profile' };
  if (name === 'nueva') return { name: 'new' };
  return { name: 'home' };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// Cabecera fija con el logo (en todas las secciones). El título de la página va debajo y se desplaza.
function topbar(title = '', back = false) {
  const nb = myBattleActions();
  return `
    <header class="topbar">
      ${back ? `<button class="icon-btn" data-go="${back === true ? '#/' : back}" aria-label="Volver">${ICON.back}</button>` : ''}
      <a class="brand" href="#/" aria-label="Almuerzos Muy Tochos · Inicio">
        <img src="icon.svg" alt="" width="36" height="36">
        <span class="wordmark">Almuerzos<b>Muy Tochos</b></span>
      </a>
      ${nb && route().name !== 'pool' ? `<a class="top-alert" href="#/pool" aria-label="${nb === 1 ? 'Tienes 1 batalla esperándote' : `Tienes ${nb} batallas esperándote`}">⚔️<span class="t">${nb === 1 ? ' Te toca jugar' : ` ${nb} batallas`}</span><span class="n">${nb}</span></a>` : ''}
    </header>
    ${title ? `<h1 class="page-title">${title}</h1>` : ''}`;
}
function tabbar(active) {
  const t = (key, href, icon, label, badge = 0) => `<a href="${href}" class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}>${icon}<span>${label}</span>${badge ? `<span class="tab-badge" aria-label="${badge} pendientes">${badge}</span>` : ''}</a>`;
  return `
    <nav class="tabbar" aria-label="Secciones"><div class="tabs">
      ${t('home', '#/', ICON.home, 'Inicio')}
      ${t('pool', '#/pool', ICON.pool, 'Mi pool', myBattleActions())}
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
  const cars = new Map();
  $app.querySelectorAll('.carousel[data-car]').forEach((el) => {
    const t = el.querySelector('.car-track');
    if (t && t.scrollLeft) cars.set(el.dataset.car + '|' + (el.dataset.ctx || ''), t.scrollLeft);
  });
  return { rects, focus, cars };
}
function restoreLayout({ rects, focus, cars }) {
  $app.querySelectorAll('.carousel[data-car]').forEach((el) => {
    const v = cars?.get(el.dataset.car + '|' + (el.dataset.ctx || ''));
    if (v) el.querySelector('.car-track').scrollLeft = v;
  });
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
  else if (r.name === 'pool') renderPool();
  else if (r.name === 'profile') renderProfile();
  else if (r.name === 'new' && isAdmin()) renderNew();
  else renderHome();
  restoreLayout(layout);
  hydratePlaces();
  syncInfo();
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

// ---------- Piezas comunes de un almuerzo ----------
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
// Participación: cuántos faltan y qué pasa cuando estéis todos
const PHASE_TEXT = {
  proposals: { did: 'han propuesto', didOne: 'ha propuesto', info: 'Cuando proponga el último, empieza la votación.', all: '¡Ya habéis propuesto todos!', soon: 'En un momento empieza la votación.' },
  voting: { did: 'han votado', didOne: 'ha votado', info: 'Cuando vote el último, se cierra la votación y el primero del ranking será el sitio del almuerzo.', all: '¡Ya habéis votado todos!', soon: 'En un momento se anuncia el sitio del almuerzo.' },
  rating: { did: 'han puntuado', didOne: 'ha puntuado', info: 'Cuando puntúe el último, se desvela quién propuso el sitio y se lleva sus puntos.', all: '¡Ya habéis puntuado todos!', soon: 'En un momento se desvela quién lo propuso.' },
};
function counter(b) {
  const p = pending(b);
  const t = PHASE_TEXT[b.session.phase];
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const all = p.missing === 0;
  return `
    <div class="section-title">Participación ${info('participacion', all ? t.soon : `${t.info} Es anónimo: nadie sabe quién falta.`)}</div>
    <div class="card counter" aria-live="polite">
      <div class="row">
        <span class="big ${all ? 'ok' : ''}">${all ? '✓' : p.missing}</span>
        <span class="label">${all ? t.all : `de ${p.total} aún no ${p.missing === 1 ? t.didOne : t.did}`}</span>
      </div>
      <div class="bar ${all ? 'ok' : ''}"><i style="width:${pct}%"></i></div>
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
  return { done: true, ico: '🎉', text: 'Almuerzo terminado' };
}

// ---------- Inicio: el próximo almuerzo ----------
function daysUntil(d) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const x = parseDate(d); x.setHours(0, 0, 0, 0);
  return Math.round((x - t) / 86400000);
}
function relDay(d) {
  const n = daysUntil(d);
  return n === 0 ? '¡Es hoy!' : n === 1 ? 'Mañana' : n > 1 ? `Dentro de ${n} días` : n === -1 ? 'Fue ayer' : `Fue hace ${-n} días`;
}
function nextHead(s) {
  if (!s.lunch_date) return `
    <div class="session-head next-head">
      <div class="eyebrow">🍽️ Próximo almuerzo · nº ${s.number} ${info('fases', 'Cada almuerzo pasa por 4 fases: <b>propuestas</b>, <b>votación</b>, <b>almuerzo</b> (se puntúa) y <b>revelación</b>. Cada una se cierra sola cuando habéis participado todos. La fecha se elige a la vez que las propuestas.')}</div>
      <h2>Fecha por decidir${s.lunch_time ? ` <span class="when">· ${esc(hhmm(s.lunch_time))}</span>` : ''}</h2>
      <button class="rel-day pick" type="button" data-scroll="#fecha">📅 Elegid fecha en el calendario ↓</button>
      ${s.note ? `<p class="note">${linkify(s.note)}</p>` : ''}
      ${stepper(s.phase)}
    </div>`;
  const future = daysUntil(s.lunch_date) >= 0;
  return `
    <div class="session-head next-head">
      <div class="eyebrow">🍽️ ${future ? 'Próximo almuerzo' : 'Último almuerzo'} · nº ${s.number} ${info('fases', 'Cada almuerzo pasa por 4 fases: <b>propuestas</b>, <b>votación</b>, <b>almuerzo</b> (se puntúa) y <b>revelación</b>. Cada una se cierra sola cuando habéis participado todos.')}</div>
      <h2>${esc(longDate(s.lunch_date))}${s.lunch_time ? ` <span class="when">· ${esc(hhmm(s.lunch_time))}</span>` : ''}</h2>
      <div class="rel-day">${relDay(s.lunch_date)}</div>
      ${s.note ? `<p class="note">${linkify(s.note)}</p>` : ''}
      ${stepper(s.phase)}
    </div>`;
}
function history(past) {
  return `
    <div class="section-title"><span class="grow">Histórico de ganadores ${info('historico', 'El sitio que ganó cada almuerzo y quién lo propuso. Toca uno para ver el detalle.')}</span>${past.length ? `<span class="chip">${past.length} ${past.length === 1 ? 'almuerzo' : 'almuerzos'}</span>` : ''}</div>
    ${past.length ? `<div class="past">
      ${past.map((s) => `
        <a class="past-item" href="#/s/${s.id}">
          <span class="num">${s.number}</span>
          <span class="grow">
            <strong>🏆 ${esc(s.winner_name || 'Sin ganador')}</strong>
            <span class="hint">${esc(longDate(s.lunch_date))} · propuesto por ${esc(s.host_id ? nameOf(s.host_id) : '—')}</span>
          </span>
          ${s.host_id ? avatar(person(s.host_id), 'sm') : ''}
        </a>`).join('')}
    </div>` : '<div class="card empty" style="padding:20px">Aún no hay almuerzos anteriores.</div>'}`;
}
// Secciones del almuerzo en curso, en este orden: ranking → tu propuesta → participación
function activeSections(b) {
  const phase = b.session.phase;
  if (phase === 'proposals') return proposalsView(b);
  if (phase === 'voting') return votingView(b);
  return ratingView(b);
}
function renderHome() {
  const act = activeSession();
  const b = act && state.boards.get(act.id);
  const past = state.sessions.filter((s) => s.phase === 'closed');
  const nextNum = (state.sessions[0]?.number || 0) + 1;
  const openB = state.battles?.stats?.open_battles || 0;

  let top;
  if (act && b) top = nextHead(b.session) + activeSections(b);
  else if (act) top = nextHead(act) + '<div class="card"><div class="splash" style="min-height:120px"><div class="spinner"></div></div></div>';
  else top = `
    <div class="session-head next-head">
      <div class="eyebrow">🍽️ Próximo almuerzo</div>
      <h2>Sin fecha todavía</h2>
    </div>
    <div class="card empty">
      <div class="big">🗓️</div>
      <strong>No hay ningún almuerzo en marcha ${info('sin-sesion', isAdmin() ? 'Créalo cuando tengáis fecha: se abrirá el plazo de propuestas para todo el grupo.' : 'Cuando el admin ponga fecha al próximo, aparecerá aquí.')}</strong>
      ${isAdmin() ? `<button class="btn primary" data-go="#/nueva">${ICON.plus} Crear almuerzo ${nextNum}</button>` : ''}
    </div>`;

  $app.innerHTML = `
    ${topbar()}
    <main>
      ${top}
      ${history(past)}
      ${openB ? `<a class="salseo-line" href="#/pool">⚔️ <span class="grow">${openB === 1 ? 'Hay 1 batalla por jugar' : `Hay ${openB} batallas por jugar`} en el grupo</span><span class="hint">${state.battles.stats.fighters} en liza</span></a>` : ''}
      ${pushCard('home')}
      ${isAdmin() && b ? adminBox(b) : ''}
    </main>
    ${tabbar('home')}`;
  bindCommon();
  bindPushCard();
  if (b) bindSession(b);
}

// ---------- Almuerzo (los anteriores; el que está en marcha se ve en Inicio) ----------
function renderSession(id) {
  if (activeSession()?.id === id) return renderHome();
  const s = state.sessions.find((x) => x.id === id);
  if (!s) {
    $app.innerHTML = `${topbar('Almuerzo', true)}<main><div class="empty"><div class="big">🫥</div>Este almuerzo no existe.</div></main>${tabbar('home')}`;
    bindCommon();
    return;
  }
  const b = state.boards.get(id);
  if (!b) {
    $app.innerHTML = `${topbar(`Almuerzo ${s.number}`, true)}<main><div class="splash"><div class="spinner"></div></div></main>${tabbar('home')}`;
    bindCommon();
    ensureBoard(id);
    return;
  }
  $app.innerHTML = `
    ${topbar(`Almuerzo ${b.session.number}`, true)}
    <main>
      <div class="session-head">
        <div class="eyebrow">🎉 Almuerzo terminado</div>
        <h2>${esc(whenText(b.session))}</h2>
        ${b.session.note ? `<p class="note">${linkify(b.session.note)}</p>` : ''}
        ${stepper(b.session.phase)}
      </div>
      ${closedView(b)}
      ${isAdmin() ? adminBox(b) : ''}
    </main>
    ${tabbar('home')}`;
  bindCommon();
  bindSession(b);
}

// ---------------------------------------------------------------------------
// Fecha entre todos: calendario de sábados y domingos
// ---------------------------------------------------------------------------
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
function dateDraft(b) {
  const id = b.session.id;
  const poll = b.date_poll;
  let d = state.drafts.dates[id];
  if (!d || !d.dirty) {
    const sel = {};
    const today = isoDate(new Date());
    for (const x of poll.mine) if (x.day >= today && x.day <= poll.max_day) sel[x.day] = x.level;   // fuera de plazo no cuenta
    // Se abre en el mes de tu primera fecha, de la que va ganando o del próximo fin de semana disponible
    const t = new Date();
    while (t.getDay() !== 6 && t.getDay() !== 0) t.setDate(t.getDate() + 1);
    const nextWeekend = isoDate(t);
    const first = poll.mine[0]?.day || poll.best || (nextWeekend <= poll.max_day ? nextWeekend : isoDate(new Date()));
    d = state.drafts.dates[id] = { sel, none: !!poll.my_none, dirty: false, open: !!d?.open, month: d?.month || first.slice(0, 7) };
  }
  return d;
}
function calendarHTML(b, d) {
  const poll = b.date_poll;
  const today = isoDate(new Date());
  const maxDay = poll.max_day;                                        // un mes después del último almuerzo
  const [y, m] = d.month.split('-').map(Number);
  const maxMonth = maxDay.slice(0, 7);
  const [my, mm] = maxMonth.split('-').map(Number);
  const lastNav = `${mm + 2 > 12 ? my + 1 : my}-${pad2(((mm + 1) % 12) + 1)}`;   // se puede asomar 2 meses más allá
  const tooFar = d.month > maxMonth || maxDay < today;
  const startDow = (new Date(y, m - 1, 1).getDay() + 6) % 7;          // lunes = 0
  const days = new Date(y, m, 0).getDate();
  const agg = new Map(poll.days.map((x) => [x.day, x]));
  const members = b.members || 1;
  const canPrev = d.month > today.slice(0, 7);
  const canNext = d.month < lastNav;
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += '<span class="cal-blank"></span>';
  for (let day = 1; day <= days; day++) {
    const iso = ymd(y, m, day);
    const dow = (startDow + day - 1) % 7;
    const weekend = dow >= 5;
    const late = weekend && iso > maxDay;
    const open = weekend && iso >= today && !late;
    const g = agg.get(iso);
    const n = g ? g.yes + g.maybe : 0;
    const lvl = d.sel[iso];
    cells += `<button type="button" class="cal-day ${weekend ? 'we' : ''} ${late ? 'late' : ''} ${lvl ? `sel l${lvl}` : ''} ${iso === poll.best ? 'best' : ''}"
      ${open ? `data-day="${iso}"` : 'disabled'} style="--heat:${(n / members).toFixed(2)}"
      aria-label="${esc(dayLabel(iso))}${n ? `, ${n} ${n === 1 ? 'puede' : 'pueden'}` : ''}${lvl ? ', elegida' : ''}" aria-pressed="${!!lvl}">
      <span>${day}</span>${open && n ? `<i class="cal-n">${n}</i>` : ''}</button>`;
  }
  return `
    <div class="cal">
      <div class="cal-head">
        <button type="button" class="icon-btn small" data-cal="-1" ${canPrev ? '' : 'disabled'} aria-label="Mes anterior">‹</button>
        <strong>${MONTHS_ES[m - 1]} ${y}</strong>
        <button type="button" class="icon-btn small" data-cal="1" ${canNext ? '' : 'disabled'} aria-label="Mes siguiente">›</button>
      </div>
      <div class="cal-grid ${tooFar ? 'too-far' : ''}">
        ${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((w, i) => `<span class="cal-dow ${i >= 5 ? 'we' : ''}">${w}</span>`).join('')}
        ${cells}
        ${tooFar ? '<div class="cal-watermark" role="note"><span>Demasiado tiempo sin volver a almorzar con tus panas</span></div>' : ''}
      </div>
      <p class="cal-limit">Como mucho hasta el <b>${esc(dayLabel(maxDay))}</b> · un mes después del último almuerzo</p>
    </div>`;
}
function datePollView(b) {
  const poll = b.date_poll;
  if (!poll) return '';
  const d = dateDraft(b);
  const members = b.members || 1;
  const mine = Object.keys(d.sel).sort();
  const ranked = [...poll.days].sort((a, c) => (c.yes + c.maybe) - (a.yes + a.maybe) || c.yes - a.yes || (a.day < c.day ? -1 : 1)).slice(0, 6);
  const missing = poll.missing.map((id) => person(id)).filter(Boolean);
  const status = !d.dirty && poll.answered ? '<span class="chip ok">✓ guardado</span>' : '';   // si hay cambios, ya sale el botón «Guardar»
  return `
    <div class="section-title" id="fecha"><span class="grow">📅 ¿Qué día quedamos? ${info('fecha', 'Marca en el calendario los <b>sábados y domingos</b> que puedes, como mucho <b>un mes después del último almuerzo</b>. Abre «Tus fechas» para decir si cada una es <b>seguro</b> o <b>si hace falta</b>, y guarda. Cuando hayáis respondido todos, se fija sola la fecha con más gente (empate: más «seguro»; después, la más cercana). El admin puede fijarla antes.')}</span></div>
    <div class="card date-card">
      ${calendarHTML(b, d)}
      <div class="my-drawer ${d.open ? 'open' : ''}">
        <div class="md-bar">
          <button type="button" class="md-toggle" data-mdtoggle aria-expanded="${d.open}" aria-controls="md-body-${b.session.id}">
            <span class="md-title">${mine.length ? `Tus fechas <b>${mine.length}</b>` : d.none ? 'Ninguna te va bien' : 'Tus fechas'}</span>
            ${status}
            <span class="chev" aria-hidden="true">▾</span>
          </button>
          ${(mine.length || d.none) && (d.dirty || !poll.answered) ? `<button type="button" class="btn primary small" id="date-save">${poll.answered ? 'Actualizar' : 'Guardar'}</button>` : ''}
        </div>
        <div class="md-body" id="md-body-${b.session.id}"><div class="md-inner">
      ${mine.length ? `<div class="my-dates">
        ${mine.map((iso) => `
          <div class="md-row">
            <span class="md-date">${esc(dayLabel(iso))}</span>
            <span class="md-ctrl"><span class="seg" role="radiogroup" aria-label="Disponibilidad el ${esc(dayLabel(iso))}">
              <button type="button" class="${d.sel[iso] === 2 ? 'on' : ''}" data-mday="${iso}" data-level="2" role="radio" aria-checked="${d.sel[iso] === 2}">✅ Seguro</button>
              <button type="button" class="${d.sel[iso] === 1 ? 'on maybe' : ''}" data-mday="${iso}" data-level="1" role="radio" aria-checked="${d.sel[iso] === 1}">🤷 Si hace falta</button>
            </span>
            <button type="button" class="icon-btn small" data-rmday="${iso}" aria-label="Quitar ${esc(dayLabel(iso))}">${ICON.x}</button></span>
          </div>`).join('')}
      </div>` : `<p class="md-empty">${d.none ? '😕 Has marcado que ninguna fecha te va bien.' : 'Toca en el calendario los sábados y domingos que puedes.'}</p>`}
      <label class="none-toggle"><input type="checkbox" id="date-none" ${d.none ? 'checked' : ''}> Ninguna fecha me va bien</label>
        </div></div>
      </div>
    </div>
    <div class="card avail-card">
      <div class="md-head"><strong>Disponibilidad del grupo</strong></div>
      <div class="legend"><span><i class="lg-yes"></i>seguro</span><span><i class="lg-maybe"></i>si hace falta</span><span>· de ${members}</span></div>
      ${ranked.length ? ranked.map((x) => `
        <div class="av-row ${x.day === poll.best ? 'best' : ''}">
          <span class="av-date">${x.day === poll.best ? '⭐ ' : ''}${esc(dayLabel(x.day))}</span>
          <span class="av-bar" aria-label="${x.yes} seguro, ${x.maybe} si hace falta, de ${members}">
            <i class="yes" style="width:${(x.yes / members) * 100}%"></i><i class="maybe" style="width:${(x.maybe / members) * 100}%"></i></span>
          <span class="av-n">${x.yes + x.maybe}/${members}</span>
          ${isAdmin() ? `<button type="button" class="btn ghost small av-fix" data-fixday="${x.day}">Fijar</button>` : ''}
        </div>`).join('') : '<p class="md-empty">Aún nadie ha elegido fecha.</p>'}
      ${poll.none_count ? `<p class="md-empty" style="margin-top:6px">${poll.none_count} ${poll.none_count === 1 ? 'persona no puede' : 'personas no pueden'} en ninguna.</p>` : ''}
      <div class="missing">
        ${missing.length
          ? `<span class="ms-label">Faltan por elegir fecha (${missing.length}):</span>
             <div class="ms-list">${missing.map((p) => `<span class="ms-chip">${avatar(p, 'xs')}${esc(p.display_name)}</span>`).join('')}</div>`
          : '<span class="ms-label ok">✅ Ya habéis respondido todos</span>'}
      </div>
    </div>`;
}
function bindDatePoll(b) {
  const poll = b.date_poll;
  if (!poll) return;
  const id = b.session.id;
  const d = dateDraft(b);
  const touch = () => { d.dirty = true; render(); };
  $app.querySelectorAll('[data-cal]').forEach((btn) => (btn.onclick = () => {
    const [y, m] = d.month.split('-').map(Number);
    const n = new Date(y, m - 1 + Number(btn.dataset.cal), 1);
    d.month = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}`;
    render();
  }));
  $app.querySelectorAll('.cal-day[data-day]').forEach((btn) => (btn.onclick = () => {
    const iso = btn.dataset.day;
    if (d.sel[iso]) delete d.sel[iso]; else { d.sel[iso] = 2; d.none = false; }
    if (navigator.vibrate) navigator.vibrate(8);
    touch();
  }));
  $app.querySelectorAll('[data-mday]').forEach((btn) => (btn.onclick = () => { d.sel[btn.dataset.mday] = Number(btn.dataset.level); touch(); }));
  $app.querySelectorAll('[data-rmday]').forEach((btn) => (btn.onclick = () => { delete d.sel[btn.dataset.rmday]; touch(); }));
  const tg = $app.querySelector('[data-mdtoggle]');
  if (tg) tg.onclick = () => {
    d.open = !d.open;
    tg.closest('.my-drawer').classList.toggle('open', d.open);
    tg.setAttribute('aria-expanded', String(d.open));
  };
  const none = document.getElementById('date-none');
  if (none) none.onchange = () => { d.none = none.checked; if (d.none) d.sel = {}; touch(); };
  const save = document.getElementById('date-save');
  if (save) save.onclick = async () => {
    save.disabled = true;
    const days = Object.keys(d.sel).sort().map((day) => ({ day, level: d.sel[day] }));
    d.dirty = false;
    const r = await call('save_dates', { p_session: id, p_days: days, p_none: d.none && !days.length }, 'Fechas guardadas 📅');
    if (!r.ok) { d.dirty = true; render(); }
  };
  $app.querySelectorAll('[data-fixday]').forEach((btn) => (btn.onclick = async () => {
    const day = btn.dataset.fixday;
    const ok = await confirmSheet({ title: `¿Fijar el ${dayLabel(day)}?`, text: 'Se cerrará la elección de fecha y avisaremos a todo el grupo.', okLabel: 'Fijar fecha' });
    if (ok) call('fix_date', { p_session: id, p_day: day }, '📅 Fecha fijada');
  }));
}

// Columna de posición del ranking: medallas para el podio, flecha si acaba de subir o bajar
function rankCol(i, ranked, move) {
  if (!ranked) return '<div class="rank-col" aria-label="Sin posición todavía"><span class="rank-num none">–</span></div>';
  const medal = ['gold', 'silver', 'bronze'][i] || '';
  return `<div class="rank-col" aria-label="Posición ${i + 1}">
    <span class="rank-num ${medal}">${i === 0 ? '<span class="crown" aria-hidden="true">👑</span>' : ''}${i + 1}</span>
    ${move ? `<span class="rank-move ${move.dir}" aria-label="${move.dir === 'up' ? 'sube' : 'baja'}">${move.dir === 'up' ? '▲' : '▼'}</span>` : ''}
  </div>`;
}
// Tu propuesta en una sola línea, discreta
function mineLine(mp, extra = '') {
  return `
    <div class="mine-line">
      <span class="mine-open" ${openAttrs(mp.place_id, mp.name)}>
        ${thumb(mp.place_id, '🍽️', 'xs')}
        <span class="body"><span class="nm">${esc(mp.name)}</span><span class="open-hint">Web ↗</span></span>
      </span>
      ${extra}
    </div>`;
}

function proposalsView(b) {
  const id = b.session.id;
  const d = (state.drafts.proposal[id] ||= { placeId: null, editing: false, adding: false, name: '', note: '' });
  const mp = b.my_proposal;
  const showForm = !mp || d.editing;
  const pool = state.pool;
  if (d.placeId && !pool.some((p) => p.id === d.placeId && !p.battle_id)) d.placeId = null;
  const n = b.proposals.length;
  const ranking = `
    <div class="block-head">
      <h3>🏆 Ranking de sitios para el próximo almuerzo ${info('ranking', 'Los sitios propuestos, sin saber de quién es cada uno. El orden lo decide la votación, que empieza cuando todos hayáis propuesto. Desliza las fotos y toca un sitio para ver su web y su carta.')}</h3>
      <div class="sub"><span>${n} ${n === 1 ? 'sitio propuesto' : 'sitios propuestos'} · aún sin votos</span></div>
    </div>
    ${n ? `<ul class="tiles ranking">
      ${b.proposals.map((p) => `
        <li class="place-tile rank-tile ${p.mine ? 'mine' : ''}">
          ${rankCol(0, false)}
          ${carousel(p.place_id, p.name, { ctx: 'g' })}
          <div class="tile-foot" ${openAttrs(p.place_id, p.name)}>
            <span class="name">${esc(p.name)}</span>
            ${placeDesc(p.place_id)}
            <span class="foot-row"><span class="open-hint">${p.mine ? 'Web ↗' : 'Web y carta ↗'}</span>${p.mine ? '<span class="mine-tag" title="Solo tú lo sabes">tuya</span>' : ''}</span>
          </div>
        </li>`).join('')}
    </ul>` : '<div class="card empty" style="padding:24px">Aún no hay propuestas. ¡Sé el primero!</div>'}`;
  const form = `
    <form class="card" id="prop-form" novalidate>
      <span class="field-label">${mp ? 'Cambia tu propuesta' : 'Elige tu propuesta de tu pool'}</span>
      ${pool.length ? `<div class="pick-list" role="radiogroup" aria-label="Sitios de tu pool">
        ${pool.map((p) => `
          <label class="pick ${p.battle_id ? 'disabled' : ''} ${d.placeId === p.id ? 'on' : ''}">
            <input type="radio" name="place" value="${p.id}" ${d.placeId === p.id ? 'checked' : ''} ${p.battle_id ? 'disabled' : ''}>
            ${thumb(p.place_id, '🍽️', 'sm')}
            <span class="body"><span class="name">${esc(p.name)}</span></span>
            ${p.battle_id ? '<span class="chip accent">⚔️ en batalla</span>' : ''}
          </label>`).join('')}
      </div>` : '<p class="hint">Tu pool está vacío: añade un sitio para poder proponerlo.</p>'}
      <div class="add-inline">
        <button type="button" class="btn ghost small" id="add-open">🔎 Buscar otro sitio en Google Maps</button>
      </div>
      <div class="error-text" id="prop-error" role="alert"></div>
      <div class="btn-row">
        ${mp ? '<button type="button" class="btn ghost" id="prop-cancel">Cancelar</button>' : ''}
        <button class="btn primary" type="submit" ${d.placeId ? '' : 'disabled'}>${mp ? 'Cambiar propuesta' : 'Proponer este sitio'}</button>
      </div>
    </form>`;
  const mine = mp ? `
    <div class="card mine-card">
      ${mineLine(mp, `<span class="mine-actions">
        <button class="icon-btn small" id="prop-edit" aria-label="Cambiar propuesta" title="Cambiar">${ICON.edit}</button>
        <button class="icon-btn small danger" id="prop-withdraw" aria-label="Retirar propuesta" title="Retirar">${ICON.x}</button>
      </span>`)}
    </div>` : '';

  return `
    ${ranking}
    <div class="section-title">Tu propuesta ${info('tu-propuesta', 'Elige un sitio de tu pool. Es anónima: solo se sabrá que era tuya si gana, al final. Puedes cambiarla o retirarla mientras dure el plazo.')}</div>
    ${showForm ? form : mine}
    ${datePollView(b)}
    ${counter(b)}`;
}

function votingView(b) {
  const id = b.session.id;
  const mv = state.moves.get(id) || {};
  const now = Date.now();
  const voted = b.my_vote;
  const votedName = voted && b.proposals.find((p) => p.id === voted)?.name;
  const mp = b.my_proposal || b.proposals.find((p) => p.mine);
  const ranked = (b.session.votes_count || 0) > 0;
  return `
    <div class="block-head">
      <h3>🏆 Ranking de sitios para el próximo almuerzo ${info('ranking', 'Se ordena en directo por votos, pero nadie ve cuántos tiene cada sitio. Cada uno tiene un voto, secreto y definitivo. Toca un sitio para ver su web y su carta.')}</h3>
      <div class="sub"><span class="live">en directo</span><span>${ranked ? 'ordenado por votos' : 'aún sin votos'}</span></div>
    </div>
    <ul class="tiles ranking">
      ${b.proposals.map((p, i) => {
        const m = mv[p.id] && mv[p.id].until > now ? mv[p.id] : null;
        const isVote = voted === p.id;
        let action = '';
        if (isVote) action = '<span class="chip ok">Tu voto</span>';
        else if (p.mine) action = '<span class="mine-tag">tuya</span>';
        else if (!voted) action = `<button class="btn primary small" data-vote="${p.id}" data-name="${esc(p.name)}">Votar</button>`;
        return `
          <li data-flip="p${p.id}" class="place-tile rank-tile ${ranked && i === 0 ? 'lead' : ''} ${ranked && i < 3 ? `podium p${i + 1}` : ''} ${isVote ? 'voted' : ''} ${p.mine ? 'mine' : ''}">
            ${rankCol(i, ranked, m)}
            ${carousel(p.place_id, p.name, { ctx: 'v' })}
            <div class="tile-foot" ${openAttrs(p.place_id, p.name)}>
              <span class="name">${esc(p.name)}</span>
              ${placeDesc(p.place_id)}
              <span class="foot-row"><span class="open-hint">${action ? 'Web ↗' : 'Web y carta ↗'}</span>${action}</span>
            </div>
          </li>`;
      }).join('')}
    </ul>
    <div class="section-title">Tu propuesta ${info('tu-propuesta', 'Tu sitio compite de forma anónima. No puedes votarlo: tu voto tiene que ir a otro, y no se puede cambiar.')}</div>
    <div class="card mine-card">
      ${mp ? mineLine(mp) : '<p class="hint" style="margin:0">No propusiste ningún sitio para este almuerzo.</p>'}
      <div class="vote-status ${voted ? 'ok' : ''}">${voted
        ? `✅ Has votado <b>«${esc(votedName)}»</b>`
        : '🗳️ <b>Te falta votar:</b> elige en el ranking de arriba'}</div>
    </div>
    ${datePollView(b)}
    ${counter(b)}`;
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
      ${winnerPhoto(b)}
      <div class="trophy">🏆</div>
      <div class="label">Sitio ganador ${info('ganador', 'El más votado. Quién lo propuso se desvela cuando todo el grupo haya puntuado.')}</div>
      <h3>${esc(b.session.winner_name)}</h3>
      ${b.session.winner_by_draw ? '<span class="chip gold">Empate resuelto por sorteo 🎲</span>' : ''}
      <div class="mystery">🤫 ¿Quién lo propuso?</div>
    </div>
    <div class="section-title"><span class="grow">${b.my_ratings ? 'Tu puntuación' : 'Puntúa el almuerzo'} ${info('puntua', 'Del 1 al 10 en cada categoría. Puedes corregirlo hasta que puntúe todo el grupo. La nota del sitio es secreta hasta la gran final.')}</span></div>
    <form class="card" id="rate-form" novalidate>
      ${cats.map((c) => `
        <div class="cat">
          <div class="cat-head">
            <span class="emoji" aria-hidden="true">${esc(c.emoji || '•')}</span>
            <span class="grow"><strong>${esc(c.label)}</strong>${c.hint ? info(`cat-${c.key}`, esc(c.hint), `Qué se puntúa en ${c.label}`) : ''}</span>
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
    </form>
    ${datePollView(b)}
    ${counter(b)}`;
}

function closedView(b) {
  const s = b.session;
  const host = s.host_id ? person(s.host_id) : null;
  const others = b.proposals.filter((p) => !p.winner);
  const cats = b.categories;
  return `
    <div class="card winner-card" style="margin-top:14px">
      ${winnerPhoto(b)}
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
        : '<strong>🤫 Nota secreta hasta la gran final</strong>'}
    </div>
    ${b.my_ratings ? `
      <div class="section-title">Tu puntuación</div>
      <div class="card"><div class="my-scores">
        ${cats.map((c) => `<div class="s"><b>${b.my_ratings[c.key] ?? '–'}</b>${esc(c.emoji || '')} ${esc(c.label)}</div>`).join('')}
      </div></div>` : ''}
    ${others.length ? `
      <div class="section-title"><span class="grow">Resto de propuestas ${info('resto', 'Los demás sitios de este almuerzo. Siguen siendo anónimos.')}</span></div>
      <ul class="pool">
        ${others.map((p) => `<li class="pool-item place-card ${p.mine ? 'mine' : ''}" ${openAttrs(p.place_id, p.name)}>${thumb(p.place_id, '🍽️', 'sm')}<span class="body"><span class="name">${esc(p.name)}</span>${p.mine ? '<span class="hint">La tuya</span>' : ''}</span><span class="open-hint">Web ↗</span></li>`).join('')}
      </ul>` : ''}`;
}

function adminBox(b) {
  const s = b.session;
  const next = {
    proposals: 'Cerrar propuestas y empezar a votar',
    voting: 'Cerrar la votación',
    rating: 'Cerrar puntuación y revelar',
  }[s.phase];
  return `
    <div class="admin-box">
      <div class="section-title">Admin ${info('admin-sesion', 'Cada fase avanza sola cuando participa todo el grupo. Ciérrala a mano solo si alguien no va a participar. Borrar elimina propuestas, votos y notas.')}</div>
      <div class="btn-col">
        ${next ? `<button class="btn ghost" id="adm-next">${next}</button>` : ''}
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
  bindDatePoll(b);
  $app.querySelectorAll('[data-scroll]').forEach((el) => (el.onclick = () => document.querySelector(el.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));

  if (phase === 'proposals') {
    const d = state.drafts.proposal[id];
    const f = document.getElementById('prop-form');
    if (f) {
      f.querySelectorAll('input[name=place]').forEach((r) => (r.onchange = () => { d.placeId = Number(r.value); render(); }));
      const cancel = f.querySelector('#prop-cancel');
      if (cancel) cancel.onclick = () => { d.editing = false; render(); };
      f.querySelector('#add-open').onclick = async () => {
        const res = await searchAndAdd();
        if (res?.result === 'added') { d.placeId = res.pool_id; render(); }
      };
      f.onsubmit = async (e) => {
        e.preventDefault();
        if (!d.placeId) return;
        const btn = f.querySelector('button[type=submit]');
        btn.disabled = true;
        const { error } = await sb.rpc('propose_place', { p_session: id, p_place: d.placeId });
        if (error) { document.getElementById('prop-error').textContent = friendlyError(error); btn.disabled = false; return; }
        state.drafts.proposal[id] = { placeId: null, editing: false, adding: false, name: '', note: '' };
        toast(b.my_proposal ? 'Propuesta cambiada 🤫' : 'Propuesta enviada 🤫');
        flushPush();
        await loadAll().catch(() => {});
        render();
      };
    }
    const edit = document.getElementById('prop-edit');
    if (edit) edit.onclick = () => { Object.assign(d, { editing: true, placeId: null }); render(); };
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
      const ok = await confirmSheet({ title: `¿Borrar el almuerzo ${b.session.number}?`, text: 'Se borrarán sus propuestas, votos y puntuaciones. No se puede deshacer.', okLabel: 'Borrar', danger: true });
      if (!ok) return;
      const { error } = await sb.from('sessions').delete().eq('id', id);
      if (error) return toast(friendlyError(error), true);
      toast('Almuerzo borrado');
      state.boards.delete(id);
      await loadAll().catch(() => {});
      go('#/');
    };
  }
}

function sessionFields(v) {
  return `
    <label class="switch-row"><input type="checkbox" id="f-poll" ${v.poll ? 'checked' : ''}>
      <span class="grow"><strong>📅 Que el grupo elija la fecha</strong><span class="hint">Calendario de sábados y domingos, a la vez que las propuestas</span></span></label>
    <div class="grid-2">
      <div class="field" ${v.poll ? 'hidden' : ''} id="f-date-wrap"><label for="f-date">Fecha</label><input class="input" type="date" id="f-date" value="${esc(v.date || '')}"></div>
      <div class="field"><label for="f-time">Hora <span class="hint">(opc.)</span></label><input class="input" type="time" id="f-time" value="${esc(v.time)}"></div>
    </div>
    <div class="field"><label for="f-note">Nota <span class="hint">(opcional)</span></label>
      <textarea class="input" id="f-note" maxlength="300" placeholder="Dónde quedamos, quién conduce…">${esc(v.note)}</textarea></div>`;
}

function editSessionSheet(s) {
  sheet(`
    <h3>Editar almuerzo ${s.number}</h3>
    <form id="edit-form" novalidate>
      ${sessionFields({ poll: !s.lunch_date, date: s.lunch_date, time: hhmm(s.lunch_time), note: s.note || '' })}
      <div class="error-text" id="edit-error"></div>
      <div class="btn-row"><button type="button" class="btn ghost" data-close>Cancelar</button><button class="btn primary" type="submit">Guardar</button></div>
    </form>`, (root, done) => {
    const pollBox = root.querySelector('#f-poll');
    pollBox.onchange = () => { root.querySelector('#f-date-wrap').hidden = pollBox.checked; };
    root.querySelector('#edit-form').onsubmit = async (e) => {
      e.preventDefault();
      const date = pollBox.checked ? null : root.querySelector('#f-date').value;
      if (!pollBox.checked && !date) { root.querySelector('#edit-error').textContent = 'Pon la fecha o deja que la elija el grupo'; return; }
      const { error } = await sb.from('sessions').update({
        lunch_date: date,
        lunch_time: root.querySelector('#f-time').value || null,
        note: root.querySelector('#f-note').value.trim() || null,
      }).eq('id', s.id);
      if (error) { root.querySelector('#edit-error').textContent = friendlyError(error); return; }
      done(true);
      toast('Almuerzo actualizado');
      await loadAll().catch(() => {});
      render();
    };
  });
}

// ---------- Nuevo almuerzo (solo admin) ----------
function renderNew() {
  const nextNum = (state.sessions[0]?.number || 0) + 1;
  const inAWeek = new Date(Date.now() + 7 * 86400000);
  const v = (state.drafts.newSession ||= { poll: true, date: isoDate(inAWeek), time: '', note: '' });
  const busy = activeSession();
  $app.innerHTML = `
    ${topbar(`Nuevo almuerzo ${nextNum}`, true)}
    <main>
      ${busy ? `<div class="card"><strong>Ya hay un almuerzo en marcha ${info('busy', `Termina el almuerzo ${busy.number} antes de crear otro.`)}</strong></div>` : `
      <div class="section-title" style="margin-top:4px">Datos del almuerzo ${info('nueva', 'Al crearlo se abre el plazo de propuestas para todo el grupo. Si dejas que el grupo elija la fecha, cada uno marca en un calendario los fines de semana que puede. La fecha, la hora y la nota se pueden editar después.')}</div>
      <form class="card" id="new-form" novalidate>
        ${sessionFields(v)}
        <div class="error-text" id="new-error" role="alert"></div>
        <button class="btn primary block" type="submit">Crear almuerzo ${nextNum}</button>
      </form>`}
    </main>
    ${tabbar('home')}`;
  bindCommon();
  const f = document.getElementById('new-form');
  if (!f) return;
  ['date', 'time', 'note'].forEach((k) => (f.querySelector(`#f-${k}`).oninput = (e) => (v[k] = e.target.value)));
  f.querySelector('#f-poll').onchange = (e) => { v.poll = e.target.checked; f.querySelector('#f-date-wrap').hidden = v.poll; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!v.poll && !v.date) { document.getElementById('new-error').textContent = 'Pon la fecha o deja que la elija el grupo'; return; }
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    const { data, error } = await sb.rpc('create_session', { p_date: v.poll ? null : v.date, p_time: v.time || null, p_note: v.note || null });
    if (error) { document.getElementById('new-error').textContent = friendlyError(error); btn.disabled = false; return; }
    state.drafts.newSession = null;
    toast(`Almuerzo ${nextNum} creado`);
    await loadAll().catch(() => {});
    go(`#/s/${data}`);
  };
}

// ---------- Clasificación y gran final ----------
function renderRanking() {
  const lg = state.league;
  const me = state.me.id;
  const weight = Number(lg.score_weight) !== 1 ? ` (× ${num(lg.score_weight, 2)})` : '';
  const rules = `Si gana tu propuesta, <b>+${lg.host_points} puntos</b>. En la gran final se suma la nota de tus sitios${weight} y <b>+${lg.best_site_bonus}</b> a quien propuso el mejor. Quien más sume gana la cena 🍽️.`;

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
      <div class="section-title">Mejores sitios ${info('mejores', 'Nota media de cada sitio ganador, con el detalle por categoría.')}</div>
      <div class="stack-gap">
        ${f.sites.map((st, i) => `
          <div class="card site-row">
            <div class="top">
              <span style="font-size:24px">${['🥇', '🥈', '🥉'][i] || `${i + 1}.`}</span>
              <span class="grow">
                <strong>${esc(st.name)}</strong>
                <span class="hint">Almuerzo ${st.number} · ${esc(shortDate(st.lunch_date))} · de ${esc(st.host_id ? nameOf(st.host_id) : '—')}</span>
              </span>
              <span class="score">${num(st.score, 2)}</span>
            </div>
            ${st.categories.length ? `<div class="cat-bars">
              ${st.categories.map((c) => `<div class="cb"><span class="l"><span>${esc(c.emoji || '')} ${esc(c.label)}</span><b>${num(c.avg)}</b></span><div class="bar"><i style="width:${c.avg * 10}%"></i></div></div>`).join('')}
            </div>` : '<span class="hint">Nadie lo puntuó</span>'}
          </div>`).join('') || '<div class="card empty">Sin sitios puntuados</div>'}
      </div>
      <div class="section-title">Clasificación final ${info('final', rules)}</div>
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
      </div>`;
  } else {
    content = `
      <div class="section-title"><span class="grow">Puntos de victoria ${info('puntos', `${rules} Las notas son secretas hasta la gran final.`)}</span><span class="chip">${lg.closed_count} ${lg.closed_count === 1 ? 'almuerzo cerrado' : 'almuerzos cerrados'}</span></div>
      <div class="card standings">
        ${lg.standings.map((r, i) => `
          <div class="stand-row ${r.user_id === me ? 'me' : ''}">
            <span class="pos">${i + 1}</span>
            ${avatar(person(r.user_id), 'sm')}
            <span class="grow">
              <span class="name">${esc(nameOf(r.user_id))}</span>
              <span class="breakdown">${r.wins ? '🏆'.repeat(Math.min(r.wins, 6)) + ` ${r.wins} ${r.wins === 1 ? 'almuerzo ganado' : 'almuerzos ganados'}` : 'Sin victorias aún'}</span>
            </span>
            <span class="pts">${r.points}<small> pts</small></span>
          </div>`).join('')}
      </div>
      `;
  }

  $app.innerHTML = `
    ${topbar('Clasificación')}
    <main>
      ${content}
      ${isAdmin() ? `
        <div class="admin-box">
          <div class="section-title">Admin ${info('admin-final', lg.final_revealed ? 'Vuelve a esconder las notas y la clasificación final.' : `Muestra a todo el grupo las notas de los sitios y quién gana la cena. Se puede volver a ocultar.${lg.closed_count ? '' : ' Hace falta al menos un almuerzo cerrado.'}`)}</div>
          ${lg.final_revealed
            ? '<button class="btn ghost block" id="adm-final">Ocultar la gran final</button>'
            : `<button class="btn primary block" id="adm-final" ${lg.closed_count ? '' : 'disabled'}>🎉 Revelar la gran final</button>`}
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
          <div class="label-row"><label for="name">Nombre</label>${info('nombre', 'Es como te verá el resto del grupo. Toca la foto de arriba para cambiarla.')}</div>
          <input class="input" id="name" maxlength="40" value="${esc(me.display_name)}" autocomplete="nickname" required>
        </div>
        <button class="btn primary block" type="submit">Guardar</button>
      </form>
      ${isAdmin() ? mapsAdminCard() : ''}
      <div class="section-title">Avisos en este dispositivo ${info('avisos-disp', 'Se activan en cada móvil por separado. Te avisamos si te retan a una batalla y cuando toque votar o puntuar. Sin teléfono ni email.')}</div>
      ${pushSettings()}
      <div class="section-title">El grupo · ${state.profiles.size}</div>
      <div class="card who-list">
        ${members.map((m) => `<div class="who-row">${avatar(m, 'sm')}<span class="name">${esc(m.display_name)}</span><span class="hint">@${esc(m.username)}</span></div>`).join('')}
      </div>
      <div style="margin-top:24px"><button class="btn ghost block" id="logout">Salir</button></div>
    </main>
    ${tabbar('profile')}`;
  bindCommon();
  bindPushCard();
  bindMapsAdmin();

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
    const ok = await confirmSheet({ title: '¿Salir de la app?', text: 'Tendrás que volver a escribir tu usuario y contraseña.', okLabel: 'Salir' });
    if (!ok) return;
    await disablePush().catch(() => {});
    await sb.auth.signOut();
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
// Pool privado y batallas
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const battleById = (id) => state.battles?.battles?.find((b) => b.id === id);
// Batallas en las que me toca hacer algo (girar la ruleta o jugar)
function myBattleActions() {
  return (state.battles?.battles || []).filter((b) =>
    (b.status === 'spin' && b.challenger) || (b.status === 'playing' && !b.finished)).length;
}

// Avisos dentro de la web cuando cambia algo de mis batallas
function detectBattleEvents(prev, next) {
  if (!prev || !next) return;
  const old = new Map(prev.battles.map((b) => [b.id, b]));
  for (const b of next.battles) {
    const o = old.get(b.id);
    if (!o) {
      if (b.parent_id && b.status !== 'resolved') toast(`🤝 ¡Empate en «${b.place_name}»! Hay revancha`);
      else if (!b.challenger && b.status !== 'resolved') toast(`⚔️ ¡Batalla por «${b.place_name}»! Sois ${b.players}`);
      continue;
    }
    if (o.status !== 'resolved' && b.status === 'resolved') {
      toast(b.result === 'win' ? `🏆 ¡Has ganado «${b.place_name}»!` : b.result === 'rematch' ? `🤝 Empate en «${b.place_name}»: revancha` : `💥 Has perdido «${b.place_name}»`);
    } else if (o.status === 'spin' && b.status === 'playing' && !b.challenger) {
      toast(`🎰 Minijuego elegido: ${GAMES[b.game]?.name || b.game}. ¡A jugar!`);
    } else if (b.players > o.players && b.status !== 'resolved') {
      toast(`⚔️ Se une otro rival a «${b.place_name}»: sois ${b.players}`);
    }
  }
}

function updateAppBadge() {
  let n = myBattleActions();
  const act = activeSession();
  const b = act && state.boards.get(act.id);
  if (b && !myStatus(b).done) n++;
  if (b?.date_poll && !b.date_poll.answered) n++;
  try {
    if (!navigator.setAppBadge) return;
    if (n > 0) navigator.setAppBadge(n).catch(() => {}); else navigator.clearAppBadge().catch(() => {});
  } catch { /* no disponible */ }
}

// Buscar en Google Maps y añadir al pool
async function searchAndAdd() {
  if (!state.mapsKey) {
    toast(isAdmin() ? 'Primero configura Google Maps en Perfil' : 'Google Maps aún no está configurado: avisa al admin', true);
    return null;
  }
  const picked = await pickPlace(state.mapsKey);
  if (!picked) return null;
  return addPlace(picked.name, picked.note, picked.place_id);
}

async function addPlace(name, note, placeId = null) {
  const { data, error } = await sb.rpc('add_to_pool', { p_name: name, p_note: note || null, p_place_id: placeId });
  if (error) { toast(friendlyError(error), true); return null; }
  flushPush();
  await loadAll().catch(() => {});
  render();
  if (data.result === 'added') toast('Añadido a tu pool');
  else await battleIntroFlow(data, data.result === 'battle');
  return data;
}

async function battleIntroFlow(data, created) {
  const rivals = data.rivals;
  const rivTxt = `${rivals} ${rivals === 1 ? 'rival anónimo' : 'rivales anónimos'}`;
  const choice = await gameScreen(`
    <div class="big">⚔️</div>
    <h2>¡Batalla!</h2>
    <p>${created ? 'Alguien más tiene' : 'Ya había una batalla en marcha por'} <b>«${esc(data.place_name)}»</b>${created ? ' en su pool' : ''}.</p>
    <p>Te enfrentas a <b>${rivTxt}</b>. Quien gane se queda el sitio; los demás lo pierden.</p>
    ${created ? '<p class="muted">Como la has provocado tú, te toca girar la ruleta.</p>'
      : data.status === 'spin' ? '<p class="muted">Falta que quien la provocó gire la ruleta. Te avisaremos.</p>' : ''}`,
    created ? [{ label: '🎰 Girar la ruleta', value: 'spin', primary: true }, { label: 'Luego', value: 'later' }]
      : data.status === 'playing' ? [{ label: '▶ Jugar ahora', value: 'play', primary: true }, { label: 'Luego', value: 'later' }]
        : [{ label: 'Vale', value: 'later', primary: true }]);
  closeOverlay();
  if (choice === 'spin') await spinFlow(data.battle_id);
  else if (choice === 'play') await playFlow(data.battle_id);
}

async function spinFlow(battleId) {
  const bt = battleById(battleId);
  const rl = rouletteScreen(bt?.place_name || '', Math.max(1, (bt?.players || 2) - 1));
  const outcome = await new Promise((resolve) => {
    rl.onLater(() => resolve('later'));
    rl.onSpin(async () => {
      rl.setBusy(true);
      const { data: game, error } = await sb.rpc('spin_roulette', { p_battle: battleId });
      if (error) { toast(friendlyError(error), true); resolve('later'); return; }
      flushPush();
      await rl.land(game);
      await sleep(800);
      resolve('spun');
    });
  });
  await loadAll().catch(() => {});
  render();
  if (outcome !== 'spun') { closeOverlay(); return; }
  await playFlow(battleId);
}

async function playFlow(battleId) {
  for (;;) {
    const bt = battleById(battleId);
    if (!bt || bt.status !== 'playing' || bt.finished) { closeOverlay(); render(); return; }
    const g = GAMES[bt.game];
    const rivals = bt.players - 1;
    const go = await gameScreen(`
      <div class="big">${g.emoji}</div>
      <div class="eyebrow">«${esc(bt.place_name)}» · contra ${rivals} ${rivals === 1 ? 'rival' : 'rivales'}</div>
      <h2>${g.name}</h2>
      <p>${g.how}</p>
      <div><span class="pill">Intento ${bt.attempts + 1} de 3</span>${bt.best !== null ? `<span class="pill">Tu mejor: ${bt.best}</span>` : ''}</div>
      <p class="muted">Todos jugáis exactamente la misma partida y cuenta vuestro mejor intento. Si cierras la app a mitad, ese intento cuenta 0.</p>`,
    [{ label: '¡Empezar!', value: true, primary: true }, { label: 'Ahora no', value: false }]);
    if (!go) { closeOverlay(); return; }

    const { data: st, error } = await sb.rpc('start_attempt', { p_battle: battleId });
    if (error || !st?.ok) {
      toast(error ? friendlyError(error) : st.reason, true);
      closeOverlay(); await loadAll().catch(() => {}); render(); return;
    }
    const res = await runGame(st.game, st.seed, { attempt: st.attempt });
    const { data: fin, error: e2 } = await sb.rpc('finish_attempt', { p_battle: battleId, p_score: res.score });
    flushPush();
    await loadAll().catch(() => {});
    render();
    if (e2 || !fin?.ok) { toast(e2 ? friendlyError(e2) : fin.reason, true); closeOverlay(); return; }

    const left = fin.attempts_left;
    const buttons = [];
    if (!fin.finished && !fin.resolved && left > 0) {
      buttons.push({ label: `Otro intento (${left === 1 ? 'queda 1' : `quedan ${left}`})`, value: 'again', primary: true });
      buttons.push({ label: `Me planto con ${fin.best} puntos`, value: 'stop' });
      buttons.push({ label: 'Lo sigo luego', value: 'exit' });
    } else {
      buttons.push({ label: fin.resolved ? 'Ver el resultado' : 'Cerrar', value: 'exit', primary: true });
    }
    const choice = await gameScreen(`
      <div class="big">${fin.score > 0 && fin.score >= fin.best ? '🔥' : g.emoji}</div>
      <h2 class="score-big">${fin.score} puntos</h2>
      <p>${esc(res.summary)}</p>
      <div><span class="pill">Tu mejor: ${fin.best}</span><span class="pill">${left === 1 ? 'Te queda 1 intento' : `Te quedan ${left} intentos`}</span></div>
      ${fin.score !== res.score ? '<p class="muted">El servidor ha puesto 0 a este intento (demasiado corto o demasiado largo).</p>' : ''}
      ${fin.resolved ? '<p><b>¡Ya habéis jugado todos! La batalla está resuelta.</b></p>'
        : fin.finished ? '<p class="muted">Has gastado tus intentos. Te avisaremos del resultado.</p>' : ''}`, buttons);
    if (choice === 'again') continue;
    closeOverlay();
    if (choice === 'stop') await call('stop_playing', { p_battle: battleId }, `Te plantas con ${fin.best} puntos`);
    else render();
    return;
  }
}

function battleBoard(bt) {
  if (!bt.board) return '';
  return `<div class="board">${bt.board.map((r, i) => `<span class="pill ${r.me ? 'me' : ''}">${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${r.best ?? '—'}${r.me ? ' (tú)' : ''}</span>`).join('')}</div>`;
}

function battleCard(bt) {
  const g = bt.game ? GAMES[bt.game] : null;
  const rivals = bt.players - 1;
  let status = '', actions = '';
  if (bt.status === 'spin') {
    if (bt.challenger) {
      status = '🎰 Te toca girar la ruleta para elegir el minijuego.';
      actions = `<button class="btn primary" data-spin="${bt.id}">🎰 Girar la ruleta</button>`;
    } else status = '⏳ Esperando a que quien provocó la batalla gire la ruleta…';
  } else if (bt.status === 'playing') {
    if (!bt.finished) {
      const left = 3 - bt.attempts;
      status = `Intentos: <b>${bt.attempts}/3</b>${bt.best !== null ? ` · Tu mejor: <b>${bt.best}</b>` : ''}`;
      actions = `<button class="btn primary" data-play="${bt.id}">▶ ${bt.attempts ? `Jugar (${left === 1 ? 'queda 1' : `quedan ${left}`})` : 'Jugar'}</button>`
        + (bt.attempts && !bt.open_attempt ? `<button class="btn ghost" data-stop="${bt.id}">Me planto</button>` : '');
    } else status = `✅ Has terminado con <b>${bt.best ?? 0}</b> puntos. Esperando a tus rivales…`;
    status += `<br><span class="hint">Rivales que ya han terminado: ${bt.rivals_done} de ${rivals}</span>`;
  } else {
    status = (bt.result === 'win' ? '🏆 <b>¡Ganaste!</b> El sitio es tuyo.'
      : bt.result === 'rematch' ? '🤝 <b>Empate.</b> Se juega una revancha.'
        : '💥 <b>Perdiste.</b> Otro jugador se lo queda.') + battleBoard(bt);
  }
  return `
    <div class="card battle-card ${bt.status} ${bt.result || ''}">
      <div class="bc-head">
        ${bt.place_id ? thumb(bt.place_id, g ? g.emoji : '🎰', 'sm') : `<span class="bc-game">${g ? g.emoji : '🎰'}</span>`}
        <span class="grow">
          <strong>«${esc(bt.place_name)}»</strong>
          <span class="hint">${bt.parent_id ? 'Revancha · ' : ''}contra ${rivals} ${rivals === 1 ? 'rival anónimo' : 'rivales anónimos'}${g ? ` · ${g.name}` : ''}</span>
        </span>
      </div>
      <div class="bc-status">${status}</div>
      ${actions ? `<div class="btn-row">${actions}</div>` : ''}
      ${bt.status !== 'resolved' ? `<button class="link-btn" data-forfeit="${bt.id}" data-name="${esc(bt.place_name)}">Rendirme</button>` : ''}
    </div>`;
}

function renderPool() {
  const B = state.battles || { stats: {}, battles: [] };
  const open = B.battles.filter((x) => x.status !== 'resolved');
  const done = B.battles.filter((x) => x.status === 'resolved');
  $app.innerHTML = `
    ${topbar('Mi pool')}
    <main>
      ${open.length ? `<div class="section-title">Mis batallas ${info('batallas', 'Se abren cuando dos o más tenéis el mismo sitio en el pool. Quien la provoca gira la ruleta; cada uno juega 3 intentos (cuenta el mejor) y quien más puntos saca se queda el sitio. Rendirte es perderlo.')}</div><div class="stack-gap">${open.map(battleCard).join('')}</div>` : ''}
      <div class="section-title"><span class="grow">Mi pool privado · ${state.pool.length} ${info('pool', 'Tus sitios candidatos para proponer; solo los ves tú. Búscalos en Google Maps y ponles un nombre. Si otro ya tiene el mismo sitio, se abre una batalla ⚔️.')}</span></div>
      <div class="card">
        ${mapsNotice()}
        <button class="btn primary block" id="pool-search">🔎 Buscar un sitio en Google Maps</button>
      </div>
      ${state.pool.length ? `<ul class="tiles" style="margin-top:12px">
        ${state.pool.map((p) => `
          <li class="place-tile">
            ${carousel(p.place_id, p.name, { ctx: 'p', fallback: p.battle_id ? '⚔️' : '🍽️' })}
            <div class="tile-foot" ${openAttrs(p.place_id, p.name)}>
              <span class="name">${esc(p.name)}</span>
              <span class="foot-row"><span class="open-hint">Web ↗</span>${p.battle_id ? '<span class="chip">⚔️ En batalla</span>' : p.proposed ? '<span class="chip">✅ Propuesto</span>' : `<button class="icon-btn small" data-remove="${p.id}" data-name="${esc(p.name)}" aria-label="Quitar ${esc(p.name)}">${ICON.x}</button>`}</span>
            </div>
          </li>`).join('')}
      </ul>` : '<div class="card empty" style="margin-top:12px;padding:24px">Tu pool está vacío.</div>'}
      ${done.length ? `<div class="section-title">Batallas terminadas</div><div class="stack-gap">${done.map(battleCard).join('')}</div>` : ''}
      ${isAdmin() && B.admin?.length ? `
        <div class="admin-box">
          <div class="section-title">Admin · batallas abiertas ${info('admin-batallas', 'Solo si una batalla se atasca: «Girar ruleta» la gira por quien la provocó y «Resolver ya» decide con lo jugado hasta ahora. Los jugadores son anónimos también para ti.')}</div>
          ${B.admin.map((a) => `
            <div class="stand-row">
              <span class="grow"><span class="name">Batalla #${a.id} · ${a.players} jugadores</span>
                <span class="breakdown">${a.status === 'spin' ? 'Ruleta sin girar' : `${GAMES[a.game]?.name} · han terminado ${a.done} de ${a.players}`}</span></span>
              <button class="btn ghost small" data-force="${a.id}" data-status="${a.status}">${a.status === 'spin' ? 'Girar ruleta' : 'Resolver ya'}</button>
            </div>`).join('')}
        </div>` : ''}
      <div class="section-title"><span class="grow">🎮 Minijuegos ${info('minijuegos', 'Deciden las batallas: cuando dos o más queréis el mismo sitio, la ruleta elige uno de estos juegos y quien más puntos saca en 3 intentos se queda el sitio. Aquí los pruebas <b>solo para practicar</b>: no cuenta.')}</span><span class="chip">práctica</span></div>
      <div class="card practice">
        <div class="practice-games">
          ${Object.entries(GAMES).map(([k, g]) => `<button class="practice-game" data-practice="${k}"><span>${g.emoji}</span>${esc(g.name)}${practiceBest(k) !== null ? `<small>Récord: ${practiceBest(k)}</small>` : ''}</button>`).join('')}
        </div>
        <button class="btn primary block" data-practice-spin>🎰 Girar la ruleta</button>
      </div>
    </main>
    ${tabbar('pool')}`;
  bindCommon();

  document.getElementById('pool-search').onclick = () => searchAndAdd();
  $app.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = async () => {
    if (await confirmSheet({ title: `¿Quitar «${b.dataset.name}»?`, text: 'Lo borrarás de tu pool.', okLabel: 'Quitar', danger: true })) {
      call('remove_from_pool', { p_place: Number(b.dataset.remove) }, 'Quitado de tu pool');
    }
  }));
  $app.querySelectorAll('[data-spin]').forEach((b) => (b.onclick = () => spinFlow(Number(b.dataset.spin))));
  $app.querySelectorAll('[data-practice]').forEach((b) => (b.onclick = () => practiceFlow(b.dataset.practice)));
  $app.querySelector('[data-practice-spin]').onclick = () => practiceFlow(null);
  $app.querySelectorAll('[data-play]').forEach((b) => (b.onclick = () => playFlow(Number(b.dataset.play))));
  $app.querySelectorAll('[data-stop]').forEach((b) => (b.onclick = async () => {
    const bt = battleById(Number(b.dataset.stop));
    if (await confirmSheet({ title: '¿Te plantas?', text: `Te quedas con ${bt?.best ?? 0} puntos y renuncias a los intentos que te quedan.`, okLabel: 'Me planto' })) {
      call('stop_playing', { p_battle: Number(b.dataset.stop) }, 'Te has plantado');
    }
  }));
  $app.querySelectorAll('[data-forfeit]').forEach((b) => (b.onclick = async () => {
    if (await confirmSheet({ title: '¿Rendirte?', text: `Saldrás de la batalla y perderás «${b.dataset.name}» de tu pool.`, okLabel: 'Me rindo', danger: true })) {
      call('forfeit_battle', { p_battle: Number(b.dataset.forfeit) }, 'Te has rendido 🏳️');
    }
  }));
  $app.querySelectorAll('[data-force]').forEach((b) => (b.onclick = async () => {
    const spin = b.dataset.status === 'spin';
    if (await confirmSheet({ title: spin ? '¿Girar la ruleta por el retador?' : '¿Resolver la batalla ya?', text: spin ? 'Se elegirá el minijuego al azar.' : 'Se decidirá con los intentos jugados hasta ahora.', okLabel: 'Sí' })) {
      call('admin_force_battle', { p_battle: Number(b.dataset.force) }, 'Hecho');
    }
  }));
}



// ---------------------------------------------------------------------------
// Sitios de Google Maps: miniaturas, dirección, atribución y web
// ---------------------------------------------------------------------------
function carousel(placeId, name, { ctx = '', fallback = '🍽️', extra = '' } = {}) {
  const info = placeId && state.placeInfo.get(placeId);
  const attrs = `${placeId ? `data-car="${esc(placeId)}"` : ''} data-ctx="${ctx}" ${openAttrs(placeId, name)}`;
  return carouselHTML(info?.photos, { fallback, extra, attrs });
}
function thumb(placeId, fallback = '🍽️', size = '') {
  const ph = placeId && state.placeInfo.get(placeId)?.photos?.[0];
  const img = ph ? `style="background-image:url('${esc(ph.url)}')" title="${esc(ph.author ? `Foto: ${ph.author} · Google Maps` : 'Google Maps')}"` : '';
  return `<span class="thumb ${size} ${img ? 'has-photo' : ''}" ${placeId ? `data-thumb="${esc(placeId)}"` : ''} ${img} aria-hidden="true"><span>${fallback}</span></span>`;
}
function openAttrs(placeId, name) {
  return placeId ? `data-open="${esc(placeId)}" data-name="${esc(name)}" role="link" tabindex="0"` : `data-open-name="${esc(name)}" role="link" tabindex="0"`;
}
// Descripción corta del sitio (se rellena al llegar de Google; vacía si Google no tiene nada)
function placeDesc(placeId) {
  if (!placeId) return '';
  const info = state.placeInfo.get(placeId);
  const html = info && 'desc' in info ? descHTML(info.desc) : '';
  return `<span class="desc ${info && 'desc' in info && !html ? 'none' : ''}" data-desc="${esc(placeId)}">${html}</span>`;
}
function winnerPhoto(b) {
  const w = b.proposals.find((p) => p.id === b.session.winner_proposal_id);
  if (!w?.place_id) return '';
  return `<div class="hero-car">${carousel(w.place_id, w.name, { ctx: 'w', extra: '<span class="hero-link">Web y carta ↗</span>' })}</div>`;
}
function mapsNotice() {
  if (state.mapsKey) return '';
  return `<p class="hint" style="margin:0 0 10px">⚠️ Google Maps aún no está configurado. ${isAdmin() ? 'Configúralo en <b>Perfil</b>.' : 'Avisa al admin.'}</p>`;
}

// Rellena las fotos de lo que hay en pantalla y activa los carruseles
state.placeInfo = new Map();
function hydratePlaces() {
  $app.querySelectorAll('.carousel').forEach((el) => { el._photos = state.placeInfo.get(el.dataset.car)?.photos; bindCarousel(el); });
  if (!state.mapsKey) return;
  const ids = new Set(), withDesc = new Set();
  $app.querySelectorAll('[data-thumb],[data-car]').forEach((el) => ids.add(el.dataset.thumb || el.dataset.car));
  $app.querySelectorAll('[data-desc]').forEach((el) => { ids.add(el.dataset.desc); withDesc.add(el.dataset.desc); });
  for (const id of ids) {
    const have = state.placeInfo.get(id);
    const details = withDesc.has(id);
    if (have && (!details || 'desc' in have)) continue;
    placeInfo(state.mapsKey, id, { details }).then((info) => {
      if (!info) return;
      state.placeInfo.set(id, info);
      applyPlaceInfo(id, info);
    }).catch(() => {});
  }
}
function applyPlaceInfo(id, info) {
  if ('desc' in info) {
    const html = descHTML(info.desc);
    $app.querySelectorAll(`[data-desc="${CSS.escape(id)}"]`).forEach((el) => { el.innerHTML = html; el.classList.toggle('none', !html); });
  }
  const first = info.photos?.[0];
  if (!first) return;
  $app.querySelectorAll(`[data-thumb="${CSS.escape(id)}"]`).forEach((el) => {
    el.style.backgroundImage = `url("${first.url}")`;
    el.classList.add('has-photo');
    el.title = first.author ? `Foto: ${first.author} · Google Maps` : 'Google Maps';
  });
  $app.querySelectorAll(`.carousel[data-car="${CSS.escape(id)}"]`).forEach((el) => {
    // Si ya tiene estas mismas fotos (p. ej. solo llegaba la descripción), no se toca
    if (el._photos && el._photos.length === info.photos.length && el._photos.every((ph, i) => ph.url === info.photos[i].url)) return;
    const extra = [...el.querySelectorAll('.car-pos,.car-move,.hero-link')].map((x) => x.outerHTML).join('');
    const attrs = [...el.attributes].filter((a) => a.name !== 'class' && a.name !== 'data-bound').map((a) => `${a.name}="${esc(a.value)}"`).join(' ');
    const tmp = document.createElement('div');
    tmp.innerHTML = carouselHTML(info.photos, { extra, attrs });
    const fresh = tmp.firstElementChild;
    fresh._photos = info.photos;
    el.replaceWith(fresh);
    bindCarousel(fresh);
  });
}

// Tocar una tarjeta → web del sitio (o su ficha de Google Maps si no tiene web)
function openPlace(placeId, name) {
  if (!placeId) { window.open(mapsSearchURL(name), '_blank', 'noopener'); return; }
  const known = openPlace.cache.get(placeId);
  if (known) { window.open(known, '_blank', 'noopener'); return; }
  // Se abre la pestaña ya (dentro del toque) y se le pone la dirección al saberla
  const w = window.open('', '_blank');
  if (w) { try { w.document.title = name || 'Abriendo…'; w.document.body.innerHTML = '<p style="font:16px system-ui;padding:24px">Abriendo la web del sitio…</p>'; } catch { /* distinto origen */ } }
  placeLinks(state.mapsKey, placeId).then(({ website, maps }) => {
    const url = website || maps || mapsSearchURL(name);
    openPlace.cache.set(placeId, url);
    if (!website) toast('Este sitio no tiene web: te abro su ficha de Google Maps');
    if (w && !w.closed) w.location.href = url;
    else placeLinkSheet(name, url, !!website);
  }).catch(() => {
    const url = mapsSearchURL(name);
    if (w && !w.closed) w.location.href = url;
    else placeLinkSheet(name, url, false);
  });
}
openPlace.cache = new Map();
function placeLinkSheet(name, url, isWeb) {
  sheet(`
    <h3>${esc(name)}</h3>
    <p>${isWeb ? 'Abre su web para ver la carta.' : 'No tiene web: mira su ficha en Google Maps.'}</p>
    <div class="btn-col">
      <a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener" data-close-after>${isWeb ? '🌐 Abrir la web' : '📍 Abrir en Google Maps'}</a>
      <button class="btn ghost" data-close>Cerrar</button>
    </div>`, (root, done) => { root.querySelector('[data-close-after]').addEventListener('click', () => setTimeout(() => done(true), 100)); });
}
$app.addEventListener('click', (e) => {
  const card = e.target.closest('[data-open],[data-open-name]');
  if (!card || e.target.closest('button, a, input, label.pick')) return;
  openPlace(card.dataset.open || null, card.dataset.name || card.dataset.openName);
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const card = e.target.closest?.('[data-open],[data-open-name]');
  if (card && e.target === card) openPlace(card.dataset.open || null, card.dataset.name || card.dataset.openName);
});
onMapsAuthError(() => toast('La clave de Google Maps no es válida o no permite esta web', true));

// Admin: clave de Google Maps (la pega el admin; es una clave pública restringida a esta web)
function mapsAdminCard() {
  const on = !!state.mapsKey;
  return `
    <div class="section-title">Admin · Google Maps ${info('maps', 'Sirve para buscar sitios, ver sus fotos y descripción y abrir su web. Pega una <b>clave de navegador</b> de Google Maps restringida a esta web.')}</div>
    <div class="card">
      <strong>${on ? '✅ Google Maps configurado' : '⚠️ Falta la clave de Google Maps'}</strong>
      <div class="field" style="margin:12px 0 10px">
        <input class="input" id="maps-key" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
               placeholder="${on ? 'Pega una clave nueva para cambiarla' : 'AIza…'}">
      </div>
      <div class="btn-row">
        <button class="btn primary small" id="maps-save">Guardar clave</button>
        ${on ? '<button class="btn ghost small" id="maps-test">Probar buscador</button>' : ''}
      </div>
    </div>`;
}
function bindMapsAdmin() {
  const save = document.getElementById('maps-save');
  if (!save) return;
  save.onclick = async () => {
    const v = document.getElementById('maps-key').value.trim();
    if (!/^[A-Za-z0-9_-]{20,60}$/.test(v)) return toast('Eso no parece una clave de Google Maps', true);
    const { error } = await sb.from('app_config').update({ maps_key: v, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) return toast(friendlyError(error), true);
    const changed = state.mapsKey && state.mapsKey !== v;
    state.mapsKey = v;
    toast(changed ? 'Clave guardada. Cierra y abre la app para usarla' : 'Clave guardada ✅');
    render();
  };
  const test = document.getElementById('maps-test');
  if (test) test.onclick = () => pickPlace(state.mapsKey, { title: 'Prueba', button: 'Cerrar (es solo una prueba)' });
}

// ---------------------------------------------------------------------------
// Modo entrenamiento (no toca el servidor; récord personal en este móvil)
// ---------------------------------------------------------------------------
function practiceBest(game) {
  const v = lsGet(`almuerzos-best2-${game}`);
  return v === null ? null : Number(v);
}
async function practiceFlow(game) {
  if (!game) {
    const rl = rouletteScreen('', 0, { practice: true });
    const spun = await new Promise((resolve) => {
      rl.onLater(() => resolve(null));
      rl.onSpin(async () => {
        rl.setBusy(true);
        const g = Object.keys(GAMES)[Math.floor(Math.random() * Object.keys(GAMES).length)];
        await rl.land(g);
        await sleep(800);
        resolve(g);
      });
    });
    if (!spun) { closeOverlay(); render(); return; }
    game = spun;
  }
  let round = 1;
  for (;;) {
    const g = GAMES[game];
    const best = practiceBest(game);
    const go = await gameScreen(`
      <div class="big">${g.emoji}</div>
      <div class="eyebrow">🎮 Entrenamiento</div>
      <h2>${g.name}</h2>
      <p>${g.how}</p>
      ${best !== null ? `<div><span class="pill">Tu récord: ${best}</span></div>` : ''}
      <p class="muted">En una batalla de verdad tendrás 3 intentos y cuenta el mejor.</p>`,
    [{ label: '¡Empezar!', value: true, primary: true }, { label: 'Salir', value: false }]);
    if (!go) break;
    const res = await runGame(game, Math.floor(Math.random() * 2147483646) + 1, { label: `entrenamiento ${round}` });
    const record = best === null || res.score > best;
    if (record) lsSet(`almuerzos-best2-${game}`, String(res.score));
    const next = await gameScreen(`
      <div class="big">${record && res.score > 0 ? '🏅' : g.emoji}</div>
      <h2 class="score-big">${res.score} puntos</h2>
      <p>${esc(res.summary)}</p>
      <div><span class="pill">${record ? (best === null ? 'Primer récord' : '¡Nuevo récord!') : `Récord: ${best}`}</span></div>`,
    [{ label: 'Otra vez', value: 'again', primary: true }, { label: '🎰 Otro juego', value: 'spin' }, { label: 'Salir', value: 'exit' }]);
    if (next === 'again') { round++; continue; }
    if (next === 'spin') { closeOverlay(); return practiceFlow(null); }
    break;
  }
  closeOverlay();
  render();
}

// ---------------------------------------------------------------------------
// Avisos push (iPhone con la web en inicio y Android)
// ---------------------------------------------------------------------------
const PUSH_FN = `${SUPABASE_URL}/functions/v1/push`;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let swReg = null;

function pushStatus() {
  if (isIOS() && !isStandalone()) return 'ios-install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return state.pushOn ? 'on' : 'off';
}
function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function vapidKey() {
  const r = await fetch(PUSH_FN, { headers: { apikey: SUPABASE_KEY } });
  const j = await r.json();
  if (!j.publicKey) throw new Error(j.error || 'El servidor de avisos no responde');
  return j.publicKey;
}
async function enablePush(interactive) {
  if (!pushSupported()) return false;
  if (interactive) {
    const perm = await Notification.requestPermission();   // debe ser lo primero tras el toque (iPhone)
    if (perm !== 'granted') { toast('Sin permiso no te podemos avisar', true); return false; }
  } else if (Notification.permission !== 'granted') return false;
  const reg = swReg || (await navigator.serviceWorker.ready);
  const key = await vapidKey();
  let sub = await reg.pushManager.getSubscription();
  if (sub && lsGet('almuerzos-vapid') !== key) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  const j = sub.toJSON();
  const { error } = await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  if (error) throw error;
  lsSet('almuerzos-vapid', key);
  state.pushOn = true;
  return true;
}
async function disablePush() {
  if (!pushSupported()) return;
  const reg = swReg || (await navigator.serviceWorker.getRegistration());
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await sb.rpc('delete_push_subscription', { p_endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => {});
  }
  state.pushOn = false;
}
// Envía los avisos que acaba de provocar este usuario (la función solo recoge los suyos)
function flushPush() {
  if (!state.session) return;
  sb.functions.invoke('push', { body: {} }).catch(() => {});
}
async function setupPush() {
  try {
    if ('serviceWorker' in navigator) {
      swReg = await navigator.serviceWorker.register('./sw.js');
      navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'go' && e.data.url) go(e.data.url); });
    }
    if (pushSupported() && Notification.permission === 'granted') await enablePush(false);
  } catch (e) { console.warn('avisos', e); }
  flushPush();
  render();
}

function pushCard(where) {
  const st = pushStatus();
  if (st === 'on' || st === 'unsupported') return '';
  if (where === 'home' && (lsGet('almuerzos-push-dismiss') || st === 'denied')) return '';
  const later = where === 'home' ? '<button class="btn ghost small" data-push-dismiss>Ahora no</button>' : '';
  if (st === 'ios-install') return `
    <div class="card push-card">
      <strong>🔔 Añade la app a tu pantalla de inicio para recibir avisos ${info(`push-ios-${where}`, 'En Safari toca <b>Compartir → Añadir a pantalla de inicio</b>. Abre la app desde ese icono y actívalos aquí. Te avisaremos de batallas y de cuándo toca votar o puntuar.')}</strong>
      ${later ? `<div class="btn-row" style="margin-top:12px">${later}</div>` : ''}
    </div>`;
  if (st === 'denied') return `
    <div class="card push-card"><strong>🔕 Avisos bloqueados ${info(`push-denied-${where}`, 'Los has bloqueado para esta web. Actívalos en los ajustes del móvil (Notificaciones) y vuelve aquí.')}</strong></div>`;
  return `
    <div class="card push-card">
      <strong>🔔 Activa los avisos ${info(`push-${where}`, 'Te avisamos si te retan a una batalla y cuando toque votar o puntuar. Sin teléfono ni email.')}</strong>
      <div class="btn-row" style="margin-top:12px"><button class="btn primary small" data-push-on>Activar avisos</button>${later}</div>
    </div>`;
}
function pushSettings() {
  if (pushStatus() !== 'on') return pushCard('profile') || '<div class="card"><p class="hint" style="margin:0">Este navegador no admite avisos.</p></div>';
  return `
    <div class="card">
      <strong>✅ Avisos activados en este dispositivo</strong>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn ghost small" data-push-test>Enviar aviso de prueba</button>
        <button class="btn ghost small" data-push-off>Desactivar</button>
      </div>
    </div>`;
}
function bindPushCard() {
  $app.querySelectorAll('[data-push-on]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { if (await enablePush(true)) toast('🔔 Avisos activados'); } catch (e) { toast(friendlyError(e), true); }
    render();
  }));
  $app.querySelectorAll('[data-push-dismiss]').forEach((b) => (b.onclick = () => { lsSet('almuerzos-push-dismiss', '1'); render(); }));
  $app.querySelectorAll('[data-push-off]').forEach((b) => (b.onclick = async () => {
    try { await disablePush(); toast('Avisos desactivados'); } catch (e) { toast(friendlyError(e), true); }
    render();
  }));
  $app.querySelectorAll('[data-push-test]').forEach((b) => (b.onclick = async () => {
    const { error } = await sb.rpc('push_test');
    if (error) return toast(friendlyError(error), true);
    const { data, error: e2 } = await sb.functions.invoke('push', { body: {} });
    if (e2) return toast('No se pudo enviar el aviso', true);
    toast(data?.sent ? '🔔 Aviso enviado: debería llegarte en unos segundos' : 'No se ha podido entregar el aviso', !data?.sent);
  }));
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function onSession(session) {
  const prevUser = state.session?.user?.id;
  state.session = session;
  if (!session) {
    unsubscribe();
    Object.assign(state, { me: null, loaded: false, sessions: [], league: null, profiles: new Map(), boards: new Map(), moves: new Map(), pool: [], battles: null, pushOn: false });
    closeOverlay();
    updateAppBadge();
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
  setupPush();
}

sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => onSession(session), 0);
});
