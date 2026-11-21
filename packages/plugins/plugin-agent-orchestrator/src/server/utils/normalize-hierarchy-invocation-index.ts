// SPDX-License-Identifier: Apache-2.0

import type { Database } from '@nocobase/database';

export function normalizeHierarchyInvocationIndex(database: Database) {
  if (!database.inDialect('postgres')) return;

  const collection = database.getCollection('agentHierarchyInvocations');
  const parentSessionField = collection.underscored ? 'parent_session_id' : 'parentSessionId';
  const parentToolCallField = collection.underscored ? 'parent_tool_call_id' : 'parentToolCallId';
  const index = collection.model.options.indexes?.find(
    (item) =>
      item.unique &&
      item.fields?.length === 2 &&
      item.fields[0] === parentSessionField &&
      item.fields[1] === parentToolCallField,
  );
  if (!index?.name || Buffer.byteLength(index.name, 'utf8') <= 63) return;

  // Sequelize 6 reuses these index option objects during sync. Match PostgreSQL's stored name, including the table prefix.
  let name = '';
  for (const character of index.name) {
    if (Buffer.byteLength(name + character, 'utf8') > 63) break;
    name += character;
  }
  index.name = name;
}
