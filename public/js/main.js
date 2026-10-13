// Точка входа: вход по семейному коду, загрузка дерева, связка интерфейса.

import { t, getLang, translateDom } from './i18n.js';
import { createBackend } from './backend.js';
import { buildModel } from './model.js';
import { layoutFamily, layoutHourglass } from './layout.js';
import { TreeView } from './ui/treeview.js';
import { h, icon, emblem, hydrateIcons, toast, popupMenu, confirmDialog, openModal, clear, langSwitcher } from './ui/dom.js';
import { renderDrawer, closeDrawer, addRelative } from './ui/drawer.js';
import { openQuickNote, openNoteForm, closeQuickNote } from './ui/quick-note.js';
import { openPersonForm } from './ui/person-form.js';
import { openAdminLogin, openAdminPanel } from './ui/admin.js';
import { openKinship } from './ui/kinship-ui.js';
import { openPrint } from './ui/print.js';
import { searchPeople, avatarEl, personSubline } from './ui/picker.js';
import { store, displayName, latinNames } from './util.js';

const $ = id => document.getElementById(id);

const app = {
  backend: null,
  model: null,
  layout: null,
  isAdmin: false,
  adminEmail: '',
  pending: 0,
  view: 'family',
  focusId: null,
  selectedId: null,
  meId: store.get('ft-me'),
  tree: null,

  photoUrl: path => app.backend.photoUrl(path),

  async refresh({ select, fit = false } = {}) {
    const r = await app.backend.getTree();
    if (!r.ok) {
      if (r.error === 'locked') { closeDrawer(); showLock(t('Семейный код изменился. Введите новый код.')); }
      else toast(t('Не удалось обновить дерево: {error}', { error: r.message || r.error }), 'err');
      return;
    }
    app.raw = r.data;
    app.model = buildModel(r.data);
    if (select !== undefined && select !== null) app.selectedId = select;
    if (app.selectedId && !app.model.get(app.selectedId)) app.selectedId = null;
    if (app.focusId && !app.model.get(app.focusId)) { app.focusId = null; app.view = 'family'; }
    render({ fit });
    if (select) app.select(select, { focus: true });
  },

  // preview — только выделить карточку и показать кнопки вокруг (первое касание на телефоне)
  select(id, { focus = false, preview = false } = {}) {
    app.selectedId = id;
    closeQuickNote();
    if (!id) {
      closeDrawer();
      app.tree.setSelected(null);
      app.tree.setHighlight(null);
      return;
    }
    if (focus && !app.layout.index.has(id)) {
      // человека нет в текущем виде — перестраиваем
      if (app.view === 'focus') { app.focusId = id; render(); }
      else { app.view = 'family'; render(); }
    }
    if (preview) {
      closeDrawer();
      app.tree.ensureVisible(id);
      if (!store.get('ft-tap-hint')) {
        store.set('ft-tap-hint', true);
        toast(t('Кнопки «+» вокруг карточки добавляют родственников. Нажмите на карточку ещё раз, чтобы открыть профиль.'), 'info', 7000);
      }
    } else {
      renderDrawer(app, id);
    }
    app.tree.setSelected(id);
    app.tree.setHighlight(highlightFor(id));
    if (focus) app.tree.focusOn(id, { offsetX: drawerOffset() });
  },

  // кнопки вокруг карточки
  cardAction(type, personId, rect) {
    if (type === 'note') {
      // на компьютере — окошко рядом с карточкой, на телефоне — обычное окно
      if (rect && window.matchMedia('(hover: hover) and (pointer: fine)').matches && window.innerWidth > 720) openQuickNote(app, personId, rect);
      else openNoteForm(app, personId, { fromTree: true });
      return;
    }
    addRelative(app, personId, type);
  },

  setView(view, focusId = null) {
    app.view = view;
    if (view === 'focus') {
      app.focusId = focusId || app.selectedId || app.meId || app.focusId || firstPersonId();
      if (!app.focusId) { app.view = 'family'; }
    }
    render();
    if (app.view === 'focus') {
      // вся линия целиком, если помещается в читаемом масштабе
      const k = app.tree.fit(true, 0.9);
      if (k < 0.45) app.tree.focusOn(app.focusId, { k: 0.7, offsetX: drawerOffset() });
    } else if (app.selectedId && app.layout.index.has(app.selectedId)) {
      app.tree.focusOn(app.selectedId, { k: 0.8, offsetX: drawerOffset() });
    } else app.tree.fit();
    if (app.selectedId) app.select(app.selectedId);
  },

  setMe(id) {
    app.meId = id;
    if (id) store.set('ft-me', id); else store.remove('ft-me');
    toast(id ? t('Запомнили: это вы. Теперь в профилях видно, кем вам приходится человек.') : t('Отметка «это я» снята'), 'ok');
    render();
    if (app.selectedId) app.select(app.selectedId);
  },

  openKinship(id) { openKinship(app, id); },

  showPath(path) {
    closeDrawer();
    app.selectedId = null;
    const missing = path.some(id => !app.layout.index.has(id));
    if (missing && app.view === 'focus') { app.view = 'family'; render(); }
    app.tree.setSelected(null);
    app.tree.setHighlight(new Set(path));
    const mid = path[Math.floor(path.length / 2)];
    app.tree.focusOn(mid, { k: 0.6 });
  },

  async onAdminChange() {
    const s = await app.backend.adminSession();
    app.isAdmin = !!s;
    app.adminEmail = s?.email || '';
    await app.updatePending();
    if (app.selectedId) renderDrawer(app, app.selectedId);
  },

  async updatePending() {
    app.pending = app.isAdmin ? await app.backend.pendingCount() : 0;
    const badge = $('pendingBadge');
    badge.hidden = !app.pending;
    badge.textContent = app.pending;
    $('btnAdmin').classList.toggle('btn-ghost', !app.isAdmin);
  },
};

function firstPersonId() {
  return app.model.people.keys().next().value || null;
}

function drawerOffset() {
  return window.innerWidth > 720 && $('drawer').classList.contains('open') ? 436 : 0;
}

// В режиме «предки и потомки» на экране и так только линия — подсветка не нужна.
function highlightFor(id) {
  return app.view === 'focus' ? null : lineage(id);
}

function lineage(id) {
  const set = new Set([id]);
  for (const x of app.model.ancestors(id)) set.add(x);
  for (const x of app.model.descendants(id)) set.add(x);
  for (const p of app.model.partners(id)) set.add(p.id);
  return set;
}

// ---------- отрисовка ----------
function render({ fit = false } = {}) {
  const model = app.model;
  document.title = model.title;
  $('treeTitle').textContent = model.title;
  $('lockTitle').textContent = model.title;

  const empty = $('empty');
  const isEmpty = model.people.size === 0;
  empty.hidden = !isEmpty;
  if (isEmpty) {
    clear(empty).append(h('div', { class: 'empty-card' },
      emblem(),
      h('h2', null, t('Дерево пока пустое')),
      h('p', null, app.isAdmin
        ? t('Добавьте первого человека — например, себя. Дальше можно добавлять родителей, детей и супругов прямо из профиля.')
        : t('Начните с себя: заполните анкету, укажите родителей, супруга и детей. Вы сразу появитесь в дереве, а после проверки администратором карточка станет обычной.')),
      h('button', { class: 'btn btn-primary btn-lg', onclick: () => openPersonForm(app) }, icon('plus'), t('Добавить себя')),
    ));
  }

  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('active', b.dataset.view === app.view));
  const chip = $('focusChip');
  if (app.view === 'focus' && app.focusId) {
    chip.hidden = false;
    chip.textContent = t('Линия: {name}', { name: displayName(model.get(app.focusId)) });
  } else chip.hidden = true;

  app.layout = app.view === 'focus' && app.focusId ? layoutHourglass(model, app.focusId) : layoutFamily(model);
  app.tree.render(app.layout, model, { meId: app.meId });
  if (app.selectedId) {
    app.tree.setSelected(app.selectedId);
    app.tree.setHighlight(highlightFor(app.selectedId));
  }
  if (fit) initialCamera();
}

// Стартовый вид: «я» в центре; иначе всё дерево, если оно помещается крупно,
// а большое дерево — с верха в читаемом масштабе (удобно старшему поколению).
function initialCamera() {
  if (app.meId && app.layout.index.has(app.meId)) {
    app.tree.focusOn(app.meId, { k: 0.95, animate: false });
    return;
  }
  const k = app.tree.fit(false, 1.05);
  if (k !== undefined && k < 0.78) {
    const minY = Math.min(...app.layout.cards.map(c => c.y));
    const top = app.layout.cards.filter(c => !c.ghost && c.y === minY);
    const anchor = top[Math.floor((top.length - 1) / 2)] || app.layout.cards[0];
    if (anchor) app.tree.showTop(anchor.personId, 0.85);
  }
}

// ---------- вход ----------
function showLock(message = '') {
  $('loader').hidden = true;
  $('shell').hidden = true;
  $('lock').hidden = false;
  $('lockError').textContent = message;
  $('lockDemo').hidden = app.backend.mode !== 'demo';
  const input = $('lockInput');
  input.value = '';
  setTimeout(() => input.focus(), 50);
}

async function forgetCode() {
  await app.backend.lock();
  app.isAdmin = false;
  await app.updatePending();
}

const NO_CONNECTION = () => t('Нет связи с сервером. Проверьте интернет или включите VPN и обновите страницу.');

// Ввод семейного кода: сервер запоминает этот браузер (cookie на 180 дней).
async function unlock(code) {
  const r = await app.backend.unlock(code);
  if (!r.ok) {
    if (r.error === 'bad_code') showLock(t('Неверный код. Попробуйте ещё раз.'));
    else showLock(r.message || NO_CONNECTION());
    return false;
  }
  return openTree();
}

async function openTree() {
  const r = await app.backend.getTree();
  if (!r.ok) {
    if (r.error === 'locked') showLock();
    else showLock(r.message || NO_CONNECTION());
    return false;
  }
  app.raw = r.data;
  app.model = buildModel(r.data);
  $('loader').hidden = true;
  $('lock').hidden = true;
  $('shell').hidden = false;
  render({ fit: true });
  return true;
}

// ---------- поиск ----------
function setupSearch() {
  const input = $('searchInput');
  const box = $('searchBox');
  let dd = null, items = [], active = -1;
  const close = () => { dd?.remove(); dd = null; active = -1; };
  const choose = i => {
    const p = items[i];
    if (!p) return;
    close();
    input.value = '';
    input.blur();
    app.select(p.id, { focus: true });
  };
  input.addEventListener('input', () => {
    close();
    const q = input.value.trim();
    if (!q) return;
    items = searchPeople(app.model, q, { limit: 10 });
    dd = h('div', { class: 'dropdown', role: 'listbox' });
    if (!items.length) dd.append(h('div', { class: 'dd-empty' }, t('Никого не нашли')));
    items.forEach((p, i) => {
      const el = h('div', { class: 'dd-item', role: 'option' }, avatarEl(app.model, p, app.photoUrl),
        h('div', { class: 't' }, h('div', { class: 'n' }, displayName(p)), h('div', { class: 'y' }, personSubline(p))));
      el.addEventListener('mousedown', e => { e.preventDefault(); choose(i); });
      dd.append(el);
    });
    box.append(dd);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); input.blur(); return; }
    if (!dd) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active >= 0 ? active : 0); return; }
    dd.querySelectorAll('.dd-item').forEach((el, i) => el.classList.toggle('active', i === active));
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.querySelector('.modal-backdrop')) {
      e.preventDefault();
      input.focus();
    }
  });
}

// ---------- справка ----------
function openHelp() {
  const item = (title, text) => h('p', null, h('b', null, title + ' '), text);
  openModal({
    title: t('Как пользоваться'),
    body: h('div', { class: 'bio' },
      item(t('Смотреть дерево.'), t('Перетаскивайте дерево мышью или пальцем, приближайте колёсиком или двумя пальцами. Нажмите на карточку, чтобы открыть профиль человека.')),
      item(t('Кнопки вокруг карточки.'), t('Наведите мышь на карточку (на телефоне — коснитесь её один раз): появятся кнопки «+ Родитель» сверху, «+ Ребёнок» снизу, «+ Супруг(а)» справа и «+ Брат, сестра» слева. Нажмите нужную — откроется анкета, уже связанная с этим человеком. Кнопка с облачком в углу — быстрая заметка. На телефоне второе касание по карточке открывает профиль.')),
      item(t('Добавить себя или родственника.'), t('Кнопка «Добавить» вверху или «Добавить родственника» в профиле. Укажите родителей, супруга и детей: выберите из дерева или впишите новое имя.')),
      item(t('Исправить ошибку.'), t('Откройте профиль и нажмите «Предложить правку». Можно добавить фото и истории.')),
      item(t('Проверка.'), t('Новые люди, связи, фото и заметки сразу появляются на дереве бледными, с пометкой «на проверке». К таким карточкам можно сразу добавлять родственников, а ошибки — исправлять кнопкой «Исправить». Когда администратор всё проверит, карточки станут обычными.')),
      item(t('Заметки и воспоминания.'), t('В профиле любого человека нажмите «Добавить заметку» — история, факт, воспоминание. Заметку видно всем сразу, с пометкой «на проверке».')),
      item(t('«Это я».'), t('Отметьте себя в своём профиле — тогда у каждого человека будет видно, кем он вам приходится, а кнопка ◎ быстро найдёт вас на дереве.')),
      item(t('Полупрозрачные карточки'), t('означают, что человек показан в другой ветке (например, у жены свои родители в дереве). Нажмите — дерево перейдёт к основной карточке.')),
      item(t('Язык.'), t('Кнопки RU, EN, DE в меню ☰ переключают язык сайта. Тексты, которые вписали родственники, не переводятся, а имена на английском и немецком показываются латиницей — это можно отключить в меню ☰.')),
      isStandalone() ? null : h('h3', { class: 'help-h' }, t('Иконка на экране телефона')),
      isStandalone() ? null : installSteps(),
    ),
  });
}

// ---------- установка на экран телефона ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast(t('Готово! Иконка «Семья» появилась на экране'), 'ok'); });

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function installSteps() {
  const steps = (title, items) => h('div', { class: 'install-block' },
    h('div', { class: 'install-title' }, title),
    h('ol', null, items.map(s => h('li', null, s))));
  const ios = steps(t('iPhone и iPad'), [
    t('Откройте сайт в Safari (на новых iPhone подойдёт и Chrome).'),
    t('Нажмите «Поделиться» — квадрат со стрелкой вверх, внизу или вверху экрана.'),
    t('Выберите «На экран «Домой»». Если пункта не видно — прокрутите список вниз.'),
    t('Нажмите «Добавить». При первом запуске с иконки введите семейный код ещё раз.'),
  ]);
  const android = steps('Android', [
    t('Откройте сайт в Chrome или Яндекс Браузере.'),
    t('Нажмите меню ⋮ — три точки в правом верхнем углу.'),
    t('Выберите «Установить приложение» или «Добавить на главный экран».'),
    t('Подтвердите — иконка «Семья» появится рядом с другими приложениями.'),
  ]);
  return h('div', null,
    isIOS() ? [ios, android] : [android, ios],
    h('p', { class: 'install-note' }, t('Иконка открывает тот же сайт, поэтому VPN по-прежнему нужен.')));
}

async function openInstall() {
  if (installPrompt) {
    // Android/Chrome: системное окно «Установить приложение»
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch { /* ignore */ }
    installPrompt = null;
    return;
  }
  openModal({ title: t('Иконка на экране телефона'), body: h('div', null,
    h('p', { class: 'intro' }, t('Поставьте дерево на экран телефона как приложение — открывать его можно будет одним нажатием, без поиска ссылки.')),
    installSteps()) });
}

// ---------- язык ----------
// Тексты страницы, подпись под иконкой на экране телефона и переключатели RU · EN · DE.
function setupLanguage() {
  translateDom();
  document.title = t(document.title);
  const lang = getLang();
  if (lang !== 'ru') {
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', t('Семья'));
    document.querySelector('link[rel="manifest"]')?.setAttribute('href', `manifest.${lang}.webmanifest`);
    $('lockDemo').replaceChildren(t('Демо-режим: данные хранятся только в этом браузере. Семейный код —') + ' ', h('b', null, 'демо'), '.');
    $('demoText').replaceChildren(h('b', null, t('Демо-режим.')), ' ' + t('Данные хранятся только в этом браузере. Пароль администратора —') + ' ', h('b', null, 'demo'), '.');
  }
  $('lock').prepend(langSwitcher('lang-lock'));
  $('btnMenu').before(langSwitcher('lang-top'));
}

// ---------- запуск ----------
async function start() {
  setupLanguage();
  hydrateIcons();
  try {
    app.backend = await createBackend();
  } catch (e) {
    console.error(e);
    clear($('loader')).append(h('div', { class: 'empty-card' },
      h('h2', null, t('Не удалось загрузиться')),
      h('p', null, t('Не получилось подключиться к серверу. Проверьте интернет или включите VPN и обновите страницу.')),
      h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, t('Обновить'))));
    return;
  }

  app.tree = new TreeView($('viewport'), $('world'), {
    labels: $('genLabels'),
    actions: $('cardActions'),
    photoUrl: app.photoUrl,
    onSelect: (id, opts) => app.select(id, opts),
    onBackground: () => app.select(null),
    onAction: (type, id, rect) => app.cardAction(type, id, rect),
  });

  if (app.backend.mode === 'demo') {
    $('demoBanner').hidden = false;
    $('shell').classList.add('has-banner');
    $('demoReset').addEventListener('click', async () => {
      if (await confirmDialog(t('Удалить все демо-данные в этом браузере и начать заново?'), { okText: t('Сбросить'), danger: true })) {
        await app.backend.reset();
        location.reload();
      }
    });
  }

  $('lockForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('lockBtn');
    btn.disabled = true;
    try { await unlock($('lockInput').value.trim()); } finally { btn.disabled = false; }
  });

  $('btnAdd').addEventListener('click', () => openPersonForm(app));
  $('btnKin').addEventListener('click', () => openKinship(app, app.selectedId));
  $('btnPrint').addEventListener('click', () => openPrint(app));
  $('btnAdmin').addEventListener('click', () => (app.isAdmin ? openAdminPanel(app) : openAdminLogin(app)));
  $('btnMenu').addEventListener('click', () => popupMenu($('btnMenu'), [
    { node: langSwitcher('lang-menu') },
    // на английском и немецком имена латиницей; можно вернуть кириллицу
    getLang() === 'ru' ? null : {
      label: latinNames() ? t('Показывать имена кириллицей') : t('Показывать имена латиницей'), icon: 'user',
      onClick: () => { store.set('ft-translit', !latinNames()); render(); if (app.selectedId) app.select(app.selectedId); },
    },
    '-',
    { label: t('Кем приходится'), icon: 'link', onClick: () => openKinship(app, app.selectedId) },
    { label: t('Печать и PDF'), icon: 'printer', onClick: () => openPrint(app) },
    app.isAdmin
      ? { label: t('Администрирование') + (app.pending ? ` (${app.pending})` : ''), icon: 'shield', onClick: () => openAdminPanel(app) }
      : { label: t('Вход для администратора'), icon: 'shield', onClick: () => openAdminLogin(app) },
    '-',
    isStandalone() ? null : { label: t('Иконка на экран телефона'), icon: 'download', onClick: openInstall },
    { label: t('Как пользоваться'), icon: 'info', onClick: openHelp },
    { label: t('Выйти на этом устройстве'), icon: 'logout', onClick: async () => { closeDrawer(); await forgetCode(); showLock(); } },
  ]));

  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => app.setView(b.dataset.view)));
  $('zoomIn').addEventListener('click', () => app.tree.zoomBy(1.25, undefined, undefined, true));
  $('zoomOut').addEventListener('click', () => app.tree.zoomBy(0.8, undefined, undefined, true));
  $('zoomFit').addEventListener('click', () => app.tree.fit());
  $('zoomMe').addEventListener('click', () => {
    if (app.meId && app.model.get(app.meId)) app.select(app.meId, { focus: true });
    else toast(t('Откройте свой профиль и нажмите «Это я» — тогда эта кнопка будет находить вас на дереве.'), 'info', 6000);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-backdrop, .lightbox, .menu') && app.selectedId) app.select(null);
  });
  setupSearch();

  // браузер уже запомнен (семейный код вводили раньше) или вошёл администратор
  await app.onAdminChange().catch(() => {});
  if (app.backend.session.unlocked || app.isAdmin) await openTree();
  else showLock();
}

start();
