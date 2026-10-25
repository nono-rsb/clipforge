// Rendu d'une image de clip : recadrage, fond flou, sous-titres animés, titre d'accroche.
import { clamp, clamp01 } from './analyzer.js';
import { emojiFor } from './emoji.js';

const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const wordEmoji = w => (w.emo === undefined ? (w.emo = emojiFor(w.w)) : w.emo);

export const ASPECTS = {
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '16:9': [1920, 1080],
};

export const CAPTION_STYLES = {
  karaoke: { label: 'Karaoké', accent: '#FFE600' },
  box: { label: 'Surligné', accent: '#7C5CFF' },
  impact: { label: 'Impact', accent: '#00E676' },
  neon: { label: 'Néon', accent: '#3DF5FF' },
  minimal: { label: 'Minimal', accent: '#FFFFFF' },
  pop: { label: 'Mot à mot', accent: '#FFE600' },
  beast: { label: 'Beast', accent: '#FF2D2D' },
  retro: { label: 'Rétro', accent: '#FF4FD8' },
};

// Polices des sous-titres : [graisse, famille] (chargées par Google Fonts dans index.html).
export const CAPTION_FONTS = {
  montserrat: { label: 'Montserrat', weight: 900, family: 'Montserrat' },
  anton: { label: 'Anton', weight: 400, family: 'Anton' },
  bangers: { label: 'Bangers', weight: 400, family: 'Bangers' },
  poppins: { label: 'Poppins', weight: 800, family: 'Poppins' },
};
export const fontSpec = (key, size, minimal = false) => {
  const f = CAPTION_FONTS[key] || CAPTION_FONTS.montserrat;
  const w = f.family === 'Montserrat' && minimal ? 800 : f.weight;
  return `${w} ${size}px "${f.family}", "Arial Black", Impact, sans-serif`;
};

// Filtres couleur appliqués à la vidéo (syntaxe CSS de ctx.filter).
export const FILTERS = {
  none: { label: 'Aucun', css: 'none' },
  vivid: { label: 'Vif', css: 'saturate(1.35) contrast(1.08)' },
  cinema: { label: 'Cinéma', css: 'contrast(1.15) saturate(0.85) sepia(0.12)' },
  warm: { label: 'Chaud', css: 'sepia(0.25) saturate(1.2) hue-rotate(-8deg)' },
  cool: { label: 'Froid', css: 'saturate(1.05) hue-rotate(12deg) brightness(1.03)' },
  bw: { label: 'N&B', css: 'grayscale(1) contrast(1.15)' },
};

export const HOOK_THEMES = {
  light: { bg: '#fff', fg: '#111' },
  dark: { bg: '#111', fg: '#fff' },
  accent: { bg: '#FFE600', fg: '#111' },
};

// Regroupe les mots en petites "bouchées" de 1 à 3 mots, comme les shorts viraux.
export function groupWords(words, maxWords = 3) {
  const groups = [];
  let cur = null;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const brk = !cur || cur.words.length >= maxWords || /[.!?…,;:]$/.test(prev?.w || '') || (prev && w.s - prev.e > 0.5);
    if (brk) { cur = { words: [], s: w.s, e: w.e }; groups.push(cur); }
    cur.words.push(w);
    cur.e = w.e;
  });
  return groups;
}

const bg = document.createElement('canvas');
const bgx = bg.getContext('2d');

export function renderFrame(ctx, video, clip, t, env) {
  const { width: W, height: H } = ctx.canvas;
  const o = clip.opts;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const vw = video.videoWidth, vh = video.videoHeight;
  if (vw) {
    ctx.save();
    ctx.filter = FILTERS[o.filter]?.css || 'none';
    const auto = o.reframe === 'auto';
    const duo = env.track.duo;
    const podcast = auto && o.layout === 'fill' && o.podcast && o.podcast !== 'off' && duo?.has(t);
    if (podcast && o.podcast === 'split') drawSplit(ctx, video, vw, vh, W, H, o, duo, t);
    else if (podcast) {
      // Orateur actif : plein cadre sur la personne qui parle, coupe franche au changement.
      const s = duo.seat(duo.speaker(t), t);
      drawFill(ctx, video, vw, vh, W, H, o.zoom * faceZoom(s, vw, vh, W, H), s.x, clamp(s.y + 0.1 / o.zoom, 0, 1));
    } else {
      const cx = auto ? env.track.x(t) : o.cropX;
      // Le visage est placé un peu au-dessus du centre (règle des tiers).
      const cy = auto ? clamp(env.track.y(t) + 0.1 / o.zoom, 0, 1) : 0.45;
      if (o.layout === 'fit') drawFit(ctx, video, vw, vh, W, H, o, cx);
      else drawFill(ctx, video, vw, vh, W, H, o.zoom, cx, cy);
    }
    ctx.restore();
  }
  if (o.captions && clip.groups?.length) drawCaptions(ctx, clip.groups, t, o, W, H);
  if (o.hook) drawHook(ctx, o.hookText || clip.title, t - clip.start, W, H, o);
  if (o.watermark) drawWatermark(ctx, o.watermark, W, H);
  if (o.progress) {
    const p = clamp01((t - clip.start) / (clip.end - clip.start));
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillRect(0, H - H * 0.008, W, H * 0.008);
    const acc = accentOf(o);
    ctx.fillStyle = acc.toUpperCase() === '#FFFFFF' ? '#7C5CFF' : acc;
    ctx.fillRect(0, H - H * 0.008, W * p, H * 0.008);
  }
  if (o.fade) {
    // Fondu au noir sur les 0,4 premières et dernières secondes.
    const d = 0.4 * (o.speed || 1);
    const a = Math.max(1 - (t - clip.start) / d, 1 - (clip.end - t) / d);
    if (a > 0) { ctx.fillStyle = `rgba(0,0,0,${clamp01(a)})`; ctx.fillRect(0, 0, W, H); }
  }
  ctx.restore();
}

const accentOf = o => o.capColor || CAPTION_STYLES[o.capStyle]?.accent || '#FFE600';

function drawWatermark(ctx, text, W, H) {
  const size = Math.round(Math.min(W, H * 0.75) * 0.032);
  ctx.save();
  ctx.font = `700 ${size}px Inter, Arial, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.globalAlpha = 0.7;
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = size * 0.4;
  ctx.fillStyle = '#fff';
  ctx.fillText(text, W - size, H - size * 1.4);
  ctx.restore();
}

function cropRect(vw, vh, W, H, zoom, cx, cy = 0.5) {
  const target = W / H;
  let sw, sh;
  if (vw / vh > target) { sh = vh; sw = vh * target; } else { sw = vw; sh = vw / target; }
  sw /= zoom; sh /= zoom;
  const sx = clamp(cx * vw - sw / 2, 0, vw - sw);
  const sy = clamp(cy * vh - sh / 2, 0, vh - sh);
  return [sx, sy, sw, sh];
}

function drawFill(ctx, video, vw, vh, W, H, zoom, cx, cy) {
  const [sx, sy, sw, sh] = cropRect(vw, vh, W, H, zoom, cx, cy);
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
}

// Zoom pour que le visage occupe ~1/3 de la largeur du cadre (sans jamais dézoomer).
function faceZoom(s, vw, vh, W, H) {
  const target = W / H;
  const maxW = vw / vh > target ? vh * target : vw;
  return clamp(maxW / (s.w * vw * 3), 1, 2.5);
}

// Écran partagé : personne de gauche en haut, personne de droite en bas.
function drawSplit(ctx, video, vw, vh, W, H, o, duo, t) {
  const h = Math.round(H / 2);
  const active = duo.speaker(t);
  [0, 1].forEach(p => {
    const s = duo.seat(p, t);
    const y0 = p * h;
    const [sx, sy, sw, sh] = cropRect(vw, vh, W, h, o.zoom * faceZoom(s, vw, vh, W, h), s.x, clamp(s.y + 0.08, 0, 1));
    ctx.drawImage(video, sx, sy, sw, sh, 0, y0, W, h);
    if (p !== active) { ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(0, y0, W, h); }
  });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, h - H * 0.002, W, H * 0.004);
}

function drawFit(ctx, video, vw, vh, W, H, o, cx) {
  // Fond : version minuscule floutée puis agrandie (rapide).
  const bw = 54, bh = Math.max(8, Math.round(bw * H / W));
  if (bg.width !== bw || bg.height !== bh) { bg.width = bw; bg.height = bh; }
  const [sx, sy, sw, sh] = cropRect(vw, vh, bw, bh, 1, 0.5);
  bgx.filter = 'blur(2px)';
  bgx.drawImage(video, sx, sy, sw, sh, -2, -2, bw + 4, bh + 4);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bg, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(0, 0, W, H);
  // Vidéo entière centrée (zoom rogne les côtés autour du sujet).
  const scale = Math.min(W / vw, H / vh) * o.zoom;
  const dw = vw * scale, dh = vh * scale;
  if (dw <= W) ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
  else {
    const vis = W / scale;
    const sx2 = clamp(cx * vw - vis / 2, 0, vw - vis);
    ctx.drawImage(video, sx2, 0, vis, vh, 0, (H - dh) / 2, W, dh);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

function findGroup(groups, t) {
  let lo = 0, hi = groups.length - 1, g = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (groups[m].s - 0.05 <= t) { g = m; lo = m + 1; } else hi = m - 1; }
  if (g < 0) return null;
  const cur = groups[g], next = groups[g + 1];
  const until = Math.min(cur.e + 0.6, next ? next.s - 0.05 : Infinity);
  return t <= until ? cur : null;
}

function drawCaptions(ctx, groups, t, o, W, H) {
  const g = findGroup(groups, t);
  if (!g) return;
  const base = Math.round(Math.min(W, H * 0.75) * 0.092 * o.capSize);
  const minimal = o.capStyle === 'minimal';
  ctx.font = fontSpec(o.capFont, base, minimal);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const toks = g.words.map(w => ({ w, text: o.uppercase ? w.w.toUpperCase() : w.w }));
  toks.forEach(k => { k.width = ctx.measureText(k.text).width; });
  // Le style Impact grossit le mot actif : on espace davantage pour qu'il ne touche pas ses voisins.
  const space = base * (o.capStyle === 'impact' || o.capStyle === 'beast' ? 0.45 : 0.28), maxW = W * 0.86;
  const lines = [[]];
  let lw = 0;
  for (const k of toks) {
    if (lines.at(-1).length && lw + space + k.width > maxW) { lines.push([]); lw = 0; }
    lw += (lines.at(-1).length ? space : 0) + k.width;
    lines.at(-1).push(k);
  }
  const appear = clamp01((t - g.s) / 0.12);
  const sc = 0.82 + 0.18 * (1 - (1 - appear) ** 3);
  ctx.save();
  ctx.translate(W / 2, H * o.capPos);
  ctx.scale(sc, sc);
  const accent = accentOf(o);
  lines.forEach((line, li) => {
    const width = line.reduce((a, k, i) => a + k.width + (i ? space : 0), 0);
    const y = (li - (lines.length - 1) / 2) * base * 1.18;
    let x = -width / 2;
    line.forEach((k, i) => {
      const next = g.words[g.words.indexOf(k.w) + 1];
      const active = t >= k.w.s && (next ? t < next.s : t < k.w.e + 0.6);
      // « Mot à mot » : les mots apparaissent au fur et à mesure qu'ils sont prononcés.
      if (o.capStyle !== 'pop' || t >= k.w.s - 0.02) {
        const pop = o.capStyle === 'pop' ? 0.7 + 0.3 * (1 - (1 - clamp01((t - k.w.s) / 0.12)) ** 3) : 1;
        ctx.save();
        if (pop !== 1) { ctx.translate(x + k.width / 2, y); ctx.scale(pop, pop); ctx.translate(-(x + k.width / 2), -y); }
        drawWord(ctx, o.capStyle, k.text, x, y, k.width, base, active, accent);
        ctx.restore();
      }
      x += k.width + space;
    });
  });
  if (o.emojis) {
    // Emoji du mot en cours s'il en a un, sinon du premier mot du groupe qui en a un.
    const cur = g.words.find((w, i) => t >= w.s && (g.words[i + 1] ? t < g.words[i + 1].s : true));
    const emo = (cur && wordEmoji(cur)) || g.words.map(wordEmoji).find(Boolean);
    if (emo) {
      const pop = 1 - (1 - clamp01((t - g.s) / 0.18)) ** 3;
      const size = base * 1.7 * (o.emojiSize || 1);
      const ey = -((lines.length - 1) / 2) * base * 1.18 - base * 1.55;
      ctx.save();
      ctx.translate(0, ey);
      ctx.scale(0.4 + 0.6 * pop, 0.4 + 0.6 * pop);
      ctx.rotate(Math.sin(t * 3) * 0.06);
      ctx.font = `${size}px ${EMOJI_FONT}`;
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,.45)';
      ctx.shadowBlur = size * 0.2;
      ctx.fillText(emo, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawWord(ctx, style, text, x, y, w, base, active, accent) {
  ctx.save();
  if (style === 'box' && active) {
    ctx.fillStyle = accent;
    roundRect(ctx, x - base * 0.14, y - base * 0.62, w + base * 0.28, base * 1.18, base * 0.2);
    ctx.fill();
  }
  if ((style === 'impact' || style === 'beast') && active) {
    ctx.translate(x + w / 2, y);
    ctx.scale(1.12, 1.12);
    ctx.translate(-(x + w / 2), -y);
    ctx.rotate(-0.02);
  }
  if (style === 'minimal') {
    ctx.shadowColor = 'rgba(0,0,0,.75)';
    ctx.shadowBlur = base * 0.25;
    ctx.shadowOffsetY = base * 0.05;
    ctx.fillStyle = active ? '#fff' : 'rgba(255,255,255,.72)';
    ctx.fillText(text, x, y);
    ctx.restore();
    return;
  }
  if (style === 'retro') {
    // Ombre portée franche, façon affiche.
    ctx.fillStyle = '#000';
    ctx.fillText(text, x + base * 0.08, y + base * 0.09);
  }
  ctx.strokeStyle = '#000';
  ctx.lineWidth = base * (style === 'impact' ? 0.22 : style === 'beast' ? 0.28 : 0.16);
  ctx.strokeText(text, x, y);
  if (style === 'neon' && active) { ctx.shadowColor = accent; ctx.shadowBlur = base * 0.5; }
  ctx.fillStyle = active && style !== 'box' ? accent : '#fff';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawHook(ctx, text, dt, W, H, o = {}) {
  const dur = (o.hookDur || 3) * (o.speed || 1) + 0.2;
  if (!text || dt < 0 || dt > dur) return;
  const alpha = dt > dur - 0.4 ? (dur - dt) / 0.4 : clamp01(dt / 0.2);
  const theme = HOOK_THEMES[o.hookTheme] || HOOK_THEMES.light;
  const size = Math.round(Math.min(W, H * 0.75) * 0.046);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `800 ${size}px Inter, Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const maxW = W * 0.78;
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const tryL = cur ? cur + ' ' + w : w;
    if (ctx.measureText(tryL).width > maxW && cur) { lines.push(cur); cur = w; } else cur = tryL;
  }
  if (cur) lines.push(cur);
  lines.splice(3);
  const lh = size * 1.28, pad = size * 0.7;
  const bw = Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2;
  const bh = lines.length * lh + pad * 1.2;
  const y0 = H * 0.1 + (1 - alpha) * -size;
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = size * 0.6;
  ctx.fillStyle = theme.bg;
  roundRect(ctx, (W - bw) / 2, y0, bw, bh, size * 0.45);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = theme.fg;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + pad * 0.6 + lh * (i + 0.5)));
  ctx.restore();
}
