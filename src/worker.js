// ============================================================
// Семейное дерево — серверная часть (Cloudflare Worker)
//
// Статика (папка public/) отдаётся Cloudflare напрямую.
// Здесь обрабатываются только /api/* и /photos/*.
//
// Привязки (wrangler.jsonc):  DB — база D1, PHOTOS — хранилище KV.
// Секреты (Settings → Variables and Secrets):
//   ADMIN_PASSWORD — пароль администратора;
//   FAMILY_CODE    — начальный семейный код (потом меняется на сайте).
//
// Доступ: после ввода семейного кода браузер получает cookie сессии
// (180 дней), после входа администратора — отдельную cookie (30 дней).
//
// Модерация: всё, что присылают родственники, сразу записывается в базу
// с пометкой state = 'pending' (на дереве — бледные карточки) и связывается
// с заявкой (submission_id). Администратор одобряет заявку — записи
// становятся 'approved'; отклоняет — записи удаляются.
// ============================================================

const SCHEMA_VERSION = '2';
const FAMILY_DAYS = 180;
const ADMIN_DAYS = 30;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 200 * 1024;
const MAX_PENDING = 300;
const MAX_STATEMENTS = 40; // запас до лимита бесплатного D1 (50 запросов за вызов)

const PERSON_TEXT = ['first_name', 'patronymic', 'last_name', 'maiden_name', 'gender', 'birth_date', 'birth_place',
  'death_date', 'death_place', 'occupation', 'bio'];
const PERSON_BOOL = ['birth_approx', 'is_deceased', 'death_approx'];
const UNION_STATUS = ['married', 'divorced', 'widowed', 'partner'];
const KINDS = ['new_person', 'edit_person', 'add_photo', 'add_note'];
const STATE_TABLES = ['people', 'parent_child', 'unions', 'photos', 'notes'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '', patronymic TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
    maiden_name TEXT NOT NULL DEFAULT '', gender TEXT NOT NULL DEFAULT '',
    birth_date TEXT NOT NULL DEFAULT '', birth_approx INTEGER NOT NULL DEFAULT 0, birth_place TEXT NOT NULL DEFAULT '',
    is_deceased INTEGER NOT NULL DEFAULT 0, death_date TEXT NOT NULL DEFAULT '', death_approx INTEGER NOT NULL DEFAULT 0,
    death_place TEXT NOT NULL DEFAULT '', occupation TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
    main_photo_id TEXT, state TEXT NOT NULL DEFAULT 'approved', submission_id TEXT, added_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS parent_child (
    parent_id TEXT NOT NULL, child_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'birth',
    state TEXT NOT NULL DEFAULT 'approved', submission_id TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id))`,
  `CREATE INDEX IF NOT EXISTS parent_child_child ON parent_child (child_id)`,
  `CREATE TABLE IF NOT EXISTS unions (
    id TEXT PRIMARY KEY, partner1_id TEXT NOT NULL, partner2_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'married',
    start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'approved', submission_id TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL, path TEXT NOT NULL, thumb_path TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'approved', submission_id TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS photos_person ON photos (person_id)`,
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL, text TEXT NOT NULL, author_name TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'approved', submission_id TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS notes_person ON notes (person_id)`,
  `CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_person_id TEXT, payload TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, reviewed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS submissions_status ON submissions (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS attempts_ip ON attempts (ip, kind, at)`,
  `CREATE TABLE IF NOT EXISTS uploads (path TEXT PRIMARY KEY, uploader TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS uploads_uploader ON uploads (uploader, created_at)`,
];

// Обновление базы, созданной первой версией: новые поля. На новой базе
// эти команды просто не нужны — ошибки «столбец уже есть» пропускаются.
const MIGRATIONS = [
  `ALTER TABLE people ADD COLUMN state TEXT NOT NULL DEFAULT 'approved'`,
  `ALTER TABLE people ADD COLUMN submission_id TEXT`,
  `ALTER TABLE people ADD COLUMN added_by TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE parent_child ADD COLUMN state TEXT NOT NULL DEFAULT 'approved'`,
  `ALTER TABLE parent_child ADD COLUMN submission_id TEXT`,
  `ALTER TABLE unions ADD COLUMN state TEXT NOT NULL DEFAULT 'approved'`,
  `ALTER TABLE unions ADD COLUMN submission_id TEXT`,
  `ALTER TABLE photos ADD COLUMN state TEXT NOT NULL DEFAULT 'approved'`,
  `ALTER TABLE photos ADD COLUMN submission_id TEXT`,
];

let schemaReady = false;

// ---------- ответы ----------
// Ответ создаётся через одну функцию: локальный демо-режим подменяет её,
// чтобы запускать этот же сервер прямо в браузере.
function makeResponse(body, init) {
  return globalThis.__ftMakeResponse ? globalThis.__ftMakeResponse(body, init) : new Response(body, init);
}

function json(data, status = 200, extra) {
  const h = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (extra) for (const [k, v] of extra) h.append(k, v);
  return makeResponse(JSON.stringify(data), { status, headers: h });
}
const fail = (status, error, code) => json({ error, code: code || undefined }, status);

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// ---------- утилиты ----------
const nowIso = () => new Date().toISOString();
const nowSec = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256hex('cmp:' + a), sha256hex('cmp:' + b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const normalizeCode = c => String(c || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

const clientIp = request => request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';

function str(v, max = 2000) { return String(v ?? '').trim().slice(0, max); }
const marks = arr => arr.map(() => '?').join(',');

function cleanPerson(p, partial = false) {
  const out = {};
  for (const f of PERSON_TEXT) {
    if (partial && !(f in p)) continue;
    out[f] = str(p[f], f === 'bio' ? 20000 : 300);
  }
  for (const f of PERSON_BOOL) {
    if (partial && !(f in p)) continue;
    out[f] = p[f] ? 1 : 0;
  }
  if (!partial || 'main_photo_id' in p) out.main_photo_id = p.main_photo_id ? str(p.main_photo_id, 64) : null;
  if ('gender' in out && !['m', 'f', ''].includes(out.gender)) out.gender = '';
  return out;
}

function personOut(r) {
  if (!r) return r;
  const o = { ...r };
  for (const f of PERSON_BOOL) o[f] = !!o[f];
  return o;
}

// На бесплатном тарифе — не больше 50 запросов к базе за вызов,
// поэтому списки обрабатываются пачками через IN (…).
function chunks(arr, n = 90) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// ---------- схема ----------
async function ensureSchema(env) {
  if (schemaReady) return;
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first();
    if (row && row.value === SCHEMA_VERSION) { schemaReady = true; return; }
  } catch { /* таблиц ещё нет */ }
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  for (const m of MIGRATIONS) {
    try { await env.DB.prepare(m).run(); } catch { /* столбец уже есть */ }
  }
  await env.DB.batch([
    ...STATE_TABLES.map(t => env.DB.prepare(`CREATE INDEX IF NOT EXISTS ${t}_submission ON ${t} (submission_id)`)),
    env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('title', 'Семейное дерево')`),
    env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)`).bind(SCHEMA_VERSION),
  ]);
  schemaReady = true;
}

async function getSetting(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first();
  return row ? row.value : null;
}

// ---------- сессии ----------
async function getAuth(request, env) {
  const c = parseCookies(request);
  const hashes = [];
  if (c.ft_s) hashes.push(await sha256hex(c.ft_s));
  if (c.ft_a) hashes.push(await sha256hex(c.ft_a));
  const auth = { family: false, admin: false };
  if (!hashes.length) return auth;
  const { results } = await env.DB.prepare(
    `SELECT kind FROM sessions WHERE id_hash IN (${marks(hashes)}) AND expires_at > ?`,
  ).bind(...hashes, nowSec()).all();
  for (const r of results) {
    if (r.kind === 'admin') auth.admin = true;
    if (r.kind === 'family') auth.family = true;
  }
  if (auth.admin) auth.family = true;
  auth.uploader = c.ft_a ? 'a:' + (await sha256hex(c.ft_a)).slice(0, 16) : c.ft_s ? 'f:' + (await sha256hex(c.ft_s)).slice(0, 16) : '';
  return auth;
}

async function createSession(env, kind, days) {
  const token = randomToken();
  const t = nowSec();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(t),
    env.DB.prepare(`INSERT INTO sessions (id_hash, kind, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .bind(await sha256hex(token), kind, t + days * 86400, t),
  ]);
  return token;
}

// Защита от подбора: не больше limit ошибок за час с одного адреса.
async function checkAttempts(env, ip, kind, limit) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE ip = ? AND kind = ? AND at > ?`)
    .bind(ip, kind, nowSec() - 3600).first();
  if (row && row.n >= limit) throw new HttpError(429, 'Слишком много попыток. Попробуйте через час.', 'rate_limited');
}
async function recordAttempt(env, ip, kind) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO attempts (ip, kind, at) VALUES (?, ?, ?)`).bind(ip, kind, nowSec()),
    env.DB.prepare(`DELETE FROM attempts WHERE at < ?`).bind(nowSec() - 86400),
  ]);
}

async function familyCodeOk(env, code) {
  const hash = await getSetting(env, 'family_code_hash');
  if (hash) {
    const salt = (await getSetting(env, 'family_code_salt')) || '';
    return safeEqual(hash, await sha256hex(salt + normalizeCode(code)));
  }
  if (!env.FAMILY_CODE) {
    // подсказка для владельца — в журнале сервера, посетителям не показываем
    console.warn('FAMILY_CODE не найден: добавьте секрет FAMILY_CODE в Settings → Variables and Secrets этого Worker');
    throw new HttpError(503, 'Сайт ещё не настроен. Сообщите администратору.', 'not_configured');
  }
  return safeEqual(normalizeCode(env.FAMILY_CODE), normalizeCode(code));
}

// ---------- запросы ----------
async function readJson(request, maxBytes = MAX_PAYLOAD_BYTES) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Слишком большой объём данных');
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'Неверный формат запроса'); }
}

function requireFamily(auth) { if (!auth.family) throw new HttpError(401, 'Нужно ввести семейный код', 'locked'); }
function requireAdmin(auth) { if (!auth.admin) throw new HttpError(403, 'Нужно войти как администратор', 'not_admin'); }

// ---------- обработчики ----------
async function apiSession(request, env, auth) {
  return json({ family: auth.family, admin: auth.admin, adminConfigured: !!env.ADMIN_PASSWORD });
}

async function apiUnlock(request, env) {
  const ip = clientIp(request);
  await checkAttempts(env, ip, 'family', 30);
  const { code } = await readJson(request, 2000);
  if (!(await familyCodeOk(env, code))) {
    await recordAttempt(env, ip, 'family');
    throw new HttpError(401, 'Неверный семейный код', 'bad_code');
  }
  const token = await createSession(env, 'family', FAMILY_DAYS);
  return json({ ok: true }, 200, [['Set-Cookie', cookie('ft_s', token, FAMILY_DAYS * 86400)]]);
}

async function apiLogout(request, env) {
  const c = parseCookies(request);
  const stmts = [];
  for (const t of [c.ft_s, c.ft_a]) if (t) stmts.push(env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await sha256hex(t)));
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true }, 200, [['Set-Cookie', cookie('ft_s', '', 0)], ['Set-Cookie', cookie('ft_a', '', 0)]]);
}

async function apiTree(request, env, auth) {
  requireFamily(auth);
  const [title, people, pc, unions, photos, notes] = await env.DB.batch([
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'title'`),
    env.DB.prepare(`SELECT * FROM people ORDER BY created_at, id`),
    env.DB.prepare(`SELECT * FROM parent_child ORDER BY created_at`),
    env.DB.prepare(`SELECT * FROM unions ORDER BY created_at`),
    env.DB.prepare(`SELECT * FROM photos ORDER BY created_at`),
    env.DB.prepare(`SELECT id, person_id, text, author_name, state, created_at FROM notes ORDER BY created_at`),
  ]);
  return json({
    title: title.results[0]?.value || 'Семейное дерево',
    people: people.results.map(personOut),
    parent_child: pc.results,
    unions: unions.results,
    photos: photos.results,
    notes: notes.results,
  });
}

// ---------- заявки родственников ----------
// Всё добавляемое сразу записывается в базу «на проверке». Правки
// неподтверждённых записей применяются сразу (их всё равно проверит админ),
// правки и удаления подтверждённых — ждут решения администратора.
async function apiSubmit(request, env, auth) {
  requireFamily(auth);
  const DB = env.DB;
  const body = await readJson(request);
  const kind = body.kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Неизвестный тип заявки');
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : null;
  if (!payload) throw new HttpError(400, 'Пустая заявка');
  const author = str(body.author, 200);
  const comment = str(body.comment, 4000);

  const { results: ppl } = await DB.prepare(`SELECT id, state FROM people`).all();
  const stateOf = new Map(ppl.map(p => [p.id, p.state]));
  let target = body.target ? str(body.target, 64) : null;
  if (kind !== 'new_person' && !stateOf.has(target)) throw new HttpError(404, 'Человек, к которому относится заявка, не найден');
  const pendingCount = await DB.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'`).first();
  if (pendingCount.n >= MAX_PENDING) throw new HttpError(429, 'Слишком много заявок ждут проверки. Попробуйте позже.');

  const sid = crypto.randomUUID();
  const t = nowIso();
  const stmts = [];
  const created = { main: null, refs: {} };
  const rel = payload.relations && typeof payload.relations === 'object' ? payload.relations : {};
  const adds = Array.isArray(rel.add) ? rel.add.filter(r => r && typeof r === 'object') : [];
  const removes = Array.isArray(rel.remove) ? rel.remove.filter(r => r && typeof r === 'object') : [];
  const updates = Array.isArray(rel.update) ? rel.update.filter(r => r && typeof r === 'object') : [];
  const photos = Array.isArray(payload.photos) ? payload.photos.filter(p => p && /^p\/[0-9a-f-]{36}\.jpg$/.test(p.path)) : [];
  let personPatch = payload.person && typeof payload.person === 'object' ? payload.person : {};
  let pendingRows = 0;   // записи «на проверке», появившиеся из этой заявки
  let appliedNow = false;

  const newPerson = p => {
    const id = crypto.randomUUID();
    const c = cleanPerson(p && typeof p === 'object' ? p : {});
    c.main_photo_id = null;
    const cols = ['id', ...Object.keys(c), 'state', 'submission_id', 'added_by', 'created_at', 'updated_at'];
    stmts.push(DB.prepare(`INSERT INTO people (${cols.join(',')}) VALUES (${marks(cols)})`)
      .bind(id, ...Object.values(c), 'pending', sid, author, t, t));
    stateOf.set(id, 'pending');
    pendingRows++;
    return id;
  };

  if (kind === 'new_person') {
    target = newPerson(personPatch);
    created.main = target;
    personPatch = {};
  } else if (stateOf.get(target) === 'pending' && Object.keys(personPatch).length) {
    // неподтверждённую карточку можно исправлять сразу
    const c = cleanPerson(personPatch, true);
    delete c.main_photo_id;
    const keys = Object.keys(c);
    if (keys.length) {
      stmts.push(DB.prepare(`UPDATE people SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...Object.values(c), t, target));
      appliedNow = true;
    }
    personPatch = {};
  }

  let tUnions = [], tLinks = [];
  if (kind !== 'new_person') {
    [{ results: tUnions }, { results: tLinks }] = await DB.batch([
      DB.prepare(`SELECT id, partner1_id, partner2_id, state FROM unions WHERE partner1_id = ? OR partner2_id = ?`).bind(target, target),
      DB.prepare(`SELECT parent_id, child_id, state FROM parent_child WHERE parent_id = ? OR child_id = ?`).bind(target, target),
    ]);
  }
  const unionOf = (a, b) => tUnions.find(u => (u.partner1_id === a && u.partner2_id === b) || (u.partner1_id === b && u.partner2_id === a));

  const keyMap = new Map();
  const resolve = (ref, i) => {
    if (!ref || typeof ref !== 'object') return null;
    if (ref.id && stateOf.has(String(ref.id))) return String(ref.id);
    if (ref.new && typeof ref.new === 'object') {
      const id = newPerson(ref.new);
      created.refs[i] = id;
      return id;
    }
    return null;
  };
  const link = (p, c, k = 'birth') => {
    if (!p || !c || p === c) return;
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO parent_child (parent_id, child_id, kind, state, submission_id, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)`).bind(p, c, k === 'adopted' ? 'adopted' : 'birth', sid, t));
    pendingRows++;
  };

  adds.forEach((r, i) => {
    if (r.type !== 'partner') return;
    const q = resolve(r.ref, i);
    if (!q || q === target) return;
    if (r.key) keyMap.set(String(r.key), q);
    if (!unionOf(target, q)) {
      const status = UNION_STATUS.includes(r.status) ? r.status : 'married';
      stmts.push(DB.prepare(`INSERT INTO unions (id, partner1_id, partner2_id, status, state, submission_id, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)`).bind(crypto.randomUUID(), target, q, status, sid, t));
      tUnions.push({ partner1_id: target, partner2_id: q, state: 'pending' });
      pendingRows++;
    }
  });
  adds.forEach((r, i) => { if (r.type === 'parent') link(resolve(r.ref, i), target, r.kind); });
  adds.forEach((r, i) => {
    if (r.type !== 'child') return;
    const c = resolve(r.ref, i);
    if (!c) return;
    link(target, c);
    let other = null;
    if (r.otherParent && r.otherParent.id && stateOf.has(String(r.otherParent.id))) other = String(r.otherParent.id);
    else if (r.otherParent && r.otherParent.key) other = keyMap.get(String(r.otherParent.key)) || null;
    if (other && other !== c) link(other, c);
  });

  // удаления и смена статуса брака: свои неподтверждённые связи — сразу, остальное — админу
  const keptRemoves = [], keptUpdates = [];
  for (const r of removes) {
    const id = str(r.id, 64);
    if (r.type === 'parent' || r.type === 'child') {
      const [p, c] = r.type === 'parent' ? [id, target] : [target, id];
      const row = tLinks.find(x => x.parent_id === p && x.child_id === c);
      if (!row) continue;
      if (row.state === 'pending') {
        stmts.push(DB.prepare(`DELETE FROM parent_child WHERE parent_id = ? AND child_id = ?`).bind(p, c));
        appliedNow = true;
      } else keptRemoves.push({ type: r.type, id });
    } else if (r.type === 'partner') {
      const u = unionOf(target, id);
      if (!u) continue;
      if (u.state === 'pending' && u.id) {
        stmts.push(DB.prepare(`DELETE FROM unions WHERE id = ?`).bind(u.id));
        appliedNow = true;
      } else keptRemoves.push({ type: 'partner', id });
    }
  }
  for (const r of updates) {
    if (r.type !== 'partner' || !UNION_STATUS.includes(r.status)) continue;
    const id = str(r.id, 64);
    const u = unionOf(target, id);
    if (u && u.state === 'pending' && u.id) {
      stmts.push(DB.prepare(`UPDATE unions SET status = ? WHERE id = ?`).bind(r.status, u.id));
      appliedNow = true;
    } else keptUpdates.push({ type: 'partner', id, status: r.status });
  }

  for (const ph of photos) {
    stmts.push(DB.prepare(`INSERT INTO photos (id, person_id, path, thumb_path, caption, state, submission_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(crypto.randomUUID(), target, ph.path, /^p\/[0-9a-f-]{36}_t\.jpg$/.test(ph.thumb_path) ? ph.thumb_path : '', str(ph.caption, 500), sid, t));
    pendingRows++;
  }

  if (kind === 'add_note') {
    const text = str(payload.note && payload.note.text, 10000);
    if (!text) throw new HttpError(400, 'Заметка пустая');
    stmts.push(DB.prepare(`INSERT INTO notes (id, person_id, text, author_name, state, submission_id, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`).bind(crypto.randomUUID(), target, text, author, sid, t));
    pendingRows++;
  }

  const needsReview = kind === 'new_person' || pendingRows > 0 || Object.keys(personPatch).length > 0 || keptRemoves.length || keptUpdates.length;
  if (needsReview) {
    const stored = { ...payload, person: personPatch, relations: { add: adds, remove: keptRemoves, update: keptUpdates }, materialized: true, created };
    if (kind === 'add_note') stored.note = { text: str(payload.note && payload.note.text, 10000) };
    stmts.push(DB.prepare(`INSERT INTO submissions (id, kind, target_person_id, payload, author_name, comment, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).bind(sid, kind, target, JSON.stringify(stored), author, comment, t));
  }
  if (stmts.length > MAX_STATEMENTS) {
    throw new HttpError(413, 'Слишком много изменений в одной анкете. Разделите их на несколько анкет.');
  }
  if (stmts.length) await DB.batch(stmts);
  return json({ id: needsReview ? sid : null, created, target, applied: appliedNow && !needsReview });
}

function isJpeg(bytes) { return bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF; }

async function apiUpload(request, env, auth) {
  requireFamily(auth);
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM uploads WHERE uploader = ? AND created_at > ?`)
    .bind(auth.uploader, nowSec() - 86400).first();
  if (!auth.admin && recent.n >= 300) throw new HttpError(429, 'Слишком много фото за сутки. Попробуйте завтра.');
  const form = await request.formData();
  const id = crypto.randomUUID();
  const files = [['full', `p/${id}.jpg`], ['thumb', `p/${id}_t.jpg`]];
  const blobs = [];
  for (const [field, key] of files) {
    const f = form.get(field);
    if (!f || typeof f === 'string') throw new HttpError(400, 'Файл не получен');
    const buf = await f.arrayBuffer();
    if (buf.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'Фото слишком большое (больше 4 МБ)');
    if (!isJpeg(new Uint8Array(buf, 0, Math.min(4, buf.byteLength)))) throw new HttpError(415, 'Поддерживаются только фотографии JPEG');
    blobs.push([key, buf]);
  }
  try {
    for (const [key, buf] of blobs) {
      await env.PHOTOS.put(key, buf, { metadata: { type: 'image/jpeg', by: auth.uploader } });
    }
  } catch (e) {
    throw new HttpError(507, 'Не удалось сохранить фото: возможно, исчерпан дневной лимит хранилища. Попробуйте завтра.');
  }
  const t = nowSec();
  await env.DB.batch(blobs.map(([key]) =>
    env.DB.prepare(`INSERT OR REPLACE INTO uploads (path, uploader, created_at) VALUES (?, ?, ?)`).bind(key, auth.uploader, t)));
  return json({ path: files[0][1], thumb_path: files[1][1] });
}

async function servePhoto(request, env, auth, key) {
  if (!auth.family) return makeResponse('Нужно ввести семейный код', { status: 401 });
  if (!/^p\/[0-9a-f-]{36}(_t)?\.jpg$/.test(key)) return makeResponse('Not found', { status: 404 });
  const obj = await env.PHOTOS.get(key, { type: 'stream' });
  if (!obj) return makeResponse('Not found', { status: 404 });
  return makeResponse(obj, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ---------- администратор ----------
async function apiAdminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    console.warn('ADMIN_PASSWORD не найден: добавьте секрет ADMIN_PASSWORD в Settings → Variables and Secrets этого Worker');
    throw new HttpError(503, 'Вход администратора ещё не настроен.', 'not_configured');
  }
  const ip = clientIp(request);
  await checkAttempts(env, ip, 'admin', 10);
  const { password } = await readJson(request, 2000);
  if (!(await safeEqual(String(password || ''), String(env.ADMIN_PASSWORD)))) {
    await recordAttempt(env, ip, 'admin');
    throw new HttpError(401, 'Неверный пароль', 'bad_password');
  }
  const token = await createSession(env, 'admin', ADMIN_DAYS);
  return json({ ok: true }, 200, [['Set-Cookie', cookie('ft_a', token, ADMIN_DAYS * 86400)]]);
}

async function apiAdminLogout(request, env) {
  const c = parseCookies(request);
  if (c.ft_a) await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await sha256hex(c.ft_a)).run();
  return json({ ok: true }, 200, [['Set-Cookie', cookie('ft_a', '', 0)]]);
}

async function insertPerson(env, p) {
  const id = p.id && /^[\w-]{1,64}$/.test(p.id) ? p.id : crypto.randomUUID();
  const c = cleanPerson(p);
  const t = nowIso();
  const cols = ['id', ...Object.keys(c), 'created_at', 'updated_at'];
  await env.DB.prepare(`INSERT INTO people (${cols.join(',')}) VALUES (${marks(cols)})`)
    .bind(id, ...Object.values(c), t, t).run();
  return personOut(await env.DB.prepare(`SELECT * FROM people WHERE id = ?`).bind(id).first());
}

async function updatePerson(env, id, patch) {
  const c = cleanPerson(patch, true);
  const keys = Object.keys(c);
  if (keys.length) {
    await env.DB.prepare(`UPDATE people SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...Object.values(c), nowIso(), id).run();
  }
  const row = await env.DB.prepare(`SELECT * FROM people WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Человек не найден');
  return personOut(row);
}

async function deleteFiles(env, keys) {
  const valid = [...new Set(keys.filter(k => k && /^p\//.test(k)))];
  for (const k of valid) await env.PHOTOS.delete(k);
  for (const part of chunks(valid)) {
    await env.DB.prepare(`DELETE FROM uploads WHERE path IN (${marks(part)})`).bind(...part).run();
  }
}

// Удаление людей вместе со всем, что к ним привязано.
async function deletePeople(env, ids, extraStmts = []) {
  const DB = env.DB;
  const stmts = [...extraStmts];
  const files = [];
  for (const part of chunks(ids, 45)) {
    const { results } = await DB.prepare(`SELECT path, thumb_path FROM photos WHERE person_id IN (${marks(part)})`).bind(...part).all();
    files.push(...results.flatMap(p => [p.path, p.thumb_path]));
    stmts.push(
      DB.prepare(`DELETE FROM photos WHERE person_id IN (${marks(part)})`).bind(...part),
      DB.prepare(`DELETE FROM notes WHERE person_id IN (${marks(part)})`).bind(...part),
      DB.prepare(`DELETE FROM parent_child WHERE parent_id IN (${marks(part)}) OR child_id IN (${marks(part)})`).bind(...part, ...part),
      DB.prepare(`DELETE FROM unions WHERE partner1_id IN (${marks(part)}) OR partner2_id IN (${marks(part)})`).bind(...part, ...part),
      DB.prepare(`UPDATE submissions SET target_person_id = NULL WHERE target_person_id IN (${marks(part)})`).bind(...part),
      DB.prepare(`DELETE FROM people WHERE id IN (${marks(part)})`).bind(...part),
    );
  }
  await deleteFiles(env, files);
  if (stmts.length) await DB.batch(stmts);
}

// Объединение двух карточек одного человека: всё переносится на into.
async function mergePeople(env, from, into) {
  const DB = env.DB;
  if (!from || !into || from === into) throw new HttpError(400, 'Нужно выбрать двух разных людей');
  const [{ results: [a] }, { results: [b] }] = await DB.batch([
    DB.prepare(`SELECT * FROM people WHERE id = ?`).bind(from),
    DB.prepare(`SELECT * FROM people WHERE id = ?`).bind(into),
  ]);
  if (!a || !b) throw new HttpError(404, 'Человек не найден');
  // у основной карточки заполняем пустые поля данными второй
  const patch = {};
  for (const f of PERSON_TEXT) if (!b[f] && a[f]) patch[f] = a[f];
  for (const f of PERSON_BOOL) if (!b[f] && a[f]) patch[f] = 1;
  if (!b.main_photo_id && a.main_photo_id) patch.main_photo_id = a.main_photo_id;
  const pk = Object.keys(patch);
  const stmts = [
    DB.prepare(`UPDATE OR IGNORE parent_child SET parent_id = ? WHERE parent_id = ?`).bind(into, from),
    DB.prepare(`DELETE FROM parent_child WHERE parent_id = ?`).bind(from),
    DB.prepare(`UPDATE OR IGNORE parent_child SET child_id = ? WHERE child_id = ?`).bind(into, from),
    DB.prepare(`DELETE FROM parent_child WHERE child_id = ?`).bind(from),
    DB.prepare(`DELETE FROM parent_child WHERE parent_id = child_id`),
    DB.prepare(`UPDATE unions SET partner1_id = ? WHERE partner1_id = ?`).bind(into, from),
    DB.prepare(`UPDATE unions SET partner2_id = ? WHERE partner2_id = ?`).bind(into, from),
    DB.prepare(`DELETE FROM unions WHERE partner1_id = partner2_id`),
    DB.prepare(`DELETE FROM unions WHERE id IN (
      SELECT u2.id FROM unions u1 JOIN unions u2 ON u1.id < u2.id
       AND ((u1.partner1_id = u2.partner1_id AND u1.partner2_id = u2.partner2_id)
         OR (u1.partner1_id = u2.partner2_id AND u1.partner2_id = u2.partner1_id))
      WHERE ? IN (u2.partner1_id, u2.partner2_id))`).bind(into),
    DB.prepare(`UPDATE photos SET person_id = ? WHERE person_id = ?`).bind(into, from),
    DB.prepare(`UPDATE notes SET person_id = ? WHERE person_id = ?`).bind(into, from),
    DB.prepare(`UPDATE submissions SET target_person_id = ? WHERE target_person_id = ?`).bind(into, from),
    DB.prepare(`DELETE FROM people WHERE id = ?`).bind(from),
  ];
  if (pk.length) {
    stmts.push(DB.prepare(`UPDATE people SET ${pk.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...pk.map(k => patch[k]), nowIso(), into));
  }
  await DB.batch(stmts);
}

async function approveSubmission(env, id, body) {
  const DB = env.DB;
  const s = await DB.prepare(`SELECT * FROM submissions WHERE id = ?`).bind(id).first();
  if (!s) throw new HttpError(404, 'Заявка не найдена');
  if (s.status !== 'pending') throw new HttpError(409, 'Эта заявка уже рассмотрена');
  const p = safeParse(s.payload);
  if (!p.materialized) throw new HttpError(400, 'Заявка старого формата', 'legacy');
  const target = s.target_person_id;
  const t = nowIso();
  const stmts = [];
  if (!body.skipEdits && target) {
    const c = cleanPerson(p.person || {}, true);
    delete c.main_photo_id;
    const keys = Object.keys(c);
    if (keys.length) {
      stmts.push(DB.prepare(`UPDATE people SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...Object.values(c), t, target));
    }
    for (const r of (p.relations && p.relations.remove) || []) {
      if (r.type === 'parent') stmts.push(DB.prepare(`DELETE FROM parent_child WHERE parent_id = ? AND child_id = ?`).bind(r.id, target));
      if (r.type === 'child') stmts.push(DB.prepare(`DELETE FROM parent_child WHERE parent_id = ? AND child_id = ?`).bind(target, r.id));
      if (r.type === 'partner') stmts.push(DB.prepare(`DELETE FROM unions WHERE (partner1_id = ? AND partner2_id = ?) OR (partner1_id = ? AND partner2_id = ?)`).bind(target, r.id, r.id, target));
    }
    for (const r of (p.relations && p.relations.update) || []) {
      if (r.type === 'partner' && UNION_STATUS.includes(r.status)) {
        stmts.push(DB.prepare(`UPDATE unions SET status = ? WHERE (partner1_id = ? AND partner2_id = ?) OR (partner1_id = ? AND partner2_id = ?)`)
          .bind(r.status, target, r.id, r.id, target));
      }
    }
  }
  for (const tbl of STATE_TABLES) stmts.push(DB.prepare(`UPDATE ${tbl} SET state = 'approved' WHERE submission_id = ?`).bind(id));
  // главное фото — первое одобренное, если его ещё нет
  stmts.push(DB.prepare(`UPDATE people SET main_photo_id = (
      SELECT f.id FROM photos f WHERE f.person_id = people.id AND f.state = 'approved' ORDER BY f.created_at LIMIT 1)
    WHERE main_photo_id IS NULL AND id IN (SELECT person_id FROM photos WHERE submission_id = ?)`).bind(id));
  stmts.push(DB.prepare(`UPDATE submissions SET status = 'approved', admin_note = ?, reviewed_at = ? WHERE id = ?`)
    .bind(str(body.admin_note, 2000), t, id));
  await DB.batch(stmts);
}

async function rejectSubmission(env, id, body) {
  const DB = env.DB;
  const s = await DB.prepare(`SELECT * FROM submissions WHERE id = ?`).bind(id).first();
  if (!s) throw new HttpError(404, 'Заявка не найдена');
  if (s.status !== 'pending') throw new HttpError(409, 'Эта заявка уже рассмотрена');
  const p = safeParse(s.payload);
  const final = DB.prepare(`UPDATE submissions SET status = 'rejected', admin_note = ?, reviewed_at = ? WHERE id = ?`)
    .bind(str(body.admin_note, 2000), nowIso(), id);
  if (p.materialized) {
    const [{ results: people }, { results: photos }] = await DB.batch([
      DB.prepare(`SELECT id FROM people WHERE submission_id = ? AND state = 'pending'`).bind(id),
      DB.prepare(`SELECT path, thumb_path FROM photos WHERE submission_id = ? AND state = 'pending'`).bind(id),
    ]);
    await deleteFiles(env, photos.flatMap(x => [x.path, x.thumb_path]));
    await deletePeople(env, people.map(x => x.id), [
      DB.prepare(`DELETE FROM parent_child WHERE submission_id = ? AND state = 'pending'`).bind(id),
      DB.prepare(`DELETE FROM unions WHERE submission_id = ? AND state = 'pending'`).bind(id),
      DB.prepare(`DELETE FROM photos WHERE submission_id = ? AND state = 'pending'`).bind(id),
      DB.prepare(`DELETE FROM notes WHERE submission_id = ? AND state = 'pending'`).bind(id),
      final,
    ]);
  } else {
    // заявка старого формата: удаляем только присланные файлы, если они ни к кому не прикреплены
    const keys = (p.photos || []).flatMap(x => [x.path, x.thumb_path]).filter(k => k && /^p\//.test(k));
    const used = new Set();
    for (const part of chunks(keys, 45)) {
      const { results } = await DB.prepare(`SELECT path, thumb_path FROM photos WHERE path IN (${marks(part)}) OR thumb_path IN (${marks(part)})`)
        .bind(...part, ...part).all();
      for (const r of results) { used.add(r.path); used.add(r.thumb_path); }
    }
    await deleteFiles(env, keys.filter(k => !used.has(k)));
    await final.run();
  }
}

// Вставка многих строк малым числом запросов: строки передаются JSON-параметром.
// Параметр в D1 — не больше 2 МБ, поэтому крупные таблицы делятся на части
// (с запасом: символ кириллицы в UTF-8 занимает 2 байта).
const JSON_CHUNK_CHARS = 500000;
function jsonInserts(DB, table, cols, rows, verb = 'INSERT') {
  const sql = `${verb} INTO ${table} (${cols.join(',')}) SELECT ${cols.map(c => `json_extract(value, '$.${c}')`).join(',')} FROM json_each(?)`;
  const out = [];
  let part = [], size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (part.length && size + s.length + 1 > JSON_CHUNK_CHARS) { out.push(part); part = []; size = 2; }
    part.push(s); size += s.length + 1;
  }
  if (part.length) out.push(part);
  return out.map(p => DB.prepare(sql).bind(`[${p.join(',')}]`));
}

async function importData(env, body) {
  const people = Array.isArray(body.people) ? body.people : [];
  const unions = Array.isArray(body.unions) ? body.unions : [];
  const pc = Array.isArray(body.parent_child) ? body.parent_child : [];
  const t = nowIso();
  const pRows = people.map(p => ({ id: str(p.id, 64) || crypto.randomUUID(), ...cleanPerson(p), created_at: t, updated_at: t }));
  const uRows = unions.map(u => ({
    id: str(u.id, 64) || crypto.randomUUID(), partner1_id: str(u.partner1_id, 64), partner2_id: str(u.partner2_id, 64),
    status: UNION_STATUS.includes(u.status) ? u.status : 'married', start_date: str(u.start_date, 20), end_date: str(u.end_date, 20), created_at: t,
  }));
  const cRows = pc.map(r => ({ parent_id: str(r.parent_id, 64), child_id: str(r.child_id, 64), kind: r.kind === 'adopted' ? 'adopted' : 'birth', created_at: t }))
    .filter(r => r.parent_id && r.child_id && r.parent_id !== r.child_id);
  const pCols = ['id', ...PERSON_TEXT, ...PERSON_BOOL, 'main_photo_id', 'created_at', 'updated_at'];
  const stmts = [
    ...jsonInserts(env.DB, 'people', pCols, pRows.map(r => ({ ...r, main_photo_id: null }))),
    ...jsonInserts(env.DB, 'unions', ['id', 'partner1_id', 'partner2_id', 'status', 'start_date', 'end_date', 'created_at'], uRows),
    ...jsonInserts(env.DB, 'parent_child', ['parent_id', 'child_id', 'kind', 'created_at'], cRows, 'INSERT OR IGNORE'),
  ];
  if (stmts.length) await env.DB.batch(stmts);
  return { people: pRows.length, unions: uRows.length, parent_child: cRows.length };
}

// Восстановление из резервной копии (файл из «Скачать резервную копию»):
// люди, связи, фото (записи о них), заметки и заявки заменяются данными из файла.
// Сами фото в хранилище не трогаем, сессии и семейный код — тоже.
// Пачка запросов D1 выполняется как одна транзакция: при ошибке база остаётся прежней.
async function restoreData(env, body) {
  if (!body || !Array.isArray(body.people)) throw new HttpError(400, 'Это не резервная копия дерева');
  const list = k => (Array.isArray(body[k]) ? body[k].filter(x => x && typeof x === 'object') : []);
  const t = nowIso();
  const id = v => str(v, 64);
  const state = v => (v === 'pending' ? 'pending' : 'approved');
  const sub = v => (v ? str(v, 64) : null);
  const at = v => str(v, 40) || t;

  const people = list('people').filter(p => id(p.id)).map(p => ({
    id: id(p.id), ...cleanPerson(p), state: state(p.state), submission_id: sub(p.submission_id),
    added_by: str(p.added_by, 200), created_at: at(p.created_at), updated_at: at(p.updated_at),
  }));
  const pc = list('parent_child').filter(r => id(r.parent_id) && id(r.child_id) && id(r.parent_id) !== id(r.child_id)).map(r => ({
    parent_id: id(r.parent_id), child_id: id(r.child_id), kind: r.kind === 'adopted' ? 'adopted' : 'birth',
    state: state(r.state), submission_id: sub(r.submission_id), created_at: at(r.created_at),
  }));
  const unions = list('unions').filter(u => id(u.partner1_id) && id(u.partner2_id)).map(u => ({
    id: id(u.id) || crypto.randomUUID(), partner1_id: id(u.partner1_id), partner2_id: id(u.partner2_id),
    status: UNION_STATUS.includes(u.status) ? u.status : 'married', start_date: str(u.start_date, 20), end_date: str(u.end_date, 20),
    state: state(u.state), submission_id: sub(u.submission_id), created_at: at(u.created_at),
  }));
  const photos = list('photos').filter(f => id(f.id) && id(f.person_id) && str(f.path, 200)).map(f => ({
    id: id(f.id), person_id: id(f.person_id), path: str(f.path, 200), thumb_path: str(f.thumb_path, 200), caption: str(f.caption, 500),
    state: state(f.state), submission_id: sub(f.submission_id), created_at: at(f.created_at),
  }));
  const notes = list('notes').filter(n => id(n.id) && id(n.person_id) && str(n.text, 10000)).map(n => ({
    id: id(n.id), person_id: id(n.person_id), text: str(n.text, 10000), author_name: str(n.author_name, 200),
    state: state(n.state), submission_id: sub(n.submission_id), created_at: at(n.created_at),
  }));
  const subs = list('submissions').filter(s => id(s.id) && KINDS.includes(s.kind)).map(s => ({
    id: id(s.id), kind: s.kind, target_person_id: sub(s.target_person_id),
    payload: typeof s.payload === 'string' ? s.payload : JSON.stringify(s.payload || {}),
    author_name: str(s.author_name, 200), comment: str(s.comment, 2000),
    status: ['pending', 'approved', 'rejected'].includes(s.status) ? s.status : 'pending',
    admin_note: str(s.admin_note, 2000), created_at: at(s.created_at), reviewed_at: s.reviewed_at ? str(s.reviewed_at, 40) : null,
  }));
  const title = list('settings').find(s => s.key === 'title');

  const DB = env.DB;
  const cols = rows => (rows.length ? Object.keys(rows[0]) : []);
  const inserts = [
    ...jsonInserts(DB, 'people', cols(people), people, 'INSERT OR IGNORE'),
    ...jsonInserts(DB, 'parent_child', cols(pc), pc, 'INSERT OR IGNORE'),
    ...jsonInserts(DB, 'unions', cols(unions), unions, 'INSERT OR IGNORE'),
    ...jsonInserts(DB, 'photos', cols(photos), photos, 'INSERT OR IGNORE'),
    ...jsonInserts(DB, 'notes', cols(notes), notes, 'INSERT OR IGNORE'),
    ...jsonInserts(DB, 'submissions', cols(subs), subs, 'INSERT OR IGNORE'),
  ];
  // запас до лимита бесплатного тарифа: 50 запросов к базе за вызов
  if (inserts.length > 36) throw new HttpError(413, 'Резервная копия слишком большая, чтобы восстановить её через сайт.');
  await DB.batch([
    ...['people', 'parent_child', 'unions', 'photos', 'notes', 'submissions'].map(tb => DB.prepare(`DELETE FROM ${tb}`)),
    ...inserts,
    ...(title && str(title.value, 80)
      ? [DB.prepare(`INSERT INTO settings (key, value) VALUES ('title', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(str(title.value, 80))]
      : []),
  ]);
  return { people: people.length, parent_child: pc.length, unions: unions.length, photos: photos.length, notes: notes.length, submissions: subs.length };
}

async function adminRoute(request, env, auth, method, parts) {
  requireAdmin(auth);
  const [res, id, action] = parts;
  const DB = env.DB;

  if (res === 'pending-count' && method === 'GET') {
    const r = await DB.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'`).first();
    return json({ count: r.n });
  }
  if (res === 'submissions' && method === 'GET' && !id) {
    const status = new URL(request.url).searchParams.get('status') || 'pending';
    const order = status === 'pending' ? 'ASC' : 'DESC';
    const { results } = await DB.prepare(`SELECT * FROM submissions WHERE status = ? ORDER BY created_at ${order} LIMIT 200`).bind(status).all();
    return json(results.map(s => ({ ...s, payload: safeParse(s.payload) })));
  }
  if (res === 'submissions' && method === 'POST' && id && action === 'approve') {
    await approveSubmission(env, id, await readJson(request));
    return json({ ok: true });
  }
  if (res === 'submissions' && method === 'POST' && id && action === 'reject') {
    await rejectSubmission(env, id, await readJson(request));
    return json({ ok: true });
  }
  if (res === 'submissions' && method === 'PATCH' && id) {
    // для заявок старого формата
    const b = await readJson(request);
    if (!['pending', 'approved', 'rejected'].includes(b.status)) throw new HttpError(400, 'Неверный статус');
    await DB.prepare(`UPDATE submissions SET status = ?, admin_note = ?, reviewed_at = ? WHERE id = ?`)
      .bind(b.status, str(b.admin_note, 2000), nowIso(), id).run();
    return json({ ok: true });
  }
  if (res === 'merge' && method === 'POST') {
    const b = await readJson(request);
    await mergePeople(env, str(b.from, 64), str(b.into, 64));
    return json({ ok: true });
  }
  if (res === 'people' && method === 'POST' && !id) return json(await insertPerson(env, await readJson(request)));
  if (res === 'people' && method === 'PATCH' && id) return json(await updatePerson(env, id, await readJson(request)));
  if (res === 'people' && method === 'DELETE' && id) { await deletePeople(env, [id]); return json({ ok: true }); }

  if (res === 'parent-child' && method === 'POST') {
    const b = await readJson(request);
    const p = str(b.parent_id, 64), c = str(b.child_id, 64);
    if (!p || !c || p === c) throw new HttpError(400, 'Человек не может быть родителем самому себе');
    await DB.prepare(`INSERT INTO parent_child (parent_id, child_id, kind, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (parent_id, child_id) DO UPDATE SET kind = excluded.kind`)
      .bind(p, c, b.kind === 'adopted' ? 'adopted' : 'birth', nowIso()).run();
    return json({ ok: true });
  }
  if (res === 'parent-child' && method === 'DELETE') {
    const b = await readJson(request);
    await DB.prepare(`DELETE FROM parent_child WHERE parent_id = ? AND child_id = ?`).bind(str(b.parent_id, 64), str(b.child_id, 64)).run();
    return json({ ok: true });
  }

  if (res === 'unions' && method === 'POST' && !id) {
    const b = await readJson(request);
    const a = str(b.partner1_id, 64), c = str(b.partner2_id, 64);
    if (!a || !c || a === c) throw new HttpError(400, 'Неверная пара');
    const uid = crypto.randomUUID();
    await DB.prepare(`INSERT INTO unions (id, partner1_id, partner2_id, status, start_date, end_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(uid, a, c, UNION_STATUS.includes(b.status) ? b.status : 'married', str(b.start_date, 20), str(b.end_date, 20), nowIso()).run();
    return json(await DB.prepare(`SELECT * FROM unions WHERE id = ?`).bind(uid).first());
  }
  if (res === 'unions' && method === 'PATCH' && id) {
    const b = await readJson(request);
    const sets = [], vals = [];
    if ('status' in b && UNION_STATUS.includes(b.status)) { sets.push('status = ?'); vals.push(b.status); }
    if ('start_date' in b) { sets.push('start_date = ?'); vals.push(str(b.start_date, 20)); }
    if ('end_date' in b) { sets.push('end_date = ?'); vals.push(str(b.end_date, 20)); }
    if (sets.length) await DB.prepare(`UPDATE unions SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
    return json({ ok: true });
  }
  if (res === 'unions' && method === 'DELETE' && id) {
    await DB.prepare(`DELETE FROM unions WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  }

  if (res === 'photos' && method === 'POST' && !id) {
    const b = await readJson(request);
    const pid = crypto.randomUUID();
    await DB.prepare(`INSERT INTO photos (id, person_id, path, thumb_path, caption, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(pid, str(b.person_id, 64), str(b.path, 200), str(b.thumb_path, 200), str(b.caption, 500), nowIso()).run();
    return json(await DB.prepare(`SELECT * FROM photos WHERE id = ?`).bind(pid).first());
  }
  if (res === 'photos' && method === 'PATCH' && id) {
    const b = await readJson(request);
    await DB.prepare(`UPDATE photos SET caption = ? WHERE id = ?`).bind(str(b.caption, 500), id).run();
    return json({ ok: true });
  }
  if (res === 'photos' && method === 'DELETE' && id) {
    const ph = await DB.prepare(`SELECT * FROM photos WHERE id = ?`).bind(id).first();
    if (ph) {
      await deleteFiles(env, [ph.path, ph.thumb_path]);
      await DB.batch([
        DB.prepare(`DELETE FROM photos WHERE id = ?`).bind(id),
        DB.prepare(`UPDATE people SET main_photo_id = NULL WHERE main_photo_id = ?`).bind(id),
      ]);
    }
    return json({ ok: true });
  }
  if (res === 'notes' && method === 'POST' && !id) {
    const b = await readJson(request);
    const text = str(b.text, 10000);
    if (!text) throw new HttpError(400, 'Заметка пустая');
    const nid = crypto.randomUUID();
    await DB.prepare(`INSERT INTO notes (id, person_id, text, author_name, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(nid, str(b.person_id, 64), text, str(b.author_name, 200), nowIso()).run();
    return json(await DB.prepare(`SELECT * FROM notes WHERE id = ?`).bind(nid).first());
  }
  if (res === 'notes' && method === 'DELETE' && id) {
    await DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  }
  if (res === 'delete-uploads' && method === 'POST') {
    const b = await readJson(request);
    const keys = (Array.isArray(b.paths) ? b.paths : []).map(k => str(k, 200)).filter(k => /^p\//.test(k)).slice(0, 200);
    // не трогаем файлы, которые уже прикреплены к людям
    const used = new Set();
    for (const part of chunks(keys, 45)) {
      const { results } = await DB.prepare(`SELECT path, thumb_path FROM photos WHERE path IN (${marks(part)}) OR thumb_path IN (${marks(part)})`)
        .bind(...part, ...part).all();
      for (const r of results) { used.add(r.path); used.add(r.thumb_path); }
    }
    await deleteFiles(env, keys.filter(k => !used.has(k)));
    return json({ ok: true });
  }

  if (res === 'settings' && method === 'PUT') {
    const b = await readJson(request);
    if ('title' in b) {
      await DB.prepare(`INSERT INTO settings (key, value) VALUES ('title', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
        .bind(str(b.title, 80) || 'Семейное дерево').run();
    }
    return json({ ok: true });
  }
  if (res === 'family-code' && method === 'PUT') {
    const b = await readJson(request);
    const code = normalizeCode(b.code);
    if (code.length < 4) throw new HttpError(400, 'Семейный код должен быть не короче 4 символов');
    const salt = randomToken();
    await DB.batch([
      DB.prepare(`INSERT INTO settings (key, value) VALUES ('family_code_salt', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(salt),
      DB.prepare(`INSERT INTO settings (key, value) VALUES ('family_code_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(await sha256hex(salt + code)),
      // старый код больше не действует: все семейные сессии сбрасываются
      DB.prepare(`DELETE FROM sessions WHERE kind = 'family'`),
    ]);
    return json({ ok: true });
  }
  if (res === 'import' && method === 'POST') {
    return json(await importData(env, await readJson(request, 3 * 1024 * 1024)));
  }
  if (res === 'restore' && method === 'POST') {
    return json(await restoreData(env, await readJson(request, 15 * 1024 * 1024)));
  }
  if (res === 'export' && method === 'GET') {
    const tables = ['people', 'parent_child', 'unions', 'photos', 'notes', 'submissions', 'settings'];
    const out = await DB.batch(tables.map(t => DB.prepare(`SELECT * FROM ${t}`)));
    const data = {};
    tables.forEach((t, i) => { data[t] = out[i].results; });
    data.people = data.people.map(personOut);
    data.submissions = data.submissions.map(s => ({ ...s, payload: safeParse(s.payload) }));
    data.settings = data.settings.filter(s => !/^family_code|schema_version/.test(s.key));
    return json(data);
  }
  throw new HttpError(404, 'Неизвестный запрос');
}

// ---------- маршрутизация ----------
async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const isApi = path.startsWith('/api/');
  const isPhoto = path.startsWith('/photos/');
  if (!isApi && !isPhoto) return env.ASSETS.fetch(request);

  // запросы, меняющие данные, принимаем только со своего сайта
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return fail(403, 'Запрос с чужого сайта отклонён');
  }

  await ensureSchema(env);
  const auth = await getAuth(request, env);
  if (isPhoto) return servePhoto(request, env, auth, decodeURIComponent(path.slice('/photos/'.length)));

  const parts = path.slice('/api/'.length).split('/').filter(Boolean);
  const [head, ...rest] = parts;
  if (head === 'session' && method === 'GET') return apiSession(request, env, auth);
  if (head === 'unlock' && method === 'POST') return apiUnlock(request, env);
  if (head === 'logout' && method === 'POST') return apiLogout(request, env);
  if (head === 'tree' && method === 'GET') return apiTree(request, env, auth);
  if (head === 'submissions' && method === 'POST') return apiSubmit(request, env, auth);
  if (head === 'uploads' && method === 'POST') return apiUpload(request, env, auth);
  if (head === 'admin') {
    if (rest[0] === 'login' && method === 'POST') return apiAdminLogin(request, env);
    if (rest[0] === 'logout' && method === 'POST') return apiAdminLogout(request, env);
    return adminRoute(request, env, auth, method, rest);
  }
  return fail(404, 'Неизвестный запрос');
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message, e.code);
      console.error(e && e.stack || e);
      return fail(500, 'Ошибка на сервере. Попробуйте ещё раз.');
    }
  },
};
