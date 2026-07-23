import type { Context } from '@nocobase/actions';
import { graphCursorPath, hasRetryAuthentication } from '../plugin';

const context = (headers: Record<string, string>, currentUser?: { id: number }) =>
  ({ request: { headers }, state: { currentUser } }) as unknown as Context;

describe('Microsoft Graph gateway security helpers', () => {
  it('requires either an API key or an authenticated NocoBase user for retry', () => {
    expect(hasRetryAuthentication(context({}))).toBe(false);
    expect(hasRetryAuthentication(context({ 'x-api-key': 'mgk_test' }))).toBe(true);
    expect(hasRetryAuthentication(context({}, { id: 1 }))).toBe(true);
  });

  it('accepts a Microsoft Graph nextLink for the original resource', () => {
    expect(
      graphCursorPath(
        'https://graph.microsoft.com/v1.0/users/user%40example.com/messages?$skiptoken=abc',
        '/users/user%40example.com/messages',
      ),
    ).toBe('/users/user%40example.com/messages?$skiptoken=abc');
  });

  it('rejects cursors that change resource or host', () => {
    expect(() =>
      graphCursorPath('https://graph.microsoft.com/v1.0/drives/secret/root/children', '/users/user/messages'),
    ).toThrow('Invalid pagination cursor');
    expect(() => graphCursorPath('https://attacker.example/v1.0/users/user/messages', '/users/user/messages')).toThrow(
      'Invalid pagination cursor',
    );
  });
});
