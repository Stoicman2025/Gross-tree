// Печать дерева и сохранение в PDF (через системный диалог печати).

import { h, openModal, toast, withBusy } from './dom.js';
import { renderCard, renderLinksSvg } from './treeview.js';
import { layoutFamily, layoutHourglass } from '../layout.js';
import { displayName } from '../util.js';
import { t } from '../i18n.js';

const PAPER = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] };
const MM = 96 / 25.4;
const MARGIN_MM = 8;

export function openPrint(app) {
  const paper = h('select', { class: 'select' }, Object.keys(PAPER).map(k => h('option', { value: k, selected: k === 'A3' }, k)));
  const orient = h('select', { class: 'select' },
    h('option', { value: 'auto' }, t('Автоматически')),
    h('option', { value: 'landscape' }, t('Альбомная')),
    h('option', { value: 'portrait' }, t('Книжная')));
  const what = h('select', { class: 'select' },
    h('option', { value: 'family' }, t('Вся семья')),
    app.view === 'focus' && app.focusId ? h('option', { value: 'focus', selected: true }, t('Предки и потомки: {name}', { name: displayName(app.model.get(app.focusId)) })) : null);
  const withTitle = h('input', { type: 'checkbox', checked: true });
  const info = h('div', { class: 'note-box', style: 'margin-top:14px' });

  const field = (label, c) => h('div', { class: 'field' }, h('label', null, label), c);
  const body = h('div',
    h('p', { class: 'intro' }, t('Дерево будет вписано в один лист. В окне печати выберите принтер или «Сохранить как PDF». Для большого дерева берите формат крупнее — A2/A1 можно распечатать в копицентре.')),
    h('div', { class: 'grid grid-3', style: 'margin-top:12px' }, field(t('Формат'), paper), field(t('Ориентация'), orient), field(t('Что печатать'), what)),
    h('label', { class: 'check', style: 'margin-top:12px' }, withTitle, t('Название дерева сверху')),
    info);

  const updateInfo = () => {
    const layout = what.value === 'focus' ? layoutHourglass(app.model, app.focusId) : layoutFamily(app.model);
    const { scale } = pageGeometry(layout, paper.value, orient.value, withTitle.checked);
    const pct = Math.round(scale * 100);
    info.textContent = t('Масштаб карточек: {pct}% от экранного.', { pct }) + (pct < 45 ? ' ' + t('Мелковато — попробуйте формат крупнее.') : '');
  };
  [paper, orient, what, withTitle].forEach(el => el.addEventListener('change', updateInfo));

  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('Отмена'));
  const go = h('button', { class: 'btn btn-primary', type: 'button' }, t('Печать / PDF'));
  go.addEventListener('click', () => withBusy(go, async () => {
    m.close();
    await printTree(app, { paper: paper.value, orient: orient.value, what: what.value, withTitle: withTitle.checked });
  }));
  const m = openModal({ title: t('Печать и PDF'), body, footer: [cancel, go] });
  updateInfo();
}

function pageGeometry(layout, paperKey, orient, withTitle) {
  let [w, hgt] = PAPER[paperKey];
  const landscape = orient === 'landscape' || (orient === 'auto' && layout.width >= layout.height);
  if (landscape) [w, hgt] = [hgt, w];
  const areaW = (w - MARGIN_MM * 2) * MM;
  const areaH = (hgt - MARGIN_MM * 2) * MM - (withTitle ? 56 : 0);
  const scale = Math.min(areaW / layout.width, areaH / layout.height, 1.2);
  return { w, h: hgt, areaW, areaH, scale, landscape };
}

async function printTree(app, { paper, orient, what, withTitle }) {
  const layout = what === 'focus' ? layoutHourglass(app.model, app.focusId) : layoutFamily(app.model);
  const g = pageGeometry(layout, paper, orient, withTitle);
  const root = document.getElementById('printRoot');
  root.replaceChildren();

  const tree = h('div', { class: 'print-tree', style: {
    width: layout.width + 'px', height: layout.height + 'px', transform: `scale(${g.scale})`,
    left: Math.max(0, (g.areaW - layout.width * g.scale) / 2) + 'px', top: (withTitle ? 56 : 0) + 'px',
  } });
  tree.append(renderLinksSvg(layout, app.model).svg);
  for (const c of layout.cards) tree.append(renderCard(app.model, c, { photoUrl: app.photoUrl, meId: null }));
  const page = h('div', { class: 'print-page', style: { width: g.areaW + 'px', height: (g.areaH + (withTitle ? 56 : 0)) + 'px' } },
    withTitle ? h('div', { class: 'print-title' }, app.model.title) : null,
    tree);
  root.append(page);

  const style = h('style', { id: 'printPageStyle' }, `@page { size: ${g.w}mm ${g.h}mm; margin: ${MARGIN_MM}mm; }`);
  document.head.append(style);

  // ждём загрузки фото, чтобы они попали на печать
  const imgs = [...root.querySelectorAll('img')];
  imgs.forEach(img => { img.loading = 'eager'; });
  await Promise.race([
    Promise.all(imgs.map(img => (img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })))),
    new Promise(r => setTimeout(r, 6000)),
  ]);

  const cleanup = () => { style.remove(); root.replaceChildren(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  try {
    window.print();
  } catch {
    toast(t('Не удалось открыть печать'), 'err');
    cleanup();
  }
}
