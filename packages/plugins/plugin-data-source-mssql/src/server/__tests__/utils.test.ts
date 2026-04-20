/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { sanitize } from '../utils';

describe('Utils', () => {
  describe('sanitize', () => {
    it('should return primitive values unchanged', () => {
      expect(sanitize(null)).toBe(null);
      expect(sanitize(undefined)).toBe(undefined);
      expect(sanitize(42)).toBe(42);
      expect(sanitize('hello')).toBe('hello');
      expect(sanitize(true)).toBe(true);
    });

    it('should sanitize simple objects', () => {
      const obj = { a: 1, b: 'test' };
      const result = sanitize(obj);

      expect(result).toEqual({ a: 1, b: 'test' });
    });

    it('should sanitize nested objects', () => {
      const obj = {
        level1: {
          level2: {
            value: 'deep',
          },
        },
      };

      const result = sanitize(obj);

      expect(result.level1.level2.value).toBe('deep');
    });

    it('should detect and handle circular references', () => {
      const obj: any = { a: 1 };
      obj.self = obj;

      const result = sanitize(obj);

      expect(result.a).toBe(1);
      expect(result.self).toBe('[Circular]');
    });

    it('should sanitize arrays', () => {
      const arr = [1, 'two', { three: 3 }];
      const result = sanitize(arr);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([1, 'two', { three: 3 }]);
    });

    it('should handle arrays with circular references', () => {
      const arr: any[] = [1, 2];
      arr.push(arr);

      const result = sanitize(arr);

      expect(result[0]).toBe(1);
      expect(result[1]).toBe(2);
      expect(result[2]).toBe('[Circular]');
    });

    it('should respect depth limit', () => {
      const deepObj = {
        l1: {
          l2: {
            l3: {
              l4: {
                value: 'too deep',
              },
            },
          },
        },
      };

      // Default depth is 3
      const result = sanitize(deepObj);

      // l1 (depth 2), l2 (depth 1), l3 (depth 0)
      expect(result.l1.l2.l3).toBe('[DepthExceeded]');
    });

    it('should allow custom depth', () => {
      const obj = {
        l1: {
          l2: {
            value: 'test',
          },
        },
      };

      // With depth 1, should only go one level
      const result = sanitize(obj, 1);

      expect(result.l1).toBe('[DepthExceeded]');
    });

    it('should sanitize Error objects', () => {
      const error = new Error('Test error');
      const result = sanitize(error);

      expect(typeof result).toBe('object');
    });

    it('should handle complex nested structures', () => {
      const complex = {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        meta: {
          total: 2,
          page: 1,
        },
      };

      const result = sanitize(complex);

      expect(result.users).toHaveLength(2);
      expect(result.users[0].name).toBe('Alice');
      expect(result.meta.total).toBe(2);
    });

    it('should handle Date objects', () => {
      const obj = { date: new Date('2024-01-01') };
      const result = sanitize(obj);

      // Date is an object, so it will be processed
      expect(typeof result.date).toBe('object');
    });

    it('should handle multiple references to same object (not circular)', () => {
      const shared = { value: 'shared' };
      const obj = {
        ref1: shared,
        ref2: shared,
      };

      const result = sanitize(obj);

      // First reference should work
      expect(result.ref1.value).toBe('shared');
      // Second reference should be marked as circular (same object seen before)
      expect(result.ref2).toBe('[Circular]');
    });
  });
});
