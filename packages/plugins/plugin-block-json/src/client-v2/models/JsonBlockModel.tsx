import React, { useEffect, useMemo, useState } from 'react';
import type { Key } from 'react';
import { Alert, Button, Empty, Segmented, Space, Tree } from 'antd';
import type { TreeDataNode } from 'antd';
import { css } from '@emotion/css';
import { observer, SingleRecordResource } from '@nocobase/flow-engine';
import type { Collection, CollectionField, FlowModelContext } from '@nocobase/flow-engine';
import { BlockSceneEnum, CollectionBlockModel } from '@nocobase/client-v2';
import { tExpr, useT } from '../locale';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface JsonBlockProps {
  fieldPath?: string;
  defaultExpandAll?: boolean;
  showRoot?: boolean;
}

type JsonBlockSettingsParams = JsonBlockProps;

interface ParseResult {
  value?: JsonValue;
  error?: string;
  empty?: boolean;
}

const jsonBlockClass = css`
  .nb-json-block-toolbar {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 12px;
  }

  .nb-json-block-tree {
    max-height: 520px;
    overflow: auto;
    padding: 8px;
    border: 1px solid var(--ant-color-border-secondary);
    border-radius: 6px;
    background: var(--ant-color-bg-container);
  }

  .nb-json-node-key {
    color: var(--ant-color-primary);
    font-weight: 600;
  }

  .nb-json-node-meta {
    color: var(--ant-color-text-tertiary);
    margin-left: 6px;
  }

  .nb-json-node-string {
    color: #0f766e;
  }

  .nb-json-node-number {
    color: #b45309;
  }

  .nb-json-node-boolean {
    color: #7c3aed;
  }

  .nb-json-node-null {
    color: var(--ant-color-text-tertiary);
  }

  pre.nb-json-raw {
    max-height: 520px;
    overflow: auto;
    margin: 0;
    padding: 12px;
    border: 1px solid var(--ant-color-border-secondary);
    border-radius: 6px;
    background: var(--ant-color-fill-quaternary);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonField(field: CollectionField) {
  const type = String(field.type || '').toLowerCase();
  const fieldInterface = String(field.interface || '').toLowerCase();
  const component = String(field.uiSchema?.['x-component'] || '').toLowerCase();
  return (
    type.includes('json') ||
    type === 'object' ||
    type === 'array' ||
    type === 'text' ||
    type === 'string' ||
    fieldInterface.includes('json') ||
    fieldInterface.includes('array') ||
    fieldInterface.includes('textarea') ||
    component.includes('json') ||
    component.includes('textarea')
  );
}

export function getJsonFieldOptions(collection?: Collection) {
  const fields = collection?.getFields?.() || [];
  return fields.filter(isJsonField).map((field) => ({
    label: field.title || field.name,
    value: field.name,
  }));
}

function getValueByPath(record: unknown, fieldPath?: string) {
  if (!fieldPath || !isRecord(record)) {
    return undefined;
  }
  return fieldPath.split('.').reduce<unknown>((current, key) => {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    return current[key as keyof typeof current];
  }, record);
}

function normalizeJsonValue(value: unknown): ParseResult {
  if (value === undefined || value === null || value === '') {
    return { empty: true };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return { empty: true };
    }
    try {
      return { value: JSON.parse(trimmed) as JsonValue };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { value: value as JsonValue };
}

function describeCollection(value: JsonValue, t: ReturnType<typeof useT>) {
  if (Array.isArray(value)) {
    return t('{{count}} items', { count: value.length });
  }
  if (isRecord(value)) {
    return t('{{count}} keys', { count: Object.keys(value).length });
  }
  return '';
}

function renderScalar(value: JsonValue) {
  if (value === null) {
    return <span className="nb-json-node-null">null</span>;
  }
  if (typeof value === 'string') {
    return <span className="nb-json-node-string">{JSON.stringify(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="nb-json-node-number">{value}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="nb-json-node-boolean">{String(value)}</span>;
  }
  return null;
}

function createTitle(label: string, value: JsonValue, t: ReturnType<typeof useT>) {
  if (Array.isArray(value) || isRecord(value)) {
    return (
      <span>
        <span className="nb-json-node-key">{label}</span>
        <span className="nb-json-node-meta">{Array.isArray(value) ? '[]' : '{}'}</span>
        <span className="nb-json-node-meta">{describeCollection(value, t)}</span>
      </span>
    );
  }
  return (
    <span>
      <span className="nb-json-node-key">{label}</span>
      <span className="nb-json-node-meta">:</span> {renderScalar(value)}
    </span>
  );
}

function buildTree(value: JsonValue, t: ReturnType<typeof useT>, path = 'root', label = 'root'): TreeDataNode {
  if (Array.isArray(value)) {
    return {
      key: path,
      title: createTitle(label, value, t),
      children: value.map((item, index) => buildTree(item, t, `${path}.${index}`, `[${index}]`)),
    };
  }

  if (isRecord(value)) {
    return {
      key: path,
      title: createTitle(label, value, t),
      children: Object.entries(value).map(([key, item]) => buildTree(item as JsonValue, t, `${path}.${key}`, key)),
    };
  }

  return {
    key: path,
    title: createTitle(label, value, t),
  };
}

function collectExpandableKeys(nodes: TreeDataNode[]) {
  const keys: string[] = [];
  const visit = (items: TreeDataNode[]) => {
    items.forEach((item) => {
      if (item.children?.length) {
        keys.push(String(item.key));
        visit(item.children);
      }
    });
  };
  visit(nodes);
  return keys;
}

export function JsonViewer({
  value,
  defaultExpandAll = true,
  showRoot = true,
}: {
  value: unknown;
  defaultExpandAll?: boolean;
  showRoot?: boolean;
}) {
  const t = useT();
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const result = useMemo(() => normalizeJsonValue(value), [value]);
  const treeData = useMemo(() => {
    if (result.value === undefined) {
      return [];
    }
    const root = buildTree(result.value, t);
    return showRoot === false && root.children?.length ? root.children : [root];
  }, [result.value, showRoot, t]);
  const allKeys = useMemo(() => collectExpandableKeys(treeData), [treeData]);
  const allKeySignature = allKeys.join('\u0000');
  const [expandedKeys, setExpandedKeys] = useState<Key[]>(defaultExpandAll === false ? [] : allKeys);

  useEffect(() => {
    setExpandedKeys(defaultExpandAll === false || !allKeySignature ? [] : allKeySignature.split('\u0000'));
    // allKeySignature keeps this from resetting user-expanded state on every render.
  }, [allKeySignature, defaultExpandAll]);

  if (result.empty) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('No JSON data')} />;
  }

  if (result.error) {
    return <Alert type="error" message={t('Invalid JSON')} description={result.error} showIcon />;
  }

  return (
    <div className={jsonBlockClass}>
      <div className="nb-json-block-toolbar">
        <Space wrap>
          <Button size="small" onClick={() => setExpandedKeys(allKeys)}>
            {t('Expand all')}
          </Button>
          <Button size="small" onClick={() => setExpandedKeys([])}>
            {t('Collapse all')}
          </Button>
        </Space>
        <Segmented
          size="small"
          value={mode}
          onChange={(nextMode) => setMode(nextMode as 'tree' | 'raw')}
          options={[
            { label: t('Tree'), value: 'tree' },
            { label: t('Raw'), value: 'raw' },
          ]}
        />
      </div>
      {mode === 'tree' ? (
        <Tree
          className="nb-json-block-tree"
          treeData={treeData}
          expandedKeys={expandedKeys}
          onExpand={(keys) => setExpandedKeys(keys)}
          selectable={false}
          blockNode
        />
      ) : (
        <pre className="nb-json-raw">{JSON.stringify(result.value, null, 2)}</pre>
      )}
    </div>
  );
}

const JsonPreview = observer(
  ({ model }: { model: JsonBlockModel }) => {
    const t = useT();
    const record = model.resource?.getData();
    const sourceValue = getValueByPath(record, model.props.fieldPath);

    if (!model.props.fieldPath) {
      return <Alert type="info" message={t('Select a JSON field in block settings.')} showIcon />;
    }

    return (
      <JsonViewer value={sourceValue} defaultExpandAll={model.props.defaultExpandAll} showRoot={model.props.showRoot} />
    );
  },
  { displayName: 'JsonPreview' },
);

export class JsonBlockModel extends CollectionBlockModel<JsonBlockProps> {
  static scene = BlockSceneEnum.one;

  static filterCollection(collection: Collection) {
    return !!collection.filterTargetKey;
  }

  get resource() {
    return super.resource as SingleRecordResource;
  }

  createResource() {
    return this.context.createResource(SingleRecordResource);
  }

  renderComponent() {
    return <JsonPreview model={this} />;
  }
}

JsonBlockModel.registerFlow({
  key: 'jsonBlockSettings',
  title: tExpr('JSON block settings'),
  on: 'beforeRender',
  steps: {
    configure: {
      title: tExpr('Configure JSON preview'),
      paramsRequired: true,
      uiSchema(ctx: FlowModelContext) {
        return {
          fieldPath: {
            type: 'string',
            title: tExpr('JSON field'),
            required: true,
            'x-decorator': 'FormItem',
            'x-component': 'Select',
            'x-component-props': {
              showSearch: true,
              allowClear: true,
              options: getJsonFieldOptions(ctx.collection),
              placeholder: tExpr('Select a JSON field'),
            },
          },
          defaultExpandAll: {
            type: 'boolean',
            title: tExpr('Expand all by default'),
            'x-decorator': 'FormItem',
            'x-component': 'Switch',
          },
          showRoot: {
            type: 'boolean',
            title: tExpr('Show root node'),
            'x-decorator': 'FormItem',
            'x-component': 'Switch',
          },
        };
      },
      defaultParams: {
        defaultExpandAll: true,
        showRoot: true,
      },
      handler(ctx, params: JsonBlockSettingsParams) {
        ctx.model.setProps({
          fieldPath: params.fieldPath,
          defaultExpandAll: params.defaultExpandAll,
          showRoot: params.showRoot,
        });
      },
    },
  },
});

JsonBlockModel.define({
  label: tExpr('JSON'),
  group: tExpr('Content'),
  searchable: true,
  searchPlaceholder: tExpr('Search'),
  sort: 510,
});
