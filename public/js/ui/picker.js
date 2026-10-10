// Поле «выбрать человека»: поиск по дереву или добавление нового.
// Значение: null | { id } | { new: { first_name, patronymic, last_name, gender, birth_date } }

import { h, icon, clear } from './dom.js';
import { displayName, initials, lifeYears, normalizeText, searchKey, parseNameInput, guessGender, makeDate, yearOf } from '../util.js';

export function searchPeople(model, query, { exclude = new Set(), limit = 8 } = {}) {
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const res = [];
  for (const p of model.people.values()) {
    if (exclude.has(p.id)) continue;
    const key = searchKey(p);
    if (tokens.every(t => key.includes(t))) {
      const starts = tokens.every(t => key.split(' ').some(w => w.startsWith(t)));
      res.push({ p, score: starts ? 0 : 1 });
    }
  }
  res.sort((a, b) => a.score - b.score || displayName(a.p).localeCompare(displayName(b.p), 'ru'));
  return res.slice(0, limit).map(r => r.p);
}

export function avatarEl(model, p, photoUrl) {
  const ph = p.id ? model.mainPhoto(p.id) : null;
  const src = ph ? photoUrl(ph.thumb_path || ph.path) : '';
  return h('span', { class: `avatar ${p.gender ? 'g-' + p.gender : ''}` }, src ? h('img', { src, alt: '' }) : initials(p));
}

export function personPicker({ model, photoUrl, value = null, placeholder = 'Начните вводить имя…', exclude = new Set(), genderHint = '', allowNew = true, onChange }) {
  const root = h('div', { class: 'picker' });
  let current = value;
  let editorOpen = false;

  function set(v, { silent = false } = {}) {
    current = v;
    render();
    if (!silent && onChange) onChange(current);
  }

  function render() {
    clear(root);
    if (!current) return renderInput();
    if (current.id) {
      const p = model.get(current.id);
      if (!p) { current = null; return renderInput(); }
      root.append(h('div', { class: 'picker-chip' },
        avatarEl(model, p, photoUrl),
        h('div', { class: 't' }, h('div', { class: 'n' }, displayName(p)), h('div', { class: 'y' }, [p.patronymic, lifeYears(p)].filter(Boolean).join(' · '))),
        h('button', { class: 'btn btn-icon btn-ghost btn-sm', type: 'button', 'aria-label': 'Убрать', onclick: () => set(null) }, icon('x')),
      ));
      return;
    }
    const np = current.new;
    const label = () => [np.first_name, np.patronymic, np.last_name].filter(Boolean).join(' ') || 'Без имени';
    const nameEl = h('div', { class: 'n' }, label());
    const avatar = h('span', { class: 'avatar' }, initials(np));
    root.append(h('div', { class: 'picker-chip new' },
      avatar,
      h('div', { class: 't' }, h('div', { class: 'tag' }, 'Новый человек'), nameEl),
      h('button', { class: 'btn btn-icon btn-ghost btn-sm', type: 'button', 'aria-label': 'Изменить', title: 'Уточнить данные', onclick: () => { editorOpen = !editorOpen; render(); } }, icon('edit')),
      h('button', { class: 'btn btn-icon btn-ghost btn-sm', type: 'button', 'aria-label': 'Убрать', onclick: () => set(null) }, icon('x')),
    ));
    if (editorOpen) {
      root.append(newPersonEditor(np, () => {
        nameEl.textContent = label();
        avatar.textContent = initials(np);
        onChange && onChange(current);
      }));
    }
  }

  function renderInput() {
    const input = h('input', { class: 'input', type: 'text', placeholder, autocomplete: 'off' });
    let dd = null;
    let items = [];
    let active = -1;

    const closeDd = () => { dd?.remove(); dd = null; active = -1; };
    const choose = i => {
      const it = items[i];
      if (!it) return;
      closeDd();
      if (it.kind === 'person') set({ id: it.p.id });
      else {
        const parsed = parseNameInput(input.value);
        const gender = genderHint || guessGender(parsed);
        editorOpen = true;
        set({ new: { ...parsed, gender, birth_date: '' } });
      }
    };
    const update = () => {
      const q = input.value.trim();
      closeDd();
      if (!q) return;
      const found = searchPeople(model, q, { exclude });
      items = found.map(p => ({ kind: 'person', p }));
      if (allowNew) items.push({ kind: 'new' });
      dd = h('div', { class: 'dropdown', role: 'listbox' });
      if (!found.length && !allowNew) dd.append(h('div', { class: 'dd-empty' }, 'Никого не нашли'));
      items.forEach((it, i) => {
        const el = it.kind === 'person'
          ? h('div', { class: 'dd-item', role: 'option' }, avatarEl(model, it.p, photoUrl),
              h('div', { class: 't' }, h('div', { class: 'n' }, displayName(it.p)), h('div', { class: 'y' }, [it.p.patronymic, lifeYears(it.p)].filter(Boolean).join(' · '))))
          : h('div', { class: 'dd-item new', role: 'option' }, icon('userPlus'), h('div', { class: 't' }, `Добавить нового: «${q}»`));
        el.addEventListener('mousedown', e => { e.preventDefault(); choose(i); });
        dd.append(el);
      });
      root.append(dd);
    };
    input.addEventListener('input', update);
    input.addEventListener('focus', () => { if (input.value.trim()) update(); });
    input.addEventListener('blur', () => setTimeout(closeDd, 120));
    input.addEventListener('keydown', e => {
      if (!dd) return;
      const els = [...dd.querySelectorAll('.dd-item')];
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(els.length - 1, active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active >= 0 ? active : 0); return; }
      else if (e.key === 'Escape') { e.stopPropagation(); closeDd(); return; }
      els.forEach((el, i) => el.classList.toggle('active', i === active));
    });
    root.append(input);
  }

  render();
  return {
    el: root,
    get value() { return current; },
    set value(v) { set(v, { silent: true }); },
  };
}

// Мини-форма для нового человека внутри поля выбора.
function newPersonEditor(np, onCommit) {
  const f = (label, key, extra = {}) => {
    const input = h('input', { class: 'input', value: np[key] || '', ...extra });
    input.addEventListener('input', () => { np[key] = input.value.trim(); });
    input.addEventListener('change', onCommit);
    return h('div', { class: 'field' }, h('label', null, label), input);
  };
  const gender = h('select', { class: 'select' },
    h('option', { value: '' }, 'Не указан'),
    h('option', { value: 'm', selected: np.gender === 'm' }, 'Мужской'),
    h('option', { value: 'f', selected: np.gender === 'f' }, 'Женский'));
  gender.addEventListener('change', () => { np.gender = gender.value; onCommit(); });
  const year = h('input', { class: 'input', type: 'number', min: 1500, max: 2100, placeholder: 'Год', value: yearOf(np.birth_date) || '' });
  year.addEventListener('input', () => { np.birth_date = makeDate(year.value); });
  year.addEventListener('change', onCommit);
  return h('div', { class: 'new-person-editor' },
    h('div', { class: 'grid grid-3' }, f('Фамилия', 'last_name'), f('Имя', 'first_name'), f('Отчество', 'patronymic')),
    h('div', { class: 'grid grid-2', style: 'margin-top:10px' },
      h('div', { class: 'field' }, h('label', null, 'Пол'), gender),
      h('div', { class: 'field' }, h('label', null, 'Год рождения'), year)),
    h('div', { class: 'hint', style: 'margin-top:8px' }, 'Остальное можно будет дополнить позже.'),
  );
}
