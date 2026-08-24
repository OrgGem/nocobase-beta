/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { S3Adapter } from '../adapters/s3-adapter';

class Command {
  constructor(public readonly input: unknown) {}
}

function createClient(handler: (command: Command) => unknown) {
  return {
    send: async (command: Command) => handler(command),
  };
}

const SDK = {
  HeadObjectCommand: class extends Command {},
  ListObjectsV2Command: class extends Command {},
  DeleteObjectCommand: class extends Command {},
  DeleteObjectsCommand: class extends Command {},
  CopyObjectCommand: class extends Command {},
};

describe('S3Adapter rename()', () => {
  it('encodes CopySource path segments while preserving "/" separators', async () => {
    const commands: Array<{ type: string; input: any }> = [];
    const client = createClient((command) => {
      const type = command.constructor.name;
      const input = (command as any).input;
      commands.push({ type, input });

      if (type === 'HeadObjectCommand') {
        return { ContentLength: 10, ContentType: 'text/plain' };
      }
      if (type === 'CopyObjectCommand') {
        return {};
      }
      if (type === 'DeleteObjectCommand') {
        return {};
      }
      throw new Error(`Unexpected command ${type}`);
    });
    const adapter = new S3Adapter({ client: client as any, bucket: 'bucket', sdk: SDK as any });

    await adapter.rename('/folder/a file+b.txt', '/folder/renamed.txt');

    const copy = commands.find((command) => command.type === 'CopyObjectCommand');
    expect(copy?.input).toEqual({
      Bucket: 'bucket',
      CopySource: 'bucket/folder/a%20file%2Bb.txt',
      Key: 'folder/renamed.txt',
    });
    expect(commands.some((command) => command.type === 'DeleteObjectCommand')).toBe(true);
  });

  it('copies each object in a directory and deletes the source objects in batches', async () => {
    const commands: Array<{ type: string; input: any }> = [];
    const client = createClient((command) => {
      const type = command.constructor.name;
      const input = (command as any).input;
      commands.push({ type, input });

      if (type === 'HeadObjectCommand') {
        throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      }
      if (type === 'ListObjectsV2Command') {
        return {
          Contents: [{ Key: 'old/sub/a.txt' }, { Key: 'old/sub/b.txt' }],
          NextContinuationToken: undefined,
        };
      }
      if (type === 'CopyObjectCommand' || type === 'DeleteObjectsCommand') {
        return {};
      }
      throw new Error(`Unexpected command ${type}`);
    });
    const adapter = new S3Adapter({ client: client as any, bucket: 'bucket', sdk: SDK as any });

    await adapter.rename('/old/sub', '/new/sub');

    const copies = commands.filter((command) => command.type === 'CopyObjectCommand');
    expect(copies.map((command) => command.input.CopySource)).toEqual(['bucket/old/sub/a.txt', 'bucket/old/sub/b.txt']);
    expect(copies.map((command) => command.input.Key)).toEqual(['new/sub/a.txt', 'new/sub/b.txt']);

    const deletes = commands.find((command) => command.type === 'DeleteObjectsCommand');
    expect(deletes?.input.Delete.Objects).toEqual([{ Key: 'old/sub/a.txt' }, { Key: 'old/sub/b.txt' }]);
  });

  it('does not delete source objects when a copy fails mid-directory-rename', async () => {
    const commands: Array<{ type: string; input: any }> = [];
    let copyCalls = 0;
    const client = createClient((command) => {
      const type = command.constructor.name;
      const input = (command as any).input;
      commands.push({ type, input });

      if (type === 'HeadObjectCommand') {
        throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      }
      if (type === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'old/a.txt' }, { Key: 'old/b.txt' }] };
      }
      if (type === 'CopyObjectCommand') {
        copyCalls += 1;
        if (copyCalls === 2) {
          throw new Error('copy failed');
        }
        return {};
      }
      if (type === 'DeleteObjectsCommand') {
        return {};
      }
      throw new Error(`Unexpected command ${type}`);
    });
    const adapter = new S3Adapter({ client: client as any, bucket: 'bucket', sdk: SDK as any });

    await expect(adapter.rename('/old', '/new')).rejects.toThrow('copy failed');
    expect(commands.some((command) => command.type === 'DeleteObjectsCommand')).toBe(false);
  });
});
