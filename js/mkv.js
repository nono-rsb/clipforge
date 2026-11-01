// Lecture des fichiers MKV / WebM (enregistrements OBS, téléchargements WebM) pour l'export
// et l'analyse rapides : pistes et liste des images avec leur position, sans décoder.
// Renvoie la même forme que la lecture des MP4 (voir fastexport.js).

const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, Info: 0x1549A966, TimecodeScale: 0x2AD7B1,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2,
  Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA, Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
  ContentEncodings: 0x6D80, Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1,
  ReferenceBlock: 0xFB,
};
// Éléments de premier niveau : ils terminent un Cluster de taille inconnue (fichiers OBS en cours d'écriture).
const TOP = new Set([ID.Cluster, ID.Info, ID.Tracks, 0x1C53BB6B, 0x1254C367, 0x114D9B74, 0x1043A770, 0x1941A469]);
const MASTER = new Set([ID.TrackEntry, ID.Video, ID.Audio, ID.BlockGroup]);

export async function isMatroska(file) {
  const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3;
}

// Lecture du fichier par fenêtres de 16 Mo : la plupart des accès sont synchrones.
function reader(file) {
  let start = 0, buf = new Uint8Array(0);
  return {
    size: file.size,
    async need(pos, n) {
      if (pos >= start && pos + n <= start + buf.length) return;
      start = pos;
      buf = new Uint8Array(await file.slice(pos, Math.min(file.size, pos + Math.max(n, 16 << 20))).arrayBuffer());
    },
    byte(pos) { return buf[pos - start]; },
    bytes(pos, n) { return buf.subarray(pos - start, pos - start + n); },
  };
}

// En-tête d'élément : identifiant, taille (-1 si inconnue) et longueur de l'en-tête.
async function head(R, pos) {
  await R.need(pos, 12);
  let b = R.byte(pos), len = 1;
  while (len <= 4 && !(b & (0x80 >> (len - 1)))) len++;
  if (len > 4) throw new Error('MKV illisible');
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + R.byte(pos + i);
  const sp = pos + len;
  b = R.byte(sp);
  let sl = 1;
  while (sl <= 8 && !(b & (0x80 >> (sl - 1)))) sl++;
  if (sl > 8) throw new Error('MKV illisible');
  let size = b & (0xFF >> sl), allOnes = size === (0xFF >> sl);
  for (let i = 1; i < sl; i++) { const x = R.byte(sp + i); size = size * 256 + x; allOnes &&= x === 0xFF; }
  return { id, size: allOnes ? -1 : size, hdr: len + sl };
}

const uint = d => d.reduce((a, x) => a * 256 + x, 0);
const float = d => d.length === 4 ? new DataView(d.buffer, d.byteOffset, 4).getFloat32(0) : new DataView(d.buffer, d.byteOffset, 8).getFloat64(0);
const text = d => new TextDecoder().decode(d).replace(/\0+$/, '');

// Lit les enfants d'un élément de taille connue et range les valeurs utiles dans `out`.
async function children(R, pos, end, out) {
  while (pos < end) {
    const e = await head(R, pos);
    const at = pos + e.hdr;
    if (MASTER.has(e.id)) {
      const sub = {};
      await children(R, at, at + e.size, sub);
      (out[e.id] ||= []).push(sub);
    } else if (e.size <= 1 << 20) {
      await R.need(at, e.size);
      out[e.id] = R.bytes(at, e.size).slice();
    }
    pos = at + e.size;
  }
}

function codecOf(t) {
  const id = text(t[ID.CodecID]), priv = t[ID.CodecPrivate];
  const hex = x => x.toString(16).padStart(2, '0');
  if (id === 'V_MPEG4/ISO/AVC' && priv?.length > 4) return { codec: `avc1.${hex(priv[1])}${hex(priv[2])}${hex(priv[3])}`, description: priv };
  if (id === 'V_VP8') return { codec: 'vp8' };
  if (id === 'V_VP9') return { codec: 'vp09.00.10.08' };
  if (id === 'A_AAC' && priv) return { codec: 'mp4a.40.2', description: priv };
  if (id === 'A_OPUS') return { codec: 'opus', ...(priv ? { description: priv } : {}) };
  return null;
}

export async function openMatroska(file) {
  const R = reader(file);
  const ebml = await head(R, 0);
  let pos = ebml.hdr + ebml.size;
  const seg = await head(R, pos);
  if (seg.id !== ID.Segment) throw new Error('MKV illisible');
  pos += seg.hdr;
  const end = seg.size < 0 ? file.size : Math.min(file.size, pos + seg.size);
  let scale = 1e6, tracks = [];
  const blocks = [];
  while (pos < end) {
    const e = await head(R, pos);
    const at = pos + e.hdr;
    if (e.id === ID.Info) {
      const o = {};
      await children(R, at, at + e.size, o);
      if (o[ID.TimecodeScale]) scale = uint(o[ID.TimecodeScale]);
    } else if (e.id === ID.Tracks) {
      const o = {};
      await children(R, at, at + e.size, o);
      tracks = o[ID.TrackEntry] || [];
      if (tracks.some(t => t[ID.ContentEncodings])) throw new Error('MKV compressé non pris en charge');
    } else if (e.id === ID.Cluster) {
      // Parcourt les blocs d'images du Cluster sans lire les images elles-mêmes.
      const cEnd = e.size < 0 ? end : at + e.size;
      let p = at, tc = 0;
      while (p < cEnd) {
        const c = await head(R, p);
        if (e.size < 0 && TOP.has(c.id)) break;
        const ca = p + c.hdr;
        if (c.id === ID.Timecode) { await R.need(ca, c.size); tc = uint(R.bytes(ca, c.size)); }
        else if (c.id === ID.SimpleBlock) blocks.push(await block(R, ca, c.size, tc, null));
        else if (c.id === ID.BlockGroup) {
          let q = ca, key = true, b = null;
          while (q < ca + c.size) {
            const g = await head(R, q);
            if (g.id === ID.Block) b = [q + g.hdr, g.size];
            if (g.id === ID.ReferenceBlock) key = false;
            q += g.hdr + g.size;
          }
          if (b) blocks.push(await block(R, b[0], b[1], tc, key));
        }
        if (c.size < 0) throw new Error('MKV illisible');
        p = ca + c.size;
      }
      pos = p;
      continue;
    }
    if (e.size < 0) throw new Error('MKV illisible');
    pos = at + e.size;
  }

  const ts = 1e9 / scale;
  const pick = type => tracks.find(t => t[ID.TrackType]?.[0] === type);
  const vt = pick(1), at = pick(2);
  if (!vt) throw new Error('pas de piste vidéo lisible');
  const listOf = t => {
    const n = uint(t[ID.TrackNumber]);
    const s = blocks.filter(b => b.track === n);
    s.forEach((b, i) => {
      b.timescale = ts;
      b.dts = b.cts;
      b.duration = Math.max(1, (s[i + 1]?.cts ?? b.cts + ts / 30) - b.cts);
    });
    // Images clés : drapeau du bloc, ou toutes les images pour le son.
    if (t === at) s.forEach(b => { b.is_sync = true; });
    return s;
  };
  const vc = codecOf(vt);
  if (!vc) throw new Error(`codec ${text(vt[ID.CodecID])} non pris en charge`);
  const v = vt[ID.Video][0];
  const video = { config: { ...vc, codedWidth: uint(v[ID.PixelWidth]), codedHeight: uint(v[ID.PixelHeight]) }, samples: listOf(vt), rotation: 0 };
  let audio = null;
  if (at) {
    const ac = codecOf(at), a = at[ID.Audio]?.[0] || {};
    const cfg = ac && { ...ac, sampleRate: Math.round(a[ID.SamplingFrequency] ? float(a[ID.SamplingFrequency]) : 48000), numberOfChannels: a[ID.Channels] ? uint(a[ID.Channels]) : 2 };
    if (cfg && window.AudioDecoder && (await AudioDecoder.isConfigSupported(cfg).catch(() => ({}))).supported) audio = { config: cfg, samples: listOf(at) };
  }
  return { video, audio, hasAudio: !!at };
}

// Bloc : numéro de piste, décalage de temps, drapeaux ; les images regroupées (« lacing ») ne sont pas gérées.
async function block(R, at, size, tc, key) {
  await R.need(at, 8);
  const b0 = R.byte(at);
  let len = 1;
  while (len <= 8 && !(b0 & (0x80 >> (len - 1)))) len++;
  let track = b0 & (0xFF >> len);
  for (let i = 1; i < len; i++) track = track * 256 + R.byte(at + i);
  const rel = (R.byte(at + len) << 8 | R.byte(at + len + 1)) << 16 >> 16;
  const flags = R.byte(at + len + 2);
  if (flags & 0x06) throw new Error('MKV avec images regroupées non pris en charge');
  return { track, cts: tc + rel, offset: at + len + 3, size: size - len - 3, is_sync: key ?? !!(flags & 0x80) };
}
