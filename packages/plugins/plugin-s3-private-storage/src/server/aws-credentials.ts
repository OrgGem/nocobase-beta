/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { AwsCredentialIdentity } from '@smithy/types';

/**
 * Credential resolution for S3 clients.
 *
 * Supports three modes:
 * 1. Static credentials (accessKeyId + secretAccessKey) — used directly.
 * 2. Assume role (roleArn) — calls STS AssumeRole, optionally chaining on top
 *    of static credentials or the default credential chain (EC2 instance
 *    profile / ECS container credentials / env vars / shared config).
 * 3. No credentials configured — the AWS SDK falls back to its default
 *    credential chain, which covers EC2 instances that already have S3
 *    permissions through an IAM role attached to the instance profile
 *    (e.g. an EC2 in the same account as the bucket).
 */

export interface S3CredentialOptions {
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  roleArn?: string;
  roleSessionName?: string;
  externalId?: string;
}

export type CredentialsProvider = (() => Promise<AwsCredentialIdentity>) | AwsCredentialIdentity | undefined;

const ROLE_CREDENTIAL_REFRESH_BUFFER_MS = 5 * 60_000;
const ROLE_CREDENTIAL_FALLBACK_TTL_MS = 15 * 60_000;

export function resolveCredentialsProvider(options: S3CredentialOptions): CredentialsProvider {
  const accessKeyId = options.accessKeyId?.trim();
  const secretAccessKey = options.secretAccessKey?.trim();
  const roleArn = options.roleArn?.trim();

  // 1. Assume-role workflow (optionally chained on static or instance credentials).
  if (roleArn) {
    return createAssumeRoleProvider(
      options,
      accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    );
  }

  // 2. Static credentials.
  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
    };
  }

  // 3. No explicit credentials: let the SDK resolve through the default chain.
  return undefined;
}

function createAssumeRoleProvider(
  options: S3CredentialOptions,
  baseCredentials?: { accessKeyId: string; secretAccessKey: string },
): () => Promise<AwsCredentialIdentity> {
  let cached: { creds: AwsCredentialIdentity; expiresAt: number } | null = null;

  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now + ROLE_CREDENTIAL_REFRESH_BUFFER_MS) {
      return cached.creds;
    }

    let sts: any;
    try {
      // Use a variable so the NocoBase build tool does not try to resolve the
      // package root (nested-clients has no "." export). The subpath is
      // resolved at runtime from dist/node_modules, where it is bundled
      // transitively via @aws-sdk/credential-provider-node.
      const stsPackage = '@aws-sdk/nested-clients/sts';
      sts = require(stsPackage);
    } catch (error) {
      throw new Error(
        '[s3-private-storage] @aws-sdk/nested-clients is required for roleArn-based credentials. Please run `npm install @aws-sdk/nested-clients`.',
      );
    }

    const stsConfig: any = {
      region: options.region,
    };
    if (options.endpoint) {
      stsConfig.endpoint = options.endpoint;
    }
    if (baseCredentials) {
      stsConfig.credentials = baseCredentials;
    } else {
      // The nested-clients STS runtime does not wire a default credential
      // provider, so provide the standard default chain (env → shared config →
      // IMDS/ECS) explicitly. This lets EC2 instances assume a role using
      // their instance profile credentials.
      try {
        const { defaultProvider } = require('@aws-sdk/credential-provider-node');
        stsConfig.credentialDefaultProvider = (config: any) => defaultProvider({ profile: config?.profile });
      } catch {
        // If credential-provider-node is unavailable, STS will fail later with
        // a descriptive "credentials not provided" error.
      }
    }

    const client = new sts.STSClient(stsConfig);
    const command = new sts.AssumeRoleCommand({
      RoleArn: options.roleArn?.trim(),
      RoleSessionName: options.roleSessionName?.trim() || 's3-private-storage',
      ...(options.externalId?.trim() ? { ExternalId: options.externalId.trim() } : {}),
    });

    const response = await client.send(command);
    const roleCredentials = response.Credentials;
    if (!roleCredentials?.AccessKeyId || !roleCredentials.SecretAccessKey) {
      throw new Error('[s3-private-storage] AssumeRole returned incomplete credentials');
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
