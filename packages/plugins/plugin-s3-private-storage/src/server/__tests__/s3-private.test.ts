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
