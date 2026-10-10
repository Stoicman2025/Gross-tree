// Заметки к карточке: быстрое окошко рядом с карточкой (как примечание в Excel)
// и обычное окно — для телефона и профиля.

import { h, icon, openModal, toast, withBusy } from './dom.js';
import { displayName, formatDate, store } from '../util.js';

export async function saveNote(app, personId, text, author) {
  store.set('ft-author', author);
  if (app.isAdmin) {
    await app.backend.addNote({ person_id: personId, text, author_name: author });
  } else {
    await app.backend.submit({ kind: 'add_note', target: personId, payload: { note: { text } }, author, comment: '' });
  }
}

// Последние заметки — коротко, чтобы было видно, что уже написали.
function recentNotes(app, personId, max = 3) {
  const notes = app.model.notes(personId);
  if (!notes.length) return null;
  const shown = notes.slice(-max);
  return h('div', { class: 'qn-list' },
    notes.length > max ? h('div', { class: 'qn-more' }, `ещё ${notes.length - max} — в профиле`) : null,
    shown.map(n => h('div', { class: `qn-item ${n.pending ? 'pending' : ''}` },
      h('div', { class: 'qn-text' }, n.text.length > 220 ? n.text.slice(0, 220) + '…' : n.text),
      h('div', { class: 'qn-meta' }, [n.author_name, formatDate(String(n.created_at || '').slice(0, 10)), n.pending ? 'на проверке' : ''].filter(Boolean).join(' · ')))));
}

// Поле «от кого»: если имя уже известно — просто подпись с возможностью сменить.
function authorField(app) {
  const known = store.get('ft-author', '');
  const input = h('input', { class: 'input qn-author', value: known, placeholder: 'Ваше имя', 'aria-label': 'Ваше имя' });
  if (!known || app.isAdmin) return { el: input, get value() { return input.value.trim(); }, focusIfEmpty() { if (!input.value.trim()) input.focus(); } };
  const wrap = h('div', { class: 'qn-from' });
  const showInput = () => { wrap.replaceChildren(input); input.focus(); };
  wrap.append('от ', h('b', null, known), ' ', h('button', { class: 'link-btn', type: 'button', onclick: showInput }, 'сменить'));
  return { el: wrap, get value() { return input.value.trim(); }, focusIfEmpty() {} };
}

let openPopover = null;
export function closeQuickNote() {
  if (openPopover) { openPopover.close(); openPopover = null; }
}

// anchor — прямоугольник карточки в координатах сцены (#stage)
export function openQuickNote(app, personId, anchor) {
  closeQuickNote();
  const stage = document.getElementById('stage');
  const p = app.model.get(personId);
  const text = h('textarea', { class: 'textarea qn-input', rows: 3, placeholder: 'История, факт, воспоминание…' });
  const author = authorField(app);
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Сохранить');
  const close = h('button', { class: 'btn btn-icon btn-ghost btn-sm', type: 'button', 'aria-label': 'Закрыть' }, icon('x', 16));
  const box = h('div', { class: 'quick-note', role: 'dialog', 'aria-label': `Заметка: ${displayName(p)}` },
    h('div', { class: 'qn-head' }, icon('message', 16), h('span', { class: 'qn-title' }, displayName(p)), close),
    recentNotes(app, personId),
    text,
    h('div', { class: 'qn-foot' }, author.el, save),
    app.isAdmin ? null : h('div', { class: 'qn-hint' }, 'Появится сразу, с пометкой «на проверке».'));
  stage.append(box);

  // справа от карточки, если помещается, иначе слева; по вертикали — в пределах сцены
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const bw = box.offsetWidth, bh = box.offsetHeight;
  let left = anchor.left + anchor.width + 14;
  if (left + bw > sw - 8) left = anchor.left - bw - 14;
  left = Math.max(8, Math.min(left, sw - bw - 8));
  const top = Math.max(8, Math.min(anchor.top, sh - bh - 8));
  box.style.left = left + 'px';
  box.style.top = top + 'px';
  setTimeout(() => text.focus(), 30);

  const onDoc = e => { if (!box.contains(e.target)) api.close(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); api.close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click();
  };
  const api = {
    close() {
      box.remove();
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      if (openPopover === api) openPopover = null;
    },
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  });
  close.addEventListener('click', () => api.close());
  save.addEventListener('click', () => withBusy(save, async () => {
    const t = text.value.trim();
    if (!t) { toast('Напишите текст заметки', 'err'); text.focus(); return; }
    const a = author.value;
    if (!app.isAdmin && !a) { toast('Укажите, пожалуйста, ваше имя', 'err'); author.focusIfEmpty(); return; }
    try {
      await saveNote(app, personId, t, a);
      api.close();
      toast(app.isAdmin ? 'Заметка добавлена' : 'Спасибо! Заметка добавлена и ждёт проверки.', 'ok');
      await app.refresh();
      if (app.isAdmin) await app.updatePending();
    } catch (e) { toast(e.message, 'err', 7000); }
  }));
  openPopover = api;
  return api;
}

// Обычное окно: на телефоне и из профиля.
export function openNoteForm(app, personId, { fromTree = false } = {}) {
  const p = app.model.get(personId);
  const text = h('textarea', { class: 'textarea', rows: 5, placeholder: 'Например: «Дедушка всю жизнь работал на железной дороге и знал наизусть расписание поездов…»' });
  const author = h('input', { class: 'input', value: store.get('ft-author', ''), placeholder: 'Например, Анна Иванова' });
  const list = recentNotes(app, personId);
  const body = h('div',
    h('p', { class: 'intro' }, app.isAdmin
      ? `Заметка сразу появится у «${displayName(p)}».`
      : `Заметка появится у «${displayName(p)}» сразу, с пометкой «на проверке», пока её не одобрит администратор.`),
    list ? h('div', { style: 'margin-top:12px' }, list) : null,
    h('div', { class: 'field', style: 'margin-top:12px' }, h('label', null, 'Новая заметка'), text),
    h('div', { class: 'field', style: 'margin-top:12px' }, h('label', null, app.isAdmin ? 'Подпись' : 'Ваше имя *'), author));
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена');
  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Добавить заметку');
  save.addEventListener('click', () => withBusy(save, async () => {
    const t = text.value.trim();
    if (!t) { toast('Напишите текст заметки', 'err'); text.focus(); return; }
    if (!app.isAdmin && !author.value.trim()) { toast('Укажите, пожалуйста, ваше имя', 'err'); author.focus(); return; }
    try {
      await saveNote(app, personId, t, author.value.trim());
      m.close();
      toast(app.isAdmin ? 'Заметка добавлена' : 'Спасибо! Заметка добавлена и ждёт проверки.', 'ok');
      await app.refresh(fromTree ? {} : { select: personId });
      if (app.isAdmin) await app.updatePending();
    } catch (e) { toast(e.message, 'err', 7000); }
  }));
  const m = openModal({ title: `Заметка · ${displayName(p)}`, body, footer: [cancel, save], dismissable: false });
}
