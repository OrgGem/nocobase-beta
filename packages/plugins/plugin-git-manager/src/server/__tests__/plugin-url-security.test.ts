import { describe, expect, it } from 'vitest';

import { isGitConfigurationUrlMutation } from '../plugin';

describe('Git Manager generic URL mutation policy', () => {
  it('covers direct and association collection create/update routes', () => {
    expect(isGitConfigurationUrlMutation('gitRepositories', 'create')).toBe(true);
    expect(isGitConfigurationUrlMutation('gitAccounts', 'update')).toBe(true);
    expect(isGitConfigurationUrlMutation('gitAccounts.repositories', 'update')).toBe(true);
    expect(isGitConfigurationUrlMutation('gitRepositories.10.gitAccount', 'create')).toBe(true);
  });

  it('does not treat a read or a custom Git Manager action as a generic URL mutation', () => {
    expect(isGitConfigurationUrlMutation('gitAccounts.repositories', 'list')).toBe(false);
    expect(isGitConfigurationUrlMutation('gitManager', 'clone')).toBe(false);
  });
});
