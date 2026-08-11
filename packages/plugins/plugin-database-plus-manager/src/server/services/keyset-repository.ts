import type { Repository } from '@nocobase/database';

export interface KeysetPageOptions {
  context: unknown;
  filter: Record<string, unknown>;
  fields?: string[];
  appends?: string[];
  except?: string[];
  sort: string[];
  limit: number;
}

export interface KeysetPageResult<T> {
  rows: T[];
  hasNext: boolean;
}

export function supportsKeysetPagination(repository: unknown): repository is Repository {
  return (
    typeof repository === 'object' &&
    repository !== null &&
    typeof (repository as { find?: unknown }).find === 'function'
  );
}

export async function findKeysetPage<T>(
  repository: Repository,
  options: KeysetPageOptions,
): Promise<KeysetPageResult<T>> {
  const rows = await repository.find({
    context: options.context,
    filter: options.filter,
    fields: options.fields,
    appends: options.appends,
    except: options.except,
    sort: options.sort,
    limit: options.limit + 1,
  });
  return {
    rows: rows.slice(0, options.limit) as T[],
    hasNext: rows.length > options.limit,
  };
}
