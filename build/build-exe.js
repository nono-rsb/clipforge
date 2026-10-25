// Fabrique dist/ClipForge.exe (ou dist/ClipForge hors Windows) : un seul fichier qui contient
// Node.js, server.js et les fichiers de l'app (Node SEA). Lancer : node build/build-exe.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WIN = process.platform === 'win32';
const exe = path.join(DIST, WIN ? 'ClipForge.exe' : 'ClipForge');
const blob = path.join(DIST, 'sea-prep.blob');
const config = path.join(DIST, 'sea-config.json');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);

const files = ['index.html', 'styles.css', 'manifest.webmanifest', ...['js', 'icons'].flatMap(d => fs.readdirSync(path.join(ROOT, d)).map(f => `${d}/${f}`))];
const assets = Object.fromEntries(files.map(f => [f, path.join(ROOT, f)]));
fs.writeFileSync(config, JSON.stringify({
  main: path.join(ROOT, 'server.js'),
  output: blob,
  disableExperimentalSEAWarning: true,
  assets,
}, null, 2));

// Le shell ne sert qu'à npx (npx.cmd sous Windows) : le chemin de node.exe peut contenir des espaces.
const run = (cmd, args, shell = false) => execFileSync(cmd, args, { stdio: 'inherit', shell });
run(process.execPath, ['--experimental-sea-config', config]);
fs.copyFileSync(process.execPath, exe);
const postject = ['postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
run('npx', ['--yes', ...postject], WIN);
fs.rmSync(blob);
fs.rmSync(config);
console.log(`\n  OK : ${path.relative(ROOT, exe)} (${(fs.statSync(exe).size / 1e6).toFixed(0)} Mo)\n`);
