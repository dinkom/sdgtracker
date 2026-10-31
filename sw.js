const CACHE = 'calquest-v18';
const ASSETS = ['./', './index.html', './skinovi/skinovi.json', './skinovi/osnovni.css', './skinovi/jesen.css', './skinovi/bozic.css', './calquest.webmanifest', './sdg-icon-192.png', './sdg-icon-512.png', './sdg-icon-maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// Mreža prvo, uz provjeru svježine (zaobilazi HTTP međuspremnik); predmemorija kad nema interneta.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request.url, {cache: 'no-cache'}).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
