// Импорт/экспорт GEDCOM 5.5.1 — стандартный формат генеалогических программ
// (MyHeritage, Geni, FamilySearch, Gramps, «Древо Жизни»).

import { parseDate, isPatronymic, uid } from './util.js';

const GED_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// ---------- экспорт ----------
export function exportGedcom(model, { photoUrl } = {}) {
  const out = [];
  const line = (lvl, tag, value = '') => {
    const v = String(value ?? '');
    if (!v.includes('\n') && v.length <= 200) { out.push(`${lvl} ${tag}${v ? ' ' + v : ''}`); return; }
    const parts = v.split(/\r?\n/);
    parts.forEach((part, i) => {
      const chunks = part.match(/.{1,200}/gsu) || [''];
      chunks.forEach((chunk, j) => {
        if (i === 0 && j === 0) out.push(`${lvl} ${tag}${chunk ? ' ' + chunk : ''}`);
        else if (j === 0) out.push(`${lvl + 1} CONT ${chunk}`.trimEnd());
        else out.push(`${lvl + 1} CONC ${chunk}`);
      });
    });
  };

  const now = new Date();
  out.push('0 HEAD');
  out.push('1 SOUR FAMILY_TREE_SITE');
  out.push('2 NAME Семейное дерево');
  out.push(`1 DATE ${now.getDate()} ${GED_MONTHS[now.getMonth()]} ${now.getFullYear()}`);
  out.push('1 GEDC');
  out.push('2 VERS 5.5.1');
  out.push('2 FORM LINEAGE-LINKED');
  out.push('1 CHAR UTF-8');

  const indiId = new Map();
  let n = 1;
  for (const id of model.people.keys()) indiId.set(id, `@I${n++}@`);

  // Семьи: явные и неявные союзы + одиночные родители
  const fams = [];
  const famOfPair = new Map();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const u of model.unions) {
    const f = { id: `@F${fams.length + 1}@`, a: u.partner1_id, b: u.partner2_id, union: u, kids: [] };
    fams.push(f);
    famOfPair.set(key(u.partner1_id, u.partner2_id), f);
  }
  const singleFam = new Map();
  for (const id of model.people.keys()) {
    const ps = model.parents(id);
    if (ps.length === 2) {
      famOfPair.get(key(ps[0], ps[1]))?.kids.push(id);
    } else if (ps.length === 1) {
      let f = singleFam.get(ps[0]);
      if (!f) {
        f = { id: `@F${fams.length + 1}@`, a: ps[0], b: null, union: null, kids: [] };
        fams.push(f);
        singleFam.set(ps[0], f);
      }
      f.kids.push(id);
    }
  }

  const famsOf = new Map();
  const famcOf = new Map();
  for (const f of fams) {
    for (const p of [f.a, f.b]) if (p) (famsOf.get(p) || famsOf.set(p, []).get(p)).push(f.id);
    for (const k of f.kids) (famcOf.get(k) || famcOf.set(k, []).get(k)).push(f);
  }

  for (const [id, p] of model.people) {
    out.push(`0 ${indiId.get(id)} INDI`);
    const given = [p.first_name, p.patronymic].filter(Boolean).join(' ');
    const birthSurname = p.maiden_name || p.last_name || '';
    line(1, 'NAME', `${given} /${birthSurname}/`.trim());
    if (given) line(2, 'GIVN', given);
    if (birthSurname) line(2, 'SURN', birthSurname);
    if (p.maiden_name && p.last_name && p.maiden_name !== p.last_name) {
      line(1, 'NAME', `${given} /${p.last_name}/`.trim());
      out.push('2 TYPE married');
      line(2, 'SURN', p.last_name);
    }
    if (p.gender) out.push(`1 SEX ${p.gender === 'm' ? 'M' : 'F'}`);
    if (p.birth_date || p.birth_place) {
      out.push('1 BIRT');
      if (p.birth_date) line(2, 'DATE', gedDate(p.birth_date, p.birth_approx));
      if (p.birth_place) line(2, 'PLAC', p.birth_place);
    }
    if (p.is_deceased || p.death_date || p.death_place) {
      out.push(p.death_date || p.death_place ? '1 DEAT' : '1 DEAT Y');
      if (p.death_date) line(2, 'DATE', gedDate(p.death_date, p.death_approx));
      if (p.death_place) line(2, 'PLAC', p.death_place);
    }
    if (p.occupation) line(1, 'OCCU', p.occupation);
    if (p.bio) line(1, 'NOTE', p.bio);
    if (photoUrl) {
      for (const ph of model.photos(id)) {
        out.push('1 OBJE');
        line(2, 'FILE', photoUrl(ph.path));
        out.push('3 FORM jpg');
        if (ph.caption) line(3, 'TITL', ph.caption);
      }
    }
    for (const fid of famsOf.get(id) || []) out.push(`1 FAMS ${fid}`);
    for (const f of famcOf.get(id) || []) {
      out.push(`1 FAMC ${f.id}`);
      const link = model.parentLinks(id).find(l => l.kind === 'adopted' && (l.id === f.a || l.id === f.b));
      if (link) out.push('2 PEDI adopted');
    }
  }

  for (const f of fams) {
    out.push(`0 ${f.id} FAM`);
    let husb = f.a, wife = f.b;
    const ga = model.get(f.a)?.gender, gb = f.b ? model.get(f.b)?.gender : null;
    if (ga === 'f' || gb === 'm') { husb = f.b; wife = f.a; }
    if (husb) out.push(`1 HUSB ${indiId.get(husb)}`);
    if (wife) out.push(`1 WIFE ${indiId.get(wife)}`);
    for (const k of f.kids) out.push(`1 CHIL ${indiId.get(k)}`);
    if (f.union && !f.union.implicit) {
      if (f.union.status !== 'partner') {
        out.push('1 MARR');
        if (f.union.start_date) line(2, 'DATE', gedDate(f.union.start_date));
      }
      if (f.union.status === 'divorced') {
        out.push(f.union.end_date ? '1 DIV' : '1 DIV Y');
        if (f.union.end_date) line(2, 'DATE', gedDate(f.union.end_date));
      }
    }
  }
  out.push('0 TRLR');
  return out.join('\r\n') + '\r\n';
}

function gedDate(s, approx = false) {
  const p = parseDate(s);
  if (!p) return '';
  let v = String(p.y);
  if (p.m) v = `${GED_MONTHS[p.m - 1]} ${v}`;
  if (p.m && p.d) v = `${p.d} ${v}`;
  return approx ? `ABT ${v}` : v;
}

// ---------- импорт ----------
export function decodeGedcomBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));

  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4000));
  const charMatch = head.match(/\n\s*1\s+CHAR\s+([^\r\n]+)/i);
  const declared = charMatch ? charMatch[1].trim().toUpperCase() : '';
  if (/1251|ANSI|WINDOWS|CYRILLIC/.test(declared)) return new TextDecoder('windows-1251').decode(bytes);

  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1251').decode(bytes);
}

export function parseGedcom(text) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const root = { children: [] };
  const stack = [root];
  for (const raw of lines) {
    const m = raw.match(/^\s*(\d+)\s+(@[^@]+@\s+)?(\S+)(?:\s(.*))?$/);
    if (!m) continue;
    const level = +m[1];
    const node = { level, xref: m[2] ? m[2].trim() : null, tag: m[3].toUpperCase(), value: m[4] ?? '', children: [] };
    if (node.tag === 'CONT' || node.tag === 'CONC') {
      const parent = stack[level];
      if (parent) parent.value += (node.tag === 'CONT' ? '\n' : '') + node.value;
      continue;
    }
    while (stack.length > level + 1) stack.pop();
    const parent = stack[level] || stack[stack.length - 1];
    parent.children.push(node);
    stack[level + 1] = node;
    stack.length = level + 2;
  }

  const child = (node, tag) => node.children.find(c => c.tag === tag);
  const childVal = (node, tag) => child(node, tag)?.value?.trim() || '';

  const people = [];
  const parentChild = [];
  const unions = [];
  const warnings = [];
  const idMap = new Map();

  for (const rec of root.children.filter(n => n.tag === 'INDI')) {
    const names = rec.children.filter(c => c.tag === 'NAME');
    const typed = re => names.find(n => re.test(childVal(n, 'TYPE')));
    const explicitBirth = typed(/birth|maiden/i);
    const birthName = explicitBirth || names.find(n => !/married/i.test(childVal(n, 'TYPE'))) || names[0];
    let marriedName = typed(/married/i);
    // «Прасковья /Громова/» без типа + «/Лапина/» с TYPE birth → Громова — по мужу
    if (!marriedName && explicitBirth) marriedName = names.find(n => n !== birthName && !childVal(n, 'TYPE'));
    const parsed = birthName ? parseGedName(birthName, childVal) : { given: '', surname: '' };
    const { first, patronymic } = splitGiven(parsed.given);

    let lastName = parsed.surname;
    let maiden = '';
    const marnm = childVal(rec, '_MARNM') || (birthName ? childVal(birthName, '_MARNM') : '');
    if (marriedName) {
      const mp = parseGedName(marriedName, childVal);
      if (mp.surname && mp.surname !== parsed.surname) { maiden = parsed.surname; lastName = mp.surname; }
    } else if (marnm && marnm !== parsed.surname) {
      maiden = parsed.surname; lastName = marnm;
    }

    const birt = child(rec, 'BIRT');
    const deat = child(rec, 'DEAT');
    const bd = birt ? parseGedDate(childVal(birt, 'DATE')) : { date: '', approx: false };
    const dd = deat ? parseGedDate(childVal(deat, 'DATE')) : { date: '', approx: false };
    const sex = childVal(rec, 'SEX').toUpperCase();

    const notes = rec.children.filter(c => c.tag === 'NOTE' && !/^@.+@$/.test(c.value.trim())).map(c => c.value.trim()).filter(Boolean);
    const noteRefs = rec.children.filter(c => c.tag === 'NOTE' && /^@.+@$/.test(c.value.trim())).map(c => c.value.trim());
    for (const ref of noteRefs) {
      const nrec = root.children.find(n => n.tag === 'NOTE' && n.xref === ref);
      if (nrec?.value) notes.push(nrec.value.trim());
    }

    const id = uid();
    idMap.set(rec.xref, id);
    people.push({
      id,
      first_name: first,
      patronymic,
      last_name: lastName,
      maiden_name: maiden,
      gender: sex === 'M' ? 'm' : sex === 'F' ? 'f' : '',
      birth_date: bd.date,
      birth_approx: bd.approx,
      birth_place: birt ? childVal(birt, 'PLAC') : '',
      is_deceased: !!deat,
      death_date: dd.date,
      death_approx: dd.approx,
      death_place: deat ? childVal(deat, 'PLAC') : '',
      occupation: childVal(rec, 'OCCU'),
      bio: notes.join('\n\n'),
    });
  }

  const pcSeen = new Set();
  for (const fam of root.children.filter(n => n.tag === 'FAM')) {
    const h = idMap.get(childVal(fam, 'HUSB'));
    const w = idMap.get(childVal(fam, 'WIFE'));
    if (h && w) {
      const marr = child(fam, 'MARR');
      const div = child(fam, 'DIV');
      unions.push({
        id: uid(),
        partner1_id: h,
        partner2_id: w,
        status: div ? 'divorced' : marr ? 'married' : 'married',
        start_date: marr ? parseGedDate(childVal(marr, 'DATE')).date : '',
        end_date: div ? parseGedDate(childVal(div, 'DATE')).date : '',
      });
    }
    for (const c of fam.children.filter(x => x.tag === 'CHIL')) {
      const cid = idMap.get(c.value.trim());
      if (!cid) { warnings.push(`Не найден ребёнок ${c.value}`); continue; }
      const kindFor = parentXref => {
        const indi = root.children.find(n => n.tag === 'INDI' && idMap.get(n.xref) === cid);
        const famc = indi?.children.find(x => x.tag === 'FAMC' && x.value.trim() === fam.xref);
        const pedi = famc ? childVal(famc, 'PEDI').toLowerCase() : '';
        return pedi === 'adopted' ? 'adopted' : 'birth';
      };
      for (const pid of [h, w]) {
        if (!pid) continue;
        const k = pid + '|' + cid;
        if (pcSeen.has(k)) continue;
        pcSeen.add(k);
        parentChild.push({ parent_id: pid, child_id: cid, kind: kindFor() });
      }
    }
  }

  return { people, parent_child: parentChild, unions, warnings };
}

function parseGedName(node, childVal) {
  const v = node.value || '';
  const m = v.match(/^([^/]*)\/([^/]*)\/?(.*)$/);
  let given = childVal(node, 'GIVN');
  let surname = childVal(node, 'SURN');
  if (m) {
    if (!given) given = (m[1] + ' ' + m[3]).trim();
    if (!surname) surname = m[2].trim();
  } else if (!given) {
    given = v.trim();
  }
  return { given: given.replace(/\s+/g, ' '), surname };
}

function splitGiven(given) {
  const words = given.split(' ').filter(Boolean);
  if (words.length >= 2 && isPatronymic(words[words.length - 1])) {
    return { first: words.slice(0, -1).join(' '), patronymic: words[words.length - 1] };
  }
  return { first: words.join(' '), patronymic: '' };
}

export function parseGedDate(v) {
  let s = String(v || '').toUpperCase().trim();
  if (!s) return { date: '', approx: false };
  let approx = false;
  if (/^(ABT|ABOUT|EST|CAL|BEF|AFT|BET|FROM|TO|INT)\b/.test(s)) approx = true;
  s = s.replace(/^(ABT|ABOUT|EST|CAL|BEF|AFT|INT)\s+/, '').replace(/^(BET|FROM)\s+/, '').replace(/\s+(AND|TO)\s+.*$/, '');
  s = s.replace(/^TO\s+/, '');
  const m = s.match(/(?:(\d{1,2})\s+)?(?:([A-Z]{3})\s+)?(\d{3,4})/);
  if (!m) return { date: '', approx: false };
  const d = m[1] ? +m[1] : 0;
  const mon = m[2] ? GED_MONTHS.indexOf(m[2]) + 1 : 0;
  const y = +m[3];
  let date = String(y).padStart(4, '0');
  if (mon > 0) {
    date += '-' + String(mon).padStart(2, '0');
    if (d > 0) date += '-' + String(d).padStart(2, '0');
  }
  return { date, approx };
}
