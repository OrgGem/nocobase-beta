import type { AnyRecord, DatabaseLike, RepositoryLike } from '../services/resolve-pipeline';

type FilterValue = unknown;

const matchesOperator = (actual: unknown, operator: string, expected: unknown): boolean => {
  const a = actual instanceof Date ? actual.toISOString() : actual;
  const b = expected instanceof Date ? expected.toISOString() : expected;
  switch (operator) {
    case '$gt':
      return a != null && a > (b as never);
    case '$lt':
      return a != null && a < (b as never);
    case '$ne':
      return a !== b;
    case '$in':
      if (!Array.isArray(expected)) return false;
      return expected.includes(a);
    default:
      return false;
  }
};

const matchFilter = (row: AnyRecord, filter?: Record<string, FilterValue>): boolean => {
  if (!filter) return true;
  return Object.entries(filter).every(([key, condition]) => {
    const actual = row[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      return Object.entries(condition as Record<string, unknown>).every(([operator, expected]) =>
        matchesOperator(actual, operator, expected),
      );
    }
    return actual === condition;
  });
};

const sortRows = (rows: AnyRecord[], sort?: string[]): AnyRecord[] => {
  if (!sort?.length) return rows;
  const sorted = [...rows].sort((a, b) => {
    for (const directive of sort) {
      const descending = directive.startsWith('-');
      const field = descending ? directive.slice(1) : directive;
      const av = a[field] as string | number | null | undefined;
      const bv = b[field] as string | number | null | undefined;
      if (av === bv) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av < bv ? -1 : 1) * (descending ? -1 : 1);
    }
    return 0;
  });
  return sorted;
};

export class FakeRepository implements RepositoryLike {
  rows: AnyRecord[] = [];
  private nextId = 1;

  async findOne(options?: {
    filter?: Record<string, unknown>;
    filterByTk?: unknown;
    sort?: string[];
  }): Promise<AnyRecord | null> {
    const matched =
      options?.filterByTk !== undefined
        ? this.rows.filter((row) => row.id === options.filterByTk)
        : this.rows.filter((row) => matchFilter(row, options?.filter));
    return sortRows(matched, options?.sort)[0] ?? null;
  }

  async find(options?: { filter?: Record<string, unknown>; sort?: string[]; limit?: number }): Promise<AnyRecord[]> {
    const matched = this.rows.filter((row) => matchFilter(row, options?.filter));
    const sorted = sortRows(matched, options?.sort);
    return options?.limit ? sorted.slice(0, options.limit) : sorted;
  }

  async count(options?: { filter?: Record<string, unknown> }): Promise<number> {
    return this.rows.filter((row) => matchFilter(row, options?.filter)).length;
  }

  async create(options: { values: Record<string, unknown> }): Promise<AnyRecord> {
    const row: AnyRecord = { id: this.nextId++, createdAt: new Date().toISOString(), ...options.values };
    this.rows.push(row);
    return row;
  }

  async update(options: {
    filterByTk?: unknown;
    filter?: Record<string, unknown>;
    values: Record<string, unknown>;
  }): Promise<[number]> {
    const targets =
      options.filterByTk !== undefined
        ? this.rows.filter((row) => row.id === options.filterByTk)
        : this.rows.filter((row) => matchFilter(row, options.filter));
    for (const target of targets) {
      Object.assign(target, options.values);
    }
    return [targets.length];
  }

  async destroy(options?: { filter?: Record<string, unknown> }): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !matchFilter(row, options?.filter));
    return before - this.rows.length;
  }
}

export class FakeDatabase implements DatabaseLike {
  private readonly repositories = new Map<string, FakeRepository>();

  getRepository(name: string): FakeRepository {
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new FakeRepository();
      this.repositories.set(name, repository);
    }
    return repository;
  }

  repo(name: string): FakeRepository {
    return this.getRepository(name);
  }
}
