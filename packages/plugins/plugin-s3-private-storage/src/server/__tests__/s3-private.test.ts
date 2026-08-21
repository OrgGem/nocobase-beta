import { getPrivateS3StreamUrl } from '../storages/get-file-url';
import { assertStreamAuthenticated } from '../stream-auth';
import { S3Adapter } from '../adapters/s3-adapter';

interface ListRequest {
  Bucket: string;
  Prefix: string;
  Delimiter: string;
  MaxKeys: number;
  ContinuationToken?: string;
}

class ListObjectsV2Command {
  constructor(public readonly input: ListRequest) {}
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

describe('S3PrivateStorage', () => {
  it('builds stream urls for aiFiles records', () => {
    const file = {
      id: 7,
      constructor: {
        name: 'aiFiles',
      },
    };

    expect(getPrivateS3StreamUrl(file, true)).toBe(
      '/api/attachments:stream?filterByTk=7&mode=inline&collection=aiFiles',
    );
  });

  it('falls back to attachments for generic records', () => {
    const file = { id: 8 };

    expect(getPrivateS3StreamUrl(file, false)).toBe(
      '/api/attachments:stream?filterByTk=8&mode=attachment&collection=attachments',
    );
  });

  it('rejects stream requests before storage access when bearer auth has not populated currentUser', () => {
    const ctx = {
      state: {},
      throw(status: number, message: string) {
        throw new HttpError(status, message);
      },
    };

    expect(() => assertStreamAuthenticated(ctx)).toThrow(
      expect.objectContaining({
        status: 401,
        message: 'Unauthenticated',
      }),
    );
  });

  it('allows stream requests after auth middleware has populated currentUser', () => {
    const ctx = {
      state: {
        currentUser: {
          id: 1,
        },
      },
      throw(status: number, message: string) {
        throw new HttpError(status, message);
      },
    };

    expect(assertStreamAuthenticated(ctx)).toBe(true);
  });

  it('translates offset pagination into S3 continuation requests', async () => {
    const commands: ListObjectsV2Command[] = [];
    const responses = [
      {
        Contents: [
          { Key: 'a.txt', Size: 1 },
          { Key: 'b.txt', Size: 2 },
        ],
        IsTruncated: true,
        NextContinuationToken: 'after-b',
      },
      {
        Contents: [
          { Key: 'c.txt', Size: 3 },
          { Key: 'd.txt', Size: 4 },
        ],
        IsTruncated: true,
        NextContinuationToken: 'after-d',
      },
    ];
    const client = {
      send: async (command: ListObjectsV2Command) => {
        commands.push(command);
        const response = responses.shift();
        if (!response) {
          throw new Error('Unexpected S3 list request');
        }
        return response;
      },
    };
    const adapter = new S3Adapter({
      client,
      bucket: 'private-bucket',
      sdk: { ListObjectsV2Command },
    });

    const result = await adapter.list('/', { offset: 2, limit: 2 });

    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) {
      throw new Error('Expected an S3 ListResult');
    }

    expect(result.entries.map((entry) => entry.name)).toEqual(['c.txt', 'd.txt']);
    expect(result.nextContinuationToken).toBe('after-d');
    expect(result.hasMore).toBe(true);
    expect(commands.map((command) => command.input)).toEqual([
      {
        Bucket: 'private-bucket',
        Prefix: '',
        Delimiter: '/',
        MaxKeys: 2,
        ContinuationToken: undefined,
      },
      {
        Bucket: 'private-bucket',
        Prefix: '',
        Delimiter: '/',
        MaxKeys: 2,
        ContinuationToken: 'after-b',
      },
    ]);
  });
});

describe('S3PrivateStorage _removeFile', () => {
  it('deletes the object and calls back without error', async () => {
    const { default: S3PrivateStorage } = await import('../storages/s3-private');
    const sent: any[] = [];
    const storage = {
      options: { bucket: 'test-bucket' },
    } as any;

    // @ts-ignore - we only need make() behavior with a stubbed client
    const instance = new S3PrivateStorage(storage);
    // Replace the client with a mock that records DeleteObjectCommand sends
    (instance as any).client = {
      send: async (command: any) => {
        sent.push(command);
        return {};
      },
    };

    const engine = instance.make();
    const file = { key: 'dir/file.txt' };

    await new Promise<void>((resolve, reject) => {
      engine._removeFile({} as any, file, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect(sent.length).toBe(1);
    expect(sent[0].constructor.name).toBe('DeleteObjectCommand');
    expect(sent[0].input).toEqual({ Bucket: 'test-bucket', Key: 'dir/file.txt' });
  });

  it('calls back with error when delete fails', async () => {
    const { default: S3PrivateStorage } = await import('../storages/s3-private');
    const storage = {
      options: { bucket: 'test-bucket' },
    } as any;

    // @ts-ignore
    const instance = new S3PrivateStorage(storage);
    (instance as any).client = {
      send: async () => {
        throw new Error('boom');
      },
    };

    const engine = instance.make();
    const file = { key: 'dir/file.txt' };

    const err = await new Promise<any>((resolve) => {
      engine._removeFile({} as any, file, (e: any) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
  });
});
describe('S3PrivateStorage delete()', () => {
  it('batches records into a single DeleteObjectsCommand', async () => {
    const { default: S3PrivateStorage } = await import('../storages/s3-private');
    const sent: any[] = [];
    const storage = {
      options: { bucket: 'test-bucket' },
    } as any;

    // @ts-ignore
    const instance = new S3PrivateStorage(storage);
    (instance as any).client = {
      send: async (command: any) => {
        sent.push(command);
        return { Deleted: command.input.Delete.Objects };
      },
    };

    const records = [{ key: 'a.txt' }, { key: 'b.txt' }, { key: 'c.txt' }] as any;

    const [deletedCount, remaining] = await instance.delete(records);

    expect(sent.length).toBe(1);
    expect(sent[0].constructor.name).toBe('DeleteObjectsCommand');
    expect(sent[0].input.Delete.Objects).toEqual([{ Key: 'a.txt' }, { Key: 'b.txt' }, { Key: 'c.txt' }]);
    expect(sent[0].input.Delete.Quiet).toBe(true);
    expect(deletedCount).toBe(3);
    expect(remaining).toEqual([]);
  });

  it('chunks batches of more than 1000 keys', async () => {
    const { default: S3PrivateStorage } = await import('../storages/s3-private');
    const sent: any[] = [];
    const storage = {
      options: { bucket: 'test-bucket' },
    } as any;

    // @ts-ignore
    const instance = new S3PrivateStorage(storage);
    (instance as any).client = {
      send: async (command: any) => {
        sent.push(command);
        return { Deleted: command.input.Delete.Objects };
      },
    };

    const records = Array.from({ length: 2500 }, (_, i) => ({ key: `f${i}.txt` })) as any;
    const [deletedCount] = await instance.delete(records);

    expect(sent.length).toBe(3); // 1000 + 1000 + 500
    expect(deletedCount).toBe(2500);
  });

  it('throws when S3 reports delete errors', async () => {
    const { default: S3PrivateStorage } = await import('../storages/s3-private');
    const storage = {
      options: { bucket: 'test-bucket' },
    } as any;

    // @ts-ignore
    const instance = new S3PrivateStorage(storage);
    (instance as any).client = {
      send: async () => ({ Errors: [{ Key: 'a.txt', Code: 'AccessDenied' }] }),
    };

    await expect(instance.delete([{ key: 'a.txt' }] as any)).rejects.toThrow('Failed to delete 1 object');
  });
});

describe('S3Adapter list() offset with directory markers', () => {
  it('does not drift when a page contains a directory placeholder object', async () => {
    const { S3Adapter } = await import('../adapters/s3-adapter');
    const commands: any[] = [];
    const responses = [
      // Page 1: dir placeholder (Key === prefix) + 1 file + 1 dir prefix
      {
        Contents: [
          { Key: 'docs/', Size: 0 },
          { Key: 'docs/a.txt', Size: 1 },
        ],
        CommonPrefixes: [{ Prefix: 'docs/sub/' }],
        IsTruncated: true,
        NextContinuationToken: 'after-page-1',
      },
      // Page 2: the rest
      {
        Contents: [
          { Key: 'docs/b.txt', Size: 2 },
          { Key: 'docs/c.txt', Size: 3 },
        ],
        CommonPrefixes: [],
        IsTruncated: false,
        NextContinuationToken: undefined,
      },
    ];
    const client = {
      send: async (command: any) => {
        commands.push(command);
        const response = responses.shift();
        if (!response) throw new Error('Unexpected S3 list request');
        return response;
      },
    };
    const adapter = new S3Adapter({
      client,
      bucket: 'bucket',
      sdk: {
        ListObjectsV2Command: class {
          constructor(public input: any) {}
        },
      },
    });

    const result = await adapter.list('/docs/', { offset: 1, limit: 2 });

    // Page 1 walked past rawCount = 2 Contents + 1 CommonPrefix = 3 entries,
    // which is >= offset 1, so page 1 is consumed entirely and page 2 is used.
    expect(Array.isArray(result)).toBe(false);
    if (!Array.isArray(result)) {
      // Page 2 entries: b.txt, c.txt (dir placeholder docs/ was filtered by toFileEntries)
      expect(result.entries.map((e) => e.name)).toEqual(['b.txt', 'c.txt']);
    }
    expect(commands.length).toBe(2);
  });
});
