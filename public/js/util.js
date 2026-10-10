// Общие помощники: экранирование, имена, даты, localStorage.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- localStorage: может быть недоступен (приватный режим и т.п.) ----------
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

// ---------- имена ----------
export function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

export function displayName(p) {
  if (!p) return '';
  const parts = [p.first_name, p.last_name].filter(Boolean);
  return parts.join(' ') || 'Без имени';
}

export function fullName(p) {
  if (!p) return '';
  const parts = [p.last_name, p.first_name, p.patronymic].filter(Boolean);
  let s = parts.join(' ') || 'Без имени';
  if (p.maiden_name && p.maiden_name !== p.last_name) s += ` (урожд. ${p.maiden_name})`;
  return s;
}

// «Имя Отчество» для первой строки карточки
export function givenNames(p) {
  return [p.first_name, p.patronymic].filter(Boolean).join(' ') || 'Без имени';
}

export function initials(p) {
  const a = (p.first_name || '').trim()[0] || '';
  const b = (p.last_name || '').trim()[0] || '';
  return (a + b).toUpperCase() || '?';
}

export function searchKey(p) {
  return normalizeText([p.last_name, p.first_name, p.patronymic, p.maiden_name].join(' '));
}

const PATRONYMIC_RE = /(вич|вна|ична|инична|ич|оглы|кызы)$/i;

export function isPatronymic(word) {
  return PATRONYMIC_RE.test(word || '');
}

// Разбирает «Иван Петров», «Иван Петрович Петров», «Петров Иван Петрович».
export function parseNameInput(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const res = { first_name: '', patronymic: '', last_name: '' };
  if (words.length === 1) {
    res.first_name = words[0];
  } else if (words.length === 2) {
    if (isPatronymic(words[1])) { res.first_name = words[0]; res.patronymic = words[1]; }
    else { res.first_name = words[0]; res.last_name = words[1]; }
  } else if (words.length >= 3) {
    if (isPatronymic(words[1])) {
      res.first_name = words[0]; res.patronymic = words[1]; res.last_name = words.slice(2).join(' ');
    } else if (isPatronymic(words[words.length - 1])) {
      res.last_name = words[0]; res.first_name = words[1]; res.patronymic = words.slice(2).join(' ');
    } else {
      res.first_name = words[0]; res.last_name = words.slice(1).join(' ');
    }
  }
  return res;
}

export function guessGender({ first_name = '', patronymic = '', last_name = '' }) {
  const pat = patronymic.toLowerCase();
  if (/(вич|ич|оглы)$/.test(pat)) return 'm';
  if (/(вна|чна|кызы)$/.test(pat)) return 'f';
  const ln = last_name.toLowerCase();
  if (/(ова|ева|ёва|ина|ына|ская|цкая|ая)$/.test(ln)) return 'f';
  if (/(ов|ев|ёв|ин|ын|ский|цкий|ой|ый)$/.test(ln)) return 'm';
  const fn = first_name.toLowerCase();
  if (/(илья|никита|кузьма|фома|лука|савва|миша|саша|женя|коля|ваня|петя|вася|дима|гриша|паша|лёша|леша|сережа|серёжа|юра|толя|витя|слава|костя|боря|гоша|федя|вова)$/.test(fn)) return 'm';
  if (/[ая]$/.test(fn)) return 'f';
  if (/(любовь|нинель|эсфирь|юдифь|рахиль|руфь)$/.test(fn)) return 'f';
  if (fn) return 'm';
  return '';
}

// ---------- даты: 'ГГГГ', 'ГГГГ-ММ', 'ГГГГ-ММ-ДД' ----------
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export function parseDate(s) {
  const m = String(s || '').match(/^(\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (!m) return null;
  return { y: +m[1], m: m[2] ? +m[2] : null, d: m[3] ? +m[3] : null };
}

export function makeDate(y, m, d) {
  y = parseInt(y, 10); m = parseInt(m, 10); d = parseInt(d, 10);
  if (!y) return '';
  let s = String(y).padStart(4, '0');
  if (m >= 1 && m <= 12) {
    s += '-' + String(m).padStart(2, '0');
    if (d >= 1 && d <= 31) s += '-' + String(d).padStart(2, '0');
  }
  return s;
}

export function yearOf(s) {
  const p = parseDate(s);
  return p ? p.y : null;
}

export function formatDate(s, approx = false) {
  const p = parseDate(s);
  if (!p) return '';
  let out;
  if (p.d && p.m) out = `${p.d} ${MONTHS_GEN[p.m - 1]} ${p.y}`;
  else if (p.m) out = `${MONTHS_NOM[p.m - 1]} ${p.y}`;
  else out = String(p.y);
  return approx ? `около ${out}` : out;
}

export function lifeYears(p) {
  const b = yearOf(p.birth_date);
  const d = yearOf(p.death_date);
  const bs = b ? (p.birth_approx ? '~' + b : String(b)) : '';
  const ds = d ? (p.death_approx ? '~' + d : String(d)) : '';
  if (p.is_deceased || d) {
    if (!bs && !ds) return '';
    return `${bs || '?'} – ${ds || '?'}`;
  }
  return bs ? `р. ${bs}` : '';
}

export function ageText(p) {
  const b = parseDate(p.birth_date);
  if (!b || p.birth_approx) return '';
  let end;
  if (p.is_deceased || p.death_date) {
    const d = parseDate(p.death_date);
    if (!d) return '';
    end = d;
  } else {
    const now = new Date();
    end = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  }
  let age = end.y - b.y;
  if (b.m && end.m && (end.m < b.m || (end.m === b.m && b.d && end.d && end.d < b.d))) age--;
  if (age < 0 || age > 130) return '';
  return `${age} ${plural(age, 'год', 'года', 'лет')}`;
}

export function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

// Сортировка по дате рождения: неизвестные — в конец, в порядке добавления.
export function birthSortKey(p) {
  const d = parseDate(p.birth_date);
  if (!d) return 99999999;
  return d.y * 10000 + (d.m || 6) * 100 + (d.d || 15);
}
