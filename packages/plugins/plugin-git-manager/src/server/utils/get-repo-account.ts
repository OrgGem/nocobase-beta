import { assertUrlHasNoUserInfo } from './url-security';

export interface GitAccountCredentials {
  pat: string;
  username: string;
  baseUrl: string | null;
  provider: string;
}

type RecordGetter = {
  get(attribute: string): unknown;
};

type GitAccountDatabase = {
  getRepository(name: 'gitAccounts'): {
    findOne(input: { filterByTk: number | string }): Promise<RecordGetter | null>;
  };
};

export async function getRepoAccount(
  db: GitAccountDatabase,
  repo: RecordGetter,
): Promise<GitAccountCredentials | null> {
  const gitAccountId = repo.get('gitAccountId');
  if (typeof gitAccountId !== 'number' && typeof gitAccountId !== 'string') return null;

  const account = await db.getRepository('gitAccounts').findOne({
    filterByTk: gitAccountId,
  });
  if (!account) return null;

  const baseUrl = ((account.get('baseUrl') as string) || '').trim() || null;
  if (baseUrl) assertUrlHasNoUserInfo(baseUrl);

  return {
    pat: ((account.get('pat') as string) || '').trim(),
    username: ((account.get('username') as string) || '').trim(),
    baseUrl,
    provider: ((account.get('provider') as string) || 'gitlab').trim(),
  };
}
