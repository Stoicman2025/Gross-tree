// Отрисовка дерева: карточки (HTML) + линии (SVG), перемещение и масштаб
// мышью, колесом, пальцами (pinch) и кнопками.

import { h } from './dom.js';
import { displayName, initials, lifeYears, yearOf } from '../util.js';

const MIN_K = 0.12, MAX_K = 2.2;

export function renderCard(model, card, { photoUrl, meId } = {}) {
  const p = model.get(card.personId);
  const ph = model.mainPhoto(card.personId);
  const src = ph ? photoUrl(ph.thumb_path || ph.path) : '';
  const years = lifeYears(p);
  const cls = ['card', `g-${p.gender || 'u'}`];
  if (card.ghost) cls.push('ghost');
  if (p.is_deceased || p.death_date) cls.push('deceased');
  if (meId && meId === p.id && !card.ghost) cls.push('me');
  const first = p.first_name || p.last_name || 'Без имени';
  const second = p.first_name ? p.last_name : '';
  return h('div', {
    class: cls.join(' '),
    'data-id': p.id,
    'data-ghost': card.ghost ? '1' : null,
    tabindex: card.ghost ? null : '0',
    role: 'button',
    'aria-label': displayName(p),
    title: [p.last_name, p.first_name, p.patronymic].filter(Boolean).join(' '),
    style: { left: card.x + 'px', top: card.y + 'px', width: card.w + 'px', height: card.h + 'px' },
  },
  h('div', { class: 'avatar' }, src ? h('img', { src, alt: '', loading: 'lazy', draggable: 'false' }) : initials(p)),
  h('div', { class: 'n1' }, first),
  second ? h('div', { class: 'n2' }, second) : null,
  card.ghost ? h('div', { class: 'ghost-tag' }, 'в другой ветке ↗') : (years ? h('div', { class: 'years' }, years) : null));
}

// Полосы поколений и подписи десятилетий («1950-е») по годам рождения в ряду.
export function generationRows(layout, model) {
  const o = layout.options;
  return (layout.rows || []).map((row, i) => {
    const years = row.ids.map(id => yearOf(model.get(id)?.birth_date)).filter(Boolean).sort((a, b) => a - b);
    const median = years.length ? years[Math.floor(years.length / 2)] : null;
    return {
      y: row.y,
      bandTop: row.y - o.vGap / 2,
      bandHeight: o.cardH + o.vGap,
      shaded: i % 2 === 0,
      label: median ? `${Math.floor(median / 10) * 10}-е` : '',
      // в просвете над рядом, чтобы не наезжать на карточки
      labelY: row.y - Math.min(22, o.vGap / 3),
    };
  });
}

export function renderLinksSvg(layout) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'tree-links');
  svg.setAttribute('width', layout.width);
  svg.setAttribute('height', layout.height);
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  const paths = [];
  // сначала линии детей, потом супружеские (поверх)
  const sorted = [...layout.lines].sort((a, b) => (a.kind === 'partner') - (b.kind === 'partner'));
  for (const l of sorted) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', l.d);
    p.setAttribute('class', `link ${l.kind}${l.status === 'divorced' ? ' divorced' : ''}`);
    p._line = l;
    svg.append(p);
    paths.push(p);
  }
  return { svg, paths };
}

export class TreeView {
  constructor(viewport, world, { onSelect, onBackground, photoUrl, labels = null }) {
    this.viewport = viewport;
    this.world = world;
    this.labelsEl = labels;
    this.genRows = [];
    this.onSelect = onSelect;
    this.onBackground = onBackground;
    this.photoUrl = photoUrl;
    this.t = { x: 0, y: 0, k: 1 };
    this.layout = null;
    this.cards = new Map(); // personId -> primary element
    this.paths = [];
    this.#bind();
  }

  render(layout, model, { meId } = {}) {
    this.layout = layout;
    this.model = model;
    this.world.replaceChildren();
    this.world.style.width = layout.width + 'px';
    this.world.style.height = layout.height + 'px';
    this.genRows = generationRows(layout, model);
    for (const g of this.genRows) {
      if (!g.shaded) continue;
      this.world.append(h('div', { class: 'gen-band', style: { top: g.bandTop + 'px', height: g.bandHeight + 'px' } }));
    }
    if (this.labelsEl) {
      this.labelsEl.replaceChildren(...this.genRows.map(g => {
        const el = h('div', { class: 'gen-label' }, g.label);
        g.el = el;
        return el;
      }));
    }
    const { svg, paths } = renderLinksSvg(layout);
    this.paths = paths;
    this.world.append(svg);
    this.cards = new Map();
    this.cardEls = [];
    const frag = document.createDocumentFragment();
    for (const c of layout.cards) {
      const el = renderCard(model, c, { photoUrl: this.photoUrl, meId });
      frag.append(el);
      this.cardEls.push(el);
      if (!c.ghost) this.cards.set(c.personId, el);
    }
    this.world.append(frag);
    this.#apply();
  }

  setSelected(id) {
    for (const el of this.cardEls || []) el.classList.toggle('selected', !!id && el.dataset.id === id && !el.dataset.ghost);
  }

  // set — множество id для подсветки (null — снять подсветку)
  setHighlight(set) {
    for (const el of this.cardEls || []) el.classList.toggle('dim', !!set && !set.has(el.dataset.id));
    for (const p of this.paths) {
      const l = p._line;
      let on = false;
      if (set) {
        if (l.kind === 'partner') on = l.ids.every(id => set.has(id));
        else on = set.has(l.child) && l.parents.some(id => set.has(id));
      }
      p.classList.toggle('hl', !!set && on);
      p.classList.toggle('dim', !!set && !on);
    }
  }

  // ---------- камера ----------
  #apply(animate = false) {
    this.world.classList.toggle('animating', animate);
    this.world.style.transform = `translate(${this.t.x}px, ${this.t.y}px) scale(${this.t.k})`;
    if (animate) {
      clearTimeout(this._animT);
      this._animT = setTimeout(() => this.world.classList.remove('animating'), 480);
    }
    this.#placeLabels(animate);
  }

  // подписи поколений прижаты к левому краю и едут вместе с рядами
  #placeLabels(animate) {
    if (!this.labelsEl || !this.genRows.length) return;
    const hgt = this.viewport.clientHeight;
    for (const g of this.genRows) {
      if (!g.el) continue;
      const y = this.t.y + g.labelY * this.t.k;
      g.el.style.transition = animate ? 'top .45s cubic-bezier(.2,.7,.2,1)' : 'none';
      g.el.style.top = y + 'px';
      g.el.hidden = !g.label || y < 12 || y > hgt - 12 || this.t.k < 0.25;
    }
  }

  size() {
    const r = this.viewport.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  fit(animate = true, maxK = 1) {
    if (!this.layout) return;
    const { w, h } = this.size();
    const pad = 40;
    const k = Math.max(MIN_K, Math.min(maxK, (w - pad * 2) / this.layout.width, (h - pad * 2) / this.layout.height));
    this.t = { k, x: (w - this.layout.width * k) / 2, y: Math.max(pad, (h - this.layout.height * k) / 2) };
    this.#apply(animate);
    return k;
  }

  // Показать верх дерева в читаемом масштабе: старшее поколение у верхнего края,
  // по горизонтали — по центру вокруг указанного человека.
  showTop(personId, k = 0.8) {
    const c = this.layout?.index.get(personId);
    if (!c) return false;
    const { w } = this.size();
    const minY = Math.min(...this.layout.cards.map(x => x.y));
    this.t = { k, x: w / 2 - (c.x + c.w / 2) * k, y: 36 - (minY - 40) * k };
    this.#apply(false);
    return true;
  }

  focusOn(personId, { k = null, animate = true, offsetX = 0 } = {}) {
    const c = this.layout?.index.get(personId);
    if (!c) return false;
    const { w, h } = this.size();
    const kk = k ?? Math.max(this.t.k, 0.75);
    this.t = { k: kk, x: (w - offsetX) / 2 - (c.x + c.w / 2) * kk, y: h / 2 - (c.y + c.h / 2) * kk };
    this.#apply(animate);
    return true;
  }

  zoomBy(factor, cx, cy, animate = false) {
    const { w, h } = this.size();
    if (cx === undefined) { cx = w / 2; cy = h / 2; }
    const k = Math.max(MIN_K, Math.min(MAX_K, this.t.k * factor));
    const f = k / this.t.k;
    this.t = { k, x: cx - (cx - this.t.x) * f, y: cy - (cy - this.t.y) * f };
    this.#apply(animate);
  }

  // ---------- ввод ----------
  #bind() {
    const vp = this.viewport;
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    this.moved = false;

    vp.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        this.moved = false;
        drag = { sx: e.clientX, sy: e.clientY, tx: this.t.x, ty: this.t.y };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.t.k, tx: this.t.x, ty: this.t.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        drag = null;
        this.moved = true;
        for (const id of pointers.keys()) { try { vp.setPointerCapture(id); } catch { /* ignore */ } }
      }
    });

    vp.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const rect = vp.getBoundingClientRect();
        const k = Math.max(MIN_K, Math.min(MAX_K, pinch.k * d / pinch.d));
        const mx = (a.x + b.x) / 2 - rect.left, my = (a.y + b.y) / 2 - rect.top;
        const pmx = pinch.mx - rect.left, pmy = pinch.my - rect.top;
        const f = k / pinch.k;
        this.t = { k, x: mx - (pmx - pinch.tx) * f, y: my - (pmy - pinch.ty) * f };
        this.#apply();
      } else if (drag) {
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!this.moved && Math.hypot(dx, dy) > 5) {
          this.moved = true;
          vp.classList.add('dragging');
          // захват — только когда начали тянуть, иначе клик по карточке не дойдёт до неё
          try { vp.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        }
        if (this.moved) {
          this.t.x = drag.tx + dx;
          this.t.y = drag.ty + dy;
          this.#apply();
        }
      }
    });

    const end = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {
        const [p] = [...pointers.values()];
        drag = { sx: p.x, sy: p.y, tx: this.t.x, ty: this.t.y };
      }
      if (!pointers.size) { drag = null; vp.classList.remove('dragging'); }
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);

    vp.addEventListener('click', e => {
      if (this.moved) return;
      const cardEl = e.target.closest('.card');
      if (cardEl) {
        const id = cardEl.dataset.id;
        if (cardEl.dataset.ghost) this.focusOn(id);
        this.onSelect && this.onSelect(id);
      } else {
        this.onBackground && this.onBackground();
      }
    });

    vp.addEventListener('keydown', e => {
      const cardEl = e.target.closest?.('.card');
      if (cardEl && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.onSelect && this.onSelect(cardEl.dataset.id);
      }
    });

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
  }
}
