// SPDX-License-Identifier: Apache-2.0

export interface EnvironmentPermissionContext {
  can?: (args: { resource: string; action: string }) => { params?: Record<string, unknown> } | null;
}

export class SftpgoEnvironmentPermissionError extends Error {
  readonly status = 403;
  readonly expose = true;

  constructor() {
    super('Permission denied');
    this.name = 'SftpgoEnvironmentPermissionError';
  }
}

export function hasEnvironmentPermission(context?: EnvironmentPermissionContext): boolean {
  const permission = context?.can?.({ resource: 'environmentVariables', action: 'update' });
  return !!permission && Object.keys(permission.params || {}).length === 0;
}
