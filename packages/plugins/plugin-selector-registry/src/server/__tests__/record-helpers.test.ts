import { read, toNumber, toIso } from '../utils/record-helpers';

describe('record-helpers', () => {
  describe('read', () => {
    it('reads plain object properties', () => {
      expect(read({ a: 1 }, 'a')).toBe(1);
    });

    it('reads model instances via .get()', () => {
      const model = { get: (k: string) => (k === 'x' ? 42 : undefined) };
      expect(read(model, 'x')).toBe(42);
      expect(read(model, 'y')).toBeUndefined();
    });

    it('returns undefined for null/undefined records', () => {
      expect(read(null, 'a')).toBeUndefined();
      expect(read(undefined, 'a')).toBeUndefined();
    });
  });

  describe('toNumber', () => {
    it('converts numeric strings', () => {
      expect(toNumber('42')).toBe(42);
    });
    it('returns fallback for NaN', () => {
      expect(toNumber('abc')).toBe(0);
      expect(toNumber('abc', -1)).toBe(-1);
    });
    it('returns fallback for Infinity', () => {
      expect(toNumber(Infinity)).toBe(0);
    });
    it('passes through finite numbers', () => {
      expect(toNumber(3.14)).toBe(3.14);
    });
  });

  describe('toIso', () => {
    it('produces ISO 8601 strings', () => {
      expect(toIso(new Date('2025-01-01T00:00:00Z'))).toBe('2025-01-01T00:00:00.000Z');
    });
  });
});
