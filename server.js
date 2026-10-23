// Mini serveur local pour ClipForge (aucune dépendance).
// - Sert l'application. Les en-têtes COOP/COEP activent le multi-thread WebAssembly, d'où une transcription plus rapide.
// - Importe des vidéos depuis un lien (YouTube…) grâce à yt-dlp, installé à la demande dans ./bin.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, execFile, execFileSync, spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;
const BIN = path.join(ROOT, 'bin');
const DL = path.join(ROOT, 'downloads');
const WIN = process.platform === 'win32';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};

const YTDLP_URL = {
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
}[process.platform];
const FFMPEG_ZIP = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

const openBrowser = url => {
  if (!process.env.NO_OPEN) exec(WIN ? `start "" ${url}` : `open ${url}`);
};

/* ---------------- Outils (yt-dlp, ffmpeg) ---------------- */

function findTool(name) {
  const local = path.join(BIN, WIN ? `${name}.exe` : name);
  if (fs.existsSync(local)) return local;
  try {
    const out = execFileSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const get = (u, hops) => {
      https.get(u, { headers: { 'User-Agent': 'ClipForge' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops > 8) return reject(new Error('Trop de redirections'));
          return get(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const tmp = `${dest}.part`;
        const out = fs.createWriteStream(tmp);
        res.on('data', c => { got += c.length; onProgress?.(got, total); });
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
        res.pipe(out);
      }).on('error', reject);
    };
    get(url, 0);
  });
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name.toLowerCase() === name) return p;
  }
  return null;
}

let installing = false;
async function install(send) {
  fs.mkdirSync(BIN, { recursive: true });
  if (!findTool('yt-dlp')) {
    if (!YTDLP_URL) throw new Error('Système non pris en charge pour l\'installation automatique de yt-dlp');
    const dest = path.join(BIN, WIN ? 'yt-dlp.exe' : 'yt-dlp');
    await download(YTDLP_URL, dest, (got, total) => send({ type: 'progress', what: 'yt-dlp', got, total }));
    if (!WIN) fs.chmodSync(dest, 0o755);
  }
  if (!findTool('ffmpeg') && WIN) {
    const zip = path.join(BIN, 'ffmpeg.zip');
    const tmp = path.join(BIN, 'ffmpeg-tmp');
    await download(FFMPEG_ZIP, zip, (got, total) => send({ type: 'progress', what: 'ffmpeg', got, total }));
    send({ type: 'info', text: 'Décompression de ffmpeg…' });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    await new Promise((res, rej) => execFile('tar', ['-xf', zip, '-C', tmp], err => (err ? rej(err) : res())));
    // Seul ffmpeg.exe sert (assemblage image + son) ; ffprobe & co. prendraient 160 Mo de plus.
    const src = findFile(tmp, 'ffmpeg.exe');
    if (src) fs.renameSync(src, path.join(BIN, 'ffmpeg.exe'));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }
}

/* ---------------- Téléchargement d'une vidéo ---------------- */

function ytDownload(url, send, onChild) {
  return new Promise((resolve, reject) => {
    const ytdlp = findTool('yt-dlp');
    const ffmpeg = findTool('ffmpeg');
    fs.mkdirSync(DL, { recursive: true });
    // Avec ffmpeg : meilleure qualité jusqu'en 1080p (H.264 de préférence, lu partout).
    // Sans ffmpeg : seul un fichier déjà complet (souvent 360p) est possible.
    const format = ffmpeg
      ? 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[ext=mp4]/b'
      : 'b[ext=mp4]/b';
    const args = [
      '--no-playlist', '--newline', '--no-simulate', '--progress', '--restrict-filenames',
      // Certificats de Windows plutôt que ceux embarqués : indispensable si un antivirus
      // ou le réseau inspecte le HTTPS (sinon « CERTIFICATE_VERIFY_FAILED »).
      '--compat-options', 'no-certifi',
      // YouTube exige un moteur JavaScript : on prête Node.js, déjà installé.
      '--js-runtimes', `node:${process.execPath}`,
      '--print', 'before_dl:TITLE:%(title)s',
      '--print', 'after_move:FILE:%(filepath)s',
      '--progress-template', 'download:PROG:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '-f', format, '--merge-output-format', 'mp4',
      '-o', path.join(DL, '%(id)s.%(ext)s'),
    ];
    if (ffmpeg && ffmpeg.startsWith(BIN)) args.push('--ffmpeg-location', BIN);
    args.push(url);

    send({ type: 'info', text: ffmpeg ? 'Connexion à la vidéo…' : 'Connexion… (sans ffmpeg : qualité limitée)' });
    const child = spawn(ytdlp, args, { windowsHide: true });
    onChild(child);
    let file = null, title = null, part = 0, lastPct = 0;
    const errors = [];
    const onLine = line => {
      line = line.trim();
      if (!line) return;
      if (line.startsWith('TITLE:')) { title = line.slice(6); send({ type: 'title', title }); }
      else if (line.startsWith('FILE:')) file = line.slice(5);
      else if (line.startsWith('PROG:')) {
        const [pct, speed, eta] = line.slice(5).split('|').map(s => s.trim());
        const p = parseFloat(pct) || 0;
        if (p < lastPct - 50) part++; // 2e flux (audio après la vidéo)
        lastPct = p;
        send({ type: 'progress', pct: p, speed, eta, part });
      } else if (/\[Merger\]|\[VideoConvertor\]|\[FixupM3u8\]/.test(line)) send({ type: 'info', text: 'Assemblage de la vidéo et du son…' });
    };
    let buf = '';
    child.stdout.on('data', d => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); });
    child.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => { if (l.trim()) errors.push(l.trim()); }));
    child.on('error', reject);
    child.on('close', code => {
      if (buf) onLine(buf);
      if (code === 0 && file && fs.existsSync(file)) resolve({ file, title });
      else {
        const msg = errors.filter(l => l.startsWith('ERROR')).pop() || errors.pop() || `yt-dlp a échoué (code ${code})`;
        reject(new Error(msg.replace(/^ERROR:\s*/, '')));
      }
    });
  });
}

// Les vidéos téléchargées ne servent que le temps que le navigateur les charge :
// elles sont supprimées juste après l'import, et au démarrage s'il en reste.
function cleanDownloads() {
  if (!fs.existsSync(DL)) return;
  for (const f of fs.readdirSync(DL)) {
    try { fs.rmSync(path.join(DL, f), { force: true }); } catch {}
  }
}

/* ---------------- HTTP ---------------- */

function sse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  return obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
}

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function api(req, res, pathname, query) {
  if (pathname === '/api/yt/status') {
    return json(res, { ytdlp: !!findTool('yt-dlp'), ffmpeg: !!findTool('ffmpeg'), canInstallFfmpeg: WIN });
  }
  if (pathname === '/api/yt/install') {
    const send = sse(req, res);
    if (installing) { send({ type: 'error', message: 'Installation déjà en cours' }); return res.end(); }
    installing = true;
    console.log('  [YouTube] Installation de yt-dlp / ffmpeg…');
    try { await install(send); send({ type: 'done' }); console.log('  [YouTube] Outils installés.'); }
    catch (e) { send({ type: 'error', message: e.message }); console.error(`  [YouTube] Échec de l'installation : ${e.message}`); }
    finally { installing = false; res.end(); }
    return;
  }
  if (pathname === '/api/yt/cleanup') {
    const name = path.basename(query.get('name') || '');
    if (name) fs.rm(path.join(DL, name), { force: true }, () => {});
    return json(res, { ok: true });
  }
  if (pathname === '/api/yt/download') {
    const url = query.get('url') || '';
    const send = sse(req, res);
    if (!/^https?:\/\/\S+$/i.test(url)) { send({ type: 'error', message: 'Lien invalide' }); return res.end(); }
    if (!findTool('yt-dlp')) { send({ type: 'error', message: 'yt-dlp n\'est pas installé' }); return res.end(); }
    let child = null;
    req.on('close', () => { if (child && child.exitCode === null) child.kill(); });
    console.log(`  [YouTube] Téléchargement : ${url}`);
    try {
      const { file, title } = await ytDownload(url, send, c => { child = c; });
      send({ type: 'done', url: `/downloads/${encodeURIComponent(path.basename(file))}`, name: path.basename(file), title });
      console.log(`  [YouTube] OK : ${title}`);
    } catch (e) { send({ type: 'error', message: e.message }); console.error(`  [YouTube] Échec : ${e.message}`); }
    res.end();
    return;
  }
  res.writeHead(404).end();
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) { api(req, res, pathname, searchParams).catch(() => res.destroy()); return; }
  const url = decodeURIComponent(pathname);
  const file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
  if (!file.startsWith(ROOT) || file.startsWith(BIN)) { res.writeHead(403).end(); return; }
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
  cleanDownloads();
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
