/* Accessibilité : noms lisibles pour les boutons-icônes et les curseurs, état des
   boutons à choix, zone d'import utilisable au clavier, annonces des messages.
   Appliqué à toute la page, y compris aux éléments créés ensuite (cartes, timeline…). */

const hasWords = s => /[\p{L}\p{N}]{2,}/u.test(s);

// Texte de l'étiquette la plus proche d'un champ (label englobant, .label voisin, <b> du titre).
function labelText(el) {
  const own = el.closest('label');
  if (own) {
    const t = [...own.childNodes].filter(n => n !== el && !n.contains?.(el)).map(n => n.textContent).join(' ').trim();
    if (hasWords(t)) return t.replace(/\s+/g, ' ');
  }
  const prev = el.previousElementSibling;
  if (prev && hasWords(prev.textContent) && !prev.matches('input, select, button, textarea')) return prev.textContent.trim().replace(/\s+/g, ' ');
  const field = el.closest('.field');
  const lab = field?.querySelector('.label');
  if (lab && hasWords(lab.textContent)) return lab.textContent.trim().replace(/\s+/g, ' ');
  return '';
}

function fix(root) {
  root.querySelectorAll('button:not([aria-label])').forEach(b => {
    if (hasWords(b.textContent)) return;
    const name = b.title || b.dataset.label;
    if (name) b.setAttribute('aria-label', name);
  });
  root.querySelectorAll('input:not([type=hidden]):not([type=file]):not([aria-label]), select:not([aria-label]), textarea:not([aria-label])').forEach(el => {
    if (el.id && document.querySelector(`label[for="${el.id}"]`)) return;
    const name = el.title || el.placeholder || labelText(el);
    if (name) el.setAttribute('aria-label', name);
  });
  // Boutons à choix (chips, formats, styles) : annoncés comme enfoncés ou non.
  root.querySelectorAll('button[data-v]').forEach(b => {
    const on = String(b.classList.contains('on'));
    if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
  });
  // Zones d'import (label + input file caché) : atteignables avec Tab, ouvertes avec Entrée ou Espace.
  root.querySelectorAll('label:has(> input[type=file][hidden])').forEach(l => {
    if (l.hasAttribute('tabindex')) return;
    l.tabIndex = 0;
    l.setAttribute('role', 'button');
    l.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      l.querySelector('input[type=file]').click();
    });
  });
}

export function initA11y() {
  const toasts = document.getElementById('toasts');
  toasts?.setAttribute('role', 'status');
  toasts?.setAttribute('aria-live', 'polite');
  const help = document.getElementById('help');
  help?.setAttribute('role', 'dialog');
  help?.setAttribute('aria-modal', 'true');
  help?.setAttribute('aria-label', 'Aide et raccourcis');
  fix(document);
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fix(document); });
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'title'] });
}
