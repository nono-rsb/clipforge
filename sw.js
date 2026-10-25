// Version installée sur l'écran d'accueil (iPhone, Android) : l'app reste utilisable sans connexion.
// Réseau d'abord pour toujours avoir la dernière version ; le cache ne sert que hors ligne.
const CACHE = 'clipforge-v1';
const SHELL = [
  './', 'index.html', 'legal.html', 'styles.css', 'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png',
  ...['analyzer', 'app', 'cache', 'emoji', 'exporter', 'faces', 'montage', 'renderer', 'save', 'tour', 'transcribe', 'whisper-worker'].map(f => `js/${f}.js`),
];
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Polices : gardées une fois pour toutes.
  if (FONTS.test(req.url)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return r;
    })));
    return;
  }
  // Modèles d'IA et bibliothèques : elles ont leur propre cache, on n'y touche pas.
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).then(r => {
    if (r.ok && r.type === 'basic') {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
