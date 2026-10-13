// Администрирование: вход, проверка заявок, данные, настройки.

import { h, icon, clear, openModal, toast, withBusy, promptDialog, downloadFile, confirmDialog } from './dom.js';
import { openPersonForm, statusLabels } from './person-form.js';
import { applyChange } from '../apply.js';
import { exportGedcom, decodeGedcomBuffer, parseGedcom } from '../gedcom.js';
import { buildModel } from '../model.js';
import { displayName, formatDate, normalizeText, yearOf, lifeYears, nameText } from '../util.js';
import { t, locale } from '../i18n.js';

// ---------- вход ----------
export function openAdminLogin(app) {
  // скрытое поле имени нужно менеджерам паролей, чтобы запомнить пароль
  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'admin', hidden: true });
  const password = h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: t('Пароль администратора'), required: true });
  const err = h('p', { class: 'lock-error', style: 'text-align:left' });
  const go = h('button', { class: 'btn btn-primary', type: 'submit' }, t('Войти'));
  const form = h('form', null,
    h('p', { class: 'intro' }, app.backend.mode === 'demo'
      ? t('Демо-режим: пароль администратора — demo.')
      : t('Вход только для администратора дерева.')),
    user,
    h('div', { class: 'field', style: 'margin-top:12px' }, h('label', null, t('Пароль')), password),
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
      toast(t('Вы вошли как администратор'), 'ok');
      openAdminPanel(app);
    });
  });
  const m = openModal({ title: t('Вход администратора'), body: form, size: 'sm' });
}

// ---------- панель ----------
export function openAdminPanel(app, tab = 'subs') {
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const content = h('div');
  const m = openModal({ title: t('Администрирование'), body: h('div', null, tabs, content), size: 'lg' });

  const TABS = [
    ['subs', t('Заявки'), 'users'],
    ['data', t('Данные'), 'download'],
    ['settings', t('Настройки'), 'shield'],
  ];
  function show(next) {
    tab = next;
    clear(tabs);
    for (const [key, label, ic] of TABS) {
      const b = h('button', { class: key === next ? 'active' : '', role: 'tab', onclick: () => show(key) }, icon(ic, 16), label);
      if (key === 'subs' && app.pending) b.append(h('span', { class: 'badge' }, app.pending));
      tabs.append(b);
    }
    clear(content);
    if (next === 'subs') renderSubmissions(app, content, () => show('subs'));
    if (next === 'data') renderData(app, content, m);
    if (next === 'settings') renderSettings(app, content, m);
  }
  // заявку можно принять и из формы «Изменить и принять» — тогда обновляем список
  app.onSubmissionReviewed = () => { if (document.body.contains(content) && tab === 'subs') show('subs'); };
  show(tab);
  return m;
}

// ---------- заявки ----------
const fieldLabels = () => ({
  last_name: t('Фамилия'), first_name: t('Имя'), patronymic: t('Отчество'), maiden_name: t('Девичья фамилия'), gender: t('Пол'),
  birth_date: t('Дата рождения'), birth_approx: t('Дата рождения примерная'), birth_place: t('Место рождения'),
  is_deceased: t('Умер(ла)'), death_date: t('Дата смерти'), death_approx: t('Дата смерти примерная'), death_place: t('Место смерти'),
  occupation: t('Род занятий'), bio: t('Биография'),
});

function fmtValue(key, v) {
  if (key === 'gender') return v === 'm' ? t('мужской') : v === 'f' ? t('женский') : '—';
  if (typeof v === 'boolean') return v ? t('да') : t('нет');
  if (key === 'birth_date' || key === 'death_date') return v ? formatDate(v) : '—';
  return v === '' || v === null || v === undefined ? '—' : String(v);
}

function refLabel(model, ref) {
  if (!ref) return '—';
  if (ref.id) return displayName(model.get(ref.id)) || t('(удалён)');
  const n = ref.new || {};
  return [n.first_name, n.patronymic, n.last_name].filter(Boolean).map(nameText).join(' ') || t('без имени');
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

const dateTime = iso => new Date(iso).toLocaleString(locale());

async function renderSubmissions(app, root, rerender) {
  let status = root.dataset.status || 'pending';
  const sub = h('div', { class: 'subtabs' });
  const list = h('div');
  root.append(sub, list);
  const btn = (s, label) => h('button', { class: `btn btn-sm ${s === status ? 'btn-primary' : ''}`, onclick: () => { root.dataset.status = s; status = s; load(); paint(); } }, label);
  function paint() { clear(sub).append(btn('pending', t('Ожидают проверки')), btn('approved', t('Принятые')), btn('rejected', t('Отклонённые'))); }
  paint();

  async function load() {
    clear(list).append(h('div', { class: 'muted' }, t('Загрузка…')));
    try {
      const items = await app.backend.listSubmissions(status);
      clear(list);
      if (!items.length) {
        list.append(h('div', { class: 'note-box' }, status === 'pending'
          ? t('Новых заявок нет. Когда родственники заполнят анкету или предложат правку, она появится здесь.')
          : t('Здесь пока пусто.')));
        return;
      }
      for (const s of items) list.append(submissionCard(app, s, status === 'pending', async () => { await app.refresh(); await app.updatePending(); rerender(); }));
    } catch (e) {
      clear(list).append(h('div', { class: 'note-box warn' }, t('Не удалось загрузить заявки: {error}', { error: e.message })));
    }
  }
  load();
}

function submissionCard(app, s, actionable, onDone) {
  const model = app.model;
  const payload = s.payload || {};
  const FIELD_LABELS = fieldLabels();
  const STATUS_LABELS = statusLabels();
  // новые заявки уже записаны в дерево «на проверке»; старые — только описание
  const materialized = !!payload.materialized;
  const created = payload.created || { main: null, refs: {} };
  const target = s.target_person_id ? model.get(s.target_person_id) : null;
  const mainPerson = s.kind === 'new_person' && materialized ? target : null;
  const pName = mainPerson ? displayName(mainPerson) : refLabel(model, { new: payload.person || {} });
  const gone = t('(человек удалён)');
  const title = s.kind === 'new_person' ? t('Новый человек: {name}', { name: materialized && !target ? gone : pName })
    : s.kind === 'add_photo' ? t('Фото: {name}', { name: target ? displayName(target) : gone })
    : s.kind === 'add_note' ? t('Заметка: {name}', { name: target ? displayName(target) : gone })
    : t('Правка: {name}', { name: target ? displayName(target) : gone });

  const card = h('div', { class: 'sub-card' },
    h('h4', null, title),
    h('div', { class: 'sub-meta' }, t('От: {author} · {date}', { author: nameText(s.author_name) || t('не указан'), date: dateTime(s.created_at) })));

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
      h('thead', null, h('tr', null, h('th', null, t('Поле')), isEdit ? h('th', null, t('Было')) : null, h('th', null, isEdit ? t('Станет') : t('Значение')))),
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
        h('option', { value: '' }, t('Нет, это новый человек')),
        sim.map(p => h('option', { value: p.id }, t('Да, это {name}', { name: `${displayName(p)} ${lifeYears(p)}`.trim() }))));
      card.append(h('div', { class: 'note-box warn', style: 'margin-bottom:10px' },
        h('div', { style: 'margin-bottom:6px' }, t('Похоже, такой человек уже есть в дереве. Объединить?')), mainLink));
    }
  }

  // связи
  const rel = payload.relations || {};
  const linkSelects = {};
  const relRows = [];
  const labelOf = type => ({ parent: t('Родитель'), partner: t('Супруг(а)'), child: t('Ребёнок') }[type] || type);
  // имя человека из ссылки: созданного по заявке — как он записан сейчас
  const refName = (r, i) => {
    const cid = created.refs?.[i];
    if (cid && model.get(cid)) return displayName(model.get(cid));
    return refLabel(model, r.ref);
  };
  (rel.add || []).forEach((r, i) => {
    const row = h('div', { class: 'rel-change' }, h('span', { class: 'sign add' }, '+'), `${labelOf(r.type)}: `,
      h('b', null, refName(r, i)), r.ref?.new ? h('span', { class: 'muted small' }, t('(новый)')) : null);
    if (r.type === 'partner' && r.status && r.status !== 'married') row.append(h('span', { class: 'muted small' }, STATUS_LABELS[r.status]));
    if (r.type === 'child' && r.otherParent) {
      const ki = (rel.add || []).findIndex(x => x.key && x.key === r.otherParent.key);
      const other = r.otherParent.id ? displayName(model.get(r.otherParent.id)) : ki >= 0 ? refName(rel.add[ki], ki) : '—';
      row.append(h('span', { class: 'muted small' }, t('второй родитель: {name}', { name: other })));
    }
    const createdId = created.refs?.[i];
    if (r.ref?.new && actionable && (!materialized || (createdId && model.get(createdId)))) {
      const np = createdId ? model.get(createdId) : r.ref.new;
      const sim = similarPeople(model, np, createdId);
      const sel = h('select', { class: 'select' },
        h('option', { value: '' }, sim.length ? t('Это новый человек (или выберите похожего)') : t('Это новый человек')),
        sim.map(p => h('option', { value: p.id }, t('Это {name}', { name: `${displayName(p)} ${lifeYears(p)}`.trim() }))),
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
    relRows.push(h('div', { class: 'rel-change' }, h('span', { class: 'sign rm' }, '−'), t('Убрать связь «{type}»:', { type: labelOf(r.type).toLowerCase() }) + ' ', h('b', null, displayName(model.get(r.id)) || t('(удалён)'))));
  }
  for (const r of rel.update || []) {
    relRows.push(h('div', { class: 'rel-change' }, h('span', { class: 'sign add' }, '~'), t('Статус отношений с') + ' ', h('b', null, displayName(model.get(r.id))), `: ${STATUS_LABELS[r.status] || r.status}`));
  }
  if (relRows.length) card.append(h('div', { style: 'margin-bottom:8px' }, relRows));

  if ((payload.photos || []).length) {
    card.append(h('div', { class: 'sub-photos' }, payload.photos.map(ph => h('img', { src: app.photoUrl(ph.thumb_path || ph.path), alt: ph.caption || '', title: ph.caption || '' }))));
  }

  if (!actionable) {
    card.append(h('div', { class: 'sub-meta', style: 'margin:8px 0 0' },
      `${s.status === 'approved' ? t('Принята') : t('Отклонена')}${s.reviewed_at ? ' ' + dateTime(s.reviewed_at) : ''}${s.admin_note ? ' · ' + s.admin_note : ''}`));
    return card;
  }

  const targetMissing = !target && (s.kind !== 'new_person' || materialized);
  if (targetMissing) card.append(h('div', { class: 'note-box warn' }, t('Человек, к которому относилась заявка, уже удалён или объединён с другим. Заявку можно только отклонить.')));

  const approve = h('button', { class: 'btn btn-sage btn-sm', disabled: targetMissing }, icon('check', 16), t('Принять'));
  const canEdit = !targetMissing && (s.kind === 'new_person' || s.kind === 'edit_person');
  const edit = h('button', { class: 'btn btn-sm', disabled: !canEdit }, icon('edit', 16), t('Изменить и принять'));
  const reject = h('button', { class: 'btn btn-danger btn-sm' }, icon('x', 16), t('Отклонить'));

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
      toast(t('Заявка принята'), 'ok');
      await onDone();
    } catch (e) { toast(e.message, 'err', 7000); }
  }));

  edit.addEventListener('click', () => {
    const personId = s.kind === 'edit_person' || materialized ? s.target_person_id : null;
    openPersonForm(app, { personId, submission: s });
  });

  reject.addEventListener('click', async () => {
    const note = await promptDialog({ title: t('Отклонить заявку'), label: t('Причина (необязательно, видна только вам). Всё, что прислали в этой заявке, исчезнет из дерева.'), okText: t('Отклонить') });
    if (note === null) return;
    try {
      await app.backend.rejectSubmission(s.id, note.trim());
      toast(t('Заявка отклонена'));
      await onDone();
    } catch (e) { toast(e.message, 'err'); }
  });

  card.append(h('div', { class: 'sub-actions' }, approve, edit, reject));
  return card;
}

// ---------- данные ----------
async function downloadBackup(app, suffix = '') {
  const data = await app.backend.exportAll();
  // местное время в имени файла: family-tree-backup-2026-10-12_14-30.json
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}`;
  downloadFile(`family-tree-backup-${stamp}${suffix}.json`, JSON.stringify({ exported_at: new Date().toISOString(), ...data }, null, 2), 'application/json');
}

function renderData(app, root, modal) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const gedBtn = h('button', { class: 'btn btn-sm' }, icon('download', 16), t('Скачать .ged'));
  gedBtn.addEventListener('click', () => {
    // только подтверждённые данные; фото закрыты семейным кодом, ссылки на них не кладём
    const raw = app.raw || {};
    const ok = x => x.state !== 'pending';
    const approved = { ...raw, people: (raw.people || []).filter(ok), parent_child: (raw.parent_child || []).filter(ok), unions: (raw.unions || []).filter(ok), photos: [] };
    const text = exportGedcom(buildModel(approved));
    downloadFile(`family-tree-${today}.ged`, '﻿' + text, 'text/plain;charset=utf-8');
  });

  const jsonBtn = h('button', { class: 'btn btn-sm' }, icon('download', 16), t('Скачать резервную копию'));
  jsonBtn.addEventListener('click', () => withBusy(jsonBtn, async () => {
    try { await downloadBackup(app); } catch (e) { toast(e.message, 'err'); }
  }));

  const fileInput = h('input', { type: 'file', accept: '.ged,.gedcom,text/plain', hidden: true });
  const importBtn = h('button', { class: 'btn btn-sm' }, icon('upload', 16), t('Выбрать файл .ged'));
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
      if (!parsed.people.length) { preview.append(h('div', { class: 'note-box warn' }, t('В файле не найдено ни одного человека.'))); return; }
      const sample = parsed.people.slice(0, 6).map(p => [p.first_name, p.patronymic, p.last_name].filter(Boolean).join(' ')).join(', ');
      const go = h('button', { class: 'btn btn-primary btn-sm' }, t('Импортировать {n} чел.', { n: parsed.people.length }));
      go.addEventListener('click', () => withBusy(go, async () => {
        if (app.model.people.size) {
          const ok = await confirmDialog(t('В дереве уже {n} чел. Люди из файла будут ДОБАВЛЕНЫ к ним (без объединения). Продолжить?', { n: app.model.people.size }), { okText: t('Импортировать') });
          if (!ok) return;
        }
        try {
          await app.backend.bulkImport(parsed);
          toast(t('Импортировано: {n} чел.', { n: parsed.people.length }), 'ok');
          modal.close();
          await app.refresh({ fit: true });
        } catch (e) { toast(t('Ошибка импорта: {error}', { error: e.message }), 'err', 8000); }
      }));
      preview.append(h('div', { class: 'note-box', style: 'margin-top:12px' },
        h('div', null, h('b', null, t('Найдено: {people} чел., {unions} пар, {links} связей родитель–ребёнок.', { people: parsed.people.length, unions: parsed.unions.length, links: parsed.parent_child.length }))),
        h('div', { class: 'small', style: 'margin:4px 0 10px' }, t('Например: {names}', { names: sample + (parsed.people.length > 6 ? '…' : '') })),
        parsed.warnings.length ? h('div', { class: 'small' }, t('Предупреждения: {list}', { list: parsed.warnings.slice(0, 3).join('; ') })) : null,
        go));
    } catch (e) {
      preview.append(h('div', { class: 'note-box warn' }, t('Не удалось прочитать файл: {error}', { error: e.message })));
    }
  });

  root.append(
    h('div', { class: 'data-block' },
      h('h4', null, t('Резервная копия')),
      h('p', null, t('Полная выгрузка базы (люди, связи, заметки, подписи к фото, заявки) в один файл. Сервер сам хранит историю базы за 7 дней, но долгосрочную копию лучше скачивать раз в месяц или после крупных изменений. Файл пригодится, чтобы вернуть дерево к этому состоянию — см. «Восстановить из резервной копии».')),
      jsonBtn),
    restoreBlock(app, modal),
    h('div', { class: 'data-block' },
      h('h4', null, t('Экспорт в GEDCOM')),
      h('p', null, t('Стандартный формат генеалогических программ. Файл можно открыть в MyHeritage, Geni, FamilySearch, Gramps или «Древе Жизни».')),
      gedBtn),
    h('div', { class: 'data-block' },
      h('h4', null, t('Импорт из GEDCOM')),
      h('p', null, t('Добавить людей из файла другой программы. Поддерживаются кодировки UTF-8 и Windows-1251. Фотографии из файла не переносятся.')),
      importBtn, fileInput, preview),
  );
}

// Восстановление из резервной копии: всё содержимое дерева заменяется данными из файла.
function restoreBlock(app, modal) {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const pickBtn = h('button', { class: 'btn btn-sm' }, icon('upload', 16), t('Выбрать файл копии (.json)'));
  pickBtn.addEventListener('click', () => fileInput.click());
  const preview = h('div');
  const count = (data, key) => (Array.isArray(data[key]) ? data[key].length : 0);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    clear(preview);
    let data;
    try { data = JSON.parse(await file.text()); } catch { data = null; }
    if (!data || typeof data !== 'object' || !Array.isArray(data.people)) {
      preview.append(h('div', { class: 'note-box warn', style: 'margin-top:12px' }, t('Это не резервная копия дерева. Выберите файл family-tree-backup-….json, скачанный кнопкой «Скачать резервную копию».')));
      return;
    }
    const when = data.exported_at ? dateTime(data.exported_at) : t('дата неизвестна');
    const pendingSubs = (data.submissions || []).filter(s => s && s.status === 'pending').length;
    const go = h('button', { class: 'btn btn-danger btn-sm' }, icon('upload', 16), t('Восстановить из этой копии'));
    go.addEventListener('click', () => withBusy(go, async () => {
      const ok = await confirmDialog(
        t('Все текущие данные дерева будут заменены данными из копии от {date}.\n\nСначала сайт скачает копию текущих данных — на случай, если понадобится вернуть всё обратно. Продолжить?', { date: when }),
        { title: t('Восстановить из резервной копии'), okText: t('Восстановить'), danger: true });
      if (!ok) return;
      try {
        await downloadBackup(app, '-before-restore');
      } catch (e) {
        toast(t('Не удалось сохранить копию текущих данных, восстановление отменено: {error}', { error: e.message }), 'err', 9000);
        return;
      }
      try {
        const res = await app.backend.restore(data);
        modal.close();
        toast(t('Дерево восстановлено из копии: {n} чел.', { n: res.people }), 'ok', 7000);
        app.select(null);
        await app.refresh({ fit: true });
        await app.updatePending();
      } catch (e) {
        toast(t('Не удалось восстановить: {error}', { error: e.message }), 'err', 9000);
      }
    }));
    preview.append(h('div', { class: 'note-box', style: 'margin-top:12px' },
      h('div', null, h('b', null, t('Копия от {date}', { date: when }))),
      h('div', { class: 'small', style: 'margin:4px 0 4px' }, t('В копии: {people} чел., {links} связей родитель–ребёнок, {unions} пар, {photos} фото, {notes} заметок, заявок: {subs} (ждут проверки: {pending}).', {
        people: count(data, 'people'), links: count(data, 'parent_child'), unions: count(data, 'unions'),
        photos: count(data, 'photos'), notes: count(data, 'notes'), subs: count(data, 'submissions'), pending: pendingSubs,
      })),
      h('div', { class: 'small', style: 'margin:0 0 10px' }, t('Сейчас в дереве: {n} чел.', { n: app.model.people.size })),
      go));
  });

  return h('div', { class: 'data-block' },
    h('h4', null, t('Восстановить из резервной копии')),
    h('p', null, t('Вернуть дерево к состоянию из скачанного файла копии. Люди, связи, заметки и заявки заменятся данными из файла, а то, что добавили после этой копии, исчезнет. Перед восстановлением сайт сам скачает копию текущих данных.')),
    h('p', null, t('Сами фотографии в копию не входят — в ней только ссылки на них. Фото, которые с тех пор не удаляли, вернутся вместе с данными.')),
    pickBtn, fileInput, preview);
}

// ---------- настройки ----------
function renderSettings(app, root, modal) {
  // исходное название, а не перевод «Семейное дерево» по умолчанию
  const titleInput = h('input', { class: 'input', value: (app.raw && app.raw.title) || app.model.title, maxlength: 80 });
  const saveTitle = h('button', { class: 'btn btn-sm btn-primary' }, t('Сохранить'));
  saveTitle.addEventListener('click', () => withBusy(saveTitle, async () => {
    const value = titleInput.value.trim() || 'Семейное дерево';
    try { await app.backend.setTitle(value); toast(t('Название сохранено'), 'ok'); await app.refresh(); } catch (e) { toast(e.message, 'err'); }
  }));

  const code1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: t('Новый семейный код') });
  const code2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: t('Повторите код') });
  const saveCode = h('button', { class: 'btn btn-sm btn-primary' }, t('Сменить код'));
  saveCode.addEventListener('click', () => withBusy(saveCode, async () => {
    const c = code1.value.trim();
    if (c.length < 4) { toast(t('Код должен быть не короче 4 символов'), 'err'); return; }
    if (c !== code2.value.trim()) { toast(t('Коды не совпадают'), 'err'); return; }
    try {
      await app.backend.setFamilyCode(c);
      code1.value = code2.value = '';
      toast(t('Семейный код изменён. Все устройства родственников попросят ввести новый код — разошлите его.'), 'ok', 7000);
    } catch (e) { toast(e.message, 'err'); }
  }));

  const logout = h('button', { class: 'btn btn-sm' }, icon('logout', 16), t('Выйти из режима администратора'));
  logout.addEventListener('click', async () => {
    await app.backend.signOut();
    modal.close();
    await app.onAdminChange();
    toast(t('Вы вышли из режима администратора'));
  });

  root.append(
    h('div', { class: 'data-block' },
      h('h4', null, t('Название дерева')),
      h('p', null, t('Показывается в шапке сайта и на экране входа.')),
      h('div', { class: 'row-actions' }, h('div', { style: 'flex:1;min-width:220px' }, titleInput), saveTitle)),
    h('div', { class: 'data-block' },
      h('h4', null, t('Семейный код')),
      h('p', null, t('Код, по которому родственники открывают дерево. После смены старый перестанет работать — разошлите новый.')),
      h('div', { class: 'grid grid-2' }, code1, code2),
      h('div', { style: 'margin-top:10px' }, saveCode)),
    h('div', { class: 'data-block' },
      h('h4', null, t('Режим администратора')),
      h('p', null, t('Этот браузер запомнен как администратор на 30 дней. Пароль меняется в настройках сервера (секрет ADMIN_PASSWORD).')),
      logout),
  );
}
