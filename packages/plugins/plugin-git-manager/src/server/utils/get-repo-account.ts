export interface GitAccountCredentials {
  pat: string;
  username: string;
  baseUrl: string | null;
  provider: string;
}

export async function getRepoAccount(db: any, repo: any): Promise<GitAccountCredentials | null> {
  const gitAccountId = repo.get('gitAccountId') as number | null;
  if (!gitAccountId) return null;

  const account = await db.getRepository('gitAccounts').findOne({
    filterByTk: gitAccountId,
  });
  if (!account) return null;

  return {
    pat: ((account.get('pat') as string) || '').trim(),
    username: ((account.get('username') as string) || '').trim(),
    baseUrl: ((account.get('baseUrl') as string) || '').trim() || null,
    provider: ((account.get('provider') as string) || 'gitlab').trim(),
  };
}
