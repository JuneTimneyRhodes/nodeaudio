// Keeps the top bar on one line at any width. Controls carry a priority (data-pri:
// higher = gives way first). When the bar overflows, the lowest-priority controls are
// moved — the real elements, listeners and all — into the ⋯ menu, and moved back when
// there is room again. Elements with data-drop are simply hidden instead (the meter).

export function fitTopbar(bar) {
  const more = bar.querySelector('#more');
  const menu = document.querySelector('#more-menu');
  const items = [...bar.querySelectorAll('[data-pri]')].sort((a, b) => b.dataset.pri - a.dataset.pri);
  const homes = new Map();
  for (const el of items) {
    const mark = document.createComment('slot:' + (el.id || el.className));
    el.before(mark);
    homes.set(el, mark);
  }

  const restore = () => {
    for (const el of items) {
      el.classList.remove('ovf-hidden');
      if (el.parentElement !== homes.get(el).parentElement || el.previousSibling !== homes.get(el)) homes.get(el).after(el);
    }
    menu.innerHTML = '';
  };

  const fits = () => bar.scrollWidth <= bar.clientWidth + 1;

  const fit = () => {
    restore();
    bar.classList.remove('crowded');
    more.hidden = true;
    if (fits()) return;
    bar.classList.add('crowded'); // tighter gaps, separators hidden
    if (fits()) return;
    more.hidden = false;
    const moved = [];
    for (const el of items) {
      if (fits()) break;
      if (el.hasAttribute('data-drop')) { el.classList.add('ovf-hidden'); continue; }
      moved.push(el);
      el.classList.add('ovf-hidden'); // take it out of the bar now so the next measure is right
    }
    if (!moved.length) { more.hidden = true; return; } // dropping decoration was enough
    // the menu lists controls in their bar order (left to right)
    moved.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    for (const el of moved) {
      const row = document.createElement('div');
      row.className = 'more-row';
      if (el.dataset.label) { const l = document.createElement('span'); l.textContent = el.dataset.label; row.appendChild(l); }
      el.classList.remove('ovf-hidden');
      row.appendChild(el);
      row.hidden = el.hidden; // e.g. Install, until the browser offers it (its observer re-fits)
      menu.appendChild(row);
    }
  };

  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    if (open) {
      const r = more.getBoundingClientRect();
      menu.style.top = r.bottom + 6 + 'px';
      menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
    }
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target) && e.target !== more) menu.classList.remove('open'); });
  // clicking a button in the menu runs it and closes the menu; selects stay open to pick
  menu.addEventListener('click', (e) => { if (e.target.closest('button')) menu.classList.remove('open'); });

  // a timer, not requestAnimationFrame: rAF is paused while the page is in the background,
  // and widths change then too (fonts and labels finishing loading)
  let timer = 0;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(fit, 30); };
  // watch the sections too: their contents change width after boot (labels, icons, fonts)
  // without the bar itself resizing. Fitting is synchronous, so this settles in one pass.
  const ro = new ResizeObserver(schedule);
  ro.observe(bar);
  for (const c of bar.children) ro.observe(c);
  // fonts change widths once loaded; hidden buttons (Install) can appear later
  document.fonts && document.fonts.ready.then(schedule);
  for (const el of bar.querySelectorAll('#install, #export-gd')) new MutationObserver(schedule).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  // safety net for width changes no observer reports (late font swaps, label updates):
  // re-fit whenever the bar is found overflowing. Cheap — one layout read.
  setInterval(() => { if (!fits()) schedule(); }, 500);
  window.addEventListener('load', schedule);
  fit();
  return fit;
}
