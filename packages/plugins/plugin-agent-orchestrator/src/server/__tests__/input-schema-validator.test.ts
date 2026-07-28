import { describe, expect, it } from 'vitest';
import { validateInputSchemaDefinition, validateSkillInput } from '../services/InputSchemaValidator';

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    count: { type: 'integer', minimum: 1 },
  },
  required: ['title'],
  additionalProperties: false,
};

describe('InputSchemaValidator', () => {
  it('accepts valid input', () => {
    expect(() => validateSkillInput(schema, { title: 'Report', count: 2 })).not.toThrow();
  });

  it('rejects missing, mistyped, and unknown input fields', () => {
    expect(() => validateSkillInput(schema, { count: 0, unexpected: true })).toThrow('Skill input validation failed');
  });

  it('rejects malformed schema definitions before execution', () => {
    expect(() => validateInputSchemaDefinition('{invalid json')).toThrow('valid JSON Schema object');
  });
});
