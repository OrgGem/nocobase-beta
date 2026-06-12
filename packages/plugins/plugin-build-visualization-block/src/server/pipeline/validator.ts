/**
 * Spec Validator pipeline stage for `plugin-build-visualization-block`.
 *
 * This module is built incrementally:
 * - Task 5.1 implements the core field-existence check plus the remove/remap of
 *   invalid references. Every field reference in the spec is resolved against
 *   the introspected {@link SchemaSummary}; references that do not exist are
 *   remapped to a same-named field (case-insensitive) when one is available, or
 *   removed for list-type references (`table.fields`, `table.sortable`,
 *   `form.fields`, chart `dimensions`). Each remove/remap is recorded as a
 *   {@link ValidationAdjustment}.
 * - Task 5.2 (this revision) extends the remap step with a role→type
 *   compatibility table (see {@link tryTypeCompatibleRemap}) so a missing field
 *   can fall back to an existing field of a compatible data type, and adds
 *   required-role enforcement: a chart left with no usable measure, or a
 *   chart/table/form left with no usable fields, means a required role cannot be
 *   satisfied, so the spec is marked invalid and
 *   {@link ValidationResult.usedFallback} is set to `true` (the actual fallback
 *   spec is produced by the caller). Each unmet requirement is recorded as a
 *   `unmet-role` {@link ValidationAdjustment}.
 * - Task 5.3 (this revision) adds the schema-unavailable abort and the
 *   aggregate adjustments summary. Before any reconciliation runs, the
 *   validator checks whether the spec's `primaryCollection` is unavailable in
 *   the {@link SchemaSummary} — meaning it is absent from the summary entirely,
 *   or present but flagged `introspectionFailed`. If so it short-circuits: it
 *   records a single `schema unavailable` adjustment, sets
 *   {@link ValidationResult.usedFallback} to `true`, and returns the original
 *   spec untouched (it never tries to produce a cleaned spec from a schema it
 *   cannot trust). It also surfaces a {@link ValidationSummary} aggregating the
 *   adjustments (outcome + removed/remapped counts + unmet-role list).
 *
 * The validator is a pure function over structured input: it never mutates the
 * spec it is given and returns a fresh {@link BlockSpec}.
 */

import type {
  Aggregation,
  BlockSpec,
  ChartDimension,
  ChartMeasure,
  ChartSpecItem,
  FieldMeta,
  SchemaSummary,
} from '../../shared/blockSpec';

/**
 * A single change the validator made to the spec while reconciling it against
 * the real collection schema.
 */
export interface ValidationAdjustment {
  /** The original field reference (as written in the spec), or for an
   * `unmet-role` adjustment a short descriptor of the unsatisfied role. */
  reference: string;
  /**
   * Whether the reference was dropped, pointed at a different field, or whether
   * a required role could not be satisfied at all.
   */
  action: 'removed' | 'remapped' | 'unmet-role';
  /** The field the reference was remapped to (only set for `remapped`). */
  replacement?: string;
  /** A short, non-localized diagnostic describing why the change was made. */
  reason?: string;
}

/**
 * An aggregate, user-facing summary of everything the validator did, derived
 * from the detailed {@link ValidationAdjustment} list (Requirement 6.7).
 */
export interface ValidationSummary {
  /**
   * `validated` when the spec passed validation and every field reference
   * resolves to an existing field (Requirement 6.4); `fallback` when the
   * validator gave up (unmet required role or unavailable schema) and the
   * caller must substitute the fallback spec.
   */
  outcome: 'validated' | 'fallback';
  /** How many field references were dropped. */
  removedCount: number;
  /** How many field references were pointed at a different field. */
  remappedCount: number;
  /** The `reference` of every `unmet-role` adjustment (required roles that
   * could not be satisfied, including schema-unavailable collections). */
  unmetRoles: string[];
}

/**
 * The result of validating a {@link BlockSpec} against a {@link SchemaSummary}.
 */
export interface ValidationResult {
  /** The cleaned spec; never references a field absent from the schema. */
  spec: BlockSpec;
  /** Every remove/remap/unmet-role the validator performed. */
  adjustments: ValidationAdjustment[];
  /**
   * Whether the validator gave up on the supplied spec and a fallback should be
   * used instead. Set to `true` when a required role cannot be satisfied (task
   * 5.2) or when the primary collection's schema is unavailable (task 5.3).
   */
  usedFallback: boolean;
  /** Aggregate summary of the adjustments, surfaced to the user (task 5.3). */
  summary: ValidationSummary;
}

/**
 * Normalize a field name for loose matching: drop every non-alphanumeric
 * character and lower-case the rest. Ported from
 * `plugin-visualization-templates`'s `normalizeFieldName` so the validator does
 * not depend on that plugin's client module.
 */
export const normalizeFieldName = (name = ''): string => name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

/**
 * Baseline role→type compatibility, derived from the `defaultVisualizationRoles`
 * declarations in `plugin-visualization-templates`. The sets are inlined (not
 * imported) so the server validator does not depend on that plugin's client
 * module — the same approach taken for {@link normalizeFieldName} above.
 *
 * This plugin references fields directly rather than via abstract roles, so the
 * table maps the two concrete *usages* a field can have in a spec:
 * - a chart **measure** with a `sum`/`avg`/`max`/`min` aggregation must point at
 *   a numeric field (a `count` measure, like the `record` role, accepts any
 *   field);
 * - a chart **dimension** groups records and therefore prefers categorical
 *   (string-like) or temporal (date) fields, mirroring the `status`/`priority`
 *   (string + select/radioGroup/input) and `createdAt`/`updatedAt`/`dueDate`
 *   (date + datetime/date) roles.
 */
const NUMERIC_FIELD_TYPES = new Set<string>(['integer', 'bigInt', 'float', 'double', 'decimal', 'real', 'number']);
const NUMERIC_INTERFACES = new Set<string>(['integer', 'number', 'percent', 'currency', 'formula']);

const DIMENSION_FIELD_TYPES = new Set<string>(['string', 'text', 'date', 'dateOnly', 'datetime', 'boolean']);
const DIMENSION_INTERFACES = new Set<string>([
  'select',
  'radioGroup',
  'input',
  'checkbox',
  'multipleSelect',
  'createdAt',
  'updatedAt',
  'datetime',
  'date',
]);

const DATE_FIELD_TYPES = new Set<string>(['date', 'dateOnly', 'datetime']);
const DATE_INTERFACES = new Set<string>(['createdAt', 'updatedAt', 'datetime', 'date']);

/** Record-identifying names (from the `record` role's `matchNames`), preferred
 * as the target when remapping a `count` measure. */
const RECORD_MATCH_NAMES = new Set<string>(['id', 'uid', 'uuid', 'key']);

/**
 * How a single field reference is used in the spec. The usage determines which
 * field types are permitted when remapping (Requirement 6.5) and which roles
 * are required (Requirement 6.3).
 */
type FieldUsage = { kind: 'measure'; aggregation?: Aggregation } | { kind: 'dimension' } | { kind: 'list' };

const isNumericField = (meta: FieldMeta): boolean =>
  NUMERIC_FIELD_TYPES.has(meta.type) || NUMERIC_INTERFACES.has(meta.interface);

const isDimensionField = (meta: FieldMeta): boolean =>
  DIMENSION_FIELD_TYPES.has(meta.type) || DIMENSION_INTERFACES.has(meta.interface);

const isDateField = (meta: FieldMeta): boolean =>
  DATE_FIELD_TYPES.has(meta.type) || DATE_INTERFACES.has(meta.interface);

/**
 * Per-collection lookup structures used while resolving references:
 * - `exact` — the set of real field names, for exact-match existence checks
 *   (Requirement 6.1).
 * - `normalized` — normalized name → first real field name with that
 *   normalization, for the case-insensitive remap baseline.
 * - `byName` — real field name → its {@link FieldMeta}, so the type-compatible
 *   remap (task 5.2) can inspect each candidate's data type/interface. Map
 *   iteration order follows insertion order, giving deterministic remaps.
 */
interface FieldIndex {
  exact: Set<string>;
  normalized: Map<string, string>;
  byName: Map<string, FieldMeta>;
}

/** Build a {@link FieldIndex} per collection from the introspected summary. */
function buildIndexes(summary: SchemaSummary): Map<string, FieldIndex> {
  const indexes = new Map<string, FieldIndex>();
  for (const collection of summary.collections) {
    const exact = new Set<string>();
    const normalized = new Map<string, string>();
    const byName = new Map<string, FieldMeta>();
    for (const field of collection.fields) {
      if (!field.name) {
        continue;
      }
      exact.add(field.name);
      byName.set(field.name, field);
      const key = normalizeFieldName(field.name);
      if (key && !normalized.has(key)) {
        normalized.set(key, field.name);
      }
    }
    indexes.set(collection.name, { exact, normalized, byName });
  }
  return indexes;
}

/**
 * Split a raw field reference into the collection it targets and the field
 * name. A reference is treated as collection-qualified (`collection.field`)
 * only when the segment before the first dot names a collection present in the
 * schema; otherwise the whole reference is a field on `primaryCollection`
 * (so relation paths like `user.name` are not mistaken for a qualifier).
 */
function splitRef(
  rawRef: string,
  primaryCollection: string,
  indexes: Map<string, FieldIndex>,
): { collection: string; field: string; qualified: boolean } {
  const dot = rawRef.indexOf('.');
  if (dot > 0) {
    const head = rawRef.slice(0, dot);
    if (indexes.has(head)) {
      return { collection: head, field: rawRef.slice(dot + 1), qualified: true };
    }
  }
  return { collection: primaryCollection, field: rawRef, qualified: false };
}

/**
 * Whether a candidate field's data type is permitted for the given usage
 * (Requirement 6.5). A `list` reference has no role-specific type constraint, a
 * `count` measure accepts any field (like the `record` role), a numeric measure
 * requires a numeric field, and a dimension requires a categorical/temporal
 * field.
 */
function isCompatible(meta: FieldMeta, usage: FieldUsage): boolean {
  if (usage.kind === 'list') {
    return true;
  }
  if (usage.kind === 'dimension') {
    return isDimensionField(meta);
  }
  if (usage.aggregation && usage.aggregation !== 'count') {
    return isNumericField(meta);
  }
  return true;
}

/**
 * Task 5.2: remap a missing field to an existing field of compatible data type
 * using the role/type compatibility table. Only candidates whose type is
 * permitted for the usage are accepted (Requirement 6.5):
 * - numeric measures map to the first numeric field;
 * - `count` measures map to a record-identifying field when present, otherwise
 *   the first available field (a count works against any column);
 * - dimensions prefer a date field, then any categorical/temporal field;
 * - generic list references are never type-guessed (returning `undefined` lets
 *   the caller remove them, preserving the task 5.1 behavior).
 */
function tryTypeCompatibleRemap(index: FieldIndex, _field: string, usage: FieldUsage): string | undefined {
  if (usage.kind === 'list') {
    return undefined;
  }
  const candidates = Array.from(index.byName.values());
  if (usage.kind === 'measure') {
    if (usage.aggregation && usage.aggregation !== 'count') {
      return candidates.find(isNumericField)?.name;
    }
    const record = candidates.find((meta) => RECORD_MATCH_NAMES.has(normalizeFieldName(meta.name)));
    return (record ?? candidates[0])?.name;
  }
  // dimension
  const dated = candidates.find(isDateField);
  if (dated) {
    return dated.name;
  }
  return candidates.find(isDimensionField)?.name;
}

/** A successful remap target plus the diagnostic describing how it was found. */
interface RemapHit {
  name: string;
  reason: string;
}

/**
 * Attempt to remap a missing field to an existing field on the same collection.
 * A same-named, case-insensitive match is tried first (task 5.1); when no name
 * match is found the type-compatible remap (task 5.2) is consulted. The
 * name-based match is treated as the same semantic field and is therefore not
 * re-gated on type, whereas the type-compatible remap only ever returns a
 * candidate whose type is permitted for the usage (Requirement 6.5).
 */
function tryRemap(index: FieldIndex, field: string, usage: FieldUsage): RemapHit | undefined {
  if (!field) {
    return undefined;
  }
  const byName = index.normalized.get(normalizeFieldName(field));
  if (byName) {
    return { name: byName, reason: 'case-insensitive name match' };
  }
  const typed = tryTypeCompatibleRemap(index, field, usage);
  if (typed) {
    return { name: typed, reason: 'type-compatible remap' };
  }
  return undefined;
}

/** The outcome of classifying a single field reference against the schema. */
type RefResolution =
  | { kind: 'kept' }
  | { kind: 'remapped'; replacement: string; reason: string }
  | { kind: 'unresolved' };

/**
 * Classify a single field reference: kept as-is, remappable to another field,
 * or unresolved (the field is missing and no remap is available — including the
 * case where the target collection is absent from the summary, which task 5.3
 * turns into a schema-unavailable fallback).
 */
function classifyRef(
  rawRef: string,
  primaryCollection: string,
  indexes: Map<string, FieldIndex>,
  usage: FieldUsage,
): RefResolution {
  const { collection, field, qualified } = splitRef(rawRef, primaryCollection, indexes);
  const index = indexes.get(collection);
  if (!index) {
    // Seam for task 5.3: an unknown collection means the schema is unavailable.
    return { kind: 'unresolved' };
  }
  if (field && index.exact.has(field)) {
    return { kind: 'kept' };
  }
  const remap = tryRemap(index, field, usage);
  if (remap) {
    const replacement = qualified ? `${collection}.${remap.name}` : remap.name;
    return { kind: 'remapped', replacement, reason: remap.reason };
  }
  return { kind: 'unresolved' };
}

/**
 * Reconcile a list of string field references (e.g. `table.fields`,
 * `table.sortable`, `form.fields`). Kept and remapped references are retained
 * (remapped ones rewritten to the replacement); unresolved references are
 * dropped. Every remove/remap is appended to `adjustments`.
 */
function reconcileStringList(
  list: string[],
  primaryCollection: string,
  indexes: Map<string, FieldIndex>,
  adjustments: ValidationAdjustment[],
): string[] {
  const result: string[] = [];
  for (const ref of list) {
    const resolution = classifyRef(ref, primaryCollection, indexes, { kind: 'list' });
    if (resolution.kind === 'kept') {
      result.push(ref);
    } else if (resolution.kind === 'remapped') {
      result.push(resolution.replacement);
      adjustments.push({
        reference: ref,
        action: 'remapped',
        replacement: resolution.replacement,
        reason: resolution.reason,
      });
    } else {
      adjustments.push({ reference: ref, action: 'removed', reason: 'field does not exist' });
    }
  }
  return result;
}

/**
 * Reconcile a chart's dimensions (a list of objects keyed by `field`). Like
 * {@link reconcileStringList}, unresolved dimensions are dropped and remapped
 * ones rewritten. Dimensions are optional, so dropping one never triggers the
 * fallback by itself.
 */
function reconcileDimensions(
  dimensions: ChartDimension[],
  primaryCollection: string,
  indexes: Map<string, FieldIndex>,
  adjustments: ValidationAdjustment[],
): ChartDimension[] {
  const result: ChartDimension[] = [];
  for (const dimension of dimensions) {
    const resolution = classifyRef(dimension.field, primaryCollection, indexes, { kind: 'dimension' });
    if (resolution.kind === 'kept') {
      result.push(dimension);
    } else if (resolution.kind === 'remapped') {
      result.push({ ...dimension, field: resolution.replacement });
      adjustments.push({
        reference: dimension.field,
        action: 'remapped',
        replacement: resolution.replacement,
        reason: resolution.reason,
      });
    } else {
      adjustments.push({ reference: dimension.field, action: 'removed', reason: 'field does not exist' });
    }
  }
  return result;
}

/**
 * Reconcile a chart's measures (a list of objects keyed by `field`). Measures
 * are kept when they resolve, remapped to a type-compatible field when one is
 * available, and dropped otherwise. A measure with a numeric aggregation only
 * remaps to a numeric field (Requirement 6.5); whether the resulting chart
 * still has at least one usable measure is checked by the caller for the
 * required-role enforcement (Requirement 6.3).
 */
function reconcileMeasures(
  measures: ChartMeasure[],
  primaryCollection: string,
  indexes: Map<string, FieldIndex>,
  adjustments: ValidationAdjustment[],
): ChartMeasure[] {
  const result: ChartMeasure[] = [];
  for (const measure of measures) {
    const usage: FieldUsage = { kind: 'measure', aggregation: measure.aggregation };
    const resolution = classifyRef(measure.field, primaryCollection, indexes, usage);
    if (resolution.kind === 'kept') {
      result.push(measure);
    } else if (resolution.kind === 'remapped') {
      result.push({ ...measure, field: resolution.replacement });
      adjustments.push({
        reference: measure.field,
        action: 'remapped',
        replacement: resolution.replacement,
        reason: resolution.reason,
      });
    } else {
      adjustments.push({
        reference: measure.field,
        action: 'removed',
        reason: 'no compatible field for measure',
      });
    }
  }
  return result;
}

/** Reconcile every field reference inside a single chart item. */
function reconcileChart(
  chart: ChartSpecItem,
  primaryCollection: string,
  indexes: Map<string, FieldIndex>,
  adjustments: ValidationAdjustment[],
): ChartSpecItem {
  const next: ChartSpecItem = {
    ...chart,
    measures: reconcileMeasures(chart.measures, primaryCollection, indexes, adjustments),
  };
  if (chart.dimensions) {
    next.dimensions = reconcileDimensions(chart.dimensions, primaryCollection, indexes, adjustments);
  }
  return next;
}

/**
 * Enforce required roles after reconciliation (Requirement 6.3). A chart needs
 * at least one usable measure, and a chart/table/form block needs at least one
 * usable field; any block left short cannot satisfy a required role, so an
 * `unmet-role` adjustment is recorded and the fallback is signalled. Returns
 * `true` when at least one required role is unmet.
 */
function enforceRequiredRoles(spec: BlockSpec, next: BlockSpec, adjustments: ValidationAdjustment[]): boolean {
  let unmet = false;
  const flag = (reference: string, reason: string) => {
    adjustments.push({ reference, action: 'unmet-role', reason });
    unmet = true;
  };

  if (spec.blockType === 'chart') {
    const charts = next.charts ?? [];
    if (charts.length === 0) {
      flag('chart', 'no chart could be produced');
    }
    for (const chart of charts) {
      if (chart.measures.length === 0) {
        flag(`chart:${chart.key}`, 'required measure has no compatible field');
      }
    }
  } else if (next.charts) {
    // Non-chart block that still carries chart items: a chart with no usable
    // measure is still an unmet required role.
    for (const chart of next.charts) {
      if (chart.measures.length === 0) {
        flag(`chart:${chart.key}`, 'required measure has no compatible field');
      }
    }
  }

  if (spec.blockType === 'table') {
    if (!next.table || next.table.fields.length === 0) {
      flag('table.fields', 'no usable fields remain for the table');
    }
  } else if (next.table && next.table.fields.length === 0) {
    flag('table.fields', 'no usable fields remain for the table');
  }

  if (spec.blockType === 'form') {
    if (!next.form || next.form.fields.length === 0) {
      flag('form.fields', 'no usable fields remain for the form');
    }
  } else if (next.form && next.form.fields.length === 0) {
    flag('form.fields', 'no usable fields remain for the form');
  }

  return unmet;
}

/**
 * Build the aggregate {@link ValidationSummary} from the detailed adjustments
 * list (Requirement 6.7). `outcome` is `fallback` whenever the validator gave
 * up (`usedFallback`) and `validated` otherwise (Requirement 6.4).
 */
function summarize(adjustments: ValidationAdjustment[], usedFallback: boolean): ValidationSummary {
  let removedCount = 0;
  let remappedCount = 0;
  const unmetRoles: string[] = [];
  for (const adjustment of adjustments) {
    if (adjustment.action === 'removed') {
      removedCount += 1;
    } else if (adjustment.action === 'remapped') {
      remappedCount += 1;
    } else {
      unmetRoles.push(adjustment.reference);
    }
  }
  return {
    outcome: usedFallback ? 'fallback' : 'validated',
    removedCount,
    remappedCount,
    unmetRoles,
  };
}

/**
 * Validate a {@link BlockSpec} against the introspected {@link SchemaSummary}.
 *
 * Walks every field reference (`charts[].measures[].field`,
 * `charts[].dimensions[].field`, `table.fields[]`, `table.sortable[]`,
 * `form.fields[]`), keeping references that exist, remapping references to a
 * same-named field or a type-compatible field when possible, and removing
 * unresolved references. After reconciliation, required-role enforcement
 * (task 5.2) flips `usedFallback` to `true` when a chart has no usable measure
 * or a block has no usable fields. Before any of that, task 5.3 aborts with a
 * fallback when the spec's `primaryCollection` schema is unavailable, and the
 * result always carries an aggregate {@link ValidationSummary}. The input spec
 * is never mutated; a fresh spec is returned alongside the list of adjustments.
 */
export function validate(spec: BlockSpec, summary: SchemaSummary): ValidationResult {
  const indexes = buildIndexes(summary);
  const adjustments: ValidationAdjustment[] = [];
  const primaryCollection = spec.primaryCollection;

  // Task 5.3 (Requirement 6.6): if the schema for the primary collection is
  // unavailable, do not attempt to clean a spec we cannot trust — record the
  // unavailability and signal the fallback. "Unavailable" here means the
  // primary collection is missing from the summary entirely, or present but
  // flagged `introspectionFailed`. Introspection (including the design's 5s
  // metadata-retrieval window) already happened upstream in the
  // CollectionIntrospector, so this layer needs no timer of its own; it only
  // inspects the summary it was handed.
  const primaryIndex = indexes.get(primaryCollection);
  const primarySummary = summary.collections.find((collection) => collection.name === primaryCollection);
  const primaryUnavailable = !primaryIndex || primarySummary?.introspectionFailed === true;
  if (primaryUnavailable) {
    adjustments.push({
      reference: primaryCollection,
      action: 'unmet-role',
      reason: 'schema unavailable',
    });
    return { spec, adjustments, usedFallback: true, summary: summarize(adjustments, true) };
  }

  const next: BlockSpec = { ...spec };

  if (spec.charts) {
    next.charts = spec.charts.map((chart) => reconcileChart(chart, primaryCollection, indexes, adjustments));
  }

  if (spec.table) {
    next.table = {
      ...spec.table,
      fields: reconcileStringList(spec.table.fields, primaryCollection, indexes, adjustments),
    };
    if (spec.table.sortable) {
      next.table.sortable = reconcileStringList(spec.table.sortable, primaryCollection, indexes, adjustments);
    }
  }

  if (spec.form) {
    next.form = {
      ...spec.form,
      fields: reconcileStringList(spec.form.fields, primaryCollection, indexes, adjustments),
    };
  }

  const usedFallback = enforceRequiredRoles(spec, next, adjustments);

  return { spec: next, adjustments, usedFallback, summary: summarize(adjustments, usedFallback) };
}

export default validate;
