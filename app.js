import { SUPABASE_URL, SUPABASE_KEY, EMAIL_DOMAIN } from './config.js';

// ---------------------------------------------------------------------------
// Cliente Supabase (la sesión se guarda en el móvil y se renueva sola)
// ---------------------------------------------------------------------------
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'almuerzos-auth', detectSessionInUrl: false },
});

const $app = document.getElementById('app');
const state = {
  session: null,
  me: null,
  profiles: new Map(),
  polls: [],
  options: [],
  votes: [],
  loaded: false,
  channel: null,
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
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

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
function ago(iso) {
  const s = (new Date(iso) - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
  return 'ahora mismo';
}

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 2600);
}

function friendlyError(err) {
  const m = (err && (err.message || err.error_description || String(err))) || 'Error';
  if (/Invalid login credentials/i.test(m)) return 'Usuario o contraseña incorrectos';
  if (/Email not confirmed/i.test(m)) return 'Este usuario aún no está confirmado';
  if (/network|fetch/i.test(m)) return 'Sin conexión. Inténtalo de nuevo';
  if (/JWT|expired/i.test(m)) return 'La sesión ha caducado, vuelve a entrar';
  return m;
}

function confirmSheet({ title, text, okLabel = 'Aceptar', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('sheet-root');
    root.innerHTML = `
      <div class="sheet-backdrop" data-close>
        <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
          <h3 id="sheet-title">${esc(title)}</h3>
          <p>${esc(text)}</p>
          <div class="btn-row">
            <button class="btn ghost" data-close>Cancelar</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button>
          </div>
        </div>
      </div>`;
    const done = (v) => { root.innerHTML = ''; resolve(v); };
    root.querySelector('[data-ok]').onclick = () => done(true);
    root.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', (e) => { if (e.target === el) done(false); }));
  });
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------
async function loadAll() {
  const [pr, po, op, vo] = await Promise.all([
    sb.from('profiles').select('id, username, display_name, avatar_url, is_admin'),
    sb.from('polls').select('*').order('created_at', { ascending: false }),
    sb.from('poll_options').select('*').order('position'),
    sb.from('votes').select('id, poll_id, user_id, option_id, score, updated_at'),
  ]);
  const err = pr.error || po.error || op.error || vo.error;
  if (err) throw err;
  state.profiles = new Map(pr.data.map((p) => [p.id, p]));
  state.me = state.profiles.get(state.session.user.id) || null;
  state.polls = po.data;
  state.options = op.data;
  state.votes = vo.data;
  state.loaded = true;
}

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try { await loadAll(); render(); } catch (e) { console.warn(e); }
  }, 200);
}

function subscribe() {
  if (state.channel) return;
  state.channel = sb.channel('almuerzos-live');
  for (const table of ['polls', 'poll_options', 'votes', 'profiles']) {
    state.channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleReload);
  }
  state.channel.subscribe();
}
function unsubscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = null;
}

// Al volver a la app en el móvil, refrescamos por si se perdió algún evento
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session) scheduleReload();
});

const isAdmin = () => !!state.me?.is_admin;
const pollVotes = (pollId) => state.votes.filter((v) => v.poll_id === pollId);
const myVote = (pollId) => state.votes.find((v) => v.poll_id === pollId && v.user_id === state.session.user.id);
const members = () => [...state.profiles.values()].sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));

// ---------------------------------------------------------------------------
// Router (#/, #/v/12, #/perfil, #/nueva)
// ---------------------------------------------------------------------------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, id] = h.split('/');
  if (name === 'v' && id) return { name: 'poll', id: Number(id) };
  if (name === 'perfil') return { name: 'profile' };
  if (name === 'nueva') return { name: 'new' };
  return { name: 'home' };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

function topbar({ title, back = false }) {
  return `
    <header class="topbar">
      ${back ? `<button class="icon-btn" data-go="#/" aria-label="Volver">${ICON.back}</button>` : ''}
      <h1>${title}</h1>
      <button class="avatar-btn" data-go="#/perfil" aria-label="Mi perfil">${avatar(state.me, 'sm')}</button>
    </header>`;
}

function bindCommon() {
  $app.querySelectorAll('[data-go]').forEach((el) => (el.onclick = () => go(el.dataset.go)));
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------
function render() {
  if (!state.session) return renderLogin();
  if (!state.loaded) { $app.innerHTML = '<div class="splash"><div class="spinner"></div></div>'; return; }
  if (!state.me) return renderNoProfile();
  const r = route();
  if (r.name === 'poll') return renderPoll(r.id);
  if (r.name === 'profile') return renderProfile();
  if (r.name === 'new' && isAdmin()) return renderNew();
  return renderHome();
}

function renderLogin() {
  $app.innerHTML = `
    <section class="login">
      <div class="logo" aria-hidden="true">🥖</div>
      <h1>Almuerzos <span>Muy Tochos</span></h1>
      <p class="sub">Las votaciones del grupo. Entra con tu usuario.</p>
      <form id="login-form" novalidate>
        <div class="field">
          <label for="user">Usuario</label>
          <div class="input-prefix">
            <input class="input" id="user" name="user" autocomplete="username" autocapitalize="none"
                   autocorrect="off" spellcheck="false" inputmode="text" placeholder="ana" required>
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
    if (error) {
      errEl.textContent = friendlyError(error);
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  };
}

function renderNoProfile() {
  $app.innerHTML = `
    <section class="login">
      <div class="logo">🤔</div>
      <h1>Falta tu perfil</h1>
      <p class="sub">Tu usuario existe pero no tiene perfil. Avisa al admin.</p>
      <button class="btn ghost block" id="logout">Salir</button>
    </section>`;
  document.getElementById('logout').onclick = () => sb.auth.signOut();
}

function pollCard(p) {
  const n = pollVotes(p.id).length;
  const mine = myVote(p.id);
  const voters = pollVotes(p.id).slice(0, 6).map((v) => avatar(state.profiles.get(v.user_id), 'xs')).join('');
  const status = p.is_open
    ? (mine ? '<span class="chip voted">✓ Has votado</span>' : '<span class="chip pending">Te falta votar</span>')
    : '<span class="chip">Cerrada</span>';
  return `
    <a class="poll-item ${p.is_open ? '' : 'closed'}" href="#/v/${p.id}">
      <div class="meta">
        <span class="chip ${p.kind === 'score' ? 'accent' : ''}">${p.kind === 'score' ? 'Puntuar 1–10' : 'Elegir opción'}</span>
        ${status}
      </div>
      <h3>${esc(p.title)}</h3>
      <div class="meta">
        <div class="stack">${voters}</div>
        <span class="grow">${n} ${n === 1 ? 'voto' : 'votos'}</span>
        <span>${ago(p.is_open ? p.created_at : (p.closed_at || p.created_at))}</span>
      </div>
    </a>`;
}

function renderHome() {
  const open = state.polls.filter((p) => p.is_open);
  const closed = state.polls.filter((p) => !p.is_open)
    .sort((a, b) => new Date(b.closed_at || b.created_at) - new Date(a.closed_at || a.created_at));
  $app.innerHTML = `
    ${topbar({ title: 'Almuerzos <span>Muy Tochos</span>' })}
    <main>
      ${isAdmin() ? `<button class="btn primary fab" data-go="#/nueva">${ICON.plus} Nueva votación</button>` : ''}
      ${state.polls.length === 0 ? `
        <div class="empty"><div class="big">🍽️</div>Todavía no hay votaciones.${isAdmin() ? '<br>Crea la primera.' : ''}</div>` : ''}
      ${open.length ? `<div class="section-title">Abiertas · <span class="live">en directo</span></div>
        <div class="poll-list">${open.map(pollCard).join('')}</div>` : ''}
      ${closed.length ? `<div class="section-title">Cerradas</div>
        <div class="poll-list">${closed.map(pollCard).join('')}</div>` : ''}
    </main>`;
  bindCommon();
}

function renderPoll(id) {
  const p = state.polls.find((x) => x.id === id);
  if (!p) {
    $app.innerHTML = `${topbar({ title: 'Votación', back: true })}
      <main><div class="empty"><div class="big">🫥</div>Esta votación ya no existe.</div></main>`;
    bindCommon();
    return;
  }
  const votes = pollVotes(p.id);
  const mine = myVote(p.id);
  const all = members();
  const votedIds = new Set(votes.map((v) => v.user_id));
  const missing = all.filter((m) => !votedIds.has(m.id));
  const canVote = p.is_open;

  let body = '';
  if (p.kind === 'choice') {
    const opts = state.options.filter((o) => o.poll_id === p.id);
    const counts = new Map(opts.map((o) => [o.id, votes.filter((v) => v.option_id === o.id)]));
    const max = Math.max(0, ...[...counts.values()].map((a) => a.length));
    body = `<div class="choices" role="list">
      ${opts.map((o) => {
        const vs = counts.get(o.id);
        const pct = votes.length ? Math.round((vs.length / votes.length) * 100) : 0;
        const isMine = mine?.option_id === o.id;
        const winner = !p.is_open && max > 0 && vs.length === max;
        return `
          <div role="listitem">
            <button class="choice ${isMine ? 'mine' : ''} ${winner ? 'winner' : ''}" data-option="${o.id}"
                    ${canVote ? '' : 'disabled'} aria-pressed="${isMine}">
              <span class="fill" style="width:${pct}%"></span>
              ${canVote ? '<span class="check"></span>' : ''}
              <span class="label">${esc(o.label)}</span>
              <span class="count">${vs.length}</span>
              <span class="pct">${pct}%</span>
            </button>
            ${vs.length ? `<div class="voters">${vs.map((v) => avatar(state.profiles.get(v.user_id), 'xs')).join('')}</div>` : ''}
          </div>`;
      }).join('')}
    </div>`;
  } else {
    const scores = votes.map((v) => v.score);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const dist = Array.from({ length: 10 }, (_, i) => scores.filter((s) => s === i + 1).length);
    const dmax = Math.max(1, ...dist);
    body = `
      ${canVote ? `
        <div class="section-title">${mine ? 'Tu nota (puedes cambiarla)' : 'Pon tu nota'}</div>
        <div class="scores">
          ${Array.from({ length: 10 }, (_, i) => i + 1).map((n) =>
            `<button class="score-btn ${mine?.score === n ? 'mine' : ''}" data-score="${n}" aria-pressed="${mine?.score === n}">${n}</button>`).join('')}
        </div>` : ''}
      <div class="section-title">Resultado</div>
      <div class="card">
        <div class="avg">
          <span class="num">${avg === null ? '–' : avg.toLocaleString('es', { maximumFractionDigits: 1 })}</span>
          <span class="of">/ 10 · ${scores.length} ${scores.length === 1 ? 'voto' : 'votos'}</span>
        </div>
        <div class="dist" aria-label="Distribución de notas">
          ${dist.map((c, i) => `
            <div class="col">
              <span class="n">${c || ''}</span>
              <div class="bar ${c ? '' : 'zero'}" style="height:${c ? Math.max(8, (c / dmax) * 100) : 2}%"></div>
              <span class="lbl">${i + 1}</span>
            </div>`).join('')}
        </div>
        ${votes.length ? `<div class="who">
          ${votes.slice().sort((a, b) => b.score - a.score).map((v) => {
            const pr = state.profiles.get(v.user_id);
            return `<div class="who-row">${avatar(pr, 'sm')}<span class="name">${esc(pr?.display_name)}</span><span class="val">${v.score}</span></div>`;
          }).join('')}
        </div>` : ''}
      </div>`;
  }

  $app.innerHTML = `
    ${topbar({ title: 'Votación', back: true })}
    <main>
      <div class="poll-head">
        <div class="meta">
          <span class="chip ${p.kind === 'score' ? 'accent' : ''}">${p.kind === 'score' ? 'Puntuar 1–10' : 'Elegir opción'}</span>
          ${p.is_open ? '<span class="chip open">Abierta</span> <span class="live">en directo</span>' : `<span class="chip">Cerrada ${p.closed_at ? ago(p.closed_at) : ''}</span>`}
        </div>
        <h2>${esc(p.title)}</h2>
        ${p.description ? `<p>${esc(p.description)}</p>` : ''}
      </div>
      ${p.kind === 'choice' && canVote ? `<div class="section-title">${mine ? 'Tu voto (puedes cambiarlo)' : 'Elige una opción'}</div>` : ''}
      ${body}
      <p class="progress">Han votado <strong>${votes.length}</strong> de <strong>${all.length}</strong></p>
      ${p.is_open && missing.length ? `<div class="missing"><span class="hint">Faltan:</span>${missing.map((m) => avatar(m, 'xs')).join('')}</div>` : ''}
      ${isAdmin() ? `
        <div class="admin-box">
          <div class="section-title">Admin</div>
          <div class="btn-row">
            <button class="btn ghost" id="toggle">${p.is_open ? 'Cerrar votación' : 'Reabrir'}</button>
            <button class="btn danger" id="delete">Borrar</button>
          </div>
        </div>` : ''}
    </main>`;
  bindCommon();

  $app.querySelectorAll('[data-option]').forEach((b) => (b.onclick = () => castVote(p, { option_id: Number(b.dataset.option) })));
  $app.querySelectorAll('[data-score]').forEach((b) => (b.onclick = () => castVote(p, { score: Number(b.dataset.score) })));

  if (isAdmin()) {
    document.getElementById('toggle').onclick = async () => {
      if (p.is_open) {
        const ok = await confirmSheet({ title: '¿Cerrar la votación?', text: 'Nadie podrá votar ni cambiar su voto. Podrás reabrirla.', okLabel: 'Cerrar' });
        if (!ok) return;
      }
      const { error } = await sb.from('polls').update({ is_open: !p.is_open }).eq('id', p.id);
      if (error) return toast(friendlyError(error), true);
      toast(p.is_open ? 'Votación cerrada' : 'Votación reabierta');
      scheduleReload();
    };
    document.getElementById('delete').onclick = async () => {
      const ok = await confirmSheet({ title: '¿Borrar la votación?', text: `Se borrará «${p.title}» con todos sus votos. No se puede deshacer.`, okLabel: 'Borrar', danger: true });
      if (!ok) return;
      const { error } = await sb.from('polls').delete().eq('id', p.id);
      if (error) return toast(friendlyError(error), true);
      state.polls = state.polls.filter((x) => x.id !== p.id);
      toast('Votación borrada');
      go('#/');
    };
  }
}

async function castVote(poll, value) {
  const uid = state.session.user.id;
  const prev = myVote(poll.id);
  if (prev && ((value.option_id && prev.option_id === value.option_id) || (value.score && prev.score === value.score))) return;
  const row = { poll_id: poll.id, user_id: uid, option_id: value.option_id ?? null, score: value.score ?? null };
  // Actualización optimista: se ve al instante
  state.votes = state.votes.filter((v) => !(v.poll_id === poll.id && v.user_id === uid)).concat({ ...row, id: prev?.id ?? -1 });
  render();
  const { error } = await sb.from('votes').upsert(row, { onConflict: 'poll_id,user_id' });
  if (error) { toast(friendlyError(error), true); scheduleReload(); return; }
  if (navigator.vibrate) navigator.vibrate(12);
  toast(prev ? 'Voto cambiado' : '¡Voto registrado!');
}

function renderNew() {
  const draft = renderNew.draft ||= { title: '', description: '', kind: 'choice', options: ['', ''] };
  $app.innerHTML = `
    ${topbar({ title: 'Nueva votación', back: true })}
    <main>
      <form id="new-form" class="card" novalidate>
        <div class="field">
          <label for="title">Pregunta</label>
          <input class="input" id="title" maxlength="120" placeholder="¿Dónde almorzamos el sábado?" value="${esc(draft.title)}" required>
        </div>
        <div class="field">
          <label for="desc">Detalles <span class="hint">(opcional)</span></label>
          <textarea class="input" id="desc" maxlength="500" placeholder="Hora, lugar, lo que sea…">${esc(draft.description)}</textarea>
        </div>
        <div class="field">
          <label>Tipo</label>
          <div class="segmented" role="group" aria-label="Tipo de votación">
            <button type="button" data-kind="choice" aria-pressed="${draft.kind === 'choice'}">Elegir opción</button>
            <button type="button" data-kind="score" aria-pressed="${draft.kind === 'score'}">Puntuar 1–10</button>
          </div>
        </div>
        ${draft.kind === 'choice' ? `
          <div class="field">
            <label>Opciones</label>
            <div id="opts">
              ${draft.options.map((o, i) => `
                <div class="opt-row">
                  <input class="input" data-opt="${i}" maxlength="80" placeholder="Opción ${i + 1}" value="${esc(o)}">
                  ${draft.options.length > 2 ? `<button type="button" class="icon-btn" data-del="${i}" aria-label="Quitar opción">${ICON.x}</button>` : ''}
                </div>`).join('')}
            </div>
            <button type="button" class="btn ghost" id="add-opt">${ICON.plus} Añadir opción</button>
          </div>` : `<p class="hint">Cada uno pondrá una nota del 1 al 10 y verás la media en directo.</p>`}
        <div class="error-text" id="new-error" role="alert"></div>
        <button class="btn primary block" type="submit">Crear votación</button>
      </form>
    </main>`;
  bindCommon();
  const f = document.getElementById('new-form');
  const sync = () => {
    draft.title = f.querySelector('#title').value;
    draft.description = f.querySelector('#desc').value;
    f.querySelectorAll('[data-opt]').forEach((el) => (draft.options[Number(el.dataset.opt)] = el.value));
  };
  f.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { sync(); draft.kind = b.dataset.kind; renderNew(); }));
  f.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { sync(); draft.options.splice(Number(b.dataset.del), 1); renderNew(); }));
  const add = f.querySelector('#add-opt');
  if (add) add.onclick = () => {
    sync(); draft.options.push(''); renderNew();
    const inputs = document.querySelectorAll('[data-opt]'); inputs[inputs.length - 1]?.focus();
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    sync();
    const err = document.getElementById('new-error');
    const title = draft.title.trim();
    const options = draft.options.map((o) => o.trim()).filter(Boolean);
    if (!title) { err.textContent = 'Escribe la pregunta'; return; }
    if (draft.kind === 'choice' && options.length < 2) { err.textContent = 'Pon al menos 2 opciones'; return; }
    if (draft.kind === 'choice' && new Set(options.map((o) => o.toLowerCase())).size !== options.length) { err.textContent = 'Hay opciones repetidas'; return; }
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Creando…';
    const { data, error } = await sb.rpc('create_poll', {
      p_title: title, p_description: draft.description, p_kind: draft.kind,
      p_options: draft.kind === 'choice' ? options : null,
    });
    if (error) { err.textContent = friendlyError(error); btn.disabled = false; btn.textContent = 'Crear votación'; return; }
    renderNew.draft = null;
    await loadAll();
    toast('Votación creada');
    go(`#/v/${data}`);
  };
}

function renderProfile() {
  const me = state.me;
  $app.innerHTML = `
    ${topbar({ title: 'Mi perfil', back: true })}
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
          <span class="hint">Así te verán los demás en las votaciones.</span>
        </div>
        <button class="btn primary block" type="submit">Guardar</button>
      </form>
      <div class="section-title">El grupo · ${state.profiles.size}</div>
      <div class="card who" style="margin-top:0">
        ${members().map((m) => `<div class="who-row">${avatar(m, 'sm')}<span class="name">${esc(m.display_name)}</span><span class="hint">@${esc(m.username)}</span></div>`).join('')}
      </div>
      <div style="margin-top:24px">
        <button class="btn ghost block" id="logout">Cerrar sesión</button>
      </div>
    </main>`;
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
// Arranque y sesión
// ---------------------------------------------------------------------------
async function onSession(session) {
  const prevUser = state.session?.user?.id;
  state.session = session;
  if (!session) {
    unsubscribe();
    Object.assign(state, { me: null, loaded: false, polls: [], options: [], votes: [], profiles: new Map() });
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

sb.auth.onAuthStateChange((event, session) => {
  // Se difiere para no bloquear el cliente de auth dentro del callback
  setTimeout(() => onSession(session), 0);
});
