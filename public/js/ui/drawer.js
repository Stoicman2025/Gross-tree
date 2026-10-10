// Профиль человека в боковой панели + просмотр фото.

import { h, icon, clear, popupMenu, confirmDialog, promptDialog, toast, openModal, withBusy } from './dom.js';
import { avatarEl, personPicker } from './picker.js';
import { openPersonForm, openPhotoForm } from './person-form.js';
import { relationship } from '../kinship.js';
import { displayName, fullName, formatDate, initials, lifeYears, ageText } from '../util.js';
import { openNoteForm } from './quick-note.js';

const STATUS_TEXT = { married: '', divorced: 'в разводе', widowed: 'вдовство', partner: 'гражданский брак' };

export function renderDrawer(app, personId) {
  const drawer = document.getElementById('drawer');
  const model = app.model;
  const p = model.get(personId);
  if (!p) { closeDrawer(); return; }

  const scroll = h('div', { class: 'drawer-scroll' });
  scroll.append(h('div', { class: 'drawer-head' },
    h('button', { class: 'btn btn-icon btn-ghost', 'aria-label': 'Закрыть', onclick: () => app.select(null) }, icon('x', 20))));

  // --- шапка ---
  const main = model.mainPhoto(personId);
  const photos = model.photos(personId);
  const photoBox = h('div', { class: `profile-photo ${main ? 'clickable' : ''} ${p.gender ? 'g-' + p.gender : ''}` },
    main ? h('img', { src: app.photoUrl(main.path), alt: displayName(p) }) : initials(p));
  if (main) photoBox.addEventListener('click', () => openLightbox(app, personId, photos.indexOf(main)));

  const dates = [];
  if (p.birth_date) dates.push(formatDate(p.birth_date, p.birth_approx));
  if (p.is_deceased || p.death_date) dates.push(p.death_date ? formatDate(p.death_date, p.death_approx) : '?');
  const age = ageText(p);
  const datesText = dates.length ? dates.join(' — ') + (age ? ` (${age})` : '') : '';

  const chips = h('div', { class: 'chips' });
  if (app.meId === personId) chips.append(h('span', { class: 'chip gold' }, icon('star', 14), 'Это вы'));
  else if (app.meId && model.get(app.meId)) {
    const rel = relationship(model, app.meId, personId);
    if (rel && rel.kind !== 'none') chips.append(h('span', { class: 'chip accent' }, `Вам: ${rel.text}`));
  }

  scroll.append(h('div', { class: 'profile-hero' },
    photoBox,
    h('h2', { class: 'profile-name' }, [p.last_name, p.first_name, p.patronymic].filter(Boolean).join(' ') || 'Без имени'),
    p.maiden_name && p.maiden_name !== p.last_name ? h('div', { class: 'profile-maiden' }, `урождённая ${p.maiden_name}`) : null,
    datesText ? h('div', { class: 'profile-dates' }, datesText) : null,
    chips.childElementCount ? chips : null,
  ));

  const pending = model.isPending(personId);
  if (pending) {
    scroll.append(h('div', { class: 'note-box', style: 'margin-top:16px' },
      h('div', null, h('span', { class: 'pending-mark' }, 'на проверке'), ' Карточка уже на дереве, но ещё не проверена администратором.'),
      p.added_by ? h('div', { class: 'small', style: 'margin-top:4px' }, `Добавил(а): ${p.added_by}`) : null,
      app.isAdmin ? null : h('div', { class: 'small', style: 'margin-top:4px' }, 'Ошибку можно исправить сразу — кнопка «Исправить».'),
      app.isAdmin && p.submission_id ? h('div', { class: 'row-actions', style: 'margin-top:10px' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: e => withBusy(e.currentTarget, async () => {
          try {
            await app.backend.approveSubmission(p.submission_id);
            toast('Заявка одобрена', 'ok');
            await app.updatePending();
            await app.refresh({ select: personId });
          } catch (err) { toast(err.message, 'err'); }
        }) }, icon('check', 16), 'Одобрить заявку'),
        h('span', { class: 'small muted' }, 'вместе со всем, что в ней прислали')) : null));
  }

  // --- действия ---
  const addRelBtn = h('button', { class: 'btn btn-sm' }, icon('userPlus', 16), 'Добавить родственника');
  addRelBtn.addEventListener('click', () => popupMenu(addRelBtn, [
    { label: 'Родителя', icon: 'user', onClick: () => addRelative(app, personId, 'parent') },
    { label: 'Супруга(у)', icon: 'users', onClick: () => addRelative(app, personId, 'partner') },
    { label: 'Ребёнка', icon: 'user', onClick: () => addRelative(app, personId, 'child') },
    { label: 'Брата или сестру', icon: 'users', onClick: () => addRelative(app, personId, 'sibling') },
  ]));
  scroll.append(h('div', { class: 'profile-actions' },
    h('button', { class: 'btn btn-sm btn-primary', onclick: () => openPersonForm(app, { personId }) },
      icon('edit', 16), app.isAdmin ? 'Редактировать' : pending ? 'Исправить' : 'Предложить правку'),
    addRelBtn,
    h('button', { class: 'btn btn-sm', onclick: () => app.setView('focus', personId) }, icon('hourglass', 16), 'Предки и потомки'),
    h('button', { class: 'btn btn-sm', onclick: () => app.openKinship(personId) }, icon('link', 16), 'Кем приходится'),
    h('button', { class: 'btn btn-sm btn-ghost', onclick: () => app.setMe(app.meId === personId ? null : personId) },
      icon('star', 16), app.meId === personId ? 'Это не я' : 'Это я'),
  ));

  // --- факты ---
  const facts = [];
  if (p.birth_date || p.birth_place) facts.push(['Рождение', [formatDate(p.birth_date, p.birth_approx), p.birth_place].filter(Boolean).join(', ')]);
  if (p.is_deceased || p.death_date || p.death_place) facts.push(['Смерть', [formatDate(p.death_date, p.death_approx), p.death_place].filter(Boolean).join(', ') || 'дата неизвестна']);
  if (p.occupation) facts.push(['Род занятий', p.occupation]);
  if (facts.length) {
    scroll.append(h('div', { class: 'section' }, h('h3', null, 'Сведения'),
      h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', { class: 'fact' }, h('dt', null, k), h('dd', null, v))))));
  }
  if (p.bio) scroll.append(h('div', { class: 'section' }, h('h3', null, 'О человеке'), h('div', { class: 'bio' }, p.bio)));

  // --- заметки и воспоминания ---
  const notes = model.notes(personId);
  const notesBox = h('div', { class: 'notes-list' });
  for (const n of notes) {
    notesBox.append(h('div', { class: `note ${n.pending ? 'pending' : ''}` },
      h('div', { class: 'note-text' }, n.text),
      h('div', { class: 'note-meta' },
        [n.author_name, formatDate(String(n.created_at || '').slice(0, 10))].filter(Boolean).join(' · '),
        n.pending ? h('span', { class: 'pending-mark' }, 'на проверке') : null),
      app.isAdmin ? h('button', { class: 'btn btn-icon btn-sm btn-ghost note-del', type: 'button', 'aria-label': 'Удалить заметку', title: 'Удалить заметку', onclick: async () => {
        if (!(await confirmDialog('Удалить эту заметку?', { danger: true, okText: 'Удалить' }))) return;
        try { await app.backend.deleteNote(n.id); toast('Заметка удалена', 'ok'); await app.refresh({ select: personId }); }
        catch (e) { toast(e.message, 'err'); }
      } }, icon('trash', 16)) : null));
  }
  scroll.append(h('div', { class: 'section' },
    h('h3', null, `Заметки и воспоминания${notes.length ? ' · ' + notes.length : ''}`),
    notes.length ? notesBox : h('p', { class: 'muted small', style: 'margin:0 0 10px' }, 'Расскажите, каким был человек, поделитесь историей или фактом.'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openNoteForm(app, personId) }, icon('edit', 16), 'Добавить заметку')));

  // --- фото ---
  const gallery = h('div', { class: 'gallery' });
  photos.forEach((ph, i) => {
    gallery.append(h('button', { type: 'button', class: ph.pending ? 'pending' : null, 'aria-label': ph.caption || 'Фото', onclick: () => openLightbox(app, personId, i) },
      h('img', { src: app.photoUrl(ph.thumb_path || ph.path), alt: ph.caption || '', loading: 'lazy' }),
      main && main.id === ph.id && photos.length > 1 ? h('span', { class: 'main-mark' }, '★ главное') : null));
  });
  gallery.append(h('button', { type: 'button', class: 'add-photo', onclick: () => openPhotoForm(app, personId) }, icon('camera', 22), 'Добавить'));
  scroll.append(h('div', { class: 'section' }, h('h3', null, `Фотографии${photos.length ? ' · ' + photos.length : ''}`), gallery));

  // --- семья ---
  const fam = h('div', { class: 'section' }, h('h3', null, 'Семья'));
  const group = (label, items) => {
    if (!items.length) return;
    fam.append(h('div', { class: 'rel-group' }, h('div', { class: 'rel-label' }, label),
      items.map(({ id, note, pend }) => {
        const r = model.get(id);
        const isPend = pend || model.isPending(id);
        return h('button', { class: 'rel-item', type: 'button', onclick: () => app.select(id, { focus: true }) },
          avatarEl(model, r, app.photoUrl),
          h('div', null, h('div', { class: 'n' }, displayName(r), isPend ? [' ', h('span', { class: 'pending-mark' }, 'на проверке')] : null),
            h('div', { class: 'y' }, [note, lifeYears(r)].filter(Boolean).join(' · '))));
      })));
  };
  group('Родители', model.parentLinks(personId).map(l => ({ id: l.id, note: l.kind === 'adopted' ? 'приёмный родитель' : '', pend: l.pending })));
  group('Супруги', model.partners(personId).map(({ id, union }) => ({ id, note: union.implicit ? 'общие дети' : STATUS_TEXT[union.status] || '', pend: union.pending })));
  group('Дети', model.children(personId).map(id => ({ id, pend: model.isLinkPending(personId, id) })));
  group('Братья и сёстры', model.siblings(personId).map(s => ({ id: s.id, note: s.half === 'father' ? 'по отцу' : s.half === 'mother' ? 'по матери' : '' })));
  if (fam.childElementCount > 1) scroll.append(fam);
  else scroll.append(h('div', { class: 'section' }, h('h3', null, 'Семья'), h('p', { class: 'muted small' }, 'Связи пока не указаны. Нажмите «Добавить родственника».')));

  // --- админ ---
  if (app.isAdmin) {
    scroll.append(h('div', { class: 'admin-zone' },
      h('button', { class: 'btn btn-sm', onclick: () => openMerge(app, personId) }, icon('users', 16), 'Объединить с дублем'),
      h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
        const ok = await confirmDialog(`Удалить «${fullName(p)}» из дерева вместе с фотографиями и связями? Это нельзя отменить.`, { danger: true, okText: 'Удалить' });
        if (!ok) return;
        try {
          await app.backend.deletePerson(personId);
          toast('Удалено', 'ok');
          app.select(null);
          await app.refresh();
        } catch (e) { toast(e.message, 'err'); }
      } }, icon('trash', 16), 'Удалить человека')));
  }

  clear(drawer).append(scroll);
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('shell').classList.add('drawer-open');
}

export function closeDrawer() {
  const drawer = document.getElementById('drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.getElementById('shell').classList.remove('drawer-open');
}

// ---------- объединение дублей (администратор) ----------
function openMerge(app, personId) {
  const p = app.model.get(personId);
  let into = null;
  const picker = personPicker({ model: app.model, photoUrl: app.photoUrl, allowNew: false, exclude: new Set([personId]), placeholder: 'Найдите второго человека', onChange: v => { into = v?.id || null; } });
  const body = h('div',
    h('p', { class: 'intro' }, `Если один и тот же человек попал в дерево дважды, объедините карточки. Все связи, фото и заметки «${displayName(p)}» перейдут ко второй карточке, а пустые поля в ней заполнятся данными этой. Сама эта карточка исчезнет.`),
    h('div', { class: 'field', style: 'margin-top:12px' }, h('label', null, 'Объединить с'), picker.el));
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена');
  const go = h('button', { class: 'btn btn-primary', type: 'button' }, 'Объединить');
  go.addEventListener('click', () => withBusy(go, async () => {
    if (!into) { toast('Выберите, с кем объединить', 'err'); return; }
    const target = app.model.get(into);
    if (!(await confirmDialog(`Перенести всё из «${fullName(p)}» в «${fullName(target)}» и удалить первую карточку?`, { okText: 'Объединить' }))) return;
    try {
      await app.backend.merge(personId, into);
      m.close();
      toast('Карточки объединены', 'ok');
      await app.refresh({ select: into });
    } catch (e) { toast(e.message, 'err'); }
  }));
  const m = openModal({ title: 'Объединить с дублем', body, footer: [cancel, go] });
}

// Пресеты для «Добавить родственника»
export function addRelative(app, personId, type) {
  const model = app.model;
  const p = model.get(personId);
  let preset;
  if (type === 'parent') {
    const existing = model.parents(personId);
    const otherParent = existing.length === 1 ? { id: existing[0] } : null;
    const needGender = existing.length === 1 ? (model.get(existing[0]).gender === 'm' ? 'f' : model.get(existing[0]).gender === 'f' ? 'm' : '') : '';
    preset = {
      person: { gender: needGender },
      relations: { add: [
        { type: 'child', ref: { id: personId }, otherParent },
        ...(otherParent ? [{ type: 'partner', ref: otherParent, status: 'married' }] : []),
      ] },
    };
  } else if (type === 'partner') {
    preset = { person: { gender: p.gender === 'm' ? 'f' : p.gender === 'f' ? 'm' : '' }, relations: { add: [{ type: 'partner', ref: { id: personId }, status: 'married' }] } };
  } else if (type === 'child') {
    const partners = model.partners(personId);
    const adds = [{ type: 'parent', ref: { id: personId } }];
    if (partners.length === 1) adds.push({ type: 'parent', ref: { id: partners[0].id } });
    preset = { person: { last_name: p.gender === 'm' ? p.last_name : '' }, relations: { add: adds } };
  } else if (type === 'sibling') {
    const parents = model.parents(personId);
    if (!parents.length) {
      toast('Чтобы добавить брата или сестру, сначала добавьте хотя бы одного родителя — кнопка «+ Родитель» над карточкой.', 'info', 7000);
      return;
    }
    preset = { relations: { add: parents.map(id => ({ type: 'parent', ref: { id } })) } };
  }
  openPersonForm(app, { preset });
}

// ---------- просмотр фото ----------
export function openLightbox(app, personId, index = 0) {
  const photos = app.model.photos(personId);
  if (!photos.length) return;
  let i = Math.max(0, Math.min(index, photos.length - 1));
  const img = h('img', { alt: '' });
  const cap = h('div', { class: 'cap' });
  const actions = h('div', { class: 'lb-actions' });
  const prev = h('button', { class: 'btn btn-icon lb-nav lb-prev', 'aria-label': 'Предыдущее' }, icon('left', 22));
  const next = h('button', { class: 'btn btn-icon lb-nav lb-next', 'aria-label': 'Следующее' }, icon('right', 22));
  const close = h('button', { class: 'btn btn-icon lb-close', 'aria-label': 'Закрыть' }, icon('x', 22));
  const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true' }, close, prev, img, cap, actions, next);

  function show() {
    const ph = photos[i];
    img.src = app.photoUrl(ph.path);
    cap.textContent = [ph.caption, photos.length > 1 ? `${i + 1} из ${photos.length}` : ''].filter(Boolean).join(' · ');
    prev.hidden = next.hidden = photos.length < 2;
    clear(actions);
    if (app.isAdmin) {
      const person = app.model.get(personId);
      if (person.main_photo_id !== ph.id && photos.length > 1) {
        actions.append(h('button', { class: 'btn btn-sm', onclick: async () => {
          await app.backend.updatePerson(personId, { main_photo_id: ph.id });
          toast('Главное фото изменено', 'ok'); done(); await app.refresh({ select: personId });
        } }, icon('star', 16), 'Сделать главным'));
      }
      actions.append(h('button', { class: 'btn btn-sm', onclick: async () => {
        const v = await promptDialog({ title: 'Подпись к фото', value: ph.caption || '', placeholder: 'Кто на фото, где, когда' });
        if (v === null) return;
        await app.backend.updatePhoto(ph.id, { caption: v.trim() });
        ph.caption = v.trim(); show();
        await app.refresh({ select: personId, keepLightbox: true });
      } }, icon('edit', 16), 'Подпись'));
      actions.append(h('button', { class: 'btn btn-sm', onclick: async () => {
        const ok = await confirmDialog('Удалить это фото?', { danger: true, okText: 'Удалить' });
        if (!ok) return;
        await app.backend.deletePhoto(ph);
        toast('Фото удалено', 'ok'); done(); await app.refresh({ select: personId });
      } }, icon('trash', 16), 'Удалить'));
    }
  }
  const onKey = e => {
    if (e.key === 'Escape') done();
    if (e.key === 'ArrowLeft') { i = (i - 1 + photos.length) % photos.length; show(); }
    if (e.key === 'ArrowRight') { i = (i + 1) % photos.length; show(); }
  };
  function done() { box.remove(); document.removeEventListener('keydown', onKey); }
  prev.addEventListener('click', () => { i = (i - 1 + photos.length) % photos.length; show(); });
  next.addEventListener('click', () => { i = (i + 1) % photos.length; show(); });
  close.addEventListener('click', done);
  box.addEventListener('click', e => { if (e.target === box) done(); });
  document.addEventListener('keydown', onKey);
  document.body.append(box);
  show();
}
