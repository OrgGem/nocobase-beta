import type { ElementSignature } from '../../constants';
import { md5Hex } from './key-service';
import {
  STABLE_ATTR_NAMES,
  describeElement,
  selectCss,
  selectOneCss,
  textSample,
  type ElementDescriptor,
} from './dom-analyzer';
import type { Document } from 'domhandler';

const ATTR_WEIGHT = 0.6;
const TEXT_WEIGHT = 0.4;
// When neither signature carries evidence we cannot judge resemblance; a
// neutral score lets uniqueness-validated candidates through instead of
// blocking every heal on sparse pages.
const NEUTRAL_SIMILARITY = 0.5;

export const buildSignature = (descriptor: ElementDescriptor): ElementSignature => {
  const stableAttrs: Record<string, string> = {};
  for (const name of STABLE_ATTR_NAMES) {
    const value = descriptor.attrs[name];
    if (value !== undefined) stableAttrs[name] = value;
  }
  if (descriptor.attrs.id && !looksDynamic(descriptor.attrs.id)) {
    stableAttrs.id = descriptor.attrs.id;
  }
  const sample = textSample(descriptor.text);
  return {
    tag: descriptor.tag,
    stableAttrs,
    textSample: sample,
    textHash: md5Hex(sample),
  };
};

const looksDynamic = (value: string): boolean => /[-_](\d{2,}|[0-9a-f]{6,})$/i.test(value) || /\d{6,}/.test(value);

const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

const attributeSimilarity = (a: Record<string, string>, b: Record<string, string>): number | null => {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length === 0 && keysB.length === 0) return null;
  const pairsA = new Set(keysA.map((key) => `${key}=${a[key]}`));
  const pairsB = new Set(keysB.map((key) => `${key}=${b[key]}`));
  let intersection = 0;
  for (const pair of pairsA) {
    if (pairsB.has(pair)) intersection += 1;
  }
  const union = new Set([...pairsA, ...pairsB]).size;
  return union === 0 ? null : intersection / union;
};

const textSimilarity = (a: string, b: string): number | null => {
  const textA = normalizeText(a);
  const textB = normalizeText(b);
  if (!textA && !textB) return null;
  if (!textA || !textB) return 0;
  if (textA === textB) return 1;
  if (textA.includes(textB) || textB.includes(textA)) return 0.7;
  return 0;
};

const combine = (attrScore: number | null, textScore: number | null): number => {
  if (attrScore === null && textScore === null) return NEUTRAL_SIMILARITY;
  if (attrScore === null) return textScore as number;
  if (textScore === null) return attrScore;
  return ATTR_WEIGHT * attrScore + TEXT_WEIGHT * textScore;
};

// Resemblance between the stored element signature and a candidate element.
// A tag mismatch is an instant zero: healing a button onto an input is the
// exact failure mode self-healing must never produce.
export const signatureSimilarity = (
  expected: ElementSignature | null | undefined,
  actual: ElementSignature,
): number => {
  if (!expected) return NEUTRAL_SIMILARITY;
  if (expected.tag && actual.tag && expected.tag !== actual.tag) return 0;
  const attrScore = attributeSimilarity(expected.stableAttrs ?? {}, actual.stableAttrs ?? {});
  const textScore = textSimilarity(expected.textSample ?? '', actual.textSample ?? '');
  return combine(attrScore, textScore);
};

// Capture the signature of the element a CSS selector points at, only when it
// matches exactly one node. Returns null for non-CSS selectors, invalid
// selectors, or ambiguous matches.
export const captureSignature = (dom: Document, selector: string, selectorType: string): ElementSignature | null => {
  if (selectorType !== 'css' || !selector.trim()) return null;
  const { ok, elements } = selectCss(dom, selector.trim());
  if (!ok || elements.length !== 1) return null;
  const element = selectOneCss(dom, selector.trim());
  if (!element) return null;
  return buildSignature(describeElement(element));
};

// Similarity of a candidate selector's matched element against the expected
// signature, evaluated directly on the snapshot DOM.
export const selectorSignatureScore = (
  dom: Document,
  selector: string,
  selectorType: string,
  expected: ElementSignature | null | undefined,
): number => {
  if (!expected) return NEUTRAL_SIMILARITY;
  const captured = captureSignature(dom, selector, selectorType);
  if (!captured) return NEUTRAL_SIMILARITY;
  return signatureSimilarity(expected, captured);
};
