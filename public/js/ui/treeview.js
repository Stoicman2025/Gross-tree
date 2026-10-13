// Отрисовка дерева: карточки (HTML) + линии (SVG), перемещение и масштаб
// мышью, колесом, пальцами (pinch) и кнопками.

import { h, icon } from './dom.js';
import { displayName, initials, lifeYears, yearOf, nameText } from '../util.js';
import { t } from '../i18n.js';

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
  const pending = p.state === 'pending';
  if (pending) cls.push('pending');
  const first = nameText(p.first_name || p.last_name) || t('Без имени');
  const second = p.first_name ? nameText(p.last_name) : '';
  // значок заметок — как примечание в Excel: видно, что про человека что-то написали
  const notes = card.ghost || !model.notes ? [] : model.notes(card.personId);
  const last = notes[notes.length - 1];
  return h('div', {
    class: cls.join(' '),
    'data-id': p.id,
    'data-ghost': card.ghost ? '1' : null,
    tabindex: card.ghost ? null : '0',
    role: 'button',
    'aria-label': displayName(p),
    title: [p.last_name, p.first_name, p.patronymic].filter(Boolean).map(nameText).join(' '),
    style: { left: card.x + 'px', top: card.y + 'px', width: card.w + 'px', height: card.h + 'px' },
  },
  pending && !card.ghost ? h('div', { class: 'pending-tag' }, t('на проверке')) : null,
  notes.length ? h('div', { class: 'note-badge', title: t('Заметок: {n}. Последняя: {text}', { n: notes.length, text: last.text.slice(0, 120) + (last.text.length > 120 ? '…' : '') }) },
    icon('message', 13), String(notes.length)) : null,
  h('div', { class: 'avatar' }, src ? h('img', { src, alt: '', loading: 'lazy', draggable: 'false' }) : initials(p)),
  h('div', { class: 'n1' }, first),
  second ? h('div', { class: 'n2' }, second) : null,
  card.ghost ? h('div', { class: 'ghost-tag' }, t('в другой ветке ↗')) : (years ? h('div', { class: 'years' }, years) : null));
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
      label: median ? t('{decade}-е', { decade: Math.floor(median / 10) * 10 }) : '',
      // в просвете над рядом, чтобы не наезжать на карточки
      labelY: row.y - Math.min(22, o.vGap / 3),
    };
  });
}

// Линия «на проверке», если неподтверждена сама связь или кто-то из её людей.
function linePending(model, l) {
  if (!model) return false;
  if (l.kind === 'partner') {
    const [a, b] = l.ids;
    const u = model.partners(a).find(x => x.id === b)?.union;
    return model.isPending(a) || model.isPending(b) || !!(u && u.pending);
  }
  return model.isPending(l.child) || l.parents.some(p => model.isPending(p) || model.isLinkPending(p, l.child));
}

export function renderLinksSvg(layout, model = null) {
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
    p.setAttribute('class', `link ${l.kind}${l.status === 'divorced' ? ' divorced' : ''}${linePending(model, l) ? ' pending' : ''}`);
    p._line = l;
    svg.append(p);
    paths.push(p);
  }
  return { svg, paths };
}

// Кнопки вокруг карточки: сверху родитель, снизу ребёнок, справа супруг(а),
// слева брат или сестра; в углу — быстрая заметка.
const ACTIONS = [
  { type: 'parent', side: 'top', label: () => t('Родитель') },
  { type: 'child', side: 'bottom', label: () => t('Ребёнок') },
  { type: 'partner', side: 'right', label: () => t('Супруг(а)') },
  { type: 'sibling', side: 'left', label: () => t('Брат, сестра') },
];

export class TreeView {
  constructor(viewport, world, { onSelect, onBackground, onAction, photoUrl, labels = null, actions = null }) {
    this.viewport = viewport;
    this.world = world;
    this.labelsEl = labels;
    this.actionsEl = actions;
    this.genRows = [];
    this.onSelect = onSelect;
    this.onBackground = onBackground;
    this.onAction = onAction;
    this.photoUrl = photoUrl;
    this.t = { x: 0, y: 0, k: 1 };
    this.layout = null;
    this.cards = new Map(); // personId -> primary element
    this.paths = [];
    this.hoverId = null;
    this.selectedId = null;
    this.actionsFor = null;
    this.lastPointer = 'mouse';
    this.#bind();
    this.#bindActions();
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
    const { svg, paths } = renderLinksSvg(layout, model);
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
    this.actionsFor = null;
    if (this.hoverId && !layout.index.has(this.hoverId)) this.hoverId = null;
    this.#apply();
  }

  setSelected(id) {
    this.selectedId = id;
    for (const el of this.cardEls || []) el.classList.toggle('selected', !!id && el.dataset.id === id && !el.dataset.ghost);
    this.#placeActions();
  }

  // Прямоугольник карточки в координатах сцены (для кнопок и окошка заметки).
  cardRect(personId) {
    const c = this.layout?.index.get(personId);
    if (!c) return null;
    const { x, y, k } = this.t;
    return { left: x + c.x * k, top: y + c.y * k, width: c.w * k, height: c.h * k };
  }

  #buildActions(id) {
    const el = this.actionsEl;
    el.replaceChildren();
    const twoParents = this.model.parents(id).length >= 2;
    for (const a of ACTIONS) {
      if (a.type === 'parent' && twoParents) continue;
      const label = a.label();
      const b = h('button', { class: `ca-btn ca-${a.side}`, type: 'button', 'data-type': a.type, 'aria-label': t('Добавить: {who}', { who: label }) },
        icon('plus', 14), h('span', null, label));
      el.append(b);
    }
    el.append(h('button', { class: 'ca-note', type: 'button', 'data-type': 'note', title: t('Быстрая заметка'), 'aria-label': t('Быстрая заметка') }, icon('message', 15)));
    this.actionsFor = id;
  }

  #placeActions(animate = false) {
    const el = this.actionsEl;
    if (!el) return;
    const id = this.hoverId || this.selectedId;
    const r = id && this.t.k >= 0.35 ? this.cardRect(id) : null;
    if (!r) { el.hidden = true; return; }
    if (this.actionsFor !== id || !el.childElementCount) this.#buildActions(id);
    el.hidden = false;
    el.classList.toggle('animating', animate);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const pos = {
      top: [cx, r.top], bottom: [cx, r.top + r.height], left: [r.left, cy], right: [r.left + r.width, cy],
    };
    for (const b of el.querySelectorAll('.ca-btn')) {
      const side = b.className.match(/ca-(top|bottom|left|right)/)[1];
      b.style.left = pos[side][0] + 'px';
      b.style.top = pos[side][1] + 'px';
    }
    const note = el.querySelector('.ca-note');
    note.style.left = r.left + 'px';
    note.style.top = r.top + 'px';
  }

  #bindActions() {
    const el = this.actionsEl;
    if (!el) return;
    el.hidden = true;
    el.addEventListener('pointerenter', () => clearTimeout(this._hoverT));
    el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.#hoverOut(); });
    el.addEventListener('click', e => {
      const b = e.target.closest('button[data-type]');
      if (!b || !this.actionsFor) return;
      this.onAction && this.onAction(b.dataset.type, this.actionsFor, this.cardRect(this.actionsFor));
    });
  }

  #hoverOut() {
    clearTimeout(this._hoverT);
    this._hoverT = setTimeout(() => { this.hoverId = null; this.#placeActions(); }, 260);
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
    this.#placeActions(animate);
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

  // Сдвинуть дерево, если карточка (с кнопками вокруг) у края экрана.
  ensureVisible(personId, margin = 70) {
    const r = this.cardRect(personId);
    if (!r) return;
    const { w, h } = this.size();
    const fits = r.left >= margin && r.top >= margin && r.left + r.width <= w - margin && r.top + r.height <= h - margin - 60;
    if (!fits) this.focusOn(personId, { k: this.t.k });
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

    // наведение мышью на карточку — показать кнопки вокруг неё
    vp.addEventListener('pointerover', e => {
      if (e.pointerType !== 'mouse' || pointers.size) return;
      const cardEl = e.target.closest('.card');
      if (!cardEl || cardEl.dataset.ghost) return;
      clearTimeout(this._hoverT);
      if (this.hoverId !== cardEl.dataset.id) { this.hoverId = cardEl.dataset.id; this.#placeActions(); }
    });
    vp.addEventListener('pointerout', e => {
      if (e.pointerType !== 'mouse') return;
      const cardEl = e.target.closest('.card');
      if (cardEl && !cardEl.contains(e.relatedTarget)) this.#hoverOut();
    });

    vp.addEventListener('pointerdown', e => {
      this.lastPointer = e.pointerType || 'mouse';
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
        if (cardEl.dataset.ghost) { this.focusOn(id); this.onSelect && this.onSelect(id); return; }
        // значок заметок — сразу окошко заметки
        if (e.target.closest('.note-badge')) { this.onAction && this.onAction('note', id, this.cardRect(id)); return; }
        // на телефоне первое касание выделяет карточку (и показывает кнопки), второе — открывает
        const touch = this.lastPointer !== 'mouse';
        this.onSelect && this.onSelect(id, { preview: touch && this.selectedId !== id });
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
