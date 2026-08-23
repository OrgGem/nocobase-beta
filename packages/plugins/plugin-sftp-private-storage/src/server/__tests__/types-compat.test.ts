/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';

// Canonical adapter contract owned by plugin-external-storage-manager.
import type {
  IStorageAdapter as ExternalIStorageAdapter,
  GetStreamResult as ExternalGetStreamResult,
  RangeOptions as ExternalRangeOptions,
} from '../../../../plugin-external-storage-manager/src/server/adapters/types';

import { SftpAdapter } from '../adapters/sftp-adapter';

/**
 * The SFTP plugin keeps a local copy of the adapter contract (it can run
 * without plugin-external-storage-manager installed). These tests pin the
 * local copy to the canonical contract so it cannot silently drift again.
 */
describe('adapter type compatibility with plugin-external-storage-manager', () => {
  it('SftpAdapter is structurally assignable to the external IStorageAdapter', () => {
    const manager = {
      listFiles: () => Promise.resolve([]),
      stat: () => Promise.resolve({}),
      exists: () => Promise.resolve(false),
      getFileStream: () => Promise.resolve(Readable.from([])),
      putFileStream: () => Promise.resolve(),
      mkdir: () => Promise.resolve(),
      deleteFile: () => Promise.resolve(),
      deleteDir: () => Promise.resolve(),
      rename: () => Promise.resolve(),
    };

    const adapter = new SftpAdapter(manager as never, 'config-id', '/base');

    // If getStream's return type or method signature falls out of sync, this
    // assignment fails at compile time.
    const externalTyped: ExternalIStorageAdapter = adapter;
    expect(externalTyped).toBe(adapter);
  });

  it('local GetStreamResult/RangeOptions shape matches the external contract', async () => {
    const range: ExternalRangeOptions = { start: 0, end: 99 };

    const manager = {
      listFiles: () => Promise.resolve([]),
      stat: () => Promise.resolve({ size: 1000, isFile: true, modifyTime: 0, isDirectory: false }),
      exists: () => Promise.resolve(false),
      getFileStream: () => Promise.resolve(Readable.from(['x'])),
      putFileStream: () => Promise.resolve(),
      mkdir: () => Promise.resolve(),
      deleteFile: () => Promise.resolve(),
      deleteDir: () => Promise.resolve(),
      rename: () => Promise.resolve(),
    };

    const adapter = new SftpAdapter(manager as never, 'config-id', '/base');
    const result: ExternalGetStreamResult = await adapter.getStream('/file.bin', range);
    expect(result.stream).toBeInstanceOf(Readable);
    expect(result.contentRange).toMatch(/^bytes \d+-\d+\/\d+$/);
  });
});
