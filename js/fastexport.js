// Export rapide : au lieu de rejouer la vidéo en temps réel, on lit directement les images du
// fichier (WebCodecs), on les dessine sur le canvas et on les encode aussi vite que la machine
// le permet. Le son est mixé hors temps réel (OfflineAudioContext). Quand le fichier ou le
// navigateur ne s'y prête pas, l'appelant repasse sur l'export en temps réel.
import { Muxer, ArrayBufferTarget } from './mp4-muxer.js';

let boxLib = null;
function loadMp4box() {
  boxLib ||= new Promise((res, rej) => {
    if (window.MP4Box) return res();
    const s = document.createElement('script');
    s.src = new URL('./mp4box.all.min.js', import.meta.url).href;
    s.onload = () => res();
    s.onerror = () => rej(new Error('mp4box indisponible'));
    document.head.append(s);
  });
  return boxLib;
}

export const fastAvailable = () => !!(window.VideoDecoder && window.VideoEncoder && window.AudioEncoder && window.OfflineAudioContext);

/* ---------------- Lecture du fichier (MP4 / MOV) ---------------- */

// Repère les boîtes de premier niveau (ftyp, moov…) sans lire les données (mdat), qui peuvent peser des Go.
async function topBoxes(file) {
  const out = [];
  let pos = 0;
  while (pos + 8 <= file.size) {
    const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1) size = Number(h.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    out.push({ type, pos, size });
    pos += size;
  }
  return out;
}

const cache = new WeakMap();

// Analyse le fichier une fois : pistes, liste des images et des paquets audio avec leur position.
export function openSource(file) {
  if (!cache.has(file)) cache.set(file, open(file));
  return cache.get(file);
}

async function open(file) {
  await loadMp4box();
  const boxes = await topBoxes(file);
  const moov = boxes.find(b => b.type === 'moov');
  if (!moov || boxes.some(b => b.type === 'moof')) throw new Error('format non pris en charge');
  const keep = boxes.filter(b => b.type === 'ftyp' || b.type === 'moov');
  const parts = await Promise.all(keep.map(b => file.slice(b.pos, b.pos + b.size).arrayBuffer()));
  const buf = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { buf.set(new Uint8Array(p), o); o += p.byteLength; }
  const mp4 = MP4Box.createFile(false);
  let info = null;
  mp4.onReady = i => { info = i; };
  mp4.onError = () => {};
  const ab = buf.buffer;
  ab.fileStart = 0;
  mp4.appendBuffer(ab);
  mp4.flush();
  if (!info?.videoTracks?.length) throw new Error('pas de piste vidéo lisible');
  const vt = info.videoTracks[0], at = info.audioTracks?.[0];
  const vtrak = mp4.getTrackById(vt.id);
  const entry = vtrak.mdia.minf.stbl.stsd.entries[0];
  const cbox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  let description;
  if (cbox) {
    const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    cbox.write(ds);
    description = new Uint8Array(ds.buffer, 8);
  }
  const video = {
    config: { codec: vt.codec.startsWith('vp08') ? 'vp8' : vt.codec, codedWidth: vt.video.width, codedHeight: vt.video.height, ...(description ? { description } : {}) },
    samples: vtrak.samples,
    rotation: rotationOf(vt.matrix),
  };
  if (!(await VideoDecoder.isConfigSupported(video.config)).supported) throw new Error(`codec ${vt.codec} non décodable`);
  let audio = null;
  if (at) {
    const atrak = mp4.getTrackById(at.id);
    const ae = atrak.mdia.minf.stbl.stsd.entries[0];
    const dsi = ae.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
    const cfg = { codec: at.codec, sampleRate: at.audio.sample_rate, numberOfChannels: at.audio.channel_count, ...(dsi ? { description: dsi } : {}) };
    if (window.AudioDecoder && (await AudioDecoder.isConfigSupported(cfg).catch(() => ({}))).supported) audio = { config: cfg, samples: atrak.samples };
  }
  return { video, audio, hasAudio: !!at };
}

// Rotation enregistrée par les téléphones (matrice de la piste).
function rotationOf(m) {
  if (!m) return 0;
  const a = m[0] / 65536, b = m[1] / 65536;
  return ((Math.round(Math.atan2(b, a) * 180 / Math.PI) % 360) + 360) % 360;
}

// Lit les octets d'une suite de paquets par blocs de 16 Mo au plus.
async function* readSamples(file, samples, i0, i1) {
  let i = i0;
  while (i < i1) {
    const start = samples[i].offset;
    let j = i, end = start;
    while (j < i1 && samples[j].offset + samples[j].size - start <= 16e6 && samples[j].offset >= start) { end = Math.max(end, samples[j].offset + samples[j].size); j++; }
    if (j === i) { end = samples[i].offset + samples[i].size; j = i + 1; }
    const buf = await file.slice(start, end).arrayBuffer();
    for (let k = i; k < j; k++) yield [samples[k], new Uint8Array(buf, samples[k].offset - start, samples[k].size)];
    i = j;
  }
}

/* ---------------- Images ---------------- */

// Parcourt les images de la source entre a et b (secondes) et appelle onFrame(source, t)
// pour chaque instant demandé par times(k) (croissant). La source imite un <video> pour renderFrame.
export async function eachFrame({ file, src, a, b, count, timeAt, onFrame, pace, signal }) {
  const { samples, config, rotation } = src.video;
  const ts = samples[0]?.timescale || 1;
  let i0 = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].cts / ts > a) break;
    if (samples[i].is_sync) i0 = i;
  }
  let i1 = i0;
  while (i1 < samples.length && samples[i1].dts / ts <= b + 1) i1++;
  i1 = Math.min(samples.length, i1 + 8);

  let rot = null;
  const wrap = frame => {
    if (!rotation) {
      frame.videoWidth = frame.displayWidth;
      frame.videoHeight = frame.displayHeight;
      return frame;
    }
    const sw = frame.displayWidth, sh = frame.displayHeight, swap = rotation % 180 !== 0;
    rot ||= Object.assign(document.createElement('canvas'), { width: swap ? sh : sw, height: swap ? sw : sh });
    const c = rot.getContext('2d');
    c.save();
    c.translate(rot.width / 2, rot.height / 2);
    c.rotate(rotation * Math.PI / 180);
    c.drawImage(frame, -sw / 2, -sh / 2);
    c.restore();
    rot.videoWidth = rot.width;
    rot.videoHeight = rot.height;
    return rot;
  };

  let k = 0, cur = null, err = null;
  // Chaque instant demandé reçoit la dernière image affichée avant lui (ou la première, au tout début).
  const emit = f => {
    while (k < count && timeAt(k) < f.timestamp / 1e6 - 1e-4) {
      onFrame(wrap(cur || f), timeAt(k), k);
      k++;
    }
  };
  const dec = new VideoDecoder({
    output: f => {
      try { emit(f); } catch (e) { err = e; }
      cur?.close();
      cur = f;
    },
    error: e => { err = e; },
  });
  dec.configure({ ...config, hardwareAcceleration: 'no-preference' });
  for await (const [s, data] of readSamples(file, samples, i0, i1)) {
    if (err) throw err;
    if (signal?.aborted) break;
    if (k >= count) break;
    dec.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts / ts * 1e6), duration: Math.round(s.duration / ts * 1e6), data }));
    while (dec.decodeQueueSize > 6 && !err) await new Promise(r => setTimeout(r, 0));
    await pace?.();
  }
  if (!signal?.aborted) await dec.flush().catch(e => { err ||= e; });
  if (err) { cur?.close(); dec.close(); throw err; }
  // Les dernières images reprennent la dernière image décodée.
  while (k < count && cur && !signal?.aborted) { onFrame(wrap(cur), timeAt(k), k); k++; }
  cur?.close();
  if (dec.state !== 'closed') dec.close();
}

/* ---------------- Son ---------------- */

// Son de la source entre a et b → { sampleRate, channels: Float32Array[] }, ou null sans audio.
export async function readAudio(file, src, a, b) {
  if (!src.audio) return null;
  const { samples, config } = src.audio;
  const ts = samples[0]?.timescale || config.sampleRate;
  let i0 = 0;
  while (i0 < samples.length - 1 && samples[i0 + 1].cts / ts <= a - 0.1) i0++;
  let i1 = i0;
  while (i1 < samples.length && samples[i1].cts / ts < b + 0.1) i1++;
  const parts = [];
  let err = null, rate = config.sampleRate, nch = config.numberOfChannels;
  const dec = new AudioDecoder({
    output: d => {
      rate = d.sampleRate; nch = d.numberOfChannels;
      const ch = [];
      for (let c = 0; c < d.numberOfChannels; c++) {
        const arr = new Float32Array(d.numberOfFrames);
        d.copyTo(arr, { planeIndex: c, format: 'f32-planar' });
        ch.push(arr);
      }
      parts.push({ t: d.timestamp / 1e6, ch });
      d.close();
    },
    error: e => { err = e; },
  });
  dec.configure(config);
  for await (const [s, data] of readSamples(file, samples, i0, i1)) {
    if (err) break;
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.cts / ts * 1e6), duration: Math.round(s.duration / ts * 1e6), data }));
    if (dec.decodeQueueSize > 20) await new Promise(r => setTimeout(r, 0));
  }
  await dec.flush().catch(e => { err ||= e; });
  dec.close();
  if (err) throw err;
  const len = Math.max(1, Math.round((b - a) * rate));
  const out = Array.from({ length: Math.max(1, nch) }, () => new Float32Array(len));
  for (const p of parts) {
    const at = Math.round((p.t - a) * rate);
    out.forEach((o, c) => {
      const s = p.ch[Math.min(c, p.ch.length - 1)];
      const from = Math.max(0, -at), to = Math.min(s.length, len - at);
      if (to > from) o.set(s.subarray(from, to), at + from);
    });
  }
  return { sampleRate: rate, channels: out };
}

// Change la vitesse sans changer la hauteur de la voix (WSOLA : on recolle des morceaux de son
// en cherchant à chaque fois l'endroit qui se raccorde le mieux).
export function timeStretch(channels, rate, speed) {
  if (Math.abs(speed - 1) < 1e-3) return channels;
  const N = Math.round(rate * 0.04) & ~1, Ha = N / 2, tol = Math.round(rate * 0.012);
  const inLen = channels[0].length, outLen = Math.floor(inLen / speed);
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const out = channels.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const mono = channels.length > 1 ? channels[0].map((v, i) => (v + channels[1][i]) / 2) : channels[0];
  let prev = 0;
  for (let o = 0; o < outLen; o += Ha) {
    const target = Math.round(o * speed);
    let best = target;
    if (o > 0) {
      // Le morceau qui suit naturellement le précédent sert de modèle.
      const ref = prev + Ha;
      let bestC = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const p = target + d;
        if (p < 0 || p + N > inLen) continue;
        let c = 0;
        for (let i = 0; i < N; i += 4) c += mono[p + i] * (mono[ref + i] || 0);
        if (c > bestC) { bestC = c; best = p; }
      }
    }
    best = Math.max(0, Math.min(inLen - N, best));
    for (let i = 0; i < N && o + i < out[0].length; i++) {
      const w = win[i];
      channels.forEach((ch, c) => { out[c][o + i] += (ch[best + i] || 0) * w; });
      norm[o + i] += w;
    }
    prev = best;
  }
  return out.map(ch => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? ch[i] / norm[i] : 0;
    return r;
  });
}

/* ---------------- Encodage ---------------- */

export async function makeEncoder({ W, H, fps, withAudio }) {
  const vBitrate = Math.round(10_000_000 * (W * H) / (1080 * 1920) * (fps > 30 ? 1.5 : 1));
  const vOpts = [
    { codec: fps > 30 ? 'avc1.64002A' : 'avc1.640028', mux: 'avc' },
    { codec: 'avc1.4D0028', mux: 'avc' },
    { codec: 'vp09.00.40.08', mux: 'vp9' },
  ];
  let vc = null;
  for (const v of vOpts) {
    const cfg = { codec: v.codec, width: W, height: H, bitrate: vBitrate, framerate: fps, latencyMode: 'quality', ...(v.mux === 'avc' ? { avc: { format: 'avc' } } : {}) };
    if ((await VideoEncoder.isConfigSupported(cfg).catch(() => ({}))).supported) { vc = { cfg, mux: v.mux }; break; }
  }
  if (!vc) throw new Error('encodeur vidéo indisponible');
  let ac = null;
  if (withAudio) {
    for (const [codec, mux, sampleRate] of [['mp4a.40.2', 'aac', 48000], ['opus', 'opus', 48000]]) {
      const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: 192_000 };
      if ((await AudioEncoder.isConfigSupported(cfg).catch(() => ({}))).supported) { ac = { cfg, mux }; break; }
    }
    if (!ac) throw new Error('encodeur audio indisponible');
  }
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: vc.mux, width: W, height: H, frameRate: fps },
    ...(ac ? { audio: { codec: ac.mux, numberOfChannels: 2, sampleRate: ac.cfg.sampleRate } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let err = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { err = e; } });
  venc.configure(vc.cfg);
  const aenc = ac ? new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { err = e; } }) : null;
  aenc?.configure(ac.cfg);
  const gop = fps * 2;
  return {
    sampleRate: ac?.cfg.sampleRate || 48000,
    get error() { return err; },
    frame(canvas, k) {
      if (err) throw err;
      const f = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
      venc.encode(f, { keyFrame: k % gop === 0 });
      f.close();
    },
    // Attend que l'encodeur rattrape son retard (sinon la mémoire grimpe).
    async drain() { while (venc.encodeQueueSize > 4 && !err) await new Promise(r => setTimeout(r, 0)); if (err) throw err; },
    async audio(buffer) {
      if (!aenc) return;
      const n = buffer.length, rate = buffer.sampleRate, block = 1024;
      const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
      for (let i = 0; i < n; i += block) {
        const len = Math.min(block, n - i);
        const data = new Float32Array(len * 2);
        data.set(L.subarray(i, i + len), 0);
        data.set(R.subarray(i, i + len), len);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(i * 1e6 / rate), data });
        aenc.encode(ad);
        ad.close();
        if (aenc.encodeQueueSize > 50) await new Promise(r => setTimeout(r, 0));
      }
    },
    async finish() {
      await venc.flush();
      await aenc?.flush();
      if (err) throw err;
      venc.close(); aenc?.close();
      muxer.finalize();
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
    close() { if (venc.state !== 'closed') venc.close(); if (aenc && aenc.state !== 'closed') aenc.close(); },
  };
}
