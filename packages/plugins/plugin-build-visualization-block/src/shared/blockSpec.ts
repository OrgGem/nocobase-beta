import { z } from 'zod';

/**
 * The kind of block a {@link BlockSpec} describes.
 */
export type BlockType = 'chart' | 'table' | 'form';

/**
 * A single aggregation applied to a measure field in a chart.
 */
export type Aggregation = 'count' | 'sum' | 'avg' | 'max' | 'min';

/**
 * A row-level action available on a table block.
 */
export type TableAction = 'view' | 'edit' | 'delete' | 'add';

/**
 * The mode a generated form block operates in.
 */
export type FormMode = 'create' | 'edit';

/**
 * A reference to a single field, scoped to a collection. Used where a spec
 * needs to point at a concrete field (the validator checks both the
 * `collection` and `field` against the introspected schema).
 */
export interface BlockSpecField {
  /** Must be one of the selected Target_Collections. */
  collection: string;
  /** Must exist in that collection. */
  field: string;
  /** Optional display title override. */
  title?: string;
}

/**
 * A measure (aggregated value) used by a chart.
 */
export interface ChartMeasure {
  /** Field name within the bound collection. */
  field: string;
  /** Aggregation function applied to the field. */
  aggregation?: Aggregation;
  /** Alias the aggregated value is exposed under. */
  alias: string;
  /** Whether to apply DISTINCT to the aggregation. */
  distinct?: boolean;
}

/**
 * A dimension (grouping/axis) used by a chart.
 */
export interface ChartDimension {
  /** Field name within the bound collection. */
  field: string;
  /** Alias the dimension is exposed under. */
  alias?: string;
  /** Optional value format (e.g. a date format string). */
  format?: string;
}

/**
 * A single chart within a chart-type block. A chart references fields
 * directly (rather than via abstract roles) to keep the AI contract simple.
 */
export interface ChartSpecItem {
  key: string;
  title: string;
  /** e.g. 'ant-design-charts.pie', 'antd.statistic'. */
  chartType: string;
  measures: ChartMeasure[];
  dimensions?: ChartDimension[];
  config?: Record<string, unknown>;
}

/**
 * The table-path payload of a {@link BlockSpec}.
 */
export interface TableSpec {
  fields: string[];
  sortable?: string[];
  actions?: TableAction[];
}

/**
 * The form-path payload of a {@link BlockSpec}.
 */
export interface FormSpec {
  fields: string[];
  mode?: FormMode;
}

/**
 * The structured JSON contract the LLM must produce. It is a superset of the
 * visualization-template model so the chart path can reuse the proven schema
 * builder, while also covering table and form blocks.
 */
export interface BlockSpec {
  version: 1;
  blockType: BlockType;
  title: string;
  /** The collection the block is bound to. */
  primaryCollection: string;
  dataSource: string;
  /** Chart path. */
  charts?: ChartSpecItem[];
  /** Table path. */
  table?: TableSpec;
  /** Form path. */
  form?: FormSpec;
  /** Explanation surfaced to the user. */
  rationale?: string;
}

const aggregationSchema = z.enum(['count', 'sum', 'avg', 'max', 'min']);

const chartMeasureSchema = z.object({
  field: z.string(),
  aggregation: aggregationSchema.optional(),
  alias: z.string(),
  distinct: z.boolean().optional(),
});

const chartDimensionSchema = z.object({
  field: z.string(),
  alias: z.string().optional(),
  format: z.string().optional(),
});

const chartSpecItemSchema = z.object({
  key: z.string(),
  title: z.string(),
  chartType: z.string(),
  measures: z.array(chartMeasureSchema),
  dimensions: z.array(chartDimensionSchema).optional(),
  config: z.record(z.unknown()).optional(),
});

const tableSpecSchema = z.object({
  fields: z.array(z.string()),
  sortable: z.array(z.string()).optional(),
  actions: z.array(z.enum(['view', 'edit', 'delete', 'add'])).optional(),
});

const formSpecSchema = z.object({
  fields: z.array(z.string()),
  mode: z.enum(['create', 'edit']).optional(),
});

/**
 * zod schema mirroring the {@link BlockSpec} interface. Used by the
 * SpecValidator / AIAnalyzer to validate the shape of parsed LLM output.
 */
export const blockSpecSchema = z.object({
  version: z.literal(1),
  blockType: z.enum(['chart', 'table', 'form']),
  title: z.string(),
  primaryCollection: z.string(),
  dataSource: z.string(),
  charts: z.array(chartSpecItemSchema).optional(),
  table: tableSpecSchema.optional(),
  form: formSpecSchema.optional(),
  rationale: z.string().optional(),
});

// Compile-time cross-checks: the hand-written interfaces remain the public
// contract, but these assertions ensure the zod schema stays aligned with them.
type SchemaInferred = z.infer<typeof blockSpecSchema>;
type AssertExtends<A extends B, B> = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SchemaMatchesInterface = AssertExtends<SchemaInferred, BlockSpec>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _InterfaceMatchesSchema = AssertExtends<BlockSpec, SchemaInferred>;

/**
 * Field metadata read from a live collection during introspection.
 */
export interface FieldMeta {
  name: string;
  type: string;
  interface: string;
  title: string;
}

/**
 * Relation metadata read from a live collection during introspection.
 */
export interface RelationMeta {
  name: string;
  type: string;
  target: string;
}

/**
 * A single collection's introspected schema.
 */
export interface CollectionSummary {
  name: string;
  fields: FieldMeta[];
  relations: RelationMeta[];
  /** Set when introspection of this collection failed; the collection is
   * still listed so downstream stages can decide how to proceed. */
  introspectionFailed?: boolean;
}

/**
 * The structured schema summary produced by the CollectionIntrospector and
 * consumed by the SpecValidator, SchemaGenerator, and fallback builder.
 */
export interface SchemaSummary {
  dataSource: string;
  collections: CollectionSummary[];
}
