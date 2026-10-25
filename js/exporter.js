// Export d'un clip : rendu image par image sur un canvas + audio d'origine → MediaRecorder.
import { seekTo } from './analyzer.js';
import { renderFrame, ASPECTS, isSwear } from './renderer.js';

const MIMES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime() {
  return MIMES.find(m => window.MediaRecorder?.isTypeSupported(m)) || '';
}

export function outputSize(aspect, quality) {
  const [w, h] = ASPECTS[aspect] || ASPECTS['9:16'];
  const k = quality === '720' ? 2 / 3 : 1;
  return [Math.round(w * k / 2) * 2, Math.round(h * k / 2) * 2];
}

export async function exportClip({ url, clip, env, quality = '1080', music = null, onProgress, signal }) {
  const o = clip.opts;
  const speed = o.speed || 1;
  const [W, H] = outputSize(clip.opts.aspect, quality);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const v = document.createElement('video');
  v.src = url;
  v.preload = 'auto';
  v.playsInline = true;
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Lecture vidéo impossible')); });
  await seekTo(v, clip.start);
  v.playbackRate = speed;
  v.preservesPitch = true;

  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const voice = ac.createGain();
  voice.gain.value = o.volume ?? 1;
  const bleep = ac.createGain();
  ac.createMediaElementSource(v).connect(voice).connect(bleep).connect(dest);
  const swears = o.censor ? (clip.words || []).filter(w => isSwear(w.w) && w.e > clip.start && w.s < clip.end) : [];

  // Musique de fond en boucle, mixée sous la voix.
  let m = null;
  if (music?.url && o.music) {
    m = new Audio(music.url);
    m.loop = true;
    const mg = ac.createGain();
    mg.gain.value = o.musicVol ?? 0.15;
    ac.createMediaElementSource(m).connect(mg).connect(dest);
  }

  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = pickMime();
  const rec = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: Math.round(10_000_000 * (W * H) / (1080 * 1920)),
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });

  renderFrame(ctx, v, clip, clip.start, env);
  rec.start(500);
  await ac.resume();
  if (o.fade) {
    // Fondu sonore assorti au fondu au noir de l'image.
    const real = (clip.end - clip.start) / speed, now = ac.currentTime;
    voice.gain.setValueAtTime(0, now);
    voice.gain.linearRampToValueAtTime(o.volume ?? 1, now + 0.4);
    voice.gain.setValueAtTime(o.volume ?? 1, now + Math.max(0.4, real - 0.4));
    voice.gain.linearRampToValueAtTime(0, now + real);
  }
  if (swears.length) {
    // Bip à la place des gros mots : la voix est coupée et un « bip » de 1 kHz la remplace.
    const osc = ac.createOscillator(), bg = ac.createGain();
    osc.frequency.value = 1000;
    bg.gain.value = 0;
    osc.connect(bg).connect(dest);
    const now = ac.currentTime;
    for (const w of swears) {
      const a = now + Math.max(0, (w.s - clip.start) / speed), b = now + (w.e - clip.start) / speed;
      bleep.gain.setValueAtTime(0, a); bleep.gain.setValueAtTime(1, b);
      bg.gain.setValueAtTime(0.18, a); bg.gain.setValueAtTime(0, b);
    }
    osc.start();
  }
  await v.play();
  if (m) await m.play().catch(() => {});

  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    v.addEventListener('ended', finish);
    v.addEventListener('timeupdate', () => { if (v.currentTime >= clip.end || signal?.aborted) finish(); });
    const tick = () => {
      if (done) return;
      if (signal?.aborted || v.currentTime >= clip.end) return finish();
      renderFrame(ctx, v, clip, v.currentTime, env);
      onProgress?.((v.currentTime - clip.start) / (clip.end - clip.start));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  v.pause();
  m?.pause();
  await new Promise(r => setTimeout(r, 120));
  rec.stop();
  await stopped;
  stream.getTracks().forEach(tr => tr.stop());
  ac.close();
  v.removeAttribute('src');
  v.load();
  if (signal?.aborted) throw new DOMException('Export annulé', 'AbortError');

  const type = (mime || 'video/webm').split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
}
