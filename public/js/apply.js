// Применение изменений к базе (только администратор).
// Один формат «payload» используется и для заявок родственников,
// и для прямого редактирования администратором:
//
// {
//   person:    { поля человека }            — для правки: только изменённые
//   relations: {
//     add:    [{ type: 'parent'|'partner'|'child', ref: {id}|{new:{…}}, status?, key?, otherParent? }],
//     remove: [{ type, id }],
//     update: [{ type: 'partner', id, status }],
//   },
//   photos:    [{ path, thumb_path, caption }]
// }

function findUnion(model, a, b) {
  return (model.unionsOf.get(a) || []).find(u => u.partner1_id === b || u.partner2_id === b) || null;
}

// links: { [индекс в relations.add]: id существующего человека } — админ
// может при проверке указать, что «новый» человек уже есть в дереве.
export async function applyChange(backend, model, { targetId = null, payload, links = {} }) {
  const rel = payload.relations || {};
  let pid = targetId;

  if (!pid) {
    const rec = await backend.insertPerson(payload.person || {});
    pid = rec.id;
  } else if (payload.person && Object.keys(payload.person).length) {
    await backend.updatePerson(pid, payload.person);
  }

  const created = new Map(); // ключ ссылки -> id
  const resolveRef = async (ref, idx) => {
    if (!ref) return null;
    if (ref.id) return ref.id;
    if (links[idx]) return links[idx];
    const rec = await backend.insertPerson(ref.new || {});
    return rec.id;
  };

  for (const r of rel.remove || []) {
    if (r.type === 'parent') await backend.removeParentChild(r.id, pid);
    else if (r.type === 'child') await backend.removeParentChild(pid, r.id);
    else if (r.type === 'partner') {
      const u = findUnion(model, pid, r.id);
      if (u && !u.implicit) await backend.deleteUnion(u.id);
    }
  }

  for (const r of rel.update || []) {
    if (r.type !== 'partner') continue;
    const u = findUnion(model, pid, r.id);
    if (u && !u.implicit) await backend.updateUnion(u.id, { status: r.status });
    else await backend.addUnion({ partner1_id: pid, partner2_id: r.id, status: r.status });
  }

  const adds = rel.add || [];
  for (const [i, r] of adds.entries()) {
    if (r.type !== 'partner') continue;
    const qid = await resolveRef(r.ref, i);
    if (!qid || qid === pid) continue;
    if (r.key) created.set(r.key, qid);
    const u = findUnion(model, pid, qid);
    if (!u || u.implicit) await backend.addUnion({ partner1_id: pid, partner2_id: qid, status: r.status || 'married' });
    else if (r.status && r.status !== u.status) await backend.updateUnion(u.id, { status: r.status });
  }

  for (const [i, r] of adds.entries()) {
    if (r.type !== 'parent') continue;
    const parentId = await resolveRef(r.ref, i);
    if (!parentId || parentId === pid) continue;
    await backend.addParentChild(parentId, pid, r.kind || 'birth');
  }

  for (const [i, r] of adds.entries()) {
    if (r.type !== 'child') continue;
    const cid = await resolveRef(r.ref, i);
    if (!cid || cid === pid) continue;
    await backend.addParentChild(pid, cid, 'birth');
    let other = null;
    if (r.otherParent?.id) other = r.otherParent.id;
    else if (r.otherParent?.key) other = created.get(r.otherParent.key) || null;
    if (other && other !== cid) await backend.addParentChild(other, cid, 'birth');
  }

  let firstPhoto = null;
  for (const ph of payload.photos || []) {
    const rec = await backend.insertPhoto({ person_id: pid, path: ph.path, thumb_path: ph.thumb_path, caption: ph.caption || '' });
    if (!firstPhoto) firstPhoto = rec;
  }
  const existing = model.get(pid);
  if (firstPhoto && !(existing && existing.main_photo_id)) {
    await backend.updatePerson(pid, { main_photo_id: firstPhoto.id });
  }
  return pid;
}

// Все «новые» ссылки в заявке — для выбора «это уже есть в дереве».
export function newRefs(payload) {
  return (payload.relations?.add || [])
    .map((r, i) => ({ r, i }))
    .filter(x => x.r.ref && x.r.ref.new);
}
