// SPDX-License-Identifier: Apache-2.0

import type { Database } from '@nocobase/database';
import { describe, expect, it } from 'vitest';
import { normalizeHierarchyInvocationIndex } from '../utils/normalize-hierarchy-invocation-index';

type TestIndex = {
  name: string;
  unique: boolean;
  fields: string[];
};

type TestCollection = {
  underscored: boolean;
  model: {
    options: { indexes: TestIndex[] };
    _indexes: TestIndex[];
  };
};

function createDatabase(collection: TestCollection, dialect = 'postgres') {
  return {
    inDialect: (value: string) => value === dialect,
    getCollection: () => collection,
  } as unknown as Database;
}

function createCollection(name: string, fields: string[], underscored = false): TestCollection {
  const index = { name, unique: true, fields };
  return {
    underscored,
    model: {
      options: { indexes: [index] },
      _indexes: [index],
    },
  };
}

describe('hierarchy invocation PostgreSQL index naming', () => {
  it('keeps the stored 63-byte name on both Sequelize index lists', () => {
    const fullName = 'agent_hierarchy_invocations_parent_session_id_parent_tool_call_id';
    const collection = createCollection(fullName, ['parentSessionId', 'parentToolCallId']);

    normalizeHierarchyInvocationIndex(createDatabase(collection));

    const storedName = fullName.slice(0, 63);
    expect(Buffer.byteLength(storedName, 'utf8')).toBe(63);
    expect(collection.model.options.indexes[0].name).toBe(storedName);
    expect(collection.model._indexes[0].name).toBe(storedName);
  });

  it('recognizes underscored fields and preserves a table prefix within the PostgreSQL limit', () => {
    const fullName = 'tenant_123456_agent_hierarchy_invocations_parent_session_id_parent_tool_call_id';
    const collection = createCollection(fullName, ['parent_session_id', 'parent_tool_call_id'], true);

    normalizeHierarchyInvocationIndex(createDatabase(collection));

    const storedName = collection.model.options.indexes[0].name;
    expect(storedName).toBe(fullName.slice(0, 63));
    expect(storedName.startsWith('tenant_123456_')).toBe(true);
    expect(Buffer.byteLength(storedName, 'utf8')).toBe(63);
  });

  it('leaves other database dialects unchanged', () => {
    const fullName = 'agent_hierarchy_invocations_parent_session_id_parent_tool_call_id';
    const collection = createCollection(fullName, ['parentSessionId', 'parentToolCallId']);

    normalizeHierarchyInvocationIndex(createDatabase(collection, 'sqlite'));

    expect(collection.model.options.indexes[0].name).toBe(fullName);
  });
});
