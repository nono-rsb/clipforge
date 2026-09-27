// Mini serveur local pour ClipForge (aucune dépendance).
// Les en-têtes COOP/COEP activent le multi-thread WebAssembly → transcription plus rapide.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

const openBrowser = url => {
  if (!process.env.NO_OPEN) exec(process.platform === 'win32' ? `start "" ${url}` : `open ${url}`);
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cache-Control': 'no-cache',
    });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ✂  ClipForge est lancé → ${url}\n  (fermez cette fenêtre pour arrêter)\n`);
  openBrowser(url);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    // ClipForge tourne déjà : on ouvre simplement la page.
    console.log(`\n  ClipForge est déjà lancé → http://localhost:${PORT}\n`);
    openBrowser(`http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 1500);
  } else throw err;
});
