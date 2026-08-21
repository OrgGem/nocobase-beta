import { PluginS3PrivateStorageServer } from '../plugin';

/**
 * Minimal ACL mock that can answer can() queries.
 */
function createACL(permissions: Record<string, string[]> = {}) {
  return {
    can: ({ resource, action, roles }: { resource: string; action: string; roles: string[] }) => {
      const allowed = permissions[`${resource}:${action}`];
      if (!allowed) return null;
      const hasRole = roles.some((r) => allowed.includes(r));
      if (!hasRole) return null;
      return { resource, action, params: {} };
    },
    allow: () => {},
  };
}

describe('checkParentCollectionAccess', () => {
  it('returns false when no parent collection references the attachment', async () => {
    const app: any = {
      pm: { get: () => ({ registerStorageType: () => {} }) },
      resourceManager: { registerActionHandler: () => {}, getResource: () => null },
      acl: createACL({ 'posts:view': ['member'] }),
      on: () => {},
      environment: null,
      log: {
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
      },
      context: { reqId: 'test' },
      db: {
        collections: new Map([
          [
            'posts',
            {
              name: 'posts',
              fields: new Map([
                [
                  'attachments',
                  {
                    type: 'belongsToMany',
                    options: {
                      target: 'attachments',
                      through: 'posts_attachments',
                      otherKey: 'attachmentId',
                      foreignKey: 'postId',
                    },
                  },
                ],
              ]),
              model: { name: 'Post', primaryKeyAttribute: 'id' },
            },
          ],
        ]),
        getCollection: (name: string) => {
          const col = app.db.collections.get(name);
          return col
            ? {
                ...col,
                repository: {
                  find: async () => [],
                  count: async () => 0,
                },
              }
            : null;
        },
      },
    };

    const plugin = new PluginS3PrivateStorageServer(app, {
      name: 'plugin-s3-private-storage',
      packageName: 'plugin-s3-private-storage',
    });

    const result = await (plugin as any).checkParentCollectionAccess('999', 'attachments', ['member']);
    expect(result).toBe(false);
  });

  it('returns true when the attachment is referenced in an accessible parent', async () => {
    const app: any = {
      pm: { get: () => ({ registerStorageType: () => {} }) },
      resourceManager: { registerActionHandler: () => {}, getResource: () => null },
      acl: createACL({ 'posts:view': ['member'] }),
      on: () => {},
      environment: null,
      log: {
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
      },
      context: { reqId: 'test' },
      db: {
        collections: new Map([
          [
            'posts',
            {
              name: 'posts',
              fields: new Map([
                [
                  'attachments',
                  {
                    type: 'belongsToMany',
                    options: {
                      target: 'attachments',
                      through: 'posts_attachments',
                      otherKey: 'attachmentId',
                      foreignKey: 'postId',
                    },
                  },
                ],
              ]),
              model: { name: 'Post', primaryKeyAttribute: 'id' },
            },
          ],
        ]),
        getCollection: (name: string) => {
          if (name === 'posts_attachments') {
            return {
              name: 'posts_attachments',
              model: { name: 'PostsAttachments', primaryKeyAttribute: 'id' },
              repository: {
                find: async () => [{ get: (k: string) => (k === 'postId' ? 42 : undefined) }],
                count: async () => 1,
              },
            };
          }
          const col = app.db.collections.get(name);
          if (!col) return null;
          return {
            ...col,
            repository: {
              find: async () => [],
              count: async () => 1,
            },
          };
        },
      },
    };

    const plugin = new PluginS3PrivateStorageServer(app, {
      name: 'plugin-s3-private-storage',
      packageName: 'plugin-s3-private-storage',
    });

    const result = await (plugin as any).checkParentCollectionAccess('1', 'attachments', ['member']);

    expect(result).toBe(true);
  });

  it('returns false when the user has no view permission on the parent', async () => {
    const app: any = {
      pm: { get: () => ({ registerStorageType: () => {} }) },
      resourceManager: { registerActionHandler: () => {}, getResource: () => null },
      acl: createACL({}),
      on: () => {},
      environment: null,
      log: {
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
      },
      context: { reqId: 'test' },
      db: {
        collections: new Map([
          [
            'posts',
            {
              name: 'posts',
              fields: new Map([
                [
                  'attachments',
                  {
                    type: 'belongsToMany',
                    options: {
                      target: 'attachments',
                      through: 'posts_attachments',
                      otherKey: 'attachmentId',
                      foreignKey: 'postId',
                    },
                  },
                ],
              ]),
              model: { name: 'Post', primaryKeyAttribute: 'id' },
            },
          ],
        ]),
        getCollection: () => null,
      },
    };

    const plugin = new PluginS3PrivateStorageServer(app, {
      name: 'plugin-s3-private-storage',
      packageName: 'plugin-s3-private-storage',
    });

    const result = await (plugin as any).checkParentCollectionAccess('1', 'attachments', ['guest']);
    expect(result).toBe(false);
  });

  it('falls back to attachments view permission when no parent collection exists', async () => {
    const app: any = {
      pm: { get: () => ({ registerStorageType: () => {} }) },
      resourceManager: { registerActionHandler: () => {}, getResource: () => null },
      acl: createACL({ 'attachments:view': ['member'] }),
      on: () => {},
      environment: null,
      log: {
        child: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
      },
      context: { reqId: 'test' },
      db: {
        collections: new Map(),
        getCollection: () => null,
      },
    };

    const plugin = new PluginS3PrivateStorageServer(app, {
      name: 'plugin-s3-private-storage',
      packageName: 'plugin-s3-private-storage',
    });

    const result = await (plugin as any).checkParentCollectionAccess('1', 'attachments', ['member']);

    expect(result).toBe(true);
  });
});
