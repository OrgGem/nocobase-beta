import type { ElementSignature } from '../../constants';
import { describeElement, parseDom, selectOneCss } from '../services/dom-analyzer';
import {
  buildSignature,
  captureSignature,
  selectorSignatureScore,
  signatureSimilarity,
} from '../services/signature-service';

const signatureOf = (html: string, selector: string): ElementSignature => {
  const dom = parseDom(html);
  const element = selectOneCss(dom, selector);
  if (!element) throw new Error(`missing element for ${selector}`);
  return buildSignature(describeElement(element));
};

describe('signature-service', () => {
  const PAGE = `
    <form id="login">
      <button data-testid="submit" aria-label="Sign in" name="go">Sign in</button>
      <button data-testid="cancel" aria-label="Cancel">Cancel</button>
      <input name="username" placeholder="Username" />
    </form>
  `;

  describe('buildSignature', () => {
    it('keeps only stable attributes', () => {
      const signature = signatureOf(PAGE, '[data-testid="submit"]');
      expect(signature.tag).toBe('button');
      expect(signature.stableAttrs['data-testid']).toBe('submit');
      expect(signature.stableAttrs['aria-label']).toBe('Sign in');
      expect(signature.stableAttrs.class).toBeUndefined();
      expect(signature.textSample).toBe('Sign in');
    });

    it('drops dynamic ids from the signature', () => {
      const signature = signatureOf('<div><span id="item-123456">Row</span></div>', '#item-123456');
      expect(signature.stableAttrs.id).toBeUndefined();
    });

    it('keeps stable ids', () => {
      const signature = signatureOf('<div><span id="login-title">Row</span></div>', '#login-title');
      expect(signature.stableAttrs.id).toBe('login-title');
    });
  });

  describe('signatureSimilarity', () => {
    it('scores identical elements as 1', () => {
      const a = signatureOf(PAGE, '[data-testid="submit"]');
      expect(signatureSimilarity(a, a)).toBeCloseTo(1, 5);
    });

    it('returns zero on tag mismatch', () => {
      const button = signatureOf(PAGE, '[data-testid="submit"]');
      const input = signatureOf(PAGE, 'input[name="username"]');
      expect(signatureSimilarity(button, input)).toBe(0);
    });

    it('scores a sibling with different attrs and text low', () => {
      const submit = signatureOf(PAGE, '[data-testid="submit"]');
      const cancel = signatureOf(PAGE, '[data-testid="cancel"]');
      expect(signatureSimilarity(submit, cancel)).toBeLessThan(0.4);
    });

    it('returns neutral when no expected signature exists', () => {
      const actual = signatureOf(PAGE, '[data-testid="submit"]');
      expect(signatureSimilarity(null, actual)).toBe(0.5);
      expect(signatureSimilarity(undefined, actual)).toBe(0.5);
    });

    it('survives cosmetic text changes with partial credit', () => {
      const before = signatureOf('<button data-testid="go">Sign in</button>', '[data-testid="go"]');
      const after = signatureOf('<button data-testid="go">Sign   in now</button>', '[data-testid="go"]');
      expect(signatureSimilarity(before, after)).toBeGreaterThan(0.5);
    });
  });

  describe('captureSignature', () => {
    it('captures the signature of a unique css match', () => {
      const dom = parseDom(PAGE);
      const signature = captureSignature(dom, '[data-testid="submit"]', 'css');
      expect(signature?.tag).toBe('button');
      expect(signature?.stableAttrs['data-testid']).toBe('submit');
    });

    it('returns null for ambiguous matches', () => {
      const dom = parseDom(PAGE);
      expect(captureSignature(dom, 'button', 'css')).toBeNull();
    });

    it('returns null for non-css selectors', () => {
      const dom = parseDom(PAGE);
      expect(captureSignature(dom, '//button', 'xpath')).toBeNull();
    });
  });

  describe('selectorSignatureScore', () => {
    it('scores a matching selector against the expected signature', () => {
      const dom = parseDom(PAGE);
      const expected = signatureOf(PAGE, '[data-testid="submit"]');
      expect(selectorSignatureScore(dom, '[aria-label="Sign in"]', 'css', expected)).toBeGreaterThan(0.6);
    });

    it('rejects the wrong element', () => {
      const dom = parseDom(PAGE);
      const expected = signatureOf(PAGE, '[data-testid="submit"]');
      expect(selectorSignatureScore(dom, '[data-testid="cancel"]', 'css', expected)).toBeLessThan(0.4);
    });
  });
});
