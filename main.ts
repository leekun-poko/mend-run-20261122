// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the four formats (unified diffs, SEARCH/REPLACE blocks, V4A patches
// and JSON edits), matching lines at three tiers, and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, in the order their edits ran (for the `R` lines of section 2). */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own line break, its lines, and whether it ends with that break (section 3). */
interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.finalBreak ? fl.br : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Whether O matches the file's lines at position i under a tier (section 5). */
function matchAt(lines: string[], i: number, O: string[], tier: number): boolean {
  for (let k = 0; k < O.length; k += 1) {
    const a = lines[i + k]!;
    const b = O[k]!;
    if (tier === 0 ? a !== b : tier === 1 ? trailTrim(a) !== trailTrim(b) : bothTrim(a) !== bothTrim(b)) return false;
  }
  return true;
}

/** The first tier at which O occurs at or after `from`, with every position there, or null (section 5). */
function occurrences(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i += 1) if (matchAt(lines, i, O, tier)) positions.push(i);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first occurrence of O at or after `from` at the first tier with one; an end-of-file chunk (section 8)
 *  only takes an occurrence that ends at the file's last line. */
function findChunk(lines: string[], O: string[], strict: boolean, from: number, eof: boolean): { tier: number; pos: number } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    for (let i = from; i + O.length <= lines.length; i += 1) {
      if (eof && i + O.length !== lines.length) continue;
      if (matchAt(lines, i, O, tier)) return { tier, pos: i };
    }
  }
  return null;
}

/** One line of a replacement: a context line (taken from the file itself) or a new line of the patch. */
type NItem = { ctx: number } | { add: string };

/** The lines that replace the matched ones at `pos`: context lines are the file's own, and at tier 2 every
 *  other line is re-indented from O's first line's indentation to the file's (section 5). */
function buildN(lines: string[], pos: number, O: string[], items: NItem[], tier: number): string[] {
  const F = leadWs(lines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  return items.map((it) => {
    if ('ctx' in it) return lines[pos + it.ctx]!;
    if (tier === 2 && it.add.trim() !== '' && it.add.startsWith(P)) return F + it.add.slice(P.length);
    return it.add;
  });
}

/** A hunk or chunk whose old lines are not in the file; the edit that owns it names the path. */
class HunkFail {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
}

/** One body line of a unified hunk or a V4A chunk, with a following `\` marker folded in. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'add';
  text: string;
  noNl: boolean;
}

function toBody(entries: { kind: 'ctx' | 'old' | 'add' | 'mark'; text: string }[]): BodyLine[] {
  const out: BodyLine[] = [];
  for (const e of entries) {
    if (e.kind === 'mark') {
      if (out.length > 0) out[out.length - 1]!.noNl = true;
    } else out.push({ kind: e.kind, text: e.text, noNl: false });
  }
  return out;
}

/** Split a body into O (context and old lines) and the replacement items (context and new lines). */
function splitON(body: BodyLine[]): { O: string[]; items: NItem[] } {
  const O: string[] = [];
  const items: NItem[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      items.push({ ctx: O.length });
      O.push(b.text);
    } else if (b.kind === 'old') O.push(b.text);
    else items.push({ add: b.text });
  }
  return { O, items };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Apply one section's hunks to a file's lines, in order (section 6). Throws HunkFail. */
function applyHunks(fl: FileLines, hunks: { a: number; body: BodyLine[] }[], strict: boolean): FileLines {
  const lines = [...fl.lines];
  let finalBreak = fl.finalBreak;
  let d = 0;
  for (const hunk of hunks) {
    const { O, items } = splitON(hunk.body);
    const lastN = [...hunk.body].reverse().find((b) => b.kind !== 'old');
    if (O.length === 0) {
      const add = items.map((it) => ('add' in it ? it.add : ''));
      let at = hunk.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...add);
      if (atEnd && add.length > 0 && lastN !== undefined) finalBreak = !lastN.noNl;
      d += add.length;
      continue;
    }
    const occ = occurrences(lines, O, strict);
    if (occ === null) throw new HunkFail('no-match');
    const target = hunk.a - 1 + d;
    let pos = occ.positions[0]!;
    for (const p of occ.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const repl = buildN(lines, pos, O, items, occ.tier);
    const toEnd = pos + O.length === lines.length;
    lines.splice(pos, O.length, ...repl);
    if (toEnd && repl.length > 0 && lastN !== undefined) finalBreak = !lastN.noNl;
    d += repl.length - O.length;
  }
  return { lines, br: fl.br, finalBreak };
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: { a: number; body: BodyLine[] }[];
}

/** The path a `---` or `+++` header line names: null for /dev/null (section 6). */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (sec.pairOld !== undefined) {
    oldP = sec.pairOld;
    newP = sec.pairNew!;
  } else if (sec.renameFrom !== undefined || sec.renameTo !== undefined) {
    oldP = sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
    newP = sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  } else {
    oldP = sec.gitOld;
    newP = sec.gitNew;
  }
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.deletedFile);
  return (tree) => {
    for (const p of [oldP, newP]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    if (isCreate) {
      const target = newP!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const addLines: string[] = [];
      let lastNoNl = false;
      for (const h of sec.hunks)
        for (const b of h.body)
          if (b.kind === 'add') {
            addLines.push(b.text);
            lastNoNl = b.noNl;
          }
      tree.now.set(target, addLines.length === 0 ? '' : addLines.join('\n') + (lastNoNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const from = oldP!;
    const to = newP!;
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    let out: FileLines;
    try {
      out = applyHunks(splitFile(before), sec.hunks, strict);
    } catch (e) {
      if (e instanceof HunkFail) throw new Fail(e.code, from);
      throw e;
    }
    if (to !== from) {
      tree.now.set(from, null);
      tree.now.set(to, joinFile(out));
      tree.moves.push({ old: from, new: to });
    } else tree.now.set(to, joinFile(out));
  };
}

/** Read a unified diff into edits (section 6). Throws Exit2 on a parse fault. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const fresh = (): Section => ({
    gitOld: null,
    gitNew: null,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || line === 'diff --git') {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
      } else {
        cur = fresh();
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const raw: { kind: 'ctx' | 'old' | 'add' | 'mark'; text: string }[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') raw.push({ kind: 'ctx', text: '' });
        else if (bl[0] === ' ') raw.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') raw.push({ kind: 'old', text: bl.slice(1) });
        else if (bl[0] === '+') raw.push({ kind: 'add', text: bl.slice(1) });
        else if (bl[0] === '\\') raw.push({ kind: 'mark', text: '' });
        else break;
        j += 1;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.kind === 'ctx' && raw[raw.length - 1]!.text === '') raw.pop();
      cur.hunks.push({ a: Number(m[1]), body: toBody(raw) });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** Read SEARCH/REPLACE blocks into edits (section 7). Throws Exit2 on a parse fault. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let from = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let k = at - 1; k >= from; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${at + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = at + 1; k < lines.length; k += 1)
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rp = -1;
    for (let k = eq + 1; k < lines.length; k += 1)
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = k;
        break;
      }
    if (rp < 0) throw new Exit2(`error: parse ${at + 1}`);
    const oldLines = lines.slice(at + 1, eq);
    const newLines = lines.slice(eq + 1, rp);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const fl = splitFile(before);
      const occ = occurrences(fl.lines, oldLines, strict);
      if (occ === null) throw new Fail('no-match', p);
      if (occ.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = occ.positions[0]!;
      const repl = buildN(fl.lines, pos, oldLines, newLines.map((t) => ({ add: t })), occ.tier);
      const out = [...fl.lines];
      out.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, joinFile({ lines: out, br: fl.br, finalBreak: fl.finalBreak }));
    });
    prevPath = path;
    from = rp + 1;
    i = rp + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  line: number;
  raw: { text: string; line: number }[];
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  const raw = [...sec.raw];
  while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
  const p = sec.path;
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${r.line}`);
    }
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'del') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line}`);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
    moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx += 1) {
    const r = raw[idx]!;
    const line = r.text;
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
    } else if (line === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.line}`);
      cur.eof = true;
      cur = null;
    } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) {
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push({
        kind: line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : 'add',
        text: line === '' ? '' : line.slice(1),
        noNl: false,
      });
    } else throw new Exit2(`error: parse ${r.line}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
  const to = moveTo;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (to !== null && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const fl = splitFile(before);
    const lines = [...fl.lines];
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const occ = occurrences(lines, [chunk.anchor], strict, cursor);
        if (occ === null) throw new Fail('no-match', p);
        cursor = occ.positions[0]! + 1;
      }
      const { O, items } = splitON(chunk.body);
      if (O.length === 0) {
        const add = items.map((it) => ('add' in it ? it.add : ''));
        const at = chunk.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      const found = findChunk(lines, O, strict, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', p);
      const repl = buildN(lines, found.pos, O, items, found.tier);
      lines.splice(found.pos, O.length, ...repl);
      cursor = found.pos + repl.length;
    }
    const text = joinFile({ lines, br: fl.br, finalBreak: fl.finalBreak });
    if (to !== null) {
      tree.now.set(p, null);
      tree.now.set(to, text);
      tree.moves.push({ old: p, new: to });
    } else tree.now.set(p, text);
  };
}

/** Read a V4A patch into edits (section 8). Throws Exit2 on a parse fault. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1)
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let k = first + 1; k < last; k += 1) {
    const line = lines[k]!;
    const head = /^\*\*\* (Add|Delete|Update) File: ?(.*)$/.exec(line);
    if (head !== null) {
      cur = { kind: head[1] === 'Add' ? 'add' : head[1] === 'Delete' ? 'del' : 'update', path: head[2]!.trim(), line: k + 1, raw: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${k + 1}`);
    }
    cur.raw.push({ text: line, line: k + 1 });
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const display: { key: string; text: string }[] = [];
  const inR = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.has(mv.old) ? tree.now.get(mv.old)! : wasOld;
    const wasNew = tree.original(mv.new);
    const nowNew = tree.now.has(mv.new) ? tree.now.get(mv.new)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      display.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      inR.add(mv.old);
      inR.add(mv.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (inR.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    display.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  display.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = display.map((r) => r.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
