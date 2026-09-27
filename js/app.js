import {
  decodeAudio, computeEnergy, resampleTo16k, analyzeVisual, makeTrack, refineFaces,
  buildWords, findClips, fmtTime, seekTo, clamp,
} from './analyzer.js';
import { loadFaceDetector, detectFaces } from './faces.js';
import { renderFrame, groupWords, CAPTION_STYLES } from './renderer.js';
import { exportClip, outputSize } from './exporter.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const video = $('#srcVideo');
const HOP = 0.1;

const state = {
  file: null, url: null, duration: 0,
  energy: null, words: [], visual: null,
  clips: [], editing: null,
  settings: { length: '30-60', count: 6, aspect: '9:16', transcribe: true, faces: true, podcast: 'speaker', lang: 'fr', model: 'onnx-community/whisper-base', quality: '1080' },
  exporting: false,
};
const env = { track: makeTrack(null) };

/* ---------------- Utilitaires UI ---------------- */

function show(id) {
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

async function importLink() {
  const url = $('#ytUrl').value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) { ytShow('Colle un lien complet qui commence par https://', { err: true }); return; }
  let st;
  try { st = await (await fetch('/api/yt/status')).json(); }
  catch { ytShow('Serveur ClipForge injoignable : lance l\'app avec « Lancer ClipForge.bat ».', { err: true }); return; }
  // Première utilisation : on installe directement ce qui manque, puis on enchaîne sur le téléchargement.
  if (!st.ytdlp || (!st.ffmpeg && st.canInstallFfmpeg)) {
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
  show('processing');
  $('#procFile').textContent = `${state.file.name} · ${fmtTime(state.duration)}`;
  ['audio', 'visual', 'asr', 'detect', 'faces'].forEach(s => setStep(s, '', 0, ''));
  try {
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
    try { audio = await decodeAudio(state.file); } catch (e) { console.warn(e); }
    finally { clearInterval(timer); }
    if (audio) {
      state.energy = computeEnergy(audio, HOP);
      setStep('audio', 'done', 1, `${audio.numberOfChannels} canal(aux) · ${Math.round(audio.sampleRate / 1000)} kHz`);
    } else {
      state.energy = new Float32Array(Math.ceil(state.duration / HOP));
      setStep('audio', 'skip', 1, 'Pas de piste audio exploitable — analyse visuelle uniquement');
    }

    // 2. Visuel
    let detect = null;
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
    const withFaces = state.visual.samples.filter(s => s.faces?.length).length;
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
        setStep('asr', 'done', 1, `${state.words.length} mots transcrits`);
      } catch (e) {
        console.error(e);
        setStep('asr', 'skip', 1, `Transcription indisponible : ${e.message}`);
        toast('Transcription impossible (connexion requise la 1re fois). On continue sans sous-titres.', 'err', 8000);
      }
    } else setStep('asr', 'skip', 1, S.transcribe ? 'Pas d\'audio' : 'Désactivée');

    // 4. Détection
    setStep('detect', 'run', 0.3, 'Évaluation des passages candidats…');
    await nextFrame();
    const [minLen, maxLen] = S.length.split('-').map(Number);
    const found = findClips({
      duration: state.duration, energy: state.energy, hop: HOP, words: state.words,
      cuts: state.visual.cuts, minLen, maxLen, count: S.count,
    });
    state.clips = found.map(c => initClip(c));
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
  } catch (e) {
    console.error(e);
    toast(`Erreur pendant l'analyse : ${e.message}`, 'err', 9000);
    show('upload');
  }
}

function transcribe(pcm, model, language) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    const segments = [];
    const files = new Map();
    let dev = '';
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'download') {
        files.set(m.file, m);
        let l = 0, t = 0;
        files.forEach(f => { l += f.loaded || 0; t += f.total || 0; });
        setStep('asr', 'run', t ? l / t : 0, `Téléchargement du modèle IA… ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} Mo`);
      } else if (m.type === 'ready') {
        dev = m.device === 'webgpu' ? 'GPU' : 'CPU';
        setStep('asr', 'run', 0, `Modèle prêt (${dev}) — transcription…`);
        if (!w._started) { w._started = true; w.postMessage({ type: 'run', audio: pcm, language }, [pcm.buffer]); }
      } else if (m.type === 'progress') {
        setStep('asr', 'run', m.done / m.total, `Transcription (${dev})… ${fmtTime(m.done)} / ${fmtTime(m.total)}`);
      } else if (m.type === 'segments') {
        segments.push(...m.segments);
      } else if (m.type === 'done') {
        w.terminate(); resolve(segments);
      } else if (m.type === 'error') {
        w.terminate(); reject(new Error(m.message));
      }
    };
    w.onerror = e => { w.terminate(); reject(new Error(e.message || 'Worker IA en erreur')); };
    w.postMessage({ type: 'load', model });
  });
}

/* ---------------- Clips ---------------- */

function defaultOpts() {
  return {
    aspect: state.settings.aspect, layout: 'fill', reframe: 'auto', podcast: 'off', cropX: 0.5, zoom: 1,
    captions: true, capStyle: 'karaoke', capSize: 1, capPos: state.settings.aspect === '16:9' ? 0.82 : 0.7,
    uppercase: true, emojis: true, hook: true, hookText: '', progress: false,
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
  clip.groups = groupWords(clip.words);
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
  clip.groups = groupWords(clip.words);
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
  const order = [...state.clips].sort((a, b) => $('#sortBy').value === 'time' ? a.start - b.start : b.score - a.score);
  const byScore = [...state.clips].sort((a, b) => b.score - a.score);
  $('#resCount').textContent = state.clips.length;
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
        </div>
      </div>`;
    card.querySelector('.card-title').textContent = clip.title;
    card.querySelector('.thumb').style.aspectRatio = clip.opts.aspect === '16:9' ? '16 / 11' : '9 / 12';
    card.querySelector('.thumb').addEventListener('click', () => openEditor(clip));
    card.querySelector('[data-act=edit]').addEventListener('click', () => openEditor(clip));
    card.querySelector('[data-act=export]').addEventListener('click', () => runExport([clip]));
    grid.append(card);
    await renderThumb(clip, card.querySelector('canvas'));
  }
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
$('#newVideo').addEventListener('click', () => { show('upload'); });
$('#exportAll').addEventListener('click', () => runExport([...state.clips].sort((a, b) => b.score - a.score)));

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
  try {
    for (const [i, clip] of clips.entries()) {
      const card = document.querySelector(`.card[data-id="${clip.id}"]`);
      card?.classList.add('exporting');
      const bar = card?.querySelector('.exp-bar i');
      const label = clips.length > 1 ? `Export ${i + 1}/${clips.length}` : 'Export';
      const { blob, ext } = await exportClip({
        url: state.url, clip, env, quality: state.settings.quality,
        onProgress: p => {
          const pc = Math.round(clamp(p, 0, 1) * 100);
          t.textContent = `⏺ ${label} — ${pc} % · « ${clip.title.slice(0, 40)} » (gardez l'onglet visible)`;
          if (bar) bar.style.width = `${pc}%`;
        },
      });
      card?.classList.remove('exporting');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${String(i + 1).padStart(2, '0')}_${clip.score}_${safeName(clip.title)}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    toast(clips.length > 1 ? `✅ ${clips.length} clips exportés` : '✅ Clip exporté', 'ok');
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

function sizePreview() {
  const [W, H] = outputSize(state.editing.opts.aspect, '720');
  const k = 960 / Math.max(W, H);
  pv.width = Math.round(W * k);
  pv.height = Math.round(H * k);
}

function openEditor(clip) {
  state.editing = clip;
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
  state.editing = null;
  cancelAnimationFrame(raf);
  $('#editor').classList.add('hidden');
  document.body.style.overflow = '';
  if (clip) refreshCard(clip);
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
  $('#trimStart').value = c.start;
  $('#trimEnd').value = c.end;
  $('#startVal').textContent = fmtTime(c.start);
  $('#endVal').textContent = fmtTime(c.end);
  $('#lenVal').textContent = `${(c.end - c.start).toFixed(1)} s`;
  $('#scrub').min = c.start;
  $('#scrub').max = c.end;
  $('#tDur').textContent = fmtTime(c.end - c.start);
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
  const rel = video.currentTime - c.start;
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
pv.addEventListener('click', togglePlay);
$('#muteBtn').addEventListener('click', () => { video.muted = !video.muted; $('#muteBtn').textContent = video.muted ? '🔇' : '🔊'; });
$('#scrub').addEventListener('input', e => { video.currentTime = +e.target.value; });
$('#edClose').addEventListener('click', closeEditor);
$('#edExport').addEventListener('click', () => runExport([state.editing]));
document.addEventListener('keydown', e => {
  if (!state.editing || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'Escape') closeEditor();
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

const numOpt = (id, key, after) => $(id).addEventListener('input', e => { state.editing.opts[key] = +e.target.value; after?.(); });
numOpt('#cropX', 'cropX');
numOpt('#zoom', 'zoom', () => { $('#zoomVal').textContent = `${state.editing.opts.zoom.toFixed(2)}×`; });
numOpt('#capSize', 'capSize');
numOpt('#capPos', 'capPos');

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
  const keys = ['captions', 'capStyle', 'capSize', 'capPos', 'uppercase', 'emojis', 'layout', 'reframe', 'podcast', 'aspect', 'zoom', 'progress', 'hook'];
  state.clips.forEach(c => { if (c !== state.editing) keys.forEach(k => { c.opts[k] = src[k]; }); });
  state.clips.forEach(c => { if (c !== state.editing) refreshCard(c); });
  toast('Style appliqué à tous les clips', 'ok', 2500);
});
window.addEventListener('resize', () => state.editing && drawWave());

// Accès de débogage depuis la console du navigateur.
window.clipforge = { state, env };

document.fonts.load('900 40px Montserrat').catch(() => {});
