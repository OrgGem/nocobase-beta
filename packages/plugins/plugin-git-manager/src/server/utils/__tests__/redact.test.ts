import { describe, expect, it } from 'vitest';
import { isGitManagerResourceResponse, REDACTED_PAT, redactCredentialFields } from '../redact';

describe('Git Manager credential response redaction', () => {
  it('redacts PATs recursively through nested associations and dataValues', () => {
    const response = {
      data: [
        {
          gitAccount: {
            pat: 'top-level-secret',
            dataValues: { pat: 'top-level-data-values-secret' },
          },
          dataValues: {
            gitAccount: {
              pat: 'nested-secret',
              dataValues: { pat: 'nested-data-values-secret' },
            },
          },
        },
      ],
    };

    redactCredentialFields(response);

    expect(response.data[0].gitAccount.pat).toBe(REDACTED_PAT);
    expect(response.data[0].gitAccount.dataValues.pat).toBe(REDACTED_PAT);
    expect(response.data[0].dataValues.gitAccount.pat).toBe(REDACTED_PAT);
    expect(response.data[0].dataValues.gitAccount.dataValues.pat).toBe(REDACTED_PAT);
  });

  it('handles circular response objects without leaving a PAT exposed', () => {
    const response: { pat: string; self?: unknown } = { pat: 'secret' };
    response.self = response;

    redactCredentialFields(response);

    expect(response.pat).toBe(REDACTED_PAT);
  });

  it.each([
    'gitManager',
    'gitRepositories',
    'gitReviewFlows',
    'gitCodeReviews',
    'gitSubtreeConfigs',
    'gitSubtreeRuns',
    'gitAccounts.1.repositories',
    'gitRepositories.10.gitAccount',
  ])('recognizes nested Git Manager response route %s', (resourceName) => {
    expect(isGitManagerResourceResponse(resourceName)).toBe(true);
  });

  it('does not scrub unrelated resource responses', () => {
    expect(isGitManagerResourceResponse('users')).toBe(false);
  });
});
