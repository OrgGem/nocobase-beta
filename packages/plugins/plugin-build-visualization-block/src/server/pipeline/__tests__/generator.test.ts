/**
 * Unit and property-based tests for the Schema Generator.
 *
 * These tests drive the pure builders ({@link generateChartSchema} /
 * {@link generateTableSchema} / {@link generateFormSchema}) and the public
 * {@link generate} contract directly — no server boot is required, because the
 * generator is a pure function over a {@link BlockSpec} (+ a {@link SchemaSummary}
 * the chart/table/form paths intentionally ignore).
 *
 * Property-based coverage:
 * - Property 1 (key uniqueness, Req 7.3): for many randomized VALID specs, every
 *   generated node key is unique across the emitted tree. NocoBase's ported core
 *   schemas legitimately reuse a small set of *structural* literal keys
 *   (`actions`, `grid`) at different nesting levels — those are sibling-scoped
 *   framework conventions, not generated identifiers, so the global-uniqueness
 *   invariant of Req 7.3 ("assign a unique property key to every generated schema
 *   node") is asserted over the generated keys (every key except that reserved
 *   structural set). A `uid()` collision — the real failure mode Req 7.3 guards
 *   against — would still surface as a duplicate.
 * - Property 4 (chart binds ACL, Req 13.3): for many randomized chart specs,
 *   every chart block node's `x-acl-action` equals `<primaryCollection>:list`.
 *
 * `fast-check` is not a dependency of this repository and AGENTS.md forbids
 * adding new runtime dependencies, so the property tests use a small seeded
 * deterministic PRNG (`mulberry32`) and a fixed iteration count. The seed is
 * fixed so failures are reproducible.
 */

import type { ISchema } from '@formily/react';
import { describe, expect, it } from 'vitest';

import type { BlockSpec, ChartSpecItem, SchemaSummary } from '../../../shared/blockSpec';
import { generate, generateChartSchema, generateFormSchema, generateTableSchema } from '../generator';

// ---------------------------------------------------------------------------
// Schema traversal helpers (typed without `any`).
// ---------------------------------------------------------------------------

/** A schema node viewed as an open record so `x-*` keys can be read safely. */
type Node = Record<string, unknown>;

/** View an {@link ISchema} as an open record for traversal/reads. */
function asNode(schema: ISchema): Node {
  return schema as unknown as Node;
}

/** The `[key, childNode]` entries of a node's `properties`, or `[]`. */
function propertyEntries(node: Node): Array<[string, Node]> {
  const props = node.properties;
  if (props && typeof props === 'object') {
    return Object.entries(props as Record<string, Node>);
  }
  return [];
}

/** Invoke `visit` on `node` and every descendant reachable via `properties`. */
function eachNode(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const [, child] of propertyEntries(node)) {
    eachNode(child, visit);
  }
}

/** Collect every property key declared anywhere in the tree (recursively). */
function collectPropertyKeys(schema: ISchema): string[] {
  const keys: string[] = [];
  const walk = (node: Node): void => {
    for (const [key, child] of propertyEntries(node)) {
      keys.push(key);
      walk(child);
    }
  };
  walk(asNode(schema));
  return keys;
}

/** Read a string-valued attribute (e.g. an `x-*` key) from a node, or undefined. */
function str(node: Node, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

/** All nodes (root + descendants) for which `predicate` holds. */
function findNodes(schema: ISchema, predicate: (node: Node) => boolean): Node[] {
  const matches: Node[] = [];
  eachNode(asNode(schema), (node) => {
    if (predicate(node)) {
      matches.push(node);
    }
  });
  return matches;
}

/** Nodes whose `x-decorator` equals `name`. */
function nodesByDecorator(schema: ISchema, name: string): Node[] {
  return findNodes(schema, (node) => str(node, 'x-decorator') === name);
}

/** Nodes whose `x-component` equals `name`. */
function nodesByComponent(schema: ISchema, name: string): Node[] {
  return findNodes(schema, (node) => str(node, 'x-component') === name);
}

/** Every distinct `x-decorator` value present in the tree. */
function decoratorSet(schema: ISchema): Set<string> {
  const set = new Set<string>();
  eachNode(asNode(schema), (node) => {
    const value = str(node, 'x-decorator');
    if (value) set.add(value);
  });
  return set;
}

/** Every distinct `x-component` value present in the tree. */
function componentSet(schema: ISchema): Set<string> {
  const set = new Set<string>();
  eachNode(asNode(schema), (node) => {
    const value = str(node, 'x-component');
    if (value) set.add(value);
  });
  return set;
}

/** Every distinct `x-`-prefixed attribute key present on any node in the tree. */
function xAttributeKeys(schema: ISchema): Set<string> {
  const set = new Set<string>();
  eachNode(asNode(schema), (node) => {
    for (const key of Object.keys(node)) {
      if (key.startsWith('x-')) set.add(key);
    }
  });
  return set;
}

/** Collect the `x-collection-field` bindings declared anywhere in the tree. */
function collectionFieldBindings(schema: ISchema): string[] {
  const bindings: string[] = [];
  eachNode(asNode(schema), (node) => {
    const value = str(node, 'x-collection-field');
    if (value) bindings.push(value);
  });
  return bindings;
}

// ---------------------------------------------------------------------------
// Spec fixtures + a minimal summary (the chart/table/form paths ignore it).
// ---------------------------------------------------------------------------

/** A minimal summary for the paths that bind purely from the spec. */
const EMPTY_SUMMARY: SchemaSummary = { dataSource: 'main', collections: [] };

/** A summary whose primary collection has an `id` field (fallback-friendly). */
const SUMMARY_WITH_ID: SchemaSummary = {
  dataSource: 'main',
  collections: [
    {
      name: 'orders',
      fields: [
        { name: 'id', type: 'bigInt', interface: 'integer', title: 'ID' },
        { name: 'status', type: 'string', interface: 'select', title: 'Status' },
        { name: 'createdAt', type: 'date', interface: 'createdAt', title: 'Created' },
      ],
      relations: [],
    },
  ],
};

function chartSpec(): BlockSpec {
  return {
    version: 1,
    blockType: 'chart',
    title: 'Orders overview',
    primaryCollection: 'orders',
    dataSource: 'main',
    charts: [
      {
        key: 'by-status',
        title: 'Orders by status',
        chartType: 'ant-design-charts.pie',
        measures: [{ field: 'id', aggregation: 'count', alias: 'value' }],
        dimensions: [{ field: 'status', alias: 'status' }],
        config: { angleField: 'value', colorField: 'status' },
      },
      {
        key: 'total',
        title: 'Total orders',
        chartType: 'antd.statistic',
        measures: [{ field: 'id', aggregation: 'count', alias: 'value' }],
      },
    ],
  };
}

function tableSpec(): BlockSpec {
  return {
    version: 1,
    blockType: 'table',
    title: 'Posts',
    primaryCollection: 'posts',
    dataSource: 'main',
    table: { fields: ['title', 'status', 'createdAt'] },
  };
}

function formSpec(): BlockSpec {
  return {
    version: 1,
    blockType: 'form',
    title: 'New post',
    primaryCollection: 'posts',
    dataSource: 'main',
    form: { fields: ['title', 'body'], mode: 'create' },
  };
}

// ---------------------------------------------------------------------------
// Unit tests — chart path (Req 7.1, 7.3, 7.4, 13.3 / Property 4).
// ---------------------------------------------------------------------------

describe('generateChartSchema', () => {
  it('builds the data-visualization component tree with one renderer per chart', () => {
    const spec = chartSpec();
    const schema = generateChartSchema(spec, EMPTY_SUMMARY);

    // Outer block: ChartCardItem / ChartBlockProvider / ChartV2Block (Req 7.1).
    expect(componentSet(schema).has('ChartCardItem')).toBe(true);
    expect(decoratorSet(schema).has('ChartBlockProvider')).toBe(true);
    expect(decoratorSet(schema).has('ChartV2Block')).toBe(true);

    // One ChartRendererProvider / ChartRenderer pair per chart in the spec.
    const renderers = nodesByDecorator(schema, 'ChartRendererProvider');
    expect(renderers).toHaveLength(spec.charts?.length ?? 0);
    expect(nodesByComponent(schema, 'ChartRenderer')).toHaveLength(spec.charts?.length ?? 0);
  });

  it('binds every renderer to `<primaryCollection>:list` (Req 13.3)', () => {
    const spec = chartSpec();
    const schema = generateChartSchema(spec, EMPTY_SUMMARY);

    const renderers = nodesByDecorator(schema, 'ChartRendererProvider');
    expect(renderers.length).toBeGreaterThan(0);
    for (const renderer of renderers) {
      expect(str(renderer, 'x-acl-action')).toBe(`${spec.primaryCollection}:list`);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests — table path (Req 7.2, 7.3, 7.4, 13.3).
// ---------------------------------------------------------------------------

describe('generateTableSchema', () => {
  it('builds a TableBlockProvider / TableV2 block with one column per field', () => {
    const spec = tableSpec();
    const fields = spec.table?.fields ?? [];
    const schema = generateTableSchema(spec, EMPTY_SUMMARY);

    expect(decoratorSet(schema).has('TableBlockProvider')).toBe(true);
    expect(componentSet(schema).has('TableV2')).toBe(true);

    // A field column per spec field (the action column uses a different decorator).
    const fieldColumns = findNodes(
      schema,
      (node) =>
        str(node, 'x-component') === 'TableV2.Column' && str(node, 'x-decorator') === 'TableV2.Column.Decorator',
    );
    expect(fieldColumns).toHaveLength(fields.length);

    // Each field is rendered via `<collection>.<field>` (Req 7.2).
    expect(collectionFieldBindings(schema).sort()).toEqual(fields.map((f) => `${spec.primaryCollection}.${f}`).sort());
  });

  it('carries `x-acl-action: <collection>:list` on the block node (Req 13.3)', () => {
    const spec = tableSpec();
    const schema = generateTableSchema(spec, EMPTY_SUMMARY);

    const providers = nodesByDecorator(schema, 'TableBlockProvider');
    expect(providers).toHaveLength(1);
    expect(str(providers[0], 'x-acl-action')).toBe(`${spec.primaryCollection}:list`);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — form path (Req 7.2, 7.3, 7.4).
// ---------------------------------------------------------------------------

describe('generateFormSchema', () => {
  it('builds a FormBlockProvider / FormV2 block with one field item per field', () => {
    const spec = formSpec();
    const fields = spec.form?.fields ?? [];
    const schema = generateFormSchema(spec, EMPTY_SUMMARY);

    expect(decoratorSet(schema).has('FormBlockProvider')).toBe(true);
    expect(componentSet(schema).has('FormV2')).toBe(true);

    // One CollectionField (FormItem) per spec field (Req 7.2).
    const fieldItems = findNodes(
      schema,
      (node) => str(node, 'x-component') === 'CollectionField' && str(node, 'x-decorator') === 'FormItem',
    );
    expect(fieldItems).toHaveLength(fields.length);
    expect(collectionFieldBindings(schema).sort()).toEqual(fields.map((f) => `${spec.primaryCollection}.${f}`).sort());
  });

  it('uses the create-form ACL action for `mode: create`', () => {
    const schema = generateFormSchema(formSpec(), EMPTY_SUMMARY);
    const providers = nodesByDecorator(schema, 'FormBlockProvider');
    expect(providers).toHaveLength(1);
    expect(str(providers[0], 'x-acl-action')).toBe('posts:create');
  });
});

// ---------------------------------------------------------------------------
// Unit tests — required `x-*` keys on block-level nodes (Req 7.4).
// ---------------------------------------------------------------------------

describe('block-level x-* keys (Req 7.4)', () => {
  const required = ['x-decorator', 'x-component', 'x-settings', 'x-initializer'];

  it.each([
    ['chart', chartSpec()],
    ['table', tableSpec()],
    ['form', formSpec()],
  ] as const)('every required x-* key is present in the %s schema tree', (_label, spec) => {
    const result = generate(spec, EMPTY_SUMMARY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const present = xAttributeKeys(result.schema);
    for (const key of required) {
      expect(present.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests — GenerateResult contract: empty spec → fallback (Req 7.5).
// ---------------------------------------------------------------------------

describe('generate (empty / unproducible spec → fallback, Req 7.5)', () => {
  it.each([
    ['chart with no charts', { ...chartSpec(), charts: [] } as BlockSpec],
    ['table with no fields', { ...tableSpec(), table: { fields: [] } } as BlockSpec],
    ['form with no fields', { ...formSpec(), form: { fields: [] } } as BlockSpec],
  ])('returns a fallback schema for a %s', (_label, spec) => {
    const result = generate(spec, SUMMARY_WITH_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(true);
    expect(result.schema).toBeDefined();
    // The fallback is always a chart overview bound to the summary's collection.
    expect(decoratorSet(result.schema).has('ChartBlockProvider')).toBe(true);
  });

  it('marks a directly-produced spec as not using the fallback', () => {
    const result = generate(chartSpec(), EMPTY_SUMMARY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usedFallback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — error path: no partial schema (Req 7.6 / Property 5).
// ---------------------------------------------------------------------------

describe('generate (generation error → no partial schema, Req 7.6)', () => {
  it('returns an error result and emits no schema when construction throws', () => {
    // A chart spec that is "producible" (charts.length > 0) but whose single
    // chart is malformed (no `measures`) — this reaches the internal builder and
    // makes `createChartSchema` throw on `chart.measures.map(...)`. This is the
    // only way generation throws *after* the producibility gate: an unknown
    // `blockType` is treated as unproducible and routed to the fallback before
    // `generateSchema` is reached, so the throwing dispatcher path is exercised
    // here through the malformed-but-producible chart instead.
    const malformed: BlockSpec = {
      version: 1,
      blockType: 'chart',
      title: 'Broken',
      primaryCollection: 'orders',
      dataSource: 'main',
      charts: [{} as ChartSpecItem],
    };

    const result = generate(malformed, EMPTY_SUMMARY);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    // No partial schema object is emitted on the failure result.
    expect('schema' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG + valid-spec generators for the property tests.
// ---------------------------------------------------------------------------

/** Deterministic 32-bit PRNG (mulberry32). Returns a float in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] inclusive. */
function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Pick one element from a non-empty list. */
function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[intBetween(rng, 0, items.length - 1)];
}

const COLLECTION_POOL = ['orders', 'posts', 'users', 'invoices', 'products'] as const;
const FIELD_POOL = [
  'id',
  'title',
  'status',
  'amount',
  'createdAt',
  'updatedAt',
  'name',
  'total',
  'category',
  'priority',
] as const;
const CHART_TYPE_POOL = [
  'ant-design-charts.pie',
  'ant-design-charts.line',
  'ant-design-charts.column',
  'antd.statistic',
] as const;
const AGGREGATIONS = ['count', 'sum', 'avg', 'max', 'min'] as const;

/** A set of `count` distinct field names drawn from the pool. */
function distinctFields(rng: () => number, count: number): string[] {
  const shuffled = [...FIELD_POOL].sort(() => rng() - 0.5);
  return shuffled.slice(0, count);
}

function randomChartSpec(rng: () => number): BlockSpec {
  const primaryCollection = pick(rng, COLLECTION_POOL);
  const chartCount = intBetween(rng, 1, 4);
  const charts: ChartSpecItem[] = [];
  for (let i = 0; i < chartCount; i += 1) {
    const measureCount = intBetween(rng, 1, 3);
    const measures = Array.from({ length: measureCount }, (_, m) => ({
      field: pick(rng, FIELD_POOL),
      aggregation: pick(rng, AGGREGATIONS),
      alias: `m${i}_${m}`,
    }));
    const dimensionCount = intBetween(rng, 0, 2);
    const dimensions = Array.from({ length: dimensionCount }, (_, d) => ({
      field: pick(rng, FIELD_POOL),
      alias: `d${i}_${d}`,
    }));
    charts.push({
      key: `chart-${i}`,
      title: `Chart ${i}`,
      chartType: pick(rng, CHART_TYPE_POOL),
      measures,
      dimensions,
    });
  }
  return {
    version: 1,
    blockType: 'chart',
    title: 'Generated chart',
    primaryCollection,
    dataSource: 'main',
    charts,
  };
}

function randomTableSpec(rng: () => number): BlockSpec {
  return {
    version: 1,
    blockType: 'table',
    title: 'Generated table',
    primaryCollection: pick(rng, COLLECTION_POOL),
    dataSource: 'main',
    table: { fields: distinctFields(rng, intBetween(rng, 1, 6)) },
  };
}

function randomFormSpec(rng: () => number): BlockSpec {
  return {
    version: 1,
    blockType: 'form',
    title: 'Generated form',
    primaryCollection: pick(rng, COLLECTION_POOL),
    dataSource: 'main',
    form: {
      fields: distinctFields(rng, intBetween(rng, 1, 6)),
      mode: pick(rng, ['create', 'edit'] as const),
    },
  };
}

function randomValidBlockSpec(rng: () => number): BlockSpec {
  switch (intBetween(rng, 0, 2)) {
    case 0:
      return randomChartSpec(rng);
    case 1:
      return randomTableSpec(rng);
    default:
      return randomFormSpec(rng);
  }
}

/**
 * Structural literal keys that NocoBase's ported core schemas reuse across
 * nesting levels (sibling-scoped framework conventions, not generated ids). They
 * are excluded from the global key-uniqueness assertion — see the file header.
 */
const RESERVED_STRUCTURAL_KEYS = new Set(['actions', 'grid']);

const PROPERTY_ITERATIONS = 200;
const PROPERTY_SEED = 0x5eed1234;

// ---------------------------------------------------------------------------
// Property 1 — SchemaGenerator key uniqueness (Req 7.3).
// ---------------------------------------------------------------------------

describe('Property 1: SchemaGenerator key uniqueness', () => {
  // Validates: Requirements 7.3
  it('generated node keys are globally unique across the emitted schema', () => {
    const rng = mulberry32(PROPERTY_SEED);
    for (let iteration = 0; iteration < PROPERTY_ITERATIONS; iteration += 1) {
      const spec = randomValidBlockSpec(rng);
      const result = generate(spec, EMPTY_SUMMARY);

      expect(result.ok, `spec ${JSON.stringify(spec)} should generate`).toBe(true);
      if (!result.ok) continue;

      const keys = collectPropertyKeys(result.schema).filter((key) => !RESERVED_STRUCTURAL_KEYS.has(key));
      const distinct = new Set(keys);
      expect(distinct.size, `duplicate generated key for spec ${JSON.stringify(spec)}`).toBe(keys.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 4 — Generated chart binds ACL (Req 13.3).
// ---------------------------------------------------------------------------

describe('Property 4: generated chart binds ACL', () => {
  // Validates: Requirements 13.3
  it('every chart block node carries `x-acl-action` = `<primaryCollection>:list`', () => {
    const rng = mulberry32(PROPERTY_SEED ^ 0x1357);
    for (let iteration = 0; iteration < PROPERTY_ITERATIONS; iteration += 1) {
      const spec = randomChartSpec(rng);
      const result = generate(spec, EMPTY_SUMMARY);

      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const renderers = nodesByDecorator(result.schema, 'ChartRendererProvider');
      expect(renderers.length, `expected one renderer per chart for ${JSON.stringify(spec.charts?.length)}`).toBe(
        spec.charts?.length ?? 0,
      );
      for (const renderer of renderers) {
        expect(str(renderer, 'x-acl-action')).toBe(`${spec.primaryCollection}:list`);
      }
    }
  });
});
