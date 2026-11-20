// SPDX-License-Identifier: Apache-2.0

import {
  buildBulkColumnsSql,
  buildBulkIndexesSql,
  formatColumnType,
  groupColumnsByTable,
  groupIndexesByTable,
  MssqlBulkColumnRow,
} from '../data-source/mssql-bulk-introspection';

describe('mssql-bulk-introspection', () => {
  describe('buildBulkColumnsSql', () => {
    it('targets the requested schema as a Unicode literal', () => {
      const sql = buildBulkColumnsSql('dbo');
      expect(sql).toContain("u.name = N'dbo'");
    });

    it('never interpolates a hostile schema name raw', () => {
      const sql = buildBulkColumnsSql("dbo'; DROP TABLE users; --");
      // The quote is doubled, so it stays inside the string literal
      expect(sql).toContain("u.name = N'dbo''; DROP TABLE users; --'");
      expect(sql).not.toContain("N'dbo';");
    });

    it('excludes system tables', () => {
      expect(buildBulkColumnsSql('dbo')).toContain('o.is_ms_shipped = 0');
    });

    it('reads from sys catalog, not INFORMATION_SCHEMA, for identity/default metadata', () => {
      const sql = buildBulkColumnsSql('dbo');
      expect(sql).toContain('sys.columns');
      expect(sql).toContain('sys.default_constraints');
      expect(sql).toContain('c.is_identity');
    });
  });

  describe('formatColumnType', () => {
    it('formats varchar with length', () => {
      expect(formatColumnType('varchar', 50)).toBe('VARCHAR(50)');
    });

    it('halves max_length for nchar/nvarchar (byte count -> char count)', () => {
      expect(formatColumnType('nvarchar', 100)).toBe('NVARCHAR(50)');
      expect(formatColumnType('nchar', 20)).toBe('NCHAR(10)');
    });

    it('renders MAX for -1 length', () => {
      expect(formatColumnType('nvarchar', -1)).toBe('NVARCHAR(MAX)');
      expect(formatColumnType('varchar', -1)).toBe('VARCHAR(MAX)');
      expect(formatColumnType('varbinary', -1)).toBe('VARBINARY(MAX)');
    });

    it('leaves non-char types untouched', () => {
      expect(formatColumnType('int', 4)).toBe('INT');
      expect(formatColumnType('datetime2', 8)).toBe('DATETIME2');
      expect(formatColumnType('decimal', 9)).toBe('DECIMAL');
    });
  });

  describe('groupColumnsByTable', () => {
    const row = (over: Partial<MssqlBulkColumnRow>): MssqlBulkColumnRow => ({
      table_name: 'Users',
      column_name: 'id',
      data_type: 'int',
      max_length: 4,
      is_nullable: false,
      is_identity: true,
      default_value: null,
      column_comment: null,
      ...over,
    });

    it('groups columns under their table in describeTable shape', () => {
      const map = groupColumnsByTable([
        row({}),
        row({ column_name: 'email', data_type: 'nvarchar', max_length: 200, is_identity: false, is_nullable: true }),
        row({ table_name: 'Orders', column_name: 'orderId', is_identity: false }),
      ]);

      expect(map.size).toBe(2);
      expect(map.get('Users').id).toEqual({
        type: 'INT',
        allowNull: false,
        defaultValue: undefined,
        primaryKey: false,
        autoIncrement: true,
        comment: null,
      });
      expect(map.get('Users').email.type).toBe('NVARCHAR(100)');
      expect(map.get('Users').email.allowNull).toBe(true);
      expect(map.get('Orders').orderId.autoIncrement).toBe(false);
    });

    it('converts a null default to undefined', () => {
      const map = groupColumnsByTable([row({ default_value: null })]);
      expect(map.get('Users').id.defaultValue).toBeUndefined();
    });

    it('keeps a defined default value', () => {
      const map = groupColumnsByTable([row({ default_value: '((0))' })]);
      expect(map.get('Users').id.defaultValue).toBe('((0))');
    });

    it('returns an empty map for no rows', () => {
      expect(groupColumnsByTable([]).size).toBe(0);
    });
  });

  describe('views, alias types, and scoped tableNames in buildBulkColumnsSql', () => {
    it('includes both user tables and views and resolves alias types via base system type', () => {
      const sql = buildBulkColumnsSql('sales', ['Orders', 'v_Summary']);
      expect(sql).toContain("o.type IN ('U', 'V')");
      expect(sql).toContain('COALESCE(st.name, t.name) AS data_type');
      expect(sql).toContain("AND o.name IN (N'Orders', N'v_Summary')");
    });
  });

  describe('buildBulkIndexesSql & groupIndexesByTable', () => {
    it('builds schema-scoped bulk index SQL and groups into Sequelize showIndex shape', () => {
      const sql = buildBulkIndexesSql('dbo', ['Orders']);
      expect(sql).toContain("u.name = N'dbo'");
      expect(sql).toContain("AND o.name IN (N'Orders')");

      const grouped = groupIndexesByTable([
        {
          table_name: 'Orders',
          index_name: 'PK_Orders',
          column_name: 'id',
          key_ordinal: 1,
          is_primary_key: true,
          is_unique: true,
          is_descending_key: false,
        },
        {
          table_name: 'Orders',
          index_name: 'UQ_Code',
          column_name: 'code',
          key_ordinal: 1,
          is_primary_key: false,
          is_unique: true,
          is_descending_key: true,
        },
      ]);

      expect(grouped.get('Orders')).toEqual([
        { name: 'PK_Orders', primary: true, unique: true, fields: [{ attribute: 'id', order: 'ASC' }] },
        { name: 'UQ_Code', primary: false, unique: true, fields: [{ attribute: 'code', order: 'DESC' }] },
      ]);
    });
  });
});
