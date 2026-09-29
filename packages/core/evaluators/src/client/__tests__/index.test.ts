/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, it, expect } from 'vitest';
import evaluators, { evaluators as evaluatorsRegistry, getOptions } from '../index';

describe('evaluators client registry', () => {
  it('should export default registry', () => {
    expect(evaluators).toBe(evaluatorsRegistry);
  });

  it('should register the three built-in engines', () => {
    expect(evaluators.get('math.js')).toBeDefined();
    expect(evaluators.get('formula.js')).toBeDefined();
    expect(evaluators.get('string')).toBeDefined();
  });

  it('should expose labeled options via getOptions', () => {
    const options = getOptions();
    expect(Array.isArray(options)).toBe(true);
    expect(options.length).toBeGreaterThanOrEqual(3);
    const labels = options.map((o) => o.label);
    expect(labels).toContain('Math.js');
    expect(labels).toContain('Formula.js');
  });

  it('should return evaluate functions that compute values', () => {
    const math = evaluators.get('math.js');
    expect(math.evaluate('2 + 3')).toBe(5);

    const str = evaluators.get('string');
    expect(str.evaluate('Hi {{name}}', { name: 'NocoBase' })).toBe('Hi NocoBase');
  });
});