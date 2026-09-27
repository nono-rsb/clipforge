// Analyse d'une vidéo longue : énergie audio, changements de plan, suivi du sujet,
// puis détection et notation des meilleurs moments (façon "virality score").

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const clamp01 = v => clamp(v, 0, 1);

export function fmtTime(t) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function seekTo(video, t) {
  return new Promise(resolve => {
    const done = () => { video.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 4000);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

/* ---------------- Audio ---------------- */

export async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  const ctx = new AudioContext();
  try { return await ctx.decodeAudioData(buf); }
  finally { ctx.close(); }
}

// Énergie (RMS en dB normalisée 0..1) par fenêtre de `hop` secondes.
export function computeEnergy(audio, hop = 0.1) {
  const sr = audio.sampleRate;
  const a = audio.getChannelData(0);
  const b = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
  const step = Math.floor(sr * hop);
  const len = Math.floor(audio.length / step);
  const db = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const o = i * step;
    let s = 0, n = 0;
    for (let j = 0; j < step; j += 4) {
      const v = b ? (a[o + j] + b[o + j]) * 0.5 : a[o + j];
      s += v * v; n++;
    }
    db[i] = 20 * Math.log10(Math.sqrt(s / n) + 1e-6);
  }
  const sorted = Float32Array.from(db).sort();
  const lo = sorted[Math.floor(len * 0.05)] ?? -60;
  const hi = sorted[Math.floor(len * 0.995)] ?? 0;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = clamp01((db[i] - lo) / (hi - lo || 1));
  return out;
}

export async function resampleTo16k(audio) {
  const len = Math.ceil(audio.duration * 16000);
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const r = await off.startRendering();
  return new Float32Array(r.getChannelData(0));
}

/* ---------------- Vidéo ---------------- */

// Échantillonne des images pour détecter les changements de plan, estimer où se trouve
// l'action (centre du mouvement) et, si `detect` est fourni, repérer les visages.
export async function analyzeVisual(video, duration, onProgress, detect) {
  const W = 96, H = 54;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const step = Math.max(1, duration / 400);
  const samples = [];
  let prev = null;
  for (let t = 0.05; t < duration; t += step) {
    await seekTo(video, t);
    ctx.drawImage(video, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let diff = 0, centroid = null;
    if (prev) {
      const col = new Float32Array(W);
      let tot = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, v = Math.abs(g[i] - prev[i]);
        diff += v;
        if (v > 12) { col[x] += v; tot += v; }
      }
      diff /= W * H;
      if (tot > W * H * 0.5 && diff < 40) {
        let s = 0;
        for (let x = 0; x < W; x++) s += col[x] * (x + 0.5);
        centroid = s / tot / W;
      }
    }
    samples.push({ t, diff, cx: centroid, faces: detect ? detect(video) : null });
    prev = g;
    onProgress?.(t / duration);
  }
  const diffs = samples.map(s => s.diff);
  const mean = diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1);
  const std = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length || 1));
  const thr = Math.max(18, mean + 2.5 * std);
  const cuts = samples.filter(s => s.diff > thr).map(s => s.t);
  return { samples, cuts, step };
}

// Suivi plus fin (toutes les 0,5 s) des visages sur les passages retenus.
// Renvoie la part des images où un visage a été trouvé.
export async function refineFaces(video, visual, ranges, detect, onProgress) {
  const total = ranges.reduce((a, r) => a + r.end - r.start, 0) || 1;
  let done = 0;
  const extra = [];
  for (const r of ranges) {
    for (let t = r.start; t < r.end; t += 0.5) {
      await seekTo(video, t);
      extra.push({ t, diff: 0, cx: null, faces: detect(video, { mouth: true }) });
      done += 0.5;
      onProgress?.(done / total);
    }
  }
  visual.samples = [...visual.samples, ...extra].sort((a, b) => a.t - b.t);
  return extra.filter(s => s.faces?.length).length / (extra.length || 1);
}

// Trajectoire lissée du cadrage → { x(t), y(t) } en 0..1.
// Priorité au visage (le plus grand, en restant sur le même s'il y en a plusieurs),
// sinon au centre du mouvement. Une zone morte évite les petits tremblements.
export function makeTrack(visual) {
  const S = visual?.samples || [];
  if (!S.length) return { x: () => 0.5, y: () => 0.42, hasFaces: false };
  const cuts = visual.cuts;
  const n = S.length;
  const times = S.map(s => s.t);
  const rx = new Float32Array(n), ry = new Float32Array(n), reset = new Uint8Array(n);
  let px = 0.5, py = 0.42, lastFace = -99, faceCount = 0;
  for (let i = 0; i < n; i++) {
    const s = S[i];
    let cut = false;
    if (i > 0) { const j = lowerBound(cuts, times[i - 1] + 1e-6); cut = j < cuts.length && cuts[j] <= times[i]; }
    if (cut) reset[i] = 1;
    let f = null;
    if (s.faces?.length) {
      const maxW = Math.max(...s.faces.map(g => g.w));
      const cands = s.faces.filter(g => g.w >= 0.7 * maxW);
      f = (cut || s.t - lastFace > 2)
        ? cands.reduce((a, b) => (b.w > a.w ? b : a))
        : cands.reduce((a, b) => (Math.abs(b.x - px) < Math.abs(a.x - px) ? b : a));
    }
    if (f) { px = f.x; py = f.y; lastFace = s.t; faceCount++; }
    else if (cut || s.t - lastFace > 2) {
      px = s.cx ?? (cut ? 0.5 : px);
      py = 0.42;
    }
    rx[i] = px; ry[i] = py;
  }
  // Zone morte : le cadre ne bouge que si le sujet s'éloigne vraiment.
  let hx = rx[0], hy = ry[0];
  for (let i = 0; i < n; i++) {
    if (reset[i] || Math.abs(rx[i] - hx) > 0.05) hx = rx[i];
    if (reset[i] || Math.abs(ry[i] - hy) > 0.06) hy = ry[i];
    rx[i] = hx; ry[i] = hy;
  }
  // Lissage aller-retour, réinitialisé à chaque changement de plan.
  const smooth = raw => {
    const fwd = new Float32Array(n), out = new Float32Array(n), k = 0.35;
    for (let i = 0; i < n; i++) fwd[i] = (i === 0 || reset[i]) ? raw[i] : fwd[i - 1] + k * (raw[i] - fwd[i - 1]);
    for (let i = n - 1; i >= 0; i--) out[i] = (i === n - 1 || reset[i + 1]) ? fwd[i] : out[i + 1] + k * (fwd[i] - out[i + 1]);
    return out;
  };
  const interp = out => t => {
    let lo = 0, hi = n - 1;
    if (t <= times[0]) return out[0];
    if (t >= times[hi]) return out[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
    if (reset[hi]) return out[lo];
    const f = (t - times[lo]) / (times[hi] - times[lo]);
    return out[lo] + (out[hi] - out[lo]) * f;
  };
  return {
    x: interp(smooth(rx)), y: interp(smooth(ry)), hasFaces: faceCount > 0,
    duo: makeDuo(S, times, reset, smooth, interp),
  };
}

// Mode podcast : deux personnes dans le même plan → une « place » à gauche (A) et une à droite (B),
// suivies séparément, et l'orateur actif déduit des mouvements de la bouche.
function makeDuo(S, times, reset, smooth, interp) {
  const n = S.length;
  const raw = new Uint8Array(n);
  const seat = () => ({ x: new Float32Array(n), y: new Float32Array(n), w: new Float32Array(n) });
  const A = seat(), B = seat();
  const jaw = [new Float32Array(n).fill(NaN), new Float32Array(n).fill(NaN)];
  // Secours : mouvement des pixels de la bouche moins celui du haut du visage (mouvements de tête).
  const mot = [new Float32Array(n).fill(NaN), new Float32Array(n).fill(NaN)];
  const pairs = new Array(n).fill(null);
  const pdiff = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]); return s / a.length; };
  let la = null, lb = null;
  for (let i = 0; i < n; i++) {
    const fs = [...(S[i].faces || [])].sort((a, b) => b.w - a.w);
    let pair = null;
    if (fs.length >= 2 && fs[1].w >= 0.5 * fs[0].w && Math.abs(fs[0].x - fs[1].x) > 0.15) {
      pair = fs[0].x < fs[1].x ? [fs[0], fs[1]] : [fs[1], fs[0]];
    }
    if (reset[i] && !pair) la = lb = null;
    if (pair) {
      raw[i] = 1;
      [la, lb] = pair;
      if (la.jaw != null) jaw[0][i] = la.jaw;
      if (lb.jaw != null) jaw[1][i] = lb.jaw;
      pairs[i] = pair;
      let k = i - 1;
      while (k >= 0 && !pairs[k] && times[i] - times[k] <= 0.8) k--;
      if (k >= 0 && pairs[k] && times[i] - times[k] <= 0.8) {
        [0, 1].forEach(p => {
          const f = pair[p], g = pairs[k][p];
          if (f.mouthPatch && g.mouthPatch) mot[p][i] = Math.max(0, pdiff(f.mouthPatch, g.mouthPatch) - 0.7 * pdiff(f.eyePatch, g.eyePatch));
        });
      }
    }
    const a = la || { x: 0.3, y: 0.42, w: 0.1 }, b = lb || { x: 0.7, y: 0.42, w: 0.1 };
    A.x[i] = a.x; A.y[i] = a.y; A.w[i] = a.w;
    B.x[i] = b.x; B.y[i] = b.y; B.w[i] = b.w;
  }
  if (!raw.some(Boolean)) return null;

  // Présence du duo stabilisée : majorité sur ±1 s (évite de changer de mise en page pour un raté).
  const within = (i, fn, back = 1, fwd = 1) => {
    let lo = i, hi = i;
    while (lo > 0 && times[i] - times[lo - 1] <= back) lo--;
    while (hi < n - 1 && times[hi + 1] - times[i] <= fwd) hi++;
    return fn(lo, hi);
  };
  // La vidéo est analysée à l'avance : on regarde surtout vers le futur pour couper
  // sur la personne au moment où elle commence à parler, pas 2 s après.
  const AHEAD = [0.5, 1.5];
  const stable = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    stable[i] = within(i, (lo, hi) => { let c = 0; for (let k = lo; k <= hi; k++) c += raw[k]; return c * 2 >= hi - lo + 1 ? 1 : 0; });
  }

  // Activité de parole : variations de l'ouverture de la bouche + ouverture moyenne, sur ±1 s.
  const activity = p => Float32Array.from({ length: n }, (_, i) => within(i, (lo, hi) => {
    let d = 0, nd = 0, m = 0, nm = 0, prev = NaN;
    for (let k = lo; k <= hi; k++) {
      const v = jaw[p][k];
      if (Number.isNaN(v)) continue;
      m += v; nm++;
      if (!Number.isNaN(prev)) { d += Math.abs(v - prev); nd++; }
      prev = v;
    }
    return nm ? (nd ? d / nd : 0) + 0.3 * (m / nm) : NaN;
  }, ...AHEAD));
  const motion = p => Float32Array.from({ length: n }, (_, i) => within(i, (lo, hi) => {
    let s = 0, c = 0;
    for (let k = lo; k <= hi; k++) if (!Number.isNaN(mot[p][k])) { s += mot[p][k]; c++; }
    return c ? s / c : NaN;
  }, ...AHEAD));
  const act = [activity(0), activity(1)];
  const actM = [motion(0), motion(1)];
  const speaker = new Uint8Array(n);
  let cur = 0, lastSwitch = -99;
  for (let i = 0; i < n; i++) {
    // Ouverture de bouche si dispo pour les deux, sinon mouvement de la bouche.
    let a0 = act[0][i], a1 = act[1][i], margin = 0.015;
    if (Number.isNaN(a0) || Number.isNaN(a1)) { a0 = actM[0][i]; a1 = actM[1][i]; margin = 0.004; }
    if (!Number.isNaN(a0) && !Number.isNaN(a1)) {
      if (reset[i] || lastSwitch < -1) { cur = a1 > a0 ? 1 : 0; lastSwitch = times[i]; }
      else {
        const mine = cur ? a1 : a0, other = cur ? a0 : a1;
        if (other > mine * 1.35 + margin && times[i] - lastSwitch >= 1.2) { cur = 1 - cur; lastSwitch = times[i]; }
      }
    }
    speaker[i] = cur;
  }

  const nearest = t => {
    let lo = 0, hi = n - 1;
    if (t <= times[0]) return 0;
    if (t >= times[hi]) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
    return t - times[lo] < times[hi] - t ? lo : hi;
  };
  const floorIdx = t => {
    let lo = 0, hi = n - 1;
    if (t < times[0]) return 0;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (times[m] <= t) lo = m; else hi = m - 1; }
    return lo;
  };
  const seatFns = s => ({ x: interp(smooth(s.x)), y: interp(smooth(s.y)), w: interp(smooth(s.w)) });
  const sa = seatFns(A), sb = seatFns(B);
  return {
    has: t => stable[nearest(t)] === 1,
    speaker: t => speaker[floorIdx(t)],
    seat: (p, t) => {
      const s = p ? sb : sa;
      return { x: s.x(t), y: s.y(t), w: s.w(t) };
    },
    share: (a, b) => {
      let c = 0, tot = 0;
      for (let i = 0; i < n; i++) if (times[i] >= a && times[i] <= b) { tot++; c += stable[i]; }
      return tot ? c / tot : 0;
    },
  };
}

/* ---------------- Transcription ---------------- */

const HALLUCINATIONS = /amara\.org|sous-titr|merci d'avoir regard|thanks for watching|abonnez-vous/i;

// Segments Whisper → mots horodatés (répartis selon leur longueur).
export function buildWords(segments) {
  const segs = segments
    .filter(s => s.text && !HALLUCINATIONS.test(s.text))
    .sort((a, b) => a.start - b.start);
  const words = [];
  segs.forEach((seg, k) => {
    const toks = seg.text.split(/\s+/).filter(Boolean);
    if (!toks.length) return;
    let end = seg.end;
    const next = segs[k + 1];
    if (next && end > next.start) end = next.start;
    if (!(end > seg.start)) end = seg.start + 0.35 * toks.length;
    const weights = toks.map(w => w.length + 2);
    const tot = weights.reduce((a, b) => a + b, 0);
    let t = seg.start;
    toks.forEach((w, i) => {
      const d = (end - seg.start) * weights[i] / tot;
      words.push({ w, s: t, e: t + d });
      t += d;
    });
  });
  return words;
}

/* ---------------- Détection des moments forts ---------------- */

const KEYWORDS = new Set((
  'secret secrets incroyable jamais toujours pourquoi comment attention erreur erreurs argent gratuit meilleur meilleure pire ' +
  'vrai vraiment verite choc enorme fou folle dingue personne problème probleme solution astuce astuces conseil important ' +
  'urgent histoire decouvert million millions milliard stop arrete regarde imagine imaginez serieux serieusement wow ' +
  'incroyablement choquant interdit revele revelation danger mort peur riche pauvre succes echec gagner perdu perdre ' +
  'secret never always why how mistake mistakes money free best worst truth crazy insane nobody everyone problem hack ' +
  'tip tips important million millions billion imagine actually literally shocking banned dangerous rich broke win lose'
).split(' '));

const STOP = new Set((
  'alors aussi avec avoir avait cette comme dans donc elle elles encore etait etre fait faire leur leurs mais meme parce ' +
  'plus pour quand quelque quoi sans sont suis tous tout toute toutes tres votre vous nous notre ils elle cest quil ' +
  'about after again because being could doing from have just like more really some than that their them then there ' +
  'these they this very what when where which while with would your yeah okay voila juste bien ouais'
).split(' '));

export const norm = w => w.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');

function kwScore(w) {
  let s = KEYWORDS.has(norm(w)) ? 1 : 0;
  if (/[?]$/.test(w)) s += 0.6;
  if (/[!]$/.test(w)) s += 0.4;
  return s;
}

function lowerBound(arr, x, key = v => v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]) < x) lo = m + 1; else hi = m; }
  return lo;
}

export function findClips({ duration, energy, hop, words, cuts, minLen, maxLen, count }) {
  if (duration < minLen) { minLen = Math.max(3, duration * 0.5); maxLen = duration; }
  const N = energy.length;
  const P = new Float64Array(N + 1), P2 = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) { P[i + 1] = P[i] + energy[i]; P2[i + 1] = P2[i] + energy[i] ** 2; }
  const gMean = N ? P[N] / N : 0;
  const gStd = Math.max(0.05, Math.sqrt(Math.max(0, (N ? P2[N] / N : 0) - gMean ** 2)));
  const ACT = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) ACT[i + 1] = ACT[i] + (energy[i] > gMean - 0.3 * gStd ? 1 : 0);
  const idx = t => clamp(Math.round(t / hop), 0, N);
  const range = (A, a, b) => { const i = idx(a), j = idx(b); return j > i ? (A[j] - A[i]) / (j - i) : 0; };
  const meanE = (a, b) => range(P, a, b);
  const stdE = (a, b) => Math.sqrt(Math.max(0, range(P2, a, b) - meanE(a, b) ** 2));

  const KW = new Float64Array(words.length + 1);
  words.forEach((w, i) => { KW[i + 1] = KW[i] + kwScore(w.w); });
  const wordIdx = t => lowerBound(words, t, w => w.s);

  // Points de coupe naturels : fins de phrases, pauses, creux d'énergie.
  const starts = [{ t: 0, strong: true }], ends = [{ t: duration, strong: true }];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], nx = words[i + 1];
    const sentence = /[.!?…]$/.test(w.w);
    const gap = nx ? nx.s - w.e : 99;
    if (sentence || gap > 0.4) {
      ends.push({ t: Math.min(duration, w.e + 0.25), strong: sentence });
      if (nx) starts.push({ t: Math.max(0, nx.s - 0.15), strong: sentence });
    }
  }
  const win = Math.max(1, Math.round(0.5 / hop));
  for (let i = win; i < N - win; i += 2) {
    const v = energy[i];
    if (v > gMean - 0.5 * gStd) continue;
    let isMin = true;
    for (let j = i - win; j <= i + win && isMin; j++) if (energy[j] < v) isMin = false;
    if (isMin) { starts.push({ t: i * hop, strong: !words.length }); ends.push({ t: i * hop, strong: !words.length }); }
  }
  if (starts.length < 10) for (let t = 0; t < duration; t += 2) { starts.push({ t, strong: false }); ends.push({ t, strong: false }); }
  starts.sort((a, b) => a.t - b.t);
  ends.sort((a, b) => a.t - b.t);

  const sStride = Math.max(1, Math.ceil(starts.length / 2500));
  const cands = [];
  for (let si = 0; si < starts.length; si += sStride) {
    const s = starts[si];
    const e0 = lowerBound(ends, s.t + minLen, e => e.t);
    const e1 = lowerBound(ends, s.t + maxLen + 1e-6, e => e.t);
    const eStride = Math.max(1, Math.ceil((e1 - e0) / 12));
    for (let ei = e0; ei < e1; ei += eStride) cands.push(scoreCand(s, ends[ei]));
  }

  function scoreCand(s, e) {
    const a = s.t, b = e.t, len = b - a;
    const loud = clamp01(0.5 + (meanE(a, b) - gMean) / (2 * gStd));
    const dyn = clamp01(stdE(a, b) / (gStd * 1.2));
    const hookE = clamp01(0.5 + (meanE(a, Math.min(b, a + 3)) - gMean) / (2 * gStd));
    let speech, kw = 0, hookKw = 0;
    if (words.length) {
      const i0 = wordIdx(a), i1 = wordIdx(b);
      speech = clamp01(((i1 - i0) / len) / 3.2);
      kw = clamp01(((KW[i1] - KW[i0]) / (len / 10)) / 2);
      hookKw = clamp01(KW[Math.min(i1, i0 + 14)] - KW[i0]);
    } else speech = range(ACT, a, b);
    const nc = lowerBound(cuts, b) - lowerBound(cuts, a);
    const cutRate = clamp01((nc / len) * 10 / 3);
    const target = (minLen + maxLen) / 2;
    const lenFit = 1 - Math.min(1, Math.abs(len - target) / (maxLen - minLen + 1));
    const raw = 0.22 * loud + 0.14 * dyn + 0.16 * hookE + 0.16 * speech + 0.12 * kw + 0.08 * hookKw
      + 0.05 * cutRate + 0.02 * ((s.strong ? 1 : 0.4) + (e.strong ? 1 : 0.4)) + 0.03 * lenFit;
    return { start: a, end: b, raw, f: { loud, dyn, hookE, speech, kw, hookKw, cutRate } };
  }

  cands.sort((x, y) => y.raw - x.raw);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    const ok = picked.every(p => {
      const ov = Math.max(0, Math.min(p.end, c.end) - Math.max(p.start, c.start));
      return ov < 0.15 * Math.min(p.end - p.start, c.end - c.start);
    });
    if (ok) picked.push(c);
  }
  const rMax = cands[0]?.raw ?? 1;
  const rLo = cands[Math.floor(cands.length * 0.5)]?.raw ?? 0;

  return picked.map((c, i) => {
    const cw = words.filter(w => w.s >= c.start - 0.05 && w.e <= c.end + 0.3);
    const text = cw.map(w => w.w).join(' ');
    return {
      id: `c${Date.now().toString(36)}${i}`,
      start: c.start, end: c.end,
      score: Math.round(clamp(60 + 39 * (c.raw - rLo) / (rMax - rLo || 1), 48, 99)),
      reasons: reasonsFor(c.f),
      title: makeTitle(cw, c.start),
      hashtags: makeHashtags(cw),
      text,
    };
  });
}

function reasonsFor(f) {
  const r = [];
  if (f.hookKw > 0.5) r.push(['❓', 'Accroche percutante']);
  if (f.hookE > 0.72) r.push(['🔥', 'Démarrage fort']);
  if (f.loud > 0.7) r.push(['📢', 'Moment intense']);
  if (f.kw > 0.5) r.push(['🎯', 'Mots-clés forts']);
  if (f.dyn > 0.75) r.push(['⚡', 'Rythme dynamique']);
  if (f.speech > 0.8) r.push(['💬', 'Débit rapide']);
  if (f.cutRate > 0.5) r.push(['🎬', 'Montage vif']);
  if (!r.length) r.push(['✨', 'Passage équilibré']);
  return r.slice(0, 3);
}

function makeTitle(cw, start) {
  if (!cw.length) return `Moment fort à ${fmtTime(start)}`;
  let out = [];
  for (const w of cw) { out.push(w.w); if (/[.!?…]$/.test(w.w) && out.length >= 4) break; if (out.length >= 14) break; }
  let t = out.join(' ').replace(/[,;:]$/, '');
  if (t.length > 72) t = t.slice(0, 70).replace(/\s\S*$/, '') + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function makeHashtags(cw) {
  const freq = new Map();
  for (const w of cw) {
    const n = norm(w.w);
    if (n.length < 5 || STOP.has(n) || /^\d+$/.test(n)) continue;
    freq.set(n, (freq.get(n) || 0) + 1 + (KEYWORDS.has(n) ? 1 : 0));
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => '#' + w);
}
