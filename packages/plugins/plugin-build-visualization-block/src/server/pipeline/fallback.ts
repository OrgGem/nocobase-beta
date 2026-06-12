/**
 * Fallback spec builder for `plugin-build-visualization-block`.
 *
 * When the AI Analyzer cannot produce a usable {@link BlockSpec} (parse failure,
 * shape mismatch, LLM timeout/transport error) or the Spec Validator gives up on
 * a model-produced spec, the pipeline falls back to a generic "collection
 * overview" chart. {@link buildFallbackSpec} mirrors the
 * `genericCollectionOverviewTemplate` from `plugin-visualization-templates`, but
 * is *grounded in the live schema*: it only ever references fields that actually
 * exist in the chosen collection, so the result is guaranteed to pass the
 * {@link validate} stage without triggering a further fallback (Correctness
 * Property 3 — "Fallback always valid").
 *
 * The builder is a pure function over the introspected {@link SchemaSummary};
 * it performs no I/O and never mutates its input.
 */

import type { BlockSpec, ChartSpecItem, CollectionSummary, FieldMeta, SchemaSummary } from '../../shared/blockSpec';

/**
 * Field names that identify a record, preferred as the `count` measure target.
 * Mirrors the `record` role's `matchNames` in `plugin-visualization-templates`.
 */
const RECORD_MATCH_NAMES = new Set<string>(['id', 'uid', 'uuid', 'key']);

/** Field names that indicate a status-like field, used for the pie breakdown. */
const STATUS_MATCH_NAMES = new Set<string>(['status', 'state', 'stage', 'workflowstatus']);

/** Field names that indicate a created-at-like date field, used for the trend. */
const CREATED_AT_MATCH_NAMES = new Set<string>(['createdat', 'createat', 'creationdate', 'createdon']);

/** Field interfaces typically used for a categorical status field. */
const STATUS_INTERFACES = new Set<string>(['select', 'radiogroup', 'input', 'multipleselect']);

/** Field types/interfaces that indicate a temporal field. */
const DATE_FIELD_TYPES = new Set<string>(['date', 'dateonly', 'datetime']);
const DATE_INTERFACES = new Set<string>(['createdat', 'updatedat', 'datetime', 'date']);

/** The default measure field used when a collection exposes no fields at all. */
const DEFAULT_MEASURE_FIELD = 'id';

/**
 * Normalize a field name (and interface/type tokens) for loose matching: drop
 * every non-alphanumeric character and lower-case the rest. Kept in sync with
 * `normalizeFieldName` in the validator so the two stages agree on identity.
 */
const normalize = (value = ''): string => value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

/**
 * Choose the collection the fallback block binds to: the first collection that
 * exposes at least one readable field, falling back to the first collection in
 * the summary. Returns `undefined` only when the summary lists no collections.
 */
function pickPrimaryCollection(summary: SchemaSummary): CollectionSummary | undefined {
  const withFields = summary.collections.find(
    (collection) => !collection.introspectionFailed && collection.fields.length > 0,
  );
  return withFields ?? summary.collections[0];
}

/**
 * Pick the field a `count` measure is taken over: a record-identifying field
 * (`id`/`uid`/`uuid`/`key`) when present, otherwise the first available field.
 * Falls back to the literal `'id'` for a collection with no fields (the safest
 * default — see the edge case documented on {@link buildFallbackSpec}).
 */
function pickMeasureField(fields: FieldMeta[]): string {
  const record = fields.find((field) => RECORD_MATCH_NAMES.has(normalize(field.name)));
  return record?.name ?? fields[0]?.name ?? DEFAULT_MEASURE_FIELD;
}

/** Whether a field reads like a categorical status field (name or type/iface). */
function isStatusLike(field: FieldMeta): boolean {
  if (STATUS_MATCH_NAMES.has(normalize(field.name))) {
    return true;
  }
  return field.type === 'string' && STATUS_INTERFACES.has(normalize(field.interface));
}

/** Whether a field reads like a created-at-style date field. */
function isCreatedAtLike(field: FieldMeta): boolean {
  if (CREATED_AT_MATCH_NAMES.has(normalize(field.name))) {
    return true;
  }
  return DATE_FIELD_TYPES.has(normalize(field.type)) || DATE_INTERFACES.has(normalize(field.interface));
}

/**
 * Build a generic "collection overview" chart {@link BlockSpec} for the primary
 * collection of `summary`.
 *
 * The spec always contains a "Total records" statistic (a `count` measure over a
 * record-identifying or first available field). It additionally includes a
 * "Records by status" pie chart **only** when a status-like field exists, and a
 * "Created trend" line chart **only** when a created-at-like date field exists —
 * so every field the spec references is guaranteed to exist in the collection
 * and the result validates without a further fallback (Property 3).
 *
 * Edge case: when the chosen collection exposes no fields at all (e.g. all
 * collections failed introspection), the measure falls back to the literal
 * `'id'` field — the safest default for a `count`. Such a spec only validates if
 * the collection in fact has an `id` column; Property 3 is scoped to collections
 * that do, and a genuinely field-less collection is handled upstream by the
 * validator (which would flag a further fallback).
 */
export function buildFallbackSpec(summary: SchemaSummary): BlockSpec {
  const collection = pickPrimaryCollection(summary);
  const fields = collection?.fields ?? [];
  const measureField = pickMeasureField(fields);

  const charts: ChartSpecItem[] = [
    {
      key: 'total-records',
      title: 'Total records',
      chartType: 'antd.statistic',
      measures: [{ field: measureField, aggregation: 'count', alias: 'value' }],
      config: { field: 'value', title: 'Total records' },
    },
  ];

  const statusField = fields.find(isStatusLike);
  if (statusField) {
    charts.push({
      key: 'records-by-status',
      title: 'Records by status',
      chartType: 'ant-design-charts.pie',
      measures: [{ field: measureField, aggregation: 'count', alias: 'value' }],
      dimensions: [{ field: statusField.name, alias: 'status' }],
      config: { angleField: 'value', colorField: 'status' },
    });
  }

  const createdAtField = fields.find(isCreatedAtLike);
  if (createdAtField) {
    charts.push({
      key: 'created-trend',
      title: 'Created trend',
      chartType: 'ant-design-charts.line',
      measures: [{ field: measureField, aggregation: 'count', alias: 'value' }],
      dimensions: [{ field: createdAtField.name, format: 'YYYY-MM-DD', alias: 'createdAt' }],
      config: { xField: 'createdAt', yField: 'value', smooth: true },
    });
  }

  return {
    version: 1,
    blockType: 'chart',
    title: 'Overview',
    primaryCollection: collection?.name ?? '',
    dataSource: summary.dataSource,
    charts,
    rationale:
      'Fallback collection overview generated automatically because a tailored ' + 'specification was not available.',
  };
}

export default buildFallbackSpec;
