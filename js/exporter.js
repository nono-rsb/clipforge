// Export d'un clip : rendu image par image sur un canvas + audio d'origine → MediaRecorder.
import { seekTo } from './analyzer.js';
import { renderFrame, ASPECTS } from './renderer.js';

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

export async function exportClip({ url, clip, env, quality = '1080', onProgress, signal }) {
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

  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  ac.createMediaElementSource(v).connect(dest);

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
  await v.play();

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
