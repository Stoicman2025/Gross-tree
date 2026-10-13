// Языки интерфейса: русский (исходный), английский, немецкий.
//
// Тексты в коде пишутся по-русски и оборачиваются в t('…'): русский текст —
// это и ключ, и перевод по умолчанию. Словари en.js и de.js сопоставляют
// русскому тексту перевод. Подстановки — в фигурных скобках: t('Заметок: {n}', { n }).
//
// Словарь нужного языка загружается до запуска остальных модулей (top-level await),
// поэтому t() можно вызывать и при загрузке модулей. Русскоязычным посетителям
// ничего лишнего не скачивается.

export const LANGS = [
  { code: 'ru', label: 'RU', name: 'Русский', locale: 'ru-RU' },
  { code: 'en', label: 'EN', name: 'English', locale: 'en-GB' },
  { code: 'de', label: 'DE', name: 'Deutsch', locale: 'de-DE' },
];
const CODES = LANGS.map(l => l.code);
const KEY = 'ft-lang';

const loaders = {
  en: () => import('./i18n/en.js'),
  de: () => import('./i18n/de.js'),
};

function readSaved() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}

// Сохранённый выбор; иначе — язык браузера. Если среди языков браузера есть
// русский (или другой язык, где читают по-русски), остаёмся на русском.
function detect() {
  const saved = readSaved();
  if (CODES.includes(saved)) return saved;
  const nav = globalThis.navigator || {};
  const list = (nav.languages && nav.languages.length ? nav.languages : [nav.language || '']).map(l => String(l).toLowerCase().slice(0, 2));
  if (list.some(c => ['ru', 'uk', 'be', 'kk'].includes(c))) return 'ru';
  if (list[0] === 'de') return 'de';
  if (list[0] === 'en') return 'en';
  return 'ru';
}

let lang = 'ru';
let dict = null;

// Переключить язык без перезагрузки страницы (для тестов и первого запуска).
export async function switchLang(code) {
  if (!CODES.includes(code)) code = 'ru';
  let d = null;
  if (code !== 'ru') {
    try { d = (await loaders[code]()).default; } catch (e) { console.error(e); code = 'ru'; }
  }
  lang = code;
  dict = d;
  if (globalThis.document) document.documentElement.lang = code;
}

// Выбор языка посетителем: запоминаем и перезагружаем страницу.
export function setLang(code) {
  if (!CODES.includes(code) || code === lang) return;
  try { localStorage.setItem(KEY, JSON.stringify(code)); } catch { /* приватный режим */ }
  location.reload();
}

export const getLang = () => lang;
export const locale = () => LANGS.find(l => l.code === lang).locale;

function fill(s, params) {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k] ?? '') : m));
}

export function t(text, params) {
  const tr = dict && typeof dict[text] === 'string' ? dict[text] : text;
  return fill(tr, params);
}

// Число с формой слова. Русские формы — «один / несколько / много»;
// в словаре по форме «много» лежит пара [один, много].
export function tn(n, one, few, many, params = {}) {
  const p = { n, ...params };
  const pair = dict && Array.isArray(dict[many]) ? dict[many] : null;
  if (pair) return fill(n === 1 ? pair[0] : pair[1], p);
  const n10 = n % 10, n100 = n % 100;
  const form = n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20) ? few : many;
  return fill(form, p);
}

// Тексты в index.html: элементы с data-t и атрибуты placeholder/title/aria-label.
export function translateDom(root = document) {
  if (lang === 'ru') return;
  root.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.textContent.trim()); });
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    root.querySelectorAll(`[${attr}]`).forEach(el => el.setAttribute(attr, t(el.getAttribute(attr))));
  }
}

await switchLang(detect());
