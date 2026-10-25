// Lance Whisper (whisper-worker.js) sur un son 16 kHz mono et renvoie les segments horodatés.
// onStatus(texte, avancement 0..1) sert à afficher la progression.
export function transcribePcm(pcm, model, language, onStatus = () => {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    const segments = [];
    const files = new Map();
    let dev = '', started = false;
    const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'download') {
        files.set(m.file, m);
        let l = 0, t = 0;
        files.forEach(f => { l += f.loaded || 0; t += f.total || 0; });
        onStatus(`Téléchargement du modèle IA… ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} Mo`, t ? l / t : 0);
      } else if (m.type === 'ready') {
        dev = m.device === 'webgpu' ? 'GPU' : 'CPU';
        onStatus(`Modèle prêt (${dev}) — transcription…`, 0);
        if (!started) { started = true; w.postMessage({ type: 'run', audio: pcm, language }, [pcm.buffer]); }
      } else if (m.type === 'progress') {
        onStatus(`Transcription (${dev})… ${fmt(m.done)} / ${fmt(m.total)}`, m.done / m.total);
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
