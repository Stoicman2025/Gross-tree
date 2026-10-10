// Точка входа: вход по семейному коду, загрузка дерева, связка интерфейса.

import { createBackend } from './backend.js';
import { buildModel } from './model.js';
import { layoutFamily, layoutHourglass } from './layout.js';
import { TreeView } from './ui/treeview.js';
import { h, icon, emblem, hydrateIcons, toast, popupMenu, confirmDialog, openModal, clear } from './ui/dom.js';
import { renderDrawer, closeDrawer } from './ui/drawer.js';
import { openPersonForm } from './ui/person-form.js';
import { openAdminLogin, openAdminPanel } from './ui/admin.js';
import { openKinship } from './ui/kinship-ui.js';
import { openPrint } from './ui/print.js';
import { searchPeople, avatarEl } from './ui/picker.js';
import { store, displayName, lifeYears } from './util.js';

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
      if (r.error === 'locked') { closeDrawer(); showLock('Семейный код изменился. Введите новый код.'); }
      else toast('Не удалось обновить дерево: ' + (r.message || r.error), 'err');
      return;
    }
    app.model = buildModel(r.data);
    if (select !== undefined && select !== null) app.selectedId = select;
    if (app.selectedId && !app.model.get(app.selectedId)) app.selectedId = null;
    if (app.focusId && !app.model.get(app.focusId)) { app.focusId = null; app.view = 'family'; }
    render({ fit });
    if (select) app.select(select, { focus: true });
  },

  select(id, { focus = false } = {}) {
    app.selectedId = id;
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
    renderDrawer(app, id);
    app.tree.setSelected(id);
    app.tree.setHighlight(highlightFor(id));
    if (focus) app.tree.focusOn(id, { offsetX: drawerOffset() });
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
    toast(id ? 'Запомнили: это вы. Теперь в профилях видно, кем вам приходится человек.' : 'Отметка «это я» снята', 'ok');
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
      h('h2', null, 'Дерево пока пустое'),
      h('p', null, app.isAdmin
        ? 'Добавьте первого человека — например, себя. Дальше можно добавлять родителей, детей и супругов прямо из профиля.'
        : 'Начните с себя: заполните анкету, укажите родителей, супруга и детей. После проверки администратором вы появитесь в дереве.'),
      h('button', { class: 'btn btn-primary btn-lg', onclick: () => openPersonForm(app) }, icon('plus'), 'Добавить себя'),
    ));
  }

  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('active', b.dataset.view === app.view));
  const chip = $('focusChip');
  if (app.view === 'focus' && app.focusId) {
    chip.hidden = false;
    chip.textContent = `Линия: ${displayName(model.get(app.focusId))}`;
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

// Ввод семейного кода: сервер запоминает этот браузер (cookie на 180 дней).
async function unlock(code) {
  const r = await app.backend.unlock(code);
  if (!r.ok) {
    if (r.error === 'bad_code') showLock('Неверный код. Попробуйте ещё раз.');
    else showLock(r.message || 'Нет связи с сервером. Проверьте интернет или включите VPN и обновите страницу.');
    return false;
  }
  return openTree();
}

async function openTree() {
  const r = await app.backend.getTree();
  if (!r.ok) {
    if (r.error === 'locked') showLock();
    else showLock(r.message || 'Нет связи с сервером. Проверьте интернет или включите VPN и обновите страницу.');
    return false;
  }
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
    if (!items.length) dd.append(h('div', { class: 'dd-empty' }, 'Никого не нашли'));
    items.forEach((p, i) => {
      const el = h('div', { class: 'dd-item', role: 'option' }, avatarEl(app.model, p, app.photoUrl),
        h('div', { class: 't' }, h('div', { class: 'n' }, displayName(p)), h('div', { class: 'y' }, [p.patronymic, lifeYears(p)].filter(Boolean).join(' · '))));
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
  openModal({
    title: 'Как пользоваться',
    body: h('div', { class: 'bio' },
      h('p', null, h('b', null, 'Смотреть дерево. '), 'Перетаскивайте дерево мышью или пальцем, приближайте колёсиком или двумя пальцами. Нажмите на карточку, чтобы открыть профиль человека.'),
      h('p', null, h('b', null, 'Добавить себя или родственника. '), 'Кнопка «Добавить» вверху или «Добавить родственника» в профиле. Укажите родителей, супруга и детей: выберите из дерева или впишите новое имя.'),
      h('p', null, h('b', null, 'Исправить ошибку. '), 'Откройте профиль и нажмите «Предложить правку». Можно добавить фото и истории.'),
      h('p', null, h('b', null, 'Проверка. '), 'Все изменения сначала смотрит администратор дерева. После одобрения они появятся у всех.'),
      h('p', null, h('b', null, '«Это я». '), 'Отметьте себя в своём профиле — тогда у каждого человека будет видно, кем он вам приходится, а кнопка ◎ быстро найдёт вас на дереве.'),
      h('p', null, h('b', null, 'Полупрозрачные карточки '), 'означают, что человек показан в другой ветке (например, у жены свои родители в дереве). Нажмите — дерево перейдёт к основной карточке.'),
      isStandalone() ? null : h('h3', { class: 'help-h' }, 'Иконка на экране телефона'),
      isStandalone() ? null : installSteps(),
    ),
  });
}

// ---------- установка на экран телефона ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Готово! Иконка «Семья» появилась на экране', 'ok'); });

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function installSteps() {
  const steps = (title, items) => h('div', { class: 'install-block' },
    h('div', { class: 'install-title' }, title),
    h('ol', null, items.map(t => h('li', null, t))));
  const ios = steps('iPhone и iPad', [
    'Откройте сайт в Safari (на новых iPhone подойдёт и Chrome).',
    'Нажмите «Поделиться» — квадрат со стрелкой вверх, внизу или вверху экрана.',
    'Выберите «На экран «Домой»». Если пункта не видно — прокрутите список вниз.',
    'Нажмите «Добавить». При первом запуске с иконки введите семейный код ещё раз.',
  ]);
  const android = steps('Android', [
    'Откройте сайт в Chrome или Яндекс Браузере.',
    'Нажмите меню ⋮ — три точки в правом верхнем углу.',
    'Выберите «Установить приложение» или «Добавить на главный экран».',
    'Подтвердите — иконка «Семья» появится рядом с другими приложениями.',
  ]);
  return h('div', null,
    isIOS() ? [ios, android] : [android, ios],
    h('p', { class: 'install-note' }, 'Иконка открывает тот же сайт, поэтому VPN по-прежнему нужен.'));
}

async function openInstall() {
  if (installPrompt) {
    // Android/Chrome: системное окно «Установить приложение»
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch { /* ignore */ }
    installPrompt = null;
    return;
  }
  openModal({ title: 'Иконка на экране телефона', body: h('div', null,
    h('p', { class: 'intro' }, 'Поставьте дерево на экран телефона как приложение — открывать его можно будет одним нажатием, без поиска ссылки.'),
    installSteps()) });
}

// ---------- запуск ----------
async function start() {
  hydrateIcons();
  try {
    app.backend = await createBackend();
  } catch (e) {
    console.error(e);
    clear($('loader')).append(h('div', { class: 'empty-card' },
      h('h2', null, 'Не удалось загрузиться'),
      h('p', null, 'Не получилось подключиться к серверу. Проверьте интернет или включите VPN и обновите страницу.'),
      h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Обновить')));
    return;
  }

  app.tree = new TreeView($('viewport'), $('world'), {
    labels: $('genLabels'),
    photoUrl: app.photoUrl,
    onSelect: id => app.select(id),
    onBackground: () => app.select(null),
  });

  if (app.backend.mode === 'demo') {
    $('demoBanner').hidden = false;
    $('shell').classList.add('has-banner');
    $('demoReset').addEventListener('click', async () => {
      if (await confirmDialog('Удалить все демо-данные в этом браузере и начать заново?', { okText: 'Сбросить', danger: true })) {
        app.backend.reset();
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
    { label: 'Кем приходится', icon: 'link', onClick: () => openKinship(app, app.selectedId) },
    { label: 'Печать и PDF', icon: 'printer', onClick: () => openPrint(app) },
    app.isAdmin
      ? { label: `Администрирование${app.pending ? ` (${app.pending})` : ''}`, icon: 'shield', onClick: () => openAdminPanel(app) }
      : { label: 'Вход для администратора', icon: 'shield', onClick: () => openAdminLogin(app) },
    '-',
    isStandalone() ? null : { label: 'Иконка на экран телефона', icon: 'download', onClick: openInstall },
    { label: 'Как пользоваться', icon: 'info', onClick: openHelp },
    { label: 'Выйти на этом устройстве', icon: 'logout', onClick: async () => { closeDrawer(); await forgetCode(); showLock(); } },
  ]));

  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => app.setView(b.dataset.view)));
  $('zoomIn').addEventListener('click', () => app.tree.zoomBy(1.25, undefined, undefined, true));
  $('zoomOut').addEventListener('click', () => app.tree.zoomBy(0.8, undefined, undefined, true));
  $('zoomFit').addEventListener('click', () => app.tree.fit());
  $('zoomMe').addEventListener('click', () => {
    if (app.meId && app.model.get(app.meId)) app.select(app.meId, { focus: true });
    else toast('Откройте свой профиль и нажмите «Это я» — тогда эта кнопка будет находить вас на дереве.', 'info', 6000);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, .lightbox, .menu') && app.selectedId) app.select(null);
  });
  setupSearch();

  // браузер уже запомнен (семейный код вводили раньше) или вошёл администратор
  await app.onAdminChange().catch(() => {});
  if (app.backend.session.unlocked || app.isAdmin) await openTree();
  else showLock();
}

start();
