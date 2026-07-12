/**
 * Schema info utility functions.
 *
 * Adapted from dbgate-tools/src/schemaInfoTools.ts (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 */

import type { SchemaInfo, SqlDialect } from '../types';

/**
 * Determine the default schema from a list of schemas.
 */
export function findDefaultSchema(
  schemaList: SchemaInfo[],
  dialect: SqlDialect,
  schemaInStorage: string | null = null,
): string | null {
  if (!schemaList) return null;

  if (schemaInStorage && schemaList.find((x) => x.schemaName === schemaInStorage)) {
    return schemaInStorage;
  }

  const dynamicDefaultSchema = schemaList.find((x) => x.isDefault);
  if (dynamicDefaultSchema) return dynamicDefaultSchema.schemaName;

  if (dialect?.defaultSchemaName && schemaList.find((x) => x.schemaName === dialect.defaultSchemaName)) {
    return dialect.defaultSchemaName;
  }

  return schemaList[0]?.schemaName || null;
}

export function isCompositeDbName(name: string): boolean {
  return name?.includes('::') || false;
}

export function splitCompositeDbName(name: string): { database: string; schema: string } | null {
  if (!isCompositeDbName(name)) return null;
  const [database, schema] = name.split('::');
  return { database, schema };
}

export function extractDbNameFromComposite(name: string): string {
  return isCompositeDbName(name) ? splitCompositeDbName(name)!.database : name;
}

export function extractSchemaNameFromComposite(name: string): string | undefined {
  return splitCompositeDbName(name)?.schema;
}
