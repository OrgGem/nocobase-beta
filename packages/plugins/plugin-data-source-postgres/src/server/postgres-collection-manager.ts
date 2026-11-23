/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CollectionOptions, SequelizeCollectionManager } from '@nocobase/data-source-manager';
import { cloneDeep } from 'lodash';
import { ColumnsDescription, QueryTypes, SyncOptions, Transaction } from 'sequelize';
import { createHash } from 'crypto';
import { PostgresValidationError } from './utils/validation-error';

interface FieldOptions {
  name: string;
  field?: string;
  type?: string;
  allowNull?: boolean;
  defaultValue?: unknown;
  unique?: boolean;
  autoIncrement?: boolean;
  primaryKey?: boolean;
  length?: number | string;
  precision?: number;
  scale?: number;
  elementType?: string;
}

interface UniqueIndex {
  indexName: string;
  constraintName: string | null;
  isValid?: boolean;
}

interface ForeignKeyOptions {
  foreignKey: string;
  targetKey: string;
  target: string;
  onDelete?: string;
  onUpdate?: string;
  defaultOnDelete?: string;
  replaceActions?: boolean;
}

export class PostgresCollectionManager extends SequelizeCollectionManager {
  defineCollection(options: CollectionOptions) {
    if (options.tree) {
      const { tree, ...rest } = options;
      return super.defineCollection({ ...rest, postgresTree: tree, template: options.template || 'tree' });
    }
    return super.defineCollection(options);
  }

  replaceCollections(collections: CollectionOptions[]): void {
    const snapshots: CollectionOptions[] = [];
    const added: string[] = [];
    try {
      for (const collection of collections) {
        const existing = this.getCollection(collection.name);
        if (existing) {
          snapshots.push(
            cloneDeep({
              ...existing.options,
              fields: existing.getFields().map((field) => field.options),
            }),
          );
          this.removeCollection(collection.name);
        } else {
          added.push(collection.name);
        }
        this.defineCollection(collection);
      }
    } catch (error) {
      for (const name of added) {
        if (this.hasCollection(name)) this.removeCollection(name);
      }
      for (const snapshot of snapshots.reverse()) {
        if (this.hasCollection(snapshot.name)) this.removeCollection(snapshot.name);
        try {
          this.defineCollection(snapshot);
        } catch {
          // Preserve the original defineCollection error if restoring the snapshot also fails.
        }
      }
      throw error;
    }
  }

  private quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private tableInfo(collectionName: string): { schema: string; tableName: string } {
    const collection = this.getCollection(collectionName);
    const modelTable = collection?.model?.getTableName();
    if (typeof modelTable === 'object' && modelTable) {
      return { schema: modelTable.schema || this.db.options.schema || 'public', tableName: modelTable.tableName };
    }
    return {
      schema: this.db.options.schema || 'public',
      tableName: typeof modelTable === 'string' ? modelTable : collectionName,
    };
  }

  private tableSql(collectionName: string): string {
    const { schema, tableName } = this.tableInfo(collectionName);
    return `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(tableName)}`;
  }

  private fieldType(collectionName: string, options: FieldOptions): string {
    const collection = this.getCollection(collectionName);
    if (!collection) throw new PostgresValidationError('Collection {{name}} does not exist', { name: collectionName });
    const field = this.db.buildField({ ...options }, { collection, database: this.db });
    if (field.isRelationField() || !field.dataType) {
      throw new PostgresValidationError('Field type {{type}} does not represent a PostgreSQL column', {
        type: options.type || '',
      });
    }
    const sequelizeField = field.toSequelize() as { type?: { toSql?: () => string; key?: string } };
    if (
      !sequelizeField.type ||
      sequelizeField.type.key === 'VIRTUAL' ||
      typeof sequelizeField.type.toSql !== 'function'
    ) {
      throw new PostgresValidationError('Field type {{type}} does not represent a PostgreSQL column', {
        type: options.type || '',
      });
    }
    const sqlType = sequelizeField.type.toSql();
    if (!sqlType || sqlType.toUpperCase() === 'VIRTUAL') {
      throw new PostgresValidationError('Field type {{type}} does not represent a PostgreSQL column', {
        type: options.type || '',
      });
    }
    return sqlType;
  }

  private async getColumnDataType(
    schema: string,
    tableName: string,
    columnName: string,
    transaction?: Transaction,
  ): Promise<string | undefined> {
    const columns = await this.db.sequelize.query<{ dataType: string }>(
      `SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS "dataType"
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = :schema AND c.relname = :tableName AND a.attname = :columnName
         AND a.attnum > 0 AND NOT a.attisdropped`,
      {
        replacements: { schema, tableName, columnName },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    return columns[0]?.dataType;
  }

  private async isColumnNotNull(
    schema: string,
    tableName: string,
    columnName: string,
    transaction?: Transaction,
  ): Promise<boolean> {
    const columns = await this.db.sequelize.query<{ notNull: boolean }>(
      `SELECT a.attnotnull AS "notNull"
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = :schema AND c.relname = :tableName AND a.attname = :columnName
         AND a.attnum > 0 AND NOT a.attisdropped`,
      {
        replacements: { schema, tableName, columnName },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    return columns[0]?.notNull === true;
  }

  private defaultSql(value: unknown): string {
    const literal =
      typeof value === 'object' && value !== null && !(value instanceof Date) ? JSON.stringify(value) : value;
    if (literal === null) return 'NULL';
    if (typeof literal === 'boolean') return literal ? 'TRUE' : 'FALSE';
    if (typeof literal === 'bigint') return String(literal);
    if (typeof literal === 'string' || typeof literal === 'number' || literal instanceof Date) {
      return this.db.sequelize.escape(literal);
    }
    throw new PostgresValidationError('Unsupported PostgreSQL default value');
  }

  async createTable(options: Record<string, unknown>, transaction?: Transaction): Promise<boolean> {
    if (!transaction) {
      return this.db.sequelize.transaction((externalTransaction) => this.createTable(options, externalTransaction));
    }
    const name = options.name;
    if (typeof name !== 'string' || !name) {
      throw new PostgresValidationError('Collection name is required');
    }
    const existing = this.getCollection(name);
    const table = existing
      ? this.tableInfo(name)
      : {
          schema: typeof options.schema === 'string' ? options.schema : this.db.options.schema || 'public',
          tableName: typeof options.tableName === 'string' ? options.tableName : name,
        };
    if (await this.getRelationKind(table.schema, table.tableName, transaction)) {
      return false;
    }
    const collection = existing || this.defineCollection({ ...options, name } as CollectionOptions);
    try {
      const syncOptions: SyncOptions & { transaction: Transaction } = { force: false, transaction };
      await collection.model.sync(syncOptions);
    } catch (error) {
      if (!existing && this.getCollection(name) === collection) this.removeCollection(name);
      throw error;
    }
    return true;
  }

  async dropTable(collectionName: string, cascade = false, transaction?: Transaction): Promise<void> {
    if (!transaction) {
      return this.db.sequelize.transaction((externalTransaction) =>
        this.dropTable(collectionName, cascade, externalTransaction),
      );
    }
    const kind = await this.getTableKind(collectionName, transaction);
    if (!kind) return;
    const object = kind === 'm' ? 'MATERIALIZED VIEW' : kind === 'v' ? 'VIEW' : 'TABLE';
    await this.db.sequelize.query(
      `DROP ${object} IF EXISTS ${this.tableSql(collectionName)} ${cascade ? 'CASCADE' : 'RESTRICT'}`,
      {
        transaction,
      },
    );
  }

  async getRelationKind(schema: string, tableName: string, transaction?: Transaction): Promise<string | undefined> {
    const rows = await this.db.sequelize.query<{ kind: string }>(
      `SELECT c.relkind AS kind FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = :schema AND c.relname = :tableName AND c.relkind IN ('r', 'p', 'v', 'm')`,
      { replacements: { schema, tableName }, type: QueryTypes.SELECT, transaction },
    );
    return rows[0]?.kind;
  }

  async getTableKind(collectionName: string, transaction?: Transaction): Promise<string | undefined> {
    const { schema, tableName } = this.tableInfo(collectionName);
    return this.getRelationKind(schema, tableName, transaction);
  }

  async hasZeroUserColumns(schema: string, tableName: string): Promise<boolean> {
    const rows = await this.db.sequelize.query<{ empty: boolean }>(
      `SELECT NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       ) AS empty
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = :schema AND c.relname = :tableName AND c.relkind IN ('r', 'p', 'v', 'm')`,
      { replacements: { schema, tableName }, type: QueryTypes.SELECT },
    );
    return rows[0]?.empty === true;
  }

  async describeMaterializedView(schema: string, tableName: string): Promise<ColumnsDescription | null> {
    const rows = await this.db.sequelize.query<{
      name: string;
      type: string;
      elementType: string | null;
      allowNull: boolean;
      comment: string | null;
    }>(
      `SELECT a.attname AS name,
              CASE
                WHEN t.typcategory = 'A' AND t.typelem <> 0 THEN 'ARRAY'
                ELSE UPPER(pg_catalog.format_type(
                  a.atttypid,
                  CASE WHEN t.typname IN ('varchar', 'bpchar', 'numeric') THEN a.atttypmod ELSE -1 END
                ))
              END AS type,
              CASE
                WHEN t.typcategory = 'A' AND t.typelem <> 0 THEN pg_catalog.format_type(t.typelem, -1)
                ELSE NULL
              END AS "elementType",
              NOT a.attnotnull AS "allowNull",
              pg_catalog.col_description(c.oid, a.attnum) AS comment
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
       WHERE n.nspname = :schema AND c.relname = :tableName AND c.relkind = 'm'
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      { replacements: { schema, tableName }, type: QueryTypes.SELECT },
    );
    if (!rows.length) return null;
    const description: ColumnsDescription = {};
    for (const row of rows) {
      const col: ColumnsDescription[string] & { elementType?: string } = {
        type: row.type,
        allowNull: row.allowNull,
        defaultValue: '',
        primaryKey: false,
        autoIncrement: false,
        comment: row.comment,
      };
      if (row.elementType) col.elementType = row.elementType;
      description[row.name] = col;
    }
    return description;
  }

  async getSingleColumnUniqueIndexes(
    schema: string,
    tableName: string,
  ): Promise<Array<{ column_name: string; is_single_column: boolean }>> {
    return this.db.sequelize.query<{ column_name: string; is_single_column: boolean }>(
      `SELECT a.attname AS column_name, TRUE AS is_single_column
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = tbl.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = i.indkey[0]
       WHERE n.nspname = :schema AND tbl.relname = :tableName
         AND i.indisunique AND NOT i.indisprimary AND i.indnkeyatts = 1 AND i.indpred IS NULL
         AND i.indisvalid AND i.indislive AND a.attnum > 0`,
      { replacements: { schema, tableName }, type: QueryTypes.SELECT },
    );
  }

  async getTableKinds(tableNames: string[], transaction?: Transaction): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!tableNames.length) return result;
    const schema = this.db.options.schema || 'public';
    const rows = await this.db.sequelize.query<{ tableName: string; kind: string }>(
      `SELECT c.relname AS "tableName", c.relkind AS kind
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = :schema AND c.relname IN (:tableNames) AND c.relkind IN ('r', 'p', 'v', 'm')`,
      { replacements: { schema, tableNames }, type: QueryTypes.SELECT, transaction },
    );
    for (const row of rows) {
      result.set(row.tableName, row.kind);
    }
    return result;
  }

  async discoverTables(): Promise<string[]> {
    const rows = await this.db.sequelize.query<{ name: string }>(
      `SELECT c.relname AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = :schema AND c.relkind IN ('r', 'p', 'v', 'm')
         AND (pg_catalog.has_table_privilege(c.oid, 'SELECT') OR pg_catalog.has_any_column_privilege(c.oid, 'SELECT'))
       ORDER BY c.relname`,
      { replacements: { schema: this.db.options.schema || 'public' }, type: QueryTypes.SELECT },
    );
    return rows.map((row) => row.name);
  }

  async discoverColumns(collectionName: string, transaction?: Transaction): Promise<Record<string, unknown>[]> {
    const { schema, tableName } = this.tableInfo(collectionName);
    return this.db.sequelize.query<Record<string, unknown>>(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              c.character_maximum_length, c.numeric_precision, c.numeric_scale,
              c.ordinal_position,
              EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage ku
                  ON ku.constraint_catalog = tc.constraint_catalog
                 AND ku.constraint_schema = tc.constraint_schema
                 AND ku.constraint_name = tc.constraint_name
                 AND ku.table_name = tc.table_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND ku.table_schema = c.table_schema AND ku.table_name = c.table_name
                  AND ku.column_name = c.column_name
              ) AS is_primary_key,
              (c.is_identity = 'YES' OR COALESCE(c.column_default LIKE 'nextval(%', false)) AS is_auto_increment
       FROM information_schema.columns c
       WHERE c.table_schema = :schema AND c.table_name = :tableName
       ORDER BY c.ordinal_position`,
      { replacements: { schema, tableName }, type: QueryTypes.SELECT, transaction },
    );
  }

  async addField(collectionName: string, field: FieldOptions, transaction?: Transaction): Promise<void> {
    if (!transaction) {
      return this.db.sequelize.transaction((externalTransaction) =>
        this.addField(collectionName, field, externalTransaction),
      );
    }
    if (!field.name || !field.type) {
      throw new PostgresValidationError('Field name and type are required');
    }
    const columnName = field.field || field.name;
    let sql = `ALTER TABLE ${this.tableSql(collectionName)} ADD COLUMN ${this.quoteIdentifier(
      columnName,
    )} ${this.fieldType(collectionName, field)}`;
    if (field.autoIncrement && field.defaultValue !== undefined) {
      throw new PostgresValidationError('A generated field cannot also have a default value');
    }
    if (field.autoIncrement) sql += ' GENERATED BY DEFAULT AS IDENTITY';
    if (field.allowNull === false) sql += ' NOT NULL';
    if (field.defaultValue !== undefined) sql += ` DEFAULT ${this.defaultSql(field.defaultValue)}`;
    if (field.primaryKey) sql += ' PRIMARY KEY';
    await this.db.sequelize.query(sql, { transaction });
    if (field.unique && !field.primaryKey) await this.setUnique(collectionName, columnName, true, transaction);
  }

  async updateField(
    collectionName: string,
    fieldName: string,
    options: Omit<FieldOptions, 'name'>,
    transaction?: Transaction,
  ): Promise<void> {
    if (!transaction) {
      return this.db.sequelize.transaction((externalTransaction) =>
        this.updateField(collectionName, fieldName, options, externalTransaction),
      );
    }
    const table = this.tableSql(collectionName);
    const columnName = this.getCollection(collectionName)?.getField(fieldName)?.columnName() || fieldName;
    const column = this.quoteIdentifier(columnName);
    if (['type', 'length', 'precision', 'scale', 'elementType'].some((key) => key in options)) {
      const existing = this.getCollection(collectionName)?.getField(fieldName)?.options || {};
      const type = this.fieldType(collectionName, { ...existing, ...options, name: fieldName });
      await this.db.sequelize.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type}`, {
        transaction,
      });
    }
    if (options.allowNull !== undefined) {
      await this.db.sequelize.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} ${options.allowNull ? 'DROP' : 'SET'} NOT NULL`,
        {
          transaction,
        },
      );
    }
    if (options.defaultValue !== undefined) {
      const clause =
        options.defaultValue === null ? 'DROP DEFAULT' : `SET DEFAULT ${this.defaultSql(options.defaultValue)}`;
      await this.db.sequelize.query(`ALTER TABLE ${table} ALTER COLUMN ${column} ${clause}`, { transaction });
    }
    if (options.unique !== undefined) {
      await this.setUnique(collectionName, columnName, options.unique, transaction);
    }
  }

  async removeField(
    collectionName: string,
    fieldName: string,
    cascade = false,
    transaction?: Transaction,
  ): Promise<void> {
    const columnName = this.getCollection(collectionName)?.getField(fieldName)?.columnName() || fieldName;
    await this.db.sequelize.query(
      `ALTER TABLE ${this.tableSql(collectionName)} DROP COLUMN ${this.quoteIdentifier(columnName)} ${
        cascade ? 'CASCADE' : 'RESTRICT'
      }`,
      { transaction },
    );
  }

  async ensureForeignKey(collectionName: string, options: ForeignKeyOptions, transaction?: Transaction): Promise<void> {
    if (!transaction) {
      return this.db.sequelize.transaction((externalTransaction) =>
        this.ensureForeignKey(collectionName, options, externalTransaction),
      );
    }
    const actions: Record<string, string> = {
      'NO ACTION': 'a',
      RESTRICT: 'r',
      CASCADE: 'c',
      'SET NULL': 'n',
      'SET DEFAULT': 'd',
    };
    const actionNames: Record<string, string> = {
      a: 'NO ACTION',
      r: 'RESTRICT',
      c: 'CASCADE',
      n: 'SET NULL',
      d: 'SET DEFAULT',
    };
    const defaultOnDelete = (options.defaultOnDelete || 'SET NULL').toUpperCase();
    let onDelete = (options.onDelete || defaultOnDelete).toUpperCase();
    let onUpdate = (options.onUpdate || 'CASCADE').toUpperCase();
    if (!actions[onDelete] || !actions[onUpdate])
      throw new PostgresValidationError('Invalid PostgreSQL foreign key action');
    const source = this.tableInfo(collectionName);
    const target = this.tableInfo(options.target);
    const sourceColumn =
      this.getCollection(collectionName)?.getField(options.foreignKey)?.columnName() || options.foreignKey;
    const targetColumn =
      this.getCollection(options.target)?.getField(options.targetKey)?.columnName() || options.targetKey;
    const sourceKind = await this.getRelationKind(source.schema, source.tableName, transaction);
    if (!sourceKind) {
      throw new PostgresValidationError('Collection {{name}} does not exist', { name: collectionName });
    }
    if (sourceKind === 'v' || sourceKind === 'm') {
      throw new PostgresValidationError('This collection is read-only');
    }
    const targetKind = await this.getRelationKind(target.schema, target.tableName, transaction);
    if (!targetKind) {
      throw new PostgresValidationError('Collection {{name}} does not exist', { name: options.target });
    }
    if (targetKind === 'v' || targetKind === 'm') {
      throw new PostgresValidationError('This collection is read-only');
    }
    const targetDataType = await this.getColumnDataType(target.schema, target.tableName, targetColumn, transaction);
    if (!targetDataType)
      throw new PostgresValidationError('Target column {{collection}}.{{field}} does not exist', {
        collection: options.target,
        field: options.targetKey,
      });
    const sourceColumnType = await this.getColumnDataType(source.schema, source.tableName, sourceColumn, transaction);
    if (!sourceColumnType) {
      await this.db.sequelize.query(
        `ALTER TABLE ${this.tableSql(collectionName)} ADD COLUMN ${this.quoteIdentifier(
          sourceColumn,
        )} ${targetDataType}`,
        { transaction },
      );
    }
    const constraints = await this.db.sequelize.query<{
      constraintName: string;
      targetSchema: string;
      targetTable: string;
      targetColumn: string;
      deleteAction: string;
      updateAction: string;
      columnCount: number;
    }>(
      `SELECT con.conname AS "constraintName",
              tn.nspname AS "targetSchema", t.relname AS "targetTable", ta.attname AS "targetColumn",
              con.confdeltype AS "deleteAction", con.confupdtype AS "updateAction",
              cardinality(con.conkey) AS "columnCount"
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class s ON s.oid = con.conrelid
       JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_catalog.pg_attribute sa ON sa.attrelid = s.oid AND sa.attnum = ANY(con.conkey)
       JOIN pg_catalog.pg_class t ON t.oid = con.confrelid
       JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_catalog.pg_attribute ta ON ta.attrelid = t.oid AND ta.attnum = con.confkey[array_position(con.conkey, sa.attnum)]
       WHERE con.contype = 'f' AND sn.nspname = :schema AND s.relname = :tableName AND sa.attname = :columnName`,
      {
        replacements: { schema: source.schema, tableName: source.tableName, columnName: sourceColumn },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (constraints.length) {
      const sameTarget =
        constraints.length === 1 &&
        constraints[0].columnCount === 1 &&
        constraints[0].targetSchema === target.schema &&
        constraints[0].targetTable === target.tableName &&
        constraints[0].targetColumn === targetColumn;
      const actionsMatch =
        (!options.onDelete || constraints[0].deleteAction === actions[onDelete]) &&
        (!options.onUpdate || constraints[0].updateAction === actions[onUpdate]);
      if (sameTarget && actionsMatch) {
        return;
      }
      if (sameTarget && options.replaceActions && constraints[0].constraintName) {
        onDelete = options.onDelete ? onDelete : actionNames[constraints[0].deleteAction] || onDelete;
        onUpdate = options.onUpdate ? onUpdate : actionNames[constraints[0].updateAction] || onUpdate;
        await this.db.sequelize.query(
          `ALTER TABLE ${this.tableSql(collectionName)} DROP CONSTRAINT ${this.quoteIdentifier(
            constraints[0].constraintName,
          )}`,
          { transaction },
        );
      } else {
        throw new PostgresValidationError('Conflicting foreign key exists for {{collection}}.{{field}}', {
          collection: collectionName,
          field: sourceColumn,
        });
      }
    }
    const hash = createHash('sha256')
      .update(
        `${source.schema}\0${source.tableName}\0${sourceColumn}\0${target.schema}\0${target.tableName}\0${targetColumn}`,
      )
      .digest('hex')
      .slice(0, 24);
    await this.db.sequelize.query(
      `ALTER TABLE ${this.tableSql(collectionName)} ADD CONSTRAINT ${this.quoteIdentifier(`fk_${hash}`)}
       FOREIGN KEY (${this.quoteIdentifier(sourceColumn)}) REFERENCES ${this.tableSql(
         options.target,
       )} (${this.quoteIdentifier(targetColumn)})
       ON DELETE ${onDelete} ON UPDATE ${onUpdate}`,
      { transaction },
    );
  }

  async ensureForeignKeyArray(
    collectionName: string,
    options: { foreignKey: string; targetKey: string; target: string },
    transaction?: Transaction,
  ): Promise<void> {
    if (!transaction) {
      return this.db.sequelize.transaction((externalTransaction) =>
        this.ensureForeignKeyArray(collectionName, options, externalTransaction),
      );
    }
    const source = this.tableInfo(collectionName);
    const target = this.tableInfo(options.target);
    const sourceColumn =
      this.getCollection(collectionName)?.getField(options.foreignKey)?.columnName() || options.foreignKey;
    const targetColumn =
      this.getCollection(options.target)?.getField(options.targetKey)?.columnName() || options.targetKey;
    const sourceKind = await this.getRelationKind(source.schema, source.tableName, transaction);
    if (!sourceKind) {
      throw new PostgresValidationError('Collection {{name}} does not exist', { name: collectionName });
    }
    if (sourceKind === 'v' || sourceKind === 'm') {
      throw new PostgresValidationError('This collection is read-only');
    }
    const targetKind = await this.getRelationKind(target.schema, target.tableName, transaction);
    if (!targetKind) {
      throw new PostgresValidationError('Collection {{name}} does not exist', { name: options.target });
    }
    const targetDataType = await this.getColumnDataType(target.schema, target.tableName, targetColumn, transaction);
    if (!targetDataType) {
      throw new PostgresValidationError('Target column {{collection}}.{{field}} does not exist', {
        collection: options.target,
        field: options.targetKey,
      });
    }
    const existingType = await this.getColumnDataType(source.schema, source.tableName, sourceColumn, transaction);
    if (!existingType) {
      await this.db.sequelize.query(
        `ALTER TABLE ${this.tableSql(collectionName)} ADD COLUMN ${this.quoteIdentifier(
          sourceColumn,
        )} ${targetDataType}[]`,
        { transaction },
      );
      return;
    }
    const stripModifiers = (value: string) =>
      value
        .trim()
        .toLowerCase()
        .replace(/\([^)]*\)/g, '');
    const normalizedExisting = stripModifiers(existingType);
    const normalizedExpected = `${stripModifiers(targetDataType)}[]`;
    if (normalizedExisting !== normalizedExpected && normalizedExisting !== 'json' && normalizedExisting !== 'jsonb') {
      throw new PostgresValidationError(
        'Foreign key {{collection}}.{{field}} has incompatible PostgreSQL type {{type}}',
        {
          collection: collectionName,
          field: sourceColumn,
          type: existingType,
        },
      );
    }
  }

  async ensureJoinTable(
    collectionName: string,
    options: {
      through: string;
      foreignKey: string;
      otherKey: string;
      sourceKey: string;
      targetKey: string;
      target: string;
      onDelete?: string;
      onUpdate?: string;
      replaceActions?: boolean;
    },
    transaction?: Transaction,
  ): Promise<void> {
    if (!transaction) {
      return this.db.sequelize.transaction((externalTransaction) =>
        this.ensureJoinTable(collectionName, options, externalTransaction),
      );
    }
    const source = this.tableInfo(collectionName);
    const target = this.tableInfo(options.target);
    const through = this.tableInfo(options.through);
    if (
      options.through === collectionName ||
      options.through === options.target ||
      (through.schema === source.schema && through.tableName === source.tableName) ||
      (through.schema === target.schema && through.tableName === target.tableName)
    ) {
      throw new PostgresValidationError('Join table {{name}} cannot match source or target collection', {
        name: options.through,
      });
    }
    if (options.foreignKey === options.otherKey) {
      throw new PostgresValidationError('Many-to-many foreign key and other key must be different');
    }
    const sourceColumn =
      this.getCollection(collectionName)?.getField(options.sourceKey)?.columnName() || options.sourceKey;
    const targetColumn =
      this.getCollection(options.target)?.getField(options.targetKey)?.columnName() || options.targetKey;
    const sourceDataType = await this.getColumnDataType(source.schema, source.tableName, sourceColumn, transaction);
    if (!sourceDataType) {
      throw new PostgresValidationError('Target column {{collection}}.{{field}} does not exist', {
        collection: collectionName,
        field: options.sourceKey,
      });
    }
    const targetDataType = await this.getColumnDataType(target.schema, target.tableName, targetColumn, transaction);
    if (!targetDataType) {
      throw new PostgresValidationError('Target column {{collection}}.{{field}} does not exist', {
        collection: options.target,
        field: options.targetKey,
      });
    }
    const throughKind = await this.getRelationKind(through.schema, through.tableName, transaction);
    if (throughKind === 'v' || throughKind === 'm') {
      throw new PostgresValidationError('This collection is read-only');
    }
    const requestedDelete = options.onDelete?.toUpperCase();
    const requestedUpdate = options.onUpdate?.toUpperCase();
    const usesNullOrDefault = (action?: string) => action === 'SET NULL' || action === 'SET DEFAULT';
    if (usesNullOrDefault(requestedDelete) || usesNullOrDefault(requestedUpdate)) {
      if (
        !throughKind ||
        (await this.isColumnNotNull(through.schema, through.tableName, options.foreignKey, transaction)) ||
        (await this.isColumnNotNull(through.schema, through.tableName, options.otherKey, transaction))
      ) {
        throw new PostgresValidationError('Invalid PostgreSQL foreign key action');
      }
    }
    if (!throughKind) {
      const throughSql = `${this.quoteIdentifier(through.schema)}.${this.quoteIdentifier(through.tableName)}`;
      const fkSql = this.quoteIdentifier(options.foreignKey);
      const okSql = this.quoteIdentifier(options.otherKey);
      await this.db.sequelize.query(
        `CREATE TABLE ${throughSql} (${fkSql} ${sourceDataType} NOT NULL, ${okSql} ${targetDataType} NOT NULL, PRIMARY KEY (${fkSql}, ${okSql}))`,
        { transaction },
      );
      const indexHash = createHash('sha256')
        .update(`${through.schema}\0${through.tableName}\0${options.otherKey}`)
        .digest('hex')
        .slice(0, 24);
      await this.db.sequelize.query(
        `CREATE INDEX ${this.quoteIdentifier(`idx_${indexHash}`)} ON ${throughSql} (${okSql})`,
        { transaction },
      );
    }
    await this.ensureForeignKey(
      options.through,
      {
        foreignKey: options.foreignKey,
        targetKey: options.sourceKey,
        target: collectionName,
        onDelete: options.onDelete,
        onUpdate: options.onUpdate,
        defaultOnDelete: 'CASCADE',
        replaceActions: options.replaceActions,
      },
      transaction,
    );
    await this.ensureForeignKey(
      options.through,
      {
        foreignKey: options.otherKey,
        targetKey: options.targetKey,
        target: options.target,
        onDelete: options.onDelete,
        onUpdate: options.onUpdate,
        defaultOnDelete: 'CASCADE',
        replaceActions: options.replaceActions,
      },
      transaction,
    );
  }

  private async setUnique(
    collectionName: string,
    columnName: string,
    unique: boolean,
    transaction?: Transaction,
  ): Promise<void> {
    const { schema, tableName } = this.tableInfo(collectionName);
    const indexes = await this.db.sequelize.query<UniqueIndex>(
      `SELECT idx.relname AS "indexName", con.conname AS "constraintName", i.indisvalid AS "isValid"
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = tbl.relnamespace
       JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
       JOIN pg_catalog.pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = i.indkey[0]
       LEFT JOIN pg_catalog.pg_constraint con ON con.conindid = i.indexrelid AND con.contype = 'u'
       WHERE n.nspname = :schema AND tbl.relname = :tableName AND a.attname = :columnName
         AND i.indisunique AND NOT i.indisprimary AND i.indnkeyatts = 1 AND i.indpred IS NULL AND a.attnum > 0`,
      { replacements: { schema, tableName, columnName }, type: QueryTypes.SELECT, transaction },
    );
    const dropEntry = async (index: UniqueIndex) => {
      const sql = index.constraintName
        ? `ALTER TABLE ${this.tableSql(collectionName)} DROP CONSTRAINT ${this.quoteIdentifier(index.constraintName)}`
        : `DROP INDEX ${this.quoteIdentifier(schema)}.${this.quoteIdentifier(index.indexName)}`;
      await this.db.sequelize.query(sql, { transaction });
    };
    if (unique) {
      const validIndexes = indexes.filter((index) => index.isValid !== false);
      for (const invalidIndex of indexes.filter((index) => index.isValid === false)) {
        await dropEntry(invalidIndex);
      }
      if (validIndexes.length === 0) {
        const hash = createHash('sha256').update(`${schema}\0${tableName}\0${columnName}`).digest('hex').slice(0, 24);
        await this.db.sequelize.query(
          `CREATE UNIQUE INDEX ${this.quoteIdentifier(`idx_unique_${hash}`)} ON ${this.tableSql(
            collectionName,
          )} (${this.quoteIdentifier(columnName)})`,
          { transaction },
        );
      }
    } else {
      for (const index of indexes) {
        await dropEntry(index);
      }
    }
  }

  // Collections are introspected. DDL is performed only by explicit collection/field actions.
  async sync(): Promise<void> {}
}
