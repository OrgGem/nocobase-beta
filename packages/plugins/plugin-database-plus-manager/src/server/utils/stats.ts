interface CollectionInfo {
  tableName(): string;
  model: { primaryKeyAttribute: string; getTableName(): string };
}

interface RowCountRepository {
  getEstimatedRowCount(): Promise<number>;
  count(): Promise<number>;
}

interface QueryInterface {
  collectionTableExists(collection: unknown): Promise<boolean>;
  listViews(options?: { schema?: string }): Promise<unknown[]>;
  showTableDefinition(tableInfo: { tableName: string; schema?: string }): Promise<unknown>;
  getAutoIncrementInfo(options: {
    tableInfo: { tableName: string; schema?: string };
    fieldName: string;
  }): Promise<{ seqName?: string; currentVal: number }>;
}

export interface StatsDatabase {
  getCollection(name: string): CollectionInfo;
  getRepository(name: string): RowCountRepository;
  queryInterface: QueryInterface;
}

interface CollectionMetaModel {
  get(): { name: string; title?: string; options?: { origin?: unknown } };
}

export interface CollectionsDatabase {
  getCollection(name: string): CollectionInfo;
  getRepository(name: string): {
    find(): Promise<CollectionMetaModel[]>;
    getEstimatedRowCount(): Promise<number>;
  };
}

export interface CollectionStats {
  name: string;
  tableName: string;
  tableExists: boolean;
  estimatedRowCount: number | null;
  rowCount: number | null;
  primaryKey: string | null;
  autoIncrement: { seqName?: string; currentVal: number } | null;
}

export async function getStats(
  db: StatsDatabase,
  collectionName: string,
  options?: { exact?: boolean },
): Promise<CollectionStats> {
  const collection = db.getCollection(collectionName);
  const repository = db.getRepository(collectionName);
  const tableName = collection.tableName();
  const primaryKey = collection.model.primaryKeyAttribute ?? null;

  let tableExists = false;
  let estimatedRowCount: number | null = null;
  let rowCount: number | null = null;
  let autoIncrement: { seqName?: string; currentVal: number } | null = null;

  try {
    tableExists = await db.queryInterface.collectionTableExists(collection);
  } catch {
    tableExists = true;
  }

  try {
    estimatedRowCount = await repository.getEstimatedRowCount();
  } catch {
    estimatedRowCount = null;
  }

  if (options?.exact !== false) {
    try {
      rowCount = await repository.count();
    } catch {
      rowCount = null;
    }
  }

  if (primaryKey && tableExists) {
    try {
      autoIncrement = await db.queryInterface.getAutoIncrementInfo({
        tableInfo: { tableName },
        fieldName: primaryKey,
      });
    } catch {
      autoIncrement = null;
    }
  }

  return { name: collectionName, tableName, tableExists, estimatedRowCount, rowCount, primaryKey, autoIncrement };
}

export async function listCollections(db: CollectionsDatabase) {
  const metaRepository = db.getRepository('collections');
  const rows = await metaRepository.find();

  const result = [];
  for (const row of rows) {
    const meta = row.get();
    if (meta.options && meta.options.origin) continue;
    const name = meta.name;
    if (!name || name.startsWith('_')) continue;

    let tableName = name;
    let estimatedRowCount: number | null = null;
    try {
      tableName = db.getCollection(name).tableName();
      estimatedRowCount = await db.getRepository(name).getEstimatedRowCount();
    } catch {
      estimatedRowCount = null;
    }

    result.push({ name, title: meta.title || name, tableName, estimatedRowCount });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function getViews(db: StatsDatabase) {
  return db.queryInterface.listViews();
}

export function getTableDefinition(db: StatsDatabase, tableName: string) {
  return db.queryInterface.showTableDefinition({ tableName });
}
