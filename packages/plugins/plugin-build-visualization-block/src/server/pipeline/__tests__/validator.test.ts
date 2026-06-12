/**
 * Unit and property-based tests for the Spec Validator.
 *
 * These tests drive {@link validate} directly with hand-built {@link BlockSpec}
 * and {@link SchemaSummary} values — the validator is a pure function over
 * structured input, so no server boot is required.
 *
 * The property-based suite verifies Correctness Property 2 ("SpecValidator
 * soundness"): for any spec combined with any schema, the validated output
 * never references a field absent from the schema unless the validator fell
 * back. `fast-check` is not a dependency of this repository (and per the repo
 * rules we do not add new runtime/dev dependencies for this task), so the
 * property is exercised with a deterministic, seeded pseudo-random generator
 * that produces many randomized spec/summary pairs. The seeding keeps failures
 * reproducible the same way a property library's shrinking seed would.
 */

import type {
  Aggregation,
  BlockSpec,
  ChartMeasure,
  ChartSpecItem,
  CollectionSummary,
  FieldMeta,
  SchemaSummary,
} from '../../../shared/blockSpec';
import { describe, expect, it } from 'vitest';

import { validate } from '../validator';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Build a {@link FieldMeta}; `title` defaults to the field name. */
function field(name: string, type: string, iface: string, title?: string): FieldMeta {
  return { name, type, interface: iface, title: title ?? name };
}

/** Build a {@link CollectionSummary} with no relations by default. */
function collection(name: string, fields: FieldMeta[], introspectionFailed?: boolean): CollectionSummary {
  const summary: CollectionSummary = { name, fields, relations: [] };
  if (introspectionFailed) {
    summary.introspectionFailed = true;
  }
  return summary;
}

/** Build a {@link SchemaSummary}. */
function summaryOf(collections: CollectionSummary[], dataSource = 'main'): SchemaSummary {
  return { dataSource, collections };
}

/** Build a minimal chart spec with a single chart item. */
function chartSpec(primaryCollection: string, measures: ChartMeasure[], dimensions?: { field: string }[]): BlockSpec {
  const chart: ChartSpecItem = {
    key: 'chart-1',
    title: 'Chart',
    chartType: 'ant-design-charts.pie',
    measures,
  };
  if (dimensions) {
    chart.dimensions = dimensions;
  }
  return {
    version: 1,
    blockType: 'chart',
    title: 'Test chart',
    primaryCollection,
    dataSource: 'main',
    charts: [chart],
  };
}

/** Build a table-type block spec. */
function tableSpec(primaryCollection: string, fields: string[], sortable?: string[]): BlockSpec {
  return {
    version: 1,
    blockType: 'table',
    title: 'Test table',
    primaryCollection,
    dataSource: 'main',
    table: sortable ? { fields, sortable } : { fields },
  };
}

/** Build a form-type block spec. */
function formSpec(primaryCollection: string, fields: string[]): BlockSpec {
  return {
    version: 1,
    blockType: 'form',
    title: 'Test form',
    primaryCollection,
    dataSource: 'main',
    form: { fields },
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('validate (unit)', () => {
  it('passes a fully valid spec through unchanged and reports validated', () => {
    const summary = summaryOf([
      collection('posts', [field('id', 'bigInt', 'integer'), field('title', 'string', 'input')]),
    ]);
    const spec = tableSpec('posts', ['id', 'title']);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(false);
    expect(result.summary.outcome).toBe('validated');
    expect(result.adjustments).toEqual([]);
    expect(result.spec.table?.fields).toEqual(['id', 'title']);
    // The input is never mutated; a fresh spec is returned.
    expect(result.spec).not.toBe(spec);
  });

  it('removes a non-existent optional field and records the removal', () => {
    const summary = summaryOf([
      collection('posts', [field('id', 'bigInt', 'integer'), field('title', 'string', 'input')]),
    ]);
    // `id` exists (keeps the table usable); `nope` has no field or name match.
    const spec = tableSpec('posts', ['id', 'nope']);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(false);
    expect(result.spec.table?.fields).toEqual(['id']);
    expect(result.adjustments).toEqual([{ reference: 'nope', action: 'removed', reason: 'field does not exist' }]);
    expect(result.summary).toMatchObject({ outcome: 'validated', removedCount: 1, remappedCount: 0 });
  });

  it('remaps a reference to a same-named case-insensitive match', () => {
    const summary = summaryOf([
      collection('posts', [field('id', 'bigInt', 'integer'), field('Title', 'string', 'input')]),
    ]);
    const spec = tableSpec('posts', ['id', 'title']);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(false);
    expect(result.spec.table?.fields).toEqual(['id', 'Title']);
    expect(result.adjustments).toEqual([
      {
        reference: 'title',
        action: 'remapped',
        replacement: 'Title',
        reason: 'case-insensitive name match',
      },
    ]);
    expect(result.summary).toMatchObject({ remappedCount: 1, removedCount: 0 });
  });

  it('remaps a missing numeric measure to an existing numeric field', () => {
    const summary = summaryOf([
      collection('sales', [field('name', 'string', 'input'), field('price', 'float', 'number')]),
    ]);
    const spec = chartSpec('sales', [{ field: 'amount', aggregation: 'sum', alias: 'total' }]);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(false);
    expect(result.spec.charts?.[0].measures).toEqual([{ field: 'price', aggregation: 'sum', alias: 'total' }]);
    expect(result.adjustments).toEqual([
      {
        reference: 'amount',
        action: 'remapped',
        replacement: 'price',
        reason: 'type-compatible remap',
      },
    ]);
  });

  it('drops a sum measure when no numeric field exists and falls back (unmet role)', () => {
    const summary = summaryOf([
      collection('logs', [field('message', 'string', 'input'), field('level', 'string', 'select')]),
    ]);
    const spec = chartSpec('logs', [{ field: 'count_val', aggregation: 'sum', alias: 'c' }]);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(true);
    expect(result.summary.outcome).toBe('fallback');
    expect(result.spec.charts?.[0].measures).toEqual([]);
    // The measure is dropped (no compatible field)...
    expect(result.adjustments).toContainEqual({
      reference: 'count_val',
      action: 'removed',
      reason: 'no compatible field for measure',
    });
    // ...leaving the chart with no usable measure → unmet required role.
    expect(result.adjustments).toContainEqual({
      reference: 'chart:chart-1',
      action: 'unmet-role',
      reason: 'required measure has no compatible field',
    });
    expect(result.summary.unmetRoles).toEqual(['chart:chart-1']);
  });

  it('falls back when a table is left with no usable fields (required role unmet)', () => {
    const summary = summaryOf([
      collection('posts', [field('id', 'bigInt', 'integer'), field('title', 'string', 'input')]),
    ]);
    const spec = tableSpec('posts', ['ghost1', 'ghost2']);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(true);
    expect(result.summary.outcome).toBe('fallback');
    expect(result.spec.table?.fields).toEqual([]);
    expect(result.adjustments).toContainEqual({
      reference: 'table.fields',
      action: 'unmet-role',
      reason: 'no usable fields remain for the table',
    });
    expect(result.summary.unmetRoles).toEqual(['table.fields']);
    expect(result.summary.removedCount).toBe(2);
  });

  it('falls back when a form is left with no usable fields (required role unmet)', () => {
    const summary = summaryOf([collection('posts', [field('id', 'bigInt', 'integer')])]);
    const spec = formSpec('posts', ['ghost']);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(true);
    expect(result.summary.outcome).toBe('fallback');
    expect(result.spec.form?.fields).toEqual([]);
    expect(result.summary.unmetRoles).toEqual(['form.fields']);
  });

  it('aborts early when the primary collection is absent from the summary', () => {
    const summary = summaryOf([collection('posts', [field('id', 'bigInt', 'integer')])]);
    const spec = tableSpec('ghost', ['id']);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(true);
    expect(result.summary.outcome).toBe('fallback');
    // The original spec is returned untouched (no cleaning attempted).
    expect(result.spec).toBe(spec);
    expect(result.adjustments).toEqual([{ reference: 'ghost', action: 'unmet-role', reason: 'schema unavailable' }]);
    expect(result.summary.unmetRoles).toEqual(['ghost']);
  });

  it('aborts early when the primary collection introspection failed', () => {
    const summary = summaryOf([collection('posts', [field('id', 'bigInt', 'integer')], true)]);
    const spec = tableSpec('posts', ['id']);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(true);
    expect(result.summary.outcome).toBe('fallback');
    expect(result.spec).toBe(spec);
    expect(result.adjustments).toEqual([{ reference: 'posts', action: 'unmet-role', reason: 'schema unavailable' }]);
  });

  it('populates removed/remapped/unmet counts together', () => {
    const summary = summaryOf([
      collection('posts', [field('id', 'bigInt', 'integer'), field('Title', 'string', 'input')]),
    ]);
    // id kept, title → Title remapped, ghost removed.
    const spec = tableSpec('posts', ['id', 'title', 'ghost']);

    const result = validate(spec, summary);

    expect(result.usedFallback).toBe(false);
    expect(result.spec.table?.fields).toEqual(['id', 'Title']);
    expect(result.summary).toEqual({
      outcome: 'validated',
      removedCount: 1,
      remappedCount: 1,
      unmetRoles: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Property-based test: Correctness Property 2 — SpecValidator soundness
// ---------------------------------------------------------------------------

/**
 * Deterministic, seeded PRNG (mulberry32). Returns a function producing floats
 * in [0, 1). Seeding makes any property failure reproducible.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const randInt = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

/** Field templates spanning numeric, categorical, temporal, and other types. */
const FIELD_TEMPLATES: ReadonlyArray<{ name: string; type: string; interface: string }> = [
  { name: 'id', type: 'bigInt', interface: 'integer' },
  { name: 'price', type: 'float', interface: 'number' },
  { name: 'amount', type: 'integer', interface: 'integer' },
  { name: 'title', type: 'string', interface: 'input' },
  { name: 'status', type: 'string', interface: 'select' },
  { name: 'createdAt', type: 'date', interface: 'createdAt' },
  { name: 'name', type: 'string', interface: 'input' },
];

const COLLECTION_NAMES = ['posts', 'authors', 'sales', 'logs'] as const;
const AGGREGATIONS: ReadonlyArray<Aggregation | undefined> = [undefined, 'count', 'sum', 'avg', 'max', 'min'];
/** Names that do not exist verbatim; some are case variants that may remap. */
const BOGUS_NAMES = ['ghost', 'missingField', 'xyz', 'Title', 'PRICE', 'Status'] as const;
const BLOCK_TYPES = ['chart', 'table', 'form'] as const;

/** Generate a random schema summary (1–3 collections, each 0–5 fields). */
function genSummary(rng: Rng): SchemaSummary {
  const count = randInt(rng, 1, 3);
  const names = [...COLLECTION_NAMES].sort(() => rng() - 0.5).slice(0, count);
  const collections = names.map((name) => {
    const fieldCount = randInt(rng, 0, 5);
    const chosen: FieldMeta[] = [];
    const used = new Set<string>();
    for (let i = 0; i < fieldCount; i += 1) {
      const tpl = pick(rng, FIELD_TEMPLATES);
      if (used.has(tpl.name)) {
        continue;
      }
      used.add(tpl.name);
      chosen.push(field(tpl.name, tpl.type, tpl.interface));
    }
    // Occasionally flag a non-primary collection as failed introspection.
    return collection(name, chosen, rng() < 0.1);
  });
  return summaryOf(collections);
}

/**
 * Generate a single field reference: usually a real field from the primary
 * collection, sometimes a bogus name, and sometimes a collection-qualified
 * reference into another collection in the summary.
 */
function genRef(rng: Rng, summary: SchemaSummary, primary: string): string {
  const primaryCol = summary.collections.find((c) => c.name === primary);
  const realNames = primaryCol ? primaryCol.fields.map((f) => f.name) : [];
  const roll = rng();
  if (roll < 0.55 && realNames.length > 0) {
    return pick(rng, realNames);
  }
  if (roll < 0.8) {
    return pick(rng, BOGUS_NAMES);
  }
  // Collection-qualified reference (may or may not resolve).
  const other = pick(rng, summary.collections);
  const otherNames = other.fields.map((f) => f.name);
  const fieldPart = otherNames.length > 0 && rng() < 0.6 ? pick(rng, otherNames) : pick(rng, BOGUS_NAMES);
  return `${other.name}.${fieldPart}`;
}

function genRefList(rng: Rng, summary: SchemaSummary, primary: string, max: number): string[] {
  const n = randInt(rng, 0, max);
  const list: string[] = [];
  for (let i = 0; i < n; i += 1) {
    list.push(genRef(rng, summary, primary));
  }
  return list;
}

/** Generate a random block spec whose references mix valid and invalid names. */
function genSpec(rng: Rng, summary: SchemaSummary): BlockSpec {
  // Mostly pick a primary that exists, but sometimes an unknown collection
  // (exercises the schema-unavailable abort path).
  const primary = rng() < 0.85 ? pick(rng, summary.collections).name : pick(rng, ['ghostCollection', 'nope']);
  const blockType = pick(rng, BLOCK_TYPES);

  if (blockType === 'chart') {
    const chartCount = randInt(rng, 1, 2);
    const charts: ChartSpecItem[] = [];
    for (let c = 0; c < chartCount; c += 1) {
      const measureCount = randInt(rng, 0, 3);
      const measures: ChartMeasure[] = [];
      for (let m = 0; m < measureCount; m += 1) {
        const aggregation = pick(rng, AGGREGATIONS);
        const measure: ChartMeasure = { field: genRef(rng, summary, primary), alias: `m${m}` };
        if (aggregation) {
          measure.aggregation = aggregation;
        }
        measures.push(measure);
      }
      const dimRefs = genRefList(rng, summary, primary, 2);
      const chart: ChartSpecItem = {
        key: `chart-${c}`,
        title: `Chart ${c}`,
        chartType: 'ant-design-charts.pie',
        measures,
      };
      if (dimRefs.length > 0) {
        chart.dimensions = dimRefs.map((f) => ({ field: f }));
      }
      charts.push(chart);
    }
    return {
      version: 1,
      blockType: 'chart',
      title: 'Chart',
      primaryCollection: primary,
      dataSource: 'main',
      charts,
    };
  }

  if (blockType === 'table') {
    return {
      version: 1,
      blockType: 'table',
      title: 'Table',
      primaryCollection: primary,
      dataSource: 'main',
      table: {
        fields: genRefList(rng, summary, primary, 5),
        sortable: genRefList(rng, summary, primary, 3),
      },
    };
  }

  return {
    version: 1,
    blockType: 'form',
    title: 'Form',
    primaryCollection: primary,
    dataSource: 'main',
    form: { fields: genRefList(rng, summary, primary, 5) },
  };
}

/**
 * Independent re-implementation of the validator's reference-existence check,
 * used to verify the output spec. A reference is collection-qualified only when
 * the segment before the first dot names a collection present in the summary;
 * otherwise it is a field on the primary collection.
 */
function refExists(rawRef: string, primary: string, summary: SchemaSummary): boolean {
  let collectionName = primary;
  let fieldName = rawRef;
  const dot = rawRef.indexOf('.');
  if (dot > 0) {
    const head = rawRef.slice(0, dot);
    if (summary.collections.some((c) => c.name === head)) {
      collectionName = head;
      fieldName = rawRef.slice(dot + 1);
    }
  }
  const col = summary.collections.find((c) => c.name === collectionName);
  if (!col) {
    return false;
  }
  return col.fields.some((f) => f.name !== '' && f.name === fieldName);
}

/** Collect every field reference present in the (output) spec. */
function collectRefs(spec: BlockSpec): string[] {
  const refs: string[] = [];
  for (const chart of spec.charts ?? []) {
    for (const measure of chart.measures) {
      refs.push(measure.field);
    }
    for (const dimension of chart.dimensions ?? []) {
      refs.push(dimension.field);
    }
  }
  if (spec.table) {
    refs.push(...spec.table.fields);
    refs.push(...(spec.table.sortable ?? []));
  }
  if (spec.form) {
    refs.push(...spec.form.fields);
  }
  return refs;
}

describe('validate (property: SpecValidator soundness)', () => {
  it('never reports validated while keeping a dangling field reference', () => {
    const iterations = 500;
    for (let i = 0; i < iterations; i += 1) {
      const rng = mulberry32(0x5eed + i);
      const summary = genSummary(rng);
      const spec = genSpec(rng, summary);

      const result = validate(spec, summary);
      const outputRefs = collectRefs(result.spec);

      // Invariant: outcome mirrors the usedFallback flag.
      expect(result.summary.outcome).toBe(result.usedFallback ? 'fallback' : 'validated');

      if (!result.usedFallback) {
        // Soundness: a validated result must not keep any dangling reference.
        for (const ref of outputRefs) {
          const exists = refExists(ref, result.spec.primaryCollection, summary);
          if (!exists) {
            throw new Error(
              `validated output kept dangling ref "${ref}" ` +
                `(seed=${0x5eed + i}, primary=${result.spec.primaryCollection}, ` +
                `spec=${JSON.stringify(result.spec)}, summary=${JSON.stringify(summary)})`,
            );
          }
          expect(exists).toBe(true);
        }
      }
    }
  });
});
