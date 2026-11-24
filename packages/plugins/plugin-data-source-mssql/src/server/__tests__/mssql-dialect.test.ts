// SPDX-License-Identifier: Apache-2.0

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

    it('normalizes 4-part SQL Server ProductVersion strings to 3-part SemVer', () => {
      const guard = dialect.getVersionGuard();

      // SQL Server 2019 example
      expect(guard.get('15.0.2000.5')).toBe('15.0.2000');

      // SQL Server 2017 RTM example reported by review
      expect(guard.get('14.0.1000.169')).toBe('14.0.1000');

      // SQL Server 2017 CU example
      expect(guard.get('14.0.3445.2')).toBe('14.0.3445');

      // SQL Server 2014 example (minimum supported)
      expect(guard.get('12.0.6024.0')).toBe('12.0.6024');
    });

    it('handles version strings with text prefixes', () => {
      const guard = dialect.getVersionGuard();

      expect(guard.get('Version 15.0.2000.5')).toBe('15.0.2000');
    });

    it('validates 4-part ProductVersion strings against >=12.0.0 in checkDatabaseVersion', async () => {
      const supportedDb = {
        sequelize: {
          query: async () => [{ version: '14.0.1000.169' }],
        },
      };
      await expect(dialect.checkDatabaseVersion(supportedDb)).resolves.toBe(true);

      const unsupportedDb = {
        sequelize: {
          query: async () => [{ version: '11.0.2100.60' }],
        },
      };
      await expect(dialect.checkDatabaseVersion(unsupportedDb)).rejects.toThrow(
        /ensure the version is >=12\.0\.0, current version is 11\.0\.2100/,
      );
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
