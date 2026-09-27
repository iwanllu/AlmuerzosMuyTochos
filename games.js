// ===========================================================================
// Almuerzos Muy Tochos · minijuegos de batalla y ruleta
//
// Todos los juegos son deterministas a partir de una semilla (la misma para
// todos los rivales de una batalla) y usan un paso de tiempo fijo, así que la
// partida es idéntica en cualquier móvil. Zona de juego lógica: 360 × 640.
// ===========================================================================

export const GAMES = {
  bocata: {
    name: 'Bocata tocho', emoji: '🥪', color: '#e8590c',
    how: 'Los ingredientes pasan de lado a lado. Toca para soltarlos encima del bocata: lo que sobresale se cae. Si fallas del todo, se acaba. ¡Hazlo lo más tocho posible!',
  },
  oliva: {
    name: 'Hueso de oliva', emoji: '🫒', color: '#5c940d',
    how: 'Desliza el dedo hacia arriba para lanzar el hueso por la barra hasta el platito. Mira el viento. 5 tiros: cuanto más al centro, más puntos.',
  },
  cacaos: {
    name: 'Los cacaos del gasto', emoji: '🥜', color: '#e67700',
    how: 'Mueve el plato con el dedo para recoger lo que cae: cacahuete +1, altramuz +2, oliva +3. ¡Las guindillas pican y quitan una vida! 30 segundos, 3 vidas.',
  },
  barra: {
    name: 'Corta la barra', emoji: '🥖', color: '#c2255c',
    how: 'Desliza el dedo para cortar las barras de pan que saltan. Varias de un solo tajo = combo. ¡No toques los cuchillos! 30 segundos, 3 vidas.',
  },
};
export const GAME_ORDER = ['bocata', 'oliva', 'cacaos', 'barra'];

const W = 360, H = 640, STEP = 1 / 60;
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
const UI_FONT = '"Inter",system-ui,-apple-system,sans-serif';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function emoji(ctx, ch, x, y, size, rot = 0, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  ctx.font = `${size}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, 0, 0);
  ctx.restore();
}
function text(ctx, s, x, y, { size = 16, weight = 700, color = '#fff', align = 'center', alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${size}px ${UI_FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
  ctx.restore();
}
function hud(ctx, left, right) {
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  roundRect(ctx, 10, 10, W - 20, 40, 14);
  ctx.fill();
  text(ctx, left, 24, 30, { size: 15, align: 'left' });
  text(ctx, right, W - 24, 30, { size: 15, align: 'right' });
}
// Textos flotantes (+2, ¡Perfecto!, …)
function popups() {
  const list = [];
  return {
    add(s, x, y, color = '#fff') { list.push({ s, x, y, color, t: 0 }); },
    update(dt) { for (const p of list) { p.t += dt; p.y -= 40 * dt; } while (list.length && list[0].t > 1) list.shift(); },
    draw(ctx) { for (const p of list) text(ctx, p.s, p.x, p.y, { size: 20, weight: 800, color: p.color, alpha: 1 - p.t }); },
  };
}

// ---------------------------------------------------------------------------
// 🥪 Bocata tocho
// ---------------------------------------------------------------------------
function bocata(seed) {
  const r = rng(seed);
  const ING = [['Jamón', '#f08c9c'], ['Queso', '#ffd43b'], ['Lechuga', '#8ce99a'], ['Tomate', '#fa5252'], ['Tortilla', '#ffe066'],
    ['Bacon', '#c9504d'], ['Pimiento', '#40c057'], ['Longaniza', '#a61e4d'], ['Cebolla', '#eebefa'], ['Huevo', '#fff3bf'],
    ['Atún', '#adb5bd'], ['Morcilla', '#5c2a2a'], ['Sobrasada', '#f76707'], ['Esgarraet', '#e03131'], ['Anchoas', '#868e96']];
  const LH = 20;
  const base = { x: 80, w: 200, y: 560, h: 30 };
  const stack = [];
  const falling = [];
  const pops = popups();
  let score = 0, over = false, cam = 0, camTarget = 0, perfectStreak = 0, t = 0;
  let cur = null;

  const top = () => (stack.length ? stack[stack.length - 1] : base);
  function spawn() {
    const tp = top();
    const [name, color] = ING[Math.floor(r() * ING.length)];
    const fromLeft = r() < 0.5;
    const speed = Math.min(460, 150 + stack.length * 7 + r() * 20);
    cur = { name, color, w: tp.w, y: tp.y - LH, x: fromLeft ? -tp.w * 0.5 : W - tp.w * 0.5, dir: fromLeft ? 1 : -1, speed };
  }
  spawn();

  function drop() {
    if (over || !cur) return;
    const tp = top();
    const left = Math.max(cur.x, tp.x), right = Math.min(cur.x + cur.w, tp.x + tp.w);
    const ov = right - left;
    if (ov <= 0) {
      falling.push({ ...cur, h: LH, vy: 0, rot: 0, vr: cur.dir * 2 });
      cur = null;
      over = true;
      pops.add('¡Fuera!', 180, tp.y - cam - 40, '#ffa8a8');
      return;
    }
    let layer;
    if (Math.abs(cur.x - tp.x) <= 5) {
      perfectStreak++;
      layer = { x: tp.x, w: tp.w, y: cur.y, color: cur.color, name: cur.name };
      score += 100;
      pops.add(perfectStreak > 1 ? `¡Perfecto x${perfectStreak}!` : '¡Perfecto!', 180, cur.y + cam - 30, '#ffe066');
    } else {
      perfectStreak = 0;
      layer = { x: left, w: ov, y: cur.y, color: cur.color, name: cur.name };
      score += Math.round((100 * ov) / tp.w);
      // Trozo que sobresale y cae
      const cutX = cur.x < tp.x ? cur.x : right;
      falling.push({ x: cutX, w: cur.w - ov, y: cur.y, h: LH, color: cur.color, vy: 0, rot: 0, vr: cur.x < tp.x ? -3 : 3 });
    }
    stack.push(layer);
    if (stack.length >= 100) { over = true; cur = null; return; }
    spawn();
    if (cur.y + cam < 300) camTarget = 300 - cur.y;
  }

  function drawLayer(ctx, l, y, name) {
    ctx.fillStyle = l.color;
    roundRect(ctx, l.x, y, l.w, LH - 2, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.12)';
    ctx.fillRect(l.x + 3, y + LH - 7, Math.max(0, l.w - 6), 3);
    if (name && l.w > 50) text(ctx, l.name, l.x + l.w / 2, y + LH / 2 - 1, { size: 11, weight: 700, color: 'rgba(0,0,0,.55)' });
  }
  function drawBread(ctx, x, y, w, h, isTop) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#f2b555');
    g.addColorStop(1, '#c9822b');
    ctx.fillStyle = g;
    roundRect(ctx, x, y, w, h, isTop ? h / 1.2 : 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,60,10,.45)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 1; i <= 4; i++) {
      const sx = x + (w * i) / 5;
      ctx.beginPath();
      ctx.moveTo(sx - 8, y + 7);
      ctx.lineTo(sx + 6, y + 13);
      ctx.stroke();
    }
  }

  return {
    get score() { return score; },
    get over() { return over; },
    summary: () => `${stack.length} ${stack.length === 1 ? 'ingrediente' : 'ingredientes'}`,
    onDown() { drop(); },
    update(dt) {
      t += dt;
      if (cur) {
        cur.x += cur.dir * cur.speed * dt;
        const minX = -cur.w * 0.5, maxX = W - cur.w * 0.5;
        if (cur.x < minX) { cur.x = minX; cur.dir = 1; }
        if (cur.x > maxX) { cur.x = maxX; cur.dir = -1; }
      }
      cam += (camTarget - cam) * Math.min(1, dt * 6);
      for (const f of falling) { f.vy += 1400 * dt; f.y += f.vy * dt; f.rot += f.vr * dt; }
      pops.update(dt);
    },
    draw(ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#ffe8cc');
      g.addColorStop(1, '#fff4e6');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      // Plato
      ctx.fillStyle = '#e9ecef';
      ctx.beginPath();
      ctx.ellipse(180, base.y + base.h + 10 + cam, 150, 16, 0, 0, Math.PI * 2);
      ctx.fill();
      drawBread(ctx, base.x, base.y + cam, base.w, base.h, false);
      stack.forEach((l, i) => drawLayer(ctx, l, l.y + cam, i === stack.length - 1));
      if (over && stack.length) drawBread(ctx, top().x, top().y - 22 + cam, top().w, 24, true);
      if (cur) drawLayer(ctx, cur, cur.y + cam, true);
      for (const f of falling) {
        ctx.save();
        ctx.translate(f.x + f.w / 2, f.y + cam + f.h / 2);
        ctx.rotate(f.rot);
        ctx.fillStyle = f.color;
        roundRect(ctx, -f.w / 2, -f.h / 2, f.w, f.h - 2, 6);
        ctx.fill();
        ctx.restore();
      }
      pops.draw(ctx);
      hud(ctx, `🥪 ${stack.length} ${stack.length === 1 ? 'piso' : 'pisos'}`, `${score} pts`);
      if (t < 2.5 && !stack.length) text(ctx, 'Toca para soltar', 180, 250, { size: 18, color: '#862e00', alpha: 1 - t / 2.5 });
    },
  };
}

// ---------------------------------------------------------------------------
// 🫒 Hueso de oliva
// ---------------------------------------------------------------------------
function oliva(seed) {
  const r = rng(seed);
  const throws = Array.from({ length: 5 }, () => ({
    px: Math.round(80 + r() * 200), py: Math.round(130 + r() * 170), wind: Math.round((r() * 2 - 1) * 90),
  }));
  const PR = 36, BULL = 10, START = { x: 180, y: 590 }, DRAG = 2.4;   // rozamiento: distancia ∝ fuerza del gesto
  const pops = popups();
  let i = 0, score = 0, over = false, state = 'aim', wait = 0;
  let pit = { ...START, vx: 0, vy: 0 };
  let drag = null;
  const marks = [];
  const results = [];

  function land(outside) {
    const tw = throws[i];
    const d = Math.hypot(pit.x - tw.px, pit.y - tw.py);
    let pts = 0;
    if (!outside) {
      if (d <= BULL) pts = 100;
      else if (d <= PR) pts = Math.round(100 - ((d - BULL) / (PR - BULL)) * 50);
    }
    score += pts;
    results.push(pts);
    marks.push({ x: pit.x, y: pit.y, i });
    pops.add(outside ? '¡Fuera!' : pts ? `+${pts}` : 'Fallo', pit.x, pit.y - 24, pts >= 90 ? '#ffe066' : pts ? '#fff' : '#ffa8a8');
    state = 'wait';
    wait = 1.1;
  }

  return {
    get score() { return score; },
    get over() { return over; },
    summary: () => results.map((p) => (p ? p : '0')).join(' · '),
    onDown(p) { if (state === 'aim') drag = { pts: [{ ...p, t: performance.now() }] }; },
    onMove(p) {
      if (!drag) return;
      drag.pts.push({ ...p, t: performance.now() });
      if (drag.pts.length > 12) drag.pts.shift();
    },
    onUp(p) {
      if (!drag || state !== 'aim') { drag = null; return; }
      const now = performance.now();
      drag.pts.push({ ...p, t: now });
      const recent = drag.pts.filter((q) => now - q.t <= 90);
      const a = recent[0] || drag.pts[0];
      const dt = Math.max(16, now - a.t) / 1000;
      let vx = (p.x - a.x) / dt, vy = (p.y - a.y) / dt;
      drag = null;
      if (vy > -150) { pops.add('Desliza hacia arriba', 180, 470, '#fff'); return; }
      this._throw(vx, vy);
    },
    _throw(vx, vy) {
      if (state !== 'aim') return;
      const sp = Math.hypot(vx, vy);
      if (sp > 1500) { vx *= 1500 / sp; vy *= 1500 / sp; }
      pit.vx = vx;
      pit.vy = vy;
      pit.v0 = Math.hypot(vx, vy) || 1;
      state = 'fly';
    },
    update(dt) {
      pops.update(dt);
      if (state === 'fly') {
        const tw = throws[i];
        // El viento empuja más cuanto más rápido va el hueso (y deja de empujar al pararse)
        pit.vx += tw.wind * dt * Math.min(1, Math.hypot(pit.vx, pit.vy) / pit.v0);
        const k = Math.exp(-DRAG * dt);
        pit.vx *= k;
        pit.vy *= k;
        const ns = Math.hypot(pit.vx, pit.vy);
        pit.x += pit.vx * dt;
        pit.y += pit.vy * dt;
        if (pit.x < -10 || pit.x > W + 10 || pit.y < -10) land(true);
        else if (ns < 8) land(false);
      } else if (state === 'wait') {
        wait -= dt;
        if (wait <= 0) {
          i++;
          if (i >= throws.length) { over = true; state = 'done'; i = throws.length - 1; }
          else { pit = { ...START, vx: 0, vy: 0 }; state = 'aim'; }
        }
      }
    },
    draw(ctx) {
      // Barra de madera
      ctx.fillStyle = '#8b5a2b';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(60,30,5,.25)';
      ctx.lineWidth = 2;
      for (let y = 20; y < H; y += 46) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(120, y + 8, 240, y - 8, W, y + 4);
        ctx.stroke();
      }
      const tw = throws[i];
      // Plato
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.beginPath(); ctx.ellipse(tw.px + 3, tw.py + 5, PR + 6, PR + 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f8f9fa';
      ctx.beginPath(); ctx.arc(tw.px, tw.py, PR + 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#dee2e6'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(tw.px, tw.py, PR - 6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#94d82d';
      ctx.beginPath(); ctx.arc(tw.px, tw.py, BULL, 0, Math.PI * 2); ctx.fill();
      // Marcas de tiros anteriores
      for (const m of marks) if (m.i !== i || state !== 'wait') {
        ctx.fillStyle = 'rgba(40,20,5,.35)';
        ctx.beginPath(); ctx.ellipse(m.x, m.y, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
      }
      // Hueso
      ctx.fillStyle = '#6b3e1f';
      ctx.beginPath(); ctx.ellipse(pit.x, pit.y, 9, 6, Math.atan2(pit.vy, pit.vx || 0.001), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath(); ctx.ellipse(pit.x - 2, pit.y - 2, 3, 2, 0, 0, Math.PI * 2); ctx.fill();
      // Viento
      const wv = tw.wind;
      const arrows = Math.min(3, Math.ceil(Math.abs(wv) / 30));
      const windTxt = wv === 0 || arrows === 0 ? 'sin viento' : (wv < 0 ? '←'.repeat(arrows) : '→'.repeat(arrows)) + ` ${Math.abs(wv)}`;
      ctx.fillStyle = 'rgba(0,0,0,.3)'; roundRect(ctx, 110, 60, 140, 30, 12); ctx.fill();
      text(ctx, `💨 ${windTxt}`, 180, 75, { size: 14 });
      if (state === 'aim') text(ctx, 'Desliza hacia arriba ↑', 180, 520, { size: 15, alpha: 0.85 });
      pops.draw(ctx);
      hud(ctx, `🫒 Tiro ${Math.min(i + 1, 5)}/5`, `${score} pts`);
    },
  };
}

// ---------------------------------------------------------------------------
// 🥜 Los cacaos del gasto
// ---------------------------------------------------------------------------
function cacaos(seed) {
  const r = rng(seed);
  const DUR = 30, PLATE_Y = 585, PLATE_W = 84;
  const TYPES = {
    cacahuete: { pts: 1, ch: '🥜', size: 26 },
    altramuz: { pts: 2, ch: null, size: 22 },
    oliva: { pts: 3, ch: '🫒', size: 26 },
    guindilla: { pts: 0, ch: '🌶️', size: 30 },
  };
  const schedule = [];
  for (let t = 0.6; t < DUR - 0.6;) {
    const p = t / DUR;
    const x = r(), ty = r(), sp = r(), gap = r();
    const chili = 0.06 + 0.1 * p;
    const type = ty < chili ? 'guindilla' : ty < chili + 0.07 ? 'oliva' : ty < chili + 0.32 ? 'altramuz' : 'cacahuete';
    schedule.push({ t, type, x: 24 + x * 312, speed: lerp(170, 360, p) * (0.9 + sp * 0.2) });
    t += lerp(0.62, 0.32, p) * (0.8 + gap * 0.4);
  }
  const pops = popups();
  let time = 0, next = 0, score = 0, lives = 3, over = false, plateX = 180, targetX = 180;
  const items = [];

  return {
    get score() { return score; },
    get over() { return over; },
    summary: () => `${score} pts · ${lives} ${lives === 1 ? 'vida' : 'vidas'}`,
    onDown(p) { targetX = p.x; },
    onMove(p) { targetX = p.x; },
    update(dt) {
      pops.update(dt);
      if (over) return;
      time += dt;
      plateX += (Math.max(PLATE_W / 2, Math.min(W - PLATE_W / 2, targetX)) - plateX) * Math.min(1, dt * 18);
      while (next < schedule.length && schedule[next].t <= time) items.push({ ...schedule[next++], y: -20, rot: r() * 6 });
      for (const it of items) {
        if (it.done) continue;
        it.y += it.speed * dt;
        it.rot += dt * 2;
        if (it.y >= PLATE_Y - 16 && it.y <= PLATE_Y + 12 && Math.abs(it.x - plateX) <= PLATE_W / 2 + 6) {
          it.done = true;
          if (it.type === 'guindilla') { lives--; pops.add('¡Pica! 🔥', it.x, PLATE_Y - 40, '#ff8787'); }
          else { score += TYPES[it.type].pts; pops.add(`+${TYPES[it.type].pts}`, it.x, PLATE_Y - 34, '#fff'); }
        } else if (it.y > H + 30) it.done = true;
      }
      if (lives <= 0 || time >= DUR) over = true;
    },
    draw(ctx) {
      // Mantel de cuadros
      ctx.fillStyle = '#fff5f5';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(224,49,49,.12)';
      for (let y = 0; y < H; y += 40) for (let x = (y / 40) % 2 ? 0 : 40; x < W; x += 80) ctx.fillRect(x, y, 40, 40);
      for (const it of items) {
        if (it.done) continue;
        const T = TYPES[it.type];
        if (T.ch) emoji(ctx, T.ch, it.x, it.y, T.size, it.rot * 0.3);
        else {
          ctx.fillStyle = '#ffd43b'; ctx.strokeStyle = '#e8a400'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.ellipse(it.x, it.y, 11, 8, it.rot, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
      // Plato
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.beginPath(); ctx.ellipse(plateX, PLATE_Y + 12, PLATE_W / 2 + 4, 10, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#ced4da'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(plateX, PLATE_Y, PLATE_W / 2, 12, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      pops.draw(ctx);
      hud(ctx, `⏱ ${Math.max(0, Math.ceil(DUR - time))} s   ${'❤️'.repeat(Math.max(0, lives))}`, `${score} pts`);
      if (time < 2.5) text(ctx, 'Mueve el plato con el dedo', 180, 300, { size: 16, color: '#862e00', alpha: 1 - time / 2.5 });
    },
  };
}

// ---------------------------------------------------------------------------
// 🥖 Corta la barra
// ---------------------------------------------------------------------------
function barra(seed) {
  const r = rng(seed);
  const DUR = 30, GRAV = 1000;
  const schedule = [];
  for (let t = 0.6; t < DUR - 1;) {
    const p = t / DUR;
    const n = 1 + Math.floor(r() * (p < 0.3 ? 2 : 3));
    for (let k = 0; k < n; k++) {
      const x0 = 50 + r() * 260;
      const knife = r() < 0.12 + 0.1 * p;
      schedule.push({
        t: t + k * 0.12, knife, x: x0, y: H + 30,
        vx: (r() - 0.5) * 220 + (180 - x0) * 0.5, vy: -(900 + r() * 150), vr: (r() - 0.5) * 8,
      });
    }
    t += lerp(1.3, 0.75, p) * (0.85 + r() * 0.3);
  }
  const pops = popups();
  let time = 0, next = 0, score = 0, lives = 3, over = false, cut = 0;
  const objs = [], halves = [], trail = [];
  let down = false, last = null, combo = 0;

  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function slice(a, b) {
    if (over) return;
    for (const o of objs) {
      if (o.dead) continue;
      if (segDist(o.x, o.y, a.x, a.y, b.x, b.y) < (o.knife ? 22 : 30)) {
        o.dead = true;
        if (o.knife) { lives--; pops.add('¡Ay! 🩹', o.x, o.y - 30, '#ff8787'); }
        else {
          score++; cut++; combo++;
          const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
          for (const s of [-1, 1]) halves.push({ x: o.x, y: o.y, vx: o.vx + Math.cos(ang) * 120 * s, vy: o.vy * 0.4, rot: o.rot, vr: o.vr + s * 4, t: 0 });
        }
      }
    }
  }
  function endSwipe() {
    if (combo >= 2) { score += combo - 1; pops.add(`¡Combo x${combo}! +${combo - 1}`, 180, 220, '#ffe066'); }
    combo = 0; down = false; last = null;
  }

  return {
    get score() { return score; },
    get over() { return over; },
    summary: () => `${cut} ${cut === 1 ? 'barra cortada' : 'barras cortadas'}`,
    onDown(p) { down = true; last = p; combo = 0; trail.push({ ...p, t: 0 }); },
    onMove(p) {
      if (!down) return;
      if (last && Math.hypot(p.x - last.x, p.y - last.y) >= 3) slice(last, p);
      last = p;
      trail.push({ ...p, t: 0 });
    },
    onUp() { if (down) endSwipe(); },
    update(dt) {
      pops.update(dt);
      for (const tp of trail) tp.t += dt;
      while (trail.length && trail[0].t > 0.18) trail.shift();
      for (const h of halves) { h.vy += GRAV * dt; h.x += h.vx * dt; h.y += h.vy * dt; h.rot += h.vr * dt; h.t += dt; }
      if (over) return;
      time += dt;
      while (next < schedule.length && schedule[next].t <= time) objs.push({ ...schedule[next++], rot: 0 });
      for (const o of objs) {
        if (o.dead) continue;
        o.vy += GRAV * dt; o.x += o.vx * dt; o.y += o.vy * dt; o.rot += o.vr * dt;
        if (o.vy > 0 && o.y > H + 60) o.dead = true;
      }
      if (lives <= 0 || time >= DUR) { if (down) endSwipe(); over = true; }
    },
    draw(ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#3b2314');
      g.addColorStop(1, '#5c3a21');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      for (const o of objs) if (!o.dead) emoji(ctx, o.knife ? '🔪' : '🥖', o.x, o.y, o.knife ? 44 : 54, o.rot);
      for (const h of halves) if (h.t < 1.2) emoji(ctx, '🥖', h.x, h.y, 34, h.rot, Math.max(0, 1 - h.t));
      if (trail.length > 1) {
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        trail.forEach((tp, k) => (k ? ctx.lineTo(tp.x, tp.y) : ctx.moveTo(tp.x, tp.y)));
        ctx.stroke();
      }
      pops.draw(ctx);
      hud(ctx, `⏱ ${Math.max(0, Math.ceil(DUR - time))} s   ${'❤️'.repeat(Math.max(0, lives))}`, `${score} pts`);
      if (time < 2.5) text(ctx, 'Desliza para cortar', 180, 300, { size: 16, alpha: 1 - time / 2.5 });
    },
  };
}

const FACTORIES = { bocata, oliva, cacaos, barra };
export const _factories = FACTORIES;   // para pruebas

// ---------------------------------------------------------------------------
// Pantallas (introducción, cuenta atrás, resultado) y bucle de juego
// ---------------------------------------------------------------------------
function overlay() {
  let el = document.getElementById('game-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'game-root';
    document.body.append(el);
  }
  el.innerHTML = '';
  el.className = 'game-overlay';
  document.body.classList.add('no-scroll');
  return el;
}
export function closeOverlay() {
  const el = document.getElementById('game-root');
  if (el) { el.innerHTML = ''; el.className = ''; }
  document.body.classList.remove('no-scroll');
}

// Pantalla con botones; devuelve el valor del botón pulsado
export function gameScreen(html, buttons) {
  const el = overlay();
  el.innerHTML = `<div class="game-screen">${html}<div class="game-buttons">
    ${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : 'ghost'} block" data-i="${i}">${b.label}</button>`).join('')}
  </div></div>`;
  return new Promise((resolve) => {
    el.querySelectorAll('[data-i]').forEach((btn) => (btn.onclick = () => resolve(buttons[Number(btn.dataset.i)].value)));
  });
}

// Juega una partida y devuelve { score, summary }
export function runGame(game, seed, { attempt = 1, label = null } = {}) {
  const def = GAMES[game];
  const el = overlay();
  el.innerHTML = `
    <div class="game-top">
      <span class="game-name">${def.emoji} ${def.name} <small>· ${label || `intento ${attempt}/3`}</small></span>
      <button class="game-quit" aria-label="Terminar">Terminar</button>
    </div>
    <div class="game-stage"><canvas></canvas><div class="game-count"></div></div>`;
  const stage = el.querySelector('.game-stage');
  const canvas = el.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const countEl = el.querySelector('.game-count');
  const g = FACTORIES[game](seed);
  let scale = 1, raf = 0, acc = 0, last = 0, running = false, finished = false, endTimer = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    scale = Math.min(stage.clientWidth / W, stage.clientHeight / H);
    canvas.style.width = `${W * scale}px`;
    canvas.style.height = `${H * scale}px`;
    canvas.width = Math.round(W * scale * dpr);
    canvas.height = Math.round(H * scale * dpr);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  const pos = (e) => {
    const rc = canvas.getBoundingClientRect();
    return { x: (e.clientX - rc.left) / scale, y: (e.clientY - rc.top) / scale };
  };
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture?.(e.pointerId); if (running) g.onDown?.(pos(e)); });
  canvas.addEventListener('pointermove', (e) => { if (running) g.onMove?.(pos(e)); });
  canvas.addEventListener('pointerup', (e) => { if (running) g.onUp?.(pos(e)); });
  canvas.addEventListener('pointercancel', (e) => { if (running) g.onUp?.(pos(e)); });

  return new Promise((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      resolve({ score: Math.max(0, Math.round(g.score)), summary: g.summary() });
    };
    el.querySelector('.game-quit').onclick = finish;

    function frame(now) {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (running) {
        acc += dt;
        while (acc >= STEP) { g.update(STEP); acc -= STEP; }
        if (g.over) {
          endTimer += dt;
          if (endTimer > 1.4) { g.draw(ctx); finish(); return; }
        }
      }
      g.draw(ctx);
      if (g.over && running) text(ctx, '¡Fin!', 180, 320, { size: 44, weight: 800, color: '#fff' });
      raf = requestAnimationFrame(frame);
    }
    last = performance.now();
    raf = requestAnimationFrame(frame);

    // Cuenta atrás 3-2-1
    let n = 3;
    countEl.textContent = n;
    const tick = setInterval(() => {
      n--;
      if (n > 0) countEl.textContent = n;
      else {
        clearInterval(tick);
        countEl.textContent = '¡Ya!';
        setTimeout(() => { countEl.textContent = ''; }, 500);
        running = true;
        last = performance.now();
      }
    }, 700);
  });
}

// ---------------------------------------------------------------------------
// 🎰 Ruleta: gira hasta el minijuego que ha decidido el servidor
// ---------------------------------------------------------------------------
export function rouletteScreen(placeName, rivals, { practice = false } = {}) {
  const el = overlay();
  const seg = GAME_ORDER.map((k, i) => {
    const a0 = (i * 90 - 90) * Math.PI / 180, a1 = ((i + 1) * 90 - 90) * Math.PI / 180, mid = (i * 90 + 45 - 90) * Math.PI / 180;
    const p = (a, rr) => `${150 + rr * Math.cos(a)},${150 + rr * Math.sin(a)}`;
    return `<path d="M150,150 L${p(a0, 140)} A140,140 0 0 1 ${p(a1, 140)} Z" fill="${GAMES[k].color}" stroke="#fff" stroke-width="4"/>
      <text x="${150 + 88 * Math.cos(mid)}" y="${150 + 88 * Math.sin(mid)}" font-size="40" text-anchor="middle" dominant-baseline="central">${GAMES[k].emoji}</text>`;
  }).join('');
  el.innerHTML = `
    <div class="game-screen roulette">
      ${practice
        ? `<div class="eyebrow">🎮 Modo entrenamiento</div><h2>¿A qué jugamos?</h2><p class="muted">Aquí no cuenta nada: practica todo lo que quieras.</p>`
        : `<div class="eyebrow">⚔️ Batalla por «${placeName.replace(/[<>&"]/g, '')}»</div>
      <h2>Contra ${rivals} ${rivals === 1 ? 'rival' : 'rivales'}</h2>
      <p class="muted">Gira la ruleta para elegir el minijuego.</p>`}
      <div class="wheel-wrap">
        <div class="wheel-pointer">▼</div>
        <svg class="wheel" viewBox="0 0 300 300" width="280" height="280" aria-hidden="true">${seg}
          <circle cx="150" cy="150" r="26" fill="#fff" stroke="#eadfd2" stroke-width="4"/></svg>
      </div>
      <div class="wheel-result" aria-live="polite"></div>
      <div class="game-buttons"><button class="btn primary block" data-spin>🎰 ¡Girar la ruleta!</button>
        <button class="btn ghost block" data-later>Luego</button></div>
    </div>`;
  const wheel = el.querySelector('.wheel');
  return {
    onSpin(handler) { el.querySelector('[data-spin]').onclick = handler; },
    onLater(handler) { el.querySelector('[data-later]').onclick = handler; },
    setBusy(b) { el.querySelectorAll('button').forEach((x) => (x.disabled = b)); },
    // Anima hasta el juego elegido
    land(game) {
      const i = GAME_ORDER.indexOf(game);
      const jitter = (Math.random() - 0.5) * 50;
      const deg = 360 * 6 - (i * 90 + 45) + jitter;
      wheel.style.transition = 'transform 3.6s cubic-bezier(.12,.72,.14,1)';
      wheel.style.transform = `rotate(${deg}deg)`;
      return new Promise((resolve) => setTimeout(() => {
        el.querySelector('.wheel-result').innerHTML = `<div class="big">${GAMES[game].emoji}</div><strong>${GAMES[game].name}</strong>`;
        resolve();
      }, 3700));
    },
  };
}
