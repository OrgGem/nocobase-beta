// SPDX-License-Identifier: Apache-2.0

import { BaseDialect, DatabaseOptions } from '@nocobase/database';

export class MssqlDialect extends BaseDialect {
  static dialectName = 'mssql';

  getVersionGuard() {
    return {
      sql: "SELECT CAST(SERVERPROPERTY('ProductVersion') AS VARCHAR) AS version",
      get: (v: string) => {
        const m = /([\d.]+)/.exec(v);
        return m?.[0] || v;
      },
      version: '>=12.0.0',
    };
  }

  getSequelizeOptions(options: DatabaseOptions) {
    const dialectOptions = options.dialectOptions || {};
    const encrypt = (options as DatabaseOptions & { encrypt?: boolean }).encrypt;
    const dialectInnerOptions = (dialectOptions as { options?: Record<string, unknown> } | undefined)?.options || {};

    options.dialectOptions = {
      ...dialectOptions,
      options: {
        ...dialectInnerOptions,
        ...(encrypt === undefined ? {} : { encrypt }),
      },
    };

    return options;
  }
}
