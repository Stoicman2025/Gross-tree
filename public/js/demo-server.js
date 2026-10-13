// Локальный демо-режим: настоящий сервер сайта (src/worker.js) работает
// прямо в браузере. База D1 — это SQLite (sql.js), хранилище фото — память.
// Всё сохраняется в IndexedDB этого браузера.
// На Cloudflare этот файл не используется: там отвечает настоящий сервер.

import { demoSeed } from './demo-seed.js';

const SQLJS = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/';
const ORIGIN = location.origin;
const IDB_NAME = 'ft-demo';
const COOKIES_KEY = 'ft-demo-cookies';

// ---------- ответ сервера (вместо Response: браузер не даёт читать Set-Cookie) ----------
export class FakeResponse {
  constructor(body = null, init = {}) {
    this.status = init.status ?? 200;
    this.headers = new Headers();
    const src = init.headers instanceof Headers ? [...init.headers] : Object.entries(init.headers || {});
    for (const [k, v] of src) this.headers.append(k, v);
    if (init.headers instanceof Headers && init.headers.getSetCookie) {
      this.headers.delete('set-cookie');
      for (const c of init.headers.getSetCookie()) this.headers.append('Set-Cookie', c);
    }
    this._body = body;
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  async arrayBuffer() {
    const b = this._body;
    if (b === null) return new ArrayBuffer(0);
    if (typeof b === 'string') return new TextEncoder().encode(b).buffer;
    if (b instanceof Uint8Array) return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    return new Response(b).arrayBuffer();
  }
  async text() { return new TextDecoder().decode(await this.arrayBuffer()); }
  async json() { return JSON.parse(await this.text()); }
}

// ---------- D1 поверх SQLite ----------
export class D1Sqlite {
  constructor(db) { this.db = db; this.queries = 0; }
  prepare(sql) { return new D1Stmt(this, sql, []); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try { const r = stmts.map(s => s._exec()); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
class D1Stmt {
  constructor(d1, sql, params) { this.d1 = d1; this.sql = sql; this.params = params; }
  bind(...p) { return new D1Stmt(this.d1, this.sql, p); }
  _exec() {
    this.d1.queries++;
    const st = this.d1.db.prepare(this.sql);
    try {
      st.bind(this.params.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
      const results = [];
      while (st.step()) results.push(st.getAsObject());
      return { results, success: true, meta: { changes: this.d1.db.getRowsModified() } };
    } finally { st.free(); }
  }
  async first(col) { const r = this._exec().results[0]; return r ? (col ? r[col] : r) : null; }
  async all() { return this._exec(); }
  async run() { return this._exec(); }
}

// ---------- KV в памяти (с сохранением через колбэк) ----------
export class MemoryKV {
  constructor(onChange) { this.m = new Map(); this.onChange = onChange; }
  async put(k, v) {
    const bytes = new Uint8Array(v instanceof ArrayBuffer ? v.slice(0) : await new Response(v).arrayBuffer());
    this.m.set(k, bytes);
    this.onChange && this.onChange('put', k, bytes);
  }
  async get(k) { return this.m.get(k) || null; }
  async delete(k) { this.m.delete(k); this.onChange && this.onChange('delete', k); }
}

// ---------- IndexedDB ----------
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const store = tx.objectStore('kv');
    const r = fn(store);
    tx.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}
const idbGet = key => idbOp('readonly', s => s.get(key));
const idbPut = (key, val) => idbOp('readwrite', s => s.put(val, key));
const idbDel = key => idbOp('readwrite', s => s.delete(key));
const idbAll = () => idbOp('readonly', s => s.getAllKeys());

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
    document.head.append(s);
  });
}

function readCookies() { try { return JSON.parse(localStorage.getItem(COOKIES_KEY) || '{}'); } catch { return {}; } }
function writeCookies(c) { try { localStorage.setItem(COOKIES_KEY, JSON.stringify(c)); } catch { /* ignore */ } }

// ---------- транспорт для backend.js ----------
export async function createDemoTransport() {
  if (!window.initSqlJs) await loadScript(SQLJS + 'sql-wasm.js');
  const SQL = await window.initSqlJs({ locateFile: f => SQLJS + f });
  const saved = await idbGet('sqlite').catch(() => null);
  const db = saved ? new SQL.Database(saved) : new SQL.Database();
  const DB = new D1Sqlite(db);
  const PHOTOS = new MemoryKV((op, k, bytes) => (op === 'put' ? idbPut('photo:' + k, bytes) : idbDel('photo:' + k)).catch(() => {}));
  for (const key of await idbAll().catch(() => [])) {
    if (String(key).startsWith('photo:')) PHOTOS.m.set(key.slice(6), await idbGet(key));
  }
  const env = { DB, PHOTOS, ASSETS: null, ADMIN_PASSWORD: 'demo', FAMILY_CODE: 'демо' };
  globalThis.__ftMakeResponse = (body, init) => new FakeResponse(body, init);
  const worker = (await import('../../src/worker.js')).default;
  let jar = readCookies();
  const urls = new Map();

  async function call(method, path, body, isForm) {
    const init = { method };
    if (body !== undefined && method !== 'GET') init.body = isForm ? body : JSON.stringify(body);
    const real = new Request(ORIGIN + path, init);
    const headers = new Headers();
    for (const [k, v] of real.headers) headers.set(k, v);
    const ck = Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    if (ck) headers.set('Cookie', ck);
    headers.set('Origin', ORIGIN);
    const req = { method, url: ORIGIN + path, headers, text: () => real.text(), json: () => real.json(), formData: () => real.formData() };
    const res = await worker.fetch(req, env);
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
      if (/Max-Age=0/i.test(attrs.join(';'))) delete jar[k]; else jar[k] = v;
    }
    writeCookies(jar);
    if (method !== 'GET') await idbPut('sqlite', db.export()).catch(() => {});
    return res;
  }

  // первый запуск: вымышленная семья и одна анкета «на проверке»
  if (!saved) {
    const seed = demoSeed();
    const saveJar = jar;
    jar = {};
    await call('POST', '/api/admin/login', { password: 'demo' });
    await call('POST', '/api/admin/import', { people: seed.people, unions: seed.unions, parent_child: seed.parent_child });
    await call('PUT', '/api/admin/settings', { title: seed.title });
    await call('POST', '/api/unlock', { code: 'демо' });
    for (const s of seed.submissions) {
      await call('POST', '/api/submissions', { kind: s.kind, target: s.target_person_id, payload: s.payload, author: s.author_name, comment: s.comment });
    }
    await call('POST', '/api/logout');
    jar = saveJar;
    writeCookies(jar);
  }

  return {
    call,
    photoUrl(path) {
      if (!urls.has(path)) {
        const bytes = PHOTOS.m.get(path);
        if (!bytes) return '';
        urls.set(path, URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })));
      }
      return urls.get(path);
    },
    async reset() {
      writeCookies({});
      await new Promise(resolve => { const r = indexedDB.deleteDatabase(IDB_NAME); r.onsuccess = r.onerror = r.onblocked = resolve; });
    },
  };
}
