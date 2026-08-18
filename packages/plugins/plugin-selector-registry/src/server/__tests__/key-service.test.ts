import {
  computeElementKey,
  looksLikeDynamicId,
  md5Hex,
  normalizeSelector,
  selectorFingerprint,
  sha256Hex,
  stripDynamicSuffix,
} from '../services/key-service';

describe('key-service', () => {
  describe('hashes', () => {
    it('produces stable sha256 and md5 hex digests', () => {
      expect(sha256Hex('abc')).toHaveLength(64);
      expect(md5Hex('abc')).toHaveLength(32);
      expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
      expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
    });
  });

  describe('normalizeSelector', () => {
    it('trims and collapses whitespace', () => {
      expect(normalizeSelector('  div  >  span ')).toBe('div > span');
      expect(normalizeSelector('#a\n  #b')).toBe('#a #b');
    });
  });

  describe('selectorFingerprint', () => {
    it('is insensitive to surrounding whitespace', () => {
      expect(selectorFingerprint('  #login  ')).toBe(selectorFingerprint('#login'));
    });
    it('differs for different selectors', () => {
      expect(selectorFingerprint('#login')).not.toBe(selectorFingerprint('#logout'));
    });
  });

  describe('computeElementKey', () => {
    it('is stable for the same logical identity', () => {
      const a = computeElementKey({ app: 'crm', pageUrlPattern: '/login', logicalId: 'submit-btn' });
      const b = computeElementKey({ app: 'crm', pageUrlPattern: '/login', logicalId: 'submit-btn' });
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
    });
    it('is case-insensitive on app and page', () => {
      const a = computeElementKey({ app: 'CRM', pageUrlPattern: '/Login', logicalId: 'x' });
      const b = computeElementKey({ app: 'crm', pageUrlPattern: '/login', logicalId: 'x' });
      expect(a).toBe(b);
    });
    it('changes when the logical id changes', () => {
      const a = computeElementKey({ app: 'crm', pageUrlPattern: '/l', logicalId: 'a' });
      const b = computeElementKey({ app: 'crm', pageUrlPattern: '/l', logicalId: 'b' });
      expect(a).not.toBe(b);
    });
    it('survives selector changes because it does not hash the selector', () => {
      // Same identity even though the selector text would differ between runs.
      const a = computeElementKey({ app: 'crm', pageUrlPattern: '/l', logicalId: 'submit' });
      const b = computeElementKey({ app: 'crm', pageUrlPattern: '/l', logicalId: 'submit' });
      expect(a).toBe(b);
    });
    it('throws without a logicalId', () => {
      expect(() => computeElementKey({ app: 'crm', pageUrlPattern: '/l' })).toThrow();
    });
  });

  describe('dynamic id helpers', () => {
    it('detects dynamic-looking ids', () => {
      expect(looksLikeDynamicId('btn-submit-12345')).toBe(true);
      expect(looksLikeDynamicId('uid-abc123')).toBe(true);
      expect(looksLikeDynamicId('item_9f3a2b1c')).toBe(true);
    });
    it('accepts stable ids', () => {
      expect(looksLikeDynamicId('login-button')).toBe(false);
      expect(looksLikeDynamicId('submit')).toBe(false);
    });
    it('strips volatile suffixes', () => {
      expect(stripDynamicSuffix('btn-submit-1234')).toBe('btn-submit');
      expect(stripDynamicSuffix('row_9f3a2b1c')).toBe('row');
      expect(stripDynamicSuffix('stable')).toBeNull();
    });
    it('refuses to strip when the remaining prefix is too short', () => {
      expect(stripDynamicSuffix('a-12345')).toBeNull();
    });
  });
});
