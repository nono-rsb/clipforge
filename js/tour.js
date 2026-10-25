// Visite guidée : met en lumière un élément de la page à la fois, avec une bulle d'explication.
const $ = s => document.querySelector(s);

export function startTour(steps, onEnd = () => {}) {
  steps = steps.filter(s => $(s.sel));
  if (!steps.length) return;
  let i = 0;
  const block = document.createElement('div');
  block.className = 'tour-block';
  const spot = document.createElement('div');
  spot.className = 'tour-spot';
  const tip = document.createElement('div');
  tip.className = 'tour-tip';
  tip.setAttribute('role', 'dialog');
  document.body.append(block, spot, tip);

  function place() {
    const el = $(steps[i].sel);
    if (!el) return;
    const r = el.getBoundingClientRect(), pad = 6, vw = innerWidth, vh = innerHeight;
    const top = Math.max(4, r.top - pad), bottom = Math.min(vh - 4, r.bottom + pad);
    Object.assign(spot.style, { left: `${Math.max(4, r.left - pad)}px`, top: `${top}px`, width: `${Math.min(vw - 8, r.width + pad * 2)}px`, height: `${Math.max(0, bottom - top)}px` });
    const tw = Math.min(380, vw - 24), th = tip.offsetHeight;
    tip.style.width = `${tw}px`;
    tip.style.left = `${Math.min(Math.max(12, r.left + r.width / 2 - tw / 2), vw - tw - 12)}px`;
    // Sous l'élément s'il y a la place, sinon au-dessus, sinon en bas de l'écran.
    let y = bottom + 12;
    if (y + th > vh - 12) y = top - th - 12;
    if (y < 12) y = vh - th - 12;
    tip.style.top = `${y}px`;
  }

  function show() {
    const s = steps[i];
    $(s.sel).scrollIntoView({ block: 'center', inline: 'nearest' });
    tip.innerHTML = `<small>${i + 1} / ${steps.length}</small><h4></h4><p></p>
      <div class="tour-btns"><button class="btn ghost sm" data-a="end">Passer</button><span></span>
      ${i ? '<button class="btn ghost sm" data-a="prev">←</button>' : ''}<button class="btn primary sm" data-a="next">${i === steps.length - 1 ? "C'est parti !" : 'Suivant →'}</button></div>`;
    tip.querySelector('h4').textContent = s.title;
    tip.querySelector('p').innerHTML = s.text;
    place();
    requestAnimationFrame(place);
    tip.querySelector('[data-a=next]').focus({ preventScroll: true });
  }

  function go(d) {
    i += d;
    if (i >= steps.length) end(); else show();
  }

  function end() {
    removeEventListener('resize', place);
    removeEventListener('scroll', place, true);
    removeEventListener('keydown', keys, true);
    block.remove(); spot.remove(); tip.remove();
    onEnd();
  }

  function keys(e) {
    // La visite garde le clavier : les raccourcis du montage ne se déclenchent pas pendant ce temps.
    e.stopImmediatePropagation();
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft' && i) go(-1);
  }

  tip.addEventListener('click', e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'next') go(1);
    else if (a === 'prev') go(-1);
    else if (a === 'end') end();
  });
  addEventListener('resize', place);
  addEventListener('scroll', place, true);
  addEventListener('keydown', keys, true);
  show();
}
