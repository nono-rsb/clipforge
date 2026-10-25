// Garde l'analyse d'une vidéo (énergie, transcription, images) dans le navigateur (IndexedDB) :
// relancer la même vidéo avec les mêmes réglages ne refait pas tout le travail.
const DB = 'clipforge', STORE = 'analyses', KEEP = 16;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out.result);
    t.onerror = () => reject(t.error);
  });
}

export function cacheKey(file, S) {
  return [file.name, file.size, file.lastModified, S.transcribe ? `${S.lang}:${S.model}` : 'sans-asr', S.faces ? 'visages' : 'mouvement'].join('|');
}

export async function loadAnalysis(key) {
  try {
    const db = await open();
    const hit = await tx(db, 'readonly', s => s.get(key));
    db.close();
    return hit?.data || null;
  } catch { return null; }
}

// Clips retouchés (réglages, textes, découpes), rangés à côté de l'analyse de la même vidéo.
export async function loadClips(key) {
  const hit = await loadAnalysis(`${key}|clips`);
  return Array.isArray(hit) ? hit : null;
}
export function saveClips(key, clips) { return saveAnalysis(`${key}|clips`, clips); }

export async function saveAnalysis(key, data) {
  try {
    const db = await open();
    await tx(db, 'readwrite', s => s.put({ data, at: Date.now() }, key));
    // On ne garde que les dernières analyses pour ne pas remplir le disque.
    const all = await tx(db, 'readonly', s => s.getAllKeys());
    if (all.length > KEEP) {
      const dates = await Promise.all(all.map(k => tx(db, 'readonly', s => s.get(k)).then(v => [k, v?.at || 0])));
      dates.sort((a, b) => a[1] - b[1]).slice(0, all.length - KEEP).forEach(([k]) => tx(db, 'readwrite', s => s.delete(k)));
    }
    db.close();
  } catch (e) { console.warn('Cache indisponible', e); }
}
