// Мини-библиотека интерфейса: создание элементов, иконки, окна, уведомления.

import { t, LANGS, getLang, setLang } from '../i18n.js';

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'type', 'placeholder', 'title', 'src', 'href', 'alt', 'name', 'id', 'multiple', 'accept', 'required', 'rows', 'min', 'max', 'step', 'download', 'htmlFor']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  // h('div', child, …) — без атрибутов: первый аргумент тоже содержимое
  if (props instanceof Node || Array.isArray(props) || typeof props === 'string' || typeof props === 'number') {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (PROP_KEYS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// ---------- иконки (линейные, в стиле Lucide) ----------
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  hourglass: '<path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.width = svg.style.height = size + 'px';
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

export function emblem() {
  const wrap = document.createElement('span');
  wrap.style.display = 'contents';
  // хвойный квадрат со скруглёнными углами и белым деревцем
  wrap.innerHTML = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect width="64" height="64" rx="18" fill="#1E5A48"/>
    <circle cx="32" cy="22" r="13" fill="#fff" opacity=".16"/>
    <circle cx="22.5" cy="24" r="3.6" fill="#DFEBE5"/>
    <circle cx="41.5" cy="24" r="3.6" fill="#DFEBE5"/>
    <circle cx="32" cy="15" r="3.6" fill="#DFEBE5"/>
    <path d="M32 52V28M32 36l-9.5-10M32 33l9.5-7.5M32 28V18" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    <path d="M24 52h16" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
  return wrap.firstElementChild;
}

// ---------- флаги и переключатель языка ----------
// Рисуем сами: на Windows эмодзи флагов не отображаются.
let flagSeq = 0;
const FLAGS = {
  ru: () => '<rect width="60" height="40" fill="#fff"/><rect y="13.33" width="60" height="13.34" fill="#0039A6"/><rect y="26.67" width="60" height="13.33" fill="#D52B1E"/>',
  de: () => '<rect width="60" height="13.34" fill="#000"/><rect y="13.33" width="60" height="13.34" fill="#DD0000"/><rect y="26.67" width="60" height="13.33" fill="#FFCE00"/>',
  en: () => {
    const id = 'ukf' + (++flagSeq);
    return `<clipPath id="${id}"><path d="M30 20h30v20zv20H0zH0V0zV0h30z"/></clipPath>
      <rect width="60" height="40" fill="#012169"/>
      <path d="M0 0l60 40M60 0L0 40" stroke="#fff" stroke-width="8"/>
      <path d="M0 0l60 40M60 0L0 40" clip-path="url(#${id})" stroke="#C8102E" stroke-width="4"/>
      <path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="12"/>
      <path d="M30 0v40M0 20h60" stroke="#C8102E" stroke-width="7"/>`;
  },
};

export function flag(code) {
  const wrap = document.createElement('span');
  wrap.className = 'flag';
  wrap.innerHTML = `<svg viewBox="0 0 60 40" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${FLAGS[code]()}</svg>`;
  return wrap;
}

// Три кнопки RU · EN · DE. Выбор запоминается в браузере, страница перезагружается.
export function langSwitcher(extraClass = '') {
  const cur = getLang();
  return h('div', { class: `lang-switch ${extraClass}`, role: 'group', 'aria-label': 'Language / Язык / Sprache' },
    LANGS.map(l => h('button', {
      type: 'button', class: l.code === cur ? 'active' : '', lang: l.code, title: l.name, 'aria-pressed': l.code === cur ? 'true' : 'false',
      onclick: () => setLang(l.code),
    }, flag(l.code), h('span', null, l.label))));
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    el.replaceWith(icon(el.dataset.icon));
  });
  root.querySelectorAll('[data-emblem]').forEach(el => {
    el.replaceChildren(emblem());
    if (el.tagName === 'SPAN') el.replaceWith(el.firstElementChild);
  });
}

// ---------- уведомления ----------
export function toast(message, type = 'info', ms = 4200) {
  const root = document.getElementById('toasts');
  const el = h('div', { class: `toast ${type === 'ok' ? 'ok' : type === 'err' ? 'err' : ''}`, role: 'status' }, message);
  root.append(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, ms);
  setTimeout(() => el.remove(), ms + 350);
}

// ---------- модальные окна ----------
const openModals = [];

export function openModal({ title, body, footer, size = 'md', onClose, dismissable = true }) {
  const root = document.getElementById('modalRoot');
  const closeBtn = h('button', { class: 'btn btn-icon btn-ghost', 'aria-label': t('Закрыть'), type: 'button' }, icon('x', 20));
  const modal = h('div', { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
    h('div', { class: 'modal-head' }, h('h2', null, title || ''), closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  let closed = false;
  const api = {
    el: modal,
    body: modal.querySelector('.modal-body'),
    close(result) {
      if (closed) return;
      closed = true;
      backdrop.remove();
      const i = openModals.indexOf(api);
      if (i >= 0) openModals.splice(i, 1);
      if (!openModals.length) document.removeEventListener('keydown', onKey);
      onClose && onClose(result);
    },
    setTitle(t) { modal.querySelector('.modal-head h2').textContent = t; },
    setFooter(nodes) {
      let foot = modal.querySelector('.modal-foot');
      if (!foot) { foot = h('div', { class: 'modal-foot' }); modal.append(foot); }
      clear(foot);
      append(foot, [nodes]);
    },
  };
  closeBtn.addEventListener('click', () => api.close());
  let downOnBackdrop = false;
  backdrop.addEventListener('mousedown', e => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', e => { if (dismissable && downOnBackdrop && e.target === backdrop) api.close(); });
  if (!openModals.length) document.addEventListener('keydown', onKey);
  openModals.push(api);
  root.append(backdrop);
  requestAnimationFrame(() => {
    const first = modal.querySelector('.modal-body input:not([type=hidden]):not([type=file]), .modal-body select, .modal-body textarea');
    if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
  });
  return api;
}

function onKey(e) {
  if (e.key === 'Escape' && openModals.length) {
    if (document.querySelector('.lightbox')) return;
    openModals[openModals.length - 1].close();
  }
}

export function confirmDialog(message, { title = t('Подтверждение'), okText = t('Да'), cancelText = t('Отмена'), danger = false } = {}) {
  return new Promise(resolve => {
    let result = false;
    const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => { result = true; m.close(); } }, okText);
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, cancelText);
    const m = openModal({ title, size: 'sm', body: h('p', { style: 'margin:0;white-space:pre-wrap' }, message), footer: [cancel, ok], onClose: () => resolve(result) });
    ok.focus();
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', okText = t('Сохранить'), multiline = false }) {
  return new Promise(resolve => {
    let result = null;
    const input = multiline
      ? h('textarea', { class: 'textarea', placeholder, value })
      : h('input', { class: 'input', placeholder, value });
    const ok = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { result = input.value; m.close(); } }, okText);
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('Отмена'));
    if (!multiline) input.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); });
    const m = openModal({ title, size: 'sm', body: h('div', { class: 'field' }, label ? h('label', null, label) : null, input), footer: [cancel, ok], onClose: () => resolve(result) });
  });
}

// ---------- всплывающее меню ----------
export function popupMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach(m => m.remove());
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('hr')); continue; }
    if (!it) continue;
    if (it.node) { menu.append(it.node); continue; }
    menu.append(h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); it.onClick(); } }, it.icon ? icon(it.icon) : null, it.label));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  const onDoc = e => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  const onEsc = e => { if (e.key === 'Escape') close(); };
  function close() {
    menu.remove();
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onEsc);
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onEsc);
  });
  return { close };
}

// ---------- скачивание файла, созданного на странице ----------
export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Кнопка с индикатором выполнения на время асинхронного действия
export async function withBusy(button, fn) {
  if (!button) return fn();
  const prev = button.disabled;
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '';
  button.append(h('span', { class: 'spinner', style: 'width:16px;height:16px;border-width:2px' }), ' ' + t('Подождите…'));
  try { return await fn(); } finally { button.disabled = prev; button.innerHTML = label; }
}
