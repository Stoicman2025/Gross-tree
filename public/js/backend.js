// Слой хранения. Две реализации с одинаковым интерфейсом:
//  - CloudflareBackend — настоящий сервер (Worker на том же сайте, /api/*);
//  - DemoBackend — всё хранится в этом браузере (если сервера нет,
//    например при локальном просмотре через tools/serve.ps1).

import { uid, store } from './util.js';
import { blobToDataUrl } from './photos.js';
import { demoSeed } from './demo-seed.js';

export async function createBackend() {
  const cf = new CloudflareBackend();
  try {
    await cf.init();
    return cf;
  } catch (e) {
    if (e && e.serverMissing) {
      const demo = new DemoBackend();
      await demo.init();
      return demo;
    }
    throw e;
  }
}

class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function api(method, path, body, { form = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body && !form ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? (form ? body : JSON.stringify(body)) : undefined,
    });
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет (или VPN) и попробуйте ещё раз.', 0, 'network');
  }
  const type = res.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) {
    const err = new ApiError('Сервер недоступен', res.status, 'no_api');
    err.serverMissing = res.status === 404 || res.status === 405 || res.status === 501 || type.includes('text/html');
    throw err;
  }
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || 'Ошибка сервера', res.status, data.code);
  return data;
}

// ============================================================
// Cloudflare Worker
// ============================================================
class CloudflareBackend {
  constructor() {
    this.mode = 'cloudflare';
    this.session = { unlocked: false, admin: false };
  }

  async init() {
    const s = await api('GET', '/api/session');
    this.session = { unlocked: s.family, admin: s.admin };
    return this.session;
  }

  async unlock(code) {
    try {
      await api('POST', '/api/unlock', { code });
      this.session.unlocked = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.code || 'error', message: e.message };
    }
  }

  async lock() {
    await api('POST', '/api/logout').catch(() => {});
    this.session = { unlocked: false, admin: false };
  }

  async getTree() {
    try {
      return { ok: true, data: await api('GET', '/api/tree') };
    } catch (e) {
      if (e.code === 'locked') return { ok: false, error: 'locked' };
      return { ok: false, error: 'network', message: e.message };
    }
  }

  async submit({ kind, target, payload, author, comment }) {
    const r = await api('POST', '/api/submissions', { kind, target, payload, author, comment });
    return r.id;
  }

  async uploadPhoto({ full, thumb }) {
    const fd = new FormData();
    fd.append('full', full, 'full.jpg');
    fd.append('thumb', thumb, 'thumb.jpg');
    return api('POST', '/api/uploads', fd, { form: true });
  }

  photoUrl(path) {
    if (!path) return '';
    if (/^https?:|^data:/.test(path)) return path;
    return '/photos/' + path.split('/').map(encodeURIComponent).join('/');
  }

  // ---------- администратор ----------
  async adminSession() {
    try { await this.init(); } catch { /* оставляем как было */ }
    return this.session.admin ? { email: 'администратор' } : null;
  }

  async signIn(password) {
    try {
      await api('POST', '/api/admin/login', { password });
      this.session.admin = true;
      this.session.unlocked = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async signOut() {
    await api('POST', '/api/admin/logout').catch(() => {});
    this.session.admin = false;
  }

  async pendingCount() {
    if (!this.session.admin) return 0;
    try { return (await api('GET', '/api/admin/pending-count')).count; } catch { return 0; }
  }

  listSubmissions(status) { return api('GET', '/api/admin/submissions?status=' + encodeURIComponent(status)); }
  reviewSubmission(id, status, note = '') { return api('PATCH', '/api/admin/submissions/' + id, { status, admin_note: note }); }
  insertPerson(p) { return api('POST', '/api/admin/people', p); }
  updatePerson(id, patch) { return api('PATCH', '/api/admin/people/' + id, patch); }
  deletePerson(id) { return api('DELETE', '/api/admin/people/' + id); }
  addParentChild(parentId, childId, kind = 'birth') { return api('POST', '/api/admin/parent-child', { parent_id: parentId, child_id: childId, kind }); }
  removeParentChild(parentId, childId) { return api('DELETE', '/api/admin/parent-child', { parent_id: parentId, child_id: childId }); }
  addUnion(u) { return api('POST', '/api/admin/unions', u); }
  updateUnion(id, patch) { return api('PATCH', '/api/admin/unions/' + id, patch); }
  deleteUnion(id) { return api('DELETE', '/api/admin/unions/' + id); }
  insertPhoto(ph) { return api('POST', '/api/admin/photos', ph); }
  updatePhoto(id, patch) { return api('PATCH', '/api/admin/photos/' + id, patch); }
  deletePhoto(ph) { return api('DELETE', '/api/admin/photos/' + ph.id); }
  deleteUploads(paths) { return api('POST', '/api/admin/delete-uploads', { paths }); }
  setTitle(title) { return api('PUT', '/api/admin/settings', { title }); }
  setFamilyCode(code) { return api('PUT', '/api/admin/family-code', { code }); }
  exportAll() { return api('GET', '/api/admin/export'); }

  async bulkImport({ people, parent_child, unions }) {
    // частями, чтобы не упереться в ограничения бесплатного тарифа
    for (let i = 0; i < people.length; i += 250) await api('POST', '/api/admin/import', { people: people.slice(i, i + 250) });
    for (let i = 0; i < unions.length; i += 1000) await api('POST', '/api/admin/import', { unions: unions.slice(i, i + 1000) });
    for (let i = 0; i < parent_child.length; i += 1000) await api('POST', '/api/admin/import', { parent_child: parent_child.slice(i, i + 1000) });
  }
}

export const PERSON_FIELDS = ['first_name', 'patronymic', 'last_name', 'maiden_name', 'gender', 'birth_date', 'birth_approx',
  'birth_place', 'is_deceased', 'death_date', 'death_approx', 'death_place', 'occupation', 'bio', 'main_photo_id'];

export function cleanPerson(p, partial = false) {
  const out = {};
  for (const f of PERSON_FIELDS) {
    if (partial && !(f in p)) continue;
    const v = p[f];
    if (f === 'main_photo_id') { out[f] = v || null; continue; }
    if (['birth_approx', 'is_deceased', 'death_approx'].includes(f)) { out[f] = !!v; continue; }
    out[f] = String(v ?? '').trim();
  }
  return out;
}

// ============================================================
// Демо: данные в localStorage этого браузера
// ============================================================
const DEMO_KEY = 'ft-demo-db-v1';
const DEMO_PHOTO = 'ft-demo-photo:';
const DEMO_ADMIN = 'ft-demo-admin';
const DEMO_UNLOCKED = 'ft-demo-unlocked';
export const DEMO_CODE = 'демо';

class DemoBackend {
  constructor() {
    this.mode = 'demo';
    this.photoCache = new Map();
    this.session = { unlocked: false, admin: false };
  }

  async init() {
    this.db = store.get(DEMO_KEY);
    if (!this.db) {
      this.db = demoSeed();
      this.#save();
    }
    this.session = { unlocked: !!store.get(DEMO_UNLOCKED), admin: !!store.get(DEMO_ADMIN) };
    return this.session;
  }

  #save() {
    if (!store.set(DEMO_KEY, this.db)) throw new Error('Не хватает места в браузере для демо-данных');
  }

  reset() {
    store.remove(DEMO_KEY);
    try {
      Object.keys(localStorage).filter(k => k.startsWith(DEMO_PHOTO)).forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
    store.remove(DEMO_ADMIN);
    store.remove(DEMO_UNLOCKED);
  }

  async unlock(code) {
    const c = String(code || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (c !== (this.db.familyCode || DEMO_CODE)) return { ok: false, error: 'bad_code', message: 'Неверный семейный код' };
    store.set(DEMO_UNLOCKED, true);
    this.session.unlocked = true;
    return { ok: true };
  }

  async lock() {
    store.remove(DEMO_UNLOCKED);
    store.remove(DEMO_ADMIN);
    this.session = { unlocked: false, admin: false };
  }

  #canRead() { return !!store.get(DEMO_UNLOCKED) || !!store.get(DEMO_ADMIN); }

  async getTree() {
    if (!this.#canRead()) return { ok: false, error: 'locked' };
    const { people, parent_child, unions, photos, title } = structuredClone(this.db);
    return { ok: true, data: { people, parent_child, unions, photos, title } };
  }

  async submit({ kind, target, payload, author, comment }) {
    if (!this.#canRead()) throw new Error('Нужно ввести семейный код');
    const s = {
      id: uid(), kind, target_person_id: target || null, payload: structuredClone(payload),
      author_name: author || '', comment: comment || '', status: 'pending', admin_note: '',
      created_at: new Date().toISOString(), reviewed_at: null,
    };
    this.db.submissions.push(s);
    this.#save();
    return s.id;
  }

  async uploadPhoto({ full, thumb }) {
    const id = uid();
    const path = `p/${id}.jpg`;
    const thumbPath = `p/${id}_t.jpg`;
    const [fullUrl, thumbUrl] = await Promise.all([blobToDataUrl(full), blobToDataUrl(thumb)]);
    try {
      localStorage.setItem(DEMO_PHOTO + path, fullUrl);
      localStorage.setItem(DEMO_PHOTO + thumbPath, thumbUrl);
    } catch {
      localStorage.removeItem(DEMO_PHOTO + path);
      throw new Error('В демо-режиме закончилось место для фото (ограничение браузера ~5 МБ). На настоящем сайте такого ограничения нет.');
    }
    return { path, thumb_path: thumbPath };
  }

  photoUrl(path) {
    if (!path) return '';
    if (/^https?:|^data:/.test(path)) return path;
    if (!this.photoCache.has(path)) {
      let v = '';
      try { v = localStorage.getItem(DEMO_PHOTO + path) || ''; } catch { /* ignore */ }
      if (v) this.photoCache.set(path, v);
      return v;
    }
    return this.photoCache.get(path);
  }

  async adminSession() {
    this.session.admin = !!store.get(DEMO_ADMIN);
    return this.session.admin ? { email: 'администратор' } : null;
  }

  async signIn(password) {
    if (password !== 'demo') return { ok: false, error: 'В демо-режиме пароль администратора: demo' };
    store.set(DEMO_ADMIN, true);
    this.session.admin = true;
    return { ok: true };
  }

  async signOut() { store.remove(DEMO_ADMIN); this.session.admin = false; }

  #requireAdmin() {
    if (!store.get(DEMO_ADMIN)) throw new Error('Нужно войти как администратор');
  }

  async pendingCount() {
    if (!store.get(DEMO_ADMIN)) return 0;
    return this.db.submissions.filter(s => s.status === 'pending').length;
  }

  async listSubmissions(status) {
    this.#requireAdmin();
    const list = this.db.submissions.filter(s => s.status === status);
    list.sort((a, b) => (status === 'pending' ? 1 : -1) * a.created_at.localeCompare(b.created_at));
    return structuredClone(list);
  }

  async reviewSubmission(id, status, note = '') {
    this.#requireAdmin();
    const s = this.db.submissions.find(x => x.id === id);
    if (s) { s.status = status; s.admin_note = note; s.reviewed_at = new Date().toISOString(); }
    this.#save();
  }

  async insertPerson(p) {
    this.#requireAdmin();
    const now = new Date().toISOString();
    const rec = { id: p.id || uid(), ...cleanPerson(p), created_at: now, updated_at: now };
    this.db.people.push(rec);
    this.#save();
    return structuredClone(rec);
  }

  async updatePerson(id, patch) {
    this.#requireAdmin();
    const p = this.db.people.find(x => x.id === id);
    if (!p) throw new Error('Человек не найден');
    Object.assign(p, cleanPerson(patch, true), { updated_at: new Date().toISOString() });
    this.#save();
    return structuredClone(p);
  }

  async deletePerson(id) {
    this.#requireAdmin();
    for (const ph of this.db.photos.filter(x => x.person_id === id)) this.#removeFiles(ph);
    this.db.people = this.db.people.filter(x => x.id !== id);
    this.db.parent_child = this.db.parent_child.filter(r => r.parent_id !== id && r.child_id !== id);
    this.db.unions = this.db.unions.filter(u => u.partner1_id !== id && u.partner2_id !== id);
    this.db.photos = this.db.photos.filter(x => x.person_id !== id);
    this.db.submissions.forEach(s => { if (s.target_person_id === id) s.target_person_id = null; });
    this.#save();
  }

  async addParentChild(parentId, childId, kind = 'birth') {
    this.#requireAdmin();
    if (parentId === childId) throw new Error('Человек не может быть родителем самому себе');
    const ex = this.db.parent_child.find(r => r.parent_id === parentId && r.child_id === childId);
    if (ex) ex.kind = kind;
    else this.db.parent_child.push({ parent_id: parentId, child_id: childId, kind, created_at: new Date().toISOString() });
    this.#save();
  }

  async removeParentChild(parentId, childId) {
    this.#requireAdmin();
    this.db.parent_child = this.db.parent_child.filter(r => !(r.parent_id === parentId && r.child_id === childId));
    this.#save();
  }

  async addUnion(u) {
    this.#requireAdmin();
    const rec = {
      id: uid(), partner1_id: u.partner1_id, partner2_id: u.partner2_id, status: u.status || 'married',
      start_date: u.start_date || '', end_date: u.end_date || '', created_at: new Date().toISOString(),
    };
    this.db.unions.push(rec);
    this.#save();
    return structuredClone(rec);
  }

  async updateUnion(id, patch) {
    this.#requireAdmin();
    const u = this.db.unions.find(x => x.id === id);
    if (u) Object.assign(u, patch);
    this.#save();
  }

  async deleteUnion(id) {
    this.#requireAdmin();
    this.db.unions = this.db.unions.filter(u => u.id !== id);
    this.#save();
  }

  async insertPhoto(ph) {
    this.#requireAdmin();
    const rec = { id: uid(), person_id: ph.person_id, path: ph.path, thumb_path: ph.thumb_path || '', caption: ph.caption || '', created_at: new Date().toISOString() };
    this.db.photos.push(rec);
    this.#save();
    return structuredClone(rec);
  }

  async updatePhoto(id, patch) {
    this.#requireAdmin();
    const ph = this.db.photos.find(x => x.id === id);
    if (ph) Object.assign(ph, patch);
    this.#save();
  }

  async deletePhoto(ph) {
    this.#requireAdmin();
    this.#removeFiles(ph);
    this.db.photos = this.db.photos.filter(x => x.id !== ph.id);
    this.db.people.forEach(p => { if (p.main_photo_id === ph.id) p.main_photo_id = null; });
    this.#save();
  }

  async deleteUploads(paths) {
    paths.forEach(p => { try { localStorage.removeItem(DEMO_PHOTO + p); } catch { /* ignore */ } });
  }

  #removeFiles(ph) {
    [ph.path, ph.thumb_path].forEach(p => {
      try { localStorage.removeItem(DEMO_PHOTO + p); } catch { /* ignore */ }
      this.photoCache.delete(p);
    });
  }

  async setTitle(title) {
    this.#requireAdmin();
    this.db.title = title;
    this.#save();
  }

  async setFamilyCode(code) {
    this.#requireAdmin();
    const c = String(code || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (c.length < 4) throw new Error('Семейный код должен быть не короче 4 символов');
    this.db.familyCode = c;
    store.remove(DEMO_UNLOCKED);
    this.#save();
  }

  async bulkImport({ people, parent_child, unions }) {
    this.#requireAdmin();
    const now = new Date().toISOString();
    for (const p of people) this.db.people.push({ id: p.id, ...cleanPerson(p), created_at: now, updated_at: now });
    for (const u of unions) this.db.unions.push({ ...u, created_at: now });
    for (const r of parent_child) this.db.parent_child.push({ ...r, created_at: now });
    this.#save();
  }

  async exportAll() {
    this.#requireAdmin();
    const { people, parent_child, unions, photos, submissions, title } = structuredClone(this.db);
    return { people, parent_child, unions, photos, submissions, settings: [{ key: 'title', value: title }] };
  }
}
