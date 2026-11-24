// SPDX-License-Identifier: Apache-2.0

import { DataTypes, Op, Sequelize } from 'sequelize';
import { describe, expect, it } from 'vitest';
import {
  buildFtsPrefixTerm,
  buildFtsSearchCondition,
  createMssqlOperators,
  escapeMssqlLike,
  type MssqlOperatorContext,
  type MssqlOperatorIntrospector,
} from '../operators/mssql-operators';

describe('MSSQL filter & search operators', () => {
  describe('escapeMssqlLike', () => {
    it('escapes [, %, and _ using T-SQL bracket syntax without backslashes', () => {
      expect(escapeMssqlLike('user_01')).toBe('user[_]01');
      expect(escapeMssqlLike('100%')).toBe('100[%]');
      expect(escapeMssqlLike('[admin]')).toBe('[[]admin]');
      expect(escapeMssqlLike('C:\\temp\\a_b%c[1]')).toBe('C:\\temp\\a[_]b[%]c[[]1]');
    });

    it('coerces non-string values safely instead of throwing TypeError', () => {
      expect(escapeMssqlLike(12345)).toBe('12345');
    });
  });

  describe('buildFtsPrefixTerm & buildFtsSearchCondition', () => {
    it('tokenizes multi-word input into AND-combined prefix terms', () => {
      expect(buildFtsPrefixTerm('nguyen van')).toBe('"nguyen*" AND "van*"');
      expect(buildFtsPrefixTerm('  acme  ')).toBe('"acme*"');
    });

    it('splits on embedded FTS syntax characters (", *, (, )) to prevent Msg 7630', () => {
      expect(buildFtsPrefixTerm('15"inch')).toBe('"15*" AND "inch*"');
      expect(buildFtsPrefixTerm('foo*bar')).toBe('"foo*" AND "bar*"');
    });

    it('returns null for empty or punctuation-only input so caller falls back to LIKE', () => {
      expect(buildFtsPrefixTerm('')).toBeNull();
      expect(buildFtsPrefixTerm('   ')).toBeNull();
      expect(buildFtsPrefixTerm('---')).toBeNull();
      expect(buildFtsPrefixTerm('... & ()')).toBeNull();
    });

    it('combines array inputs with OR and wraps multi-word terms in parentheses', () => {
      expect(buildFtsSearchCondition(['acme', 'beta corp'])).toBe('"acme*" OR ("beta*" AND "corp*")');
      expect(buildFtsSearchCondition(['acme', '---'])).toBeNull();
    });
  });

  describe('createMssqlOperators SQL generation', () => {
    function setupSequelize() {
      const sequelize = new Sequelize('db', 'u', 'p', { dialect: 'mssql', logging: false });
      const captured: Array<string | { query: string; bind?: unknown[] }> = [];
      (
        sequelize as unknown as { query: (sql: string | { query: string; bind?: unknown[] }) => Promise<unknown[]> }
      ).query = async (sql) => {
        captured.push(sql);
        return [];
      };

      const Customer = sequelize.define(
        'customers',
        {
          id: { type: DataTypes.INTEGER, primaryKey: true },
          fullName: { type: DataTypes.STRING, field: 'FullName' },
          code: { type: DataTypes.STRING, field: 'CustCode' },
        },
        { timestamps: false, tableName: 'nb_Customers', schema: 'sales' },
      );

      const Order = sequelize.define(
        'orders',
        {
          id: { type: DataTypes.INTEGER, primaryKey: true },
          code: { type: DataTypes.STRING, field: 'OrderCode' },
          title: { type: DataTypes.STRING, field: 'OrderTitle' },
          customerId: { type: DataTypes.INTEGER, field: 'CustomerId' },
        },
        { timestamps: false, tableName: 'nb_Orders', schema: 'sales' },
      );

      Order.belongsTo(Customer, { as: 'customer', foreignKey: 'customerId' });
      return { sequelize, Order, Customer, captured };
    }

    const introspector: MssqlOperatorIntrospector = {
      hasFTSIndex: (tableName, columnName) =>
        (tableName === 'nb_Orders' && columnName === 'OrderTitle') ||
        (tableName === 'nb_Customers' && columnName === 'FullName'),
      isAnsiStringColumn: (tableName, columnName) =>
        (tableName === 'nb_Orders' && columnName === 'OrderCode') ||
        (tableName === 'nb_Customers' && columnName === 'CustCode'),
    };

    it('uses uniform LIKE substring predicates on FTS-indexed columns so reads include infix matches and match writes', async () => {
      const { Order, captured } = setupSequelize();
      const ops = createMssqlOperators(introspector, () => 'auto');

      const rootWhere = ops.$includes('fast search', {
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      });

      const infixWhere = ops.$includes('bar', {
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      });

      const joinWhere = ops.$includes('acme corp', {
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'fullName',
        fullName: 'customer.fullName',
      });

      await Order.findAll({
        where: {
          [Op.and]: [{ title: rootWhere }, { '$customer.FullName$': joinWhere }],
        } as Record<string | symbol, unknown>,
        include: [{ association: 'customer', attributes: [] }],
      });

      await Order.findAll({
        where: { title: infixWhere } as Record<string, unknown>,
      });

      const sql = String(captured[0]);
      expect(sql).not.toContain('CONTAINS');
      expect(sql).toContain(`[orders].[OrderTitle] LIKE N'%fast search%'`);
      expect(sql).toContain(`[customer].[FullName] LIKE N'%acme corp%'`);

      const infixSql = String(captured[1]);
      expect(infixSql).not.toContain('CONTAINS');
      expect(infixSql).toContain(`[orders].[OrderTitle] LIKE N'%bar%'`);
    });

    it('never routes $notIncludes through NOT (CONTAINS(...)) even on FTS-indexed columns', async () => {
      const { Order, captured } = setupSequelize();
      const ops = createMssqlOperators(introspector, () => 'auto');

      const notIncludesWhere = ops.$notIncludes('bar', {
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      });

      await Order.findAll({ where: { title: notIncludesWhere } as Record<string, unknown> });

      const sql = String(captured[0]);
      expect(sql).not.toContain('CONTAINS');
      expect(sql).toContain(`[orders].[OrderTitle] NOT LIKE N'%bar%'`);
    });

    it('combines array $includes values with OR-ed LIKE substring predicates without CONTAINS()', async () => {
      const { Order, captured } = setupSequelize();
      const ops = createMssqlOperators(introspector, () => 'auto');

      const arrayWhere = ops.$includes(['foo', 'bar baz'], {
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      });

      await Order.findAll({ where: { title: arrayWhere } as Record<string, unknown> });

      const sql = String(captured[0]);
      expect(sql).not.toContain('CONTAINS');
      expect(sql).toContain(`[orders].[OrderTitle] LIKE N'%foo%'`);
      expect(sql).toContain(`[orders].[OrderTitle] LIKE N'%bar baz%'`);
    });

    it('falls back to T-SQL LIKE when fullTextSearchMode is off or input has only punctuation', async () => {
      const { Order, captured } = setupSequelize();
      const autoOps = createMssqlOperators(introspector, () => 'auto');
      const offOps = createMssqlOperators(introspector, () => 'off');

      const punctWhere = autoOps.$includes('---_%%', {
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      });
      await Order.findAll({ where: { title: punctWhere } as Record<string, unknown> });

      const offWhere = offOps.$includes('user_01', {
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      });
      await Order.findAll({ where: { title: offWhere } as Record<string, unknown> });

      expect(String(captured[0])).toContain(`LIKE N'%---[_][%][%]%'`);
      expect(String(captured[1])).toContain(`LIKE N'%user[_]01%'`);
    });

    it('emits non-Unicode ANSI literals for ASCII filters on VARCHAR columns to preserve B-tree index seeks', async () => {
      const { Order, captured } = setupSequelize();
      const ops = createMssqlOperators(introspector, () => 'auto');
      const ctx: MssqlOperatorContext = {
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'code',
        fullName: 'code',
      };

      await Order.findAll({ where: { code: ops.$eq('ORD-001', ctx) } as Record<string, unknown> });
      await Order.findAll({ where: { code: ops.$startsWith('ORD_1', ctx) } as Record<string, unknown> });
      await Order.findAll({ where: { code: ops.$in(['A-1', 'B-2'], ctx) } as Record<string, unknown> });
      // Non-ASCII input must remain Unicode (N'...') so characters are never lost
      await Order.findAll({ where: { code: ops.$eq('Nguyễn', ctx) } as Record<string, unknown> });
      // UPDATE / DELETE must also generate valid SQL without broken SELECT aliases
      await Order.update({ code: 'X' }, { where: { code: ops.$eq('ORD-001', ctx) } as Record<string, unknown> }).catch(
        () => undefined,
      );
      await Order.destroy({ where: { code: ops.$eq('ORD-001', ctx) } as Record<string, unknown> }).catch(
        () => undefined,
      );

      expect(String(captured[0])).toContain(`[orders].[OrderCode] = 'ORD-001'`);
      expect(String(captured[0])).not.toContain(`N'ORD-001'`);
      expect(String(captured[1])).toContain(`[orders].[OrderCode] LIKE 'ORD[_]1%'`);
      expect(String(captured[2])).toContain(`[orders].[OrderCode] IN ('A-1', 'B-2')`);
      expect(String(captured[3])).toContain(`[orders].[OrderCode] = N'Nguyễn'`);
      expect((captured[4] as { query: string }).query).toContain(`WHERE [OrderCode] = 'ORD-001'`);
      expect(String(captured[5])).toContain(`WHERE [OrderCode] = 'ORD-001'`);
    });

    it('keeps Unicode N-prefixed literals on NVARCHAR columns', async () => {
      const { Order, captured } = setupSequelize();
      const ops = createMssqlOperators(introspector, () => 'auto');
      const ctx: MssqlOperatorContext = {
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      };

      await Order.findAll({ where: { title: ops.$eq('Hello', ctx) } as Record<string, unknown> });
      expect(String(captured[0])).toContain(`[orders].[OrderTitle] = N'Hello'`);
    });

    it('keeps identical LIKE substring semantics across read and write actions without unbound aliases on UPDATE/DELETE', async () => {
      const { Order, captured } = setupSequelize();
      const ops = createMssqlOperators(introspector, () => 'auto');

      const readCtx: MssqlOperatorContext = {
        app: { ctx: { action: { actionName: 'list' } } },
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      };
      const updateCtx: MssqlOperatorContext = {
        app: { ctx: { action: { actionName: 'update' } } },
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      };
      const destroyCtx: MssqlOperatorContext = {
        app: { ctx: { action: { actionName: 'destroy' } } },
        model: Order as unknown as MssqlOperatorContext['model'],
        fieldName: 'title',
        fullName: 'title',
      };

      await Order.findAll({
        where: { title: ops.$includes('bar', readCtx) } as Record<string, unknown>,
      });
      await Order.update(
        { code: 'X' },
        { where: { title: ops.$includes('bar', updateCtx) } as Record<string, unknown> },
      ).catch(() => undefined);
      await Order.destroy({
        where: { title: ops.$includes('bar', destroyCtx) } as Record<string, unknown>,
      }).catch(() => undefined);

      const readSql = String(captured[0]);
      const updateSql = (captured[1] as { query: string }).query;
      const deleteSql = String(captured[2]);
      expect(readSql).toContain(`WHERE [orders].[OrderTitle] LIKE N'%bar%'`);
      expect(readSql).not.toContain('CONTAINS');

      expect(updateSql).toContain(`WHERE [OrderTitle] LIKE N'%bar%'`);
      expect(updateSql).not.toContain('CONTAINS');
      expect(updateSql).not.toContain('[orders].');

      expect(deleteSql).toContain(`WHERE [OrderTitle] LIKE N'%bar%'`);
      expect(deleteSql).not.toContain('CONTAINS');
      expect(deleteSql).not.toContain('[orders].');
    });
  });
});
