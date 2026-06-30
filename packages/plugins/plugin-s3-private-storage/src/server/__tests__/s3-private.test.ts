import { getPrivateS3StreamUrl } from '../storages/get-file-url';
import { assertStreamAuthenticated } from '../stream-auth';

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
});
