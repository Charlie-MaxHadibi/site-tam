// Bottom sheet réutilisable : scrim partagé, glisser la poignée vers le bas pour fermer.
const scrim = document.getElementById('scrim');
let current = null;

function hideScrimIfIdle() {
  if (!current) { scrim.classList.remove('show'); setTimeout(() => { if (!current) scrim.hidden = true; }, 260); }
}

export function createSheet(el, { onClose } = {}) {
  const grab = el.querySelector('.sheet-grab');

  const api = {
    el,
    isOpen: () => current === api,
    open() {
      if (current && current !== api) current._snapHide();
      current = api;
      el.hidden = false;
      scrim.hidden = false;
      void el.offsetHeight;                       // reflow -> l'animation part de translateY(100%)
      requestAnimationFrame(() => { el.classList.add('show'); scrim.classList.add('show'); });
    },
    close() {
      if (current === api) current = null;
      el.classList.remove('show');
      el.style.transform = '';
      clearTimeout(api._t);
      api._t = setTimeout(() => { el.hidden = true; }, 320);
      hideScrimIfIdle();
      onClose?.();
    },
    _snapHide() {
      el.classList.remove('show');
      el.hidden = true;
    },
  };

  // --- glisser pour fermer ---
  let startY = 0, dy = 0, dragging = false;
  const down = (e) => {
    dragging = true; dy = 0;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    el.style.transition = 'none';
  };
  const move = (e) => {
    if (!dragging) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dy = Math.max(0, y - startY);
    el.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    el.style.transition = '';
    el.style.transform = '';
    if (dy > 80) api.close();
  };
  grab.addEventListener('touchstart', down, { passive: true });
  grab.addEventListener('touchmove', move, { passive: true });
  grab.addEventListener('touchend', up);
  grab.addEventListener('mousedown', down);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);

  return api;
}

scrim.addEventListener('click', () => current?.close());
