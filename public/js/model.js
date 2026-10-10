// Модель дерева: индексы связей поверх «сырых» данных из базы.

import { birthSortKey } from './util.js';

export function buildModel(raw) {
  const people = new Map();
  (raw.people || []).forEach((p, i) => people.set(p.id, { ...p, _order: i }));

  const parentsOf = new Map();   // childId -> [{id, kind}]
  const childrenOf = new Map();  // parentId -> [childId]
  for (const r of raw.parent_child || []) {
    if (!people.has(r.parent_id) || !people.has(r.child_id)) continue;
    push(parentsOf, r.child_id, { id: r.parent_id, kind: r.kind || 'birth' });
    push(childrenOf, r.parent_id, r.child_id);
  }

  // Явные союзы + неявные (у ребёнка два родителя, а союз не записан).
  const unions = [];
  const unionKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const byKey = new Map();
  for (const u of raw.unions || []) {
    if (!people.has(u.partner1_id) || !people.has(u.partner2_id)) continue;
    const k = unionKey(u.partner1_id, u.partner2_id);
    if (byKey.has(k)) continue;
    const un = { ...u, implicit: false };
    unions.push(un);
    byKey.set(k, un);
  }
  for (const [childId, parents] of parentsOf) {
    if (parents.length < 2) continue;
    const [a, b] = parents;
    const k = unionKey(a.id, b.id);
    if (!byKey.has(k)) {
      const un = { id: 'implicit:' + k, partner1_id: a.id, partner2_id: b.id, status: '', implicit: true };
      unions.push(un);
      byKey.set(k, un);
    }
  }
  const unionsOf = new Map();
  for (const u of unions) {
    push(unionsOf, u.partner1_id, u);
    push(unionsOf, u.partner2_id, u);
  }

  const photosOf = new Map();
  const photosById = new Map();
  for (const ph of raw.photos || []) {
    if (!people.has(ph.person_id)) continue;
    push(photosOf, ph.person_id, ph);
    photosById.set(ph.id, ph);
  }

  const model = {
    title: raw.title || 'Семейное дерево',
    people,
    unions,
    parentsOf,
    childrenOf,
    unionsOf,
    photosOf,

    get(id) { return people.get(id) || null; },

    parents(id) { return (parentsOf.get(id) || []).map(r => r.id); },

    parentLinks(id) { return parentsOf.get(id) || []; },

    children(id) {
      return sortByBirth((childrenOf.get(id) || []).map(cid => people.get(cid)).filter(Boolean)).map(p => p.id);
    },

    partners(id) {
      return (unionsOf.get(id) || []).map(u => ({
        id: u.partner1_id === id ? u.partner2_id : u.partner1_id,
        union: u,
      }));
    },

    // Дети конкретной пары (или одного родителя, если otherId = null).
    childrenOfPair(id, otherId) {
      return this.children(id).filter(cid => {
        const ps = this.parents(cid);
        if (otherId) return ps.includes(otherId);
        return ps.length === 1;
      });
    },

    siblings(id) {
      const ps = this.parents(id);
      const res = new Map();
      for (const pid of ps) {
        for (const cid of childrenOf.get(pid) || []) {
          if (cid === id || res.has(cid)) continue;
          const cps = this.parents(cid);
          const shared = ps.filter(x => cps.includes(x));
          // «по отцу/по матери» — только если у обоих известны оба родителя и общий один
          let half = '';
          if (ps.length === 2 && cps.length === 2 && shared.length === 1) {
            const g = people.get(shared[0])?.gender;
            half = g === 'm' ? 'father' : g === 'f' ? 'mother' : 'one';
          }
          res.set(cid, { id: cid, half });
        }
      }
      return sortByBirth([...res.values()].map(s => ({ ...people.get(s.id), _half: s.half }))).map(p => ({ id: p.id, half: p._half }));
    },

    photos(id) { return photosOf.get(id) || []; },

    mainPhoto(id) {
      const p = people.get(id);
      const list = photosOf.get(id) || [];
      if (!list.length) return null;
      return (p && p.main_photo_id && photosById.get(p.main_photo_id)) || list[0];
    },

    ancestors(id) {
      const seen = new Set();
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (const pid of this.parents(cur)) {
          if (!seen.has(pid)) { seen.add(pid); stack.push(pid); }
        }
      }
      return seen;
    },

    descendants(id) {
      const seen = new Set();
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (const cid of childrenOf.get(cur) || []) {
          if (!seen.has(cid)) { seen.add(cid); stack.push(cid); }
        }
      }
      return seen;
    },
  };
  return model;
}

function push(map, key, value) {
  const arr = map.get(key);
  if (arr) arr.push(value); else map.set(key, [value]);
}

export function sortByBirth(list) {
  return [...list].sort((a, b) => birthSortKey(a) - birthSortKey(b) || (a._order ?? 0) - (b._order ?? 0));
}

// Поколения: родители выше детей, супруги на одном уровне.
export function computeGenerations(model) {
  const gen = new Map();
  for (const id of model.people.keys()) gen.set(id, 0);
  const n = model.people.size;
  for (let pass = 0; pass < n * 2 + 10; pass++) {
    let changed = false;
    for (const id of model.people.keys()) {
      const ps = model.parents(id);
      if (ps.length) {
        const target = Math.max(...ps.map(p => gen.get(p))) + 1;
        if (target > gen.get(id) && target <= n) { gen.set(id, target); changed = true; }
      }
    }
    for (const u of model.unions) {
      const a = gen.get(u.partner1_id), b = gen.get(u.partner2_id);
      if (a !== b) {
        const g = Math.max(a, b);
        gen.set(u.partner1_id, g); gen.set(u.partner2_id, g);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return gen;
}
