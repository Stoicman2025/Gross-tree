// «Кем приходится»: степень родства B по отношению к A на русском.
//
// Кровное родство считается через ближайшего общего предка:
// a — сколько поколений вверх от A, b — от B.
// Родство через брак: супруги, родня супруга, супруги родни, сваты.

import { displayName } from './util.js';

const DEGREE = {
  m: ['', '', 'двоюродный', 'троюродный', 'четвероюродный', 'пятиюродный', 'шестиюродный', 'семиюродный'],
  f: ['', '', 'двоюродная', 'троюродная', 'четвероюродная', 'пятиюродная', 'шестиюродная', 'семиюродная'],
};

function degreeWord(index, g) {
  if (index <= 1) return '';
  const list = DEGREE[g === 'f' ? 'f' : 'm'];
  if (index < list.length) return list[index];
  return `${index}-юродн${g === 'f' ? 'ая' : 'ый'}`;
}

function pick(g, m, f) {
  if (g === 'm') return m;
  if (g === 'f') return f;
  return `${m} / ${f}`;
}

function withDegree(index, g, m, f) {
  if (g !== 'm' && g !== 'f') {
    const dm = degreeWord(index, 'm'), df = degreeWord(index, 'f');
    return `${(dm ? dm + ' ' : '') + m} / ${(df ? df + ' ' : '') + f}`;
  }
  const d = degreeWord(index, g);
  return (d ? d + ' ' : '') + (g === 'f' ? f : m);
}

const pra = n => 'пра'.repeat(Math.max(0, n));

// Кровное родство: кем B приходится A.
export function bloodTerm(a, b, g, half = '') {
  if (a === 0 && b === 0) return 'это один и тот же человек';
  if (b === 0) {
    if (a === 1) return pick(g, 'отец', 'мать');
    return pick(g, pra(a - 2) + 'дедушка', pra(a - 2) + 'бабушка');
  }
  if (a === 0) {
    if (b === 1) return pick(g, 'сын', 'дочь');
    return pick(g, pra(b - 2) + 'внук', pra(b - 2) + 'внучка');
  }
  const k = Math.min(a, b);
  if (a === b) {
    let t = withDegree(k, g, 'брат', 'сестра');
    if (k === 1 && half) t += half === 'father' ? ' по отцу' : half === 'mother' ? ' по матери' : ' (сводный по одному из родителей)';
    return t;
  }
  if (a > b) {
    const d = a - b;
    if (d === 1) return withDegree(k, g, 'дядя', 'тётя');
    return withDegree(k + 1, g, pra(d - 2) + 'дедушка', pra(d - 2) + 'бабушка');
  }
  const d = b - a;
  if (d === 1) return withDegree(k, g, 'племянник', 'племянница');
  return withDegree(k, g, pra(d - 2) + 'внучатый племянник', pra(d - 2) + 'внучатая племянница');
}

// Родительный падеж для простых терминов: «двоюродный брат» → «двоюродного брата».
const NOUN_GEN = {
  отец: 'отца', мать: 'матери', сын: 'сына', дочь: 'дочери', брат: 'брата', сестра: 'сестры',
  дядя: 'дяди', тётя: 'тёти', дедушка: 'дедушки', бабушка: 'бабушки', внук: 'внука', внучка: 'внучки',
  племянник: 'племянника', племянница: 'племянницы', муж: 'мужа', жена: 'жены',
};

export function genitive(phrase) {
  if (phrase.includes(' / ') || phrase.includes('(')) return phrase;
  return phrase.split(' ').map(w => {
    const m = w.match(/^((?:пра)*)(.*)$/);
    const prefix = m[1], base = m[2];
    if (NOUN_GEN[base]) return prefix + NOUN_GEN[base];
    if (/ый$/.test(w)) return w.replace(/ый$/, 'ого');
    if (/ий$/.test(w)) return w.replace(/ий$/, 'его');
    if (/ая$/.test(w)) return w.replace(/ая$/, 'ой');
    if (/яя$/.test(w)) return w.replace(/яя$/, 'ей');
    if (/^по$|^отцу$|^матери$/.test(w)) return w;
    return w;
  }).join(' ');
}

// Все предки с расстоянием (сам человек — 0) и ссылкой на ребёнка для пути.
function ancestorMap(model, id) {
  const dist = new Map([[id, 0]]);
  const via = new Map();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const p of model.parents(cur)) {
      if (!dist.has(p)) { dist.set(p, dist.get(cur) + 1); via.set(p, cur); queue.push(p); }
    }
  }
  return { dist, via };
}

function pathUp(via, from, to) {
  // путь от «from» вверх до «to» (to — предок from)
  const chain = [to];
  let cur = to;
  while (cur !== from) { cur = via.get(cur); chain.push(cur); }
  return chain.reverse();
}

export function bloodRelation(model, aId, bId) {
  if (aId === bId) return { a: 0, b: 0, path: [aId] };
  const A = ancestorMap(model, aId);
  const B = ancestorMap(model, bId);
  let best = null;
  for (const [anc, da] of A.dist) {
    if (!B.dist.has(anc)) continue;
    const db = B.dist.get(anc);
    if (!best || da + db < best.a + best.b) best = { anc, a: da, b: db };
  }
  if (!best) return null;
  const up = pathUp(A.via, aId, best.anc);           // A … LCA
  const down = pathUp(B.via, bId, best.anc).reverse(); // LCA … B
  return { a: best.a, b: best.b, path: [...up, ...down.slice(1)] };
}

function halfInfo(model, aId, bId) {
  const pa = model.parents(aId), pb = model.parents(bId);
  if (pa.length !== 2 || pb.length !== 2) return '';
  const shared = pa.filter(x => pb.includes(x));
  if (shared.length !== 1) return '';
  const g = model.get(shared[0])?.gender;
  return g === 'm' ? 'father' : g === 'f' ? 'mother' : 'one';
}

function bloodText(model, aId, bId, rel) {
  const g = model.get(bId)?.gender || '';
  const half = rel.a === 1 && rel.b === 1 ? halfInfo(model, aId, bId) : '';
  let t = bloodTerm(rel.a, rel.b, g, half);
  if (rel.a === 0 && rel.b === 1) {
    const link = model.parentLinks(bId).find(l => l.id === aId);
    if (link && link.kind === 'adopted') t = pick(g, 'приёмный сын', 'приёмная дочь');
  }
  if (rel.a === 1 && rel.b === 0) {
    const link = model.parentLinks(aId).find(l => l.id === bId);
    if (link && link.kind === 'adopted') t = pick(g, 'приёмный отец', 'приёмная мать');
  }
  return t;
}

// Основная функция: кем B приходится A.
export function relationship(model, aId, bId) {
  const A = model.get(aId), B = model.get(bId);
  if (!A || !B) return null;
  if (aId === bId) return { text: 'это один и тот же человек', path: [aId], kind: 'self' };

  const blood = bloodRelation(model, aId, bId);
  if (blood) return { text: bloodText(model, aId, bId, blood), path: blood.path, kind: 'blood' };

  const gB = B.gender || '';

  // 1. Супруги
  const direct = model.partners(aId).find(p => p.id === bId);
  if (direct) {
    const st = direct.union.status;
    let t = pick(gB, 'муж', 'жена');
    if (st === 'divorced') t = pick(gB, 'бывший муж', 'бывшая жена');
    if (st === 'partner') t = pick(gB, 'партнёр', 'партнёрша');
    return { text: t, path: [aId, bId], kind: 'marriage' };
  }

  // 2. B — супруг(а) кровного родственника A
  for (const { id: sId } of model.partners(bId)) {
    const rel = bloodRelation(model, aId, sId);
    if (!rel || (rel.a === 0 && rel.b === 0)) continue;
    const gS = model.get(sId)?.gender || '';
    let t;
    if (rel.a === 0 && rel.b === 1) t = pick(gB, 'зять', 'невестка');
    else if (rel.a === 1 && rel.b === 1) t = pick(gB, 'зять (муж сестры)', 'невестка (жена брата)');
    else if (rel.a === 1 && rel.b === 0) t = pick(gB, 'отчим', 'мачеха');
    else {
      const term = bloodText(model, aId, sId, rel);
      t = `${pick(gB, 'муж', 'жена')} ${genitive(term)}`;
      if (gS === '' && term.includes(' / ')) t = `${pick(gB, 'муж', 'жена')}: ${term}`;
    }
    return { text: t, path: [...rel.path, bId], kind: 'marriage' };
  }

  // 3. B — кровный родственник супруга(и) A
  for (const { id: sId } of model.partners(aId)) {
    const rel = bloodRelation(model, sId, bId);
    if (!rel || (rel.a === 0 && rel.b === 0)) continue;
    const gS = model.get(sId)?.gender || '';
    const gA = A.gender || '';
    const spouseIsWife = gS === 'f' || (gS === '' && gA === 'm');
    const spouseIsHusband = gS === 'm' || (gS === '' && gA === 'f');
    let t;
    if (rel.a === 1 && rel.b === 0) {
      if (spouseIsWife) t = pick(gB, 'тесть', 'тёща');
      else if (spouseIsHusband) t = pick(gB, 'свёкор', 'свекровь');
    } else if (rel.a === 1 && rel.b === 1) {
      if (spouseIsWife) t = pick(gB, 'шурин (брат жены)', 'свояченица (сестра жены)');
      else if (spouseIsHusband) t = pick(gB, 'деверь (брат мужа)', 'золовка (сестра мужа)');
    } else if (rel.a === 0 && rel.b === 1) {
      t = pick(gB, 'пасынок', 'падчерица');
    }
    if (!t) {
      const term = bloodText(model, sId, bId, rel);
      const whose = spouseIsWife ? 'жены' : spouseIsHusband ? 'мужа' : 'супруга(и)';
      t = `${term} ${whose}`;
    }
    return { text: t, path: [aId, ...rel.path], kind: 'marriage' };
  }

  // 4. Сваты: родители супруга(и) ребёнка
  for (const cId of model.children(aId)) {
    for (const { id: dId } of model.partners(cId)) {
      if (model.parents(dId).includes(bId)) {
        return { text: pick(gB, 'сват', 'сватья'), path: [aId, cId, dId, bId], kind: 'marriage' };
      }
    }
  }

  // 5. Свояк: мужья сестёр
  for (const { id: sId } of model.partners(aId)) {
    for (const { id: tId } of model.partners(bId)) {
      const rel = bloodRelation(model, sId, tId);
      if (rel && rel.a === 1 && rel.b === 1 && A.gender === 'm' && gB === 'm') {
        return { text: 'свояк (муж сестры жены)', path: [aId, sId, ...rel.path.slice(1), bId], kind: 'marriage' };
      }
    }
  }

  // 6. Дальнее родство: кратчайший путь по любым связям
  const path = shortestPath(model, aId, bId);
  if (path) return { text: 'дальний родственник (через брак)', path, kind: 'distant' };
  return { text: 'родство не найдено — эти люди пока не связаны в дереве', path: [], kind: 'none' };
}

export function shortestPath(model, aId, bId) {
  const prev = new Map([[aId, null]]);
  const queue = [aId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === bId) break;
    const next = [
      ...model.parents(cur),
      ...(model.childrenOf.get(cur) || []),
      ...model.partners(cur).map(p => p.id),
    ];
    for (const n of next) if (!prev.has(n)) { prev.set(n, cur); queue.push(n); }
  }
  if (!prev.has(bId)) return null;
  const path = [];
  for (let cur = bId; cur !== null; cur = prev.get(cur)) path.push(cur);
  return path.reverse();
}

// Подписи шагов пути: «Иван → отец → Пётр → …»
export function describePath(model, path) {
  const steps = [];
  for (let i = 0; i < path.length; i++) {
    const id = path[i];
    const p = model.get(id);
    if (i > 0) {
      const prevId = path[i - 1];
      const g = p?.gender || '';
      let label;
      if (model.parents(prevId).includes(id)) label = pick(g, 'отец', 'мать');
      else if (model.parents(id).includes(prevId)) label = pick(g, 'сын', 'дочь');
      else label = pick(g, 'муж', 'жена');
      steps.push({ label });
    }
    steps.push({ id, name: displayName(p) });
  }
  return steps;
}
