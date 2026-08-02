import { describe, expect, it } from 'vitest';

import { validateRepoUrl } from '../../actions/git-actions';
import { parseGitLabProject } from '../gitlab-url';
import { redactCredentialFields } from '../redact';
import {
  assertUrlHasNoUserInfo,
  containsCredentialBearingUrlField,
  hasUrlUserInfo,
  redactUrlUserInfo,
  URL_USERINFO_NOT_ALLOWED,
} from '../url-security';

const CREDENTIAL_URL = 'https://user:secret@example.test/group/repository.git';
const USERNAME_ONLY_URL = 'https://user@example.test/group/repository.git';
const REPOSITORY_URL_FIELDS = new Set(['repoUrl']);
const ACCOUNT_URL_FIELDS = new Set(['baseUrl']);
const GIT_CONFIGURATION_URL_FIELDS = new Set(['repoUrl', 'baseUrl']);

describe('Git Manager URL credential security', () => {
  it('rejects URLs with a username or password', () => {
    expect(hasUrlUserInfo(CREDENTIAL_URL)).toBe(true);
    expect(hasUrlUserInfo(USERNAME_ONLY_URL)).toBe(true);
    expect(() => assertUrlHasNoUserInfo(CREDENTIAL_URL)).toThrow(URL_USERINFO_NOT_ALLOWED);
    expect(() => assertUrlHasNoUserInfo(USERNAME_ONLY_URL)).toThrow(URL_USERINFO_NOT_ALLOWED);
  });

  it.each([
    ['direct repository URL', { repoUrl: CREDENTIAL_URL }, REPOSITORY_URL_FIELDS],
    ['dotted repository URL', { 'values.repoUrl': CREDENTIAL_URL }, REPOSITORY_URL_FIELDS],
    ['bracket account URL', { 'values[baseUrl]': USERNAME_ONLY_URL }, ACCOUNT_URL_FIELDS],
    ['nested account URL', { values: { updateAssociationValues: { baseUrl: CREDENTIAL_URL } } }, ACCOUNT_URL_FIELDS],
    [
      'repository association account URL',
      { values: { gitAccount: { baseUrl: CREDENTIAL_URL } } },
      GIT_CONFIGURATION_URL_FIELDS,
    ],
    [
      'account association repository URL',
      { values: { repositories: [{ repoUrl: CREDENTIAL_URL }] } },
      GIT_CONFIGURATION_URL_FIELDS,
    ],
    ['serialized query values', JSON.stringify({ values: { repoUrl: CREDENTIAL_URL } }), REPOSITORY_URL_FIELDS],
  ])('finds a credential-bearing URL in %s', (_source, value, fields) => {
    expect(containsCredentialBearingUrlField(value, fields)).toBe(true);
  });

  it('allows clean URLs and ignores other field names', () => {
    expect(
      containsCredentialBearingUrlField(
        { values: { repoUrl: 'https://example.test/group/repository.git' } },
        REPOSITORY_URL_FIELDS,
      ),
    ).toBe(false);
    expect(containsCredentialBearingUrlField({ otherUrl: CREDENTIAL_URL }, REPOSITORY_URL_FIELDS)).toBe(false);
    expect(() => validateRepoUrl('https://example.test/group/repository.git')).not.toThrow();
  });

  it('rejects credential-bearing URLs in Git entry points', () => {
    expect(() => validateRepoUrl(CREDENTIAL_URL)).toThrow(URL_USERINFO_NOT_ALLOWED);
    expect(() => parseGitLabProject(USERNAME_ONLY_URL)).toThrow(URL_USERINFO_NOT_ALLOWED);
  });

  it('redacts userinfo from nested repository and account responses', () => {
    const response = {
      data: {
        repoUrl: CREDENTIAL_URL,
        gitAccount: {
          baseUrl: USERNAME_ONLY_URL,
        },
      },
    };

    redactCredentialFields(response);

    expect(response.data.repoUrl).toBe('https://***:***@example.test/group/repository.git');
    expect(response.data.gitAccount.baseUrl).toBe('https://***:***@example.test/group/repository.git');
  });

  it('does not leak a password segment when legacy userinfo contains another at sign', () => {
    expect(redactUrlUserInfo('https://user:secret@still-secret@example.test/repository.git')).toBe(
      'https://***:***@example.test/repository.git',
    );
  });
});
