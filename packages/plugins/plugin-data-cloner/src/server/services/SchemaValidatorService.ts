import { Application } from '@nocobase/server';
import { Database } from '@nocobase/database';

export class SchemaValidatorService {
  app: Application;

  constructor(app: Application) {
    this.app = app;
  }

  /**
   * Query information_schema to get table/column info, adapting to dialect
   */
  async getSchemaInfo(db: Database) {
    const dialect = db.sequelize.getDialect();
    let query: string;

    if (dialect === 'mssql') {
      query = `
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = 'dbo'
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `;
    } else if (dialect === 'postgres') {
      query = `
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = 'public'
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `;
    } else {
      // mysql, sqlite, mariadb
      query = `
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `;
    }

    const [results] = await db.sequelize.query(query);
    return results;
  }

  /**
   * Compare schema between two datasources
   */
  async validate(sourceKey: string, targetKey: string) {
    const sourceDataSource = this.app.dataSourceManager.get(sourceKey);
    const targetDataSource = this.app.dataSourceManager.get(targetKey);

    if (!sourceDataSource || !targetDataSource) {
      throw new Error('DataSource not found');
    }

    const sourceSchema = await this.getSchemaInfo((sourceDataSource.collectionManager as any).db);
    const targetSchema = await this.getSchemaInfo((targetDataSource.collectionManager as any).db);

    const sourceMap = this.groupByTable(sourceSchema);
    const targetMap = this.groupByTable(targetSchema);

    const errors: string[] = [];

    for (const [tableName, columns] of Object.entries(sourceMap)) {
      if (!targetMap[tableName]) {
        errors.push(`Table ${tableName} does not exist in target.`);
        continue;
      }

      const targetCols = targetMap[tableName];
      const targetColNames = targetCols.map((c: any) => c.COLUMN_NAME);

      for (const col of columns as any[]) {
        if (!targetColNames.includes(col.COLUMN_NAME)) {
          errors.push(`Column ${col.COLUMN_NAME} in table ${tableName} does not exist in target.`);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  private groupByTable(schemaData: any[]) {
    return schemaData.reduce((acc, row) => {
      if (!acc[row.TABLE_NAME]) acc[row.TABLE_NAME] = [];
      acc[row.TABLE_NAME].push(row);
      return acc;
    }, {} as Record<string, any[]>);
  }
}
