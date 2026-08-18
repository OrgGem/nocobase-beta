import { selectAll, selectOne } from 'css-select';
import render from 'dom-serializer';
import { getAttributeValue, getChildren, getName, getParent, getText, removeElement } from 'domutils';
import { parseDocument } from 'htmlparser2';
import type { Document, Element } from 'domhandler';
import { isTag, isText } from 'domhandler';

import { md5Hex } from './key-service';

export interface ElementDescriptor {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  textHash: string;
}

export interface SelectorValidation {
  validatable: boolean;
  matchCount: number;
  unique: boolean;
  reason?: string;
}

const STRIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'canvas']);

// Attributes that survive redesigns; the signature ignores everything else so
// similarity scoring is not fooled by class/style churn.
export const STABLE_ATTR_NAMES = [
  'data-testid',
  'data-test',
  'data-test-id',
  'data-cy',
  'data-qa',
  'data-id',
  'name',
  'aria-label',
  'placeholder',
  'title',
  'role',
  'type',
  'alt',
  'for',
  'href',
];

const TEXT_SAMPLE_MAX = 160;

export const parseDom = (html: string): Document => parseDocument(html);

const asElementArray = (nodes: unknown): Element[] =>
  Array.isArray(nodes) ? (nodes.filter((node) => isTag(node)) as Element[]) : [];

export const selectCss = (
  dom: Document | Element,
  selector: string,
): { ok: boolean; elements: Element[]; error?: string } => {
  try {
    return { ok: true, elements: asElementArray(selectAll(selector, dom as never)) };
  } catch (error) {
    return { ok: false, elements: [], error: error instanceof Error ? error.message : String(error) };
  }
};

export const selectOneCss = (dom: Document | Element, selector: string): Element | null => {
  try {
    const found = selectOne(selector, dom as never);
    return found && isTag(found) ? (found as Element) : null;
  } catch {
    return null;
  }
};

// Only CSS selectors can be validated server-side. XPath/text/aria selectors
// are executed by the automation client, so they stay `validatable: false`
// and must be confirmed through the feedback loop instead.
export const validateSelector = (dom: Document, selector: string, selectorType: string): SelectorValidation => {
  if (!selector || !selector.trim()) {
    return { validatable: true, matchCount: 0, unique: false, reason: 'empty selector' };
  }
  if (selectorType !== 'css') {
    return {
      validatable: false,
      matchCount: -1,
      unique: false,
      reason: `${selectorType} selectors are validated client-side`,
    };
  }
  const result = selectCss(dom, selector.trim());
  if (!result.ok) {
    return { validatable: false, matchCount: -1, unique: false, reason: result.error };
  }
  return {
    validatable: true,
    matchCount: result.elements.length,
    unique: result.elements.length === 1,
  };
};

export const describeElement = (element: Element): ElementDescriptor => {
  const attrs: Record<string, string> = {};
  for (const [name, value] of Object.entries(element.attribs ?? {})) {
    if (typeof value === 'string' && value !== '') attrs[name.toLowerCase()] = value;
  }
  const text = collapseText(getText(element));
  return { tag: getName(element).toLowerCase(), attrs, text, textHash: md5Hex(text) };
};

export const collapseText = (value: string): string => value.replace(/\s+/g, ' ').trim();

export const textSample = (value: string): string => collapseText(value).slice(0, TEXT_SAMPLE_MAX);

// Remove noisy subtrees and serialize back to compact HTML for prompts/logs.
export const trimDomSnippet = (html: string, maxChars = 20000): string => {
  const dom = parseDom(html);
  const strip = (nodes: unknown) => {
    for (const node of Array.isArray(nodes) ? [...nodes] : []) {
      if (isTag(node)) {
        const tag = getName(node).toLowerCase();
        if (STRIP_TAGS.has(tag)) {
          removeElement(node);
          continue;
        }
        strip(getChildren(node));
      } else if (isText(node)) {
        const collapsed = node.data.replace(/\s+/g, ' ');
        if (collapsed.trim() === '') node.data = '';
        else node.data = collapsed;
      }
    }
  };
  strip(getChildren(dom));
  let output = render(dom, { encodeEntities: 'utf8' });
  output = output.replace(/\s{2,}/g, ' ');
  if (output.length <= maxChars) return output;
  const cut = output.lastIndexOf('>', maxChars);
  return `${output.slice(0, cut > 0 ? cut + 1 : maxChars)}<!-- truncated -->`;
};

// Return the markup around the (failed) selector's element when it still
// exists in the snapshot, otherwise the whole trimmed snippet.
export const extractNeighborhood = (html: string, selector: string, selectorType: string, maxChars = 20000): string => {
  const dom = parseDom(html);
  if (selectorType === 'css') {
    const element = selectOneCss(dom, selector);
    if (element) {
      let scope: Element = element;
      for (let depth = 0; depth < 3; depth += 1) {
        const parent = getParent(scope);
        if (!parent || !isTag(parent) || getName(parent).toLowerCase() === 'body') break;
        scope = parent as Element;
      }
      const output = render(scope, { encodeEntities: 'utf8' }).replace(/\s{2,}/g, ' ');
      if (output.length <= maxChars) return output;
    }
  }
  return trimDomSnippet(html, maxChars);
};

export const escapeCssValue = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export const attributeValue = (element: Element, name: string): string | undefined => {
  const value = getAttributeValue(element, name);
  return typeof value === 'string' && value !== '' ? value : undefined;
};
