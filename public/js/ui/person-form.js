// Анкета человека: добавление, правка, проверка заявки администратором.
//
// Родственник → изменения уходят заявкой на проверку.
// Администратор → изменения применяются сразу.

import { h, icon, clear, openModal, toast, withBusy } from './dom.js';
import { personPicker } from './picker.js';
import { applyChange } from '../apply.js';
import { processImage } from '../photos.js';
import { displayName, parseDate, makeDate, MONTHS_NOM, store, uid } from '../util.js';

const PERSON_FIELDS = ['last_name', 'first_name', 'patronymic', 'maiden_name', 'gender', 'birth_date', 'birth_approx',
  'birth_place', 'is_deceased', 'death_date', 'death_approx', 'death_place', 'occupation', 'bio'];

const EMPTY_PERSON = {
  first_name: '', patronymic: '', last_name: '', maiden_name: '', gender: '', birth_date: '', birth_approx: false,
  birth_place: '', is_deceased: false, death_date: '', death_approx: false, death_place: '', occupation: '', bio: '',
};

const STATUS_LABELS = { married: 'в браке', divorced: 'в разводе', widowed: 'вдовство', partner: 'гражданский брак' };

// ---------- состояние формы ----------
function baseState(model, personId) {
  const st = { person: { ...EMPTY_PERSON }, parents: [null, null], parentInit: [], partners: [], children: [], photos: [] };
  if (!personId) return st;
  const p = model.get(personId);
  for (const f of PERSON_FIELDS) st.person[f] = p[f] ?? EMPTY_PERSON[f];
  const ps = model.parents(personId);
  for (const pid of ps) {
    const g = model.get(pid)?.gender;
    const slot = g === 'f' ? 1 : g === 'm' ? 0 : (st.parents[0] ? 1 : 0);
    const free = st.parents[slot] ? 1 - slot : slot;
    if (!st.parents[free]) st.parents[free] = { id: pid };
  }
  // только те, кто попал в поля «Отец/Мать» (третьего родителя форма не трогает)
  st.parentInit = st.parents.filter(Boolean).map(x => x.id);
  st.partners = model.partners(personId).map(({ id, union }) => ({
    key: 'k' + uid().slice(0, 8), ref: { id }, status: union.status || 'married',
    initialId: id, initialStatus: union.status || 'married',
  }));
  st.children = model.children(personId).map(cid => {
    const other = model.parents(cid).find(x => x !== personId) || null;
    return { ref: { id: cid }, otherParent: other ? { id: other } : null, initialId: cid, initialOther: other };
  });
  return st;
}

// Накладывает payload (из заявки или пресета) на состояние формы.
function overlay(model, st, payload) {
  if (!payload) return st;
  Object.assign(st.person, payload.person || {});
  const rel = payload.relations || {};
  for (const r of rel.remove || []) {
    if (r.type === 'parent') st.parents = st.parents.map(x => (x && x.id === r.id ? null : x));
    if (r.type === 'partner') st.partners = st.partners.filter(x => x.ref.id !== r.id);
    if (r.type === 'child') st.children = st.children.filter(x => x.ref.id !== r.id);
  }
  for (const r of rel.update || []) {
    const pt = st.partners.find(x => x.ref.id === r.id);
    if (pt) pt.status = r.status;
  }
  for (const r of rel.add || []) {
    if (r.type === 'parent') {
      if (r.ref.id && st.parents.some(x => x && x.id === r.ref.id)) continue;
      const g = r.ref.id ? model.get(r.ref.id)?.gender : r.ref.new?.gender;
      let slot = g === 'f' ? 1 : 0;
      if (st.parents[slot]) slot = 1 - slot;
      if (!st.parents[slot]) st.parents[slot] = structuredClone(r.ref);
    } else if (r.type === 'partner') {
      if (r.ref.id && st.partners.some(x => x.ref.id === r.ref.id)) continue;
      st.partners.push({ key: r.key || 'k' + uid().slice(0, 8), ref: structuredClone(r.ref), status: r.status || 'married' });
    } else if (r.type === 'child') {
      const ex = r.ref.id && st.children.find(x => x.ref.id === r.ref.id);
      if (ex) { if (r.otherParent) ex.otherParent = structuredClone(r.otherParent); continue; }
      st.children.push({ ref: structuredClone(r.ref), otherParent: r.otherParent ? structuredClone(r.otherParent) : null });
    }
  }
  for (const ph of payload.photos || []) st.photos.push({ ...ph });
  return st;
}

// Собирает payload: для нового — всё, для правки — только отличия.
function buildPayload(model, personId, st) {
  const isEdit = !!personId;
  const person = {};
  const orig = isEdit ? model.get(personId) : EMPTY_PERSON;
  for (const f of PERSON_FIELDS) {
    const v = st.person[f];
    const o = orig[f] ?? EMPTY_PERSON[f];
    if (typeof v === 'boolean' ? v !== !!o : String(v ?? '').trim() !== String(o ?? '').trim()) person[f] = typeof v === 'string' ? v.trim() : v;
  }
  if (!st.person.is_deceased) {
    // «жив» — даты смерти не нужны
    delete person.death_date; delete person.death_place; delete person.death_approx;
    if (isEdit && orig.death_date) person.death_date = '';
    if (isEdit && orig.death_place) person.death_place = '';
    if (isEdit && orig.death_approx) person.death_approx = false;
  }

  const add = [], remove = [], update = [];
  const parentIds = st.parents.filter(x => x && x.id).map(x => x.id);
  for (const pid of st.parentInit) if (!parentIds.includes(pid)) remove.push({ type: 'parent', id: pid });
  for (const ref of st.parents) {
    if (!ref) continue;
    if (ref.id && st.parentInit.includes(ref.id)) continue;
    add.push({ type: 'parent', ref: structuredClone(ref) });
  }

  const partnerIds = st.partners.filter(x => x.ref && x.ref.id).map(x => x.ref.id);
  const initPartners = isEdit ? model.partners(personId).map(x => x.id) : [];
  for (const id of initPartners) if (!partnerIds.includes(id)) remove.push({ type: 'partner', id });
  for (const pt of st.partners) {
    if (!pt.ref) continue;
    if (pt.initialId && pt.ref.id === pt.initialId) {
      if (pt.status !== pt.initialStatus) update.push({ type: 'partner', id: pt.ref.id, status: pt.status });
      continue;
    }
    add.push({ type: 'partner', ref: structuredClone(pt.ref), status: pt.status, key: pt.key });
  }

  const childIds = st.children.filter(x => x.ref && x.ref.id).map(x => x.ref.id);
  const initChildren = isEdit ? model.children(personId) : [];
  for (const id of initChildren) if (!childIds.includes(id)) remove.push({ type: 'child', id });
  for (const ch of st.children) {
    if (!ch.ref) continue;
    const otherId = ch.otherParent?.id || null;
    if (ch.initialId && ch.ref.id === ch.initialId && (!ch.otherParent || (otherId && otherId === ch.initialOther))) continue;
    add.push({ type: 'child', ref: structuredClone(ch.ref), otherParent: ch.otherParent ? structuredClone(ch.otherParent) : null });
  }

  const photos = st.photos.map(p => ({ path: p.path, thumb_path: p.thumb_path, caption: p.caption || '' }));
  const changed = Object.keys(person).length || add.length || remove.length || update.length || photos.length;
  return { payload: { person, relations: { add, remove, update }, photos }, changed: !!changed };
}

// ---------- поле даты ----------
function dateInput(value) {
  const d = parseDate(value) || {};
  const day = h('input', { class: 'input', type: 'number', min: 1, max: 31, placeholder: 'День', value: d.d || '', 'aria-label': 'День' });
  const month = h('select', { class: 'select', 'aria-label': 'Месяц' },
    h('option', { value: '' }, 'Месяц'),
    MONTHS_NOM.map((m, i) => h('option', { value: i + 1, selected: d.m === i + 1 }, m)));
  const year = h('input', { class: 'input', type: 'number', min: 1000, max: 2100, placeholder: 'Год', value: d.y || '', 'aria-label': 'Год' });
  return {
    el: h('div', { class: 'date-row' }, day, month, year),
    get value() { return makeDate(year.value, month.value, day.value); },
    onChange(fn) { [day, month, year].forEach(x => x.addEventListener('change', fn)); },
  };
}

// ---------- загрузка фото ----------
function photoUploader(app, list, { onBusyChange } = {}) {
  const root = h('div', { class: 'photo-strip' });
  let busy = 0;
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    for (const file of files) {
      busy++; onBusyChange && onBusyChange(busy); render();
      try {
        const processed = await processImage(file);
        const uploaded = await app.backend.uploadPhoto(processed);
        list.push({ ...uploaded, caption: '', preview: URL.createObjectURL(processed.thumb) });
      } catch (e) {
        toast(e.message || 'Не удалось загрузить фото', 'err', 7000);
      } finally {
        busy--; onBusyChange && onBusyChange(busy); render();
      }
    }
  });
  function render() {
    clear(root);
    list.forEach((ph, i) => {
      const cap = h('input', { class: 'input', placeholder: 'Подпись', value: ph.caption || '' });
      cap.addEventListener('input', () => { ph.caption = cap.value; });
      root.append(h('div', { class: 'photo-thumb' },
        h('img', { src: ph.preview || app.photoUrl(ph.thumb_path || ph.path), alt: '' }),
        h('button', { class: 'rm', type: 'button', 'aria-label': 'Убрать фото', onclick: () => { list.splice(i, 1); render(); } }, icon('x', 14)),
        cap));
    });
    for (let i = 0; i < busy; i++) root.append(h('div', { class: 'photo-busy' }, h('div', { class: 'spinner' })));
    root.append(h('button', { class: 'photo-add', type: 'button', onclick: () => fileInput.click() }, icon('camera', 22), 'Добавить фото'));
    root.append(fileInput);
  }
  render();
  return { el: root, get busy() { return busy; } };
}

// ============================================================
// Основная форма
// ============================================================
export function openPersonForm(app, { personId = null, preset = null, submission = null } = {}) {
  const model = app.model;
  const isEdit = !!personId;
  const isReview = !!submission;
  const asAdmin = app.isAdmin;
  // Новые заявки уже лежат в базе «на проверке» (materialized): добавленные люди и связи
  // есть в дереве, поэтому в форму подмешиваем только то, что ещё не применено.
  const materialized = !!submission?.payload?.materialized;
  let extra = preset || submission?.payload;
  if (materialized) {
    const sp = submission.payload;
    extra = { person: sp.person || {}, relations: { add: [], remove: sp.relations?.remove || [], update: sp.relations?.update || [] }, photos: [] };
  }
  const st = overlay(model, baseState(model, personId), extra);
  const editedPerson = isEdit ? model.get(personId) : null;
  const editingPending = isEdit && model.isPending(personId);

  const title = isReview ? 'Проверка заявки'
    : isEdit ? (asAdmin ? `Редактирование` : editingPending ? 'Исправить' : `Предложить правку`)
    : 'Новый человек';

  const body = h('div');
  if (!asAdmin) {
    body.append(h('p', { class: 'intro' }, editingPending
      ? `Карточка «${displayName(editedPerson)}» ещё не проверена, поэтому исправления сохранятся сразу. Новые родственники появятся на дереве бледными карточками.`
      : isEdit
        ? `Исправьте или дополните данные о человеке «${displayName(editedPerson)}». Новые родственники и фото сразу появятся на дереве бледными, а изменения полей — после проверки администратором.`
        : 'Расскажите о себе или о родственнике. Заполните то, что знаете, остальное можно оставить пустым. Человек сразу появится на дереве бледной карточкой, а после проверки администратором — обычной.'));
  } else if (isReview) {
    body.append(h('p', { class: 'intro' }, `Заявка от ${submission.author_name || 'неизвестного автора'}. Исправьте, что нужно, и примите — изменения сразу появятся в дереве.`));
  }

  // --- основное ---
  const input = (key, attrs = {}) => {
    const el = h('input', { class: 'input', value: st.person[key] || '', ...attrs });
    el.addEventListener('input', () => { st.person[key] = el.value; });
    return el;
  };
  const textarea = (key, attrs = {}) => {
    const el = h('textarea', { class: 'textarea', value: st.person[key] || '', ...attrs });
    el.addEventListener('input', () => { st.person[key] = el.value; });
    return el;
  };
  const field = (label, control, hint) => h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null);

  const firstName = input('first_name', { placeholder: 'Иван', autocomplete: 'off' });
  const maidenField = field('Девичья фамилия', input('maiden_name', { placeholder: 'Фамилия при рождении' }), 'Если меняла фамилию при замужестве');
  const genderName = 'g' + uid().slice(0, 6);
  const genderPill = (value, label) => {
    const r = h('input', { type: 'radio', name: genderName, value, checked: st.person.gender === value });
    r.addEventListener('change', () => { st.person.gender = value; maidenField.hidden = value === 'm'; });
    return h('label', { class: 'radio-pill' }, r, h('span', null, label));
  };
  maidenField.hidden = st.person.gender === 'm';

  body.append(h('div', { class: 'form-section' },
    h('h3', null, 'Основное'),
    h('div', { class: 'grid grid-3' },
      field('Фамилия', input('last_name', { placeholder: 'Иванов', autocomplete: 'off' })),
      field('Имя *', firstName),
      field('Отчество', input('patronymic', { placeholder: 'Петрович', autocomplete: 'off' }))),
    h('div', { class: 'grid grid-2', style: 'margin-top:12px' },
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Пол'),
        h('div', { class: 'radio-row' }, genderPill('m', 'Мужской'), genderPill('f', 'Женский'))),
      maidenField),
  ));

  // --- даты ---
  const birth = dateInput(st.person.birth_date);
  birth.onChange(() => { st.person.birth_date = birth.value; });
  const birthApprox = h('input', { type: 'checkbox', checked: !!st.person.birth_approx });
  birthApprox.addEventListener('change', () => { st.person.birth_approx = birthApprox.checked; });
  const death = dateInput(st.person.death_date);
  death.onChange(() => { st.person.death_date = death.value; });
  const deathApprox = h('input', { type: 'checkbox', checked: !!st.person.death_approx });
  deathApprox.addEventListener('change', () => { st.person.death_approx = deathApprox.checked; });
  const deathBox = h('div', { class: 'grid grid-2', style: 'margin-top:12px' },
    h('div', { class: 'field' }, h('div', { class: 'label' }, 'Дата смерти'), death.el,
      h('label', { class: 'check' }, deathApprox, 'примерно')),
    field('Место смерти / захоронения', input('death_place', { placeholder: 'Город, кладбище' })));
  const deceased = h('input', { type: 'checkbox', checked: !!st.person.is_deceased });
  deathBox.hidden = !st.person.is_deceased;
  deceased.addEventListener('change', () => { st.person.is_deceased = deceased.checked; deathBox.hidden = !deceased.checked; });

  body.append(h('div', { class: 'form-section' },
    h('h3', null, 'Даты и места'),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Дата рождения'), birth.el,
        h('label', { class: 'check' }, birthApprox, 'примерно (точная дата неизвестна)')),
      field('Место рождения', input('birth_place', { placeholder: 'Город, область' }))),
    h('label', { class: 'check', style: 'margin-top:12px' }, deceased, 'Человека уже нет с нами'),
    deathBox,
  ));

  // --- о человеке ---
  body.append(h('div', { class: 'form-section' },
    h('h3', null, 'О человеке'),
    h('div', { class: 'grid' },
      field('Род занятий', input('occupation', { placeholder: 'Профессия, место работы' })),
      field('Биография, истории, воспоминания', textarea('bio', { rows: 4, placeholder: 'Где жил, чем запомнился, семейные истории…' }))),
  ));

  // --- фото ---
  let photosBusy = 0;
  const uploader = photoUploader(app, st.photos, { onBusyChange: n => { photosBusy = n; } });
  body.append(h('div', { class: 'form-section' },
    h('h3', null, 'Фотографии'),
    isEdit && model.photos(personId).length ? h('p', { class: 'intro' }, `Уже есть фото: ${model.photos(personId).length}. Новые добавятся к ним.`) : null,
    uploader.el,
  ));

  // --- семья ---
  const exclude = new Set(personId ? [personId] : []);
  const pickerOpts = { model, photoUrl: app.photoUrl, exclude };
  const fatherPicker = personPicker({ ...pickerOpts, value: st.parents[0], genderHint: 'm', placeholder: 'Имя отца', onChange: v => { st.parents[0] = v; } });
  const motherPicker = personPicker({ ...pickerOpts, value: st.parents[1], genderHint: 'f', placeholder: 'Имя матери', onChange: v => { st.parents[1] = v; } });

  const partnersBox = h('div', { class: 'rel-rows' });
  const childrenBox = h('div', { class: 'rel-rows' });

  function renderPartners() {
    clear(partnersBox);
    st.partners.forEach((pt, i) => {
      const pk = personPicker({ ...pickerOpts, value: pt.ref, placeholder: 'Имя супруга(и)', onChange: v => { pt.ref = v; renderChildren(); } });
      const status = h('select', { class: 'select', 'aria-label': 'Статус' },
        Object.entries(STATUS_LABELS).map(([v, l]) => h('option', { value: v, selected: pt.status === v }, l)));
      status.addEventListener('change', () => { pt.status = status.value; });
      partnersBox.append(h('div', { class: 'rel-row' },
        pk.el,
        h('button', { class: 'btn btn-icon btn-ghost', type: 'button', 'aria-label': 'Убрать', onclick: () => { st.partners.splice(i, 1); renderPartners(); renderChildren(); } }, icon('trash')),
        h('div', { class: 'sub-select' }, status)));
    });
  }

  function partnerOptions() {
    return st.partners.filter(pt => pt.ref).map(pt => {
      const name = pt.ref.id ? displayName(model.get(pt.ref.id)) : [pt.ref.new.first_name, pt.ref.new.last_name].filter(Boolean).join(' ') || 'новый человек';
      return { value: pt.ref.id ? 'id:' + pt.ref.id : 'key:' + pt.key, label: name, ref: pt.ref.id ? { id: pt.ref.id } : { key: pt.key } };
    });
  }

  function renderChildren() {
    clear(childrenBox);
    const opts = partnerOptions();
    st.children.forEach((ch, i) => {
      const pk = personPicker({ ...pickerOpts, value: ch.ref, placeholder: 'Имя ребёнка', onChange: v => { ch.ref = v; } });
      const cur = ch.otherParent ? (ch.otherParent.id ? 'id:' + ch.otherParent.id : 'key:' + ch.otherParent.key) : '';
      const sel = h('select', { class: 'select', 'aria-label': 'Второй родитель' },
        h('option', { value: '' }, 'Второй родитель: не указан'),
        opts.map(o => h('option', { value: o.value, selected: o.value === cur }, `Второй родитель: ${o.label}`)));
      if (cur && !opts.some(o => o.value === cur) && ch.otherParent?.id && model.get(ch.otherParent.id)) {
        sel.append(h('option', { value: cur, selected: true }, `Второй родитель: ${displayName(model.get(ch.otherParent.id))}`));
      }
      sel.addEventListener('change', () => {
        const o = opts.find(x => x.value === sel.value);
        ch.otherParent = o ? o.ref : (sel.value.startsWith('id:') ? { id: sel.value.slice(3) } : null);
      });
      childrenBox.append(h('div', { class: 'rel-row' },
        pk.el,
        h('button', { class: 'btn btn-icon btn-ghost', type: 'button', 'aria-label': 'Убрать', onclick: () => { st.children.splice(i, 1); renderChildren(); } }, icon('trash')),
        h('div', { class: 'sub-select' }, sel)));
    });
  }
  renderPartners();
  renderChildren();

  body.append(h('div', { class: 'form-section' },
    h('h3', null, 'Семья'),
    h('p', { class: 'intro' }, 'Выберите людей из дерева или впишите новое имя — для нового человека появится карточка.'),
    h('div', { class: 'grid grid-2' }, field('Отец', fatherPicker.el), field('Мать', motherPicker.el)),
    h('div', { class: 'field', style: 'margin-top:14px' }, h('div', { class: 'label' }, 'Супруги'), partnersBox,
      h('button', { class: 'add-link', type: 'button', onclick: () => { st.partners.push({ key: 'k' + uid().slice(0, 8), ref: null, status: 'married' }); renderPartners(); } }, icon('plus', 16), 'Добавить супруга(у)')),
    h('div', { class: 'field', style: 'margin-top:14px' }, h('div', { class: 'label' }, 'Дети'), childrenBox,
      h('button', { class: 'add-link', type: 'button', onclick: () => {
        const opts = partnerOptions();
        st.children.push({ ref: null, otherParent: opts.length === 1 ? opts[0].ref : null });
        renderChildren();
      } }, icon('plus', 16), 'Добавить ребёнка')),
  ));

  // --- автор (для родственников) ---
  let authorInput = null, commentInput = null;
  if (!asAdmin) {
    authorInput = h('input', { class: 'input', value: store.get('ft-author', ''), placeholder: 'Например, Анна Иванова' });
    commentInput = h('textarea', { class: 'textarea', rows: 2, placeholder: 'Например: «Это сестра бабушки, данные со слов мамы»' });
    body.append(h('div', { class: 'form-section' },
      h('h3', null, 'Для администратора'),
      h('div', { class: 'grid grid-2' }, field('Ваше имя *', authorInput), field('Комментарий', commentInput)),
    ));
  }

  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена');
  const save = h('button', { class: 'btn btn-primary', type: 'button' },
    asAdmin ? (isReview ? 'Принять с изменениями' : 'Сохранить') : editingPending ? 'Сохранить' : isEdit ? 'Отправить' : 'Добавить в дерево');
  save.addEventListener('click', () => withBusy(save, submit));

  const m = openModal({ title, body, footer: [cancel, save], size: 'lg', dismissable: false });

  async function submit() {
    if (!st.person.first_name.trim() && !st.person.last_name.trim()) {
      toast('Укажите хотя бы имя или фамилию', 'err');
      firstName.focus();
      return;
    }
    if (photosBusy > 0 || uploader.busy > 0) { toast('Подождите, фото ещё загружаются', 'err'); return; }
    if (!asAdmin && !authorInput.value.trim()) { toast('Укажите, пожалуйста, ваше имя', 'err'); authorInput.focus(); return; }

    const { payload, changed } = buildPayload(model, personId, st);
    if (isEdit && !changed && !isReview) { toast('Вы ничего не изменили'); return; }

    try {
      if (asAdmin) {
        const id = changed ? await applyChange(app.backend, model, { targetId: personId, payload }) : personId;
        if (isReview) {
          // правки администратора уже применены — заявке остаётся только одобрение
          if (materialized) await app.backend.approveSubmission(submission.id, { skipEdits: true });
          else await app.backend.reviewSubmission(submission.id, 'approved');
        }
        m.close();
        toast(isReview ? 'Заявка принята' : 'Сохранено', 'ok');
        await app.refresh({ select: id });
        if (isReview) {
          await app.updatePending();
          app.onSubmissionReviewed && app.onSubmissionReviewed();
        }
      } else {
        store.set('ft-author', authorInput.value.trim());
        const res = await app.backend.submit({
          kind: isEdit ? 'edit_person' : 'new_person',
          target: personId,
          payload,
          author: authorInput.value.trim(),
          comment: commentInput.value.trim(),
        });
        m.close();
        const shown = res.created?.main || personId;
        await app.refresh({ select: shown });
        if (!isEdit) showAdded(app, shown, st.person);
        else if (res.applied) toast('Исправления сохранены', 'ok');
        else toast('Спасибо! Новые родственники и фото уже на дереве, а изменения полей появятся после проверки.', 'ok', 7000);
      }
    } catch (e) {
      console.error(e);
      toast(e.message || 'Не удалось сохранить', 'err', 7000);
    }
  }
  return m;
}

// После добавления человека: сразу виден результат и можно продолжить.
function showAdded(app, personId, person) {
  const name = [person.first_name, person.last_name].filter(Boolean).join(' ') || 'Человек';
  const body = h('div',
    h('p', { style: 'margin:0 0 8px;font-size:17px' }, `«${name}» уже на дереве.`),
    h('p', { class: 'intro' }, 'Карточка пока бледная с пометкой «на проверке» — обычной она станет после проверки администратором. К ней уже можно добавлять родственников, фото и заметки.'));
  const close = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Готово');
  const more = h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); openPersonForm(app); } }, icon('plus', 16), 'Добавить ещё человека');
  const rel = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { m.close(); app.select(personId, { focus: true }); } }, icon('userPlus', 16), 'Открыть карточку');
  const m = openModal({ title: 'Готово!', body, footer: [close, more, rel], size: 'sm' });
}

// ---------- быстрое добавление фото ----------
export function openPhotoForm(app, personId) {
  const p = app.model.get(personId);
  const list = [];
  const uploader = photoUploader(app, list);
  const body = h('div',
    h('p', { class: 'intro' }, app.isAdmin
      ? `Фото сразу появятся в профиле «${displayName(p)}».`
      : `Фото для профиля «${displayName(p)}». Они сразу появятся в профиле с пометкой «на проверке», пока их не одобрит администратор.`),
    uploader.el);
  let authorInput = null;
  if (!app.isAdmin) {
    authorInput = h('input', { class: 'input', value: store.get('ft-author', ''), placeholder: 'Например, Анна Иванова' });
    body.append(h('div', { class: 'field', style: 'margin-top:16px' }, h('label', null, 'Ваше имя *'), authorInput));
  }
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Отмена');
  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Добавить фото');
  save.addEventListener('click', () => withBusy(save, async () => {
    if (uploader.busy) { toast('Подождите, фото ещё загружаются', 'err'); return; }
    if (!list.length) { toast('Выберите хотя бы одно фото', 'err'); return; }
    if (!app.isAdmin && !authorInput.value.trim()) { toast('Укажите, пожалуйста, ваше имя', 'err'); return; }
    const payload = { person: {}, relations: { add: [], remove: [], update: [] }, photos: list.map(x => ({ path: x.path, thumb_path: x.thumb_path, caption: x.caption || '' })) };
    try {
      if (app.isAdmin) {
        await applyChange(app.backend, app.model, { targetId: personId, payload });
        m.close();
        toast('Фото добавлены', 'ok');
        await app.refresh({ select: personId });
      } else {
        store.set('ft-author', authorInput.value.trim());
        await app.backend.submit({ kind: 'add_photo', target: personId, payload, author: authorInput.value.trim(), comment: '' });
        m.close();
        toast('Спасибо! Фото добавлены и ждут проверки.', 'ok', 6000);
        await app.refresh({ select: personId });
      }
    } catch (e) {
      toast(e.message || 'Не удалось сохранить', 'err', 7000);
    }
  }));
  const m = openModal({ title: 'Добавить фото', body, footer: [cancel, save], dismissable: false });
}

export { buildPayload, baseState, overlay, STATUS_LABELS };
