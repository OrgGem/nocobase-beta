import { shouldLoadGitRepositories } from '../pages/SourcesPage';

describe('SourcesPage Git repository request policy', () => {
  it('does not request Git Manager repositories for Skill Hub sources', () => {
    expect(
      shouldLoadGitRepositories({ canManage: true, open: true, providerType: 'skill-hub', advancedConfig: false }),
    ).toBe(false);
  });

  it('does not request repositories before the source modal is open', () => {
    expect(
      shouldLoadGitRepositories({ canManage: true, open: false, providerType: 'git-manager', advancedConfig: false }),
    ).toBe(false);
  });

  it('does not request repositories for advanced Git JSON configuration', () => {
    expect(
      shouldLoadGitRepositories({ canManage: true, open: true, providerType: 'git-manager', advancedConfig: true }),
    ).toBe(false);
  });

  it('requests repositories only for an editable structured Git Manager source', () => {
    expect(
      shouldLoadGitRepositories({ canManage: true, open: true, providerType: 'git-manager', advancedConfig: false }),
    ).toBe(true);
  });
});
