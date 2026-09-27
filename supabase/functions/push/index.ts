// =====================================================================
// Almuerzos Muy Tochos · función "push" (Supabase Edge Function)
//
//   GET  → devuelve la clave pública VAPID (la web la usa para suscribirse)
//   POST → envía las notificaciones pendientes que ha provocado quien llama
//          (lo decide la base de datos con push_claim(); aquí no se lee nada más)
//
// Sin dependencias: Web Push (RFC 8291 + VAPID RFC 8292) con WebCrypto.
// Las claves VAPID se derivan de un secreto que el propio servidor ya tiene;
// nadie las introduce ni las ve. No usa la service_role.
// =====================================================================

const SUBJECT = 'https://iwanllu.github.io/AlmuerzosMuyTochos/';
const enc = new TextEncoder();

// ---------- utilidades de bytes ----------
export function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function bigToBytes(n, len = 32) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function bytesToBig(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

// ---------- curva P-256 (solo para obtener la clave pública a partir de la privada) ----------
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const G = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
           0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n];
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function inv(a, m = P) {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0, m);
}
function add(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  const l = x1 === x2 && y1 === y2 ? mod((3n * x1 * x1 + A) * inv(2n * y1)) : mod((y2 - y1) * inv(x2 - x1));
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}
export function mul(k, pt = G) {
  let r = null, q = pt;
  while (k > 0n) { if (k & 1n) r = add(r, q); q = add(q, q); k >>= 1n; }
  return r;
}

// ---------- claves VAPID deterministas a partir de un secreto del servidor ----------
export async function deriveVapid(secret) {
  if (!secret) throw new Error('Falta el secreto del servidor para las claves');
  const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('almuerzos-vapid'), info: enc.encode('v1') }, ikm, 256));
  const d = (bytesToBig(bits) % (N - 1n)) + 1n;
  const [x, y] = mul(d);
  const dB = bigToBytes(d), xB = bigToBytes(x), yB = bigToBytes(y);
  const privateKey = await crypto.subtle.importKey('jwk',
    { kty: 'EC', crv: 'P-256', d: b64u(dB), x: b64u(xB), y: b64u(yB), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { publicKey: b64u(concat(new Uint8Array([4]), xB, yB)), privateKey };
}

// Cabecera Authorization VAPID (JWT ES256)
export async function vapidHeader(endpoint, vapid, exp) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: exp ?? Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// Cifrado del mensaje (RFC 8291, aes128gcm). opts solo se usa en las pruebas.
export async function encryptPayload(plaintext, uaPublicB64, authB64, opts = {}) {
  const uaPublic = unb64u(uaPublicB64);
  const authSecret = unb64u(authB64);
  let asPrivate, asPublic;
  if (opts.asPrivate) {
    asPublic = unb64u(opts.asPublic);
    asPrivate = await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', d: opts.asPrivate, x: b64u(asPublic.slice(1, 33)), y: b64u(asPublic.slice(33, 65)), ext: true,
    }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = opts.salt ? unb64u(opts.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const data = concat(typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, data));
  return concat(salt, new Uint8Array([0, 0, 16, 0, 65]), asPublic, ct);   // rs=4096, idlen=65
}

export async function sendPush(msg, vapid) {
  const body = await encryptPayload(JSON.stringify(msg.payload), msg.p256dh, msg.auth);
  const res = await fetch(msg.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: await vapidHeader(msg.endpoint, vapid),
    },
    body,
  });
  return res.status;
}

// ---------- servidor ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

if (typeof Deno !== 'undefined' && Deno.serve) {
  let vapidPromise = null;
  const getVapid = () => (vapidPromise ??= deriveVapid(Deno.env.get('SUPABASE_DB_URL')));

  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    try {
      const vapid = await getVapid();
      if (req.method === 'GET') return json({ publicKey: vapid.publicKey });

      const authorization = req.headers.get('Authorization');
      const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY');
      if (!authorization) return json({ error: 'Falta la sesión' }, 401);
      const rpc = (fn, args) => fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey, Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(args ?? {}),
      });

      // Solo los avisos que ha provocado este usuario (lo filtra la base de datos)
      const claim = await rpc('push_claim');
      if (!claim.ok) return json({ error: await claim.text() }, claim.status);
      const { ids, messages } = await claim.json();

      let sent = 0, failed = 0;
      const gone = [];
      await Promise.all(messages.map(async (m) => {
        try {
          const status = await sendPush(m, vapid);
          if (status >= 200 && status < 300) sent++;
          else { failed++; if (status === 404 || status === 410) gone.push(m.endpoint); }
        } catch (_e) { failed++; }
      }));
      if (ids.length) await rpc('push_done', { p_ids: ids, p_gone: gone });
      return json({ sent, failed, gone: gone.length });
    } catch (e) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  });
}
