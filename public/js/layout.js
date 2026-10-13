// Раскладка дерева.
//
// Дерево собирается из «блоков»: человек + его супруги в одной строке,
// под ними — блоки детей. Соседние блоки сдвигаются максимально близко
// по контурам (левая/правая граница каждой строки), поэтому ветки не
// пересекаются и не занимают лишнего места.
//
// Строки: чётные (0, 2, 4…) — карточки, нечётные — горизонтальные
// линии к детям между ними.
//
// Если человек уже нарисован в другом месте (например, жена, у которой
// свои родители в дереве), там ставится «отсылка» — полупрозрачная
// карточка, по клику переходящая к основной.

import { computeGenerations } from './model.js';
import { yearOf } from './util.js';

// Карточки вертикальные: фото сверху, имя и годы под ним.
// partnerY — высота линии между супругами (на уровне центра фото).
export const LAYOUT_DEFAULTS = {
  cardW: 140,
  cardH: 156,
  partnerY: 44,
  partnerGap: 22,
  hGap: 26,
  groupGap: 40,
  vGap: 72,
  treeGap: 120,
  margin: 90,
  busStagger: 8,
};

export function layoutFamily(model, options = {}) {
  const b = makeBuilder(model, options);
  return b.family();
}

export function layoutHourglass(model, focusId, options = {}) {
  const b = makeBuilder(model, options);
  return b.hourglass(focusId);
}

function makeBuilder(model, options) {
  const o = { ...LAYOUT_DEFAULTS, ...options };
  const W = o.cardW;
  const placed = new Set();

  // ---------- операции с блоками ----------
  const newBlock = () => ({ cards: [], plinks: [], fams: [], L: new Map(), R: new Map(), rootCard: null });

  function extend(b, row, lo, hi) {
    if (!b.L.has(row) || lo < b.L.get(row)) b.L.set(row, lo);
    if (!b.R.has(row) || hi > b.R.get(row)) b.R.set(row, hi);
  }

  function shift(b, dx, drow = 0) {
    for (const c of b.cards) { c.x += dx; c.row += drow; }
    for (const l of b.plinks) { l.x1 += dx; l.x2 += dx; l.row += drow; }
    for (const f of b.fams) { f.ax += dx; f.row += drow; }
    const L = new Map(), R = new Map();
    for (const [r, v] of b.L) L.set(r + drow, v + dx);
    for (const [r, v] of b.R) R.set(r + drow, v + dx);
    b.L = L; b.R = R;
  }

  function absorb(target, src, skipCard = null) {
    for (const c of src.cards) if (c !== skipCard) target.cards.push(c);
    target.plinks.push(...src.plinks);
    target.fams.push(...src.fams);
    for (const [r, v] of src.L) extend(target, r, v, src.R.get(r));
  }

  const minLeft = b => Math.min(...b.L.values());
  const maxRight = b => Math.max(...b.R.values());

  // Насколько сдвинуть блок b, чтобы он встал вплотную справа от a.
  function requiredShift(a, b, gapFn) {
    let dx = -Infinity;
    for (const [r, bl] of b.L) {
      if (a.R.has(r)) dx = Math.max(dx, a.R.get(r) + gapFn(r) - bl);
    }
    if (dx === -Infinity) dx = maxRight(a) + o.hGap - minLeft(b);
    return dx;
  }

  const sibGap = r => (r % 2 === 0 ? o.hGap : o.hGap / 2);
  const grpGap = r => (r % 2 === 0 ? o.groupGap : o.hGap / 2);

  function leaf(personId, ghost) {
    const b = newBlock();
    const card = { personId, ghost, x: 0, row: 0 };
    b.cards.push(card);
    b.rootCard = card;
    extend(b, 0, -W / 2, W / 2);
    return b;
  }

  // ---------- порядок супругов ----------
  function unionCmp(a, b) {
    const ya = yearOf(a.union.start_date) ?? 9999;
    const yb = yearOf(b.union.start_date) ?? 9999;
    if (ya !== yb) return ya - yb;
    const sa = a.union.status === 'married' ? 1 : 0;
    const sb = b.union.status === 'married' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return String(a.union.created_at || '').localeCompare(String(b.union.created_at || ''));
  }
  const orderedPartners = id => model.partners(id).slice().sort(unionCmp);

  // ---------- блок потомков ----------
  function buildBlock(pid) {
    placed.add(pid);
    const me = { id: pid, ghost: false };
    const unionsHere = []; // { a: entry, b: entry|null, union }
    const newPartners = [];

    const partnerEntries = orderedPartners(pid).map(({ id, union }) => {
      const ghost = placed.has(id);
      if (!ghost) placed.add(id);
      const e = { id, ghost };
      if (!ghost) newPartners.push(e);
      unionsHere.push({ a: me, b: e, union });
      return e;
    });

    let row;
    if (!partnerEntries.length) {
      row = [me];
    } else if (partnerEntries.length === 1) {
      const q = partnerEntries[0];
      const pg = model.get(pid)?.gender, qg = model.get(q.id)?.gender;
      row = (pg === 'f' && qg === 'm') ? [q, me] : [me, q];
    } else {
      row = [partnerEntries[0], me, ...partnerEntries.slice(1)];
    }

    // Другие браки супругов (один уровень): ставим с внешней стороны.
    for (const q of newPartners) {
      const others = orderedPartners(q.id).filter(x => x.id !== pid);
      if (!others.length) continue;
      const outer = others.map(({ id, union }) => {
        const ghost = placed.has(id);
        if (!ghost) placed.add(id);
        const e = { id, ghost };
        unionsHere.push({ a: q, b: e, union });
        return e;
      });
      const qIdx = row.indexOf(q);
      if (qIdx < row.indexOf(me)) row.splice(qIdx, 0, ...outer.reverse());
      else row.splice(qIdx + 1, 0, ...outer);
    }

    // Дети, у которых известен только один родитель.
    for (const e of [me, ...newPartners]) {
      if (model.childrenOfPair(e.id, null).length) unionsHere.push({ a: e, b: null, union: null });
    }

    const block = newBlock();
    const step = W + o.partnerGap;
    row.forEach((e, i) => {
      e.x = i * step;
      const card = { personId: e.id, ghost: e.ghost, x: e.x, row: 0 };
      e.card = card;
      block.cards.push(card);
    });
    block.rootCard = me.card;
    extend(block, 0, row[0].x - W / 2, row[row.length - 1].x + W / 2);

    for (const u of unionsHere) {
      if (u.b) {
        const i = row.indexOf(u.a), j = row.indexOf(u.b);
        const [l, r] = i < j ? [row[i], row[j]] : [row[j], row[i]];
        const adjacent = Math.abs(i - j) === 1;
        block.plinks.push({ x1: l.x, x2: r.x, row: 0, adjacent, status: u.union.status, ids: [u.a.id, u.b.id] });
        u.ax = adjacent ? (l.x + r.x) / 2 : u.b.x;
        u.ay = adjacent ? 'center' : 'bottom';
      } else {
        u.ax = u.a.x;
        u.ay = 'bottom';
      }
    }

    const groups = [];
    for (const u of unionsHere.slice().sort((a, b) => a.ax - b.ax)) {
      const kidIds = model.childrenOfPair(u.a.id, u.b ? u.b.id : null);
      if (!kidIds.length) continue;
      const kidBlocks = kidIds.map(cid => (placed.has(cid) ? leaf(cid, true) : buildBlock(cid)));
      groups.push({ u, kidBlocks });
    }

    if (groups.length) {
      let acc = null;
      for (const g of groups) {
        g.kidBlocks.forEach((kb, i) => {
          if (!acc) { acc = kb; return; }
          const dx = requiredShift(acc, kb, i === 0 ? grpGap : sibGap);
          shift(kb, dx);
          absorb(acc, kb);
        });
      }
      shift(acc, 0, 2);
      const anchors = groups.map(g => g.u.ax);
      const anchorMid = (Math.min(...anchors) + Math.max(...anchors)) / 2;
      const kidXs = groups.flatMap(g => g.kidBlocks.map(kb => kb.rootCard.x));
      const kidMid = (Math.min(...kidXs) + Math.max(...kidXs)) / 2;
      shift(acc, anchorMid - kidMid);
      absorb(block, acc);

      groups.forEach((g, i) => {
        const fam = {
          ax: g.u.ax,
          ay: g.u.ay,
          row: 0,
          stagger: i - (groups.length - 1) / 2,
          kids: g.kidBlocks.map(kb => kb.rootCard),
          ids: [g.u.a.id, g.u.b ? g.u.b.id : null].filter(Boolean),
        };
        block.fams.push(fam);
        const xs = [fam.ax, ...fam.kids.map(c => c.x)];
        extend(block, 1, Math.min(...xs), Math.max(...xs));
      });
    }
    return block;
  }

  // ---------- блок предков (вверх) ----------
  function buildAncestors(pid, visited, depth) {
    const block = leaf(pid, false);
    if (depth > 40) return block;
    const parents = model.parents(pid).slice().sort((a, b) => {
      const ga = model.get(a)?.gender === 'm' ? 0 : 1;
      const gb = model.get(b)?.gender === 'm' ? 0 : 1;
      return ga - gb;
    });
    if (!parents.length) return block;

    const pblocks = parents.map(p => {
      if (visited.has(p) || placed.has(p)) return leaf(p, true);
      visited.add(p);
      return buildAncestors(p, visited, depth + 1);
    });
    let acc = pblocks[0];
    for (let i = 1; i < pblocks.length; i++) {
      const dx = requiredShift(acc, pblocks[i], r => (r === 0 ? o.partnerGap : sibGap(r)));
      shift(pblocks[i], dx);
      absorb(acc, pblocks[i]);
    }
    shift(acc, 0, -2);
    const pc = pblocks.map(pb => pb.rootCard);
    const couple = pc.length === 2;
    const anchor = couple ? (pc[0].x + pc[1].x) / 2 : pc[0].x;
    shift(acc, -anchor);
    absorb(block, acc);

    if (couple) {
      const un = model.partners(pc[0].personId).find(x => x.id === pc[1].personId);
      block.plinks.push({ x1: pc[0].x, x2: pc[1].x, row: -2, adjacent: true, status: un ? un.union.status : '', ids: [pc[0].personId, pc[1].personId] });
    }
    block.fams.push({ ax: 0, ay: couple ? 'center' : 'bottom', row: -2, stagger: 0, kids: [block.rootCard], ids: pc.map(c => c.personId) });
    extend(block, -1, Math.min(0, block.rootCard.x), Math.max(0, block.rootCard.x));
    return block;
  }

  // ---------- итоговые координаты ----------
  function finalize(block) {
    const H = o.cardH;
    const rowH = H + o.vGap;
    const cardRows = block.cards.map(c => c.row);
    const minRow = cardRows.length ? Math.min(...cardRows) : 0;
    const maxRow = cardRows.length ? Math.max(...cardRows) : 0;
    const dx = o.margin - (block.cards.length ? minLeft(block) : 0);
    const top = r => ((r - minRow) / 2) * rowH + o.margin;

    const cards = block.cards.map(c => ({
      personId: c.personId,
      ghost: c.ghost,
      cx: c.x + dx,
      x: c.x + dx - W / 2,
      y: top(c.row),
      w: W,
      h: H,
    }));
    const index = new Map();
    for (const c of cards) if (!c.ghost && !index.has(c.personId)) index.set(c.personId, c);

    const PY = o.partnerY ?? H / 2;
    const lines = [];
    for (const l of block.plinks) {
      const y0 = top(l.row);
      const x1 = l.x1 + dx, x2 = l.x2 + dx;
      if (l.adjacent) {
        lines.push({ kind: 'partner', status: l.status, ids: l.ids, d: `M${x1 + W / 2},${y0 + PY} H${x2 - W / 2}` });
      } else {
        lines.push({ kind: 'partner', status: l.status, ids: l.ids, d: `M${x1},${y0} V${y0 - 16} H${x2} V${y0}` });
      }
    }
    for (const f of block.fams) {
      const y0 = top(f.row);
      const ax = f.ax + dx;
      const ay = f.ay === 'center' ? y0 + PY : y0 + H;
      const busY = y0 + H + o.vGap / 2 + f.stagger * o.busStagger;
      for (const k of f.kids) {
        const kx = k.x + dx;
        const ky = top(k.row);
        lines.push({ kind: 'family', ids: [...f.ids, k.personId], parents: f.ids, child: k.personId, parentY: y0, childY: ky, d: famPath(ax, ay, busY, kx, ky) });
      }
    }

    // ряды поколений: верх ряда и люди в нём (для полос и подписей десятилетий)
    const rows = [];
    for (let r = minRow; r <= maxRow; r += 2) {
      const ids = block.cards.filter(c => c.row === r && !c.ghost).map(c => c.personId);
      if (ids.length) rows.push({ y: top(r), ids });
    }

    const width = (block.cards.length ? maxRight(block) + dx : 0) + o.margin;
    const height = ((maxRow - minRow) / 2) * rowH + H + o.margin * 2;
    return { cards, lines, rows, width, height, index, options: o };
  }

  function famPath(ax, ay, busY, kx, ky) {
    if (Math.abs(kx - ax) < 1) return `M${ax},${ay} V${ky}`;
    const r = Math.max(0, Math.min(12, Math.abs(kx - ax) / 2, busY - ay, ky - busY));
    const dir = kx > ax ? 1 : -1;
    return `M${ax},${ay} V${busY - r} Q${ax},${busY} ${ax + dir * r},${busY} H${kx - dir * r} Q${kx},${busY} ${kx},${busY + r} V${ky}`;
  }

  // ---------- режимы ----------
  function family() {
    const gen = computeGenerations(model);
    const order = id => model.get(id)?._order ?? 0;
    const descCount = new Map();
    const dc = id => {
      if (!descCount.has(id)) descCount.set(id, model.descendants(id).size);
      return descCount.get(id);
    };
    const hasParents = id => model.parents(id).length > 0;
    const roots = [...model.people.keys()].filter(id =>
      !hasParents(id) && !model.partners(id).some(p => hasParents(p.id)));
    roots.sort((a, b) => gen.get(a) - gen.get(b) || dc(b) - dc(a) || order(a) - order(b));

    const forest = [];
    const addTree = id => {
      const b = buildBlock(id);
      shift(b, 0, 2 * gen.get(id));
      forest.push(b);
    };
    for (const r of roots) if (!placed.has(r)) addTree(r);
    while (placed.size < model.people.size) {
      let best = null;
      for (const id of model.people.keys()) {
        if (placed.has(id)) continue;
        if (best === null || gen.get(id) < gen.get(best) || (gen.get(id) === gen.get(best) && order(id) < order(best))) best = id;
      }
      addTree(best);
    }

    const all = newBlock();
    let cursor = 0;
    forest.forEach((b, i) => {
      const dx = (i === 0 ? 0 : cursor) - minLeft(b);
      shift(b, dx);
      absorb(all, b);
      cursor = maxRight(b) + o.treeGap;
    });
    return finalize(all);
  }

  function hourglass(focusId) {
    if (!model.get(focusId)) return family();
    const down = buildBlock(focusId);
    const up = buildAncestors(focusId, new Set([focusId]), 0);
    shift(up, down.rootCard.x - up.rootCard.x);
    for (const f of up.fams) f.kids = f.kids.map(k => (k === up.rootCard ? down.rootCard : k));
    up.L.delete(0); up.R.delete(0);
    absorb(down, up, up.rootCard);
    return finalize(down);
  }

  return { family, hourglass };
}
