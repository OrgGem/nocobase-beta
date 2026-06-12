import React, { useMemo } from 'react';
import { Alert, Button, Empty, Space, Spin, Typography } from 'antd';
import { ISchema, SchemaComponent, SchemaComponentOptions } from '@nocobase/client';
import { useT } from './locale';

/**
 * A single validator adjustment, mirroring the `ValidationAdjustment` shape
 * produced by the server-side Spec Validator. Declared locally so the client
 * never imports server pipeline code.
 */
export interface Adjustment {
  /** The original field reference (or a short role descriptor). */
  reference: string;
  /** Whether the reference was dropped, remapped, or left an unmet role. */
  action: 'removed' | 'remapped' | 'unmet-role';
  /** The field the reference was remapped to (only set for `remapped`). */
  replacement?: string;
  /** A short, non-localized diagnostic describing the change. */
  reason?: string;
}

export interface PreviewPanelProps {
  /** The generated, validated block schema to preview. Absent while building. */
  schema?: ISchema;
  /** True when the result came from the fallback path (Req 9.5 / 12.4). */
  usedFallback?: boolean;
  /**
   * The validator adjustments. Accepts the validated `Adjustment[]` shape; an
   * `unknown` value (e.g. raw JSON from the build record) is tolerated and
   * narrowed at render time.
   */
  adjustments?: Adjustment[] | unknown;
  /** Insert the previewed schema into the page/popup (Req 9.2). */
  onInsert: (schema: ISchema) => void;
  /** Re-run generation, keeping the same inputs (Req 9.4 / 12.5). */
  onRegenerate: () => void;
  /** Dismiss the preview without inserting anything (Req 9.3). */
  onCancel: () => void;
  /** Whether a build/regenerate is in flight; disables actions + shows a spinner. */
  loading?: boolean;
}

/** Type guard narrowing the loosely-typed `adjustments` prop to `Adjustment[]`. */
function isAdjustmentArray(value: unknown): value is Adjustment[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item): item is Adjustment =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Adjustment).reference === 'string' &&
        typeof (item as Adjustment).action === 'string',
    )
  );
}

/** Render a one-line, human-readable description of a single adjustment. */
function describeAdjustment(adjustment: Adjustment): string {
  if (adjustment.action === 'remapped' && adjustment.replacement) {
    return `${adjustment.reference} → ${adjustment.replacement}`;
  }
  return `${adjustment.reference} → ${adjustment.action}`;
}

/**
 * Presentational preview surface for a generated block (Req 9.1–9.5, 12.4–12.5).
 *
 * It renders the generated `schema` read-only via {@link SchemaComponent},
 * surfaces a fallback notice and any validator adjustments, and exposes
 * Insert / Regenerate / Cancel actions. It owns no data or side effects — the
 * parent `BuildForm` supplies the schema and wires the callbacks.
 */
export const PreviewPanel = (props: PreviewPanelProps) => {
  const { schema, usedFallback, adjustments, onInsert, onRegenerate, onCancel, loading } = props;
  const t = useT();

  const adjustmentList = useMemo<Adjustment[]>(
    () => (isAdjustmentArray(adjustments) ? adjustments : []),
    [adjustments],
  );

  const hasSchema = Boolean(schema);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {usedFallback ? <Alert type="warning" showIcon message={t('A fallback block was generated')} /> : null}

      {adjustmentList.length > 0 ? (
        <Alert
          type="info"
          showIcon
          message={t('Some fields were adjusted to match the collection')}
          description={
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {adjustmentList.map((adjustment, index) => (
                <li key={`${adjustment.reference}-${adjustment.action}-${index}`}>{describeAdjustment(adjustment)}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      <section aria-label={t('Preview')}>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {t('Preview')}
        </Typography.Title>
        {hasSchema ? (
          <SchemaComponentOptions>
            <SchemaComponent schema={schema as ISchema} />
          </SchemaComponentOptions>
        ) : loading ? (
          <Spin aria-label={t('Generating')} />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('Preview')} />
        )}
      </section>

      <Space>
        <Button
          type="primary"
          onClick={() => schema && onInsert(schema)}
          disabled={!hasSchema || loading}
          aria-label={t('Insert')}
        >
          {t('Insert')}
        </Button>
        <Button onClick={onRegenerate} loading={loading} aria-label={t('Regenerate')}>
          {t('Regenerate')}
        </Button>
        <Button onClick={onCancel} disabled={loading} aria-label={t('Cancel')}>
          {t('Cancel')}
        </Button>
      </Space>
    </Space>
  );
};
