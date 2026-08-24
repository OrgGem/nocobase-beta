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

const SDK = {
  ListObjectsV2Command: class extends Command {},
};

describe('S3Adapter recursive search', () => {
  it('lists without a delimiter so nested files and directories are reachable', async () => {
    const commands: any[] = [];
    const client = {
      send: async (command: any) => {
        commands.push(command.input);
        return {
          Contents: [
            { Key: 'docs/a.txt', Size: 1 },
            { Key: 'docs/reports/Q3/', Size: 0 },
            { Key: 'docs/reports/Q3/b.txt', Size: 5 },
          ],
          NextContinuationToken: undefined,
        };
      },
    };
    const adapter = new S3Adapter({ client: client as any, bucket: 'bucket', sdk: SDK as any });

    const result = await adapter.list('/docs/', { search: 'Q3' });

    expect(Array.isArray(result)).toBe(true);
    expect(commands[0]).toMatchObject({ Prefix: 'docs/', MaxKeys: 1000 });
    expect(commands[0].Delimiter).toBeUndefined();

    const entries = result as any[];
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'a.txt', type: 'file', path: '/docs/a.txt' }),
        expect.objectContaining({ name: 'Q3', type: 'directory', path: '/docs/reports/Q3' }),
        expect.objectContaining({ name: 'b.txt', type: 'file', path: '/docs/reports/Q3/b.txt' }),
      ]),
    );
  });

  it('skips the directory placeholder object that has the same key as the prefix', async () => {
    const client = {
      send: async () => ({
        Contents: [
          { Key: 'docs/', Size: 0 },
          { Key: 'docs/a.txt', Size: 1 },
        ],
        NextContinuationToken: undefined,
      }),
    };
    const adapter = new S3Adapter({ client: client as any, bucket: 'bucket', sdk: SDK as any });

    const result = await adapter.list('/docs/', { search: 'a' });

    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).map((entry) => entry.name)).toEqual(['a.txt']);
  });
});
