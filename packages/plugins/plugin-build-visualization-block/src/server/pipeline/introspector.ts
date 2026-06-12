import type { Application } from '@nocobase/server';

import type { CollectionSummary, FieldMeta, RelationMeta, SchemaSummary } from '../../shared/blockSpec';

/**
 * Options accepted by {@link introspect}. These mirror the subset of the
 * Build_Record the introspector needs: the selected data source key and the
 * ordered list of target collection names.
 */
export interface IntrospectOptions {
  /** The data source key the collections belong to (e.g. `main`). */
  dataSource: string;
  /** The target collection names to introspect, in requested order. */
  collections: string[];
}

/**
 * The minimal structural shape this module reads off a collection field. Both
 * the main database `Field` (from `@nocobase/database`) and the data-source
 * `IField` (from `@nocobase/data-source-manager`) satisfy it: each exposes an
 * `options` bag and an `isRelationField()` predicate, and the database `Field`
 * additionally exposes `name`/`type` getters. We read through `options` so the
 * same code path works for either runtime without resorting to `any`.
 */
interface IntrospectableField {
  name?: string;
  type?: string;
  options?: {
    name?: string;
    type?: string;
    interface?: string;
    title?: string;
    uiSchema?: { title?: string } | null;
    target?: string;
    [key: string]: unknown;
  };
  isRelationField?: () => boolean;
}

/**
 * The minimal structural shape this module reads off a collection. Satisfied by
 * both the database `Collection` and the data-source `ICollection`.
 */
interface IntrospectableCollection {
  getFields(): IntrospectableField[];
}

/**
 * Relation field types recognised during introspection. Covers both the
 * association names used by the main database (`belongsTo`, `hasMany`,
 * `hasOne`, `belongsToMany`) and the interface-style aliases used across data
 * sources (`m2o`, `o2m`, `o2o`, `m2m`, `obo`, `oho`).
 */
const RELATION_TYPES = new Set<string>([
  'belongsTo',
  'hasMany',
  'hasOne',
  'belongsToMany',
  'o2m',
  'm2o',
  'o2o',
  'm2m',
  'obo',
  'oho',
]);

/** Data source keys that resolve to the application's main database. */
const DEFAULT_DATA_SOURCE_KEYS = new Set<string>(['', 'main']);

/**
 * Resolve the collection for `(dataSource, name)`.
 *
 * - For the default/`main` data source the collection comes from `app.db`.
 * - For any other data source it comes from that source's collection manager.
 *
 * Returns `undefined` when the data source or collection cannot be resolved;
 * callers record the miss as an `introspectionFailed` collection.
 */
function resolveCollection(app: Application, dataSource: string, name: string): IntrospectableCollection | undefined {
  if (DEFAULT_DATA_SOURCE_KEYS.has(dataSource)) {
    return app.db.getCollection(name) as IntrospectableCollection | undefined;
  }

  const source = app.dataSourceManager?.dataSources?.get(dataSource);
  const collection = source?.collectionManager?.getCollection(name);
  return collection as IntrospectableCollection | undefined;
}

/** Read a field's display title, falling back through uiSchema → title → name. */
function readFieldTitle(field: IntrospectableField, name: string): string {
  const options = field.options ?? {};
  return options.uiSchema?.title ?? options.title ?? name;
}

/** Returns true when the field describes a relation to another collection. */
function isRelation(field: IntrospectableField, type: string): boolean {
  if (typeof field.isRelationField === 'function') {
    return field.isRelationField();
  }
  return RELATION_TYPES.has(type);
}

/**
 * Build the {@link CollectionSummary} for a single collection. Splits the
 * collection's fields into flat {@link FieldMeta} and {@link RelationMeta}
 * entries.
 *
 * Only *readable* fields are retained: a field is readable when both its name
 * and type resolve to non-empty values (Req 2.1). Fields whose resolved name
 * is empty are skipped, so a collection that exposes no readable fields yields
 * an empty `fields` array rather than a list of blank entries (Req 2.4).
 *
 * This may throw if `getFields()` or a field accessor throws while reading
 * collection metadata; callers wrap the call to record the failure per
 * collection (Req 2.6).
 */
function summarizeCollection(name: string, collection: IntrospectableCollection): CollectionSummary {
  const fields: FieldMeta[] = [];
  const relations: RelationMeta[] = [];

  for (const field of collection.getFields()) {
    const options = field.options ?? {};
    const fieldName = field.name ?? options.name ?? '';
    const type = field.type ?? options.type ?? '';

    // A readable field has both a resolvable name and type; skip fields whose
    // name is empty so they never enter the collected schema (Req 2.1, 2.4).
    if (fieldName === '' || type === '') {
      continue;
    }

    fields.push({
      name: fieldName,
      type,
      interface: options.interface ?? '',
      title: readFieldTitle(field, fieldName),
    });

    if (isRelation(field, type) && typeof options.target === 'string') {
      relations.push({
        name: fieldName,
        type,
        target: options.target,
      });
    }
  }

  return { name, fields, relations };
}

/**
 * Introspect the schema of the requested collections within a data source.
 *
 * Reads each collection's fields into a flat {@link FieldMeta} list plus a
 * {@link RelationMeta} list of its relation fields, and returns a
 * {@link SchemaSummary} keyed by the data source. The requested collection
 * order is preserved in the result.
 *
 * Per-collection failure handling keeps a single bad collection from aborting
 * the whole run (Req 2.5, 2.6):
 *
 * - A collection that cannot be resolved (not found, or without a usable
 *   `getFields`) is recorded with empty fields/relations and flagged
 *   `introspectionFailed`.
 * - A collection that resolves but exposes no readable fields is recorded with
 *   an empty `fields` array and is *not* flagged `introspectionFailed`
 *   (Req 2.4) — an empty collection is a valid, non-failing outcome.
 * - If reading a collection's metadata throws, the collection is recorded with
 *   empty fields/relations and flagged `introspectionFailed`, a warning is
 *   logged when a logger is available, and processing continues without
 *   discarding already-collected results (Req 2.6).
 */
export async function introspect(app: Application, options: IntrospectOptions): Promise<SchemaSummary> {
  const { dataSource, collections } = options;
  const summaries: CollectionSummary[] = [];

  for (const name of collections) {
    try {
      const collection = resolveCollection(app, dataSource, name);

      if (!collection || typeof collection.getFields !== 'function') {
        // Unresolved collection: keep it in the result (preserving requested
        // order) but flag that introspection yielded no field-level metadata.
        summaries.push({ name, fields: [], relations: [], introspectionFailed: true });
        continue;
      }

      // A resolved-but-empty collection is recorded with an empty `fields`
      // array and is NOT flagged introspectionFailed (Req 2.4).
      summaries.push(summarizeCollection(name, collection));
    } catch (error) {
      // Reading metadata threw: record the failure and continue so one bad
      // collection cannot abort the loop or discard prior results (Req 2.6).
      app.logger?.warn?.(
        `[plugin-build-visualization-block] failed to introspect collection "${name}" in data source "${dataSource}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      summaries.push({ name, fields: [], relations: [], introspectionFailed: true });
    }
  }

  return { dataSource, collections: summaries };
}

export default introspect;
