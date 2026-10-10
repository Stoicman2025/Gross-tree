// Администрирование: вход, проверка заявок, данные, настройки.

import { h, icon, clear, openModal, toast, withBusy, promptDialog, downloadFile, confirmDialog } from './dom.js';
import { openPersonForm, STATUS_LABELS } from './person-form.js';
import { applyChange } from '../apply.js';
import { exportGedcom, decodeGedcomBuffer, parseGedcom } from '../gedcom.js';
import { buildModel } from '../model.js';
import { displayName, formatDate, normalizeText, yearOf, lifeYears } from '../util.js';

// ---------- вход ----------
export function openAdminLogin(app) {
  // скрытое поле имени нужно менеджерам паролей, чтобы запомнить пароль
  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'admin', hidden: true });
  const password = h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'Пароль администратора', required: true });
  const err = h('p', { class: 'lock-error', style: 'text-align:left' });
  const go = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти');
  const form = h('form', null,
    h('p', { class: 'intro' }, app.backend.mode === 'demo'
      ? 'Демо-режим: пароль администратора — demo.'
      : 'Вход только для администратора дерева.'),
    user,
    h('div', { class: 'field', style: 'margin-top:12px' }, h('label', null, 'Пароль'), password),
    err,
    h('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px' }, go));
  form.addEventListener('submit', e => {
    e.preventDefault();
    withBusy(go, async () => {
      err.textContent = '';
      const r = await app.backend.signIn(password.value);
      if (!r.ok) { err.textContent = r.error; return; }
      m.close();
      await app.onAdminChange();
      toast('Вы вошли как администратор', 'ok');
      openAdminPanel(app);
    });
  });
  const m = openModal({ title: 'Вход администратора', body: form, size: 'sm' });
}

// ---------- панель ----------
export function openAdminPanel(app, tab = 'subs') {
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const content = h('div');
  const m = openModal({ title: 'Администрирование', body: h('div', null, tabs, content), size: 'lg' });

  const TABS = [
    ['subs', 'Заявки', 'users'],
    ['data', 'Данные', 'download'],
    ['settings', 'Настройки', 'shield'],
  ];
  function show(t) {
    tab = t;
    clear(tabs);
    for (const [key, label, ic] of TABS) {
      const b = h('button', { class: key === t ? 'active' : '', role: 'tab', onclick: () => show(key) }, icon(ic, 16), label);
      if (key === 'subs' && app.pending) b.append(h('span', { class: 'badge' }, app.pending));
      tabs.append(b);
    }
    clear(content);
    if (t === 'subs') renderSubmissions(app, content, () => show('subs'));
    if (t === 'data') renderData(app, content, m);
    if (t === 'settings') renderSettings(app, content, m);
  }
  // заявку можно принять и из формы «Изменить и принять» — тогда обновляем список
  app.onSubmissionReviewed = () => { if (document.body.contains(content) && tab === 'subs') show('subs'); };
  show(tab);
  return m;
}

// ---------- заявки ----------
const FIELD_LABELS = {
  last_name: 'Фамилия', first_name: 'Имя', patronymic: 'Отчество', maiden_name: 'Девичья фамилия', gender: 'Пол',
  birth_date: 'Дата рождения', birth_approx: 'Дата рождения примерная', birth_place: 'Место рождения',
  is_deceased: 'Умер(ла)', death_date: 'Дата смерти', death_approx: 'Дата смерти примерная', death_place: 'Место смерти',
  occupation: 'Род занятий', bio: 'Биография',
};

function fmtValue(key, v) {
  if (key === 'gender') return v === 'm' ? 'мужской' : v === 'f' ? 'женский' : '—';
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (key === 'birth_date' || key === 'death_date') return v ? formatDate(v) : '—';
  return v === '' || v === null || v === undefined ? '—' : String(v);
}

function refLabel(model, ref) {
  if (!ref) return '—';
  if (ref.id) return displayName(model.get(ref.id)) || '(удалён)';
  const n = ref.new || {};
  return [n.first_name, n.patronymic, n.last_name].filter(Boolean).join(' ') || 'без имени';
}

function similarPeople(model, np, excludeId = null) {
  const f = normalizeText(np.first_name), l = normalizeText(np.last_name);
  if (!f) return [];
  const y = yearOf(np.birth_date);
  return [...model.people.values()].filter(p => {
    if (p.id === excludeId) return false;
    if (normalizeText(p.first_name) !== f) return false;
    if (l && normalizeText(p.last_name) !== l && normalizeText(p.maiden_name) !== l) return false;
    const py = yearOf(p.birth_date);
    if (y && py && Math.abs(y - py) > 2) return false;
    return true;
  });
}

async function renderSubmissions(app, root, rerender) {
  let status = root.dataset.status || 'pending';
  const sub = h('div', { class: 'subtabs' });
  const list = h('div');
  root.append(sub, list);
  const btn = (s, label) => h('button', { class: `btn btn-sm ${s === status ? 'btn-primary' : ''}`, onclick: () => { root.dataset.status = s; status = s; load(); paint(); } }, label);
  function paint() { clear(sub).append(btn('pending', 'Ожидают проверки'), btn('approved', 'Принятые'), btn('rejected', 'Отклонённые')); }
  paint();

  async function load() {
    clear(list).append(h('div', { class: 'muted' }, 'Загрузка…'));
    try {
      const items = await app.backend.listSubmissions(status);
      clear(list);
      if (!items.length) {
        list.append(h('div', { class: 'note-box' }, status === 'pending'
          ? 'Новых заявок нет. Когда родственники заполнят анкету или предложат правку, она появится здесь.'
          : 'Здесь пока пусто.'));
        return;
      }
      for (const s of items) list.append(submissionCard(app, s, status === 'pending', async () => { await app.refresh(); await app.updatePending(); rerender(); }));
    } catch (e) {
      clear(list).append(h('div', { class: 'note-box warn' }, 'Не удалось загрузить заявки: ' + e.message));
    }
  }
  load();
}

function submissionCard(app, s, actionable, onDone) {
  const model = app.model;
  const payload = s.payload || {};
  // новые заявки уже записаны в дерево «на проверке»; старые — только описание
  const materialized = !!payload.materialized;
  const created = payload.created || { main: null, refs: {} };
  const target = s.target_person_id ? model.get(s.target_person_id) : null;
  const mainPerson = s.kind === 'new_person' && materialized ? target : null;
  const pName = mainPerson ? displayName(mainPerson) : refLabel(model, { new: payload.person || {} });
  const gone = '(человек удалён)';
  const title = s.kind === 'new_person' ? `Новый человек: ${materialized && !target ? gone : pName}`
    : s.kind === 'add_photo' ? `Фото: ${target ? displayName(target) : gone}`
    : s.kind === 'add_note' ? `Заметка: ${target ? displayName(target) : gone}`
    : `Правка: ${target ? displayName(target) : gone}`;

  const card = h('div', { class: 'sub-card' },
    h('h4', null, title),
    h('div', { class: 'sub-meta' }, `От: ${s.author_name || 'не указан'} · ${new Date(s.created_at).toLocaleString('ru-RU')}`));

  if (s.comment) card.append(h('div', { class: 'sub-comment' }, `«${s.comment}»`));
  if (s.kind === 'add_note' && payload.note?.text) card.append(h('div', { class: 'note', style: 'margin-bottom:10px' }, h('div', { class: 'note-text' }, payload.note.text)));

  // поля: для нового человека — как он сейчас записан (родственники могли исправить)
  const personFields = mainPerson
    ? Object.fromEntries(Object.keys(FIELD_LABELS).filter(k => mainPerson[k] && mainPerson[k] !== '').map(k => [k, mainPerson[k]]))
    : payload.person || {};
  const fields = Object.entries(personFields).filter(([k]) => FIELD_LABELS[k]);
  if (fields.length) {
    const isEdit = s.kind === 'edit_person';
    card.append(h('table', { class: 'diff' },
      h('thead', null, h('tr', null, h('th', null, 'Поле'), isEdit ? h('th', null, 'Было') : null, h('th', null, isEdit ? 'Станет' : 'Значение'))),
      h('tbody', null, fields.map(([k, v]) => h('tr', null,
        h('td', null, FIELD_LABELS[k]),
        isEdit ? h('td', { class: 'old' }, target ? fmtValue(k, target[k]) : '—') : null,
        h('td', { class: isEdit ? 'new' : '' }, fmtValue(k, v)))))));
  }

  // «это уже есть в дереве?» для главного человека новой анкеты
  let mainLink = null;
  if (s.kind === 'new_person' && actionable) {
    const sim = similarPeople(model, mainPerson || payload.person || {}, created.main);
    if (sim.length) {
      mainLink = h('select', { class: 'select' },
        h('option', { value: '' }, 'Нет, это новый человек'),
        sim.map(p => h('option', { value: p.id }, `Да, это ${displayName(p)} ${lifeYears(p)}`)));
      card.append(h('div', { class: 'note-box warn', style: 'margin-bottom:10px' },
        h('div', { style: 'margin-bottom:6px' }, 'Похоже, такой человек уже есть в дереве. Объединить?'), mainLink));
    }
  }

  // связи
  const rel = payload.relations || {};
  const linkSelects = {};
  const relRows = [];
  const labelOf = t => ({ parent: 'Родитель', partner: 'Супруг(а)', child: 'Ребёнок' }[t] || t);
  // имя человека из ссылки: созданного по заявке — как он записан сейчас
  const refName = (r, i) => {
    const cid = created.refs?.[i];
    if (cid && model.get(cid)) return displayName(model.get(cid));
    return refLabel(model, r.ref);
  };
  (rel.add || []).forEach((r, i) => {
    const row = h('div', { class: 'rel-change' }, h('span', { class: 'sign add' }, '+'), `${labelOf(r.type)}: `,
      h('b', null, refName(r, i)), r.ref?.new ? h('span', { class: 'muted small' }, '(новый)') : null);
    if (r.type === 'partner' && r.status && r.status !== 'married') row.append(h('span', { class: 'muted small' }, STATUS_LABELS[r.status]));
    if (r.type === 'child' && r.otherParent) {
      const ki = (rel.add || []).findIndex(x => x.key && x.key === r.otherParent.key);
      const other = r.otherParent.id ? displayName(model.get(r.otherParent.id)) : ki >= 0 ? refName(rel.add[ki], ki) : '—';
      row.append(h('span', { class: 'muted small' }, `второй родитель: ${other}`));
    }
    const createdId = created.refs?.[i];
    if (r.ref?.new && actionable && (!materialized || (createdId && model.get(createdId)))) {
      const np = createdId ? model.get(createdId) : r.ref.new;
      const sim = similarPeople(model, np, createdId);
      const sel = h('select', { class: 'select' },
        h('option', { value: '' }, sim.length ? 'Это новый человек (или выберите похожего)' : 'Это новый человек'),
        sim.map(p => h('option', { value: p.id }, `Это ${displayName(p)} ${lifeYears(p)}`)),
        h('option', { disabled: true }, '──────────'),
        [...model.people.values()].filter(p => !sim.includes(p) && p.id !== createdId).sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru'))
          .map(p => h('option', { value: p.id }, `${displayName(p)} ${lifeYears(p)}`)));
      if (sim.length === 1) sel.value = sim[0].id;
      linkSelects[i] = sel;
      row.append(sel);
    }
    relRows.push(row);
  });
  for (const r of rel.remove || []) {
    relRows.push(h('div', { class: 'rel-change' }, h('span', { class: 'sign rm' }, '−'), `Убрать связь «${labelOf(r.type).toLowerCase()}»: `, h('b', null, displayName(model.get(r.id)) || '(удалён)')));
  }
  for (const r of rel.update || []) {
    relRows.push(h('div', { class: 'rel-change' }, h('span', { class: 'sign add' }, '~'), 'Статус отношений с ', h('b', null, displayName(model.get(r.id))), `: ${STATUS_LABELS[r.status] || r.status}`));
  }
  if (relRows.length) card.append(h('div', { style: 'margin-bottom:8px' }, relRows));

  if ((payload.photos || []).length) {
    card.append(h('div', { class: 'sub-photos' }, payload.photos.map(ph => h('img', { src: app.photoUrl(ph.thumb_path || ph.path), alt: ph.caption || '', title: ph.caption || '' }))));
  }

  if (!actionable) {
    card.append(h('div', { class: 'sub-meta', style: 'margin:8px 0 0' },
      `${s.status === 'approved' ? 'Принята' : 'Отклонена'}${s.reviewed_at ? ' ' + new Date(s.reviewed_at).toLocaleString('ru-RU') : ''}${s.admin_note ? ' · ' + s.admin_note : ''}`));
    return card;
  }

  const targetMissing = !target && (s.kind !== 'new_person' || materialized);
  if (targetMissing) card.append(h('div', { class: 'note-box warn' }, 'Человек, к которому относилась заявка, уже удалён или объединён с другим. Заявку можно только отклонить.'));

  const approve = h('button', { class: 'btn btn-sage btn-sm', disabled: targetMissing }, icon('check', 16), 'Принять');
  const canEdit = !targetMissing && (s.kind === 'new_person' || s.kind === 'edit_person');
  const edit = h('button', { class: 'btn btn-sm', disabled: !canEdit }, icon('edit', 16), 'Изменить и принять');
  const reject = h('button', { class: 'btn btn-danger btn-sm' }, icon('x', 16), 'Отклонить');

  approve.addEventListener('click', () => withBusy(approve, async () => {
    try {
      const links = {};
      for (const [i, sel] of Object.entries(linkSelects)) if (sel.value) links[i] = sel.value;
      if (materialized) {
        // «новый» человек оказался уже существующим — объединяем карточки, потом одобряем
        for (const [i, into] of Object.entries(links)) {
          const from = created.refs?.[i];
          if (from && from !== into && app.model.get(from)) await app.backend.merge(from, into);
        }
        if (mainLink && mainLink.value && created.main) await app.backend.merge(created.main, mainLink.value);
        await app.backend.approveSubmission(s.id);
      } else {
        let targetId = s.target_person_id;
        let pl = payload;
        if (mainLink && mainLink.value) {
          targetId = mainLink.value;
          const nonEmpty = Object.fromEntries(Object.entries(payload.person || {}).filter(([, v]) => v !== '' && v !== null && v !== false));
          pl = { ...payload, person: nonEmpty };
        }
        await applyChange(app.backend, app.model, { targetId, payload: pl, links });
        await app.backend.reviewSubmission(s.id, 'approved');
      }
      toast('Заявка принята', 'ok');
      await onDone();
    } catch (e) { toast(e.message, 'err', 7000); }
  }));

  edit.addEventListener('click', () => {
    const personId = s.kind === 'edit_person' || materialized ? s.target_person_id : null;
    openPersonForm(app, { personId, submission: s });
  });

  reject.addEventListener('click', async () => {
    const note = await promptDialog({ title: 'Отклонить заявку', label: 'Причина (необязательно, видна только вам). Всё, что прислали в этой заявке, исчезнет из дерева.', okText: 'Отклонить' });
    if (note === null) return;
    try {
      await app.backend.rejectSubmission(s.id, note.trim());
      toast('Заявка отклонена');
      await onDone();
    } catch (e) { toast(e.message, 'err'); }
  });

  card.append(h('div', { class: 'sub-actions' }, approve, edit, reject));
  return card;
}

// ---------- данные ----------
function renderData(app, root, modal) {
  const today = new Date().toISOString().slice(0, 10);
  const gedBtn = h('button', { class: 'btn btn-sm' }, icon('download', 16), 'Скачать .ged');
  gedBtn.addEventListener('click', () => {
    // только подтверждённые данные; фото закрыты семейным кодом, ссылки на них не кладём
    const raw = app.raw || {};
    const ok = x => x.state !== 'pending';
    const approved = { ...raw, people: (raw.people || []).filter(ok), parent_child: (raw.parent_child || []).filter(ok), unions: (raw.unions || []).filter(ok), photos: [] };
    const text = exportGedcom(buildModel(approved));
    downloadFile(`family-tree-${today}.ged`, '﻿' + text, 'text/plain;charset=utf-8');
  });

  const jsonBtn = h('button', { class: 'btn btn-sm' }, icon('download', 16), 'Скачать резервную копию');
  jsonBtn.addEventListener('click', () => withBusy(jsonBtn, async () => {
    try {
      const data = await app.backend.exportAll();
      downloadFile(`family-tree-backup-${today}.json`, JSON.stringify({ exported_at: new Date().toISOString(), ...data }, null, 2), 'application/json');
    } catch (e) { toast(e.message, 'err'); }
  }));

  const fileInput = h('input', { type: 'file', accept: '.ged,.gedcom,text/plain', hidden: true });
  const importBtn = h('button', { class: 'btn btn-sm' }, icon('upload', 16), 'Выбрать файл .ged');
  importBtn.addEventListener('click', () => fileInput.click());
  const preview = h('div');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    clear(preview);
    try {
      const text = decodeGedcomBuffer(await file.arrayBuffer());
      const parsed = parseGedcom(text);
      if (!parsed.people.length) { preview.append(h('div', { class: 'note-box warn' }, 'В файле не найдено ни одного человека.')); return; }
      const sample = parsed.people.slice(0, 6).map(p => [p.first_name, p.patronymic, p.last_name].filter(Boolean).join(' ')).join(', ');
      const go = h('button', { class: 'btn btn-primary btn-sm' }, `Импортировать ${parsed.people.length} чел.`);
      go.addEventListener('click', () => withBusy(go, async () => {
        if (app.model.people.size) {
          const ok = await confirmDialog(`В дереве уже ${app.model.people.size} чел. Люди из файла будут ДОБАВЛЕНЫ к ним (без объединения). Продолжить?`, { okText: 'Импортировать' });
          if (!ok) return;
        }
        try {
          await app.backend.bulkImport(parsed);
          toast(`Импортировано: ${parsed.people.length} чел.`, 'ok');
          modal.close();
          await app.refresh({ fit: true });
        } catch (e) { toast('Ошибка импорта: ' + e.message, 'err', 8000); }
      }));
      preview.append(h('div', { class: 'note-box', style: 'margin-top:12px' },
        h('div', null, h('b', null, `Найдено: ${parsed.people.length} чел., ${parsed.unions.length} пар, ${parsed.parent_child.length} связей родитель–ребёнок.`)),
        h('div', { class: 'small', style: 'margin:4px 0 10px' }, `Например: ${sample}${parsed.people.length > 6 ? '…' : ''}`),
        parsed.warnings.length ? h('div', { class: 'small' }, `Предупреждения: ${parsed.warnings.slice(0, 3).join('; ')}`) : null,
        go));
    } catch (e) {
      preview.append(h('div', { class: 'note-box warn' }, 'Не удалось прочитать файл: ' + e.message));
    }
  });

  root.append(
    h('div', { class: 'data-block' },
      h('h4', null, 'Экспорт в GEDCOM'),
      h('p', null, 'Стандартный формат генеалогических программ. Файл можно открыть в MyHeritage, Geni, FamilySearch, Gramps или «Древе Жизни».'),
      gedBtn),
    h('div', { class: 'data-block' },
      h('h4', null, 'Резервная копия'),
      h('p', null, 'Полная выгрузка базы (люди, связи, подписи к фото, заявки) в JSON. Сервер сам хранит историю базы за 7 дней, но долгосрочную копию лучше скачивать раз в месяц или после крупных изменений.'),
      jsonBtn),
    h('div', { class: 'data-block' },
      h('h4', null, 'Импорт из GEDCOM'),
      h('p', null, 'Добавить людей из файла другой программы. Поддерживаются кодировки UTF-8 и Windows-1251. Фотографии из файла не переносятся.'),
      importBtn, fileInput, preview),
  );
}

// ---------- настройки ----------
function renderSettings(app, root, modal) {
  const titleInput = h('input', { class: 'input', value: app.model.title, maxlength: 80 });
  const saveTitle = h('button', { class: 'btn btn-sm btn-primary' }, 'Сохранить');
  saveTitle.addEventListener('click', () => withBusy(saveTitle, async () => {
    const t = titleInput.value.trim() || 'Семейное дерево';
    try { await app.backend.setTitle(t); toast('Название сохранено', 'ok'); await app.refresh(); } catch (e) { toast(e.message, 'err'); }
  }));

  const code1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Новый семейный код' });
  const code2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Повторите код' });
  const saveCode = h('button', { class: 'btn btn-sm btn-primary' }, 'Сменить код');
  saveCode.addEventListener('click', () => withBusy(saveCode, async () => {
    const c = code1.value.trim();
    if (c.length < 4) { toast('Код должен быть не короче 4 символов', 'err'); return; }
    if (c !== code2.value.trim()) { toast('Коды не совпадают', 'err'); return; }
    try {
      await app.backend.setFamilyCode(c);
      code1.value = code2.value = '';
      toast('Семейный код изменён. Все устройства родственников попросят ввести новый код — разошлите его.', 'ok', 7000);
    } catch (e) { toast(e.message, 'err'); }
  }));

  const logout = h('button', { class: 'btn btn-sm' }, icon('logout', 16), 'Выйти из режима администратора');
  logout.addEventListener('click', async () => {
    await app.backend.signOut();
    modal.close();
    await app.onAdminChange();
    toast('Вы вышли из режима администратора');
  });

  root.append(
    h('div', { class: 'data-block' },
      h('h4', null, 'Название дерева'),
      h('p', null, 'Показывается в шапке сайта и на экране входа.'),
      h('div', { class: 'row-actions' }, h('div', { style: 'flex:1;min-width:220px' }, titleInput), saveTitle)),
    h('div', { class: 'data-block' },
      h('h4', null, 'Семейный код'),
      h('p', null, 'Код, по которому родственники открывают дерево. После смены старый перестанет работать — разошлите новый.'),
      h('div', { class: 'grid grid-2' }, code1, code2),
      h('div', { style: 'margin-top:10px' }, saveCode)),
    h('div', { class: 'data-block' },
      h('h4', null, 'Режим администратора'),
      h('p', null, 'Этот браузер запомнен как администратор на 30 дней. Пароль меняется в настройках сервера (секрет ADMIN_PASSWORD).'),
      logout),
  );
}
