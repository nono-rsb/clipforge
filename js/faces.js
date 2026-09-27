// Détection de visages (MediaPipe BlazeFace) dans le navigateur.
// L'image est découpée en carrés qui se chevauchent : le modèle travaille en 128×128,
// donc un visage moyen dans une image 16:9 serait sinon trop petit pour être vu.

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const LANDMARK_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const TILE = 256;
const MOUTH = 192;

let detector = null;
let landmarker = null;
const mouth = document.createElement('canvas');
mouth.width = mouth.height = MOUTH;
const mouthCtx = mouth.getContext('2d');
const full = document.createElement('canvas');
const fullCtx = full.getContext('2d');
const tile = document.createElement('canvas');
tile.width = tile.height = TILE;
const tileCtx = tile.getContext('2d');

async function create(Task, files, options) {
  let err;
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await Task.createFromOptions(files, { ...options, baseOptions: { ...options.baseOptions, delegate } });
    } catch (e) { err = e; }
  }
  throw err;
}

export async function loadFaceDetector() {
  if (detector) return;
  const { FilesetResolver, FaceDetector, FaceLandmarker } = await import(`${MP}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
  detector = await create(FaceDetector, files, {
    baseOptions: { modelAssetPath: MODEL },
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.55,
  });
  // Optionnel : sert à savoir qui parle (ouverture de la mâchoire).
  try {
    landmarker = await create(FaceLandmarker, files, {
      baseOptions: { modelAssetPath: LANDMARK_MODEL },
      runningMode: 'IMAGE',
      numFaces: 1,
      outputFaceBlendshapes: true,
      // Le visage est déjà localisé : on accepte un détecteur interne moins strict.
      minFaceDetectionConfidence: 0.3,
      minFacePresenceConfidence: 0.3,
    });
  } catch (e) { console.warn('FaceLandmarker indisponible', e); }
}

// Petite vignette en niveaux de gris (moyenne retirée) d'une zone du visage.
// Sert de secours quand les repères du visage sont introuvables (visage flou, lointain…).
const PW = 24, PH = 12;
const patchC = document.createElement('canvas');
patchC.width = PW; patchC.height = PH;
const patchCtx = patchC.getContext('2d', { willReadFrequently: true });
function patch(f, fw, fh, y0, y1) {
  const w = f.w * fw * 0.6, h = f.h * fh * (y1 - y0);
  patchCtx.drawImage(full, f.x * fw - w / 2, (f.y + y0 * f.h) * fh, w, h, 0, 0, PW, PH);
  const d = patchCtx.getImageData(0, 0, PW, PH).data;
  const g = new Float32Array(PW * PH);
  let m = 0;
  for (let i = 0; i < g.length; i++) { g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765; m += g[i]; }
  m /= g.length;
  for (let i = 0; i < g.length; i++) g[i] -= m;
  return g;
}

// Ouverture de la bouche (0..1) d'un visage, mesurée sur un gros plan recadré.
function jawOpen(f, fw, fh) {
  const side = Math.max(f.w * fw, f.h * fh) * 1.8;
  mouthCtx.fillStyle = '#000';
  mouthCtx.fillRect(0, 0, MOUTH, MOUTH);
  mouthCtx.drawImage(full, f.x * fw - side / 2, f.y * fh - side / 2, side, side, 0, 0, MOUTH, MOUTH);
  try {
    const r = landmarker.detect(mouth);
    const cats = r.faceBlendshapes?.[0]?.categories;
    if (!cats) return null;
    return cats.find(c => c.categoryName === 'jawOpen')?.score ?? null;
  } catch { return null; }
}

// Carrés couvrant l'image le long de son grand côté (coordonnées normalisées 0..1).
function tiles(vw, vh) {
  const out = [{ x: 0, y: 0, w: 1, h: 1 }];
  const r = vw / vh;
  if (r > 1.2) {
    const n = Math.ceil(r) + 1, side = 1 / r;
    for (let i = 0; i < n; i++) out.push({ x: (1 - side) * i / (n - 1), y: 0, w: side, h: 1 });
  } else if (r < 0.83) {
    const n = Math.ceil(1 / r) + 1, side = r;
    for (let i = 0; i < n; i++) out.push({ x: 0, y: (1 - side) * i / (n - 1), w: 1, h: side });
  }
  return out;
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2));
  const iy = Math.max(0, Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

// Renvoie les visages de l'image courante : centre (x, y), taille (w, h), tout en 0..1.
// Avec { mouth: true }, ajoute `jaw` (ouverture de la bouche) aux 3 plus grands visages.
export function detectFaces(video, { mouth: withMouth = false } = {}) {
  if (!detector || !video.videoWidth) return [];
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = 720 / Math.max(vw, vh);
  const fw = Math.round(vw * k), fh = Math.round(vh * k);
  if (full.width !== fw || full.height !== fh) { full.width = fw; full.height = fh; }
  fullCtx.drawImage(video, 0, 0, fw, fh);

  const found = [];
  for (const t of tiles(vw, vh)) {
    const sw = t.w * fw, sh = t.h * fh;
    const s = TILE / Math.max(sw, sh);
    tileCtx.fillStyle = '#000';
    tileCtx.fillRect(0, 0, TILE, TILE);
    tileCtx.drawImage(full, t.x * fw, t.y * fh, sw, sh, 0, 0, sw * s, sh * s);
    let res;
    try { res = detector.detect(tile); } catch { continue; }
    for (const d of res.detections || []) {
      const b = d.boundingBox;
      const x = t.x + (b.originX + b.width / 2) / s / fw;
      const y = t.y + (b.originY + b.height / 2) / s / fh;
      const w = b.width / s / fw, h = b.height / s / fh;
      if (w < 0.015) continue;
      found.push({ x, y, w, h, score: d.categories?.[0]?.score ?? 0.5 });
    }
  }
  // Fusion des doublons trouvés dans plusieurs carrés.
  found.sort((a, b) => b.score - a.score);
  const faces = [];
  for (const f of found) if (faces.every(g => iou(f, g) < 0.3)) faces.push(f);
  if (withMouth) {
    [...faces].sort((a, b) => b.w - a.w).slice(0, 3).forEach(f => {
      f.jaw = landmarker ? jawOpen(f, fw, fh) : null;
      f.mouthPatch = patch(f, fw, fh, 0.1, 0.5);
      f.eyePatch = patch(f, fw, fh, -0.4, -0.05);
    });
  }
  return faces;
}
