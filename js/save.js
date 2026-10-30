// Enregistrement des fichiers exportés.
// Sur téléphone (iPhone…), la feuille de partage permet « Enregistrer la vidéo » dans Photos ;
// ailleurs, c'est un téléchargement classique.
const touch = matchMedia('(pointer: coarse)').matches;
let toast = null;
export function setSaveToast(fn) { toast = fn; }

export function saveBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (!touch || !toast || !navigator.canShare?.({ files: [file] })) { download(blob, name); return; }
  // Le partage doit partir d'un toucher : l'export étant long, on propose un bouton.
  const t = toast(`✅ ${name} `, 'ok', 0);
  const b = document.createElement('button');
  b.className = 'btn primary sm';
  b.textContent = '📲 Enregistrer / partager';
  b.onclick = async () => {
    try { await navigator.share({ files: [file] }); t.remove(); }
    catch (e) { if (e.name !== 'AbortError') download(blob, name); }
  };
  const x = document.createElement('button');
  x.className = 'btn ghost sm icon';
  x.textContent = '✕';
  x.onclick = () => t.remove();
  t.append(b, x);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// Pendant une analyse ou un export : garde l'écran allumé (sinon le téléphone se met en veille
// et tout s'arrête) et demande confirmation si on ferme ou recharge la page.
let busy = 0;
addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

export async function keepAwake() {
  busy++;
  let lock = null, done = false;
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  return () => {
    if (done) return;
    done = true;
    busy--;
    lock?.release().catch(() => {});
  };
}

// Demande au navigateur de ne pas effacer les analyses et projets enregistrés quand la place
// manque (Safari sur iPhone vide sinon les données des sites peu ouverts).
export function keepData() {
  navigator.storage?.persisted?.().then(p => p || navigator.storage.persist()).catch(() => {});
}
