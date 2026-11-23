// SPDX-License-Identifier: Apache-2.0

import { SECRET_MASK } from '../../shared/constants';
import type { RcloneProviderOption } from '../../shared/types';

const SENSITIVE_KEY_PATTERN =
  /(?:^|_)(?:pass(?:word)?\d*|secret|token|client_secret|access_key_id|secret_access_key|private_key|sas_url|api_key|bearer_token|key_pem|encrypt_password)(?:$|_)/i;

const NON_SENSITIVE_EXCEPTIONS = new Set([
  'key_file_type',
  'public_key',
  'storage_class',
  'acl',
  'location_constraint',
  'server_side_encryption',
]);

export function isSensitiveRemoteField(key: string, providerOptions?: readonly RcloneProviderOption[]): boolean {
  const normalized = key.trim().toLowerCase();
  if (NON_SENSITIVE_EXCEPTIONS.has(normalized)) {
    return false;
  }
  const matchedOption = providerOptions?.find((opt) => opt.Name.toLowerCase() === normalized);
  if (matchedOption) {
    if (matchedOption.IsPassword || matchedOption.Sensitive) {
      return true;
    }
  }
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

export function maskRemoteConfig(
  rawConfig: Readonly<Record<string, unknown>>,
  providerOptions?: readonly RcloneProviderOption[],
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawConfig)) {
    if (key === 'type') {
      masked[key] = value;
      continue;
    }
    if (value !== undefined && value !== null && String(value) !== '' && isSensitiveRemoteField(key, providerOptions)) {
      masked[key] = SECRET_MASK;
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

export function mergeRemoteConfigForUpdate(
  existingConfig: Readonly<Record<string, unknown>>,
  incomingParams: Readonly<Record<string, unknown>>,
  providerOptions?: readonly RcloneProviderOption[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(incomingParams)) {
    if (key === 'type' || value === undefined) {
      continue;
    }
    // Omit untouched masked secrets so Rclone /config/update keeps existing values without double-obscuring passwords.
    if (value === SECRET_MASK && isSensitiveRemoteField(key, providerOptions)) {
      continue;
    }
    if (value === null || value === '') {
      if (Object.prototype.hasOwnProperty.call(existingConfig, key)) {
        patch[key] = '';
      }
      continue;
    }
    patch[key] = value;
  }

  return patch;
}

export function redactTextSecrets(message: string, secrets: readonly (string | null | undefined)[]): string {
  let result = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 3 && secret !== SECRET_MASK) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}
