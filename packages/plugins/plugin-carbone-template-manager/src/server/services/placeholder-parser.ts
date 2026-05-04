import unzipper from 'unzipper';
import type { PlaceholderNode, PlaceholderNodeType, PlaceholderSchema } from '../../shared/types';

/**
 * Lightweight extractor for Carbone-style placeholders (`{d.foo}`, `{c.bar}`).
 *
 * Word/Excel/PowerPoint store text as fragmented runs of XML nodes — a single
 * `{d.foo}` may be split across multiple `<w:t>` (DOCX) or `<a:t>` (PPTX)
 * elements when the user typed it with formatting changes mid-token. This
 * parser unzips the file, concatenates the text content of every relevant
 * XML part, and runs a regex over the joined string. Best-effort but matches
 * Carbone's own behaviour for the documented happy path.
 *
 * Returned schema is a tree built from dotted paths, with array nodes
 * promoted from `[i]` / `[i+1]` loop suffixes.
 */
export class PlaceholderParser {
  async parse(buffer: Buffer, mimeType?: string): Promise<PlaceholderSchema> {
    const directory = await unzipper.Open.buffer(buffer);
    const fragments: string[] = [];
    const warnings: string[] = [];

    for (const entry of directory.files) {
      if (entry.type !== 'File') continue;
      if (!shouldRead(entry.path)) continue;
      const xml = (await entry.buffer()).toString('utf8');
      fragments.push(extractText(xml));
    }

    const joined = fragments.join('\n');
    const tokens = matchTokens(joined);

    // Detect fragmented placeholders that survived only because we joined
    // the text. We can't recover the original split, so just warn.
    if (countOpenBraces(joined) !== tokens.length) {
      warnings.push(
        'Some placeholders may be split across rich-text runs. Re-typing the placeholder in plain text usually fixes it.',
      );
    }

    return buildSchema(tokens, warnings);
  }
}

// ── readers ──────────────────────────────────────────────────────────────────

function shouldRead(path: string): boolean {
  return (
    // DOCX
    path === 'word/document.xml' ||
    path.startsWith('word/header') ||
    path.startsWith('word/footer') ||
    // XLSX
    path === 'xl/sharedStrings.xml' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(path) ||
    // PPTX
    /^ppt\/slides\/slide\d+\.xml$/.test(path) ||
    /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(path) ||
    // ODT/ODS/ODP all keep content in content.xml
    path === 'content.xml' ||
    path === 'styles.xml'
  );
}

/**
 * Pull the visible text out of an Office Open XML fragment. We strip every
 * tag and keep only the text content; this is enough for placeholder
 * detection because Carbone tokens live in plain text only.
 */
function extractText(xml: string): string {
  // Replace common whitespace tags with spaces so adjacent runs don't merge
  // into a single word.
  const normalized = xml
    .replace(/<w:tab\/?>/gi, ' ')
    .replace(/<w:br\/?>/gi, ' ')
    .replace(/<a:br\/?>/gi, ' ')
    .replace(/<text:tab\/?>/gi, ' ')
    .replace(/<text:line-break\/?>/gi, ' ');
  return normalized.replace(/<[^>]+>/g, '');
}

// ── tokenisation ────────────────────────────────────────────────────────────

interface Token {
  scope: 'd' | 'c';
  raw: string; // e.g. "user.name:upperCase"
}

const TOKEN_RE = /\{(d|c)\.([^{}]+?)\}/g;

function matchTokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    out.push({ scope: m[1] as 'd' | 'c', raw: m[2] });
  }
  return out;
}

function countOpenBraces(text: string): number {
  return (text.match(/\{(d|c)\./g) ?? []).length;
}

// ── schema builder ──────────────────────────────────────────────────────────

const NUMBER_HINTS = /(total|qty|quantity|count|amount|price|sum|number|index|num|age|year)/i;
const DATE_HINTS = /(date|at$|created|updated|deleted|expir(es|ed|y))/i;
const BOOL_HINTS = /^(is|has|can|should|enabled|active)/i;

function inferType(name: string): PlaceholderNodeType {
  if (DATE_HINTS.test(name)) return 'date';
  if (NUMBER_HINTS.test(name)) return 'number';
  if (BOOL_HINTS.test(name)) return 'boolean';
  return 'string';
}

interface RawSegment {
  name: string;
  isArray: boolean;
}

/**
 * Splits a Carbone path body into segments + extracted formatters.
 * Examples:
 *   "user.name:upperCase"            → segs=[user, name],   formatters=[upperCase]
 *   "items[i].price:formatN(2)"      → segs=[items*, price], formatters=[formatN(2)]
 */
function tokeniseRaw(raw: string): { segments: RawSegment[]; formatters: string[] } {
  // Formatters are everything after the first ':' that is not inside parens.
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ':' && depth === 0) {
      cut = i;
      break;
    }
  }

  const pathPart = cut === -1 ? raw : raw.slice(0, cut);
  const formatterStr = cut === -1 ? '' : raw.slice(cut + 1);

  const formatters = formatterStr
    ? splitFormatters(formatterStr).map((s) => s.trim()).filter(Boolean)
    : [];

  const segments: RawSegment[] = [];
  for (const part of pathPart.split('.')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const arrMatch = /^([^\[]+)\[[^\]]*\]$/.exec(trimmed);
    if (arrMatch) {
      segments.push({ name: arrMatch[1], isArray: true });
    } else {
      segments.push({ name: trimmed, isArray: false });
    }
  }
  return { segments, formatters };
}

function splitFormatters(str: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of str) {
    if (ch === '(') {
      depth++;
      buf += ch;
    } else if (ch === ')') {
      depth--;
      buf += ch;
    } else if (ch === ':' && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

interface MutableNode {
  name: string;
  type: PlaceholderNodeType;
  path: string;
  formatters: Set<string>;
  isArray: boolean;
  children: Map<string, MutableNode>;
}

function getOrCreate(
  parent: Map<string, MutableNode>,
  seg: RawSegment,
  parentPath: string,
): MutableNode {
  let node = parent.get(seg.name);
  if (!node) {
    node = {
      name: seg.name,
      type: seg.isArray ? 'array' : 'object',
      path: parentPath ? `${parentPath}.${seg.name}` : seg.name,
      formatters: new Set(),
      isArray: seg.isArray,
      children: new Map(),
    };
    parent.set(seg.name, node);
  }
  // Promote to array if any reference uses [i].
  if (seg.isArray && !node.isArray) {
    node.isArray = true;
    node.type = 'array';
  }
  return node;
}

function freeze(node: MutableNode): PlaceholderNode {
  const isLeaf = node.children.size === 0;
  let type: PlaceholderNodeType = node.type;
  if (isLeaf && (type === 'object' || type === 'array')) {
    // Override only when it's truly a leaf (no children referenced).
    type = node.isArray ? 'array' : inferType(node.name);
  }
  const out: PlaceholderNode = {
    name: node.name,
    type,
    path: node.path,
  };
  if (node.formatters.size) out.formatters = Array.from(node.formatters);
  if (node.children.size) out.children = Array.from(node.children.values()).map(freeze);
  return out;
}

function buildSchema(tokens: Token[], warnings: string[]): PlaceholderSchema {
  const dRoot = new Map<string, MutableNode>();
  const cRoot = new Map<string, MutableNode>();

  for (const tok of tokens) {
    const root = tok.scope === 'd' ? dRoot : cRoot;
    const { segments, formatters } = tokeniseRaw(tok.raw);
    if (!segments.length) continue;

    let cursor = root;
    let parentPath = tok.scope;
    for (let i = 0; i < segments.length; i++) {
      const node = getOrCreate(cursor, segments[i], parentPath);
      const isLast = i === segments.length - 1;
      if (isLast) {
        for (const f of formatters) node.formatters.add(f);
      }
      cursor = node.children;
      parentPath = node.path;
    }
  }

  return {
    d: Array.from(dRoot.values()).map(freeze),
    c: cRoot.size ? Array.from(cRoot.values()).map(freeze) : undefined,
    warnings,
  };
}
