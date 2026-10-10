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
// ============================================================

const SCHEMA_VERSION = '1';
const FAMILY_DAYS = 180;
const ADMIN_DAYS = 30;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 200 * 1024;
const MAX_PENDING = 200;

const PERSON_TEXT = ['first_name', 'patronymic', 'last_name', 'maiden_name', 'gender', 'birth_date', 'birth_place',
  'death_date', 'death_place', 'occupation', 'bio'];
const PERSON_BOOL = ['birth_approx', 'is_deceased', 'death_approx'];
const UNION_STATUS = ['married', 'divorced', 'widowed', 'partner'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '', patronymic TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
    maiden_name TEXT NOT NULL DEFAULT '', gender TEXT NOT NULL DEFAULT '',
    birth_date TEXT NOT NULL DEFAULT '', birth_approx INTEGER NOT NULL DEFAULT 0, birth_place TEXT NOT NULL DEFAULT '',
    is_deceased INTEGER NOT NULL DEFAULT 0, death_date TEXT NOT NULL DEFAULT '', death_approx INTEGER NOT NULL DEFAULT 0,
    death_place TEXT NOT NULL DEFAULT '', occupation TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
    main_photo_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS parent_child (
    parent_id TEXT NOT NULL, child_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'birth', created_at TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id))`,
  `CREATE INDEX IF NOT EXISTS parent_child_child ON parent_child (child_id)`,
  `CREATE TABLE IF NOT EXISTS unions (
    id TEXT PRIMARY KEY, partner1_id TEXT NOT NULL, partner2_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'married',
    start_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL, path TEXT NOT NULL, thumb_path TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS photos_person ON photos (person_id)`,
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

let schemaReady = false;

// ---------- ответы ----------
function json(data, status = 200, extra) {
  const h = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (extra) for (const [k, v] of extra) h.append(k, v);
  return new Response(JSON.stringify(data), { status, headers: h });
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

// ---------- схема ----------
async function ensureSchema(env) {
  if (schemaReady) return;
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first();
    if (row && row.value === SCHEMA_VERSION) { schemaReady = true; return; }
  } catch { /* таблиц ещё нет */ }
  await env.DB.batch([
    ...SCHEMA.map(s => env.DB.prepare(s)),
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
    `SELECT kind FROM sessions WHERE id_hash IN (${hashes.map(() => '?').join(',')}) AND expires_at > ?`,
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
  if (!env.FAMILY_CODE) throw new HttpError(503, 'Семейный код ещё не задан. Администратору: добавьте секрет FAMILY_CODE в настройках Worker.', 'not_configured');
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
  const [title, people, pc, unions, photos] = await env.DB.batch([
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'title'`),
    env.DB.prepare(`SELECT * FROM people ORDER BY created_at, id`),
    env.DB.prepare(`SELECT * FROM parent_child ORDER BY created_at`),
    env.DB.prepare(`SELECT * FROM unions ORDER BY created_at`),
    env.DB.prepare(`SELECT * FROM photos ORDER BY created_at`),
  ]);
  return json({
    title: title.results[0]?.value || 'Семейное дерево',
    people: people.results.map(personOut),
    parent_child: pc.results,
    unions: unions.results,
    photos: photos.results,
  });
}

async function apiSubmit(request, env, auth) {
  requireFamily(auth);
  const body = await readJson(request);
  const kind = body.kind;
  if (!['new_person', 'edit_person', 'add_photo'].includes(kind)) throw new HttpError(400, 'Неизвестный тип заявки');
  if (!body.payload || typeof body.payload !== 'object') throw new HttpError(400, 'Пустая заявка');
  const target = body.target ? str(body.target, 64) : null;
  if (kind !== 'new_person') {
    const exists = await env.DB.prepare(`SELECT id FROM people WHERE id = ?`).bind(target).first();
    if (!exists) throw new HttpError(404, 'Человек, к которому относится заявка, не найден');
  }
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'`).first();
  if (pending.n >= MAX_PENDING) throw new HttpError(429, 'Слишком много заявок ждут проверки. Попробуйте позже.');
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO submissions (id, kind, target_person_id, payload, author_name, comment, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(id, kind, target, JSON.stringify(body.payload), str(body.author, 200), str(body.comment, 4000), nowIso()).run();
  return json({ id });
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
  if (!auth.family) return new Response('Нужно ввести семейный код', { status: 401 });
  if (!/^p\/[0-9a-f-]{36}(_t)?\.jpg$/.test(key)) return new Response('Not found', { status: 404 });
  const obj = await env.PHOTOS.get(key, { type: 'stream' });
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ---------- администратор ----------
async function apiAdminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Пароль администратора не задан. Добавьте секрет ADMIN_PASSWORD в настройках Worker.', 'not_configured');
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
  await env.DB.prepare(`INSERT INTO people (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
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

// На бесплатном тарифе — не больше 50 запросов к базе за вызов,
// поэтому списки обрабатываются пачками через IN (…).
function chunks(arr, n = 90) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function deleteFiles(env, keys) {
  const valid = [...new Set(keys.filter(k => k && /^p\//.test(k)))];
  for (const k of valid) await env.PHOTOS.delete(k);
  for (const part of chunks(valid)) {
    await env.DB.prepare(`DELETE FROM uploads WHERE path IN (${part.map(() => '?').join(',')})`).bind(...part).run();
  }
}

async function deletePerson(env, id) {
  const { results: photos } = await env.DB.prepare(`SELECT path, thumb_path FROM photos WHERE person_id = ?`).bind(id).all();
  await deleteFiles(env, photos.flatMap(p => [p.path, p.thumb_path]));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM photos WHERE person_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM parent_child WHERE parent_id = ? OR child_id = ?`).bind(id, id),
    env.DB.prepare(`DELETE FROM unions WHERE partner1_id = ? OR partner2_id = ?`).bind(id, id),
    env.DB.prepare(`UPDATE submissions SET target_person_id = NULL WHERE target_person_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM people WHERE id = ?`).bind(id),
  ]);
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
  const stmts = [];
  // одна инструкция на таблицу: строки передаются одним JSON-параметром
  const insertJson = (table, cols, rows, verb = 'INSERT') => {
    if (!rows.length) return;
    stmts.push(env.DB.prepare(`${verb} INTO ${table} (${cols.join(',')}) SELECT ${cols.map(c => `json_extract(value, '$.${c}')`).join(',')} FROM json_each(?)`)
      .bind(JSON.stringify(rows)));
  };
  insertJson('people', pCols, pRows.map(r => ({ ...r, main_photo_id: null })));
  insertJson('unions', ['id', 'partner1_id', 'partner2_id', 'status', 'start_date', 'end_date', 'created_at'], uRows);
  insertJson('parent_child', ['parent_id', 'child_id', 'kind', 'created_at'], cRows, 'INSERT OR IGNORE');
  if (stmts.length) await env.DB.batch(stmts);
  return { people: pRows.length, unions: uRows.length, parent_child: cRows.length };
}

async function adminRoute(request, env, auth, method, parts) {
  requireAdmin(auth);
  const [res, id] = parts;
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
  if (res === 'submissions' && method === 'PATCH' && id) {
    const b = await readJson(request);
    if (!['pending', 'approved', 'rejected'].includes(b.status)) throw new HttpError(400, 'Неверный статус');
    await DB.prepare(`UPDATE submissions SET status = ?, admin_note = ?, reviewed_at = ? WHERE id = ?`)
      .bind(b.status, str(b.admin_note, 2000), nowIso(), id).run();
    return json({ ok: true });
  }
  if (res === 'people' && method === 'POST' && !id) return json(await insertPerson(env, await readJson(request)));
  if (res === 'people' && method === 'PATCH' && id) return json(await updatePerson(env, id, await readJson(request)));
  if (res === 'people' && method === 'DELETE' && id) { await deletePerson(env, id); return json({ ok: true }); }

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
  if (res === 'delete-uploads' && method === 'POST') {
    const b = await readJson(request);
    const keys = (Array.isArray(b.paths) ? b.paths : []).map(k => str(k, 200)).filter(k => /^p\//.test(k)).slice(0, 200);
    // не трогаем файлы, которые уже прикреплены к людям
    const used = new Set();
    for (const part of chunks(keys, 45)) {
      const marks = part.map(() => '?').join(',');
      const { results } = await DB.prepare(`SELECT path, thumb_path FROM photos WHERE path IN (${marks}) OR thumb_path IN (${marks})`)
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
  if (res === 'export' && method === 'GET') {
    const tables = ['people', 'parent_child', 'unions', 'photos', 'submissions', 'settings'];
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

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

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
