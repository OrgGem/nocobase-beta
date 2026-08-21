import { resolveCredentialsProvider } from '../aws-credentials';

describe('resolveCredentialsProvider', () => {
  it('returns undefined when no credentials or role are configured (default chain)', () => {
    const provider = resolveCredentialsProvider({ region: 'us-east-1' });
    expect(provider).toBeUndefined();
  });

  it('returns static credentials when both keys are present', () => {
    const provider = resolveCredentialsProvider({
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    }) as any;
    expect(provider).toEqual({
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    });
  });

  it('returns undefined when only one key is present', () => {
    expect(resolveCredentialsProvider({ accessKeyId: 'AKIA_TEST' })).toBeUndefined();
    expect(resolveCredentialsProvider({ secretAccessKey: 'secret' })).toBeUndefined();
  });

  it('trims whitespace around credentials', () => {
    const provider = resolveCredentialsProvider({
      accessKeyId: '  AKIA_TEST  ',
      secretAccessKey: '  secret  ',
    }) as any;
    expect(provider.accessKeyId).toBe('AKIA_TEST');
    expect(provider.secretAccessKey).toBe('secret');
  });

  it('creates an assume-role provider when roleArn is set', async () => {
    const provider = resolveCredentialsProvider({
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123456789012:role/test-role',
    }) as () => Promise<any>;

    expect(typeof provider).toBe('function');

    // @aws-sdk/nested-clients may not be resolvable in all test envs; the
    // provider should either work or throw a descriptive error.
    try {
      const creds = await provider();
      expect(creds.accessKeyId).toBeTruthy();
      expect(creds.secretAccessKey).toBeTruthy();
    } catch (error: any) {
      // In a test environment without AWS credentials the default chain fails;
      // that means STS was wired up correctly. Only a missing-module error is a bug.
      const message = error.message || '';
      expect(message).not.toContain('@aws-sdk/nested-clients');
      expect(message).toMatch(/Could not load credentials|Credentials|credential/i);
    }
  });

  it('uses static credentials as the base for assume-role when provided', () => {
    const provider = resolveCredentialsProvider({
      accessKeyId: 'AKIA_BASE',
      secretAccessKey: 'base-secret',
      roleArn: 'arn:aws:iam::123456789012:role/test-role',
    });
    expect(typeof provider).toBe('function');
  });
});
