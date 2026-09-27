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
  cacaos: {
    name: 'Los cacaos del gasto', emoji: '🥜', color: '#e67700',
    how: 'Mueve el plato con el dedo para recoger lo que cae: cacahuete +1, altramuz +2, oliva +3. ¡Las guindillas pican y quitan una vida! 30 segundos, 3 vidas.',
  },
  barra: {
    name: 'Corta la barra', emoji: '🥖', color: '#c2255c',
    how: 'Desliza el dedo para cortar todo lo que salta: barras de pan, tomates, pimientos, quesos, huevos, cebollas, longanizas… Varios de un tajo = combo. ¡La barra de oro vale 5! No toques los cuchillos. 30 segundos, 3 vidas.',
  },
};
export const GAME_ORDER = ['bocata', 'cacaos', 'barra'];

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
// Pseudoaleatorio fijo por posición: los dibujos (agujeros del queso, rodajas…)
// quedan anclados al mundo, así que al recortar una capa no "bailan".
const hsh = (k) => { const v = Math.sin(k * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
const LH = 20;           // alto de cada capa
const LAYER_H = 18;      // alto dibujado (deja 2 px de aire)

function wavyPath(ctx, x0, x1, y, amp, period) {
  for (let x = x0; x <= x1; x += 3) ctx.lineTo(x, y + Math.sin((x / period) * Math.PI * 2) * amp);
  ctx.lineTo(x1, y + Math.sin((x1 / period) * Math.PI * 2) * amp);
}
function vgrad(ctx, y0, y1, c0, c1) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  return g;
}
function clipBox(ctx, x, y, w, h, over = 3) {
  ctx.beginPath();
  ctx.rect(x - over, y - 6, w + over * 2, h + 12);
  ctx.clip();
}
function slices(ctx, x, w, step, fn) {
  for (let k = Math.floor((x - step) / step); k * step < x + w + step; k++) fn(k * step + step / 2, k);
}

// Cada ingrediente se dibuja como lo que es (x, y = esquina superior; w = ancho)
const INGREDIENTS = [
  { key: 'jamon', name: 'Jamón', draw(ctx, x, y, w) {
    const h = LAYER_H;
    ctx.beginPath();
    ctx.moveTo(x - 4, y + 4);
    wavyPath(ctx, x - 4, x + w + 4, y + 3, 2, 26);
    for (let xx = x + w + 5; xx >= x - 5; xx -= 3) ctx.lineTo(xx, y + h - 1 + Math.sin(xx / 9) * 2.4);
    ctx.closePath();
    ctx.fillStyle = vgrad(ctx, y, y + h, '#f7a8b8', '#e0738a');
    ctx.fill();
    ctx.strokeStyle = '#b84d65'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    slices(ctx, x, w, 34, (cx, k) => {
      ctx.beginPath();
      ctx.moveTo(cx - 14, y + 6 + hsh(k) * 4);
      ctx.bezierCurveTo(cx - 4, y + 2, cx + 2, y + 16, cx + 14, y + 9 + hsh(k + 9) * 4);
      ctx.stroke();
    });
    ctx.restore();
  } },
  { key: 'queso', name: 'Queso', draw(ctx, x, y, w) {
    const h = LAYER_H;
    ctx.beginPath();
    ctx.moveTo(x - 7, y + 2);
    ctx.lineTo(x + w + 7, y + 2);
    ctx.lineTo(x + w + 9, y + h + 4);                 // esquina que cuelga
    ctx.lineTo(x + w - 2, y + h - 3);
    for (let xx = x + w - 2; xx > x + 2; xx -= 2) {
      const k = Math.floor(xx / 26), d = hsh(k) > 0.55 ? 4 + hsh(k + 3) * 6 : 0;
      const t = (xx % 26) / 26;
      ctx.lineTo(xx, y + h - 3 + Math.sin(t * Math.PI) * d);
    }
    ctx.lineTo(x + 2, y + h - 3);
    ctx.lineTo(x - 9, y + h + 4);
    ctx.closePath();
    ctx.fillStyle = vgrad(ctx, y, y + h, '#ffe066', '#fcc419');
    ctx.fill();
    ctx.strokeStyle = '#e8a400'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(232,164,0,.55)';
    slices(ctx, x, w, 22, (cx, k) => {
      if (hsh(k + 1) < 0.35) return;
      ctx.beginPath(); ctx.ellipse(cx + (hsh(k) - 0.5) * 8, y + 6 + hsh(k + 5) * 7, 2.2 + hsh(k + 2) * 2.2, 1.8 + hsh(k + 4) * 1.6, 0, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.fillRect(x - 6, y + 3, w + 12, 2);
    ctx.restore();
  } },
  { key: 'lechuga', name: 'Lechuga', draw(ctx, x, y, w) {
    const h = LAYER_H;
    ctx.beginPath();
    ctx.moveTo(x - 7, y + h / 2);
    for (let xx = x - 7; xx <= x + w + 7; xx += 8) ctx.quadraticCurveTo(xx + 4, y - 3, xx + 8, y + 3);
    for (let xx = x + w + 7; xx >= x - 7; xx -= 8) ctx.quadraticCurveTo(xx - 4, y + h + 3, xx - 8, y + h - 3);
    ctx.closePath();
    ctx.fillStyle = vgrad(ctx, y, y + h, '#b2f2bb', '#51cf66');
    ctx.fill();
    ctx.strokeStyle = '#2f9e44'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(235,251,238,.9)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x - 6, y + h / 2); wavyPath(ctx, x - 6, x + w + 6, y + h / 2, 1.5, 40); ctx.stroke();
    slices(ctx, x, w, 18, (cx) => { ctx.beginPath(); ctx.moveTo(cx, y + h / 2); ctx.lineTo(cx + 6, y + 3); ctx.moveTo(cx, y + h / 2); ctx.lineTo(cx + 6, y + h - 3); ctx.stroke(); });
    ctx.restore();
  } },
  { key: 'tomate', name: 'Tomate', draw(ctx, x, y, w) {
    ctx.save(); clipBox(ctx, x, y, w, LAYER_H, 2);
    slices(ctx, x, w, 20, (cx) => {
      const cy = y + LAYER_H / 2, r = 11;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#e03131'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r - 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ff6b6b'; ctx.fill();
      ctx.fillStyle = '#ffc9c9';
      for (let i = 0; i < 3; i++) {
        const a = i * 2.1 + 0.5;
        ctx.beginPath(); ctx.ellipse(cx + Math.cos(a) * 4.5, cy + Math.sin(a) * 4.5, 2.6, 1.8, a, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#ffe066';
      for (let i = 0; i < 3; i++) { const a = i * 2.1 + 0.5; ctx.fillRect(cx + Math.cos(a) * 4.5 - 0.7, cy + Math.sin(a) * 4.5 - 0.7, 1.4, 1.4); }
      ctx.strokeStyle = '#c92a2a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.restore();
  } },
  { key: 'tortilla', name: 'Tortilla', draw(ctx, x, y, w) {
    const h = LAYER_H;
    roundRect(ctx, x - 2, y + 1, w + 4, h, 8);
    ctx.fillStyle = vgrad(ctx, y, y + h, '#ffe066', '#f59f00');
    ctx.fill();
    ctx.strokeStyle = '#d9480f'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.save(); ctx.clip();
    slices(ctx, x, w, 16, (cx, k) => {
      ctx.fillStyle = 'rgba(201,90,0,.35)';
      ctx.beginPath(); ctx.ellipse(cx + (hsh(k) - 0.5) * 8, y + 3 + hsh(k + 1) * 3, 3 + hsh(k + 2) * 3, 1.6, 0, 0, Math.PI * 2); ctx.fill();
      if (hsh(k + 7) > 0.5) { ctx.fillStyle = '#fff3bf'; roundRect(ctx, cx - 3, y + 9 + hsh(k + 3) * 4, 6, 4, 1.5); ctx.fill(); }
    });
    ctx.restore();
  } },
  { key: 'bacon', name: 'Bacon', draw(ctx, x, y, w) {
    const bands = [['#a61e4d', 0, 6], ['#ffe3e3', 6, 3], ['#e8590c', 9, 5], ['#fff0f6', 14, 2], ['#c92a2a', 16, 3]];
    for (const [c, off, th] of bands) {
      ctx.beginPath();
      ctx.moveTo(x - 5, y + off + 1);
      wavyPath(ctx, x - 5, x + w + 5, y + off + 1, 2.5, 30);
      for (let xx = x + w + 5; xx >= x - 5; xx -= 3) ctx.lineTo(xx, y + off + th + 1 + Math.sin((xx / 30) * Math.PI * 2) * 2.5);
      ctx.closePath(); ctx.fillStyle = c; ctx.fill();
    }
  } },
  { key: 'pimiento', name: 'Pimiento', draw(ctx, x, y, w) {
    ctx.save(); clipBox(ctx, x, y, w, LAYER_H, 4);
    slices(ctx, x, w, 28, (cx, k) => {
      const red = k % 2 === 0;
      for (const row of [0, 1]) {
        const yy = y + 4 + row * 9, ox = row * 12;
        roundRect(ctx, cx - 16 + ox, yy - 4, 30, 8, 4);
        ctx.fillStyle = red ? (row ? '#f03e3e' : '#fa5252') : (row ? '#37b24d' : '#51cf66');
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.45)'; roundRect(ctx, cx - 12 + ox, yy - 3, 16, 2, 1); ctx.fill();
      }
    });
    ctx.restore();
  } },
  { key: 'longaniza', name: 'Longaniza', draw(ctx, x, y, w) {
    ctx.save(); clipBox(ctx, x, y, w, LAYER_H, 3);
    slices(ctx, x, w, 17, (cx, k) => {
      const cy = y + LAYER_H / 2 + (k % 2 ? 1 : -1);
      ctx.beginPath(); ctx.arc(cx, cy, 9.5, 0, Math.PI * 2); ctx.fillStyle = '#862e3b'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, 7.5, 0, Math.PI * 2); ctx.fillStyle = '#e8687c'; ctx.fill();
      ctx.fillStyle = '#fff5f5';
      for (let i = 0; i < 4; i++) ctx.fillRect(cx - 4 + hsh(k * 4 + i) * 8, cy - 4 + hsh(k * 4 + i + 50) * 8, 1.8, 1.8);
    });
    ctx.restore();
  } },
  { key: 'cebolla', name: 'Cebolla', draw(ctx, x, y, w) {
    ctx.save(); clipBox(ctx, x, y, w, LAYER_H, 3);
    slices(ctx, x, w, 22, (cx, k) => {
      const cy = y + LAYER_H / 2;
      for (const [r, c] of [[10, '#be4bdb'], [7, '#f3d9fa'], [4.5, '#da77f2']]) {
        ctx.beginPath(); ctx.ellipse(cx + (k % 2) * 2, cy, r + 2, r * 0.85, 0, 0, Math.PI * 2);
        ctx.strokeStyle = c; ctx.lineWidth = 2.6; ctx.stroke();
      }
    });
    ctx.restore();
  } },
  { key: 'huevo', name: 'Huevo frito', draw(ctx, x, y, w) {
    const h = LAYER_H;
    ctx.beginPath();
    ctx.moveTo(x - 6, y + h / 2);
    for (let xx = x - 6; xx <= x + w + 6; xx += 10) ctx.quadraticCurveTo(xx + 5, y - 1 - hsh(Math.floor(xx / 10)) * 3, xx + 10, y + 2);
    ctx.lineTo(x + w + 6, y + h - 2);
    ctx.lineTo(x - 6, y + h - 2);
    ctx.closePath();
    ctx.fillStyle = '#fffdf5'; ctx.fill();
    ctx.strokeStyle = '#e9d8a6'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.save(); clipBox(ctx, x, y, w, h, 1);
    slices(ctx, x, w, 50, (cx) => {
      ctx.beginPath(); ctx.arc(cx, y + h / 2 + 1, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fab005'; ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.beginPath(); ctx.arc(cx - 2.5, y + h / 2 - 2, 2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
  } },
  { key: 'atun', name: 'Atún', draw(ctx, x, y, w) {
    ctx.save(); clipBox(ctx, x, y, w, LAYER_H, 3);
    slices(ctx, x, w, 9, (cx, k) => {
      ctx.fillStyle = ['#d9b38c', '#c69c6d', '#e6c9a8'][k % 3];
      ctx.beginPath(); ctx.ellipse(cx, y + 5 + hsh(k) * 9, 6 + hsh(k + 1) * 3, 4, hsh(k + 2) * 2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(120,80,40,.35)'; ctx.lineWidth = 1; ctx.stroke();
    });
    ctx.restore();
  } },
  { key: 'morcilla', name: 'Morcilla', draw(ctx, x, y, w) {
    ctx.save(); clipBox(ctx, x, y, w, LAYER_H, 3);
    slices(ctx, x, w, 18, (cx, k) => {
      const cy = y + LAYER_H / 2;
      ctx.beginPath(); ctx.arc(cx, cy, 9.5, 0, Math.PI * 2); ctx.fillStyle = '#1f0f12'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, 7.8, 0, Math.PI * 2); ctx.fillStyle = '#4a1f24'; ctx.fill();
      ctx.fillStyle = '#e9d8c4';
      for (let i = 0; i < 6; i++) ctx.fillRect(cx - 5 + hsh(k * 6 + i) * 10, cy - 5 + hsh(k * 6 + i + 40) * 10, 1.5, 1.5);
    });
    ctx.restore();
  } },
  { key: 'sobrasada', name: 'Sobrasada', draw(ctx, x, y, w) {
    const h = LAYER_H;
    ctx.beginPath();
    ctx.moveTo(x - 3, y + h - 2);
    for (let xx = x - 3; xx <= x + w + 3; xx += 6) ctx.lineTo(xx, y + 3 + hsh(Math.floor(xx / 6)) * 5);
    ctx.lineTo(x + w + 3, y + h - 2);
    ctx.closePath();
    ctx.fillStyle = vgrad(ctx, y, y + h, '#ff922b', '#d9480f');
    ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(255,244,230,.7)';
    slices(ctx, x, w, 7, (cx, k) => ctx.fillRect(cx, y + 6 + hsh(k) * 9, 1.6, 1.6));
    ctx.restore();
  } },
  { key: 'anchoas', name: 'Anchoas', draw(ctx, x, y, w) {
    ctx.save(); clipBox(ctx, x, y, w, LAYER_H, 6);
    for (const row of [0, 1]) {
      slices(ctx, x + row * 14, w, 30, (cx) => {
        const cy = y + 5 + row * 9;
        ctx.beginPath(); ctx.ellipse(cx, cy, 12, 3.6, 0, 0, Math.PI * 2);
        ctx.fillStyle = vgrad(ctx, cy - 4, cy + 4, '#ced4da', '#6c5b4c'); ctx.fill();
        ctx.beginPath(); ctx.moveTo(cx + 11, cy); ctx.lineTo(cx + 17, cy - 4); ctx.lineTo(cx + 17, cy + 4); ctx.closePath();
        ctx.fillStyle = '#868e96'; ctx.fill();
        ctx.fillStyle = '#212529'; ctx.fillRect(cx - 9, cy - 1, 1.6, 1.6);
      });
    }
    ctx.restore();
  } },
  { key: 'lomo', name: 'Lomo', draw(ctx, x, y, w) {
    const h = LAYER_H;
    roundRect(ctx, x - 3, y + 1, w + 6, h, 6);
    ctx.fillStyle = vgrad(ctx, y, y + h, '#d9a066', '#a0612c');
    ctx.fill();
    ctx.strokeStyle = '#7a4520'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(60,30,10,.6)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    slices(ctx, x, w, 16, (cx) => { ctx.beginPath(); ctx.moveTo(cx - 5, y + h); ctx.lineTo(cx + 5, y + 1); ctx.stroke(); });
    ctx.restore();
  } },
  { key: 'esgarraet', name: 'Esgarraet', draw(ctx, x, y, w) {
    ctx.save(); clipBox(ctx, x, y, w, LAYER_H, 4);
    slices(ctx, x, w, 14, (cx, k) => {
      if (k % 3 === 2) {
        ctx.fillStyle = '#f8f9fa';
        ctx.beginPath(); ctx.ellipse(cx, y + 9, 7, 5, hsh(k), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#dee2e6'; ctx.lineWidth = 1; ctx.stroke();
      } else {
        ctx.fillStyle = k % 2 ? '#c92a2a' : '#e03131';
        ctx.beginPath(); ctx.ellipse(cx, y + 9, 10, 5, (hsh(k) - 0.5) * 0.8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.ellipse(cx - 2, y + 7, 5, 1.2, 0, 0, Math.PI * 2); ctx.fill();
      }
    });
    ctx.restore();
  } },
  { key: 'allioli', name: 'All i oli', draw(ctx, x, y, w) {
    const h = LAYER_H;
    ctx.beginPath();
    ctx.moveTo(x - 4, y + 6);
    wavyPath(ctx, x - 4, x + w + 4, y + 5, 2.5, 22);
    for (let xx = x + w + 4; xx >= x - 4; xx -= 2) {
      const k = Math.floor(xx / 24), t = (xx % 24) / 24;
      const drip = hsh(k) > 0.5 ? Math.sin(t * Math.PI) * (6 + hsh(k + 3) * 6) : 0;
      ctx.lineTo(xx, y + h - 6 + drip);
    }
    ctx.closePath();
    ctx.fillStyle = vgrad(ctx, y, y + h, '#fffdf0', '#f4ecc8');
    ctx.fill();
    ctx.strokeStyle = '#e0d49a'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    slices(ctx, x, w, 26, (cx) => { ctx.beginPath(); ctx.ellipse(cx, y + 7, 4, 1.4, 0, 0, Math.PI * 2); ctx.fill(); });
    ctx.restore();
  } },
];

// Carita para el pan (mira hacia el ingrediente que se mueve)
function breadFace(ctx, cx, cy, lookX, mood) {
  const dx = Math.max(-2.2, Math.min(2.2, (lookX - cx) / 40));
  for (const s of [-1, 1]) {
    const ex = cx + s * 13;
    if (mood === 'sad') {
      ctx.strokeStyle = '#3b1d0a'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ex - 4, cy - 3); ctx.lineTo(ex + 4, cy + 3); ctx.moveTo(ex + 4, cy - 3); ctx.lineTo(ex - 4, cy + 3); ctx.stroke();
    } else {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(ex, cy, 5, 5.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2b1608'; ctx.beginPath(); ctx.arc(ex + dx, cy + 0.8, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex + dx - 1, cy - 0.5, 1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,120,120,.45)'; ctx.beginPath(); ctx.ellipse(cx + s * 22, cy + 7, 4.5, 2.6, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#3b1d0a'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.beginPath();
  if (mood === 'wow') { ctx.fillStyle = '#3b1d0a'; ctx.ellipse(cx, cy + 9, 3.2, 4, 0, 0, Math.PI * 2); ctx.fill(); }
  else if (mood === 'sad') ctx.arc(cx, cy + 13, 5, Math.PI * 1.15, Math.PI * 1.85);
  else ctx.arc(cx, cy + 5, 5, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
}

// Mitad de abajo de una barra de pan (corte hacia arriba: se ve la miga)
function bottomBread(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = 'rgba(80,40,10,.18)';
  ctx.beginPath(); ctx.ellipse(x + w / 2, y + h + 4, w / 2 + 6, 7, 0, 0, Math.PI * 2); ctx.fill();
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(x + 8, y);
    ctx.lineTo(x + w - 8, y);
    ctx.bezierCurveTo(x + w + 8, y, x + w + 6, y + h, x + w - 16, y + h);
    ctx.lineTo(x + 16, y + h);
    ctx.bezierCurveTo(x - 6, y + h, x - 8, y, x + 8, y);
    ctx.closePath();
  };
  shape();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#e9a85a'); g.addColorStop(0.5, '#cf8736'); g.addColorStop(1, '#9c5a1d');
  ctx.fillStyle = g; ctx.fill();
  ctx.save();
  ctx.clip();
  // miga (la cara cortada)
  ctx.fillStyle = '#fff1d6'; ctx.fillRect(x - 10, y, w + 20, 7);
  ctx.fillStyle = 'rgba(214,170,110,.65)';
  for (let i = 0; i < 18; i++) { ctx.beginPath(); ctx.ellipse(x + 14 + hsh(i + 60) * (w - 28), y + 3.5, 1.9, 1.1, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = 'rgba(160,90,30,.35)'; ctx.fillRect(x - 10, y + 7, w + 20, 1.5);
  // brillo y harina
  ctx.fillStyle = 'rgba(255,240,210,.3)'; ctx.beginPath(); ctx.ellipse(x + w / 2, y + h * 0.55, w / 2 - 16, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  for (let i = 0; i < 22; i++) ctx.fillRect(x + 6 + hsh(i) * (w - 12), y + 12 + hsh(i + 30) * (h - 16), 1.6, 1.6);
  ctx.restore();
  shape();
  ctx.strokeStyle = '#8a4c16'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

// Mitad de arriba (tapa): cúpula dorada con los cortes del panadero
function topBread(ctx, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + 4, y + h);
  ctx.bezierCurveTo(x - 10, y + h, x - 4, y + 2, x + 30, y);
  ctx.lineTo(x + w - 30, y);
  ctx.bezierCurveTo(x + w + 4, y + 2, x + w + 10, y + h, x + w - 4, y + h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#c97a2c'); g.addColorStop(0.45, '#e5a352'); g.addColorStop(1, '#f2c27b');
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = '#8a4c16'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.clip();
  // cortes del panadero
  for (let i = 0; i < 5; i++) {
    const cx = x + 30 + ((w - 60) * i) / 4;
    ctx.save(); ctx.translate(cx, y + h * 0.42); ctx.rotate(-0.45);
    ctx.fillStyle = '#f8d9a0'; ctx.beginPath(); ctx.ellipse(0, 0, 15, 3.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120,60,10,.55)'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.ellipse(0, 1, 15, 3.6, 0, 0.1, Math.PI - 0.1); ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.beginPath(); ctx.ellipse(x + w * 0.35, y + 6, w * 0.25, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  for (let i = 0; i < 18; i++) ctx.fillRect(x + 10 + hsh(i + 90) * (w - 20), y + 3 + hsh(i + 120) * (h - 8), 1.5, 1.5);
  ctx.restore();
  ctx.fillStyle = '#fff1d6';
  ctx.fillRect(x + 8, y + h - 3, w - 16, 3);
}

function bocata(seed) {
  const r = rng(seed);
  const base = { x: 80, w: 200, y: 548, h: 36 };
  const stack = [];
  const falling = [];
  const pops = popups();
  let score = 0, over = false, cam = 0, camTarget = 0, perfectStreak = 0, t = 0, wowT = 0;
  let cur = null, lid = null;

  const top = () => (stack.length ? stack[stack.length - 1] : base);
  function spawn() {
    const tp = top();
    const ing = INGREDIENTS[Math.floor(r() * INGREDIENTS.length)];
    const fromLeft = r() < 0.5;
    const speed = Math.min(460, 150 + stack.length * 7 + r() * 20);
    cur = { ing, w: tp.w, y: tp.y - LH, x: fromLeft ? -tp.w * 0.5 : W - tp.w * 0.5, dir: fromLeft ? 1 : -1, speed };
  }
  spawn();

  function finish() {
    over = true;
    const tp = top();
    lid = { y: tp.y - 200, target: tp.y - 26, x: base.x, w: base.w };
  }
  function drop() {
    if (over || !cur) return;
    const tp = top();
    const left = Math.max(cur.x, tp.x), right = Math.min(cur.x + cur.w, tp.x + tp.w);
    const ov = right - left;
    if (ov <= 0) {
      falling.push({ ...cur, h: LH, vy: 0, rot: 0, vr: cur.dir * 2 });
      cur = null;
      pops.add('¡Fuera!', 180, tp.y + cam - 40, '#e03131');
      finish();
      return;
    }
    let layer;
    if (Math.abs(cur.x - tp.x) <= 5) {
      perfectStreak++;
      layer = { x: tp.x, w: tp.w, y: cur.y, ing: cur.ing };
      score += 100;
      wowT = 0.6;
      pops.add(perfectStreak > 1 ? `¡Perfecto x${perfectStreak}!` : '¡Perfecto!', 180, cur.y + cam - 34, '#e8590c');
    } else {
      perfectStreak = 0;
      layer = { x: left, w: ov, y: cur.y, ing: cur.ing };
      score += Math.round((100 * ov) / tp.w);
      const cutX = cur.x < tp.x ? cur.x : right;
      falling.push({ x: cutX, w: cur.w - ov, y: cur.y, h: LH, ing: cur.ing, vy: 0, rot: 0, vr: cur.x < tp.x ? -3 : 3 });
      pops.add(cur.ing.name, left + ov / 2, cur.y + cam - 18, '#7a3e0c');
    }
    stack.push(layer);
    if (stack.length >= 100) { cur = null; finish(); return; }
    spawn();
    if (cur.y + cam < 300) camTarget = 300 - cur.y;
  }

  function drawBoard(ctx) {
    const by = base.y + base.h + 6 + cam;
    ctx.fillStyle = 'rgba(80,40,10,.15)';
    roundRect(ctx, 24, by + 4, 312, 30, 14); ctx.fill();
    const g = ctx.createLinearGradient(0, by, 0, by + 28);
    g.addColorStop(0, '#d9a066'); g.addColorStop(1, '#b0763f');
    ctx.fillStyle = g; roundRect(ctx, 20, by, 320, 28, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(110,60,20,.35)'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(30, by + 6 + i * 5); ctx.bezierCurveTo(120, by + 3 + i * 6, 220, by + 10 + i * 4, 330, by + 5 + i * 5); ctx.stroke(); }
    ctx.fillStyle = '#fff4e6'; ctx.beginPath(); ctx.arc(322, by + 14, 5, 0, Math.PI * 2); ctx.fill();
  }

  return {
    get score() { return score; },
    get over() { return over; },
    summary: () => `${stack.length} ${stack.length === 1 ? 'ingrediente' : 'ingredientes'}`,
    onDown() { drop(); },
    update(dt) {
      t += dt;
      wowT = Math.max(0, wowT - dt);
      if (cur) {
        cur.x += cur.dir * cur.speed * dt;
        const minX = -cur.w * 0.5, maxX = W - cur.w * 0.5;
        if (cur.x < minX) { cur.x = minX; cur.dir = 1; }
        if (cur.x > maxX) { cur.x = maxX; cur.dir = -1; }
      }
      if (lid) lid.y += (lid.target - lid.y) * Math.min(1, dt * 9);
      cam += (camTarget - cam) * Math.min(1, dt * 6);
      for (const f of falling) { f.vy += 1400 * dt; f.y += f.vy * dt; f.rot += f.vr * dt; }
      pops.update(dt);
    },
    draw(ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#fff4e6');
      g.addColorStop(1, '#ffe8cc');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(232,89,12,.05)';
      for (let yy = 0; yy < H; yy += 48) for (let xx = (yy / 48) % 2 ? 0 : 24; xx < W; xx += 48) ctx.fillRect(xx, yy, 24, 24);

      drawBoard(ctx);
      bottomBread(ctx, base.x, base.y + cam, base.w, base.h);
      const lookX = cur ? cur.x + cur.w / 2 : 180;
      const mood = over && stack.length < 3 ? 'sad' : wowT > 0 ? 'wow' : 'happy';
      breadFace(ctx, base.x + base.w / 2, base.y + cam + 18, lookX, mood);
      for (const l of stack) {
        ctx.save();
        ctx.fillStyle = 'rgba(80,40,10,.12)';
        ctx.fillRect(l.x + 2, l.y + cam + LAYER_H - 1, l.w - 4, 3);
        l.ing.draw(ctx, l.x, l.y + cam, l.w);
        ctx.restore();
      }
      if (lid) topBread(ctx, lid.x, lid.y + cam, lid.w, 28);
      if (cur) { ctx.save(); cur.ing.draw(ctx, cur.x, cur.y + cam, cur.w); ctx.restore(); }
      for (const f of falling) {
        ctx.save();
        ctx.translate(f.x + f.w / 2, f.y + cam + f.h / 2);
        ctx.rotate(f.rot);
        f.ing.draw(ctx, -f.w / 2, -f.h / 2, f.w);
        ctx.restore();
      }
      pops.draw(ctx);
      hud(ctx, `🥪 ${stack.length} ${stack.length === 1 ? 'piso' : 'pisos'}`, `${score} pts`);
      if (t < 2.5 && !stack.length) text(ctx, 'Toca para soltar', 180, 250, { size: 18, color: '#862e00', alpha: 1 - t / 2.5 });
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
// 🥖 Corta la barra (y todo lo que salte)
// ---------------------------------------------------------------------------
// Carita kawaii
function cuteFace(ctx, x, y, s = 1, mood = 'happy') {
  for (const k of [-1, 1]) {
    ctx.fillStyle = '#2b1608';
    ctx.beginPath(); ctx.ellipse(x + k * 7 * s, y, 2.6 * s, 3.2 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x + k * 7 * s - 0.8 * s, y - 1.1 * s, 0.95 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,110,130,.5)';
    ctx.beginPath(); ctx.ellipse(x + k * 12 * s, y + 5 * s, 3.2 * s, 1.9 * s, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#2b1608'; ctx.lineWidth = 1.6 * s; ctx.lineCap = 'round';
  ctx.beginPath();
  if (mood === 'o') { ctx.fillStyle = '#2b1608'; ctx.ellipse(x, y + 5.5 * s, 2 * s, 2.6 * s, 0, 0, Math.PI * 2); ctx.fill(); }
  else { ctx.arc(x, y + 2.5 * s, 3.4 * s, Math.PI * 0.18, Math.PI * 0.82); ctx.stroke(); }
}
function shine(ctx, x, y, rx, ry, rot = -0.5, a = 0.45) {
  ctx.fillStyle = `rgba(255,255,255,${a})`;
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill();
}
function capsule(ctx, len, th) {
  ctx.beginPath();
  ctx.moveTo(-len / 2 + th / 2, -th / 2);
  ctx.lineTo(len / 2 - th / 2, -th / 2);
  ctx.arc(len / 2 - th / 2, 0, th / 2, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(-len / 2 + th / 2, th / 2);
  ctx.arc(-len / 2 + th / 2, 0, th / 2, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
}

// Sprites centrados en (0,0). cut = se ve el interior (al partirlo)
const SPRITES = {
  pan: { r: 36, pts: 1, juice: '#e9b872', draw(ctx, cut, gold = false) {
    capsule(ctx, 100, 30);
    const g = ctx.createLinearGradient(0, -15, 0, 15);
    if (gold) { g.addColorStop(0, '#fff3bf'); g.addColorStop(0.5, '#fcc419'); g.addColorStop(1, '#e67700'); }
    else { g.addColorStop(0, '#f2c27b'); g.addColorStop(0.55, '#d98d3b'); g.addColorStop(1, '#a4601f'); }
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = gold ? '#b35c00' : '#7a4318'; ctx.lineWidth = 2; ctx.stroke();
    if (cut) {
      capsule(ctx, 92, 22); ctx.fillStyle = gold ? '#fff9db' : '#fff1d6'; ctx.fill();
      ctx.fillStyle = gold ? 'rgba(240,180,0,.5)' : 'rgba(210,160,100,.55)';
      for (let i = 0; i < 14; i++) { ctx.beginPath(); ctx.ellipse(-40 + hsh(i) * 80, -7 + hsh(i + 20) * 14, 2.2, 1.4, 0, 0, Math.PI * 2); ctx.fill(); }
      return;
    }
    for (let i = 0; i < 4; i++) {
      ctx.save(); ctx.translate(-33 + i * 22, -2); ctx.rotate(-0.55);
      ctx.fillStyle = gold ? '#fff3bf' : '#f8d9a0'; ctx.beginPath(); ctx.ellipse(0, 0, 11, 3.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (let i = 0; i < 10; i++) ctx.fillRect(-44 + hsh(i + 5) * 88, -12 + hsh(i + 50) * 22, 1.4, 1.4);
    shine(ctx, -20, -9, 16, 2.4, 0, 0.35);
    cuteFace(ctx, 0, 3, 1.05);
    if (gold) { ctx.fillStyle = '#fff'; for (const [sx, sy] of [[-40, -18], [42, -14], [30, 18]]) { ctx.beginPath(); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx + 1.5, sy - 1.5); ctx.lineTo(sx + 5, sy); ctx.lineTo(sx + 1.5, sy + 1.5); ctx.lineTo(sx, sy + 5); ctx.lineTo(sx - 1.5, sy + 1.5); ctx.lineTo(sx - 5, sy); ctx.lineTo(sx - 1.5, sy - 1.5); ctx.fill(); } }
  } },
  tomate: { r: 30, pts: 1, juice: '#e03131', draw(ctx, cut) {
    ctx.beginPath(); ctx.arc(0, 2, 24, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(-8, -6, 4, 0, 2, 26); g.addColorStop(0, '#ff8787'); g.addColorStop(1, '#c92a2a');
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = '#a61e1e'; ctx.lineWidth = 1.8; ctx.stroke();
    if (cut) {
      ctx.beginPath(); ctx.arc(0, 2, 19, 0, Math.PI * 2); ctx.fillStyle = '#ff6b6b'; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 2, 6, 0, Math.PI * 2); ctx.fillStyle = '#ffa8a8'; ctx.fill();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.fillStyle = '#ffc9c9'; ctx.beginPath(); ctx.ellipse(Math.cos(a) * 12, 2 + Math.sin(a) * 12, 5, 3.2, a, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffd43b'; ctx.beginPath(); ctx.arc(Math.cos(a) * 12, 2 + Math.sin(a) * 12, 1.3, 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    shine(ctx, -9, -8, 7, 4);
    ctx.fillStyle = '#2f9e44';
    for (let i = 0; i < 5; i++) { ctx.save(); ctx.translate(0, -20); ctx.rotate((i / 5) * Math.PI * 2); ctx.beginPath(); ctx.ellipse(0, -5, 2.6, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    ctx.fillStyle = '#2b8a3e'; ctx.fillRect(-1.5, -30, 3, 8);
    cuteFace(ctx, 0, 6);
  } },
  pimiento: { r: 30, pts: 1, juice: '#f03e3e', draw(ctx, cut) {
    ctx.beginPath();
    ctx.moveTo(-18, -14);
    ctx.bezierCurveTo(-30, 0, -26, 24, -12, 26);
    ctx.bezierCurveTo(-6, 20, -2, 30, 4, 26);
    ctx.bezierCurveTo(10, 30, 14, 20, 16, 26);
    ctx.bezierCurveTo(30, 22, 30, 0, 18, -14);
    ctx.bezierCurveTo(8, -20, -8, -20, -18, -14);
    ctx.closePath();
    const g = ctx.createLinearGradient(-24, 0, 24, 0); g.addColorStop(0, '#c92a2a'); g.addColorStop(0.45, '#fa5252'); g.addColorStop(1, '#a61e1e');
    ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = '#8f1b1b'; ctx.lineWidth = 1.8; ctx.stroke();
    if (cut) {
      ctx.beginPath(); ctx.ellipse(0, 6, 16, 16, 0, 0, Math.PI * 2); ctx.fillStyle = '#fff5f5'; ctx.fill();
      ctx.fillStyle = '#fff3bf';
      for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.ellipse(-5 + hsh(i) * 10, 0 + hsh(i + 9) * 12, 2, 1.4, hsh(i), 0, Math.PI * 2); ctx.fill(); }
      return;
    }
    ctx.strokeStyle = 'rgba(120,20,20,.35)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-6, -12); ctx.quadraticCurveTo(-10, 8, -6, 24); ctx.moveTo(8, -12); ctx.quadraticCurveTo(12, 8, 8, 24); ctx.stroke();
    shine(ctx, -12, -2, 3, 9, 0.2);
    ctx.fillStyle = '#2f9e44'; ctx.beginPath(); ctx.ellipse(0, -16, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2b8a3e'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(0, -18); ctx.quadraticCurveTo(2, -28, 9, -30); ctx.stroke();
    cuteFace(ctx, 0, 4);
  } },
  queso: { r: 30, pts: 1, juice: '#fcc419', draw(ctx, cut) {
    ctx.beginPath(); ctx.moveTo(-28, 18); ctx.lineTo(26, 18); ctx.lineTo(26, -4); ctx.lineTo(-28, -20); ctx.closePath();
    ctx.fillStyle = cut ? '#fff3bf' : '#ffd43b'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(-28, -20); ctx.lineTo(26, -4); ctx.lineTo(30, -8); ctx.lineTo(-22, -24); ctx.closePath();
    ctx.fillStyle = '#fab005'; ctx.fill();
    ctx.strokeStyle = '#e8a400'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(-28, 18); ctx.lineTo(26, 18); ctx.lineTo(26, -4); ctx.lineTo(30, -8); ctx.lineTo(-22, -24); ctx.lineTo(-28, -20); ctx.closePath(); ctx.stroke();
    ctx.fillStyle = cut ? 'rgba(250,176,5,.5)' : '#f59f00';
    for (const [hx, hy, hr] of [[-16, 8, 4], [14, 10, 3], [4, -1, 2.5], [-20, -8, 2.2], [18, 1, 2]]) { ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.fill(); }
    if (!cut) { shine(ctx, -6, 12, 9, 1.8, 0, 0.35); cuteFace(ctx, 2, 6, 0.9); }
  } },
  cebolla: { r: 28, pts: 1, juice: '#e599f7', draw(ctx, cut) {
    ctx.beginPath();
    ctx.moveTo(0, -28);
    ctx.bezierCurveTo(8, -18, 26, -8, 24, 8);
    ctx.bezierCurveTo(22, 22, 10, 26, 0, 26);
    ctx.bezierCurveTo(-10, 26, -22, 22, -24, 8);
    ctx.bezierCurveTo(-26, -8, -8, -18, 0, -28);
    ctx.closePath();
    const g = ctx.createRadialGradient(-6, 0, 4, 0, 4, 28); g.addColorStop(0, '#e599f7'); g.addColorStop(1, '#862e9c');
    ctx.fillStyle = cut ? '#f8f0fc' : g; ctx.fill(); ctx.strokeStyle = '#702a85'; ctx.lineWidth = 1.8; ctx.stroke();
    if (cut) {
      for (const rr of [18, 12, 6]) { ctx.beginPath(); ctx.ellipse(0, 6, rr, rr * 0.95, 0, 0, Math.PI * 2); ctx.strokeStyle = '#da77f2'; ctx.lineWidth = 2.4; ctx.stroke(); }
      return;
    }
    ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, -24); ctx.quadraticCurveTo(-14, 0, -6, 24); ctx.moveTo(0, -24); ctx.quadraticCurveTo(14, 0, 6, 24); ctx.stroke();
    ctx.strokeStyle = '#d0bfae'; ctx.lineWidth = 1.2;
    for (const dx of [-4, 0, 4]) { ctx.beginPath(); ctx.moveTo(dx * 0.5, 26); ctx.lineTo(dx, 31); ctx.stroke(); }
    cuteFace(ctx, 0, 6);
  } },
  huevo: { r: 26, pts: 1, juice: '#fcc419', draw(ctx, cut) {
    ctx.beginPath(); ctx.ellipse(0, 2, 20, 25, 0, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(-6, -8, 3, 0, 2, 26); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#f1e3c6');
    ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = '#d6c29b'; ctx.lineWidth = 1.6; ctx.stroke();
    if (cut) {
      ctx.beginPath(); ctx.arc(0, 4, 10, 0, Math.PI * 2); ctx.fillStyle = '#fab005'; ctx.fill();
      shine(ctx, -3, 1, 3, 2, 0, 0.6);
      return;
    }
    shine(ctx, -8, -10, 4, 7, 0.3, 0.7);
    cuteFace(ctx, 0, 6, 0.95);
  } },
  longaniza: { r: 34, pts: 1, juice: '#c2255c', draw(ctx, cut) {
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#8c2233'; ctx.lineWidth = 22;
    ctx.beginPath(); ctx.moveTo(-34, 6); ctx.quadraticCurveTo(0, -22, 34, 6); ctx.stroke();
    ctx.strokeStyle = cut ? '#f783ac' : '#e0566b'; ctx.lineWidth = 18;
    ctx.beginPath(); ctx.moveTo(-34, 6); ctx.quadraticCurveTo(0, -22, 34, 6); ctx.stroke();
    if (cut) {
      ctx.fillStyle = '#fff0f6';
      for (let i = 0; i < 14; i++) { const t = hsh(i); const px = -30 + t * 60; ctx.fillRect(px, -9 + 14 * Math.pow((px / 34), 2) + (hsh(i + 7) - 0.5) * 10, 2, 2); }
      return;
    }
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-24, -1); ctx.quadraticCurveTo(0, -18, 24, -1); ctx.stroke();
    ctx.strokeStyle = '#f1e3c6'; ctx.lineWidth = 2;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * 38, 8); ctx.lineTo(s * 44, 12); ctx.stroke(); }
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 6; i++) ctx.fillRect(-26 + i * 10, -4 + Math.abs(i - 2.5) * 2.5, 1.6, 1.6);
    cuteFace(ctx, 0, -5, 0.9);
  } },
  berenjena: { r: 32, pts: 1, juice: '#b197fc', draw(ctx, cut) {
    ctx.beginPath();
    ctx.moveTo(-6, -24);
    ctx.bezierCurveTo(8, -26, 12, -10, 18, 4);
    ctx.bezierCurveTo(26, 22, 12, 32, 0, 30);
    ctx.bezierCurveTo(-16, 30, -24, 18, -18, 2);
    ctx.bezierCurveTo(-14, -10, -18, -22, -6, -24);
    ctx.closePath();
    const g = ctx.createLinearGradient(-20, 0, 22, 0); g.addColorStop(0, '#5f3dc4'); g.addColorStop(0.4, '#845ef7'); g.addColorStop(1, '#3b1f86');
    ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = '#2d1766'; ctx.lineWidth = 1.8; ctx.stroke();
    if (cut) {
      ctx.beginPath(); ctx.ellipse(0, 8, 14, 18, 0, 0, Math.PI * 2); ctx.fillStyle = '#fff3bf'; ctx.fill();
      ctx.fillStyle = '#c9a66b';
      for (let i = 0; i < 12; i++) { ctx.beginPath(); ctx.arc(-6 + hsh(i) * 12, -2 + hsh(i + 30) * 20, 1.2, 0, Math.PI * 2); ctx.fill(); }
      return;
    }
    shine(ctx, -10, 4, 3, 10, 0.2, 0.4);
    ctx.fillStyle = '#2f9e44';
    ctx.beginPath(); ctx.moveTo(-14, -20); ctx.quadraticCurveTo(-4, -12, 8, -22); ctx.quadraticCurveTo(0, -32, -14, -20); ctx.fill();
    ctx.strokeStyle = '#2b8a3e'; ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-4, -24); ctx.lineTo(-2, -33); ctx.stroke();
    cuteFace(ctx, 0, 10, 0.95);
  } },
  cuchillo: { r: 24, knife: true, draw(ctx) {
    ctx.save(); ctx.rotate(-0.2);
    ctx.fillStyle = '#5c3a21'; roundRect(ctx, 14, -6, 34, 12, 5); ctx.fill();
    ctx.strokeStyle = '#3b2314'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#e9ecef'; for (const rx of [22, 32, 42]) { ctx.beginPath(); ctx.arc(rx, 0, 1.8, 0, Math.PI * 2); ctx.fill(); }
    ctx.beginPath(); ctx.moveTo(14, -8); ctx.lineTo(-40, -8); ctx.quadraticCurveTo(-50, -2, -46, 6); ctx.lineTo(14, 8); ctx.closePath();
    const g = ctx.createLinearGradient(0, -8, 0, 8); g.addColorStop(0, '#f8f9fa'); g.addColorStop(0.5, '#ced4da'); g.addColorStop(1, '#868e96');
    ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = '#495057'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(10, -5); ctx.lineTo(-38, -5); ctx.stroke();
    ctx.fillStyle = '#e03131'; ctx.font = `800 13px ${UI_FONT}`; ctx.textAlign = 'center'; ctx.fillText('!', -16, 5);
    ctx.restore();
  } },
};
const FRUITS = ['pan', 'pan', 'pan', 'tomate', 'tomate', 'pimiento', 'pimiento', 'queso', 'queso', 'cebolla', 'huevo', 'longaniza', 'longaniza', 'berenjena'];

function barra(seed) {
  const r = rng(seed);
  const DUR = 30, GRAV = 1000;
  const schedule = [];
  for (let t = 0.6; t < DUR - 1;) {
    const p = t / DUR;
    const n = 1 + Math.floor(r() * (p < 0.3 ? 2 : 3));
    for (let k = 0; k < n; k++) {
      const x0 = 50 + r() * 260;
      const roll = r();
      const type = roll < 0.12 + 0.1 * p ? 'cuchillo' : roll > 0.975 ? 'oro' : FRUITS[Math.floor(r() * FRUITS.length)];
      schedule.push({
        t: t + k * 0.12, type, x: x0, y: H + 30,
        vx: (r() - 0.5) * 220 + (180 - x0) * 0.5, vy: -(900 + r() * 150), vr: (r() - 0.5) * 6,
      });
    }
    t += lerp(1.3, 0.75, p) * (0.85 + r() * 0.3);
  }
  const pops = popups();
  let time = 0, next = 0, score = 0, lives = 3, over = false, cut = 0, flash = 0;
  const objs = [], halves = [], trail = [], drops = [], splats = [];
  let down = false, last = null, combo = 0;

  const spr = (type) => SPRITES[type === 'oro' ? 'pan' : type];
  const drawType = (ctx, type, isCut) => spr(type).draw(ctx, isCut, type === 'oro');

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
      const S = spr(o.type);
      if (segDist(o.x, o.y, a.x, a.y, b.x, b.y) < S.r) {
        o.dead = true;
        if (S.knife) { lives--; flash = 0.35; pops.add('¡Ay! 🩹', o.x, o.y - 30, '#ff8787'); continue; }
        const pts = o.type === 'oro' ? 5 : 1;
        score += pts; cut++; combo++;
        if (pts > 1) pops.add('¡Barra de oro! +5', o.x, o.y - 34, '#ffe066');
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const nx = Math.cos(ang + Math.PI / 2), ny = Math.sin(ang + Math.PI / 2);
        for (const s of [-1, 1]) halves.push({ type: o.type, x: o.x, y: o.y, vx: o.vx * 0.6 + nx * 110 * s, vy: o.vy * 0.3 + ny * 110 * s, rot: o.rot, cut: ang, side: s, vr: o.vr + s * 3, t: 0 });
        const color = o.type === 'oro' ? '#ffd43b' : S.juice;
        for (let i = 0; i < 12; i++) {
          const a2 = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 220;
          drops.push({ x: o.x, y: o.y, vx: Math.cos(a2) * sp, vy: Math.sin(a2) * sp - 80, r: 2 + Math.random() * 3.5, color, t: 0 });
        }
        splats.push({ x: o.x, y: o.y, color, r: 16 + Math.random() * 10, t: 0, seed: Math.random() * 100 });
      }
    }
  }
  function endSwipe() {
    if (combo >= 2) { score += combo - 1; pops.add(`¡Combo x${combo}! +${combo - 1}`, 180, 220, '#ffe066'); }
    combo = 0; down = false; last = null;
  }

  // Tabla de cortar (se dibuja una vez)
  const bg = document.createElement('canvas');
  bg.width = W; bg.height = H;
  {
    const c = bg.getContext('2d');
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#c8945e'); g.addColorStop(1, '#9e6a3a');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    for (let i = 0; i < 26; i++) {
      c.strokeStyle = `rgba(90,50,20,${0.08 + hsh(i) * 0.12})`; c.lineWidth = 1 + hsh(i + 3) * 2;
      const y0 = (i / 26) * H + hsh(i + 9) * 10;
      c.beginPath(); c.moveTo(0, y0); c.bezierCurveTo(W * 0.3, y0 + (hsh(i + 1) - 0.5) * 30, W * 0.7, y0 + (hsh(i + 2) - 0.5) * 30, W, y0 + (hsh(i + 4) - 0.5) * 20); c.stroke();
    }
    for (let i = 0; i < 3; i++) { c.fillStyle = 'rgba(90,50,20,.18)'; c.beginPath(); c.ellipse(40 + hsh(i + 70) * 280, 80 + hsh(i + 80) * 480, 9, 5, 0.3, 0, Math.PI * 2); c.fill(); }
    const v = c.createRadialGradient(W / 2, H / 2, 150, W / 2, H / 2, 420);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(40,20,5,.45)');
    c.fillStyle = v; c.fillRect(0, 0, W, H);
  }

  return {
    get score() { return score; },
    get over() { return over; },
    summary: () => `${cut} ${cut === 1 ? 'corte' : 'cortes'}`,
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
      flash = Math.max(0, flash - dt);
      for (const tp of trail) tp.t += dt;
      while (trail.length && trail[0].t > 0.18) trail.shift();
      for (const h of halves) { h.vy += GRAV * dt; h.x += h.vx * dt; h.y += h.vy * dt; h.rot += h.vr * dt; h.t += dt; }
      for (const d of drops) { d.vy += 700 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.t += dt; }
      for (const s of splats) s.t += dt;
      while (drops.length && drops[0].t > 1) drops.shift();
      while (splats.length && splats[0].t > 2.5) splats.shift();
      if (over) return;
      time += dt;
      while (next < schedule.length && schedule[next].t <= time) objs.push({ ...schedule[next++], rot: 0 });
      for (const o of objs) {
        if (o.dead) continue;
        o.vy += GRAV * dt; o.x += o.vx * dt; o.y += o.vy * dt; o.rot += o.vr * dt;
        if (o.vy > 0 && o.y > H + 70) o.dead = true;
      }
      if (lives <= 0 || time >= DUR) { if (down) endSwipe(); over = true; }
    },
    draw(ctx) {
      ctx.drawImage(bg, 0, 0, W, H);
      for (const s of splats) {
        ctx.save(); ctx.globalAlpha = 0.35 * (1 - s.t / 2.5); ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
        for (let i = 0; i < 6; i++) { const a = s.seed + i; ctx.beginPath(); ctx.arc(s.x + Math.cos(a) * s.r * 1.3, s.y + Math.sin(a) * s.r * 1.3, 3 + (i % 3), 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
      for (const h of halves) {
        if (h.t > 1.3) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - h.t / 1.3);
        ctx.translate(h.x, h.y);
        ctx.rotate(h.cut);
        ctx.beginPath(); ctx.rect(-80, h.side < 0 ? -80 : 0, 160, 80); ctx.clip();
        ctx.rotate(-h.cut + h.rot);
        drawType(ctx, h.type, true);
        ctx.restore();
      }
      for (const o of objs) {
        if (o.dead) continue;
        ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot);
        ctx.fillStyle = 'rgba(40,20,5,.18)'; ctx.beginPath(); ctx.ellipse(4, 30, spr(o.type).r * 0.8, 6, 0, 0, Math.PI * 2); ctx.fill();
        drawType(ctx, o.type, false);
        ctx.restore();
      }
      for (const d of drops) { ctx.globalAlpha = Math.max(0, 1 - d.t); ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
      if (trail.length > 1) {
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const [wdt, col] of [[9, 'rgba(255,255,255,.25)'], [4, 'rgba(255,255,255,.95)']]) {
          ctx.strokeStyle = col; ctx.lineWidth = wdt; ctx.beginPath();
          trail.forEach((tp, k) => (k ? ctx.lineTo(tp.x, tp.y) : ctx.moveTo(tp.x, tp.y)));
          ctx.stroke();
        }
      }
      if (flash > 0) { ctx.fillStyle = `rgba(224,49,49,${flash})`; ctx.fillRect(0, 0, W, H); }
      pops.draw(ctx);
      hud(ctx, `⏱ ${Math.max(0, Math.ceil(DUR - time))} s   ${'❤️'.repeat(Math.max(0, lives))}`, `${score} pts`);
      if (time < 2.5) text(ctx, 'Desliza para cortar', 180, 300, { size: 17, alpha: 1 - time / 2.5 });
    },
  };
}

const FACTORIES = { bocata, cacaos, barra };
export const _factories = FACTORIES;   // para pruebas
export const _art = { INGREDIENTS, SPRITES, bottomBread, topBread, breadFace };   // para pruebas

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
  const N = GAME_ORDER.length, SEG = 360 / N;
  const seg = GAME_ORDER.map((k, i) => {
    const a0 = (i * SEG - 90) * Math.PI / 180, a1 = ((i + 1) * SEG - 90) * Math.PI / 180, mid = (i * SEG + SEG / 2 - 90) * Math.PI / 180;
    const p = (a, rr) => `${150 + rr * Math.cos(a)},${150 + rr * Math.sin(a)}`;
    return `<path d="M150,150 L${p(a0, 140)} A140,140 0 0 1 ${p(a1, 140)} Z" fill="${GAMES[k].color}" stroke="#fff" stroke-width="4"/>
      <text x="${150 + 86 * Math.cos(mid)}" y="${150 + 86 * Math.sin(mid)}" font-size="46" text-anchor="middle" dominant-baseline="central">${GAMES[k].emoji}</text>`;
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
      const SEGD = 360 / GAME_ORDER.length;
      const jitter = (Math.random() - 0.5) * SEGD * 0.6;
      const deg = 360 * 6 - (i * SEGD + SEGD / 2) + jitter;
      wheel.style.transition = 'transform 3.6s cubic-bezier(.12,.72,.14,1)';
      wheel.style.transform = `rotate(${deg}deg)`;
      return new Promise((resolve) => setTimeout(() => {
        el.querySelector('.wheel-result').innerHTML = `<div class="big">${GAMES[game].emoji}</div><strong>${GAMES[game].name}</strong>`;
        resolve();
      }, 3700));
    },
  };
}
