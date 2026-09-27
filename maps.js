// ===========================================================================
// Almuerzos Muy Tochos · Google Maps
//   · Buscador de sitios con mapa (sugerencias + tocar un sitio en el mapa)
//   · Foto y dirección para las tarjetas
//   · Web del sitio al tocar una tarjeta
//
// Coste: el buscador va por sesiones (gratis) y solo se pide a Google lo
// imprescindible. La web del sitio se consulta solo cuando alguien la abre.
// No se guarda nada de Google salvo el identificador del sitio.
// ===========================================================================

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT_CENTER = { lat: 39.4699, lng: -0.3763 };   // Valencia

let bootKey = null;
let authFailed = false;
const authListeners = new Set();
export const onMapsAuthError = (fn) => authListeners.add(fn);

export function mapsReady() { return !!(window.google?.maps?.importLibrary) && !authFailed; }

// Carga perezosa del SDK de Google Maps (cargador oficial de importLibrary)
export function loadMaps(key) {
  if (!key) return Promise.reject(new Error('Google Maps aún no está configurado'));
  if (authFailed && bootKey === key) return Promise.reject(new Error('La clave de Google Maps no es válida para esta web'));
  if (bootKey && bootKey !== key) {
    // Cambió la clave: hace falta recargar la página para usar la nueva
    return Promise.reject(new Error('Clave nueva guardada: recarga la app para usarla'));
  }
  if (!bootKey) {
    bootKey = key;
    window.gm_authFailure = () => {
      authFailed = true;
      authListeners.forEach((fn) => fn());
    };
    /* eslint-disable */
    ((g) => { var h, a, k, p = 'The Google Maps JavaScript API', c = 'google', l = 'importLibrary', q = '__ib__', m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set(), e = new URLSearchParams(), u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement('script')); e.set('libraries', [...r] + ''); for (k in g) e.set(k.replace(/[A-Z]/g, (t) => '_' + t[0].toLowerCase()), g[k]); e.set('callback', c + '.maps.' + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => (h = n(Error(p + ' could not load.'))); a.nonce = m.querySelector('script[nonce]')?.nonce || ''; m.head.append(a); })); d[l] ? console.warn(p + ' only loads once. Ignoring:', g) : (d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n))); })({ key, v: 'weekly', language: 'es', region: 'ES' });
    /* eslint-enable */
  }
  return window.google.maps.importLibrary('places').then(() => window.google.maps);
}

// ---------- Datos de un sitio (con caché en memoria mientras la app está abierta) ----------
const infoCache = new Map();
const linkCache = new Map();

// Fotos del sitio (solo el campo "photos": tarifa IDs Only, gratis e ilimitada;
// cada foto que se llega a ver cuenta como "Place Photo": 1.000 gratis/mes)
export const MAX_PHOTOS = 5;
export const photoList = (place) => (place.photos || []).slice(0, MAX_PHOTOS).map((ph) => {
  const a = ph.authorAttributions?.[0];
  return { url: ph.getURI({ maxWidth: 800, maxHeight: 600 }), author: a ? a.displayName : null };
});
export function placeInfo(key, id) {
  if (!id) return Promise.resolve(null);
  if (!infoCache.has(id)) {
    infoCache.set(id, loadMaps(key).then(async () => {
      const { Place } = await google.maps.importLibrary('places');
      const p = new Place({ id, requestedLanguage: 'es' });
      await p.fetchFields({ fields: ['photos'] });
      return { photos: photoList(p) };
    }).catch((e) => { infoCache.delete(id); throw e; }));
  }
  return infoCache.get(id);
}
export const cachedInfo = (id) => infoCache.get(id);

// Web y enlace de Google Maps (tarifa Enterprise: 1.000 gratis/mes → solo al tocar)
export function placeLinks(key, id) {
  if (!linkCache.has(id)) {
    linkCache.set(id, loadMaps(key).then(async () => {
      const { Place } = await google.maps.importLibrary('places');
      const p = new Place({ id, requestedLanguage: 'es' });
      await p.fetchFields({ fields: ['websiteURI', 'googleMapsURI'] });
      return { website: p.websiteURI || null, maps: p.googleMapsURI || null };
    }).catch((e) => { linkCache.delete(id); throw e; }));
  }
  return linkCache.get(id);
}
export const mapsSearchURL = (name) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name || '')}`;

// ---------- Buscador con mapa ----------
// Devuelve { place_id, name, note } o null si se cancela
export function pickPlace(key, { title = 'Añadir un sitio', button = 'Añadir a mi pool' } = {}) {
  return new Promise((resolve) => {
    let root = document.getElementById('picker-root');
    if (!root) { root = document.createElement('div'); root.id = 'picker-root'; document.body.append(root); }
    document.body.classList.add('no-scroll');
    root.innerHTML = `
      <div class="picker" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="pk-top">
          <button class="pk-close" aria-label="Cerrar">✕</button>
          <div class="pk-search">
            <span aria-hidden="true">🔎</span>
            <input id="pk-q" type="search" placeholder="Busca el bar o restaurante…" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
          </div>
          <button class="pk-locate" aria-label="Centrar en mi ubicación" title="Cerca de mí">📍</button>
        </div>
        <ul class="pk-results" role="listbox" hidden></ul>
        <div class="pk-map"><div class="pk-map-msg">Cargando Google Maps…</div></div>
        <div class="pk-panel">
          <p class="pk-hint">Escribe arriba o toca un sitio en el mapa.</p>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const input = $('#pk-q'), results = $('.pk-results'), panel = $('.pk-panel'), mapEl = $('.pk-map');
    let map, marker, token, selected = null, timer, closed = false, lastReq = 0;

    const close = (value) => {
      if (closed) return;
      closed = true;
      root.innerHTML = '';
      document.body.classList.remove('no-scroll');
      resolve(value);
    };
    $('.pk-close').onclick = () => close(null);

    const fail = (msg) => { mapEl.innerHTML = `<div class="pk-map-msg">⚠️ ${esc(msg)}</div>`; };
    onMapsAuthError(() => fail('La clave de Google Maps no es válida o no permite esta web. Avisa al admin.'));

    loadMaps(key).then(async () => {
      const [{ Map }, places, { AdvancedMarkerElement }] = await Promise.all([
        google.maps.importLibrary('maps'), google.maps.importLibrary('places'), google.maps.importLibrary('marker'),
      ]);
      if (closed) return;
      mapEl.innerHTML = '';
      map = new Map(mapEl, {
        center: DEFAULT_CENTER, zoom: 12, mapId: 'DEMO_MAP_ID',
        disableDefaultUI: true, zoomControl: true, clickableIcons: true, gestureHandling: 'greedy',
      });
      marker = new AdvancedMarkerElement({ map: null });
      token = new places.AutocompleteSessionToken();

      // Tocar un sitio del mapa
      map.addListener('click', (e) => {
        if (!e.placeId) return;
        e.stop?.();
        select(new places.Place({ id: e.placeId, requestedLanguage: 'es' }));
      });

      input.oninput = () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
        timer = setTimeout(async () => {
          const req = ++lastReq;
          try {
            const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
              input: q, sessionToken: token, language: 'es', region: 'es',
              locationBias: map.getBounds() || map.getCenter(),
            });
            if (req !== lastReq || closed) return;
            const preds = suggestions.map((s) => s.placePrediction).filter(Boolean);
            results.innerHTML = preds.length
              ? preds.map((p, i) => `<li role="option" data-i="${i}"><strong>${esc(p.mainText?.text || p.text.text)}</strong><span>${esc(p.secondaryText?.text || '')}</span></li>`).join('')
              : '<li class="pk-empty">Sin resultados</li>';
            results.hidden = false;
            results.querySelectorAll('[data-i]').forEach((li) => (li.onclick = () => {
              results.hidden = true;
              input.blur();
              select(preds[Number(li.dataset.i)].toPlace());
            }));
          } catch (err) {
            results.innerHTML = `<li class="pk-empty">No se pudo buscar: ${esc(err.message)}</li>`;
            results.hidden = false;
          }
        }, 250);
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); results.querySelector('[data-i]')?.click(); } };
      setTimeout(() => input.focus(), 50);

      $('.pk-locate').onclick = () => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
          (pos) => { map.panTo({ lat: pos.coords.latitude, lng: pos.coords.longitude }); map.setZoom(15); },
          () => {}, { enableHighAccuracy: true, timeout: 8000 });
      };

      async function select(place) {
        panel.innerHTML = '<p class="pk-hint">Cargando…</p>';
        try {
          await place.fetchFields({ fields: ['id', 'displayName', 'formattedAddress', 'location', 'photos', 'googleMapsURI', 'primaryTypeDisplayName'] });
        } catch (err) {
          panel.innerHTML = `<p class="pk-hint">⚠️ ${esc(err.message)}</p>`;
          return;
        }
        token = new places.AutocompleteSessionToken();   // la sesión de búsqueda termina aquí
        if (closed) return;
        selected = place;
        if (place.location) { map.panTo(place.location); map.setZoom(Math.max(map.getZoom(), 16)); marker.position = place.location; marker.map = map; }
        const photos = photoList(place);
        const gName = place.displayName || '';
        panel.innerHTML = `
          ${carouselHTML(photos)}
          <div class="pk-info">
            <strong>${esc(gName)}</strong>
            <span class="hint">${esc(place.primaryTypeDisplayName || '')}${place.primaryTypeDisplayName && place.formattedAddress ? ' · ' : ''}${esc(place.formattedAddress || '')}</span>
          </div>
          <div class="field"><label for="pk-name">Nombre para el grupo</label>
            <input class="input" id="pk-name" maxlength="80" value="${esc(gName.slice(0, 80))}" autocomplete="off"></div>
          <div class="pk-error error-text" role="alert"></div>
          <button class="btn primary block" id="pk-add">${esc(button)}</button>`;
        bindCarousel(panel.querySelector('.carousel'), photos);
        $('#pk-add').onclick = () => {
          const name = $('#pk-name').value.replace(/\s+/g, ' ').trim();
          if (name.length < 2) { $('.pk-error').textContent = 'Ponle un nombre'; return; }
          close({ place_id: selected.id, name, note: '' });
        };
      }
    }).catch((err) => fail(err.message));
  });
}

// ---------- Carrusel de fotos (se desliza con el dedo) ----------
export function carouselHTML(photos, { fallback = '🍽️', extra = '', attrs = '' } = {}) {
  const list = photos || [];
  return `<div class="carousel ${list.length > 1 ? 'multi' : 'single'}" ${attrs}>
    <div class="car-track">${list.length
      ? list.map((ph, i) => `<div class="car-slide"><img src="${esc(ph.url)}" alt="" ${i ? 'loading="lazy"' : ''} decoding="async" draggable="false"></div>`).join('')
      : `<div class="car-slide car-empty"><span>${fallback}</span></div>`}</div>
    ${extra}
    ${list.length > 1 ? `<div class="car-dots">${list.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
    ${list.length ? `<span class="car-attr">${list[0].author ? `📷 ${esc(list[0].author)} · ` : ''}Google Maps</span>` : ''}
    ${list.length > 1 ? '<button type="button" class="car-nav prev" aria-label="Foto anterior">‹</button><button type="button" class="car-nav next" aria-label="Foto siguiente">›</button>' : ''}
  </div>`;
}
export function bindCarousel(el, photos) {
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  const track = el.querySelector('.car-track');
  const dots = [...el.querySelectorAll('.car-dots i')];
  const attr = el.querySelector('.car-attr');
  const step = () => {
    const sl = track.children;
    return sl.length > 1 ? Math.max(1, sl[1].offsetLeft - sl[0].offsetLeft) : Math.max(1, track.clientWidth);
  };
  const idx = () => Math.min(track.children.length - 1, Math.round(track.scrollLeft / step()));
  const update = () => {
    const i = idx();
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
    const list = photos || el._photos;
    if (attr && list?.[i]) attr.textContent = `${list[i].author ? `📷 ${list[i].author} · ` : ''}Google Maps`;
    el.dataset.index = i;
  };
  track.addEventListener('scroll', update, { passive: true });
  el.querySelectorAll('.car-nav').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    track.scrollBy({ left: (b.classList.contains('next') ? 1 : -1) * step(), behavior: 'smooth' });
  }));
  el._update = update;
}
