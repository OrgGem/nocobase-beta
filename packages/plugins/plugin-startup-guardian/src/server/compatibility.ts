/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const VALIDATED_CORE_VERSION = '2.2.40';

const runtimeRequire = createRequire(join(process.cwd(), 'package.json'));

export async function readRuntimeCoreVersion(): Promise<string | null> {
  let manifestPath: string;
  try {
    manifestPath = runtimeRequire.resolve('@nocobase/server/package.json');
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const manifest = parsed as { name?: unknown; version?: unknown };
    return manifest.name === '@nocobase/server' && typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

export function isValidatedCoreVersion(version: string | null): boolean {
  return version === VALIDATED_CORE_VERSION;
}
