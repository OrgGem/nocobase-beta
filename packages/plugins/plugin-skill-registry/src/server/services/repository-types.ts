import type { RegistryModel } from './model-values';

export interface RegistryRepository {
  find(options?: Record<string, unknown>): Promise<RegistryModel[]>;
  findOne(options?: Record<string, unknown>): Promise<RegistryModel | null>;
  create(options: { values: Record<string, unknown>; transaction?: unknown }): Promise<RegistryModel>;
  update(options: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    values: Record<string, unknown>;
    transaction?: unknown;
  }): Promise<unknown>;
  destroy(options: {
    filter?: Record<string, unknown>;
    filterByTk?: string | number;
    transaction?: unknown;
  }): Promise<unknown>;
  count(options?: { filter?: Record<string, unknown> }): Promise<number>;
}

export interface RegistryModelStatic {
  increment(field: string, options: { by?: number; where: Record<string, unknown> }): Promise<unknown>;
}

export interface RegistryDatabase {
  getRepository(name: string): RegistryRepository;
  getModel?(name: string): RegistryModelStatic;
  sequelize?: {
    transaction<T>(callback: (transaction: unknown) => Promise<T>): Promise<T>;
  };
}

// Read-then-write on downloadCount loses concurrent increments, so push the arithmetic into SQL.
export async function incrementDownloadCount(database: RegistryDatabase, packageId: string): Promise<void> {
  const model = database.getModel?.('skillRegistryPackages');
  if (!model) {
    return;
  }
  await model.increment('downloadCount', { by: 1, where: { id: packageId } });
}

export async function withTransaction<T>(
  database: RegistryDatabase,
  callback: (transaction: unknown) => Promise<T>,
): Promise<T> {
  if (database.sequelize) {
    return database.sequelize.transaction(callback);
  }
  return callback(undefined);
}
