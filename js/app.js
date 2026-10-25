import {
  decodeAudioSmart, computeEnergy, resampleTo16k, analyzeVisual, makeTrack, refineFaces,
  buildWords, findClips, fmtTime, seekTo, clamp, norm, isKeyword,
} from './analyzer.js';
import { loadFaceDetector, detectFaces } from './faces.js';
import { renderFrame, groupWords, CAPTION_STYLES, CAPTION_FONTS, FILTERS, isSwear } from './renderer.js';
import { exportClip, outputSize } from './exporter.js';
import { transcribePcm } from './transcribe.js';
import { cacheKey, loadAnalysis, saveAnalysis, loadClips, saveClips } from './cache.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const video = $('#srcVideo');
const HOP = 0.1;

const state = {
  file: null, url: null, duration: 0,
  energy: null, words: [], visual: null,
  clips: [], editing: null, music: null,
  settings: { length: '30-60', count: 6, aspect: '9:16', transcribe: true, faces: true, podcast: 'speaker', lang: 'fr', model: 'onnx-community/whisper-base', quality: '1080', fps: '30', topics: '' },
  exporting: false,
};
const env = { track: makeTrack(null) };

/* ---------------- Utilitaires UI ---------------- */

const store = {
  get: k => { try { return localStorage.getItem(`clipforge.${k}`); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`clipforge.${k}`, v); } catch {} },
};

// Thème clair / sombre, mémorisé.
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#themeBtn').textContent = t === 'light' ? '🌙' : '☀️';
}
applyTheme(store.get('theme') || 'dark');
$('#themeBtn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(t);
  store.set('theme', t);
});
const toggleHelp = on => $('#help').classList.toggle('hidden', !on);
$('#helpBtn').addEventListener('click', () => toggleHelp(true));
$('#helpClose').addEventListener('click', () => toggleHelp(false));
$('#help').addEventListener('click', e => { if (e.target.id === 'help') toggleHelp(false); });
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === '?') toggleHelp($('#help').classList.contains('hidden'));
  else if (e.key === 'Escape' && !$('#help').classList.contains('hidden')) { e.stopImmediatePropagation(); toggleHelp(false); }
}, true);

function show(id) {
  // Une analyse qui finit pendant qu'on est dans l'onglet Montage ne doit pas le fermer.
  if (id !== 'montage' && $('#modes .on')?.dataset.mode === 'montage') {
    lastClipScreen = id;
    if (id === 'results') toast('✂ Tes clips sont prêts : reviens dans l\'onglet Clipping.', 'ok', 6000);
    return;
  }
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${id}`));
  window.scrollTo(0, 0);
}

function toast(msg, kind = '', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

// Prévient quand une longue tâche finit pendant que l'onglet est caché.
function notify(text) {
  if (!document.hidden) return;
  try { if (Notification.permission === 'granted') new Notification('ClipForge', { body: text }); } catch {}
  const old = document.title;
  document.title = `✅ ${text}`;
  addEventListener('focus', () => { document.title = old; }, { once: true });
}
const askNotify = () => { try { if (Notification.permission === 'default') Notification.requestPermission(); } catch {} };

function scoreClass(s) { return s >= 85 ? 's-hi' : s >= 70 ? 's-mid' : 's-lo'; }

function setStep(id, status, pct, detail) {
  const li = document.querySelector(`[data-step="${id}"]`);
  li.className = status;
  if (pct != null) li.querySelector('.bar i').style.width = `${Math.round(clamp(pct, 0, 1) * 100)}%`;
  if (detail != null) li.querySelector('small').textContent = detail;
}

// setTimeout plutôt que requestAnimationFrame : continue même si l'onglet est en arrière-plan.
const nextFrame = () => new Promise(r => setTimeout(r, 30));

/* ---------------- Import ---------------- */

function bindChips(container, onPick) {
  container.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    container.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    onPick(b.dataset.v);
  });
}

$$('.chips[data-setting]').forEach(c => bindChips(c, v => { state.settings[c.dataset.setting] = v; }));
$('#count').addEventListener('input', e => { state.settings.count = +e.target.value; $('#countVal').textContent = e.target.value; });
$('#transcribe').addEventListener('change', e => { state.settings.transcribe = e.target.checked; $('#asrOpts').style.opacity = e.target.checked ? 1 : 0.4; });
$('#faces').addEventListener('change', e => { state.settings.faces = e.target.checked; });
$('#lang').addEventListener('change', e => { state.settings.lang = e.target.value; });
$('#model').addEventListener('change', e => { state.settings.model = e.target.value; });
$('#topics').value = store.get('topics') || '';
state.settings.topics = $('#topics').value;
$('#topics').addEventListener('input', e => { state.settings.topics = e.target.value; store.set('topics', e.target.value); });

const dz = $('#dropzone');
$('#fileInput').addEventListener('change', e => e.target.files[0] && loadFile(e.target.files[0]));
$('#dzChange').addEventListener('click', e => { e.preventDefault(); $('#fileInput').click(); });
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => {
  const f = [...e.dataTransfer.files].find(f => f.type.startsWith('video/') || /\.(mkv|mov|mp4|webm|m4v|avi)$/i.test(f.name));
  if (f) loadFile(f); else toast('Déposez un fichier vidéo.', 'err');
});

async function loadFile(file) {
  if (state.url) URL.revokeObjectURL(state.url);
  state.file = file;
  state.url = URL.createObjectURL(file);
  video.src = state.url;
  const prev = $('#dzPreview');
  prev.src = state.url;
  try {
    await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = rej; });
  } catch {
    toast('Ce format vidéo n\'est pas lisible par le navigateur. Essayez un MP4 (H.264).', 'err', 8000);
    return;
  }
  if (!Number.isFinite(video.duration)) {
    // WebM sans durée dans l'en-tête : on force le navigateur à la calculer.
    await new Promise(res => {
      video.addEventListener('durationchange', function h() {
        if (Number.isFinite(video.duration)) { video.removeEventListener('durationchange', h); res(); }
      });
      video.currentTime = 1e101;
    });
    await seekTo(video, 0);
  }
  state.duration = video.duration;
  prev.currentTime = Math.min(5, video.duration / 3);
  $('.dz-empty').classList.add('hidden');
  $('.dz-file').classList.remove('hidden');
  $('#dzName').textContent = file.name;
  $('#dzInfo').textContent = `${fmtTime(video.duration)} · ${video.videoWidth}×${video.videoHeight} · ${(file.size / 1e6).toFixed(0)} Mo`;
  $('#generate').disabled = false;
}

/* ---------------- Import depuis un lien (YouTube…) ---------------- */

let ytSource = null;

function ytShow(text, { pct = null, err = false, install = false, cancel = false } = {}) {
  $('#ytStatus').classList.remove('hidden');
  $('#ytStatus').classList.toggle('err', err);
  $('#ytText').textContent = text;
  $('#ytPct').textContent = pct == null ? '' : `${Math.round(pct)} %`;
  $('#ytBar').style.width = `${pct ?? 0}%`;
  $('#ytBar').parentElement.style.display = pct == null ? 'none' : '';
  $('#ytInstall').classList.toggle('hidden', !install);
  $('#ytCancel').classList.toggle('hidden', !cancel);
  $('#ytGo').disabled = cancel;
}

function stream(url, onMsg) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(url);
    ytSource = { close: () => { es.close(); reject(Object.assign(new Error('Annulé'), { name: 'AbortError' })); } };
    es.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'done') { es.close(); resolve(m); }
      else if (m.type === 'error') { es.close(); reject(new Error(m.message)); }
      else onMsg(m);
    };
    es.onerror = () => { es.close(); reject(new Error('Connexion au serveur ClipForge perdue')); };
  });
}

// null si le serveur local n'est pas là (ex. version hébergée sur Cloudflare Pages,
// qui renvoie une page HTML ou une 404 à la place de l'API).
async function serverStatus() {
  try {
    const r = await fetch('/api/yt/status', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
    return await r.json();
  } catch { return null; }
}

const OFFLINE_MSG = 'L\'import par lien ne marche que dans la version installée sur ton PC (ClipForge.exe ou « Lancer ClipForge.bat ») : '
  + 'un site en ligne ne peut pas télécharger depuis YouTube. Ici, télécharge d\'abord la vidéo, puis glisse-la dans le cadre ci-dessous.';

serverStatus().then(st => {
  if (st) return;
  $('#ytForm').classList.add('offline');
  $('#ytUrl').placeholder = 'Import YouTube : disponible dans la version PC';
});

async function importLink() {
  const url = $('#ytUrl').value.trim();
  const st = await serverStatus();
  if (!st) { ytShow(OFFLINE_MSG, { err: true }); return; }
  if (!/^https?:\/\/\S+$/i.test(url)) { ytShow('Colle un lien complet qui commence par https://', { err: true }); return; }
  // Première utilisation : on installe directement ce qui manque, puis on enchaîne sur le téléchargement.
  if (!st.ytdlp || (!st.ffmpeg && st.canInstallFfmpeg) || (st.js === false && st.canInstallFfmpeg)) {
    if (!(await installTools())) return;
  }
  try {
    let title = '';
    const m = await stream(`/api/yt/download?url=${encodeURIComponent(url)}`, msg => {
      if (msg.type === 'title') title = msg.title;
      if (msg.type === 'info') ytShow(msg.text, { cancel: true });
      if (msg.type === 'progress') {
        const what = msg.part ? 'Son' : 'Vidéo';
        ytShow(`${what} : ${title || 'téléchargement'}${msg.speed && msg.speed !== 'Unknown B/s' ? ` · ${msg.speed}` : ''}${msg.eta && msg.eta !== 'Unknown' ? ` · reste ${msg.eta}` : ''}`,
          { pct: msg.pct, cancel: true });
      }
    });
    ytShow('Chargement dans ClipForge…', { pct: 100 });
    const blob = await (await fetch(m.url)).blob();
    // Le navigateur a sa copie : on libère tout de suite la place sur le disque.
    fetch(`/api/yt/cleanup?name=${encodeURIComponent(m.name)}`).catch(() => {});
    const name = (m.title || m.name).replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.mp4';
    await loadFile(new File([blob], name, { type: 'video/mp4' }));
    ytShow(`✅ Importée : ${m.title || m.name}`);
  } catch (e) {
    if (e.name !== 'AbortError') ytShow(`Échec : ${e.message}`, { err: true });
  } finally {
    ytSource = null;
    $('#ytGo').disabled = false;
  }
}
async function installTools() {
  ytShow('Première utilisation : installation des outils de téléchargement (une seule fois)…', { cancel: false });
  $('#ytGo').disabled = true;
  try {
    await stream('/api/yt/install', m => {
      if (m.type === 'progress') {
        const mo = v => (v / 1e6).toFixed(0);
        ytShow(`1re utilisation — installation de ${m.what}… ${mo(m.got)}${m.total ? ` / ${mo(m.total)}` : ''} Mo`,
          { pct: m.total ? (100 * m.got) / m.total : null });
        $('#ytGo').disabled = true;
      }
      if (m.type === 'info') ytShow(m.text);
    });
    return true;
  } catch (e) {
    ytShow(`Installation impossible : ${e.message}. Vérifie ta connexion Internet puis réessaie.`, { err: true, install: true });
    return false;
  } finally {
    ytSource = null;
    $('#ytGo').disabled = false;
  }
}

$('#ytForm').addEventListener('submit', e => { e.preventDefault(); if (!ytSource) importLink(); });
$('#ytInstall').addEventListener('click', async () => { if (await installTools()) importLink(); });
$('#ytCancel').addEventListener('click', () => {
  ytSource?.close();
  ytSource = null;
  ytShow('Import annulé.');
  $('#ytGo').disabled = false;
});

/* ---------------- Pipeline d'analyse ---------------- */

$('#generate').addEventListener('click', generate);

async function generate() {
  const S = state.settings;
  askNotify();
  show('processing');
  $('#procFile').textContent = `${state.file.name} · ${fmtTime(state.duration)}`;
  ['audio', 'visual', 'asr', 'detect', 'faces'].forEach(s => setStep(s, '', 0, ''));
  try {
    const key = cacheKey(state.file, S);
    const cached = await loadAnalysis(key);
    let detect = null, withFaces = 0;
    if (cached) {
      // Même vidéo, mêmes réglages : on reprend l'analyse enregistrée au lieu de tout refaire.
      ({ energy: state.energy, words: state.words, visual: state.visual } = cached);
      setStep('audio', 'done', 1, 'Repris de la dernière analyse');
      setStep('visual', 'done', 1, 'Repris de la dernière analyse');
      setStep('asr', state.words.length ? 'done' : 'skip', 1, state.words.length ? `${state.words.length} mots (déjà transcrits)` : 'Pas de transcription');
      if (S.faces) { try { await loadFaceDetector(); detect = detectFaces; } catch (e) { console.warn(e); } }
      withFaces = state.visual.samples.filter(s => s.faces?.length).length;
    } else {
    // 1. Audio
    // Le décodage est d'un seul bloc (pas de progression native) : on affiche le temps écoulé
    // et une estimation pour que l'utilisateur voie que ça avance.
    const mo = state.file.size / 1e6;
    const eta = Math.max(3, Math.round(mo / 9));
    const t0 = performance.now();
    const tick = () => {
      const s = (performance.now() - t0) / 1000;
      setStep('audio', 'run', Math.min(0.95, s / eta), `Décodage de la piste audio… ${Math.round(s)} s (fichier de ${mo.toFixed(0)} Mo, ~${eta} s)`);
    };
    tick();
    const timer = setInterval(tick, 500);
    await nextFrame();
    let audio = null;
    try { audio = await decodeAudioSmart(state.file); } catch (e) { console.warn(e); }
    finally { clearInterval(timer); }
    if (audio) {
      state.energy = computeEnergy(audio, HOP);
      setStep('audio', 'done', 1, `${audio.numberOfChannels} canal(aux) · ${Math.round(audio.sampleRate / 1000)} kHz`);
    } else {
      state.energy = new Float32Array(Math.ceil(state.duration / HOP));
      setStep('audio', 'skip', 1, 'Pas de piste audio exploitable — analyse visuelle uniquement');
    }

    // 2. Visuel
    if (S.faces) {
      setStep('visual', 'run', 0, 'Chargement du détecteur de visages…');
      try { await loadFaceDetector(); detect = detectFaces; }
      catch (e) {
        console.warn(e);
        toast('Détecteur de visages indisponible (connexion requise la 1re fois) : cadrage sur le mouvement.', 'err', 7000);
      }
    }
    setStep('visual', 'run', 0, 'Échantillonnage des images…');
    state.visual = await analyzeVisual(video, state.duration, p => setStep('visual', 'run', p, `Image à ${fmtTime(p * state.duration)}`), detect);
    env.track = makeTrack(state.visual);
    withFaces = state.visual.samples.filter(s => s.faces?.length).length;
    setStep('visual', 'done', 1, `${state.visual.cuts.length} changements de plan · ${detect ? `visages sur ${Math.round(100 * withFaces / (state.visual.samples.length || 1))} % des images` : 'suivi du mouvement'}`);

    // 3. Transcription
    state.words = [];
    if (S.transcribe && audio) {
      setStep('asr', 'run', 0, 'Préparation de l\'audio 16 kHz…');
      const pcm = await resampleTo16k(audio);
      audio = null;
      try {
        const segments = await transcribe(pcm, S.model, S.lang);
        state.words = buildWords(segments);
        if (state.words.length) setStep('asr', 'done', 1, `${state.words.length} mots transcrits`);
        else {
          setStep('asr', 'skip', 1, 'Aucune parole reconnue — vérifie la langue choisie');
          toast('Aucune parole reconnue, donc pas de sous-titres. Vérifie la langue (ou choisis « Détection auto ») et relance.', 'err', 9000);
        }
      } catch (e) {
        console.error(e);
        setStep('asr', 'skip', 1, `Transcription indisponible : ${e.message}`);
        toast('Transcription impossible (connexion requise la 1re fois). On continue sans sous-titres.', 'err', 8000);
      }
    } else setStep('asr', 'skip', 1, S.transcribe ? 'Pas d\'audio' : 'Désactivée');
    saveAnalysis(key, { energy: state.energy, words: state.words, visual: structuredClone(state.visual) });
    }
    env.track = makeTrack(state.visual);

    // 4. Détection
    setStep('detect', 'run', 0.3, 'Évaluation des passages candidats…');
    await nextFrame();
    const [minLen, maxLen] = S.length.split('-').map(Number);
    const found = findClips({
      duration: state.duration, energy: state.energy, hop: HOP, words: state.words,
      cuts: state.visual.cuts, minLen, maxLen, count: S.count, topics: S.topics.split(/[,;]+/).map(x => x.trim()).filter(Boolean),
    });
    state.clips = found.map(c => initClip(c));
    state.key = key;
    // Clips retouchés lors d'une session précédente sur la même vidéo : on les reprend.
    const saved = cached ? await loadClips(key) : null;
    if (saved?.length) {
      const fresh = state.clips;
      state.clips = saved.map(c => ({ ...c, opts: { ...defaultOpts(), ...c.opts }, groups: groupWords(c.words, c.opts.maxWords || 3) }));
      setTimeout(() => {
        const t = toast('♻ Tes clips modifiés la dernière fois ont été retrouvés. ', 'ok', 9000);
        const b = document.createElement('button');
        b.className = 'btn ghost sm';
        b.textContent = 'Nouvelle détection';
        b.onclick = () => { state.clips = fresh; t.remove(); persistClips(); renderResults(); };
        t.append(b);
      }, 400);
    }
    setStep('detect', 'done', 1, `${state.clips.length} clips retenus`);

    // 5. Suivi fin des visages sur les clips retenus
    if (detect && withFaces) {
      const share = await refineFaces(video, state.visual, state.clips, detect,
        p => setStep('faces', 'run', p, `Suivi du visage image par image… ${Math.round(p * 100)} %`));
      env.track = makeTrack(state.visual);
      // Mode podcast sur les clips où deux personnes partagent le plan.
      let duoClips = 0;
      state.clips.forEach(c => {
        if ((env.track.duo?.share(c.start, c.end) || 0) < 0.4) return;
        duoClips++;
        c.opts.podcast = S.podcast;
        if (S.podcast === 'split') c.opts.capPos = 0.5;
        c.reasons = [['🎙️', 'Échange à deux'], ...c.reasons].slice(0, 3);
      });
      setStep('faces', 'done', 1, `Visage suivi sur ${Math.round(share * 100)} % du temps des clips`
        + (duoClips ? ` · mode podcast sur ${duoClips} clip(s)` : ''));
    } else setStep('faces', 'skip', 1, detect ? 'Aucun visage détecté — cadrage sur le mouvement' : 'Désactivé');
    await renderResults();
    show('results');
    notify(`${state.clips.length} clips prêts`);
  } catch (e) {
    console.error(e);
    toast(`Erreur pendant l'analyse : ${e.message}`, 'err', 9000);
    show('upload');
  }
}

function transcribe(pcm, model, language) {
  return transcribePcm(pcm, model, language, (txt, p) => setStep('asr', 'run', p, txt));
}

/* ---------------- Clips ---------------- */

function defaultOpts() {
  return {
    aspect: state.settings.aspect, layout: 'fill', reframe: 'auto', podcast: 'off', cropX: 0.5, zoom: 1,
    captions: true, capStyle: 'karaoke', capSize: 1, capPos: state.settings.aspect === '16:9' ? 0.82 : 0.7,
    uppercase: true, emojis: true, hook: true, hookText: '', progress: false,
    capFont: 'montserrat', capColor: '', maxWords: 3, emojiSize: 1,
    filter: 'none', speed: 1, volume: 1, fade: false, music: !!state.music, musicVol: 0.15,
    watermark: store.get('watermark') || '', hookDur: 3, hookTheme: 'light', highlight: false, censor: false,
  };
}

function initClip(c) {
  const clip = { ...c, origStart: c.start, origEnd: c.end, opts: defaultOpts(), textEdited: false };
  refreshWords(clip);
  return clip;
}

function refreshWords(clip) {
  if (!clip.textEdited) {
    clip.words = state.words.filter(w => w.s >= clip.start - 0.05 && w.e <= clip.end + 0.3).map(w => ({ ...w }));
  } else {
    clip.words = clip.words.filter(w => w.e > clip.start && w.s < clip.end);
  }
  clip.groups = groupWords(clip.words, clip.opts.maxWords);
}

function setClipText(clip, text) {
  const toks = text.split(/\s+/).filter(Boolean);
  const old = clip.words;
  if (toks.length === old.length) {
    clip.words = old.map((w, i) => ({ s: w.s, e: w.e, w: toks[i] }));
  } else {
    const s0 = old[0]?.s ?? clip.start + 0.2;
    const e0 = old.length ? old.at(-1).e : clip.end - 0.2;
    const weights = toks.map(t => t.length + 2);
    const tot = weights.reduce((a, b) => a + b, 0) || 1;
    let t = s0;
    clip.words = toks.map((w, i) => { const d = (e0 - s0) * weights[i] / tot; const o = { w, s: t, e: t + d }; t += d; return o; });
  }
  clip.textEdited = true;
  clip.text = toks.join(' ');
  clip.groups = groupWords(clip.words, clip.opts.maxWords);
}

// Enregistre les clips (réglages, textes, découpes) pour les retrouver la prochaine fois.
let persistTimer = 0;
function persistClips() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (state.key) saveClips(state.key, state.clips.map(({ groups, ...c }) => ({ ...c, words: c.words.map(({ emo, ...w }) => w) })));
  }, 600);
}

let thumbQueue = Promise.resolve();
function renderThumb(clip, canvas) {
  thumbQueue = thumbQueue.then(() => drawThumb(clip, canvas)).catch(console.error);
  return thumbQueue;
}

async function drawThumb(clip, canvas) {
  const [W, H] = outputSize(clip.opts.aspect, '720');
  const k = 300 / Math.max(W, H);
  canvas.width = Math.round(W * k);
  canvas.height = Math.round(H * k);
  const t = clip.start + Math.min(1.2, (clip.end - clip.start) / 2);
  await seekTo(video, t);
  renderFrame(canvas.getContext('2d'), video, clip, t, env);
}

async function renderResults() {
  await document.fonts.load('900 40px Montserrat').catch(() => {});
  const grid = $('#clipGrid');
  grid.innerHTML = '';
  const sort = $('#sortBy').value, min = +$('#minScore').value;
  const order = state.clips.filter(c => c.score >= min).sort((a, b) =>
    sort === 'time' ? a.start - b.start : sort === 'length' ? (a.end - a.start) - (b.end - b.start) : b.score - a.score);
  const byScore = [...state.clips].sort((a, b) => b.score - a.score);
  $('#resCount').textContent = order.length < state.clips.length ? `${order.length} / ${state.clips.length}` : state.clips.length;
  updateExportAll();
  $('#resSource').textContent = `${state.file.name} · ${fmtTime(state.duration)}${state.words.length ? ' · transcription IA' : ''}`;
  for (const [i, clip] of order.entries()) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.animationDelay = `${i * 50}ms`;
    card.dataset.id = clip.id;
    const rank = byScore.indexOf(clip) + 1;
    card.innerHTML = `
      <div class="thumb">
        <canvas></canvas>
        <div class="play">▶</div>
        <div class="score"><b class="${scoreClass(clip.score)}">${clip.score}</b><small>VIRALITÉ</small></div>
        ${rank <= 3 ? `<div class="rank">#${rank}</div>` : ''}
        <label class="pick" title="Sélectionner pour l'export"><input type="checkbox" ${selected.has(clip.id) ? 'checked' : ''}><span></span></label>
        <div class="dur">${fmtTime(clip.end - clip.start)}</div>
      </div>
      <div class="card-body">
        <div class="card-title"></div>
        <div class="card-time">${fmtTime(clip.start)} → ${fmtTime(clip.end)}</div>
        <div class="reasons">${clip.reasons.map(([e, r]) => `<span>${e} ${r}</span>`).join('')}</div>
        ${clip.hashtags.length ? `<div class="tags">${clip.hashtags.join(' ')}</div>` : ''}
        <div class="exp-bar"><i></i></div>
        <div class="card-actions">
          <button class="btn ghost sm" data-act="edit">✎ Éditer</button>
          <button class="btn primary sm" data-act="export">⬇ Exporter</button>
          <button class="btn ghost sm icon" data-act="dup" title="Dupliquer (pour tester une autre version)">⧉</button>
          <button class="btn ghost sm icon" data-act="del" title="Supprimer">🗑</button>
        </div>
      </div>`;
    card.querySelector('.card-title').textContent = clip.title;
    card.querySelector('.thumb').style.aspectRatio = clip.opts.aspect === '16:9' ? '16 / 11' : '9 / 12';
    card.querySelector('.thumb').addEventListener('click', e => { if (!e.target.closest('.pick')) openEditor(clip); });
    hoverPreview(card, clip);
    card.querySelector('.pick input').addEventListener('change', e => {
      e.target.checked ? selected.add(clip.id) : selected.delete(clip.id);
      card.classList.toggle('picked', e.target.checked);
      updateExportAll();
    });
    card.classList.toggle('picked', selected.has(clip.id));
    card.querySelector('[data-act=edit]').addEventListener('click', () => openEditor(clip));
    card.querySelector('[data-act=export]').addEventListener('click', () => runExport([clip]));
    card.querySelector('[data-act=dup]').addEventListener('click', () => duplicateClip(clip));
    card.querySelector('[data-act=del]').addEventListener('click', () => deleteClip(clip));
    grid.append(card);
    await renderThumb(clip, card.querySelector('canvas'));
  }
}

// Aperçu animé (muet) du clip au survol de sa carte, avec recadrage et sous-titres.
function hoverPreview(card, clip) {
  const thumb = card.querySelector('.thumb');
  const canvas = card.querySelector('canvas');
  let v = null, raf = 0, timer = 0;
  thumb.addEventListener('mouseenter', () => {
    timer = setTimeout(() => {
      v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.src = state.url;
      v.currentTime = clip.start;
      v.playbackRate = clip.opts.speed || 1;
      v.play().catch(() => {});
      const ctx = canvas.getContext('2d');
      const step = () => {
        if (!v) return;
        if (v.currentTime >= clip.end) v.currentTime = clip.start;
        if (v.readyState >= 2) renderFrame(ctx, v, clip, v.currentTime, env);
        raf = requestAnimationFrame(step);
      };
      step();
    }, 250);
  });
  thumb.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); v = null; renderThumb(clip, canvas); }
  });
}

async function refreshCard(clip) {
  const card = document.querySelector(`.card[data-id="${clip.id}"]`);
  if (!card) return;
  card.querySelector('.card-title').textContent = clip.title;
  card.querySelector('.card-time').textContent = `${fmtTime(clip.start)} → ${fmtTime(clip.end)}`;
  card.querySelector('.dur').textContent = fmtTime(clip.end - clip.start);
  await renderThumb(clip, card.querySelector('canvas'));
}

$('#sortBy').addEventListener('change', renderResults);
$('#minScore').addEventListener('input', e => { $('#minScoreVal').textContent = e.target.value; });
$('#minScore').addEventListener('change', renderResults);

function newId() { return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

function duplicateClip(clip) {
  const copy = { ...clip, id: newId(), title: `${clip.title} (copie)`, opts: { ...clip.opts }, words: clip.words.map(w => ({ ...w })) };
  copy.groups = groupWords(copy.words, copy.opts.maxWords);
  state.clips.splice(state.clips.indexOf(clip) + 1, 0, copy);
  persistClips();
  renderResults();
  toast('Clip dupliqué', 'ok', 2000);
}

let lastDeleted = null;
function deleteClip(clip) {
  const i = state.clips.indexOf(clip);
  if (i < 0) return;
  state.clips.splice(i, 1);
  lastDeleted = { clip, i };
  persistClips();
  renderResults();
  const t = toast('Clip supprimé. ', '', 6000);
  const undo = document.createElement('button');
  undo.className = 'btn ghost sm';
  undo.textContent = 'Annuler';
  undo.onclick = () => {
    if (!lastDeleted) return;
    state.clips.splice(lastDeleted.i, 0, lastDeleted.clip);
    lastDeleted = null;
    persistClips();
    t.remove();
    renderResults();
  };
  t.append(undo);
}

// Clip créé à la main autour d'un instant (recherche dans la transcription ou bouton « Clip manuel »).
function manualClip(at, len = 30) {
  const start = clamp(at - 3, 0, Math.max(0, state.duration - 5));
  const end = Math.min(state.duration, start + len);
  const cw = state.words.filter(w => w.s >= start && w.e <= end);
  const clip = initClip({
    id: newId(), start, end, score: 60, reasons: [['✋', 'Choisi à la main']],
    title: cw.length ? cw.slice(0, 10).map(w => w.w).join(' ') : `Clip à ${fmtTime(start)}`, hashtags: [], text: '',
  });
  state.clips.push(clip);
  persistClips();
  renderResults().then(() => openEditor(clip));
}

$('#addClip').addEventListener('click', () => {
  const t = state.editing ? video.currentTime : Math.min(state.duration / 2, 10);
  manualClip(t);
});

// Recherche d'un mot ou d'une phrase dans la transcription.
$('#searchText').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const q = norm(e.target.value);
  const box = $('#searchResults');
  if (!q) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (!state.words.length) { box.innerHTML = '<p class="muted">Pas de transcription pour cette vidéo : active « Sous-titres IA » à l\'import.</p>'; return; }
  const terms = q.split(' ').filter(Boolean);
  const hits = [];
  for (let i = 0; i < state.words.length && hits.length < 30; i++) {
    if (terms.every((tm, k) => norm(state.words[i + k]?.w || '').startsWith(tm))) {
      hits.push(i);
      i += terms.length;
    }
  }
  if (!hits.length) { box.innerHTML = `<p class="muted">Aucun passage avec « ${escapeHtml(e.target.value)} ».</p>`; return; }
  box.innerHTML = `<p class="muted">${hits.length} passage(s) — clique pour créer un clip autour :</p>`;
  hits.forEach(i => {
    const ctxWords = state.words.slice(Math.max(0, i - 6), i + 10);
    const b = document.createElement('button');
    b.className = 'hit';
    b.innerHTML = `<b class="mono">${fmtTime(state.words[i].s)}</b> <span></span>`;
    b.querySelector('span').textContent = `…${ctxWords.map(w => w.w).join(' ')}…`;
    b.addEventListener('click', () => manualClip(state.words[i].s));
    box.append(b);
  });
});

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('#newVideo').addEventListener('click', () => { show('upload'); });
const selected = new Set();
function updateExportAll() {
  [...selected].forEach(id => { if (!state.clips.some(c => c.id === id)) selected.delete(id); });
  $('#exportAll').textContent = selected.size ? `⬇ Exporter la sélection (${selected.size})` : '⬇ Tout exporter';
}
$('#exportAll').addEventListener('click', () => {
  const list = selected.size ? state.clips.filter(c => selected.has(c.id)) : state.clips;
  runExport([...list].sort((a, b) => b.score - a.score));
});
$('#copyAll').addEventListener('click', async () => {
  const txt = [...state.clips].sort((a, b) => b.score - a.score)
    .map((c, i) => `${i + 1}. ${c.title} (${fmtTime(c.start)} → ${fmtTime(c.end)}, score ${c.score})\n${c.hashtags.concat(['#shorts', '#viral']).join(' ')}`).join('\n\n');
  try { await navigator.clipboard.writeText(txt); toast('📋 Titres et hashtags de tous les clips copiés', 'ok', 2500); }
  catch { toast('Copie impossible', 'err'); }
});

/* ---------------- Export ---------------- */

function safeName(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 50) || 'clip';
}

async function runExport(clips) {
  if (state.exporting) { toast('Un export est déjà en cours.'); return; }
  state.exporting = true;
  const wasPlaying = !video.paused;
  video.pause();
  const t = toast('', '', 0);
  // Temps restant : l'export se fait en temps réel, à la vitesse choisie pour chaque clip.
  const realLen = c => (c.end - c.start) / (c.opts.speed || 1);
  let left = clips.reduce((a, c) => a + realLen(c), 0);
  try {
    for (const [i, clip] of clips.entries()) {
      const card = document.querySelector(`.card[data-id="${clip.id}"]`);
      card?.classList.add('exporting');
      const bar = card?.querySelector('.exp-bar i');
      const label = clips.length > 1 ? `Export ${i + 1}/${clips.length}` : 'Export';
      const { blob, ext } = await exportClip({
        url: state.url, clip, env, quality: state.settings.quality, fps: +state.settings.fps, music: state.music,
        onProgress: p => {
          const pc = Math.round(clamp(p, 0, 1) * 100);
          const rest = left - clamp(p, 0, 1) * realLen(clip);
          t.textContent = `⏺ ${label} — ${pc} % · reste ~${fmtTime(rest)} · « ${clip.title.slice(0, 40)} » (gardez l'onglet visible)`;
          if (bar) bar.style.width = `${pc}%`;
        },
      });
      card?.classList.remove('exporting');
      left -= realLen(clip);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${String(i + 1).padStart(2, '0')}_${clip.score}_${safeName(clip.title)}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    toast(clips.length > 1 ? `✅ ${clips.length} clips exportés` : '✅ Clip exporté', 'ok');
    notify(clips.length > 1 ? `${clips.length} clips exportés` : 'Clip exporté');
  } catch (e) {
    console.error(e);
    toast(`Échec de l'export : ${e.message}`, 'err', 8000);
  } finally {
    t.remove();
    state.exporting = false;
    $$('.card.exporting').forEach(c => c.classList.remove('exporting'));
    if (wasPlaying && state.editing) video.play();
  }
}

/* ---------------- Éditeur ---------------- */

const pv = $('#preview');
const pctx = pv.getContext('2d');
let raf = 0;
let win = [0, 0];

function styleGrid() {
  const g = $('#styleGrid');
  g.innerHTML = Object.entries(CAPTION_STYLES).map(([k, s]) => `
    <button data-style="${k}">
      <span class="demo" style="color:#fff">LE <span style="${k === 'box' ? `background:${s.accent};padding:0 3px;border-radius:4px` : `color:${s.accent}`}${k === 'neon' ? `;text-shadow:0 0 8px ${s.accent}` : ''}">CLIP</span></span>
      <small>${s.label}</small>
    </button>`).join('');
  g.addEventListener('click', e => {
    const b = e.target.closest('button[data-style]');
    if (!b || !state.editing) return;
    state.editing.opts.capStyle = b.dataset.style;
    syncEditor();
  });
}
styleGrid();

$('#capFont').innerHTML = Object.entries(CAPTION_FONTS).map(([k, f]) => `<option value="${k}" style="font-family:'${f.family}'">${f.label}</option>`).join('');
$('#filterChips').innerHTML = Object.entries(FILTERS).map(([k, f]) => `<button data-v="${k}">${f.label}</button>`).join('');
Object.values(CAPTION_FONTS).forEach(f => document.fonts.load(`${f.weight} 40px "${f.family}"`).catch(() => {}));

// Musique de fond : un seul fichier pour toute la session, activable clip par clip.
const music = new Audio();
music.loop = true;
$('#musicPick').addEventListener('click', () => $('#musicInput').click());
$('#musicInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  if (state.music) URL.revokeObjectURL(state.music.url);
  state.music = { name: f.name, url: URL.createObjectURL(f) };
  music.src = state.music.url;
  state.clips.forEach(c => { c.opts.music = true; });
  syncEditor();
  toast(`🎵 Musique ajoutée à tous les clips : ${f.name}`, 'ok', 3000);
});
function syncMusic() {
  const c = state.editing;
  const on = c && state.music && c.opts.music && !video.paused;
  if (!on) { if (!music.paused) music.pause(); return; }
  music.volume = clamp(c.opts.musicVol, 0, 1);
  music.muted = video.muted;
  if (music.paused) {
    const rel = (video.currentTime - c.start) / (c.opts.speed || 1);
    music.currentTime = music.duration ? rel % music.duration : 0;
    music.play().catch(() => {});
  }
}

function exportSrt(clip) {
  const sp = clip.opts.speed || 1;
  const ts = t => {
    const ms = Math.max(0, Math.round(((t - clip.start) / sp) * 1000));
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  const lines = clip.groups.filter(g => g.e > clip.start && g.s < clip.end)
    .map((g, i) => `${i + 1}\n${ts(Math.max(g.s, clip.start))} --> ${ts(Math.min(g.e + 0.3, clip.end))}\n${g.words.map(w => w.w).join(' ')}\n`);
  if (!lines.length) { toast('Pas de sous-titres à exporter pour ce clip.', 'err'); return; }
  download(new Blob([lines.join('\n')], { type: 'text/plain' }), `${safeName(clip.title)}.srt`);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

$('#exportSrt').addEventListener('click', () => exportSrt(state.editing));

// Palette d'emojis : insère l'emoji à l'endroit du curseur dans le texte des sous-titres.
$('#emojiBar').innerHTML = '🔥 😂 😱 🤯 💰 💸 🚀 ✅ ❌ ⚠️ 💡 🎯 👀 🙏 ❤️ 💪 🏆 🤔 😭 👇'.split(' ').map(e => `<button type="button">${e}</button>`).join('');
$('#emojiBar').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const ta = $('#edText');
  const at = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, at), after = ta.value.slice(at);
  ta.value = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${b.textContent}${after && !/^\s/.test(after) ? ' ' : ''}${after}`;
  ta.focus();
  setClipText(state.editing, ta.value);
});

// Accroche proposée : la phrase du clip la plus « accrocheuse » (question, mots-clés, longueur courte).
function suggestHook(clip) {
  const sentences = [];
  let cur = [];
  for (const w of clip.words) {
    cur.push(w.w);
    if (/[.!?…]$/.test(w.w) || cur.length >= 16) { sentences.push(cur); cur = []; }
  }
  if (cur.length) sentences.push(cur);
  const scored = sentences.filter(s => s.length >= 3).map((s, i) => {
    const txt = s.join(' ');
    const score = (/\?$/.test(txt) ? 3 : 0) + s.filter(isKeyword).length * 1.5
      + (s.length >= 4 && s.length <= 12 ? 1.5 : 0) - i * 0.15 + (/^(pourquoi|comment|quand|qui|why|how|what)\b/i.test(txt) ? 2 : 0);
    return { txt, score };
  }).sort((a, b) => b.score - a.score);
  let t = scored[0]?.txt || clip.title;
  t = t.replace(/^[,;:\s-]+/, '').replace(/[,;:]$/, '');
  if (t.length > 70) t = t.slice(0, 68).replace(/\s\S*$/, '') + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
$('#hookSuggest').addEventListener('click', () => {
  const c = state.editing;
  if (!c.words.length) { toast('Pas de texte dans ce clip pour proposer une accroche.', 'err'); return; }
  c.opts.hookText = suggestHook(c);
  c.opts.hook = true;
  $('#hookText').value = c.opts.hookText;
  syncEditor();
});

// Préréglages : le style complet d'un clip, enregistré sous un nom, réutilisable sur les prochaines vidéos.
const STYLE_KEYS = ['captions', 'capStyle', 'capSize', 'capPos', 'uppercase', 'emojis', 'capFont', 'capColor', 'maxWords', 'emojiSize',
  'highlight', 'censor', 'capBg', 'punch', 'filter', 'speed', 'fade', 'watermark', 'hook', 'hookDur', 'hookTheme', 'progress', 'layout', 'zoom'];
const presets = () => { try { return JSON.parse(store.get('presets') || '{}'); } catch { return {}; } };
function fillPresets() {
  $('#presetList').innerHTML = '<option value="">— Choisir un préréglage —</option>'
    + Object.keys(presets()).map(n => `<option>${escapeHtml(n)}</option>`).join('');
}
fillPresets();
$('#presetSave').addEventListener('click', () => {
  const name = prompt('Nom du préréglage (ex. « Shorts jaune ») :');
  if (!name?.trim()) return;
  const all = presets();
  all[name.trim()] = Object.fromEntries(STYLE_KEYS.map(k => [k, state.editing.opts[k]]));
  store.set('presets', JSON.stringify(all));
  fillPresets();
  $('#presetList').value = name.trim();
  toast(`💾 Préréglage « ${name.trim()} » enregistré`, 'ok', 2500);
});
$('#presetList').addEventListener('change', e => {
  const p = presets()[e.target.value];
  if (!p) return;
  const c = state.editing;
  Object.assign(c.opts, p);
  c.groups = groupWords(c.words, c.opts.maxWords);
  syncEditor();
  toast(`Préréglage « ${e.target.value} » appliqué`, 'ok', 2000);
});
$('#presetDel').addEventListener('click', () => {
  const n = $('#presetList').value;
  if (!n) return;
  const all = presets();
  delete all[n];
  store.set('presets', JSON.stringify(all));
  fillPresets();
});
$('#exportThumb').addEventListener('click', () => {
  const c = state.editing;
  const [W, H] = outputSize(c.opts.aspect, '1080');
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  renderFrame(cv.getContext('2d'), video, c, video.currentTime, env);
  cv.toBlob(b => download(b, `${safeName(c.title)}_miniature.png`), 'image/png');
});

function sizePreview() {
  const [W, H] = outputSize(state.editing.opts.aspect, '720');
  const k = 960 / Math.max(W, H);
  pv.width = Math.round(W * k);
  pv.height = Math.round(H * k);
}

/* Historique de l'éditeur : chaque retouche peut être annulée (Ctrl+Z) ou rétablie (Ctrl+Y). */
const hist = { undo: [], redo: [] };
const clipState = c => JSON.stringify({ start: c.start, end: c.end, title: c.title, opts: c.opts, words: c.words.map(({ emo, ...w }) => w), textEdited: c.textEdited });
// Mémorise l'état juste avant une retouche (appelé au premier contact avec un réglage).
function remember() {
  const c = state.editing;
  if (!c) return;
  const j = clipState(c);
  if (hist.undo.at(-1) !== j) { hist.undo.push(j); hist.redo = []; if (hist.undo.length > 80) hist.undo.shift(); }
}
function travel(from, to) {
  const c = state.editing;
  const cur = clipState(c);
  while (from.length && from.at(-1) === cur) from.pop();
  if (!from.length) return;
  to.push(cur);
  const d = JSON.parse(from.pop());
  Object.assign(c, d);
  c.groups = groupWords(c.words, c.opts.maxWords);
  $('#edTitle').value = c.title;
  $('#edText').value = c.words.map(w => w.w).join(' ');
  $('#hookText').value = c.opts.hookText;
  updateCaption();
  syncEditor();
}
['pointerdown', 'focusin'].forEach(ev => $('#editor').addEventListener(ev, e => {
  if (e.target.closest('.ed-side, #preview, .ed-title')) remember();
}, true));

function openEditor(clip) {
  state.editing = clip;
  hist.undo = []; hist.redo = [];
  win = [Math.max(0, clip.origStart - 30), Math.min(state.duration, clip.origEnd + 30)];
  for (const id of ['#trimStart', '#trimEnd']) { $(id).min = win[0]; $(id).max = win[1]; }
  $('#edTitle').value = clip.title;
  $('#edScore').innerHTML = `Score <span class="${scoreClass(clip.score)}">${clip.score}</span>/99`;
  $('#edReasons').innerHTML = clip.reasons.map(([e, r]) => `<span>${e} ${r}</span>`).join('');
  $('#edText').value = clip.words.map(w => w.w).join(' ');
  $('#hookText').value = clip.opts.hookText;
  updateCaption();
  $('#editor').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  syncEditor();
  video.currentTime = clip.start;
  video.muted = false;
  cancelAnimationFrame(raf);
  loop();
}

function closeEditor() {
  const clip = state.editing;
  video.pause();
  music.pause();
  video.playbackRate = 1;
  state.editing = null;
  cancelAnimationFrame(raf);
  $('#editor').classList.add('hidden');
  document.body.style.overflow = '';
  if (clip) { refreshCard(clip); persistClips(); }
}

function updateCaption() {
  const c = state.editing;
  const cap = `${c.title}\n\n${c.hashtags.concat(['#shorts', '#viral']).join(' ')}`;
  $('#edCaption').textContent = cap;
}

function syncEditor() {
  const c = state.editing, o = c.opts;
  sizePreview();
  $$('.chips[data-opt]').forEach(ch => ch.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === o[ch.dataset.opt])));
  $$('[data-bool]').forEach(i => { i.checked = !!o[i.dataset.bool]; });
  $$('#styleGrid button').forEach(b => b.classList.toggle('on', b.dataset.style === o.capStyle));
  $('#cropX').value = o.cropX;
  $('#cropXField').style.display = o.reframe === 'manual' ? '' : 'none';
  const share = env.track.duo?.share(c.start, c.end) || 0;
  $('#podcastHint').textContent = o.reframe !== 'auto' || o.layout !== 'fill'
    ? 'Nécessite le recadrage « Auto » et la mise en page « Remplir ».'
    : share > 0 ? `Deux personnes détectées sur ${Math.round(share * 100)} % du clip.`
      : 'Aucune scène à deux personnes détectée dans ce clip.';
  $('#zoom').value = o.zoom;
  $('#zoomVal').textContent = `${o.zoom.toFixed(2)}×`;
  $('#capSize').value = o.capSize;
  $('#capPos').value = o.capPos;
  $$('.chips[data-optnum]').forEach(ch => ch.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === o[ch.dataset.optnum])));
  $('#capFont').value = o.capFont;
  $('#capColor').value = o.capColor || CAPTION_STYLES[o.capStyle]?.accent || '#FFE600';
  $('#emojiSize').value = o.emojiSize;
  $('#volume').value = o.volume;
  $('#volumeVal').textContent = `${Math.round(o.volume * 100)} %`;
  $('#musicVol').value = o.musicVol;
  $('#musicVolVal').textContent = `${Math.round(o.musicVol * 100)} %`;
  $('#musicName').textContent = state.music ? state.music.name : 'Aucune';
  $('#watermark').value = o.watermark;
  video.playbackRate = o.speed || 1;
  video.preservesPitch = true;
  video.volume = clamp(o.volume, 0, 1);
  $('#trimStart').value = c.start;
  $('#trimEnd').value = c.end;
  $('#startVal').textContent = fmtTime(c.start);
  $('#endVal').textContent = fmtTime(c.end);
  $('#lenVal').textContent = `${(c.end - c.start).toFixed(1)} s${o.speed > 1 ? ` (${((c.end - c.start) / o.speed).toFixed(1)} s en ${o.speed}×)` : ''}`;
  $('#scrub').min = c.start;
  $('#scrub').max = c.end;
  $('#tDur').textContent = fmtTime((c.end - c.start) / (o.speed || 1));
  drawWave();
}

function drawWave() {
  const cv = $('#wave'), c = state.editing;
  const dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr;
  cv.height = cv.clientHeight * dpr;
  const x = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H);
  const [a, b] = win;
  const toX = t => (t - a) / (b - a) * W;
  x.fillStyle = '#7c5cff22';
  x.fillRect(toX(c.start), 0, toX(c.end) - toX(c.start), H);
  const e = state.energy;
  for (let px = 0; px < W; px += 2 * dpr) {
    const t = a + (px / W) * (b - a);
    const v = e[Math.min(e.length - 1, Math.floor(t / HOP))] || 0;
    const h = Math.max(1, v * H * 0.9);
    x.fillStyle = t >= c.start && t <= c.end ? '#a58cff' : '#44445a';
    x.fillRect(px, (H - h) / 2, dpr * 1.2, h);
  }
  x.fillStyle = '#fff';
  x.fillRect(toX(c.start) - dpr, 0, 2 * dpr, H);
  x.fillRect(toX(c.end) - dpr, 0, 2 * dpr, H);
  const pt = video.currentTime;
  if (pt >= a && pt <= b) { x.fillStyle = '#ff4fd8'; x.fillRect(toX(pt), 0, dpr, H); }
}

let lastWave = 0;
function loop() {
  const c = state.editing;
  if (!c) return;
  if (!video.paused && (video.currentTime >= c.end || video.ended)) video.currentTime = c.start;
  renderFrame(pctx, video, c, video.currentTime, env);
  const rel = (video.currentTime - c.start) / (c.opts.speed || 1);
  syncMusic();
  const tt = video.currentTime;
  const bad = c.opts.censor && c.words.some(w => tt >= w.s && tt < w.e && isSwear(w.w));
  video.volume = bad ? 0 : clamp(c.opts.volume, 0, 1);
  $('#tCur').textContent = fmtTime(rel);
  if (document.activeElement !== $('#scrub')) $('#scrub').value = video.currentTime;
  $('#playBtn').textContent = video.paused ? '▶' : '❚❚';
  const now = performance.now();
  if (now - lastWave > 200) { lastWave = now; drawWave(); }
  raf = requestAnimationFrame(loop);
}

function togglePlay() {
  const c = state.editing;
  if (video.paused) {
    if (video.currentTime < c.start || video.currentTime >= c.end - 0.05) video.currentTime = c.start;
    video.play();
  } else video.pause();
}

$('#playBtn').addEventListener('click', togglePlay);
// Clic sur l'image : lecture / pause. Glisser verticalement : déplace les sous-titres.
pv.addEventListener('pointerdown', e => {
  const c = state.editing;
  const r = pv.getBoundingClientRect();
  const y0 = e.clientY;
  let dragging = false;
  pv.setPointerCapture(e.pointerId);
  const mv = ev => {
    if (!dragging && Math.abs(ev.clientY - y0) < 6) return;
    dragging = true;
    c.opts.capPos = clamp((ev.clientY - r.top) / r.height, 0.12, 0.92);
    $('#capPos').value = c.opts.capPos;
  };
  const up = () => {
    pv.removeEventListener('pointermove', mv);
    pv.removeEventListener('pointerup', up);
    if (!dragging) togglePlay();
  };
  pv.addEventListener('pointermove', mv);
  pv.addEventListener('pointerup', up);
});
const toggleFs = () => {
  const p = document.fullscreenElement ? document.exitFullscreen() : $('#stageWrap').requestFullscreen?.();
  p?.catch(() => {});
};
$('#fsBtn').addEventListener('click', toggleFs);
const toggleMute = () => { video.muted = !video.muted; $('#muteBtn').textContent = video.muted ? '🔇' : '🔊'; };
$('#muteBtn').addEventListener('click', toggleMute);
$('#scrub').addEventListener('input', e => { video.currentTime = +e.target.value; });
$('#edClose').addEventListener('click', closeEditor);
$('#edExport').addEventListener('click', () => runExport([state.editing]));
document.addEventListener('keydown', e => {
  if (!state.editing) return;
  if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key) && !/TEXTAREA|INPUT/.test(document.activeElement.tagName)) {
    e.preventDefault();
    if (e.key.toLowerCase() === 'y' || e.shiftKey) travel(hist.redo, hist.undo); else travel(hist.undo, hist.redo);
    return;
  }
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'Escape' && !document.fullscreenElement) closeEditor();
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    const d = (e.shiftKey ? 5 : 1) * (e.code === 'ArrowLeft' ? -1 : 1);
    video.currentTime = clamp(video.currentTime + d, win[0], win[1]);
  }
  if (e.code === 'KeyI') { remember(); setTrim('start', video.currentTime); }
  if (e.code === 'KeyO') { remember(); setTrim('end', video.currentTime); }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyF') toggleFs();
});

$$('.tabs button').forEach(b => b.addEventListener('click', () => {
  $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.tab-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
  if (b.dataset.tab === 'trim') drawWave();
}));

$$('.chips[data-opt]').forEach(ch => bindChips(ch, v => {
  const o = state.editing.opts;
  o[ch.dataset.opt] = v;
  if (ch.dataset.opt === 'aspect') o.capPos = v === '16:9' ? 0.82 : o.capPos;
  // En écran partagé, les sous-titres vont sur la jointure entre les deux personnes.
  if (ch.dataset.opt === 'podcast') o.capPos = v === 'split' ? 0.5 : (o.capPos === 0.5 ? 0.7 : o.capPos);
  syncEditor();
}));
$$('[data-bool]').forEach(i => i.addEventListener('change', () => { state.editing.opts[i.dataset.bool] = i.checked; }));
$$('.chips[data-optnum]').forEach(ch => bindChips(ch, v => {
  const c = state.editing;
  c.opts[ch.dataset.optnum] = +v;
  if (ch.dataset.optnum === 'maxWords') c.groups = groupWords(c.words, c.opts.maxWords);
  syncEditor();
}));
$('#capFont').addEventListener('change', e => { state.editing.opts.capFont = e.target.value; });
$('#capColor').addEventListener('input', e => { state.editing.opts.capColor = e.target.value; });
$('#capColorReset').addEventListener('click', () => { state.editing.opts.capColor = ''; syncEditor(); });
$('#watermark').addEventListener('input', e => { state.editing.opts.watermark = e.target.value; store.set('watermark', e.target.value); });

const numOpt = (id, key, after) => $(id).addEventListener('input', e => { state.editing.opts[key] = +e.target.value; after?.(); });
numOpt('#cropX', 'cropX');
numOpt('#zoom', 'zoom', () => { $('#zoomVal').textContent = `${state.editing.opts.zoom.toFixed(2)}×`; });
numOpt('#capSize', 'capSize');
numOpt('#capPos', 'capPos');
numOpt('#emojiSize', 'emojiSize');
numOpt('#volume', 'volume', () => { const o = state.editing.opts; video.volume = clamp(o.volume, 0, 1); $('#volumeVal').textContent = `${Math.round(o.volume * 100)} %`; });
numOpt('#musicVol', 'musicVol', () => { $('#musicVolVal').textContent = `${Math.round(state.editing.opts.musicVol * 100)} %`; });

function setTrim(which, t) {
  const c = state.editing;
  if (which === 'start') c.start = clamp(t, win[0], c.end - 2);
  else c.end = clamp(t, c.start + 2, win[1]);
  refreshWords(c);
  if (!c.textEdited) $('#edText').value = c.words.map(w => w.w).join(' ');
  video.currentTime = which === 'start' ? c.start : Math.max(c.start, c.end - 2);
  syncEditor();
}
$('#trimStart').addEventListener('input', e => setTrim('start', +e.target.value));
$('#trimEnd').addEventListener('input', e => setTrim('end', +e.target.value));
$$('[data-nudge]').forEach(b => b.addEventListener('click', () => {
  const [which, d] = b.dataset.nudge.split(':');
  setTrim(which, state.editing[which] + +d);
}));

$('#edTitle').addEventListener('input', e => { state.editing.title = e.target.value; updateCaption(); });
$('#edText').addEventListener('input', e => setClipText(state.editing, e.target.value));
$('#hookText').addEventListener('input', e => { state.editing.opts.hookText = e.target.value; });
$('#copyCaption').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#edCaption').textContent); toast('Légende copiée', 'ok', 2000); }
  catch { toast('Copie impossible', 'err'); }
});
$('#applyAll').addEventListener('click', () => {
  const src = state.editing.opts;
  const keys = ['captions', 'capStyle', 'capSize', 'capPos', 'uppercase', 'emojis', 'layout', 'reframe', 'podcast', 'aspect', 'zoom', 'progress', 'hook',
    'capFont', 'capColor', 'maxWords', 'emojiSize', 'filter', 'speed', 'volume', 'fade', 'music', 'musicVol', 'watermark', 'hookDur', 'hookTheme', 'highlight', 'censor', 'capBg', 'punch'];
  state.clips.forEach(c => {
    if (c === state.editing) return;
    keys.forEach(k => { c.opts[k] = src[k]; });
    c.groups = groupWords(c.words, c.opts.maxWords);
  });
  state.clips.forEach(c => { if (c !== state.editing) refreshCard(c); });
  toast('Style appliqué à tous les clips', 'ok', 2500);
});
window.addEventListener('resize', () => state.editing && drawWave());

/* ---------------- Modes : Clipping / Montage ---------------- */

// Le montage exporté peut repartir directement dans le Clipping pour en tirer des shorts.
async function toClipping(file) {
  $$('#modes button').forEach(x => x.classList.toggle('on', x.dataset.mode === 'clip'));
  montage?.leaveMontage();
  show('upload');
  await loadFile(file);
  toast('✂ Montage chargé dans le Clipping : règle les paramètres puis « Générer les clips ».', 'ok', 6000);
}

let montage = null;
let lastClipScreen = 'upload';
$('#modes').addEventListener('click', async e => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.classList.contains('on')) return;
  $$('#modes button').forEach(x => x.classList.toggle('on', x === b));
  if (b.dataset.mode === 'montage') {
    lastClipScreen = $('.screen.active')?.id.replace('screen-', '') || 'upload';
    if (lastClipScreen === 'processing') lastClipScreen = 'upload';
    video.pause();
    show('montage');
    if (!montage) {
      montage = await import('./montage.js');
      montage.initMontage({ toast, notify, toClipping });
    }
  } else {
    montage?.leaveMontage();
    show(state.clips.length && lastClipScreen === 'results' ? 'results' : lastClipScreen);
  }
});

// Accès de débogage depuis la console du navigateur.
window.clipforge = { state, env };

document.fonts.load('900 40px Montserrat').catch(() => {});
