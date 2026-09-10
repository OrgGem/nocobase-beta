/**
 * Shared AWS credential / client resolution for ECR auth and catalog providers.
 *
 * Mirrors the credential chain used by plugin-s3-private-storage:
 * 1. roleArn → STS AssumeRole (optionally chained on static creds or the default chain).
 * 2. Static credentials (accessKeyId + secretAccessKey).
 * 3. Nothing configured → the AWS SDK default credential chain (EC2 instance
 *    profile / ECS container credentials / env vars / shared config).
 */

import type { AwsCredentialIdentity } from '@smithy/types';

export interface EcrClientConfigOptions {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  roleArn?: string;
  roleSessionName?: string;
  externalId?: string;
}

export type EcrCredentialsProvider = (() => Promise<AwsCredentialIdentity>) | AwsCredentialIdentity | undefined;

const ROLE_CREDENTIAL_REFRESH_BUFFER_MS = 5 * 60_000;
const ROLE_CREDENTIAL_FALLBACK_TTL_MS = 15 * 60_000;

interface AssumeRoleCredentials {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
  Expiration?: Date;
}

interface StsConfig {
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  credentialDefaultProvider?: (config: { profile?: string }) => unknown;
}

interface StsClientLike {
  send(command: unknown): Promise<{ Credentials?: AssumeRoleCredentials }>;
}

interface StsSdkModule {
  STSClient: new (config: StsConfig) => StsClientLike;
  AssumeRoleCommand: new (input: { RoleArn?: string; RoleSessionName?: string; ExternalId?: string }) => unknown;
}

interface CredentialProviderNodeModule {
  defaultProvider: (config: { profile?: string }) => unknown;
}

export function resolveEcrCredentialsProvider(options: EcrClientConfigOptions): EcrCredentialsProvider {
  const accessKeyId = options.accessKeyId?.trim();
  const secretAccessKey = options.secretAccessKey?.trim();
  const roleArn = options.roleArn?.trim();

  if (roleArn) {
    return createAssumeRoleProvider(
      options,
      accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    );
  }

  if (accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey };
  }

  return undefined;
}

function createAssumeRoleProvider(
  options: EcrClientConfigOptions,
  baseCredentials?: { accessKeyId: string; secretAccessKey: string },
): () => Promise<AwsCredentialIdentity> {
  let cached: { creds: AwsCredentialIdentity; expiresAt: number } | null = null;

  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now + ROLE_CREDENTIAL_REFRESH_BUFFER_MS) {
      return cached.creds;
    }

    let sts: StsSdkModule;
    try {
      // Use a variable so the NocoBase build tool does not try to resolve the
      // package root (nested-clients has no "." export).
      const stsPackage = '@aws-sdk/nested-clients/sts';
      sts = require(stsPackage) as StsSdkModule;
    } catch (error) {
      throw new Error(
        '[docker-registry-ui] @aws-sdk/nested-clients is required for roleArn-based ECR credentials. Please run `npm install @aws-sdk/nested-clients`.',
      );
    }

    const stsConfig: StsConfig = { region: options.region };
    if (baseCredentials) {
      stsConfig.credentials = baseCredentials;
    } else {
      try {
        const { defaultProvider } = require('@aws-sdk/credential-provider-node') as CredentialProviderNodeModule;
        stsConfig.credentialDefaultProvider = (config: { profile?: string }) =>
          defaultProvider({ profile: config?.profile });
      } catch {
        // If credential-provider-node is unavailable, STS will fail later with
        // a descriptive "credentials not provided" error.
      }
    }

    const client = new sts.STSClient(stsConfig);
    const command = new sts.AssumeRoleCommand({
      RoleArn: options.roleArn?.trim(),
      RoleSessionName: options.roleSessionName?.trim() || 'docker-registry-ui-ecr',
      ...(options.externalId?.trim() ? { ExternalId: options.externalId.trim() } : {}),
    });

    const response = await client.send(command);
    const roleCredentials = response.Credentials;
    if (!roleCredentials?.AccessKeyId || !roleCredentials.SecretAccessKey) {
      throw new Error('[docker-registry-ui] AssumeRole returned incomplete credentials');
    }

    const creds: AwsCredentialIdentity = {
      accessKeyId: roleCredentials.AccessKeyId,
      secretAccessKey: roleCredentials.SecretAccessKey,
      ...(roleCredentials.SessionToken ? { sessionToken: roleCredentials.SessionToken } : {}),
      ...(roleCredentials.Expiration ? { expiration: roleCredentials.Expiration } : {}),
    };

    cached = {
      creds,
      expiresAt: roleCredentials.Expiration
        ? roleCredentials.Expiration.getTime()
        : now + ROLE_CREDENTIAL_FALLBACK_TTL_MS,
    };

    return creds;
  };
}
