// Montage de vidéos longues : plusieurs vidéos sur une timeline, coupe, réorganisation,
// suppression automatique des silences, textes, musique, transitions, export.
// Tout se joue en direct sur un canvas ; l'export enregistre ce rendu (comme pour les clips).
import { clamp, clamp01, fmtTime, seekTo, decodeAudio, decodeAudioSmart, computeEnergy, levelDb, resampleTo16k, buildWords } from './analyzer.js';
import { FILTERS, CAPTION_STYLES, groupWords, drawCaptionLayer } from './renderer.js';
import { pickMime, outputSize } from './exporter.js';
import { transcribePcm } from './transcribe.js';
import { saveBlob, keepAwake, keepData } from './save.js';
import { startTour } from './tour.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const COLORS = ['#7c5cff', '#ff4fd8', '#22d38a', '#ffb020', '#3df5ff', '#ff5470'];
const FADE = 0.35;
const HOP = 0.05;
const DUCK = 0.3; // niveau de la musique pendant que quelqu'un parle

const M = {
  media: [], segs: [], texts: [],
  sel: null, // { kind: 'seg' | 'text', id }
  t: 0, playing: false, k: -1,
  aspect: '16:9', quality: '1080', zoom: 40, // pixels par seconde sur la timeline
  songs: [], tracks: [], // musiques importées et leurs morceaux posés sur la timeline
  caps: { on: true, style: 'karaoke', pos: 0.82, size: 0.8 }, groups: [],
  exporting: false,
  undo: [], redo: [],
};

let ui = null; // toast / notify fournis par app.js
let ac = null, master = null, speaker = null, recDest = null, voiceBus = null, voiceMeter = null;
const players = new Map(); // id du morceau → { el, gain }
let duck = 1;
const canvas = $('#mtCanvas');
const ctx = canvas.getContext('2d');
const bg = document.createElement('canvas');
const bgx = bg.getContext('2d');
let uid = 0;
const id = p => `${p}${(++uid).toString(36)}`;

/* ---------------- Audio ---------------- */

function audio() {
  if (ac) return ac;
  ac = new AudioContext();
  master = ac.createGain();
  speaker = ac.createGain();
  recDest = ac.createMediaStreamDestination();
  master.connect(speaker).connect(ac.destination);
  master.connect(recDest);
  // Le son des vidéos passe par un bus mesuré : la musique baisse quand quelqu'un parle.
  voiceBus = ac.createGain();
  voiceBus.connect(master);
  voiceMeter = ac.createAnalyser();
  voiceMeter.fftSize = 1024;
  voiceBus.connect(voiceMeter);
  M.media.forEach(wire);
  return ac;
}

function wire(m) {
  if (!ac || m.gains || m.image) return;
  m.gains = m.els.map(el => {
    const g = ac.createGain();
    ac.createMediaElementSource(el).connect(g).connect(voiceBus);
    return g;
  });
}

/* ---------------- Médias ---------------- */

// Une photo se comporte comme une vidéo muette : une horloge remplace la lecture.
const IMAGE_MAX = 60;
class Still extends EventTarget {
  constructor(img) {
    super();
    this.img = img; this.paused = true; this.playbackRate = 1; this.preservesPitch = true;
    this._t = 0; this._base = 0;
  }
  get videoWidth() { return this.img.naturalWidth; }
  get videoHeight() { return this.img.naturalHeight; }
  get ended() { return this.currentTime >= IMAGE_MAX; }
  get currentTime() { return this.paused ? this._t : this._t + ((performance.now() - this._base) / 1000) * this.playbackRate; }
  set currentTime(v) {
    this._t = v; this._base = performance.now();
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
  }
  play() { if (this.paused) { this._base = performance.now(); this.paused = false; } return Promise.resolve(); }
  pause() { if (!this.paused) { this._t = this.currentTime; this.paused = true; } }
}

async function addImage(f) {
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { ui.toast(`« ${f.name} » n'est pas une image lisible.`, 'err', 6000); return; }
  const m = {
    id: id('m'), name: f.name, file: f, url, image: true, els: [new Still(img), new Still(img)], duration: IMAGE_MAX,
    w: img.naturalWidth, h: img.naturalHeight, color: COLORS[M.media.length % COLORS.length], thumb: '', energy: null, words: [],
  };
  M.media.push(m);
  m.thumb = await thumbnail(m);
  snapshot();
  M.segs.push(newSeg(m, 0, 4, { kb: true }));
  if (M.segs.length === 1) M.aspect = m.w >= m.h ? '16:9' : '9:16';
}

async function addFiles(files) {
  const songs = files.filter(isAudio);
  if (songs.length) await addSongs(songs);
  for (const f of files) {
    if (f.type.startsWith('image/')) { await addImage(f); continue; }
    if (isAudio(f)) continue;
    if (!f.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name)) continue;
    const url = URL.createObjectURL(f);
    const els = [0, 1].map(() => {
      const v = document.createElement('video');
      v.src = url; v.preload = 'auto'; v.playsInline = true; v.crossOrigin = 'anonymous';
      v.className = 'offscreen-video';
      document.body.append(v);
      return v;
    });
    try {
      await new Promise((res, rej) => { els[0].onloadedmetadata = res; els[0].onerror = rej; });
    } catch {
      ui.toast(`« ${f.name} » n'est pas lisible par le navigateur (essaie un MP4 H.264).`, 'err', 7000);
      els.forEach(v => v.remove());
      continue;
    }
    const m = {
      id: id('m'), name: f.name, file: f, url, els, duration: els[0].duration,
      w: els[0].videoWidth, h: els[0].videoHeight, color: COLORS[M.media.length % COLORS.length], thumb: '', energy: null,
    };
    M.media.push(m);
    wire(m);
    m.thumb = await thumbnail(m);
    snapshot();
    M.segs.push(newSeg(m, 0, m.duration));
    if (M.segs.length === 1) M.aspect = m.w >= m.h ? '16:9' : '9:16';
  }
  render();
  seek(M.t);
  offerRestore();
}

async function thumbnail(m) {
  const v = m.image ? m.els[1].img : m.els[1];
  if (!m.image) await seekTo(v, Math.min(1, m.duration / 2));
  const c = document.createElement('canvas');
  c.width = 160; c.height = Math.round(160 * m.h / m.w) || 90;
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

const newSeg = (m, a, b, base = {}) => ({
  speed: 1, vol: 1, filter: 'none', trans: 'none', layout: 'fill', zoom: 1, kb: false, ...base, id: id('s'), mid: m.id, a, b,
});
const mediaOf = s => M.media.find(m => m.id === s.mid);
const segDur = s => (s.b - s.a) / s.speed;
const total = () => M.segs.reduce((a, s) => a + segDur(s), 0);
const elFor = k => mediaOf(M.segs[k]).els[k % 2];
const gainFor = k => mediaOf(M.segs[k]).gains?.[k % 2];

function startOf(k) {
  let t = 0;
  for (let i = 0; i < k; i++) t += segDur(M.segs[i]);
  return t;
}

function locate(T) {
  let t = 0;
  for (let k = 0; k < M.segs.length; k++) {
    const d = segDur(M.segs[k]);
    if (T < t + d || k === M.segs.length - 1) return { k, local: clamp(T - t, 0, d) };
    t += d;
  }
  return { k: -1, local: 0 };
}

/* ---------------- Historique (annuler / rétablir) ---------------- */

function snapshot() {
  M.undo.push(JSON.stringify({ segs: M.segs, texts: M.texts, tracks: M.tracks }));
  if (M.undo.length > 60) M.undo.shift();
  M.redo = [];
}
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify({ segs: M.segs, texts: M.texts, tracks: M.tracks }));
  ({ segs: M.segs, texts: M.texts, tracks: M.tracks = [] } = JSON.parse(from.pop()));
  M.sel = null;
  render();
  seek(Math.min(M.t, total()));
}
const undo = () => restore(M.undo, M.redo);
const redo = () => restore(M.redo, M.undo);

/* ---------------- Lecture ---------------- */

function seek(T) {
  pause();
  M.t = clamp(T, 0, total());
  const { k, local } = locate(M.t);
  M.k = k;
  if (k < 0) { draw(); return; }
  const s = M.segs[k], el = elFor(k);
  seekTo(el, s.a + local * s.speed).then(draw);
  prepare(k + 1);
  draw();
}

// Positionne à l'avance la vidéo du segment suivant pour une coupe sans à-coup.
function prepare(k) {
  if (k >= M.segs.length) return;
  const el = elFor(k);
  if (el.paused) el.currentTime = M.segs[k].a;
}

async function play() {
  if (!M.segs.length) return;
  audio();
  await ac.resume();
  if (M.t >= total() - 0.05) M.t = 0;
  const { k, local } = locate(M.t);
  M.playing = true;
  await startSeg(k, local);
  $('#mtPlay').textContent = '❚❚';
}

async function startSeg(k, local = 0) {
  M.k = k;
  const s = M.segs[k], el = elFor(k);
  el.playbackRate = s.speed;
  el.preservesPitch = true;
  if (Math.abs(el.currentTime - (s.a + local * s.speed)) > 0.15) await seekTo(el, s.a + local * s.speed);
  if (!M.playing) return;
  await el.play().catch(() => {});
  prepare(k + 1);
}

function pause() {
  M.playing = false;
  M.media.forEach(m => m.els.forEach(v => v.pause()));
  syncMusic();
  $('#mtPlay').textContent = '▶';
}

function tick() {
  requestAnimationFrame(tick);
  syncMusic();
  if (!M.playing || M.k < 0) return;
  const s = M.segs[M.k], el = elFor(M.k);
  if (el.currentTime >= s.b - 0.02 || el.ended) {
    el.pause();
    if (M.k + 1 >= M.segs.length) { M.t = total(); pause(); finishExport(); draw(); return; }
    M.t = startOf(M.k + 1);
    startSeg(M.k + 1);
    return;
  }
  M.t = startOf(M.k) + (el.currentTime - s.a) / s.speed;
  draw();
}

/* ---------------- Musique ---------------- */

// Une musique importée peut être posée plusieurs fois sur la piste musique ; chaque morceau
// a sa position, son point de départ dans le fichier, sa durée, son volume et ses fondus.
const isAudio = f => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i.test(f.name);
const songOf = tr => M.songs.find(s => s.id === tr.sid);
const songKey = s => `${s.name}|${s.file.size}`;
const loopLen = tr => Math.max(0.5, songOf(tr).duration - tr.off);
const trackEnd = () => M.tracks.reduce((a, tr) => Math.max(a, tr.t + tr.dur), 0);

function newTrack(song, t) {
  const rest = total() - t;
  return { id: id('a'), sid: song.id, t, off: 0, dur: rest > 1 ? rest : song.duration, vol: 0.5, fin: 1, fout: 2, loop: true, duck: true };
}

async function addSongs(files) {
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const el = new Audio(url);
    try {
      await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = rej; });
    } catch {
      ui.toast(`« ${f.name} » n'est pas un fichier audio lisible.`, 'err', 6000);
      continue;
    }
    const song = { id: id('a'), name: f.name, file: f, url, duration: el.duration, wave: '' };
    M.songs.push(song);
    snapshot();
    // La première musique couvre toute la vidéo ; les suivantes partent de la tête de lecture.
    const tr = newTrack(song, M.tracks.length ? Math.min(M.t, Math.max(0, total() - 1)) : 0);
    M.tracks.push(tr);
    M.sel = { kind: 'music', id: tr.id };
    waveform(song).then(render).catch(() => {});
  }
  render();
}

// Forme d'onde dessinée une fois par musique, puis répétée sur chaque morceau.
async function waveform(song) {
  const a = await decodeAudio(song.file);
  const d = a.getChannelData(0), W = Math.min(4000, Math.max(200, Math.round(song.duration * 20))), H = 40;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffffb0';
  const step = Math.floor(d.length / W);
  const peaks = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let m = 0;
    for (let j = x * step, e = j + step; j < e; j += 8) m = Math.max(m, Math.abs(d[j]));
    peaks[x] = m;
  }
  const top = Math.max(...peaks) || 1;
  peaks.forEach((v, x) => { const h = Math.max(1, (v / top) * H); g.fillRect(x, (H - h) / 2, 1, h); });
  song.wave = c.toDataURL();
}

function player(tr) {
  let p = players.get(tr.id);
  if (!p || p.sid !== tr.sid) {
    p?.el.pause();
    const el = new Audio(songOf(tr).url);
    el.preload = 'auto';
    const gain = ac.createGain();
    gain.gain.value = 0;
    ac.createMediaElementSource(el).connect(gain).connect(master);
    p = { el, gain, sid: tr.sid };
    players.set(tr.id, p);
  }
  return p;
}

const voiceBuf = new Float32Array(1024);

// Appelée à chaque image : lance, coupe, recale et dose chaque morceau de musique.
function syncMusic() {
  if (!ac) return;
  voiceMeter.getFloatTimeDomainData(voiceBuf);
  let e = 0;
  for (const v of voiceBuf) e += v * v;
  const talking = M.playing && Math.sqrt(e / voiceBuf.length) > 0.015;
  // Baisse rapide quand la voix arrive, remontée douce quand elle s'arrête.
  duck += ((talking ? DUCK : 1) - duck) * (talking ? 0.2 : 0.03);
  const T = total();
  let k = 1;
  if (M.fadeIn) k = Math.min(k, clamp01(M.t / (FADE * 2)));
  if (M.fadeOut) k = Math.min(k, clamp01((T - M.t) / (FADE * 4)));
  for (const [tid, p] of players) {
    if (!M.tracks.some(tr => tr.id === tid)) { p.el.pause(); players.delete(tid); }
  }
  for (const tr of M.tracks) {
    if (!songOf(tr)) continue;
    const local = M.t - tr.t;
    const on = M.playing && local >= 0 && local < tr.dur;
    if (!on && !players.has(tr.id)) continue;
    const p = player(tr);
    if (!on) { if (!p.el.paused) p.el.pause(); p.gain.gain.value = 0; continue; }
    const want = tr.off + (tr.loop ? local % loopLen(tr) : local);
    if (p.el.paused || Math.abs(p.el.currentTime - want) > 0.35) {
      p.el.currentTime = want;
      if (p.el.paused) p.el.play().catch(() => {});
    }
    const f = Math.min(tr.fin ? local / tr.fin : 1, tr.fout ? (tr.dur - local) / tr.fout : 1);
    p.gain.gain.value = tr.vol * clamp01(f) * k * (tr.duck ? duck : 1);
  }
}

/* ---------------- Rendu ---------------- */

function sizeCanvas(quality) {
  const [W, H] = outputSize(M.aspect, quality);
  const k = quality === 'preview' ? 960 / Math.max(W, H) : 1;
  const w = Math.round(W * k), h = Math.round(H * k);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (M.k >= 0 && M.segs[M.k]) {
    const s = M.segs[M.k], el = elFor(M.k);
    const local = M.t - startOf(M.k), d = segDur(s);
    if (el.videoWidth) {
      ctx.save();
      ctx.filter = FILTERS[s.filter]?.css || 'none';
      // Effet Ken Burns : zoom lent et continu sur toute la durée du segment.
      const z = (s.zoom || 1) * (s.kb ? 1 + 0.15 * clamp01(local / d) : 1);
      if (s.layout === 'fit') drawFit(el, W, H); else drawFill(el, W, H, z, s.cx ?? 0.5);
      ctx.restore();
    }
    // Transition « fondu » : noir à l'entrée de ce segment et à la sortie du précédent.
    const next = M.segs[M.k + 1];
    let black = 0;
    if (s.trans === 'fade' && M.k > 0) black = Math.max(black, 1 - local / FADE);
    if (next?.trans === 'fade') black = Math.max(black, 1 - (d - local) / FADE);
    if (M.k === 0 && M.fadeIn) black = Math.max(black, 1 - local / (FADE * 2));
    if (!next && M.fadeOut) black = Math.max(black, 1 - (d - local) / (FADE * 2));
    black = clamp01(black);
    if (black > 0) { ctx.fillStyle = `rgba(0,0,0,${black})`; ctx.fillRect(0, 0, W, H); }
    const g = gainFor(M.k);
    if (g) g.gain.value = s.vol * (1 - black);
  }
  if (M.caps.on && M.groups.length) {
    drawCaptionLayer(ctx, M.groups, M.t, {
      capStyle: M.caps.style, capSize: M.caps.size, capPos: M.caps.pos, uppercase: true, emojis: true, capFont: 'montserrat', emojiSize: 0.8,
    }, W, H);
  }
  M.texts.forEach(tx => { if (M.t >= tx.t && M.t <= tx.t + tx.dur) drawText(tx, W, H); });
  $('#mtCur').textContent = fmtTime(M.t);
  $('#mtTotal').textContent = fmtTime(total());
  const ph = $('#mtPlayhead');
  ph.style.left = `${M.t * M.zoom}px`;
  if (M.playing) {
    const tl = $('#mtTimeline');
    const x = M.t * M.zoom;
    if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 40) tl.scrollLeft = x - 40;
  }
}

function drawFill(el, W, H, zoom = 1, cx = 0.5) {
  const vw = el.videoWidth, vh = el.videoHeight, r = W / H;
  let sw = vw, sh = vh;
  if (vw / vh > r) sw = vh * r; else sh = vw / r;
  sw /= zoom; sh /= zoom;
  ctx.drawImage(el.img || el, clamp(cx * vw - sw / 2, 0, vw - sw), (vh - sh) / 2, sw, sh, 0, 0, W, H);
}

function drawFit(el, W, H) {
  const vw = el.videoWidth, vh = el.videoHeight;
  const bw = 54, bh = Math.max(8, Math.round(bw * H / W));
  if (bg.width !== bw || bg.height !== bh) { bg.width = bw; bg.height = bh; }
  bgx.filter = 'blur(2px)';
  bgx.drawImage(el.img || el, -2, -2, bw + 4, bh + 4);
  ctx.drawImage(bg, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(0, 0, W, H);
  const sc = Math.min(W / vw, H / vh);
  ctx.drawImage(el.img || el, (W - vw * sc) / 2, (H - vh * sc) / 2, vw * sc, vh * sc);
}

export const TEXT_ANIMS = { fade: 'Fondu', pop: 'Pop', slide: 'Glissé', type: 'Machine à écrire' };

export const TEXT_STYLES = {
  title: 'Titre',
  box: 'Encadré',
  lower: 'Bandeau',
};

function drawText(tx, W, H) {
  const dt = M.t - tx.t;
  const alpha = Math.min(clamp01(dt / 0.25), clamp01((tx.dur - dt) / 0.25));
  const size = Math.round(Math.min(W, H) * 0.075 * tx.size);
  const anim = tx.anim || 'fade';
  const inP = 1 - (1 - clamp01(dt / 0.35)) ** 3;
  ctx.save();
  ctx.globalAlpha = anim === 'type' ? clamp01((tx.dur - dt) / 0.25) : alpha;
  if (anim === 'pop') {
    const k = 0.6 + 0.4 * inP + 0.06 * Math.sin(Math.min(1, dt / 0.35) * Math.PI);
    ctx.translate(W / 2, H * tx.y); ctx.scale(k, k); ctx.translate(-W / 2, -H * tx.y);
  } else if (anim === 'slide') ctx.translate((1 - inP) * -W * 0.25, 0);
  if (anim === 'type') {
    // Machine à écrire : les lettres apparaissent une à une.
    const n = Math.floor(dt * 22);
    tx = { ...tx, text: tx.text.slice(0, n) };
    if (!tx.text) { ctx.restore(); return; }
  }
  ctx.font = `900 ${size}px Montserrat, "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = tx.text.split('\n').slice(0, 4);
  const lh = size * 1.2;
  const y0 = H * tx.y - ((lines.length - 1) * lh) / 2;
  const wMax = Math.max(...lines.map(l => ctx.measureText(l).width));
  if (tx.style === 'box' || tx.style === 'lower') {
    const pad = size * 0.45;
    const bw = tx.style === 'lower' ? W : wMax + pad * 2;
    ctx.fillStyle = tx.style === 'lower' ? 'rgba(124,92,255,.92)' : '#fff';
    ctx.beginPath();
    ctx.roundRect?.((W - bw) / 2, y0 - lh / 2 - pad * 0.5, bw, lines.length * lh + pad, tx.style === 'lower' ? 0 : size * 0.3);
    ctx.fill();
    ctx.fillStyle = tx.style === 'lower' ? '#fff' : '#111';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh));
  } else {
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.16;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = tx.color || '#fff';
    lines.forEach((l, i) => { ctx.strokeText(l, W / 2, y0 + i * lh); ctx.fillText(l, W / 2, y0 + i * lh); });
  }
  ctx.restore();
}

/* ---------------- Édition ---------------- */

const listOf = kind => ({ seg: M.segs, text: M.texts, music: M.tracks })[kind];

function selected() {
  if (!M.sel) return null;
  return listOf(M.sel.kind).find(x => x.id === M.sel.id) || null;
}

function split() {
  const { k, local } = locate(M.t);
  if (k < 0) return;
  const s = M.segs[k];
  const at = s.a + local * s.speed;
  if (at - s.a < 0.2 || s.b - at < 0.2) { ui.toast('Place la tête de lecture plus loin du bord du segment.', '', 2500); return; }
  snapshot();
  const right = { ...s, id: id('s'), a: at, trans: 'none' };
  s.b = at;
  M.segs.splice(k + 1, 0, right);
  M.sel = { kind: 'seg', id: right.id };
  render();
  seek(M.t);
}

function remove() {
  const x = selected();
  if (!x) return;
  snapshot();
  const list = listOf(M.sel.kind);
  list.splice(list.indexOf(x), 1);
  M.sel = null;
  render();
  seek(Math.min(M.t, total()));
}

function move(d) {
  const x = selected();
  if (!x || M.sel.kind !== 'seg') return;
  const i = M.segs.indexOf(x), j = i + d;
  if (j < 0 || j >= M.segs.length) return;
  snapshot();
  [M.segs[i], M.segs[j]] = [M.segs[j], M.segs[i]];
  render();
  seek(startOf(j));
}

function duplicate() {
  const x = selected();
  if (!x) return;
  snapshot();
  if (M.sel.kind === 'seg') {
    const c = { ...x, id: id('s') };
    M.segs.splice(M.segs.indexOf(x) + 1, 0, c);
    M.sel = { kind: 'seg', id: c.id };
  } else {
    const c = { ...x, id: id(M.sel.kind === 'text' ? 't' : 'a'), t: x.t + x.dur };
    listOf(M.sel.kind).push(c);
    M.sel = { kind: M.sel.kind, id: c.id };
  }
  render();
}

function addText() {
  snapshot();
  const tx = { id: id('t'), text: 'Ton texte ici', t: M.t, dur: 4, y: 0.15, size: 1, style: 'title', color: '#ffffff', anim: 'fade' };
  M.texts.push(tx);
  M.sel = { kind: 'text', id: tx.id };
  render();
  draw();
  setTimeout(() => $('#mtTextInput')?.select(), 50);
}

// Coupe automatique des silences (« jump cut ») sur le segment choisi ou sur toute la vidéo.
async function removeSilences(all) {
  const targets = all ? [...M.segs] : [selected()].filter(x => x && M.sel.kind === 'seg');
  if (!targets.length) { ui.toast('Sélectionne un segment (ou utilise « sur tout »).', '', 3000); return; }
  const thr = +$('#mtSilThr').value, minSil = +$('#mtSilMin').value, pad = 0.12;
  const busy = ui.toast('Analyse du son pour trouver les silences…', '', 0);
  try {
    for (const m of new Set(targets.map(mediaOf))) {
      if (!m.energy && !m.image) m.energy = computeEnergy(await decodeAudioSmart(m.file), HOP);
    }
  } catch (e) {
    busy.remove();
    ui.toast(`Impossible de lire le son : ${e.message}`, 'err', 6000);
    return;
  }
  busy.remove();
  snapshot();
  let removed = 0;
  for (const s of targets) {
    const m = mediaOf(s), e = m.energy;
    if (m.image) continue;
    const parts = [];
    let runStart = null, keepFrom = s.a;
    for (let t = s.a; t <= s.b; t += HOP) {
      const quiet = (e[Math.floor(t / HOP)] ?? 0) < thr;
      if (quiet && runStart === null) runStart = t;
      if ((!quiet || t + HOP > s.b) && runStart !== null) {
        const runEnd = quiet ? s.b : t;
        if (runEnd - runStart >= minSil) {
          const cutA = runStart + pad, cutB = runEnd - pad;
          if (cutA - keepFrom > 0.15) parts.push([keepFrom, cutA]);
          removed += cutB - cutA;
          keepFrom = cutB;
        }
        runStart = null;
      }
    }
    if (s.b - keepFrom > 0.15) parts.push([keepFrom, s.b]);
    if (!parts.length) continue;
    const i = M.segs.indexOf(s);
    M.segs.splice(i, 1, ...parts.map(([a, b], j) => newSeg(m, a, b, { ...s, trans: j ? 'none' : s.trans })));
  }
  M.sel = null;
  render();
  seek(0);
  ui.toast(removed > 0.5 ? `✂ ${fmtTime(removed)} de silences retirés` : 'Aucun silence assez long trouvé (baisse la sensibilité).', removed > 0.5 ? 'ok' : '', 4000);
}

// Égalise le volume : chaque segment est ramené au niveau médian de la voix (fenêtres parlées seulement).
async function levelVolumes() {
  const segs = M.segs.filter(s => !mediaOf(s).image);
  if (!segs.length) return;
  const busy = ui.toast('Mesure du volume de chaque segment…', '', 0);
  try {
    for (const m of new Set(segs.map(mediaOf))) if (!m.level) m.level = levelDb(await decodeAudioSmart(m.file), 0.5);
  } catch (e) { busy.remove(); ui.toast(`Impossible de lire le son : ${e.message}`, 'err', 6000); return; }
  busy.remove();
  const loud = segs.map(s => {
    const L = mediaOf(s).level;
    const v = [...L.slice(Math.floor(s.a / 0.5), Math.ceil(s.b / 0.5))].filter(x => x > -50).sort((p, q) => p - q);
    return v.length ? v[Math.floor(v.length * 0.7)] : null;
  });
  const known = loud.filter(x => x !== null).sort((p, q) => p - q);
  if (!known.length) { ui.toast('Pas assez de son pour égaliser.', '', 3000); return; }
  const target = known[Math.floor(known.length / 2)];
  snapshot();
  segs.forEach((s, i) => { if (loud[i] !== null) s.vol = +clamp(10 ** ((target - loud[i]) / 20), 0.3, 2).toFixed(2); });
  render();
  ui.toast(`🔊 Volume égalisé sur ${segs.length} segment(s)`, 'ok', 3000);
}

/* ---------------- Export ---------------- */

let exportDone = null;

async function exportVideo(audioOnly = false) {
  if (!M.segs.length) { ui.toast('Ajoute au moins une vidéo.', 'err'); return; }
  if (M.exporting) return;
  audio();
  await ac.resume();
  M.exporting = true;
  const release = await keepAwake();
  pause();
  sizeCanvas(M.quality);
  const [W, H] = [canvas.width, canvas.height];
  const stream = new MediaStream([...(audioOnly ? [] : canvas.captureStream(30).getVideoTracks()), ...recDest.stream.getAudioTracks()]);
  const mime = audioOnly
    ? ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || ''
    : pickMime();
  const rec = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    ...(audioOnly ? {} : { videoBitsPerSecond: Math.round(10_000_000 * (W * H) / (1080 * 1920)) }),
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  speaker.gain.value = 0;
  const t = ui.toast('', '', 0);
  const progress = setInterval(() => {
    t.textContent = `⏺ Export ${audioOnly ? 'du son' : 'du montage'} — ${Math.round(100 * M.t / total())} % · reste ~${fmtTime(total() - M.t)} (gardez l'onglet visible)`;
  }, 400);
  await new Promise(r => { exportDone = r; seekTo(elFor(0), M.segs[0].a).then(() => { M.t = 0; draw(); rec.start(500); play(); }); });
  await new Promise(r => setTimeout(r, 150));
  rec.stop();
  await stopped;
  clearInterval(progress);
  t.remove();
  speaker.gain.value = 1;
  release();
  M.exporting = false;
  sizeCanvas('preview');
  draw();
  const type = (mime || (audioOnly ? 'audio/webm' : 'video/webm')).split(';')[0];
  const ext = audioOnly ? (type.includes('mp4') ? 'm4a' : 'weba') : (type.includes('mp4') ? 'mp4' : 'webm');
  const name = `montage_${new Date().toISOString().slice(0, 10)}.${ext}`;
  const blob = new Blob(chunks, { type });
  download(blob, name);
  if (audioOnly) ui.toast('✅ Son exporté', 'ok');
  else {
    const t2 = ui.toast('✅ Montage exporté. ', 'ok', 12000);
    const b = document.createElement('button');
    b.className = 'btn ghost sm';
    b.textContent = '✂ En faire des clips';
    b.onclick = () => { t2.remove(); ui.toClipping(new File([blob], name, { type })); };
    t2.append(b);
  }
  ui.notify(audioOnly ? 'Son du montage exporté' : 'Montage exporté');
}

const download = saveBlob;

function exportFrame() {
  if (!M.segs.length) return;
  sizeCanvas(M.quality);
  draw();
  canvas.toBlob(b => download(b, `image_${fmtTime(M.t).replace(/:/g, '-')}.png`), 'image/png');
  sizeCanvas('preview');
  draw();
}

// Chapitres YouTube : un par texte ajouté (YouTube exige un premier chapitre à 0:00).
async function copyChapters() {
  const list = [...M.texts].sort((a, b) => a.t - b.t).map(tx => [tx.t, tx.text.split('\n')[0].trim()]).filter(([, l]) => l);
  if (!list.length) { ui.toast('Ajoute des textes (T) aux débuts de parties : chacun devient un chapitre.', '', 5000); return; }
  if (list[0][0] > 1) list.unshift([0, 'Introduction']);
  else list[0][0] = 0;
  const txt = list.map(([t, l]) => `${fmtTime(t)} ${l}`).join('\n');
  try { await navigator.clipboard.writeText(txt); ui.toast('📑 Chapitres copiés : colle-les dans la description YouTube', 'ok', 4000); }
  catch { ui.toast(txt, '', 10000); }
}

// Coupe précédente / suivante (début des segments).
function jumpCut(dir) {
  const cuts = M.segs.map((_, k) => startOf(k)).concat(total());
  const next = dir > 0 ? cuts.find(c => c > M.t + 0.05) : [...cuts].reverse().find(c => c < M.t - 0.05);
  if (next !== undefined) seek(next);
}

function finishExport() {
  if (exportDone) { const r = exportDone; exportDone = null; r(); }
}

/* ---------------- Interface ---------------- */

// Mots de chaque vidéo replacés sur le temps de la timeline (coupes et vitesses comprises).
function timelineWords() {
  const words = [];
  let t0 = 0;
  for (const s of M.segs) {
    const m = mediaOf(s);
    const first = words.length;
    for (const w of m.words || []) {
      if (w.s >= s.a - 0.05 && w.e <= s.b + 0.2) words.push({ w: w.w, s: t0 + (Math.max(w.s, s.a) - s.a) / s.speed, e: t0 + (Math.min(w.e, s.b) - s.a) / s.speed });
    }
    if (words[first]) words[first].cut = true;
    t0 += segDur(s);
  }
  return words;
}

function buildCaptions() {
  M.groups = groupWords(timelineWords(), 3);
}

// Sous-titres du montage en .srt (YouTube, TikTok, Premiere…) : phrases de 42 caractères
// au plus, coupées aux pauses et à la ponctuation, calées sur la timeline.
function exportSrt() {
  const words = timelineWords();
  if (!words.length) { ui.toast('Génère d\'abord les sous-titres (💬) pour pouvoir les exporter.', '', 5000); return; }
  const lines = [];
  let cur = null;
  for (const w of words) {
    const text = cur ? `${cur.text} ${w.w}` : w.w;
    if (cur && (w.cut || w.s - cur.e > 0.6 || text.length > 42 || w.e - cur.s > 5 || /[.!?…]$/.test(cur.text))) { lines.push(cur); cur = null; }
    if (!cur) cur = { s: w.s, e: w.e, text: w.w };
    else { cur.text += ` ${w.w}`; cur.e = w.e; }
  }
  if (cur) lines.push(cur);
  const ts = t => {
    const ms = Math.max(0, Math.round(t * 1000));
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  const srt = lines.map((l, i) => `${i + 1}\n${ts(l.s)} --> ${ts(Math.min(l.e + 0.3, lines[i + 1]?.s ?? Infinity, total()))}\n${l.text.trim()}\n`).join('\n');
  download(new Blob([srt], { type: 'text/plain' }), `montage_${new Date().toISOString().slice(0, 10)}.srt`);
}

async function transcribeAll() {
  if (!M.media.length) return;
  const status = $('#mtAsrStatus');
  const btn = $('#mtTranscribe');
  btn.disabled = true;
  const release = await keepAwake();
  try {
    for (const [i, m] of M.media.entries()) {
      if (m.words) continue;
      const tag = M.media.length > 1 ? `Vidéo ${i + 1}/${M.media.length} · ` : '';
      status.textContent = `${tag}Lecture du son…`;
      const pcm = await resampleTo16k(await decodeAudioSmart(m.file));
      const segs = await transcribePcm(pcm, $('#mtModel').value, $('#mtLang').value, txt => { status.textContent = tag + txt; });
      m.words = buildWords(segs);
    }
    buildCaptions();
    const n = M.media.reduce((a, m) => a + (m.words?.length || 0), 0);
    status.textContent = n ? `✅ ${n} mots transcrits` : 'Aucune parole reconnue (vérifie la langue).';
    draw();
    ui.notify('Sous-titres du montage prêts');
  } catch (e) {
    console.error(e);
    status.textContent = `Transcription impossible : ${e.message} (connexion requise la 1re fois)`;
  } finally { btn.disabled = false; release(); }
}

/* ---------------- Sauvegarde automatique du projet ---------------- */

// Le projet (coupes, textes, réglages) est gardé dans le navigateur ; il revient quand on
// rajoute les mêmes vidéos. Les vidéos elles-mêmes ne sont jamais copiées.
const mediaKey = m => `${m.name}|${m.file.size}`;
let saveTimer = 0;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!M.segs.length) return;
    keepData();
    const keys = M.media.map(mediaKey);
    const data = {
      media: keys, aspect: M.aspect, caps: M.caps, fadeIn: M.fadeIn, fadeOut: M.fadeOut, texts: M.texts,
      segs: M.segs.map(({ mid, id: _, ...s }) => ({ ...s, m: keys[M.media.findIndex(x => x.id === mid)] })),
      tracks: M.tracks.map(({ sid, id: _, ...tr }) => ({ ...tr, s: songKey(M.songs.find(x => x.id === sid)) })),
    };
    try { localStorage.setItem('clipforge.montage', JSON.stringify(data)); } catch {}
  }, 800);
}

function offerRestore() {
  let data;
  try { data = JSON.parse(localStorage.getItem('clipforge.montage') || 'null'); } catch { return; }
  if (!data?.segs?.length) return;
  const byKey = new Map(M.media.map(m => [mediaKey(m), m]));
  if (!data.media.every(k => byKey.has(k))) return;
  // Seulement si la timeline est encore « brute » (une vidéo entière par segment).
  if (M.segs.length !== M.media.length || M.texts.length) return;
  const t = ui.toast('♻ Projet précédent retrouvé pour ces vidéos. ', 'ok', 12000);
  const b = document.createElement('button');
  b.className = 'btn ghost sm';
  b.textContent = 'Reprendre';
  b.onclick = () => {
    snapshot();
    M.segs = data.segs.map(({ m, ...s }) => ({ ...s, id: id('s'), mid: byKey.get(m).id }));
    M.texts = data.texts || [];
    // Les morceaux de musique reviennent si ces musiques sont déjà importées.
    const songs = new Map(M.songs.map(x => [songKey(x), x]));
    const back = (data.tracks || []).filter(tr => songs.has(tr.s)).map(({ s, ...tr }) => ({ ...tr, id: id('a'), sid: songs.get(s).id }));
    if (back.length) M.tracks = back;
    Object.assign(M, { aspect: data.aspect || M.aspect, caps: { ...M.caps, ...data.caps }, fadeIn: data.fadeIn, fadeOut: data.fadeOut });
    t.remove();
    syncCapsUi();
    render();
    seek(0);
  };
  t.append(b);
}

function syncCapsUi() {
  $('#mtCapsOn').checked = M.caps.on;
  $('#mtCapStyle').value = M.caps.style;
  $('#mtCapPos').value = M.caps.pos;
  $('#mtCapSize').value = M.caps.size;
}

function render() {
  buildCaptions();
  autosave();
  $('#mtEmpty').classList.toggle('hidden', M.media.length > 0);
  // Bibliothèque
  $('#mtMedia').innerHTML = '';
  M.media.forEach(m => {
    const d = document.createElement('div');
    d.className = 'mt-file';
    d.style.setProperty('--c', m.color);
    d.innerHTML = `<img alt=""><div><b></b><small>${fmtTime(m.duration)} · ${m.w}×${m.h}</small></div><button class="btn ghost sm" title="Ajouter à la fin de la timeline">＋</button>`;
    d.querySelector('img').src = m.thumb;
    d.querySelector('b').textContent = m.name;
    d.querySelector('button').addEventListener('click', () => { snapshot(); M.segs.push(newSeg(m, 0, m.image ? 4 : m.duration, m.image ? { kb: true } : {})); render(); draw(); });
    $('#mtMedia').append(d);
  });
  // Timeline
  const T = total();
  const width = Math.max(Math.max(T, trackEnd()) * M.zoom + 200, $('#mtTimeline').clientWidth);
  $('#mtInner').style.width = `${width}px`;
  const ruler = $('#mtRuler');
  ruler.innerHTML = '';
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(s => s * M.zoom >= 70) || 600;
  for (let t = 0; t <= Math.max(T, trackEnd()) + step; t += step) {
    const tick = document.createElement('span');
    tick.style.left = `${t * M.zoom}px`;
    tick.textContent = fmtTime(t);
    ruler.append(tick);
  }
  const track = $('#mtTrack');
  track.innerHTML = '';
  M.segs.forEach((s, k) => {
    const m = mediaOf(s);
    const b = document.createElement('div');
    b.className = `mt-seg${M.sel?.id === s.id ? ' sel' : ''}`;
    b.style.width = `${Math.max(4, segDur(s) * M.zoom)}px`;
    b.style.setProperty('--c', m.color);
    b.style.backgroundImage = `url(${m.thumb})`;
    b.draggable = true;
    b.title = `${m.name} · ${fmtTime(s.a)} → ${fmtTime(s.b)}`;
    b.innerHTML = `<span>${m.image ? '🖼 ' : ''}${s.trans === 'fade' && k ? '◐ ' : ''}${s.speed !== 1 ? `${s.speed}× ` : ''}${fmtTime(segDur(s))}</span><i class="hd l" title="Tirer pour raccourcir"></i><i class="hd r" title="Tirer pour raccourcir"></i>`;
    // Poignées : tirer un bord du segment pour le raccourcir ou le rallonger.
    b.querySelectorAll('.hd').forEach(h => {
      h.addEventListener('mousedown', e => e.preventDefault());
      h.addEventListener('click', e => e.stopPropagation());
      h.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        snapshot();
        const left = h.classList.contains('l'), x0 = e.clientX, a0 = s.a, b0 = s.b;
        const mv = ev => {
          const d = ((ev.clientX - x0) / M.zoom) * s.speed;
          if (left) s.a = clamp(a0 + d, 0, s.b - 0.2); else s.b = clamp(b0 + d, s.a + 0.2, m.duration);
          b.style.width = `${Math.max(4, segDur(s) * M.zoom)}px`;
          b.querySelector('span').textContent = fmtTime(segDur(s));
        };
        const up = () => {
          removeEventListener('pointermove', mv);
          removeEventListener('pointerup', up);
          M.sel = { kind: 'seg', id: s.id };
          render();
          seek(left ? startOf(k) : startOf(k) + segDur(s) - 0.05);
        };
        addEventListener('pointermove', mv);
        addEventListener('pointerup', up);
      });
    });
    b.addEventListener('click', e => {
      M.sel = { kind: 'seg', id: s.id };
      const r = b.getBoundingClientRect();
      seek(startOf(k) + ((e.clientX - r.left) / r.width) * segDur(s));
      render();
    });
    b.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(k)); b.classList.add('drag'); });
    b.addEventListener('dragend', () => b.classList.remove('drag'));
    b.addEventListener('dragover', e => e.preventDefault());
    b.addEventListener('drop', e => {
      e.preventDefault();
      const from = +e.dataTransfer.getData('text/plain');
      if (Number.isNaN(from) || from === k) return;
      snapshot();
      const [x] = M.segs.splice(from, 1);
      M.segs.splice(k, 0, x);
      render();
      seek(startOf(k));
    });
    track.append(b);
  });
  const texts = $('#mtTexts');
  texts.innerHTML = '';
  M.texts.forEach(tx => {
    const b = document.createElement('div');
    b.className = `mt-txt${M.sel?.id === tx.id ? ' sel' : ''}`;
    b.style.left = `${tx.t * M.zoom}px`;
    b.style.width = `${Math.max(16, tx.dur * M.zoom)}px`;
    b.textContent = `T ${tx.text.split('\n')[0]}`;
    // Glisser pour déplacer le texte dans le temps.
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      M.sel = { kind: 'text', id: tx.id };
      const x0 = e.clientX, t0 = tx.t;
      let moved = false;
      const mv = ev => {
        if (!moved) { snapshot(); moved = true; }
        const t = t0 + (ev.clientX - x0) / M.zoom;
        tx.t = clamp(t + snapDelta([t, t + tx.dur], tx.id, ev), 0, Math.max(0, total() - 0.5));
        b.style.left = `${tx.t * M.zoom}px`;
      };
      const up = () => { snapGuide(null); removeEventListener('pointermove', mv); removeEventListener('pointerup', up); render(); seek(tx.t); };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', up);
    });
    texts.append(b);
  });
  renderMusic();
  inspector();
  $('#mtExport').disabled = !M.segs.length;
  $$('#mtAspect button').forEach(b => b.classList.toggle('on', b.dataset.v === M.aspect));
  sizeCanvas('preview');
}

// Magnétisme de la timeline : textes et musiques s'accrochent à la tête de lecture,
// aux coupes et aux bords des autres éléments (maintenir Alt pour le désactiver).
function snapPoints(skip) {
  const pts = [0, M.t];
  let t = 0;
  M.segs.forEach(s => pts.push(t += segDur(s)));
  M.texts.forEach(x => x.id !== skip && pts.push(x.t, x.t + x.dur));
  M.tracks.forEach(x => x.id !== skip && pts.push(x.t, x.t + x.dur));
  return pts;
}
function snapGuide(t) {
  let g = $('#mtSnap');
  if (!g) { g = document.createElement('div'); g.id = 'mtSnap'; g.className = 'mt-snap'; $('#mtInner').append(g); }
  g.classList.toggle('hidden', t == null);
  if (t != null) g.style.left = `${t * M.zoom}px`;
}
// Renvoie le décalage à appliquer pour qu'un des bords (temps) tombe sur un point proche, ou 0.
function snapDelta(edges, skip, ev) {
  if (ev?.altKey) { snapGuide(null); return 0; }
  const tol = 8 / M.zoom;
  let best = null;
  for (const p of snapPoints(skip)) for (const e of edges) {
    const d = p - e;
    if (Math.abs(d) <= tol && (best == null || Math.abs(d) < Math.abs(best.d))) best = { d, p };
  }
  snapGuide(best?.p);
  return best ? best.d : 0;
}

// Bibliothèque des musiques et piste musique de la timeline.
function renderMusic() {
  const list = $('#mtSongs');
  list.innerHTML = '';
  M.songs.forEach(song => {
    const d = document.createElement('div');
    d.className = 'mt-file mt-song';
    d.innerHTML = `<span class="ico">🎵</span><div><b></b><small>${fmtTime(song.duration)}</small></div><button class="btn ghost sm" title="Poser à la tête de lecture">＋</button>`;
    d.querySelector('b').textContent = song.name;
    d.querySelector('button').addEventListener('click', () => {
      snapshot();
      const tr = newTrack(song, M.t >= total() - 0.5 ? 0 : M.t);
      M.tracks.push(tr);
      M.sel = { kind: 'music', id: tr.id };
      render();
    });
    list.append(d);
  });
  $('#mtSongsHint').classList.toggle('hidden', M.songs.length > 0);

  const lane = $('#mtMusics');
  lane.innerHTML = '';
  M.tracks.forEach(tr => {
    const song = songOf(tr);
    if (!song) return;
    const b = document.createElement('div');
    b.className = `mt-mus${M.sel?.id === tr.id ? ' sel' : ''}`;
    const place = () => {
      b.style.left = `${tr.t * M.zoom}px`;
      b.style.width = `${Math.max(12, tr.dur * M.zoom)}px`;
      // La forme d'onde défile avec le point de départ et se répète quand la musique boucle.
      b.style.backgroundSize = `${loopLen(tr) * M.zoom + tr.off * M.zoom}px 100%`;
      b.style.backgroundPosition = `${-tr.off * M.zoom}px 0`;
    };
    if (song.wave) b.style.backgroundImage = `url(${song.wave})`;
    place();
    b.title = `${song.name} · ${fmtTime(tr.dur)}`;
    b.innerHTML = `<span>🎵 ${tr.duck ? '' : '🔊 '}</span><i class="hd l" title="Tirer pour raccourcir"></i><i class="hd r" title="Tirer pour raccourcir ou rallonger"></i>`;
    b.querySelector('span').append(song.name);
    b.querySelectorAll('.hd').forEach(h => h.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      snapshot();
      const left = h.classList.contains('l'), x0 = e.clientX, t0 = tr.t, off0 = tr.off, d0 = tr.dur;
      const mv = ev => {
        let d = (ev.clientX - x0) / M.zoom;
        d += snapDelta([left ? t0 + d : t0 + d0 + d], tr.id, ev);
        if (left) {
          // Le bord gauche avance dans la musique : la fin reste en place.
          const dd = clamp(d, -Math.min(t0, off0), d0 - 0.5);
          tr.t = t0 + dd; tr.off = off0 + dd; tr.dur = d0 - dd;
        } else tr.dur = clamp(d0 + d, 0.5, tr.loop ? 24 * 3600 : songOf(tr).duration - tr.off);
        place();
      };
      const up = () => {
        snapGuide(null);
        removeEventListener('pointermove', mv);
        removeEventListener('pointerup', up);
        M.sel = { kind: 'music', id: tr.id };
        render();
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', up);
    }));
    // Glisser le morceau pour le déplacer dans le temps.
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      M.sel = { kind: 'music', id: tr.id };
      const x0 = e.clientX, t0 = tr.t;
      let moved = false;
      const mv = ev => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        if (!moved) { snapshot(); moved = true; }
        const t = t0 + (ev.clientX - x0) / M.zoom;
        tr.t = Math.max(0, t + snapDelta([t, t + tr.dur], tr.id, ev));
        place();
      };
      const up = () => {
        snapGuide(null);
        removeEventListener('pointermove', mv);
        removeEventListener('pointerup', up);
        render();
        if (!moved) seek((x0 - $('#mtInner').getBoundingClientRect().left) / M.zoom);
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', up);
    });
    lane.append(b);
  });
}

function musicInspector(box, x) {
  const song = songOf(x), len = song.duration;
  box.innerHTML = `<h3>Musique</h3><p class="muted"></p>
    <div class="field"><div class="label">Volume <b id="mmVolV">${Math.round(x.vol * 100)} %</b></div><input type="range" id="mmVol" min="0" max="1.5" step="0.05" value="${x.vol}"></div>
    <label class="switch-row"><span><span class="label">Baisser quand quelqu'un parle</span><small>La musique se met en retrait sous la voix, puis remonte</small></span><input type="checkbox" id="mmDuck" ${x.duck ? 'checked' : ''}><span class="switch"></span></label>
    <label class="switch-row"><span><span class="label">Boucler</span><small>Recommence au début si la musique est trop courte</small></span><input type="checkbox" id="mmLoop" ${x.loop ? 'checked' : ''}><span class="switch"></span></label>
    <div class="field"><div class="label">Démarrer la musique à <b class="mono" id="mmOffV">${fmtTime(x.off)}</b></div><input type="range" id="mmOff" min="0" max="${Math.max(0, len - 0.5)}" step="0.1" value="${x.off}"></div>
    <div class="row2"><div class="field"><div class="label">Début (s)</div><input type="number" class="input" id="mmT" min="0" step="0.1" value="${x.t.toFixed(1)}"></div>
    <div class="field"><div class="label">Durée (s)</div><input type="number" class="input" id="mmD" min="0.5" step="0.5" value="${x.dur.toFixed(1)}"></div></div>
    <div class="row2"><div class="field"><div class="label">Fondu d'entrée <b id="mmFinV">${x.fin} s</b></div><input type="range" id="mmFin" min="0" max="5" step="0.5" value="${x.fin}"></div>
    <div class="field"><div class="label">Fondu de sortie <b id="mmFoutV">${x.fout} s</b></div><input type="range" id="mmFout" min="0" max="8" step="0.5" value="${x.fout}"></div></div>
    <div class="chips"><button id="mmFull">↔ Toute la vidéo</button><button id="mmHere">⇤ Commencer ici</button><button id="mmEnd">⇥ Finir ici</button></div>`;
  box.querySelector('p').textContent = `${song.name} · ${fmtTime(len)}`;
  const maxDur = () => (x.loop ? 24 * 3600 : len - x.off);
  const bind = (sel, ev, fn, re) => {
    $(sel).addEventListener('pointerdown', snapshot, { once: true });
    $(sel).addEventListener('focus', snapshot, { once: true });
    $(sel).addEventListener(ev, e => { fn(e.target); if (re) render(); });
  };
  bind('#mmVol', 'input', el => { x.vol = +el.value; $('#mmVolV').textContent = `${Math.round(x.vol * 100)} %`; });
  bind('#mmFin', 'input', el => { x.fin = +el.value; $('#mmFinV').textContent = `${x.fin} s`; });
  bind('#mmFout', 'input', el => { x.fout = +el.value; $('#mmFoutV').textContent = `${x.fout} s`; });
  bind('#mmOff', 'input', el => { x.off = +el.value; x.dur = Math.min(x.dur, maxDur()); $('#mmOffV').textContent = fmtTime(x.off); });
  $('#mmOff').addEventListener('change', render);
  bind('#mmT', 'change', el => { x.t = Math.max(0, +el.value || 0); }, true);
  bind('#mmD', 'change', el => { x.dur = clamp(+el.value || 1, 0.5, maxDur()); }, true);
  $('#mmDuck').addEventListener('change', e => { snapshot(); x.duck = e.target.checked; render(); });
  $('#mmLoop').addEventListener('change', e => { snapshot(); x.loop = e.target.checked; x.dur = Math.min(x.dur, maxDur()); render(); });
  const act = (sel, fn) => $(sel).addEventListener('click', () => { snapshot(); fn(); x.dur = clamp(x.dur, 0.5, maxDur()); render(); });
  act('#mmFull', () => { x.t = 0; x.dur = Math.max(0.5, total()); });
  act('#mmHere', () => { const end = x.t + x.dur; x.t = Math.min(M.t, end - 0.5); x.dur = end - x.t; });
  act('#mmEnd', () => { x.dur = Math.max(0.5, M.t - x.t); });
}

function inspector() {
  const box = $('#mtInspect');
  const x = selected();
  if (!x) {
    box.innerHTML = `<h3>Réglages</h3><p class="muted">Clique sur un segment ou un texte de la timeline pour le modifier.</p>
      <div class="field"><label class="switch-row"><span class="label">Fondu au début de la vidéo</span><input type="checkbox" id="mtFadeIn" ${M.fadeIn ? 'checked' : ''}><span class="switch"></span></label>
      <label class="switch-row"><span class="label">Fondu à la fin de la vidéo</span><input type="checkbox" id="mtFadeOut" ${M.fadeOut ? 'checked' : ''}><span class="switch"></span></label></div>
      <div class="kv"><span>Durée totale</span><b class="mono">${fmtTime(total())}</b></div>
      <div class="kv"><span>Segments</span><b class="mono">${M.segs.length}</b></div>`;
    $('#mtFadeIn').onchange = e => { M.fadeIn = e.target.checked; draw(); };
    $('#mtFadeOut').onchange = e => { M.fadeOut = e.target.checked; draw(); };
    return;
  }
  if (M.sel.kind === 'seg') {
    const m = mediaOf(x);
    box.innerHTML = `<h3>${m.image ? 'Photo' : 'Segment'}</h3><p class="muted" title="${m.name}">${m.name}${m.image ? ' · règle la durée avec « Fin »' : ''}</p>
      <div class="field"><div class="label">Début dans la vidéo <b class="mono" id="mtAv">${fmtTime(x.a)}</b></div><input type="range" id="mtA" min="0" max="${m.duration}" step="0.05" value="${x.a}"></div>
      <div class="field"><div class="label">Fin dans la vidéo <b class="mono" id="mtBv">${fmtTime(x.b)}</b></div><input type="range" id="mtB" min="0" max="${m.duration}" step="0.05" value="${x.b}"></div>
      <div class="field"><div class="label">Vitesse</div><div class="chips" id="mtSpeed">${[0.5, 1, 1.25, 1.5, 2].map(v => `<button data-v="${v}" class="${v === x.speed ? 'on' : ''}">${String(v).replace('.', ',')}×</button>`).join('')}</div></div>
      <div class="field"><div class="label">Volume <b id="mtVolV">${Math.round(x.vol * 100)} %</b></div><input type="range" id="mtVol" min="0" max="2" step="0.05" value="${x.vol}"></div>
      <div class="field"><div class="label">Filtre</div><div class="chips" id="mtFilter">${Object.entries(FILTERS).map(([k, f]) => `<button data-v="${k}" class="${k === x.filter ? 'on' : ''}">${f.label}</button>`).join('')}</div></div>
      <div class="field"><div class="label">Transition avant ce segment</div><div class="chips" id="mtTrans"><button data-v="none" class="${x.trans !== 'fade' ? 'on' : ''}">Coupe franche</button><button data-v="fade" class="${x.trans === 'fade' ? 'on' : ''}">◐ Fondu au noir</button></div></div>
      ${x.layout !== 'fit' ? `<div class="field"><div class="label">Position horizontale</div><input type="range" id="mtCx" min="0" max="1" step="0.01" value="${x.cx ?? 0.5}"></div>` : ''}
      <div class="field"><div class="label">Zoom <b id="mtZv">${(x.zoom || 1).toFixed(2)}×</b></div><input type="range" id="mtZ" min="1" max="2.5" step="0.05" value="${x.zoom || 1}"></div>
      <label class="switch-row"><span><span class="label">Effet Ken Burns</span><small>Zoom lent et continu, idéal sur un plan fixe</small></span><input type="checkbox" id="mtKb" ${x.kb ? 'checked' : ''}><span class="switch"></span></label>
      <div class="field"><div class="label">Mise en page</div><div class="chips" id="mtLayout"><button data-v="fill" class="${x.layout === 'fill' ? 'on' : ''}">Remplir</button><button data-v="fit" class="${x.layout === 'fit' ? 'on' : ''}">Ajusté + fond flou</button></div></div>
      <button class="btn ghost sm" id="mtApplyAll">Appliquer vitesse, volume, filtre et mise en page à tous</button>`;
    const range = (idr, key, lbl) => {
      $(idr).addEventListener('pointerdown', snapshot, { once: true });
      $(idr).addEventListener('input', e => {
        const v = +e.target.value;
        if (key === 'a') x.a = clamp(v, 0, x.b - 0.2); else x.b = clamp(v, x.a + 0.2, m.duration);
        $(lbl).textContent = fmtTime(x[key]);
        M.t = startOf(M.segs.indexOf(x)) + (key === 'b' ? segDur(x) - 0.05 : 0);
        seek(M.t);
      });
      $(idr).addEventListener('change', render);
    };
    range('#mtA', 'a', '#mtAv');
    range('#mtB', 'b', '#mtBv');
    const chips = (idc, key, num) => $(idc).addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      snapshot();
      x[key] = num ? +b.dataset.v : b.dataset.v;
      render();
      seek(M.t);
    });
    chips('#mtSpeed', 'speed', true);
    chips('#mtFilter', 'filter');
    chips('#mtTrans', 'trans');
    chips('#mtLayout', 'layout');
    $('#mtCx')?.addEventListener('pointerdown', snapshot, { once: true });
    $('#mtCx')?.addEventListener('input', e => { x.cx = +e.target.value; draw(); });
    $('#mtZ').addEventListener('pointerdown', snapshot, { once: true });
    $('#mtZ').addEventListener('input', e => { x.zoom = +e.target.value; $('#mtZv').textContent = `${x.zoom.toFixed(2)}×`; draw(); });
    $('#mtKb').addEventListener('change', e => { snapshot(); x.kb = e.target.checked; draw(); });
    $('#mtVol').addEventListener('pointerdown', snapshot, { once: true });
    $('#mtVol').addEventListener('input', e => { x.vol = +e.target.value; $('#mtVolV').textContent = `${Math.round(x.vol * 100)} %`; });
    $('#mtApplyAll').addEventListener('click', () => {
      snapshot();
      M.segs.forEach(s => { s.speed = x.speed; s.vol = x.vol; s.filter = x.filter; s.layout = x.layout; s.zoom = x.zoom; s.kb = x.kb; });
      render();
      seek(M.t);
      ui.toast('Réglages appliqués à tous les segments', 'ok', 2000);
    });
  } else if (M.sel.kind === 'music') {
    musicInspector(box, x);
  } else {
    box.innerHTML = `<h3>Texte</h3>
      <div class="field"><textarea id="mtTextInput" rows="3"></textarea></div>
      <div class="field"><div class="label">Style</div><div class="chips" id="mtTStyle">${Object.entries(TEXT_STYLES).map(([k, l]) => `<button data-v="${k}" class="${k === x.style ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="field"><div class="label">Animation</div><div class="chips" id="mtTAnim">${Object.entries(TEXT_ANIMS).map(([k, l]) => `<button data-v="${k}" class="${k === (x.anim || 'fade') ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="row2"><div class="field"><div class="label">Début (s)</div><input type="number" class="input" id="mtTt" min="0" step="0.1" value="${x.t.toFixed(1)}"></div>
      <div class="field"><div class="label">Durée (s)</div><input type="number" class="input" id="mtTd" min="0.5" step="0.5" value="${x.dur}"></div></div>
      <div class="field"><div class="label">Position verticale</div><input type="range" id="mtTy" min="0.08" max="0.92" step="0.01" value="${x.y}"></div>
      <div class="field"><div class="label">Taille</div><input type="range" id="mtTs" min="0.5" max="2" step="0.05" value="${x.size}"></div>
      <div class="field"><div class="label">Couleur (style Titre)</div><input type="color" id="mtTc" value="${x.color}"></div>`;
    $('#mtTextInput').value = x.text;
    const bind = (sel, ev, fn) => { $(sel).addEventListener('focus', snapshot, { once: true }); $(sel).addEventListener('pointerdown', snapshot, { once: true }); $(sel).addEventListener(ev, e => { fn(e.target.value); draw(); }); };
    bind('#mtTextInput', 'input', v => { x.text = v; const b = $('.mt-txt.sel'); if (b) b.textContent = `T ${v.split('\n')[0]}`; });
    bind('#mtTt', 'change', v => { x.t = Math.max(0, +v || 0); render(); seek(x.t); });
    bind('#mtTd', 'change', v => { x.dur = Math.max(0.5, +v || 1); render(); });
    bind('#mtTy', 'input', v => { x.y = +v; });
    bind('#mtTs', 'input', v => { x.size = +v; });
    bind('#mtTc', 'input', v => { x.color = v; });
    $('#mtTStyle').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      snapshot();
      x.style = b.dataset.v;
      inspector();
      draw();
    });
    $('#mtTAnim').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      snapshot();
      x.anim = b.dataset.v;
      inspector();
      seek(x.t);
    });
    if (M.t < x.t || M.t > x.t + x.dur) seek(x.t + 0.3);
  }
}

/* ---------------- Tuto ---------------- */

const TOUR = [
  { sel: '#mtAdd', title: '1. Ajoute tes vidéos', text: 'Touche ici pour choisir tes <b>vidéos et photos</b> (ou glisse-les sur la page depuis ton PC). Elles se mettent bout à bout sur la timeline, dans l\'ordre.' },
  { sel: '#mtTimeline', title: '2. La timeline', text: 'Chaque bloc est un morceau de vidéo. <b>Clique</b> pour placer la tête de lecture rose, <b>glisse un bloc</b> pour changer l\'ordre, <b>tire ses bords</b> pour le raccourcir. Le zoom au-dessus permet de voir plus de détails.' },
  { sel: '#mtPlay', title: '3. Regarder', text: 'Lecture / pause (touche <b>Espace</b>). Tu peux aussi toucher l\'image. Les flèches <b>← →</b> avancent d\'une seconde.' },
  { sel: '#mtSplit', title: '4. Couper', text: 'Place la tête de lecture puis <b>Couper</b> (touche <b>S</b>) : le bloc est coupé en deux. Sélectionne le morceau en trop et supprime-le avec 🗑. Les flèches ◀ ▶ le déplacent, ⧉ le duplique.' },
  { sel: '#mtSilenceAll', title: '5. Retirer les blancs', text: 'Le plus gros gain de temps : ClipForge trouve <b>tous les silences</b> et les enlève tout seul. Règle le seuil si trop ou pas assez de choses sont coupées.' },
  { sel: '#mtLevel', title: '6. Même volume partout', text: 'Si tes vidéos viennent de sources différentes, ce bouton met <b>toutes les voix au même niveau</b>.' },
  { sel: '#mtTranscribe', title: '7. Sous-titres automatiques', text: 'Choisis la langue puis génère les sous-titres. Juste en dessous : <b>style</b>, <b>position</b> et <b>taille</b>. La première fois, l\'IA se télécharge (connexion nécessaire).' },
  { sel: '#mtText', title: '8. Textes à l\'écran', text: 'Ajoute un titre à la tête de lecture (touche <b>T</b>). Dans les réglages : style, animation, couleur, durée. Chaque texte peut aussi devenir un <b>chapitre YouTube</b> (bouton 📑).' },
  { sel: '#mtMusic', title: '9. Musique de fond', text: 'Ajoute une musique : elle se pose sur la piste 🎵 de la timeline. Glisse-la, raccourcis-la, et clique dessus pour le volume et les fondus. Elle <b>baisse toute seule</b> quand quelqu\'un parle.' },
  { sel: '#mtInspect', title: '10. Les réglages', text: 'Sélectionne un bloc, un texte ou une musique : ses réglages s\'affichent ici. Pour un bloc : <b>vitesse</b>, volume, <b>filtre</b>, zoom, effet Ken Burns, <b>fondu</b> avant le bloc, cadrage.' },
  { sel: '#mtUndo', title: '11. Pas de stress', text: 'Une erreur ? <b>Annuler</b> (Ctrl+Z) et <b>Rétablir</b> (Ctrl+Y). Ton projet est aussi <b>sauvegardé tout seul</b> : rajoute les mêmes vidéos et ClipForge te propose de reprendre.' },
  { sel: '#mtAspect', title: '12. Le format', text: '<b>16:9</b> pour YouTube, <b>9:16</b> pour TikTok, Reels et Shorts, <b>1:1</b> ou <b>4:5</b> pour Instagram.' },
  { sel: '#mtExport', title: '13. Exporter', text: 'Quand c\'est prêt : <b>Exporter la vidéo</b>. L\'export se fait en temps réel, garde la page ouverte. Ensuite, tu peux en <b>faire des clips</b> en un clic. 🎧 exporte juste le son, 🖼 l\'image affichée.' },
];

function tour() {
  pause();
  startTour(TOUR, () => { try { localStorage.setItem('clipforge.tutoMontage', '1'); } catch {} });
}

export function initMontage(helpers) {
  ui = helpers;
  sizeCanvas('preview');
  draw();
  requestAnimationFrame(tick);

  const input = $('#mtInput');
  $('#mtAdd').addEventListener('click', () => input.click());
  $('#mtEmpty').addEventListener('click', () => input.click());
  input.addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
  const stage = $('#screen-montage');
  stage.addEventListener('dragover', e => e.preventDefault());
  stage.addEventListener('drop', e => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  $('#mtTour').addEventListener('click', tour);
  let seen = null;
  try { seen = localStorage.getItem('clipforge.tutoMontage'); } catch {}
  if (!seen) setTimeout(tour, 400);
  $('#mtPlay').addEventListener('click', () => (M.playing ? pause() : play()));
  canvas.addEventListener('click', () => (M.playing ? pause() : play()));
  $('#mtSplit').addEventListener('click', split);
  $('#mtDelete').addEventListener('click', remove);
  $('#mtLeft').addEventListener('click', () => move(-1));
  $('#mtRight').addEventListener('click', () => move(1));
  $('#mtDup').addEventListener('click', duplicate);
  $('#mtText').addEventListener('click', addText);
  $('#mtUndo').addEventListener('click', undo);
  $('#mtRedo').addEventListener('click', redo);
  $('#mtSilence').addEventListener('click', () => removeSilences(false));
  $('#mtSilenceAll').addEventListener('click', () => removeSilences(true));
  $('#mtLevel').addEventListener('click', levelVolumes);
  $('#mtExport').addEventListener('click', () => exportVideo(false));
  $('#mtAudio').addEventListener('click', () => exportVideo(true));
  $('#mtFrame').addEventListener('click', exportFrame);
  $('#mtChapters').addEventListener('click', copyChapters);
  $('#mtSrt').addEventListener('click', exportSrt);
  $('#mtTranscribe').addEventListener('click', transcribeAll);
  $('#mtCapStyle').innerHTML = Object.entries(CAPTION_STYLES).map(([k, st]) => `<option value="${k}">${st.label}</option>`).join('');
  $('#mtCapsOn').addEventListener('change', e => { M.caps.on = e.target.checked; autosave(); draw(); });
  $('#mtCapStyle').addEventListener('change', e => { M.caps.style = e.target.value; autosave(); draw(); });
  $('#mtCapPos').addEventListener('input', e => { M.caps.pos = +e.target.value; autosave(); draw(); });
  $('#mtCapSize').addEventListener('input', e => { M.caps.size = +e.target.value; autosave(); draw(); });
  $('#mtFit').addEventListener('click', () => {
    M.zoom = clamp(($('#mtTimeline').clientWidth - 60) / Math.max(1, total()), 2, 200);
    $('#mtZoom').value = M.zoom;
    render();
    draw();
  });
  $('#mtZoom').addEventListener('input', e => { M.zoom = +e.target.value; render(); draw(); });
  $('#mtSilThr').addEventListener('input', e => { $('#mtSilThrV').textContent = `${Math.round(e.target.value * 100)} %`; });
  $('#mtSilMin').addEventListener('input', e => { $('#mtSilMinV').textContent = `${(+e.target.value).toFixed(1)} s`; });
  $('#mtAspect').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    M.aspect = b.dataset.v;
    if (M.caps.pos === 0.82 || M.caps.pos === 0.7) { M.caps.pos = M.aspect === '16:9' ? 0.82 : 0.7; syncCapsUi(); }
    render();
    draw();
  });
  $('#mtQuality').addEventListener('change', e => { M.quality = e.target.value; });
  $('#mtMute').addEventListener('click', () => {
    audio();
    speaker.gain.value = speaker.gain.value ? 0 : 1;
    $('#mtMute').textContent = speaker.gain.value ? '🔊' : '🔇';
  });
  // Clic sur la règle ou dans le vide de la timeline : déplace la tête de lecture.
  $('#mtInner').addEventListener('pointerdown', e => {
    if (e.target.closest('.mt-seg, .mt-txt, .mt-mus')) return;
    const r = $('#mtInner').getBoundingClientRect();
    seek((e.clientX - r.left) / M.zoom);
    if (e.target.closest('#mtTrack, #mtMusics') || e.target === $('#mtInner')) { M.sel = null; render(); }
  });

  const musicIn = $('#mtMusicInput');
  $('#mtMusic').addEventListener('click', () => musicIn.click());
  musicIn.addEventListener('change', e => { addSongs([...e.target.files]); e.target.value = ''; });

  document.addEventListener('keydown', e => {
    if (!stage.classList.contains('active') || M.exporting) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); M.playing ? pause() : play(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicate(); }
    else if (k === 's') split();
    else if (k === 't') addText();
    else if (e.key === 'Delete' || e.key === 'Backspace') remove();
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      seek(M.t + (e.shiftKey ? 5 : 1) * (e.key === 'ArrowLeft' ? -1 : 1));
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); jumpCut(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(total());
  });
  window.addEventListener('resize', () => M.media.length && render());
  render();
}

export function leaveMontage() { pause(); }

// Accès de débogage depuis la console.
window.clipforgeMontage = M;
window.clipforgeMusic = players;
