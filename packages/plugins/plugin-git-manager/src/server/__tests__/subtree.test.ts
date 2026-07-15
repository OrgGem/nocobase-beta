import { describe, expect, it } from 'vitest';
import {
  SUBTREE_EXECUTION_MODE,
  validateRemoteName,
  validateRunAgainstPreview,
  validateSubtreeConfigInput,
  validateSubtreePolicy,
  validateSubtreePrefix,
} from '../actions/subtree';

describe('Git subtree validation', () => {
  it('accepts and normalizes one relative source folder', () => {
    expect(validateSubtreePrefix('./apps/admin/')).toBe('apps/admin');
  });

  it.each(['../admin', 'apps/../admin', '/apps/admin', 'C:/apps/admin', ''])('rejects unsafe prefix %s', (prefix) => {
    expect(() => validateSubtreePrefix(prefix)).toThrow();
  });

  it('requires different source and target branches', () => {
    expect(() =>
      validateSubtreeConfigInput({
        sourceBranch: 'main',
        targetBranch: 'main',
        sourcePrefix: 'apps/admin',
        remoteName: 'origin',
        defaultPolicy: 'fastForward',
      }),
    ).toThrow('Source branch and target branch must be different');
  });

  it.each(['fastForward', 'replace', 'merge'])('accepts the %s policy', (policy) => {
    expect(validateSubtreePolicy(policy)).toBe(policy);
  });

  it('rejects option injection in the remote name', () => {
    expect(() => validateRemoteName('--upload-pack=evil')).toThrow('Invalid Git remote name');
  });

  it.each(['feature..bad', 'feature.lock', '.hidden', 'feature//bad'])('rejects invalid Git branch %s', (branch) => {
    expect(() =>
      validateSubtreeConfigInput({ sourceBranch: branch, targetBranch: 'deploy', sourcePrefix: 'apps/admin' }),
    ).toThrow('Invalid branch name');
  });
});

describe('Git subtree update policy', () => {
  it('runs interactively on the app process instead of the review queue', () => {
    expect(SUBTREE_EXECUTION_MODE).toBe('app');
  });

  it('blocks fast-forward when the target has diverged', () => {
    expect(() => validateRunAgainstPreview('fastForward', { relationship: 'diverged', targetSha: 'old' })).toThrow(
      'Target branch cannot be fast-forwarded',
    );
  });

  it('requires the exact preview SHA before replacing an existing target', () => {
    expect(() => validateRunAgainstPreview('replace', { relationship: 'diverged', targetSha: 'old' })).toThrow(
      'requires the preview target SHA',
    );
    expect(() =>
      validateRunAgainstPreview('replace', { relationship: 'diverged', targetSha: 'old' }, 'changed'),
    ).toThrow('Target branch changed after preview');
    expect(() =>
      validateRunAgainstPreview('replace', { relationship: 'diverged', targetSha: 'old' }, 'old'),
    ).not.toThrow();
  });

  it('allows merge for unrelated or diverged histories', () => {
    expect(() => validateRunAgainstPreview('merge', { relationship: 'diverged', targetSha: 'old' })).not.toThrow();
  });
});
