// Transcription locale avec Whisper (Transformers.js) — tourne dans le navigateur, rien n'est envoyé.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

env.allowLocalModels = false;

let asr = null;
let device = 'wasm';
let modelId = null;

const post = m => self.postMessage(m);

async function load(model, dev) {
  const progress_callback = p => {
    if (p.status === 'progress') post({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
  };
  asr = await pipeline('automatic-speech-recognition', model, {
    device: dev,
    dtype: dev === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback,
  });
  device = dev;
  modelId = model;
}

async function transcribeChunk(slice, language) {
  const opts = { task: 'transcribe', return_timestamps: true };
  if (language && language !== 'auto') opts.language = language;
  return asr(slice, opts);
}

self.onmessage = async e => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const devices = self.navigator?.gpu ? ['webgpu', 'wasm'] : ['wasm'];
      let err;
      for (const d of devices) {
        try { await load(msg.model, d); post({ type: 'ready', device: d }); return; } catch (x) { err = x; }
      }
      throw err;
    }
    if (msg.type === 'run') {
      const { audio, language } = msg;
      const SR = 16000, CH = 30 * SR;
      const total = audio.length / SR;
      for (let off = 0; off < audio.length; off += CH) {
        const slice = audio.subarray(off, Math.min(audio.length, off + CH));
        const t0 = off / SR, len = slice.length / SR;
        let s = 0;
        for (let i = 0; i < slice.length; i += 16) s += slice[i] * slice[i];
        const rms = Math.sqrt(s / (slice.length / 16));
        if (rms > 0.004 && len > 0.6) {
          let out;
          try { out = await transcribeChunk(slice, language); }
          catch (x) {
            if (device !== 'webgpu') throw x;
            await load(modelId, 'wasm');
            post({ type: 'ready', device: 'wasm' });
            out = await transcribeChunk(slice, language);
          }
          const chunks = out.chunks?.length ? out.chunks : [{ text: out.text, timestamp: [0, len] }];
          const segments = chunks
            .map(c => ({
              text: (c.text || '').trim(),
              start: t0 + (c.timestamp?.[0] ?? 0),
              end: t0 + Math.min(len, c.timestamp?.[1] ?? len),
            }))
            .filter(sg => sg.text);
          post({ type: 'segments', segments });
        }
        post({ type: 'progress', done: Math.min(total, t0 + len), total });
      }
      post({ type: 'done' });
    }
  } catch (x) {
    post({ type: 'error', message: x?.message || String(x) });
  }
};
