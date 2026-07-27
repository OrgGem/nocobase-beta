import { DataTypes, type Database } from '@nocobase/database';
import type { MigrationContext } from '@nocobase/database';
import { describe, expect, it, vi } from 'vitest';
import ChangeUsageUserIdToBigInt, {
  isBigIntColumnType,
  normalizeLegacyUserId,
} from '../migrations/20260727140000-change-usage-user-id-to-bigint';

interface HarnessOptions {
  allowNull?: boolean;
  collectionExists?: boolean;
  collectionRegistered?: boolean;
  columnType?: string;
  dialect?: 'mysql' | 'postgres' | 'sqlite';
  rows?: Array<{ recordId: string | number; userId: unknown }>;
}

function createHarness(options: HarnessOptions = {}) {
  const rows = options.rows ?? [];
  const dialect = options.dialect ?? 'sqlite';
  const changeColumn = vi.fn().mockResolvedValue(undefined);
  const describeTable = vi.fn().mockResolvedValue({
    userId: {
      type: options.columnType ?? 'VARCHAR(255)',
      allowNull: options.allowNull ?? true,
    },
  });
  const queryInterface = { changeColumn, describeTable };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT')) return rows;
    return undefined;
  });
  const transaction = vi.fn(async (callback: (value: object) => Promise<void>) => callback({}));
  const collection = {
    existsInDb: vi.fn().mockResolvedValue(options.collectionExists ?? true),
    getField: vi.fn().mockReturnValue({ columnName: () => 'userId' }),
    getTableNameWithSchema: () => 'aiApiUsageRecords',
    quotedTableName: () => '"aiApiUsageRecords"',
  };
  const registerCollection = vi.fn().mockReturnValue(collection);
  const removeCollection = vi.fn();
  const db = {
    collection: registerCollection,
    getCollection: vi.fn().mockReturnValue(options.collectionRegistered ? collection : undefined),
    inDialect: (...dialects: string[]) => dialects.includes(dialect),
    quoteIdentifier: (identifier: string) => `"${identifier}"`,
    removeCollection,
    sequelize: {
      getQueryInterface: () => queryInterface,
      query,
      transaction,
    },
  };
  const migration = new ChangeUsageUserIdToBigInt({
    db: db as unknown as Database,
    queryInterface,
    sequelize: db.sequelize,
  } as unknown as MigrationContext);

  return {
    changeColumn,
    collection,
    describeTable,
    migration,
    query,
    registerCollection,
    removeCollection,
    transaction,
  };
}

describe('AI API usage userId BIGINT migration', () => {
  it('accepts numeric strings without converting them through JavaScript Number', () => {
    expect(normalizeLegacyUserId('42')).toBe('42');
    expect(normalizeLegacyUserId(' 00042 ')).toBe('00042');
    expect(normalizeLegacyUserId('9007199254740993')).toBe('9007199254740993');
    expect(normalizeLegacyUserId('9223372036854775808')).toBeUndefined();
    expect(normalizeLegacyUserId('undefined')).toBeUndefined();
    expect(normalizeLegacyUserId('')).toBeUndefined();
  });

  it('changes a valid legacy column to a non-null BIGINT', async () => {
    const harness = createHarness({
      dialect: 'mysql',
      rows: [
        { recordId: 1, userId: '42' },
        { recordId: 2, userId: '0007' },
        { recordId: 3, userId: '9007199254740993' },
      ],
    });

    await harness.migration.up();

    expect(harness.changeColumn).toHaveBeenCalledWith('aiApiUsageRecords', 'userId', {
      type: DataTypes.BIGINT,
      allowNull: false,
    });
    expect(harness.query).toHaveBeenCalledTimes(1);
    expect(String(harness.query.mock.calls[0][0])).toContain('SELECT');
    expect(harness.registerCollection).toHaveBeenCalledOnce();
    expect(harness.removeCollection).toHaveBeenCalledWith('aiApiUsageRecords');
  });

  it('uses an explicit PostgreSQL USING cast inside a transaction', async () => {
    const harness = createHarness({ dialect: 'postgres', rows: [{ recordId: 1, userId: '42' }] });

    await harness.migration.up();

    const ddl = harness.query.mock.calls.find(([sql]) => String(sql).startsWith('ALTER TABLE'))?.[0];
    expect(String(ddl)).toContain('TYPE BIGINT USING BTRIM("userId")::BIGINT');
    expect(String(ddl)).toContain('SET NOT NULL');
    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.changeColumn).not.toHaveBeenCalled();
  });

  it('rejects invalid values before running any DDL', async () => {
    const harness = createHarness({
      dialect: 'postgres',
      rows: [
        { recordId: 4, userId: 'undefined' },
        { recordId: 5, userId: '' },
      ],
    });

    await expect(harness.migration.up()).rejects.toThrow('2 invalid userId value(s)');

    expect(harness.query.mock.calls.some(([sql]) => String(sql).startsWith('ALTER TABLE'))).toBe(false);
    expect(harness.changeColumn).not.toHaveBeenCalled();
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('rejects an unsupported legacy column type before scanning data', async () => {
    const harness = createHarness({ columnType: 'INTEGER' });

    await expect(harness.migration.up()).rejects.toThrow('does not support converting INTEGER to BIGINT');

    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.changeColumn).not.toHaveBeenCalled();
  });

  it('is idempotent when the column is already a non-null BIGINT', async () => {
    const harness = createHarness({ columnType: 'BIGINT', allowNull: false, rows: [{ recordId: 1, userId: '42' }] });

    await harness.migration.up();

    expect(isBigIntColumnType('BIGINT')).toBe(true);
    expect(harness.changeColumn).not.toHaveBeenCalled();
    expect(harness.query.mock.calls.some(([sql]) => String(sql).startsWith('ALTER TABLE'))).toBe(false);
  });

  it('enforces non-null when a BIGINT column was migrated incompletely', async () => {
    const harness = createHarness({
      columnType: 'BIGINT',
      allowNull: true,
      dialect: 'postgres',
      rows: [{ recordId: 1, userId: '42' }],
    });

    await harness.migration.up();

    const ddl = harness.query.mock.calls.find(([sql]) => String(sql).startsWith('ALTER TABLE'))?.[0];
    expect(String(ddl)).toContain('ALTER COLUMN "userId" SET NOT NULL');
  });

  it('is a no-op when the collection has not been installed', async () => {
    const harness = createHarness({ collectionExists: false });
    await expect(harness.migration.up()).resolves.toBeUndefined();
    expect(harness.describeTable).not.toHaveBeenCalled();
    expect(harness.removeCollection).toHaveBeenCalledWith('aiApiUsageRecords');
  });
});
