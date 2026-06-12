/**
 * Unit tests for the Collection Introspector.
 *
 * These tests drive {@link introspect} with a hand-built fake `app` so no real
 * server boot is required. The stub exposes only the surface the introspector
 * reads: `db.getCollection(name)` for the default data source,
 * `dataSourceManager.dataSources.get(key)` for non-default data sources, and
 * `logger.warn` for failure logging. Each stub is typed with a small local
 * interface and cast to `Application` through `unknown` so the production
 * signature is exercised without resorting to `any`.
 */

import type { Application } from '@nocobase/server';
import { describe, expect, it, vi } from 'vitest';

import { introspect } from '../introspector';

/** Minimal shape of a field as read by the introspector. */
interface FakeField {
  name?: string;
  type?: string;
  options?: {
    interface?: string;
    uiSchema?: { title?: string } | null;
    target?: string;
  };
  isRelationField?: () => boolean;
}

/** Minimal shape of a collection as read by the introspector. */
interface FakeCollection {
  getFields: () => FakeField[];
}

/** Minimal data-source shape for the non-default introspection path. */
interface FakeDataSource {
  collectionManager: {
    getCollection: (name: string) => FakeCollection | undefined;
  };
}

/** Minimal `app` shape the introspector depends on. */
interface FakeApp {
  db: {
    getCollection: (name: string) => FakeCollection | undefined;
  };
  dataSourceManager: {
    dataSources: {
      get: (key: string) => FakeDataSource | undefined;
    };
  };
  logger: {
    warn: (message: string) => void;
  };
}

/** Build a plain field entry. */
function field(name: string, type: string, options: FakeField['options'] = {}): FakeField {
  return { name, type, options };
}

/** Build a relation field entry that reports itself via `isRelationField()`. */
function relationField(name: string, type: string, target: string): FakeField {
  return {
    name,
    type,
    options: { target },
    isRelationField: () => true,
  };
}

/** Build a collection whose `getFields()` returns the given fields. */
function collection(fields: FakeField[]): FakeCollection {
  return { getFields: () => fields };
}

/** Build a collection whose `getFields()` throws when read. */
function throwingCollection(message: string): FakeCollection {
  return {
    getFields: () => {
      throw new Error(message);
    },
  };
}

/**
 * Build a fake app whose default (`main`) data source resolves collections from
 * the provided map. `warn` is a spy so failure logging can be asserted.
 */
function makeApp(
  collections: Record<string, FakeCollection | undefined>,
  dataSources: Record<string, FakeDataSource | undefined> = {},
): { app: Application; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const fake: FakeApp = {
    db: {
      getCollection: (name: string) => collections[name],
    },
    dataSourceManager: {
      dataSources: {
        get: (key: string) => dataSources[key],
      },
    },
    logger: { warn },
  };
  return { app: fake as unknown as Application, warn };
}

describe('introspect', () => {
  it('collects field metadata for multiple collections and preserves requested order', async () => {
    const { app } = makeApp({
      posts: collection([
        field('id', 'bigInt', { interface: 'integer', uiSchema: { title: 'ID' } }),
        field('title', 'string', { interface: 'input', uiSchema: { title: 'Title' } }),
        // No interface and no uiSchema title → empty interface, title falls back to name.
        field('status', 'string', {}),
      ]),
      authors: collection([
        field('id', 'bigInt', { interface: 'integer' }),
        field('name', 'string', { interface: 'input', uiSchema: { title: 'Name' } }),
      ]),
    });

    // Request order is authors, posts — the result must follow it (Req 2.1).
    const summary = await introspect(app, {
      dataSource: 'main',
      collections: ['authors', 'posts'],
    });

    expect(summary.dataSource).toBe('main');
    expect(summary.collections.map((c) => c.name)).toEqual(['authors', 'posts']);

    const authors = summary.collections[0];
    expect(authors.introspectionFailed).toBeUndefined();
    expect(authors.fields).toEqual([
      { name: 'id', type: 'bigInt', interface: 'integer', title: 'id' },
      { name: 'name', type: 'string', interface: 'input', title: 'Name' },
    ]);

    const posts = summary.collections[1];
    expect(posts.fields).toEqual([
      { name: 'id', type: 'bigInt', interface: 'integer', title: 'ID' },
      { name: 'title', type: 'string', interface: 'input', title: 'Title' },
      // interface absent → recorded as empty string; title falls back to name.
      { name: 'status', type: 'string', interface: '', title: 'status' },
    ]);
  });

  it('includes relation fields with their type and target', async () => {
    const { app } = makeApp({
      posts: collection([
        field('id', 'bigInt', { interface: 'integer' }),
        relationField('author', 'belongsTo', 'authors'),
      ]),
    });

    const summary = await introspect(app, {
      dataSource: 'main',
      collections: ['posts'],
    });

    const posts = summary.collections[0];
    // The relation field still appears in fields (Req 2.1)...
    expect(posts.fields.map((f) => f.name)).toContain('author');
    // ...and is additionally recorded as a relation with type + target (Req 2.2).
    expect(posts.relations).toEqual([{ name: 'author', type: 'belongsTo', target: 'authors' }]);
  });

  it('records an empty field set without flagging introspection failure and continues', async () => {
    const { app, warn } = makeApp({
      empty: collection([]),
      posts: collection([field('id', 'bigInt', { interface: 'integer' })]),
    });

    const summary = await introspect(app, {
      dataSource: 'main',
      collections: ['empty', 'posts'],
    });

    const empty = summary.collections[0];
    // Empty is a valid, non-failing outcome (Req 2.4)...
    expect(empty.fields).toEqual([]);
    expect(empty.relations).toEqual([]);
    expect(empty.introspectionFailed).toBeUndefined();

    // ...and processing continues to the next collection (Req 2.5).
    expect(summary.collections[1].name).toBe('posts');
    expect(summary.collections[1].fields).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('isolates a metadata-read failure and processes the remaining collections', async () => {
    const { app, warn } = makeApp({
      broken: throwingCollection('boom'),
      posts: collection([field('id', 'bigInt', { interface: 'integer' })]),
    });

    const summary = await introspect(app, {
      dataSource: 'main',
      collections: ['broken', 'posts'],
    });

    const broken = summary.collections[0];
    // The failing collection is flagged and emptied (Req 2.6)...
    expect(broken.introspectionFailed).toBe(true);
    expect(broken.fields).toEqual([]);
    expect(broken.relations).toEqual([]);

    // ...a warning is logged...
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('broken');

    // ...and the remaining collection is still processed (Req 2.6).
    expect(summary.collections[1].name).toBe('posts');
    expect(summary.collections[1].introspectionFailed).toBeUndefined();
    expect(summary.collections[1].fields).toHaveLength(1);
  });

  it('flags an unresolved collection as introspection failed', async () => {
    const { app, warn } = makeApp({
      // `missing` is not present in the map → getCollection returns undefined.
      posts: collection([field('id', 'bigInt', { interface: 'integer' })]),
    });

    const summary = await introspect(app, {
      dataSource: 'main',
      collections: ['missing', 'posts'],
    });

    const missing = summary.collections[0];
    expect(missing.introspectionFailed).toBe(true);
    expect(missing.fields).toEqual([]);
    expect(missing.relations).toEqual([]);
    // An unresolved collection is not a thrown error, so nothing is logged.
    expect(warn).not.toHaveBeenCalled();

    expect(summary.collections[1].name).toBe('posts');
    expect(summary.collections[1].fields).toHaveLength(1);
  });

  it('resolves collections from a non-default data source via the data source manager', async () => {
    const external: FakeDataSource = {
      collectionManager: {
        getCollection: (name: string) =>
          name === 'orders'
            ? collection([
                field('id', 'bigInt', { interface: 'integer' }),
                field('total', 'double', { interface: 'number', uiSchema: { title: 'Total' } }),
              ])
            : undefined,
      },
    };
    const { app } = makeApp({}, { external });

    const summary = await introspect(app, {
      dataSource: 'external',
      collections: ['orders'],
    });

    expect(summary.dataSource).toBe('external');
    const orders = summary.collections[0];
    expect(orders.introspectionFailed).toBeUndefined();
    expect(orders.fields).toEqual([
      { name: 'id', type: 'bigInt', interface: 'integer', title: 'id' },
      { name: 'total', type: 'double', interface: 'number', title: 'Total' },
    ]);
  });
});
