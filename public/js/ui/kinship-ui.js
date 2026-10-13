// Окно «Кем приходится».

import { h, clear, openModal, icon } from './dom.js';
import { personPicker } from './picker.js';
import { relationship, describePath } from '../kinship.js';
import { displayName } from '../util.js';
import { t } from '../i18n.js';

export function openKinship(app, firstId = null) {
  const model = app.model;
  let aId = app.meId && model.get(app.meId) ? app.meId : null;
  let bId = firstId && firstId !== aId ? firstId : null;
  if (!aId && firstId) { aId = firstId; bId = null; }

  const result = h('div');
  const pickA = personPicker({ model, photoUrl: app.photoUrl, value: aId ? { id: aId } : null, allowNew: false, placeholder: t('Например, вы'), onChange: v => { aId = v?.id || null; update(); } });
  const pickB = personPicker({ model, photoUrl: app.photoUrl, value: bId ? { id: bId } : null, allowNew: false, placeholder: t('Другой человек'), onChange: v => { bId = v?.id || null; update(); } });
  const swap = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => {
    [aId, bId] = [bId, aId];
    pickA.value = aId ? { id: aId } : null;
    pickB.value = bId ? { id: bId } : null;
    update();
  } }, '⇅ ' + t('Поменять местами'));

  // «Иван — двоюродный брат для Петра»: имена и степень родства собираются по шаблону языка
  const sentence = (who, rel, whom, strong) => {
    const parts = t('{b} — {rel} для {a}', { b: '\u0001', rel: '\u0002', a: '\u0003' }).split(/(\u0001|\u0002|\u0003)/);
    return parts.map(s => s === '\u0001' ? (strong ? h('span', null, who) : who)
      : s === '\u0002' ? (strong ? h('b', null, rel) : rel)
      : s === '\u0003' ? (strong ? h('span', { class: 'muted' }, whom) : whom)
      : s).filter(x => x !== '');
  };

  function update() {
    clear(result);
    if (!aId || !bId) {
      result.append(h('div', { class: 'note-box', style: 'margin-top:18px' }, t('Выберите двух людей — покажу, кем они приходятся друг другу и через кого связаны.')));
      return;
    }
    const a = model.get(aId), b = model.get(bId);
    const rel = relationship(model, aId, bId);
    const back = relationship(model, bId, aId);
    const box = h('div', { class: 'kin-result' });
    if (rel.kind === 'none' || rel.kind === 'self') {
      box.append(h('div', { class: 'kin-main' }, rel.text[0].toUpperCase() + rel.text.slice(1)));
    } else {
      box.append(
        h('div', { class: 'kin-main' }, sentence(displayName(b), rel.text, displayName(a), true)),
        h('div', { class: 'kin-reverse' }, sentence(displayName(a), back.text, displayName(b), false).join('')),
      );
      if (rel.path.length > 1) {
        const steps = describePath(model, rel.path);
        box.append(h('div', { class: 'kin-path' },
          steps.map(s => s.id ? h('span', { class: 'p' }, s.name) : h('span', { class: 's' }, `→ ${s.label} →`))));
        box.append(h('div', { style: 'margin-top:14px' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { m.close(); app.showPath(rel.path); } }, icon('target', 16), t('Показать на дереве'))));
      }
    }
    result.append(box);
  }

  const body = h('div',
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'field' }, h('label', null, t('Для кого')), pickA.el),
      h('div', { class: 'field' }, h('label', null, t('Кем приходится')), pickB.el)),
    h('div', { style: 'margin-top:6px' }, swap),
    result);
  const m = openModal({ title: t('Кем приходится'), body });
  update();
}
