import { DataTypes } from '@nocobase/database';
import { Migration } from '@nocobase/server';
import { QueryTypes, type TableName } from 'sequelize';

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const PREFLIGHT_BATCH_SIZE = 1_000;

interface LegacyUsageRow {
  recordId: string | number | bigint;
  userId: unknown;
}

interface InvalidUsageRow {
  recordId: string;
  userId: string;
}

interface InvalidUsageSummary {
  count: number;
  samples: InvalidUsageRow[];
}

function stringifyDatabaseValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return String(value);
}

export function normalizeLegacyUserId(value: unknown): string | undefined {
  let normalized: string;

  if (typeof value === 'string') {
    normalized = value.trim();
  } else if (typeof value === 'bigint') {
    normalized = value.toString();
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    normalized = String(value);
  } else {
    return undefined;
  }

  if (!/^\d+$/.test(normalized)) return undefined;

  const parsed = BigInt(normalized);
  if (parsed > MAX_SIGNED_BIGINT) return undefined;

  return normalized;
}

export function isBigIntColumnType(value: unknown): boolean {
  return typeof value === 'string' && value.toUpperCase().includes('BIGINT');
}

export function isLegacyStringColumnType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.toUpperCase();
  return normalized.includes('CHAR') || normalized.includes('TEXT');
}

export default class ChangeUsageUserIdToBigInt extends Migration {
  on = 'beforeLoad' as const;

  async up() {
    const { collection, temporary } = this.getUsageCollection();
    try {
      if (!(await collection.existsInDb())) return;

      const userIdField = collection.getField('userId');
      if (!userIdField) {
        throw new Error('AI API usage migration could not resolve the userId field.');
      }

      const tableName = collection.getTableNameWithSchema();
      const columnName = userIdField.columnName();
      const columns = await this.queryInterface.describeTable(tableName);
      const column = columns[columnName];
      if (!column) {
        throw new Error(`AI API usage migration could not find the physical column ${columnName}.`);
      }

      if (!isBigIntColumnType(column.type) && !isLegacyStringColumnType(column.type)) {
        throw new Error(`AI API usage migration does not support converting ${column.type} to BIGINT.`);
      }

      const invalidRows = await this.findInvalidRows(collection.quotedTableName(), columnName);
      if (invalidRows.count > 0) {
        const samples = invalidRows.samples.map((row) => `${row.recordId}:${JSON.stringify(row.userId)}`).join(', ');
        throw new Error(
          `AI API usage migration found ${invalidRows.count} invalid userId value(s). ` +
            `Clean these records before retrying the upgrade. Samples: ${samples}`,
        );
      }

      if (isBigIntColumnType(column.type)) {
        if (column.allowNull === false) return;
        await this.makeColumnNotNull(tableName, collection.quotedTableName(), columnName);
        return;
      }

      await this.changeColumnToBigInt(tableName, collection.quotedTableName(), columnName);
    } finally {
      if (temporary) this.db.removeCollection('aiApiUsageRecords');
    }
  }

  async down() {
    const { collection, temporary } = this.getUsageCollection();
    try {
      if (!(await collection.existsInDb())) return;

      const userIdField = collection.getField('userId');
      if (!userIdField) return;

      const tableName = collection.getTableNameWithSchema();
      const columnName = userIdField.columnName();
      const columns = await this.queryInterface.describeTable(tableName);
      if (!isBigIntColumnType(columns[columnName]?.type)) return;

      if (this.db.inDialect('postgres')) {
        const quotedColumn = this.db.quoteIdentifier(columnName);
        await this.sequelize.transaction(async (transaction) => {
          await this.sequelize.query(
            `ALTER TABLE ${collection.quotedTableName()} ` +
              `ALTER COLUMN ${quotedColumn} DROP NOT NULL, ` +
              `ALTER COLUMN ${quotedColumn} TYPE VARCHAR(255) USING ${quotedColumn}::text`,
            { transaction },
          );
        });
        return;
      }

      await this.queryInterface.changeColumn(tableName, columnName, {
        type: DataTypes.STRING,
        allowNull: true,
      });
    } finally {
      if (temporary) this.db.removeCollection('aiApiUsageRecords');
    }
  }

  private getUsageCollection() {
    const existing = this.db.getCollection('aiApiUsageRecords');
    if (existing) return { collection: existing, temporary: false };

    const collection = this.db.collection({
      name: 'aiApiUsageRecords',
      fields: [{ name: 'userId', type: 'string' }],
    });
    return { collection, temporary: true };
  }

  private async findInvalidRows(quotedTableName: string, columnName: string): Promise<InvalidUsageSummary> {
    const quotedId = this.db.quoteIdentifier('id');
    const quotedUserId = this.db.quoteIdentifier(columnName);
    const invalidRows: InvalidUsageSummary = { count: 0, samples: [] };
    let offset = 0;
    let hasMoreRows = true;

    while (hasMoreRows) {
      const rows = await this.sequelize.query<LegacyUsageRow>(
        `SELECT ${quotedId} AS ${this.db.quoteIdentifier('recordId')}, ` +
          `${quotedUserId} AS ${this.db.quoteIdentifier('userId')} ` +
          `FROM ${quotedTableName} ORDER BY ${quotedId} ASC LIMIT :limit OFFSET :offset`,
        {
          replacements: { limit: PREFLIGHT_BATCH_SIZE, offset },
          type: QueryTypes.SELECT,
        },
      );

      for (const row of rows) {
        if (normalizeLegacyUserId(row.userId) === undefined) {
          invalidRows.count += 1;
          if (invalidRows.samples.length < 20) {
            invalidRows.samples.push({
              recordId: stringifyDatabaseValue(row.recordId),
              userId: stringifyDatabaseValue(row.userId),
            });
          }
        }
      }

      hasMoreRows = rows.length === PREFLIGHT_BATCH_SIZE;
      offset += rows.length;
    }

    return invalidRows;
  }

  private async changeColumnToBigInt(tableName: TableName, quotedTableName: string, columnName: string) {
    if (this.db.inDialect('postgres')) {
      const quotedColumn = this.db.quoteIdentifier(columnName);
      await this.sequelize.transaction(async (transaction) => {
        await this.sequelize.query(
          `ALTER TABLE ${quotedTableName} ` +
            `ALTER COLUMN ${quotedColumn} TYPE BIGINT USING BTRIM(${quotedColumn})::BIGINT, ` +
            `ALTER COLUMN ${quotedColumn} SET NOT NULL`,
          { transaction },
        );
      });
      return;
    }

    await this.queryInterface.changeColumn(tableName, columnName, {
      type: DataTypes.BIGINT,
      allowNull: false,
    });
  }

  private async makeColumnNotNull(tableName: TableName, quotedTableName: string, columnName: string) {
    if (this.db.inDialect('postgres')) {
      const quotedColumn = this.db.quoteIdentifier(columnName);
      await this.sequelize.query(`ALTER TABLE ${quotedTableName} ALTER COLUMN ${quotedColumn} SET NOT NULL`);
      return;
    }

    await this.queryInterface.changeColumn(tableName, columnName, {
      type: DataTypes.BIGINT,
      allowNull: false,
    });
  }
}
