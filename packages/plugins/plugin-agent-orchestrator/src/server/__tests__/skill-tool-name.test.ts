import { describe, expect, it } from 'vitest';
import { buildSkillToolName, getSkillToolName, normalizeSkillToolScope } from '../utils/skill-tool-name';

describe('skill tool identity', () => {
  it('preserves the legacy canonical name for existing bindings', () => {
    expect(buildSkillToolName('Generate-Report')).toBe('skill_hub_generate_report');
  });

  it('uses the persisted immutable tool name when available', () => {
    expect(getSkillToolName({ name: 'renamed-skill', toolName: 'skill_hub_original_name' })).toBe(
      'skill_hub_original_name',
    );
  });

  it('rejects names that cannot produce an AI tool identifier', () => {
    expect(() => buildSkillToolName('---')).toThrow('ASCII letter or number');
  });

  it('normalizes unsupported scopes to CUSTOM', () => {
    expect(normalizeSkillToolScope('GENERAL')).toBe('GENERAL');
    expect(normalizeSkillToolScope('unknown')).toBe('CUSTOM');
  });
});
