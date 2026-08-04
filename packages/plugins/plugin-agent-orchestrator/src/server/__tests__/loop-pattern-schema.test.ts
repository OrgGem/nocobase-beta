import { describe, expect, it } from 'vitest';
import { validateLoopPattern } from '../services/LoopPatternSchema';

const basePattern = {
  key: 'dependency-audit',
  title: 'Dependency audit',
  goalTemplate: 'Audit dependencies and report risks.',
  autonomyLevel: 'L1',
  triggerType: 'manual',
  leaderUsername: 'leader',
  makerUsernames: ['maker'],
  verifierUsername: 'verifier',
};

describe('LoopPatternSchema', () => {
  it('accepts a manual L1 read-only pattern without repository isolation', () => {
    const result = validateLoopPattern(basePattern);
    expect(result.success).toBe(true);
  });

  it('requires independent role identities', () => {
    const result = validateLoopPattern({ ...basePattern, verifierUsername: 'maker' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'verifierUsername')).toBe(true);
    }
  });

  it('requires an explicit valid timezone for cron patterns', () => {
    expect(
      validateLoopPattern({ ...basePattern, triggerType: 'cron', cronExpression: '0 * * * *', timezone: null }).success,
    ).toBe(false);
    expect(
      validateLoopPattern({
        ...basePattern,
        triggerType: 'cron',
        cronExpression: '0 * * * *',
        timezone: 'Asia/Ho_Chi_Minh',
      }).success,
    ).toBe(true);
  });

  it('requires repository paths and worktree isolation for L2 and L3', () => {
    expect(validateLoopPattern({ ...basePattern, autonomyLevel: 'L2' }).success).toBe(false);
    expect(
      validateLoopPattern({
        ...basePattern,
        autonomyLevel: 'L2',
        repositoryKey: 'main-repository',
        repositoryRoot: 'C:/workspace/repository',
        actingOn: ['packages/plugins/**'],
        policy: { harness: { isolation: { mode: 'worktree', requireWorktree: true } } },
      }).success,
    ).toBe(true);
  });
});
