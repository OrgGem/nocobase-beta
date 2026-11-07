/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface LockIdentity {
  appId: string;
  deploymentId: string;
}

interface LockContents extends LockIdentity {
  token: string;
  pid: number;
  createdAt: string;
}

export interface LocalLock {
  release(): Promise<void>;
}

export async function acquireLocalLock(
  stateDirectory: string,
  fileName: 'runner-owner.lock' | 'state-write.lock' | 'policy-write.lock',
  identity: LockIdentity,
): Promise<LocalLock> {
  const directory = resolve(stateDirectory);
  const lockPath = join(directory, fileName);
  await mkdir(directory, { recursive: true });
  const contents: LockContents = {
    ...identity,
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(contents));
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle) await rm(lockPath, { force: true });
    if (isAlreadyExists(error)) {
      throw new Error(`Startup Guardian ${fileName} is already held; inspect its owner and do not remove it blindly`);
    }
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      const current = await readFile(lockPath, 'utf8');
      let currentContents: unknown;
      try {
        currentContents = JSON.parse(current);
      } catch {
        throw new Error(`Startup Guardian ${fileName} owner record was changed; refusing to remove it`);
      }
      if (!isLockContents(currentContents) || currentContents.token !== contents.token) {
        throw new Error(`Startup Guardian ${fileName} owner record no longer belongs to this process`);
      }
      await handle?.close();
      await rm(lockPath);
      released = true;
    },
  };
}

export async function withLocalLock<T>(
  stateDirectory: string,
  fileName: 'state-write.lock' | 'policy-write.lock',
  identity: LockIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLocalLock(stateDirectory, fileName, identity);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

export function getProcessLockIdentity(): LockIdentity {
  return {
    appId: process.env.STARTUP_GUARDIAN_APP_ID || process.env.APP_NAME || 'main',
    deploymentId: process.env.STARTUP_GUARDIAN_DEPLOYMENT_ID || 'single-node',
  };
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isLockContents(value: unknown): value is LockContents {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<LockContents>;
  return (
    typeof record.token === 'string' &&
    typeof record.pid === 'number' &&
    typeof record.createdAt === 'string' &&
    typeof record.appId === 'string' &&
    typeof record.deploymentId === 'string'
  );
}
