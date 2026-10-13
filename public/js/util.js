// Общие помощники: экранирование, имена, даты, localStorage.

import { t, tn, getLang } from './i18n.js';

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

// ---------- имена латиницей (для английского и немецкого интерфейса) ----------
// Немецкий — по правилам Дудена (Sokolow, Jelena, Schukow, Alissa),
// английский — упрощённая BGN/PCGN (Sokolov, Yelena, Zhukov, Alisa).
// Меняется только показ: в базе имена остаются как их вписали.
const TRANSLIT = {
  de: { а: 'a', б: 'b', в: 'w', г: 'g', д: 'd', е: 'e', ё: 'jo', ж: 'sch', з: 's', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
    п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'ch', ц: 'z', ч: 'tsch', ш: 'sch', щ: 'schtsch', ъ: '', ы: 'y', ь: '', э: 'e',
    ю: 'ju', я: 'ja', і: 'i', ї: 'ji', є: 'je', ґ: 'g' },
  en: { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
    п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e',
    ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' },
};
const CYR_VOWELS = 'аеёиоуыэюяіїє';
const isLetter = c => !!c && /\p{L}/u.test(c);
// у начала и конца слова соседа нет: ''.includes проверять нельзя ('абв'.includes('') === true)
const isVowel = c => !!c && CYR_VOWELS.includes(c);
const oneOf = (c, set) => !!c && set.includes(c);
const translitCache = new Map();

export function translit(text, lang) {
  const map = TRANSLIT[lang];
  const s = String(text ?? '');
  if (!map || !/[Ѐ-ӿ]/.test(s)) return s;
  const key = lang + ':' + s;
  if (translitCache.has(key)) return translitCache.get(key);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], lo = ch.toLowerCase();
    if (!(lo in map)) { out += ch; continue; }
    const prev = (s[i - 1] || '').toLowerCase(), next = (s[i + 1] || '').toLowerCase();
    let r = map[lo];
    // е, ё в начале слова и после гласной или ъ/ь: Jelena / Yelena, Sergejewitsch / Sergeyevich
    if (lo === 'е' && (!isLetter(prev) || isVowel(prev) || prev === 'ъ' || prev === 'ь')) r = lang === 'de' ? 'je' : 'ye';
    if (lo === 'ё' && oneOf(prev, 'жчшщ')) r = 'o';
    // окончания -ий, -ый: Dmitri / Dmitry, Bely
    if ((lo === 'и' || lo === 'ы') && next === 'й' && !isLetter(s[i + 2])) {
      r = lang === 'de' && lo === 'и' ? 'i' : 'y';
      i++;
    }
    if (lang === 'de') {
      // й перед гласной — j (Majer); перед я, ю, ё j уже есть в самой гласной (Maja)
      if (lo === 'й' && isVowel(next)) r = oneOf(next, 'яюё') ? '' : 'j';
      // с между гласными — ss: Alissa, Wassili
      if (lo === 'с' && isVowel(prev) && isVowel(next)) r = 'ss';
    }
    if (ch !== lo && r) r = r[0].toUpperCase() + r.slice(1);
    out += r;
  }
  if (translitCache.size > 5000) translitCache.clear();
  translitCache.set(key, out);
  return out;
}

// Показывать ли имена латиницей: только на английском и немецком, отключается в меню ☰.
export function latinNames() {
  return getLang() !== 'ru' && store.get('ft-translit', true) !== false;
}

// Имя (или любое собственное имя) для показа на экране.
export function nameText(s) {
  return s && latinNames() ? translit(s, getLang()) : (s || '');
}

export function displayName(p) {
  if (!p) return '';
  const parts = [p.first_name, p.last_name].filter(Boolean).map(nameText);
  return parts.join(' ') || t('Без имени');
}

export function fullName(p) {
  if (!p) return '';
  const parts = [p.last_name, p.first_name, p.patronymic].filter(Boolean).map(nameText);
  let s = parts.join(' ') || t('Без имени');
  if (p.maiden_name && p.maiden_name !== p.last_name) s += ' ' + t('(урожд. {name})', { name: nameText(p.maiden_name) });
  return s;
}

// «Имя Отчество» для первой строки карточки
export function givenNames(p) {
  return [p.first_name, p.patronymic].filter(Boolean).map(nameText).join(' ') || t('Без имени');
}

export function initials(p) {
  const a = nameText((p.first_name || '').trim())[0] || '';
  const b = nameText((p.last_name || '').trim())[0] || '';
  return (a + b).toUpperCase() || '?';
}

// Поиск находит человека и по кириллице, и по латинице (немецкой и английской).
export function searchKey(p) {
  const words = [p.last_name, p.first_name, p.patronymic, p.maiden_name].filter(Boolean).join(' ');
  const parts = [words];
  if (/[Ѐ-ӿ]/.test(words)) parts.push(translit(words, 'de'), translit(words, 'en'));
  return normalizeText(parts.join(' '));
}

// русские отчества и они же латиницей (Petrovich, Ivanovna)
const PATRONYMIC_RE = /(вич|вна|ична|инична|ич|оглы|кызы|ovich|evich|ovna|evna|ichna)$/i;

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
  // имя латиницей (немецкие, английские): уверенно угадать нельзя — только «-a» и отчество
  if (/[a-zäöüß]/.test(pat + ln + fn)) {
    if (/(vich|ich)$/.test(pat)) return 'm';
    if (/(vna|ichna)$/.test(pat)) return 'f';
    if (/(ova|eva|ina|skaya|ska)$/.test(ln)) return 'f';
    if (/(ov|ev|sky|skiy|skij|ski)$/.test(ln)) return 'm';
    return /a$/.test(fn) ? 'f' : '';
  }
  if (fn) return 'm';
  return '';
}

// ---------- даты: 'ГГГГ', 'ГГГГ-ММ', 'ГГГГ-ММ-ДД' ----------
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
};

// Названия месяцев для выпадающего списка — на языке интерфейса.
export function monthNames() {
  return MONTHS[getLang()] || MONTHS_NOM;
}

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

// Время с сервера (UTC, ISO) → дата 'ГГГГ-ММ-ДД' по местному времени.
export function localDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '').slice(0, 10);
  return makeDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function yearOf(s) {
  const p = parseDate(s);
  return p ? p.y : null;
}

export function formatDate(s, approx = false) {
  const p = parseDate(s);
  if (!p) return '';
  const lang = getLang();
  let out;
  if (lang === 'ru') {
    if (p.d && p.m) out = `${p.d} ${MONTHS_GEN[p.m - 1]} ${p.y}`;
    else if (p.m) out = `${MONTHS_NOM[p.m - 1]} ${p.y}`;
    else out = String(p.y);
  } else {
    const names = MONTHS[lang];
    if (p.d && p.m) out = lang === 'de' ? `${p.d}. ${names[p.m - 1]} ${p.y}` : `${p.d} ${names[p.m - 1]} ${p.y}`;
    else if (p.m) out = `${names[p.m - 1]} ${p.y}`;
    else out = String(p.y);
  }
  return approx ? t('около {date}', { date: out }) : out;
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
  return bs ? t('р. {year}', { year: bs }) : '';
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
  return tn(age, '{n} год', '{n} года', '{n} лет');
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
