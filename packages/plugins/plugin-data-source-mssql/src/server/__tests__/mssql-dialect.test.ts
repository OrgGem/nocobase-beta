/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { MssqlDialect } from '../dialects/mssql-dialect';

describe('MssqlDialect', () => {
  let dialect: MssqlDialect;

  beforeEach(() => {
    dialect = new MssqlDialect();
  });

  describe('dialectName', () => {
    it('should have correct dialect name', () => {
      expect(MssqlDialect.dialectName).toBe('mssql');
    });
  });

  describe('getVersionGuard', () => {
    it('should return version guard configuration', () => {
      const guard = dialect.getVersionGuard();

      expect(guard).toBeDefined();
      expect(guard.sql).toContain('SERVERPROPERTY');
      expect(guard.sql).toContain('ProductVersion');
      expect(guard.version).toBe('>=12.0.0');
    });

    it('should have version getter function', () => {
      const guard = dialect.getVersionGuard();

      expect(typeof guard.get).toBe('function');
    });

    it('should extract version number correctly', () => {
      const guard = dialect.getVersionGuard();

      // SQL Server 2019 example
      expect(guard.get('15.0.2000.5')).toBe('15.0.2000.5');

      // SQL Server 2017 example
      expect(guard.get('14.0.3445.2')).toBe('14.0.3445.2');

      // SQL Server 2014 example (minimum supported)
      expect(guard.get('12.0.6024.0')).toBe('12.0.6024.0');
    });

    it('should handle version string with prefix', () => {
      const guard = dialect.getVersionGuard();

      // Sometimes version might have extra text
      expect(guard.get('Version 15.0.2000.5')).toBe('15.0.2000.5');
    });
  });

  describe('getSequelizeOptions', () => {
    it('should maintain existing dialectOptions', () => {
      const options: any = {
        host: 'localhost',
        dialect: 'mssql',
        dialectOptions: {
          existingOption: 'value',
        },
      };

      const result = dialect.getSequelizeOptions(options);

      expect(result.dialectOptions.existingOption).toBe('value');
    });

    it('should set encrypt option when provided', () => {
      const options: any = {
        host: 'localhost',
        dialect: 'mssql',
        encrypt: true,
        dialectOptions: {},
      };

      const result = dialect.getSequelizeOptions(options);

      expect(result.dialectOptions.options.encrypt).toBe(true);
    });

    it('should set encrypt to false when specified', () => {
      const options: any = {
        host: 'localhost',
        dialect: 'mssql',
        encrypt: false,
        dialectOptions: {},
      };

      const result = dialect.getSequelizeOptions(options);

      expect(result.dialectOptions.options.encrypt).toBe(false);
    });

    it('should not add encrypt when undefined', () => {
      const options: any = {
        host: 'localhost',
        dialect: 'mssql',
        dialectOptions: {},
      };

      const result = dialect.getSequelizeOptions(options);

      expect(result.dialectOptions.options).toBeDefined();
      expect('encrypt' in result.dialectOptions.options).toBe(false);
    });

    it('should merge with existing dialectOptions.options', () => {
      const options: any = {
        host: 'localhost',
        dialect: 'mssql',
        encrypt: true,
        dialectOptions: {
          options: {
            trustServerCertificate: true,
          },
        },
      };

      const result = dialect.getSequelizeOptions(options);

      expect(result.dialectOptions.options.encrypt).toBe(true);
      expect(result.dialectOptions.options.trustServerCertificate).toBe(true);
    });

    it('should handle empty dialectOptions', () => {
      const options: any = {
        host: 'localhost',
        dialect: 'mssql',
        encrypt: true,
      };

      const result = dialect.getSequelizeOptions(options);

      expect(result.dialectOptions).toBeDefined();
      expect(result.dialectOptions.options.encrypt).toBe(true);
    });
  });
});
