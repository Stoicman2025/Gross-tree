// Связь с сервером (/api/* на том же сайте).
// Если сервера нет (локальный просмотр через tools/serve.ps1), включается
// демо-режим: тот же сервер запускается прямо в браузере (demo-server.js).

import { t } from './i18n.js';

export async function createBackend() {
  const cf = new Backend();
  try {
    await cf.init();
    return cf;
  } catch (e) {
    if (!e || !e.serverMissing) throw e;
    const { createDemoTransport } = await import('./demo-server.js');
    const demo = new Backend(await createDemoTransport());
    await demo.init();
    return demo;
  }
}

class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

class Backend {
  constructor(transport = null) {
    this.transport = transport;
    this.mode = transport ? 'demo' : 'cloudflare';
    this.session = { unlocked: false, admin: false };
  }

  async api(method, path, body, { form = false } = {}) {
    let res;
    try {
      if (this.transport) {
        res = await this.transport.call(method, path, body, form);
      } else {
        res = await fetch(path, {
          method,
          credentials: 'same-origin',
          headers: body && !form ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? (form ? body : JSON.stringify(body)) : undefined,
        });
      }
    } catch (e) {
      console.error(e);
      throw new ApiError(t('Нет связи с сервером. Проверьте интернет (или VPN) и попробуйте ещё раз.'), 0, 'network');
    }
    const type = res.headers.get('Content-Type') || '';
    if (!type.includes('application/json')) {
      const err = new ApiError(t('Сервер недоступен'), res.status, 'no_api');
      err.serverMissing = res.status === 404 || res.status === 405 || res.status === 501 || type.includes('text/html');
      throw err;
    }
    const data = await res.json();
    // сервер отвечает по-русски; перевод — по словарю (тексты ошибок сервера тоже в нём)
    if (!res.ok) throw new ApiError(t(data.error || 'Ошибка сервера'), res.status, data.code);
    return data;
  }

  async init() {
    const s = await this.api('GET', '/api/session');
    this.session = { unlocked: s.family, admin: s.admin };
    return this.session;
  }

  async unlock(code) {
    try {
      await this.api('POST', '/api/unlock', { code });
      this.session.unlocked = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.code || 'error', message: e.message };
    }
  }

  async lock() {
    await this.api('POST', '/api/logout').catch(() => {});
    this.session = { unlocked: false, admin: false };
  }

  async getTree() {
    try {
      return { ok: true, data: await this.api('GET', '/api/tree') };
    } catch (e) {
      if (e.code === 'locked') return { ok: false, error: 'locked' };
      return { ok: false, error: 'network', message: e.message };
    }
  }

  // Ответ: { id (null — если правка применена сразу), created: { main, refs }, target, applied }
  submit({ kind, target, payload, author, comment }) {
    return this.api('POST', '/api/submissions', { kind, target, payload, author, comment });
  }

  async uploadPhoto({ full, thumb }) {
    const fd = new FormData();
    fd.append('full', full, 'full.jpg');
    fd.append('thumb', thumb, 'thumb.jpg');
    return this.api('POST', '/api/uploads', fd, { form: true });
  }

  photoUrl(path) {
    if (!path) return '';
    if (/^https?:|^data:|^blob:/.test(path)) return path;
    if (this.transport) return this.transport.photoUrl(path);
    return '/photos/' + path.split('/').map(encodeURIComponent).join('/');
  }

  async reset() { if (this.transport) await this.transport.reset(); }

  // ---------- администратор ----------
  async adminSession() {
    try { await this.init(); } catch { /* оставляем как было */ }
    return this.session.admin ? { email: 'администратор' } : null;
  }

  async signIn(password) {
    try {
      await this.api('POST', '/api/admin/login', { password });
      this.session.admin = true;
      this.session.unlocked = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async signOut() {
    await this.api('POST', '/api/admin/logout').catch(() => {});
    this.session.admin = false;
  }

  async pendingCount() {
    if (!this.session.admin) return 0;
    try { return (await this.api('GET', '/api/admin/pending-count')).count; } catch { return 0; }
  }

  listSubmissions(status) { return this.api('GET', '/api/admin/submissions?status=' + encodeURIComponent(status)); }
  approveSubmission(id, opts = {}) { return this.api('POST', `/api/admin/submissions/${id}/approve`, opts); }
  rejectSubmission(id, note = '') { return this.api('POST', `/api/admin/submissions/${id}/reject`, { admin_note: note }); }
  reviewSubmission(id, status, note = '') { return this.api('PATCH', '/api/admin/submissions/' + id, { status, admin_note: note }); }
  merge(from, into) { return this.api('POST', '/api/admin/merge', { from, into }); }
  insertPerson(p) { return this.api('POST', '/api/admin/people', p); }
  updatePerson(id, patch) { return this.api('PATCH', '/api/admin/people/' + id, patch); }
  deletePerson(id) { return this.api('DELETE', '/api/admin/people/' + id); }
  addParentChild(parentId, childId, kind = 'birth') { return this.api('POST', '/api/admin/parent-child', { parent_id: parentId, child_id: childId, kind }); }
  removeParentChild(parentId, childId) { return this.api('DELETE', '/api/admin/parent-child', { parent_id: parentId, child_id: childId }); }
  addUnion(u) { return this.api('POST', '/api/admin/unions', u); }
  updateUnion(id, patch) { return this.api('PATCH', '/api/admin/unions/' + id, patch); }
  deleteUnion(id) { return this.api('DELETE', '/api/admin/unions/' + id); }
  insertPhoto(ph) { return this.api('POST', '/api/admin/photos', ph); }
  updatePhoto(id, patch) { return this.api('PATCH', '/api/admin/photos/' + id, patch); }
  deletePhoto(ph) { return this.api('DELETE', '/api/admin/photos/' + ph.id); }
  addNote(note) { return this.api('POST', '/api/admin/notes', note); }
  deleteNote(id) { return this.api('DELETE', '/api/admin/notes/' + id); }
  deleteUploads(paths) { return this.api('POST', '/api/admin/delete-uploads', { paths }); }
  setTitle(title) { return this.api('PUT', '/api/admin/settings', { title }); }
  setFamilyCode(code) { return this.api('PUT', '/api/admin/family-code', { code }); }
  exportAll() { return this.api('GET', '/api/admin/export'); }
  // все данные дерева заменяются данными из резервной копии
  restore(backup) { return this.api('POST', '/api/admin/restore', backup); }

  async bulkImport({ people, parent_child, unions }) {
    // частями, чтобы не упереться в ограничения бесплатного тарифа
    for (let i = 0; i < people.length; i += 250) await this.api('POST', '/api/admin/import', { people: people.slice(i, i + 250) });
    for (let i = 0; i < unions.length; i += 1000) await this.api('POST', '/api/admin/import', { unions: unions.slice(i, i + 1000) });
    for (let i = 0; i < parent_child.length; i += 1000) await this.api('POST', '/api/admin/import', { parent_child: parent_child.slice(i, i + 1000) });
  }
}
