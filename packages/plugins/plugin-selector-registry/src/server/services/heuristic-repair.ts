import type { ClientCandidate, ElementSignature, SelectorType } from '../../constants';
import {
  attributeValue,
  describeElement,
  escapeCssValue,
  parseDom,
  selectCss,
  selectOneCss,
  validateSelector,
  type ElementDescriptor,
} from './dom-analyzer';
import { stripDynamicSuffix } from './key-service';
import { buildSignature, signatureSimilarity } from './signature-service';
import type { Element, Document } from 'domhandler';
import { getChildren, getName, getParent } from 'domutils';
import { isTag } from 'domhandler';

export interface RepairInput {
  failedSelector: string;
  selectorType: SelectorType;
  domSnippet?: string;
  candidates?: ClientCandidate[];
  signature?: ElementSignature | null;
  triedSelectors?: string[];
}

export interface RepairCandidate {
  selector: string;
  selectorType: SelectorType;
  source: 'client-candidate' | 'id-drift' | 'segment-reanchor' | 'text-anchor' | 'xpath-id-extract';
  matchCount: number;
  unique: boolean;
  signatureScore: number;
  reason: string;
}

const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];
const MAX_CANDIDATES = 8;

const scoreCandidate = (signatureScore: number, unique: boolean): number => signatureScore * 0.7 + (unique ? 0.3 : 0);

const elementSignatureScore = (
  dom: Document,
  selector: string,
  expected: ElementSignature | null | undefined,
): number => {
  if (!expected) return 0.5;
  const element = selectOneCss(dom, selector);
  if (!element) return 0.5;
  return signatureSimilarity(expected, buildSignature(describeElement(element)));
};

// Build the most stable unique CSS selector for a known element.
const buildSelectorForElement = (dom: Document, element: Element): string | null => {
  const descriptor = describeElement(element);

  for (const attr of TEST_ID_ATTRS) {
    const value = attributeValue(element, attr);
    if (value) {
      const selector = `[${attr}="${escapeCssValue(value)}"]`;
      if (validateSelector(dom, selector, 'css').unique) return selector;
    }
  }

  const id = attributeValue(element, 'id');
  if (id && !stripDynamicSuffix(id)) {
    const selector = `[id="${escapeCssValue(id)}"]`;
    if (validateSelector(dom, selector, 'css').unique) return selector;
  }

  for (const attr of ['name', 'aria-label', 'placeholder']) {
    const value = attributeValue(element, attr);
    if (value) {
      const selector = `${descriptor.tag}[${attr}="${escapeCssValue(value)}"]`;
      if (validateSelector(dom, selector, 'css').unique) return selector;
    }
  }

  return buildStructuralPath(dom, element);
};

// Last resort: path from the nearest ancestor that carries a stable id.
const buildStructuralPath = (dom: Document, element: Element): string | null => {
  const segments: string[] = [];
  let current: Element = element;
  for (let depth = 0; depth < 8; depth += 1) {
    const tag = getName(current).toLowerCase();
    const parent = getParent(current);
    if (!parent || !isTag(parent)) {
      segments.unshift(tag);
      break;
    }
    const siblings = getChildren(parent).filter((node) => isTag(node) && getName(node).toLowerCase() === tag);
    const position = siblings.indexOf(current) + 1;
    segments.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${position})` : tag);

    const parentId = attributeValue(parent as Element, 'id');
    if (parentId && !stripDynamicSuffix(parentId)) {
      segments.unshift(`[id="${escapeCssValue(parentId)}"]`);
      break;
    }
    if (getName(parent).toLowerCase() === 'body') {
      segments.unshift('body');
      break;
    }
    current = parent as Element;
  }
  const selector = segments.join(' > ');
  return validateSelector(dom, selector, 'css').unique ? selector : null;
};

const repairClientCandidates = (dom: Document, input: RepairInput, out: RepairCandidate[]) => {
  for (const candidate of input.candidates ?? []) {
    if (candidate.selector) {
      const validation = validateSelector(dom, candidate.selector, 'css');
      if (validation.validatable && validation.unique) {
        out.push({
          selector: candidate.selector,
          selectorType: 'css',
          source: 'client-candidate',
          matchCount: validation.matchCount,
          unique: true,
          signatureScore: elementSignatureScore(dom, candidate.selector, input.signature ?? null),
          reason: 'client-provided selector validated unique in snapshot',
        });
      }
      continue;
    }
    if (candidate.attrs) {
      const conditions = Object.entries(candidate.attrs)
        .filter(([, value]) => typeof value === 'string' && value !== '')
        .map(([name, value]) => `[${name}="${escapeCssValue(String(value))}"]`)
        .join('');
      if (!conditions) continue;
      const selector = `${candidate.tag ?? '*'}${conditions}`;
      const validation = validateSelector(dom, selector, 'css');
      if (validation.validatable && validation.unique) {
        out.push({
          selector,
          selectorType: 'css',
          source: 'client-candidate',
          matchCount: validation.matchCount,
          unique: true,
          signatureScore: elementSignatureScore(dom, selector, input.signature ?? null),
          reason: 'client-provided attributes matched a unique element in snapshot',
        });
      }
    }
  }
};

// "btn-submit-1234" broke -> try "[id^=btn-submit]" anchored on the stable prefix.
const repairIdDrift = (dom: Document, input: RepairInput, out: RepairCandidate[]) => {
  const idMatches = input.failedSelector.match(/#([A-Za-z][\w-]*)|\[id=["']([^"']+)["']\]/g) ?? [];
  for (const raw of idMatches) {
    const id = raw.startsWith('#') ? raw.slice(1) : raw.match(/["']([^"']+)["']/)?.[1];
    if (!id) continue;
    const prefix = stripDynamicSuffix(id);
    if (!prefix) continue;
    const selector = `[id^="${escapeCssValue(prefix)}"]`;
    const validation = validateSelector(dom, selector, 'css');
    if (validation.validatable && validation.unique) {
      out.push({
        selector,
        selectorType: 'css',
        source: 'id-drift',
        matchCount: validation.matchCount,
        unique: true,
        signatureScore: elementSignatureScore(dom, selector, input.signature ?? null),
        reason: `dynamic id suffix stripped from "${id}"`,
      });
    }
  }
};

// Long structural selectors often break on one hop; retry the final segment alone.
const repairSegmentReanchor = (dom: Document, input: RepairInput, out: RepairCandidate[]) => {
  if (input.selectorType !== 'css') return;
  const segments = input.failedSelector.split(/[>+~]\s*|\s+(?![^[]*\])/).filter(Boolean);
  if (segments.length < 2) return;
  const last = segments[segments.length - 1];
  if (!last || last === input.failedSelector) return;
  const validation = validateSelector(dom, last, 'css');
  if (validation.validatable && validation.unique) {
    out.push({
      selector: last,
      selectorType: 'css',
      source: 'segment-reanchor',
      matchCount: validation.matchCount,
      unique: true,
      signatureScore: elementSignatureScore(dom, last, input.signature ?? null),
      reason: 'final segment of the broken selector is unique on its own',
    });
  }
};

// Extract id references from basic XPath expressions and convert them to CSS
// prefix anchors. This gives XPath-using clients at least some heuristic repair
// coverage instead of falling straight through to LLM or miss.
const repairXPathIdExtract = (dom: Document, input: RepairInput, out: RepairCandidate[]) => {
  if (input.selectorType !== 'xpath') return;
  // Match @id='value' or @id="value" patterns inside XPath predicates.
  const idRefs = input.failedSelector.match(/@id\s*=\s*['"]([^'"]+)['"]/g) ?? [];
  for (const ref of idRefs) {
    const id = ref.match(/['"]([^'"]+)['"]/)?.[1];
    if (!id) continue;
    const prefix = stripDynamicSuffix(id);
    if (!prefix) continue;
    const selector = `[id^="${escapeCssValue(prefix)}"]`;
    const validation = validateSelector(dom, selector, 'css');
    if (validation.validatable && validation.unique) {
      out.push({
        selector,
        selectorType: 'css',
        source: 'xpath-id-extract',
        matchCount: validation.matchCount,
        unique: true,
        signatureScore: elementSignatureScore(dom, selector, input.signature ?? null),
        reason: `extracted id "${id}" from XPath and stripped dynamic suffix`,
      });
    }
  }
};

// Text anchors are executed client-side (UiPath text selectors); emit them only
// when no CSS repair survived, and never mark them unique.
const repairTextAnchor = (input: RepairInput, out: RepairCandidate[]) => {
  if (out.length > 0) return;
  for (const candidate of input.candidates ?? []) {
    const text = (candidate.text ?? '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 80) {
      out.push({
        selector: text,
        selectorType: 'text',
        source: 'text-anchor',
        matchCount: -1,
        unique: false,
        signatureScore: 0.5,
        reason: 'text anchor for client-side verification',
      });
      return;
    }
  }
};

export const heuristicRepair = (input: RepairInput): RepairCandidate[] => {
  const out: RepairCandidate[] = [];
  const dom = input.domSnippet ? parseDom(input.domSnippet) : null;
  if (dom) {
    repairClientCandidates(dom, input, out);
    repairIdDrift(dom, input, out);
    repairSegmentReanchor(dom, input, out);
    repairXPathIdExtract(dom, input, out);
  }
  repairTextAnchor(input, out);

  const tried = new Set((input.triedSelectors ?? []).map((selector) => selector.trim()));
  const ranked = out
    .filter((candidate) => !tried.has(candidate.selector.trim()))
    .filter((candidate) => candidate.selectorType !== 'css' || candidate.unique)
    .sort((a, b) => scoreCandidate(b.signatureScore, b.unique) - scoreCandidate(a.signatureScore, a.unique));
  return ranked.slice(0, MAX_CANDIDATES);
};

export const describeCandidate = (element: Element): ElementDescriptor => describeElement(element);
