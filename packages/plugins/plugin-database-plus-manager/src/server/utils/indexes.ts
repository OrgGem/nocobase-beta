export type IndexAttribute = string | { attribute: string; order?: 'ASC' | 'DESC'; length?: number };

export interface AddIndexOptions {
  name: string;
  fields: IndexAttribute[];
}

interface IndexQueryInterface {
  showIndex: (tableName: string) => Promise<unknown[]>;
  addIndex: (tableName: string, attributes: IndexAttribute[], options: { name: string }) => Promise<unknown>;
  removeIndex: (tableName: string, indexName: string) => Promise<unknown>;
}

type IndexDatabase = { sequelize: { getQueryInterface(): IndexQueryInterface } };

export function listIndexes(db: IndexDatabase, tableName: string) {
  return db.sequelize.getQueryInterface().showIndex(tableName);
}

export function addIndex(db: IndexDatabase, tableName: string, options: AddIndexOptions) {
  return db.sequelize.getQueryInterface().addIndex(tableName, options.fields, { name: options.name });
}

export function removeIndex(db: IndexDatabase, tableName: string, indexName: string) {
  return db.sequelize.getQueryInterface().removeIndex(tableName, indexName);
}
