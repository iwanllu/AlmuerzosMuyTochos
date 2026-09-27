// Almuerzos Muy Tochos · service worker: recibe los avisos push y los muestra
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    // Numerito en el icono de la app (iPhone con la web en inicio, Android con la app instalada)
    try {
      if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
        if (data.badge > 0) await self.navigator.setAppBadge(data.badge);
        else await self.navigator.clearAppBadge();
      }
    } catch { /* no disponible */ }
    await self.registration.showNotification(data.title || 'Almuerzos Muy Tochos', {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: data.url || '#/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = event.notification.data?.url || '#/';
  const url = new URL(hash, self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        w.postMessage({ type: 'go', url: hash });
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
