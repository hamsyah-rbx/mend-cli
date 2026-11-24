// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  readonly moves: Array<[string, string]> = [];
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

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const stripSpaces = (s: string): string => s.replace(/^ +| +$/g, '');
const stripRightST = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothST = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadingST = (s: string): string => /^[ \t]*/.exec(s)![0];
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? stripRightST(s) : stripBothST(s));

type NewItem = { kind: 'ctx'; oIndex: number } | { kind: 'add'; text: string };

function findOccurrences(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  startIdx = 0,
  onlyAtPos: number | null = null,
): { tier: number; positions: number[] } | null {
  const limit = fileLines.length - oldLines.length;
  if (oldLines.length === 0 || limit < startIdx) return null;
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const normOld = oldLines.map((l) => normLine(l, tier));
    const positions: number[] = [];
    if (onlyAtPos !== null) {
      if (onlyAtPos >= startIdx && onlyAtPos <= limit) {
        let ok = true;
        for (let j = 0; j < normOld.length; j += 1) {
          if (normLine(fileLines[onlyAtPos + j]!, tier) !== normOld[j]) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(onlyAtPos);
      }
    } else {
      const normFile = fileLines.slice(startIdx).map((l) => normLine(l, tier));
      for (let i = startIdx; i <= limit; i += 1) {
        let ok = true;
        for (let j = 0; j < normOld.length; j += 1) {
          if (normFile[i - startIdx + j] !== normOld[j]) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(i);
      }
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function buildReplacement(fileLines: string[], pos: number, oldLines: string[], newItems: NewItem[], tier: number): string[] {
  const F = tier === 2 ? leadingST(fileLines[pos]!) : '';
  const P = tier === 2 ? leadingST(oldLines[0]!) : '';
  const out: string[] = [];
  for (const item of newItems) {
    if (item.kind === 'ctx') out.push(fileLines[pos + item.oIndex]!);
    else if (tier === 2 && !blank(item.text) && item.text.startsWith(P)) out.push(F + item.text.slice(P.length));
    else out.push(item.text);
  }
  return out;
}

type Edit = (tree: Tree) => void;

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

interface HunkLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  rawEmpty?: boolean;
}

interface UnifiedHunk {
  oldStart: number;
  body: HunkLine[];
}

interface UnifiedSection {
  gitOld?: string;
  gitNew?: string;
  headerOld?: string | null;
  headerNew?: string | null;
  hasMinusPlus: boolean;
  renameOld?: string;
  renameNew?: string;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hunks: UnifiedHunk[];
}

function parseUnifiedHeaderPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const raw = stripSpaces(tab >= 0 ? rest.slice(0, tab) : rest);
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function applyUnifiedHunks(before: string, hunks: UnifiedHunk[], failPath: string, strict: boolean): string {
  const file = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const oldLines: string[] = [];
    const newItems: NewItem[] = [];
    let lastNIdx = -1;
    for (let k = 0; k < h.body.length; k += 1) {
      const item = h.body[k]!;
      if (item.kind === 'ctx') {
        const oIndex = oldLines.length;
        oldLines.push(item.text);
        newItems.push({ kind: 'ctx', oIndex });
        lastNIdx = k;
      } else if (item.kind === 'del') {
        oldLines.push(item.text);
      } else if (item.kind === 'add') {
        newItems.push({ kind: 'add', text: item.text });
        lastNIdx = k;
      }
    }
    const noNewlineAfterLastN = lastNIdx >= 0 && h.body[lastNIdx + 1]?.kind === 'bs';
    if (oldLines.length > 0) {
      const found = findOccurrences(file.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.oldStart - 1 + d;
      let bestPos = found.positions[0]!;
      let bestDist = Math.abs(bestPos - target);
      for (let idx = 1; idx < found.positions.length; idx += 1) {
        const pos = found.positions[idx]!;
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = pos;
        }
      }
      const atEnd = bestPos + oldLines.length === file.lines.length;
      const repl = buildReplacement(file.lines, bestPos, oldLines, newItems, found.tier);
      file.lines.splice(bestPos, oldLines.length, ...repl);
      if (atEnd) file.final = !noNewlineAfterLastN;
      d += repl.length - oldLines.length;
    } else {
      const insertAt = Math.max(0, Math.min(file.lines.length, h.oldStart + d));
      const atEnd = insertAt === file.lines.length;
      const repl = newItems.map((it) => (it.kind === 'add' ? it.text : ''));
      file.lines.splice(insertAt, 0, ...repl);
      if (repl.length > 0 && atEnd) file.final = !noNewlineAfterLastN;
      d += repl.length;
    }
  }
  return joinFile(file.lines, file.br, file.final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        gitOld: m[1]!,
        gitNew: m[2]!,
        hasMinusPlus: false,
        isNewFile: false,
        isDeletedFile: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 1;
    } else if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (inHeader && cur !== null && !cur.hasMinusPlus) {
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.headerOld = parseUnifiedHeaderPath(line);
        cur.headerNew = parseUnifiedHeaderPath(next);
        cur.hasMinusPlus = true;
        i += 2;
      } else if (next.startsWith('+++ ')) {
        cur = {
          headerOld: parseUnifiedHeaderPath(line),
          headerNew: parseUnifiedHeaderPath(next),
          hasMinusPlus: true,
          isNewFile: false,
          isDeletedFile: false,
          hunks: [],
        };
        sections.push(cur);
        inHeader = true;
        i += 2;
      } else if (inHeader && cur !== null) {
        throw new Exit2(`error: parse ${i + 2}`);
      } else {
        i += 1;
      }
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const oldStart = Number(m[1]!);
      i += 1;
      const body: HunkLine[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (bl === '') body.push({ kind: 'ctx', text: '', rawEmpty: true });
        else if (bl[0] === ' ') body.push({ kind: 'ctx', text: bl.slice(1), rawEmpty: false });
        else if (bl[0] === '-') body.push({ kind: 'del', text: bl.slice(1) });
        else if (bl[0] === '+') body.push({ kind: 'add', text: bl.slice(1) });
        else if (bl[0] === '\\') body.push({ kind: 'bs', text: bl.slice(1) });
        else break;
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.rawEmpty) {
        body.pop();
      }
      cur.hunks.push({ oldStart, body });
    } else if (inHeader && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameOld = stripSpaces(line.slice(12));
      else if (line.startsWith('rename to ')) cur.renameNew = stripSpaces(line.slice(10));
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.isNewFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.isDeletedFile = true;
      i += 1;
    } else {
      i += 1;
    }
  }

  return sections.map((sec): Edit => {
    const oldPath = sec.hasMinusPlus ? sec.headerOld! : (sec.renameOld ?? sec.gitOld ?? null);
    const newPath = sec.hasMinusPlus ? sec.headerNew! : (sec.renameNew ?? sec.gitNew ?? null);
    if (oldPath === null || sec.isNewFile) {
      const dest = newPath ?? '/dev/null';
      return (tree) => {
        if (!safe(dest)) throw new Fail('unsafe', dest);
        if (tree.get(dest) !== null) throw new Fail('exists', dest);
        const outLines: string[] = [];
        let lastPlusNoEol = false;
        for (const h of sec.hunks) {
          for (let k = 0; k < h.body.length; k += 1) {
            const item = h.body[k]!;
            if (item.kind === 'add') {
              outLines.push(item.text);
              lastPlusNoEol = h.body[k + 1]?.kind === 'bs';
            }
          }
        }
        tree.now.set(dest, joinFile(outLines, '\n', !lastPlusNoEol));
      };
    }
    if (newPath === null || sec.isDeletedFile) {
      const src = oldPath ?? '/dev/null';
      return (tree) => {
        if (!safe(src)) throw new Fail('unsafe', src);
        if (tree.get(src) === null) throw new Fail('missing', src);
        tree.now.set(src, null);
      };
    }
    if (oldPath !== newPath) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyUnifiedHunks(before, sec.hunks, oldPath, strict);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push([oldPath, newPath]);
      };
    }
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      const out = applyUnifiedHunks(before, sec.hunks, oldPath, strict);
      tree.now.set(oldPath, out);
    };
  });
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k -= 1) {
      const cand = lines[k]!.trim();
      if (cand !== '' && !cand.startsWith('```')) {
        path = cand;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let sepIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        sepIdx = k;
        break;
      }
    }
    if (sepIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let endIdx = -1;
    for (let k = sepIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        endIdx = k;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    const blockPath = path;
    const oldLines = lines.slice(searchIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, endIdx);
    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (oldLines.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, joinFile(newLines, '\n', true));
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const file = splitFile(before);
      const found = findOccurrences(file.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', blockPath);
      if (found.positions.length > 1) throw new Fail('ambiguous', blockPath);
      const pos = found.positions[0]!;
      const newItems: NewItem[] = newLines.map((t) => ({ kind: 'add', text: t }));
      const repl = buildReplacement(file.lines, pos, oldLines, newItems, found.tier);
      file.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(blockPath, joinFile(file.lines, file.br, file.final));
    });

    prevPath = path;
    prevEnd = endIdx;
    i = endIdx + 1;
  }
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  oldLines: string[];
  newItems: NewItem[];
  eof: boolean;
}

const isV4aHeader = (line: string): boolean =>
  line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const headerIdx = i;
    const header = lines[headerIdx]!;
    if (!isV4aHeader(header)) throw new Exit2(`error: parse ${headerIdx + 1}`);
    if (header.startsWith('*** Delete File: ')) {
      const path = stripSpaces(header.slice(17));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = headerIdx + 1;
      continue;
    }
    let nextIdx = headerIdx + 1;
    while (nextIdx < last && !isV4aHeader(lines[nextIdx]!)) nextIdx += 1;
    let secEnd = nextIdx;
    while (secEnd > headerIdx + 1 && blank(lines[secEnd - 1]!)) secEnd -= 1;

    if (header.startsWith('*** Add File: ')) {
      const path = stripSpaces(header.slice(14));
      const addLines: string[] = [];
      for (let k = headerIdx + 1; k < secEnd; k += 1) {
        const l = lines[k]!;
        if (l === '') addLines.push('');
        else if (l[0] === '+') addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(addLines, '\n', true));
      });
    } else {
      const path = stripSpaces(header.slice(17));
      let k = headerIdx + 1;
      let moveTo: string | null = null;
      if (k < secEnd && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = stripSpaces(lines[k]!.slice(13));
        k += 1;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      while (k < secEnd) {
        const l = lines[k]!;
        if (l.startsWith('@@')) {
          const anc = stripSpaces(l.slice(2));
          curChunk = { anchor: anc === '' ? null : anc, oldLines: [], newItems: [], eof: false };
          chunks.push(curChunk);
        } else if (l.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${k + 1}`);
          curChunk.eof = true;
          curChunk = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${k + 1}`);
            curChunk = { anchor: null, oldLines: [], newItems: [], eof: false };
            chunks.push(curChunk);
          }
          if (l === '') {
            const oIndex = curChunk.oldLines.length;
            curChunk.oldLines.push('');
            curChunk.newItems.push({ kind: 'ctx', oIndex });
          } else if (l[0] === ' ') {
            const oIndex = curChunk.oldLines.length;
            curChunk.oldLines.push(l.slice(1));
            curChunk.newItems.push({ kind: 'ctx', oIndex });
          } else if (l[0] === '-') {
            curChunk.oldLines.push(l.slice(1));
          } else {
            curChunk.newItems.push({ kind: 'add', text: l.slice(1) });
          }
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
        k += 1;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const file = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const anc = findOccurrences(file.lines, [ch.anchor], strict, cursor);
            if (anc === null) throw new Fail('no-match', path);
            cursor = anc.positions[0]! + 1;
          }
          if (ch.oldLines.length > 0) {
            const onlyAt = ch.eof ? file.lines.length - ch.oldLines.length : null;
            const found = findOccurrences(file.lines, ch.oldLines, strict, cursor, onlyAt);
            if (found === null) throw new Fail('no-match', path);
            const pos = found.positions[0]!;
            const repl = buildReplacement(file.lines, pos, ch.oldLines, ch.newItems, found.tier);
            file.lines.splice(pos, ch.oldLines.length, ...repl);
            cursor = pos + repl.length;
          } else {
            const insertAt = ch.eof ? file.lines.length : cursor;
            const repl = ch.newItems.map((it) => (it.kind === 'add' ? it.text : ''));
            file.lines.splice(insertAt, 0, ...repl);
            cursor = insertAt + repl.length;
          }
        }
        const out = joinFile(file.lines, file.br, file.final);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
    }
    i = nextIdx;
  }
  return edits;
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const renamedFrom = new Set<string>();
  const renamedTo = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      !renamedFrom.has(oldP) &&
      !renamedTo.has(newP) &&
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      renamedFrom.add(oldP);
      renamedTo.set(newP, oldP);
    }
  }

  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows: string[] = [];
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renamedFrom.has(p)) continue;
    if (renamedTo.has(p)) rows.push(`R ${renamedTo.get(p)!} -> ${p}`);
    else rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) {
    for (const p of changed) {
      if (tree.original(p) !== null && tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was !== now && now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
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
