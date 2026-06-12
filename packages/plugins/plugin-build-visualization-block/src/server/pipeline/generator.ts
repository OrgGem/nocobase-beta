/**
 * Schema Generator pipeline stage for `plugin-build-visualization-block`.
 *
 * This module is built incrementally:
 * - Task 6.1 (this file) implements ONLY the chart path: it ports the schema
 *   construction from `plugin-visualization-templates`'s
 *   `createVisualizationTemplateSchema` (and its `createChartSchema` /
 *   `createRendererSchema` / `gridRowColWrap` helpers), adapted to consume
 *   {@link ChartSpecItem}[] taken directly from a {@link BlockSpec} (rather than
 *   a `VisualizationTemplate` + a field→role mapping). It produces the
 *   `ChartCardItem` / `ChartBlockProvider` outer block, the `ChartV2Block` grid,
 *   and one `ChartRendererProvider` / `ChartRenderer` card per chart, each
 *   carrying `x-acl-action: '<collection>:list'` (Requirements 7.1, 7.3, 7.4,
 *   13.3).
 * - Task 6.2 (this revision) adds the table and form paths:
 *   - {@link generateTableSchema} emits the standard NocoBase v1 Table block
 *     (`TableBlockProvider` decorator → `CardItem` → `TableV2`) ported from the
 *     core client's `createTableBlockUISchema`, with one
 *     `TableV2.Column.Decorator` / `TableV2.Column` column per
 *     `spec.table.fields` entry (each rendered via `x-collection-field`).
 *   - {@link generateFormSchema} emits the standard Form block
 *     (`FormBlockProvider` decorator → `CardItem` → `FormV2` → `Grid`) ported
 *     from the core client's `createCreateFormBlockUISchema` /
 *     `createEditFormBlockUISchema`, with one `Grid.Row` / `Grid.Col` /
 *     `CollectionField` (`FormItem`) item per `spec.form.fields` entry.
 *   Both bind to `spec.primaryCollection` / `spec.dataSource` and carry the
 *   `x-acl-action` the task requires (Requirements 7.2, 7.3, 7.4, 13.3).
 * - Task 6.3 (this revision) changes the public {@link generate} contract: it
 *   no longer throws or returns a bare schema. Instead it returns a
 *   {@link GenerateResult} discriminated union so callers can distinguish a
 *   normal result, a fallback result, and a hard failure:
 *   - Requirement 7.5: when the spec is empty/unproducible (a chart with no
 *     charts after validation, a table/form with no fields, or an unknown
 *     `blockType`), {@link generate} builds the FALLBACK spec from the
 *     introspected `summary`, generates its schema, and returns
 *     `{ ok: true, schema, usedFallback: true }`.
 *   - Requirement 7.6: the per-block construction is wrapped in try/catch; if
 *     generation throws after validation, {@link generate} returns
 *     `{ ok: false, error, failedNode }` and emits NO partial schema object.
 *   The pure builders ({@link generateChartSchema} / {@link generateTableSchema}
 *   / {@link generateFormSchema}) remain exported and may still throw
 *   internally — {@link generate} (via {@link generateSchema}) catches.
 *
 * The generator is a pure function over structured input: it never mutates the
 * spec it is given.
 */

import { uid } from '@formily/shared';
import type { ISchema } from '@formily/react';

import type { Aggregation, BlockSpec, ChartSpecItem, SchemaSummary } from '../../shared/blockSpec';
import { buildFallbackSpec } from './fallback';

/** The default aggregation applied to a measure when the spec omits one. */
const DEFAULT_AGGREGATION: Aggregation = 'count';

/** The default row limit applied to a chart query (mirrors the reference). */
const DEFAULT_QUERY_LIMIT = 2000;

/** The default page size applied to a generated table block (mirrors the core
 * client's `createTableBlockUISchema`). */
const DEFAULT_TABLE_PAGE_SIZE = 20;

/**
 * A measure entry as embedded in a `ChartRendererProvider` query. Mirrors the
 * shape the data-visualization renderer consumes.
 */
interface ChartQueryMeasure {
  field: string;
  aggregation: Aggregation;
  alias: string;
  distinct?: boolean;
}

/**
 * A dimension entry as embedded in a `ChartRendererProvider` query.
 */
interface ChartQueryDimension {
  field: string;
  alias?: string;
  format?: string;
}

/**
 * The `config` block passed to a `ChartRendererProvider` decorator.
 */
interface ChartRendererConfig {
  chartType: string;
  title: string;
  bordered: boolean;
  general: Record<string, unknown>;
  advanced: Record<string, unknown>;
}

/**
 * The decorator props for a single `ChartRendererProvider`. The renderer reads
 * `collection` (for the ACL action) and `config.title` / `config.bordered`
 * (for the surrounding `CardItem`).
 */
interface ChartRendererDecoratorProps {
  mode: 'builder';
  dataSource: string;
  collection: string;
  query: {
    measures: ChartQueryMeasure[];
    dimensions: ChartQueryDimension[];
    limit: number;
    offset: number;
  };
  config: ChartRendererConfig;
}

/**
 * Build the `ChartRendererProvider` / `ChartRenderer` card for a single chart.
 * Ported from `createRendererSchema`; the `x-acl-action` is derived from the
 * decorator's bound collection (Requirement 13.3) and unique property keys are
 * generated with `uid()` (Requirement 7.3).
 */
function createRendererSchema(decoratorProps: ChartRendererDecoratorProps): ISchema {
  const { collection, config } = decoratorProps;
  const { title, bordered } = config;
  return {
    type: 'void',
    'x-decorator': 'ChartRendererProvider',
    'x-decorator-props': decoratorProps,
    'x-acl-action': `${collection}:list`,
    'x-toolbar': 'ChartRendererToolbar',
    'x-settings': 'chart:renderer',
    'x-component': 'CardItem',
    'x-component-props': {
      size: 'small',
      title,
      bordered,
    },
    'x-initializer': 'charts:addBlock',
    properties: {
      actions: {
        type: 'void',
        'x-decorator': 'div',
        'x-decorator-props': {
          style: {
            position: 'absolute',
            top: 0,
            right: 0,
            zIndex: 10,
          },
        },
        'x-component': 'ActionBar',
        'x-component-props': {
          style: {
            marginRight: 'var(--nb-designer-offset)',
            marginTop: 'var(--nb-designer-offset)',
          },
        },
        'x-initializer': 'chart:configureActions',
      },
      [uid()]: {
        type: 'void',
        'x-component': 'ChartRenderer',
        'x-component-props': {},
      },
    },
  };
}

/**
 * Wrap a chart card in a single-cell `Grid.Row` / `Grid.Col`. Ported from
 * `gridRowColWrap`; unique keys via `uid()` (Requirement 7.3).
 */
function gridRowColWrap(schema: ISchema): ISchema {
  return {
    type: 'void',
    'x-component': 'Grid.Row',
    properties: {
      [uid()]: {
        type: 'void',
        'x-component': 'Grid.Col',
        properties: {
          [(schema?.name as string) || uid()]: schema,
        },
      },
    },
  };
}

/**
 * Build the renderer card for a single {@link ChartSpecItem}. Adapted from
 * `createChartSchema`: instead of resolving abstract roles through a mapping,
 * the chart's measure/dimension `field`s are consumed directly from the spec
 * (Requirement 7.1). Each measure defaults to a `count` aggregation when none
 * is supplied (mirroring the reference's `measure.aggregation || 'count'`).
 */
function createChartSchema(chart: ChartSpecItem, dataSource: string, collection: string): ISchema {
  const dimensions: ChartQueryDimension[] = (chart.dimensions ?? []).map((dimension) => ({
    field: dimension.field,
    alias: dimension.alias,
    format: dimension.format,
  }));

  const measures: ChartQueryMeasure[] = chart.measures.map((measure) => ({
    field: measure.field,
    aggregation: measure.aggregation ?? DEFAULT_AGGREGATION,
    alias: measure.alias,
    distinct: measure.distinct,
  }));

  const config: ChartRendererConfig = {
    chartType: chart.chartType,
    title: chart.title,
    bordered: false,
    general: chart.config ?? {},
    advanced: {},
  };

  const rendererProps: ChartRendererDecoratorProps = {
    mode: 'builder',
    dataSource,
    collection,
    query: {
      measures,
      dimensions,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
    },
    config,
  };

  return gridRowColWrap(createRendererSchema(rendererProps));
}

/**
 * Generate the Formily block schema for a chart-type {@link BlockSpec}.
 *
 * Ported from `createVisualizationTemplateSchema`: the outer node is a
 * `ChartCardItem` decorated by `ChartBlockProvider`, containing a configure
 * `ActionBar` and a `Grid` decorated by `ChartV2Block`. Each chart in
 * `spec.charts` becomes a `ChartRendererProvider` / `ChartRenderer` card bound
 * to `spec.primaryCollection` / `spec.dataSource`. All property keys are unique
 * via `uid()` (Requirement 7.3) and every block-level node carries the
 * `x-decorator` / `x-component` / `x-settings` / `x-initializer` keys it needs
 * to render and be configurable in the page designer (Requirement 7.4).
 *
 * The `summary` parameter is part of the stable stage signature (used by the
 * table/form paths in task 6.2 and the fallback path in task 6.3); the chart
 * path binds purely from the spec.
 */
export function generateChartSchema(spec: BlockSpec, summary: SchemaSummary): ISchema {
  // `summary` is intentionally unused on the chart path; the chart binds from
  // the validated spec directly. Kept in the signature for 6.2/6.3 parity.
  void summary;

  const charts = spec.charts ?? [];

  const properties: Record<string, ISchema> = {};
  for (const chart of charts) {
    properties[uid()] = createChartSchema(chart, spec.dataSource, spec.primaryCollection);
  }

  return {
    type: 'void',
    'x-component': 'ChartCardItem',
    'x-use-component-props': 'useChartBlockCardProps',
    'x-settings': 'chart:block',
    'x-decorator': 'ChartBlockProvider',
    properties: {
      actions: {
        type: 'void',
        'x-component': 'ActionBar',
        'x-component-props': {
          style: {
            marginBottom: 'var(--nb-designer-offset)',
          },
        },
        'x-initializer': 'chartBlock:configureActions',
      },
      [uid()]: {
        type: 'void',
        'x-component': 'Grid',
        'x-decorator': 'ChartV2Block',
        'x-initializer': 'charts:addBlock',
        properties,
      },
    },
  };
}

/**
 * The decorator props for a generated `TableBlockProvider`. Mirrors the core
 * client's `createTableBlockUISchema` decorator-props (read by
 * `useTableBlockDecoratorProps`).
 */
interface TableBlockDecoratorProps {
  collection: string;
  dataSource: string;
  action: 'list';
  params: { pageSize: number };
  showIndex: boolean;
  dragSort: boolean;
}

/**
 * Build a single `TableV2.Column.Decorator` / `TableV2.Column` column bound to
 * `<collection>.<field>` via `x-collection-field`. Ported from the core
 * client's table column structure (`fieldSettings:TableColumn` settings,
 * `TableColumnSchemaToolbar` toolbar); the field is rendered by the standard
 * `CollectionField` component. Unique keys via `uid()` (Requirement 7.3).
 */
function createTableColumnSchema(collection: string, field: string): ISchema {
  return {
    type: 'void',
    'x-decorator': 'TableV2.Column.Decorator',
    'x-toolbar': 'TableColumnSchemaToolbar',
    'x-settings': 'fieldSettings:TableColumn',
    'x-component': 'TableV2.Column',
    properties: {
      [field]: {
        'x-collection-field': `${collection}.${field}`,
        'x-component': 'CollectionField',
        'x-component-props': {},
      },
    },
  };
}

/**
 * Build the standard action column (`TableV2.Column.ActionBar`) that hosts
 * per-row actions. Ported verbatim from `createTableBlockUISchema` so the
 * generated block behaves like a designer-created one.
 */
function createTableActionColumnSchema(): ISchema {
  return {
    type: 'void',
    title: '{{ t("Actions") }}',
    'x-action-column': 'actions',
    'x-decorator': 'TableV2.Column.ActionBar',
    'x-component': 'TableV2.Column',
    'x-toolbar': 'TableColumnSchemaToolbar',
    'x-initializer': 'table:configureItemActions',
    'x-settings': 'fieldSettings:TableColumn',
    'x-toolbar-props': {
      initializer: 'table:configureItemActions',
    },
    properties: {
      [uid()]: {
        type: 'void',
        'x-decorator': 'DndContext',
        'x-component': 'Space',
        'x-component-props': {
          split: '|',
        },
      },
    },
  };
}

/**
 * Generate the Formily block schema for a table-type {@link BlockSpec}.
 *
 * Ported from the core client's `createTableBlockUISchema`: the outer node is a
 * `CardItem` decorated by `TableBlockProvider` (bound to
 * `spec.primaryCollection` / `spec.dataSource`), containing a configure
 * `ActionBar` and a `TableV2` array. Each name in `spec.table.fields` becomes a
 * `TableV2.Column` rendering `<collection>.<field>` through `x-collection-field`
 * (Requirement 7.2). The block carries `x-acl-action: '<collection>:list'`
 * (Requirement 13.3), all property keys are unique via `uid()`
 * (Requirement 7.3), and every block node carries the
 * `x-decorator` / `x-component` / `x-settings` / `x-initializer` keys it needs
 * (Requirement 7.4).
 *
 * The `summary` parameter is part of the stable stage signature; the table path
 * binds purely from the validated spec.
 */
export function generateTableSchema(spec: BlockSpec, summary: SchemaSummary): ISchema {
  // `summary` is intentionally unused here; the table binds from the validated
  // spec directly. Kept in the signature for chart/form/fallback parity.
  void summary;

  const collection = spec.primaryCollection;
  const fields = spec.table?.fields ?? [];

  const decoratorProps: TableBlockDecoratorProps = {
    collection,
    dataSource: spec.dataSource,
    action: 'list',
    params: { pageSize: DEFAULT_TABLE_PAGE_SIZE },
    showIndex: true,
    dragSort: false,
  };

  // The TableV2 `properties` hold the standard action column followed by one
  // column per spec field. `actions` is a stable literal key (sibling to the
  // uid-keyed field columns), matching the core client structure.
  const columnProperties: Record<string, ISchema> = {
    actions: createTableActionColumnSchema(),
  };
  for (const field of fields) {
    columnProperties[uid()] = createTableColumnSchema(collection, field);
  }

  return {
    type: 'void',
    'x-decorator': 'TableBlockProvider',
    'x-acl-action': `${collection}:list`,
    'x-use-decorator-props': 'useTableBlockDecoratorProps',
    'x-decorator-props': decoratorProps,
    'x-toolbar': 'BlockSchemaToolbar',
    'x-settings': 'blockSettings:table',
    'x-component': 'CardItem',
    'x-filter-targets': [],
    properties: {
      actions: {
        type: 'void',
        'x-initializer': 'table:configureActions',
        'x-component': 'ActionBar',
        'x-component-props': {
          style: {
            marginBottom: 'var(--nb-spacing)',
          },
        },
        properties: {},
      },
      [uid()]: {
        type: 'array',
        'x-initializer': 'table:configureColumns',
        'x-component': 'TableV2',
        'x-use-component-props': 'useTableBlockProps',
        'x-component-props': {
          rowKey: 'id',
          rowSelection: {
            type: 'checkbox',
          },
        },
        properties: columnProperties,
      },
    },
  };
}

/**
 * The decorator props for a generated `FormBlockProvider`. `action` is only set
 * for the edit path (read by `useEditFormBlockDecoratorProps`); the create path
 * omits it (read by `useCreateFormBlockDecoratorProps`).
 */
interface FormBlockDecoratorProps {
  dataSource: string;
  collection: string;
  action?: 'get';
}

/**
 * Build a single form field item wrapped in `Grid.Row` / `Grid.Col`. The field
 * is rendered by `CollectionField` decorated by `FormItem` and bound to
 * `<collection>.<field>` via `x-collection-field`. Ported from the core
 * client's form grid field structure (`fieldSettings:FormItem` settings,
 * `FormItemSchemaToolbar` toolbar). Unique keys via `uid()` (Requirement 7.3).
 */
function createFormFieldRowSchema(collection: string, field: string): ISchema {
  return {
    type: 'void',
    'x-component': 'Grid.Row',
    properties: {
      [uid()]: {
        type: 'void',
        'x-component': 'Grid.Col',
        properties: {
          [field]: {
            type: 'string',
            'x-toolbar': 'FormItemSchemaToolbar',
            'x-settings': 'fieldSettings:FormItem',
            'x-component': 'CollectionField',
            'x-decorator': 'FormItem',
            'x-collection-field': `${collection}.${field}`,
            'x-component-props': {},
          },
        },
      },
    },
  };
}

/**
 * Generate the Formily block schema for a form-type {@link BlockSpec}.
 *
 * Ported from the core client's `createCreateFormBlockUISchema` /
 * `createEditFormBlockUISchema`: the outer node is a `CardItem` decorated by
 * `FormBlockProvider` (bound to `spec.primaryCollection` / `spec.dataSource`),
 * containing a `FormV2` whose `grid` (a `form:configureFields` `Grid`) holds one
 * `Grid.Row` / `Grid.Col` / `CollectionField` item per `spec.form.fields` entry
 * (Requirement 7.2), plus a form action bar.
 *
 * The decorator/component/settings/initializer names and the `x-acl-action`
 * switch on `spec.form.mode`: `'create'` uses the create-form chain and
 * `'<collection>:create'`; any other mode uses the edit-form chain and
 * `'<collection>:get'` (per the task's ACL mapping; note the core client's edit
 * form itself uses `'<collection>:update'`). All property keys are unique via
 * `uid()` (Requirement 7.3) and every block node carries the required `x-*`
 * keys (Requirements 7.4, 13.3).
 */
export function generateFormSchema(spec: BlockSpec, summary: SchemaSummary): ISchema {
  // `summary` is intentionally unused here; the form binds from the validated
  // spec directly. Kept in the signature for chart/table/fallback parity.
  void summary;

  const collection = spec.primaryCollection;
  const fields = spec.form?.fields ?? [];
  // Per the task: 'create' for create mode, edit otherwise (including an
  // unspecified mode).
  const isCreate = spec.form?.mode === 'create';

  const decoratorProps: FormBlockDecoratorProps = isCreate
    ? { dataSource: spec.dataSource, collection }
    : { action: 'get', dataSource: spec.dataSource, collection };

  const gridProperties: Record<string, ISchema> = {};
  for (const field of fields) {
    gridProperties[uid()] = createFormFieldRowSchema(collection, field);
  }

  return {
    type: 'void',
    'x-acl-action-props': {
      skipScopeCheck: isCreate,
    },
    'x-acl-action': isCreate ? `${collection}:create` : `${collection}:get`,
    'x-decorator': 'FormBlockProvider',
    'x-use-decorator-props': isCreate ? 'useCreateFormBlockDecoratorProps' : 'useEditFormBlockDecoratorProps',
    'x-decorator-props': decoratorProps,
    'x-toolbar': 'BlockSchemaToolbar',
    'x-settings': isCreate ? 'blockSettings:createForm' : 'blockSettings:editForm',
    'x-component': 'CardItem',
    properties: {
      [uid()]: {
        type: 'void',
        'x-component': 'FormV2',
        'x-use-component-props': isCreate ? 'useCreateFormBlockProps' : 'useEditFormBlockProps',
        properties: {
          grid: {
            type: 'void',
            'x-component': 'Grid',
            'x-initializer': 'form:configureFields',
            properties: gridProperties,
          },
          [uid()]: {
            type: 'void',
            'x-initializer': isCreate ? 'createForm:configureActions' : 'editForm:configureActions',
            'x-component': 'ActionBar',
            'x-component-props': {
              layout: 'one-column',
            },
          },
        },
      },
    },
  };
}

/**
 * The result of converting a validated {@link BlockSpec} into a Formily block
 * schema. A discriminated union so callers never receive a partial schema on
 * failure (Requirement 7.6) and can tell whether the fallback was used
 * (Requirement 7.5):
 * - `{ ok: true; schema; usedFallback: false }` — the supplied spec produced a
 *   schema directly.
 * - `{ ok: true; schema; usedFallback: true }` — the spec was empty/unproducible
 *   so the schema was generated from the fallback spec instead.
 * - `{ ok: false; error; failedNode? }` — generation threw after validation; no
 *   schema object is emitted.
 */
export type GenerateResult =
  | { ok: true; schema: ISchema; usedFallback: boolean }
  | { ok: false; error: string; failedNode?: string };

/**
 * Internal throwing dispatcher: convert a validated {@link BlockSpec} into a
 * Formily block schema based on its `blockType`. Used by the pure builders'
 * orchestration; the public {@link generate} wraps it to satisfy the
 * no-partial-schema guarantee. Throws on an unknown `blockType` (the public
 * entry treats that as unproducible and falls back before reaching here).
 */
function generateSchema(spec: BlockSpec, summary: SchemaSummary): ISchema {
  switch (spec.blockType) {
    case 'chart':
      return generateChartSchema(spec, summary);
    case 'table':
      return generateTableSchema(spec, summary);
    case 'form':
      return generateFormSchema(spec, summary);
    default:
      throw new Error(`[generator] unknown blockType "${String(spec.blockType)}"`);
  }
}

/**
 * Whether a {@link BlockSpec} carries enough validated content to produce its
 * block. A chart needs at least one chart item, a table/form needs at least one
 * field, and an unknown `blockType` is never producible. When this returns
 * `false` the public {@link generate} routes to the fallback (Requirement 7.5).
 */
function isProducible(spec: BlockSpec): boolean {
  switch (spec.blockType) {
    case 'chart':
      return (spec.charts?.length ?? 0) > 0;
    case 'table':
      return (spec.table?.fields?.length ?? 0) > 0;
    case 'form':
      return (spec.form?.fields?.length ?? 0) > 0;
    default:
      return false;
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Top-level generator entry: convert a validated {@link BlockSpec} into a
 * {@link GenerateResult}.
 *
 * Behavior:
 * - If the spec is empty/unproducible (Requirement 7.5), generate the schema
 *   from {@link buildFallbackSpec} and return `usedFallback: true`.
 * - Otherwise generate from the supplied spec and return `usedFallback: false`.
 * - If construction throws after validation (Requirement 7.6), return an error
 *   result and emit no partial schema. The fallback path is itself wrapped so a
 *   fallback construction error is reported rather than thrown.
 */
export function generate(spec: BlockSpec, summary: SchemaSummary): GenerateResult {
  if (!isProducible(spec)) {
    // Requirement 7.5: produce the fallback schema instead of an empty/partial
    // result. Wrapped so a fallback construction error becomes an error result.
    try {
      const schema = generateSchema(buildFallbackSpec(summary), summary);
      return { ok: true, schema, usedFallback: true };
    } catch (error) {
      return { ok: false, error: toErrorMessage(error), failedNode: 'fallback' };
    }
  }

  // Requirement 7.6: never emit a partially constructed schema — only return a
  // schema when construction fully succeeds.
  try {
    const schema = generateSchema(spec, summary);
    return { ok: true, schema, usedFallback: false };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error), failedNode: spec.blockType };
  }
}

export default generate;
