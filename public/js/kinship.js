// «Кем приходится»: степень родства B по отношению к A — по-русски, по-английски, по-немецки.
//
// Кровное родство считается через ближайшего общего предка:
// a — сколько поколений вверх от A, b — от B.
// Родство через брак: супруги, родня супруга, супруги родни, сваты.
// Структура родства общая, а названия — свои в каждом языке (TERMS ниже).

import { displayName } from './util.js';
import { getLang } from './i18n.js';

function pick(g, m, f) {
  if (g === 'm') return m;
  if (g === 'f') return f;
  return `${m} / ${f}`;
}

// ============================================================
// Русский
// ============================================================
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

function withDegree(index, g, m, f) {
  if (g !== 'm' && g !== 'f') {
    const dm = degreeWord(index, 'm'), df = degreeWord(index, 'f');
    return `${(dm ? dm + ' ' : '') + m} / ${(df ? df + ' ' : '') + f}`;
  }
  const d = degreeWord(index, g);
  return (d ? d + ' ' : '') + (g === 'f' ? f : m);
}

const pra = n => 'пра'.repeat(Math.max(0, n));

function ruBlood(a, b, g, half) {
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
    return w;
  }).join(' ');
}

const RU = {
  same: 'это один и тот же человек',
  blood: ruBlood,
  adoptedChild: g => pick(g, 'приёмный сын', 'приёмная дочь'),
  adoptiveParent: g => pick(g, 'приёмный отец', 'приёмная мать'),
  spouse(g, status) {
    if (status === 'divorced') return pick(g, 'бывший муж', 'бывшая жена');
    if (status === 'partner') return pick(g, 'партнёр', 'партнёрша');
    return pick(g, 'муж', 'жена');
  },
  // B — супруг(а) кровного родственника S
  spouseOfBlood(rel, gB, gS, term) {
    if (rel.a === 0 && rel.b === 1) return pick(gB, 'зять', 'невестка');
    if (rel.a === 1 && rel.b === 1) return pick(gB, 'зять (муж сестры)', 'невестка (жена брата)');
    if (rel.a === 1 && rel.b === 0) return pick(gB, 'отчим', 'мачеха');
    if (gS === '' && term.includes(' / ')) return `${pick(gB, 'муж', 'жена')}: ${term}`;
    return `${pick(gB, 'муж', 'жена')} ${genitive(term)}`;
  },
  // B — кровный родственник супруга(и) S; sp: 'wife' | 'husband' | ''
  bloodOfSpouse(rel, gB, sp, term) {
    if (rel.a === 1 && rel.b === 0) {
      if (sp === 'wife') return pick(gB, 'тесть', 'тёща');
      if (sp === 'husband') return pick(gB, 'свёкор', 'свекровь');
    } else if (rel.a === 1 && rel.b === 1) {
      if (sp === 'wife') return pick(gB, 'шурин (брат жены)', 'свояченица (сестра жены)');
      if (sp === 'husband') return pick(gB, 'деверь (брат мужа)', 'золовка (сестра мужа)');
    } else if (rel.a === 0 && rel.b === 1) {
      return pick(gB, 'пасынок', 'падчерица');
    }
    return `${term} ${sp === 'wife' ? 'жены' : sp === 'husband' ? 'мужа' : 'супруга(и)'}`;
  },
  coParentInLaw: g => pick(g, 'сват', 'сватья'),
  svoyak: 'свояк (муж сестры жены)',
  distant: () => 'дальний родственник (через брак)',
  none: 'родство не найдено — эти люди пока не связаны в дереве',
  step: { parent: g => pick(g, 'отец', 'мать'), child: g => pick(g, 'сын', 'дочь'), spouse: g => pick(g, 'муж', 'жена') },
};

// ============================================================
// English: first cousin once removed, great-great-grandfather…
// ============================================================
const EN_ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const enOrd = n => EN_ORD[n] || `${n}th`;
const enNth = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const enGreat = n => (n <= 0 ? '' : n <= 2 ? 'great-'.repeat(n) : `${enNth(n)} great-`);
const enRemoved = d => (d === 1 ? 'once removed' : d === 2 ? 'twice removed' : `${d} times removed`);
const enCousin = (k, d = 0) => `${enOrd(k - 1)} cousin${d ? ' ' + enRemoved(d) : ''}`;

function enBlood(a, b, g, half) {
  if (a === 0 && b === 0) return 'the same person';
  if (b === 0) {
    if (a === 1) return pick(g, 'father', 'mother');
    return pick(g, enGreat(a - 2) + 'grandfather', enGreat(a - 2) + 'grandmother');
  }
  if (a === 0) {
    if (b === 1) return pick(g, 'son', 'daughter');
    return pick(g, enGreat(b - 2) + 'grandson', enGreat(b - 2) + 'granddaughter');
  }
  const k = Math.min(a, b);
  if (a === b) {
    if (k > 1) return enCousin(k);
    if (half === 'father') return pick(g, 'paternal half-brother', 'paternal half-sister');
    if (half === 'mother') return pick(g, 'maternal half-brother', 'maternal half-sister');
    if (half) return pick(g, 'half-brother', 'half-sister');
    return pick(g, 'brother', 'sister');
  }
  const d = Math.abs(a - b);
  if (k > 1) return enCousin(k, d);
  if (a > b) return pick(g, enGreat(d - 1) + 'uncle', enGreat(d - 1) + 'aunt');
  return pick(g, enGreat(d - 1) + 'nephew', enGreat(d - 1) + 'niece');
}

const enWhose = sp => (sp === 'wife' ? "wife's" : sp === 'husband' ? "husband's" : "spouse's");

const EN = {
  same: 'the same person',
  blood: enBlood,
  adoptedChild: g => pick(g, 'adopted son', 'adopted daughter'),
  adoptiveParent: g => pick(g, 'adoptive father', 'adoptive mother'),
  spouse(g, status) {
    if (status === 'divorced') return pick(g, 'ex-husband', 'ex-wife');
    if (status === 'partner') return 'partner';
    return pick(g, 'husband', 'wife');
  },
  spouseOfBlood(rel, gB, gS, term) {
    if (rel.a === 0 && rel.b === 1) return pick(gB, 'son-in-law', 'daughter-in-law');
    if (rel.a === 1 && rel.b === 1) return pick(gB, "brother-in-law (sister's husband)", "sister-in-law (brother's wife)");
    if (rel.a === 1 && rel.b === 0) return pick(gB, 'stepfather', 'stepmother');
    if (term.includes(' / ')) return `${pick(gB, 'husband', 'wife')}: ${term}`;
    return `${term}'s ${pick(gB, 'husband', 'wife')}`;
  },
  bloodOfSpouse(rel, gB, sp, term) {
    if (rel.a === 1 && rel.b === 0) return pick(gB, 'father-in-law', 'mother-in-law');
    if (rel.a === 1 && rel.b === 1) return pick(gB, `brother-in-law (${enWhose(sp)} brother)`, `sister-in-law (${enWhose(sp)} sister)`);
    if (rel.a === 0 && rel.b === 1) return pick(gB, 'stepson', 'stepdaughter');
    return `${enWhose(sp)} ${term}`;
  },
  coParentInLaw: g => pick(g, "child's father-in-law", "child's mother-in-law"),
  svoyak: "brother-in-law (wife's sister's husband)",
  distant: () => 'distant relative (by marriage)',
  none: 'no relationship found — these people are not connected in the tree yet',
  step: { parent: g => pick(g, 'father', 'mother'), child: g => pick(g, 'son', 'daughter'), spouse: g => pick(g, 'husband', 'wife') },
};

// ============================================================
// Deutsch: Urgroßvater, Cousine 2. Grades, Großonkel…
// ============================================================
// 'Großvater' → 'Urgroßvater', 'Ururgroßvater'
const ur = (n, word) => (n <= 0 ? word : 'Ur' + 'ur'.repeat(n - 1) + word[0].toLowerCase() + word.slice(1));
const grad = k => (k > 1 ? ` ${k}. Grades` : '');

function deBlood(a, b, g, half) {
  if (a === 0 && b === 0) return 'dieselbe Person';
  if (b === 0) {
    if (a === 1) return pick(g, 'Vater', 'Mutter');
    return pick(g, ur(a - 2, 'Großvater'), ur(a - 2, 'Großmutter'));
  }
  if (a === 0) {
    if (b === 1) return pick(g, 'Sohn', 'Tochter');
    return pick(g, ur(b - 2, 'Enkel'), ur(b - 2, 'Enkelin'));
  }
  const k = Math.min(a, b);
  if (a === b) {
    if (k === 2) return pick(g, 'Cousin', 'Cousine');
    if (k > 2) return pick(g, `Cousin ${k - 1}. Grades`, `Cousine ${k - 1}. Grades`);
    if (half === 'father') return pick(g, 'Halbbruder väterlicherseits', 'Halbschwester väterlicherseits');
    if (half === 'mother') return pick(g, 'Halbbruder mütterlicherseits', 'Halbschwester mütterlicherseits');
    if (half) return pick(g, 'Halbbruder', 'Halbschwester');
    return pick(g, 'Bruder', 'Schwester');
  }
  // «Onkel 2. Grades» — двоюродный дядя, «Großonkel» — двоюродный дедушка
  const d = Math.abs(a - b);
  const withGrad = s => s.split(' / ').map(x => x + grad(k)).join(' / ');
  if (a > b) {
    if (d === 1) return withGrad(pick(g, 'Onkel', 'Tante'));
    return withGrad(pick(g, ur(d - 2, 'Großonkel'), ur(d - 2, 'Großtante')));
  }
  if (d === 1) return withGrad(pick(g, 'Neffe', 'Nichte'));
  return withGrad(pick(g, ur(d - 2, 'Großneffe'), ur(d - 2, 'Großnichte')));
}

// Родительный падеж: «der Cousine», «des Cousins», «des Neffen».
function deGenitive(term, g) {
  if (g === 'f') return `der ${term}`;
  const [first, ...rest] = term.split(' ');
  const gen = /e$/.test(first) ? first + 'n' : /s$/.test(first) ? first : first + 's';
  return `des ${[gen, ...rest].join(' ')}`;
}
const deWhose = sp => (sp === 'wife' ? 'der Ehefrau' : sp === 'husband' ? 'des Ehemanns' : 'des Ehepartners');

const DE = {
  same: 'dieselbe Person',
  blood: deBlood,
  adoptedChild: g => pick(g, 'Adoptivsohn', 'Adoptivtochter'),
  adoptiveParent: g => pick(g, 'Adoptivvater', 'Adoptivmutter'),
  spouse(g, status) {
    if (status === 'divorced') return pick(g, 'Ex-Mann', 'Ex-Frau');
    if (status === 'partner') return pick(g, 'Partner', 'Partnerin');
    return pick(g, 'Ehemann', 'Ehefrau');
  },
  spouseOfBlood(rel, gB, gS, term) {
    if (rel.a === 0 && rel.b === 1) return pick(gB, 'Schwiegersohn', 'Schwiegertochter');
    if (rel.a === 1 && rel.b === 1) return pick(gB, 'Schwager (Mann der Schwester)', 'Schwägerin (Frau des Bruders)');
    if (rel.a === 1 && rel.b === 0) return pick(gB, 'Stiefvater', 'Stiefmutter');
    if (gS !== 'm' && gS !== 'f') return `${pick(gB, 'Ehemann', 'Ehefrau')}: ${term}`;
    return `${pick(gB, 'Ehemann', 'Ehefrau')} ${deGenitive(term, gS)}`;
  },
  bloodOfSpouse(rel, gB, sp, term) {
    if (rel.a === 1 && rel.b === 0) return pick(gB, 'Schwiegervater', 'Schwiegermutter');
    if (rel.a === 1 && rel.b === 1) return pick(gB, `Schwager (Bruder ${deWhose(sp)})`, `Schwägerin (Schwester ${deWhose(sp)})`);
    if (rel.a === 0 && rel.b === 1) return pick(gB, 'Stiefsohn', 'Stieftochter');
    return `${term} ${deWhose(sp)}`;
  },
  coParentInLaw: g => pick(g, 'Gegenschwiegervater', 'Gegenschwiegermutter'),
  svoyak: 'Schwager (Mann der Schwester der Ehefrau)',
  distant: g => pick(g, 'entfernter Verwandter (angeheiratet)', 'entfernte Verwandte (angeheiratet)'),
  none: 'keine Verwandtschaft gefunden – diese Personen sind im Stammbaum noch nicht verbunden',
  step: { parent: g => pick(g, 'Vater', 'Mutter'), child: g => pick(g, 'Sohn', 'Tochter'), spouse: g => pick(g, 'Ehemann', 'Ehefrau') },
};

const TERMS = { ru: RU, en: EN, de: DE };
const L = lang => TERMS[lang || getLang()] || RU;

// Кровное родство: кем B приходится A.
export function bloodTerm(a, b, g, half = '', lang = null) {
  return L(lang).blood(a, b, g, half);
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

function bloodText(T, model, aId, bId, rel) {
  const g = model.get(bId)?.gender || '';
  const half = rel.a === 1 && rel.b === 1 ? halfInfo(model, aId, bId) : '';
  let t = T.blood(rel.a, rel.b, g, half);
  if (rel.a === 0 && rel.b === 1) {
    const link = model.parentLinks(bId).find(l => l.id === aId);
    if (link && link.kind === 'adopted') t = T.adoptedChild(g);
  }
  if (rel.a === 1 && rel.b === 0) {
    const link = model.parentLinks(aId).find(l => l.id === bId);
    if (link && link.kind === 'adopted') t = T.adoptiveParent(g);
  }
  return t;
}

// Основная функция: кем B приходится A.
export function relationship(model, aId, bId, lang = null) {
  const T = L(lang);
  const A = model.get(aId), B = model.get(bId);
  if (!A || !B) return null;
  if (aId === bId) return { text: T.same, path: [aId], kind: 'self' };

  const blood = bloodRelation(model, aId, bId);
  if (blood) return { text: bloodText(T, model, aId, bId, blood), path: blood.path, kind: 'blood' };

  const gB = B.gender || '';

  // 1. Супруги
  const direct = model.partners(aId).find(p => p.id === bId);
  if (direct) return { text: T.spouse(gB, direct.union.status), path: [aId, bId], kind: 'marriage' };

  // 2. B — супруг(а) кровного родственника A
  for (const { id: sId } of model.partners(bId)) {
    const rel = bloodRelation(model, aId, sId);
    if (!rel || (rel.a === 0 && rel.b === 0)) continue;
    const gS = model.get(sId)?.gender || '';
    const t = T.spouseOfBlood(rel, gB, gS, bloodText(T, model, aId, sId, rel));
    return { text: t, path: [...rel.path, bId], kind: 'marriage' };
  }

  // 3. B — кровный родственник супруга(и) A
  for (const { id: sId } of model.partners(aId)) {
    const rel = bloodRelation(model, sId, bId);
    if (!rel || (rel.a === 0 && rel.b === 0)) continue;
    const gS = model.get(sId)?.gender || '';
    const gA = A.gender || '';
    const sp = gS === 'f' || (gS === '' && gA === 'm') ? 'wife' : gS === 'm' || (gS === '' && gA === 'f') ? 'husband' : '';
    const t = T.bloodOfSpouse(rel, gB, sp, bloodText(T, model, sId, bId, rel));
    return { text: t, path: [aId, ...rel.path], kind: 'marriage' };
  }

  // 4. Сваты: родители супруга(и) ребёнка
  for (const cId of model.children(aId)) {
    for (const { id: dId } of model.partners(cId)) {
      if (model.parents(dId).includes(bId)) {
        return { text: T.coParentInLaw(gB), path: [aId, cId, dId, bId], kind: 'marriage' };
      }
    }
  }

  // 5. Свояк: мужья сестёр
  for (const { id: sId } of model.partners(aId)) {
    for (const { id: tId } of model.partners(bId)) {
      const rel = bloodRelation(model, sId, tId);
      if (rel && rel.a === 1 && rel.b === 1 && A.gender === 'm' && gB === 'm') {
        return { text: T.svoyak, path: [aId, sId, ...rel.path.slice(1), bId], kind: 'marriage' };
      }
    }
  }

  // 6. Дальнее родство: кратчайший путь по любым связям
  const path = shortestPath(model, aId, bId);
  if (path) return { text: T.distant(gB), path, kind: 'distant' };
  return { text: T.none, path: [], kind: 'none' };
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
  const T = L();
  const steps = [];
  for (let i = 0; i < path.length; i++) {
    const id = path[i];
    const p = model.get(id);
    if (i > 0) {
      const prevId = path[i - 1];
      const g = p?.gender || '';
      let label;
      if (model.parents(prevId).includes(id)) label = T.step.parent(g);
      else if (model.parents(id).includes(prevId)) label = T.step.child(g);
      else label = T.step.spouse(g);
      steps.push({ label });
    }
    steps.push({ id, name: displayName(p) });
  }
  return steps;
}
