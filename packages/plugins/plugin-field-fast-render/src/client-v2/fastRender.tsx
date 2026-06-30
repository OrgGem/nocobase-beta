import { getDisplayNumber, Icon } from '@nocobase/client-v2';
import { Tag } from 'antd';
import React from 'react';

type CollectionFieldLike = {
  enum?: FastRenderOptionInput[];
  interface?: string;
  isAssociationField?: () => boolean;
  uiSchema?: {
    enum?: FastRenderOptionInput[];
  };
};

type TableColumnModelLike = {
  associationPathName?: string;
  collectionField?: CollectionFieldLike;
  context?: {
    collectionField?: CollectionFieldLike;
    flowSettingsEnabled?: boolean;
    prefixFieldPath?: string;
    t?: (key: string, options?: Record<string, unknown>) => string;
  };
  fieldPath?: string;
  props?: Record<string, any>;
  subModels?: {
    field?: {
      use?: string;
      context?: {
        collectionField?: CollectionFieldLike;
      };
    };
  };
};

type FastRenderOption = {
  color?: string;
  icon?: unknown;
  label?: React.ReactNode;
  value?: unknown;
  [key: string]: unknown;
};

type FastRenderOptionInput = FastRenderOption | string | number | boolean;

const FAST_RENDER_PATCHED = Symbol.for('plugin-field-fast-render.TableColumnModel.renderItem.patched');
const FAST_RENDER_ORIGINAL = Symbol.for('plugin-field-fast-render.TableColumnModel.renderItem.original');

const TEXT_INTERFACES = new Set(['input', 'textarea', 'email', 'phone', 'uuid', 'nanoid']);
const NUMBER_INTERFACES = new Set(['number', 'integer', 'id', 'snowflakeId']);
const SELECTION_INTERFACES = new Set(['select', 'multipleSelect', 'radioGroup', 'checkboxGroup']);
const SUPPORTED_INTERFACES = new Set([...TEXT_INTERFACES, ...NUMBER_INTERFACES, ...SELECTION_INTERFACES]);

const EMPTY_VALUES = new Set([null, undefined, '']);

function getColumnFieldModel(model?: TableColumnModelLike) {
  return model?.subModels?.field;
}

export function getCollectionField(model?: TableColumnModelLike): CollectionFieldLike | undefined {
  const fieldModel = getColumnFieldModel(model);
  return model?.context?.collectionField || model?.collectionField || fieldModel?.context?.collectionField;
}

export function isSupportedFastRenderField(model?: TableColumnModelLike) {
  const collectionField = getCollectionField(model);
  if (!collectionField?.interface) {
    return false;
  }
  if (typeof collectionField.isAssociationField === 'function' && collectionField.isAssociationField()) {
    return false;
  }
  return SUPPORTED_INTERFACES.has(collectionField.interface);
}

export function canFastRenderColumn(model?: TableColumnModelLike) {
  if (!model || model.props?.fastRender !== true) {
    return false;
  }
  if (model.context?.flowSettingsEnabled || model.props?.editable || model.associationPathName) {
    return false;
  }
  const fieldModel = getColumnFieldModel(model);
  if (fieldModel?.use && !isBuiltInFastRenderableFieldModel(fieldModel.use)) {
    return false;
  }
  return isSupportedFastRenderField(model);
}

function isBuiltInFastRenderableFieldModel(use?: string) {
  return !use || ['DisplayTextFieldModel', 'DisplayNumberFieldModel', 'DisplayEnumFieldModel'].includes(use);
}

function readPath(source: unknown, path?: string) {
  if (!path) {
    return undefined;
  }
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, source);
}

function getNamePath(model: TableColumnModelLike) {
  if (model.context?.prefixFieldPath && model.fieldPath?.startsWith(`${model.context.prefixFieldPath}.`)) {
    return model.fieldPath.replace(`${model.context.prefixFieldPath}.`, '');
  }
  return model.fieldPath || model.props?.dataIndex;
}

function isEmpty(value: unknown) {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return EMPTY_VALUES.has(value as null | undefined | '');
}

function renderText(model: TableColumnModelLike, value: unknown) {
  const { className, overflowMode, prefix, style, suffix } = model.props || {};
  return (
    <span
      className={className}
      style={{ ...(style || {}), whiteSpace: overflowMode === 'wrap' ? 'pre-line' : 'nowrap' }}
    >
      {prefix}
      {String(value)}
      {suffix}
    </span>
  );
}

function formatNumberValue(model: TableColumnModelLike, value: unknown) {
  return getDisplayNumber({ ...model.props, value });
}

function renderNumber(model: TableColumnModelLike, value: unknown) {
  const { addonAfter, addonBefore, className, style } = model.props || {};
  return (
    <span className={className} style={style}>
      {addonBefore}
      <span dangerouslySetInnerHTML={{ __html: formatNumberValue(model, value) ?? '' }} />
      {addonAfter}
    </span>
  );
}

function normalizeOption(option: FastRenderOptionInput): FastRenderOption {
  if (option && typeof option === 'object' && !Array.isArray(option)) {
    const value = typeof option.value === 'undefined' ? option.label : option.value;
    return {
      ...option,
      label: typeof option.label === 'undefined' ? String(value ?? '') : option.label,
      value,
    };
  }
  return {
    label: String(option),
    value: option,
  };
}

function getOptions(model: TableColumnModelLike) {
  const collectionField = getCollectionField(model);
  const { dataSource, options } = model.props || {};
  const resolved = dataSource || options || collectionField?.enum || collectionField?.uiSchema?.enum || [];
  return Array.isArray(resolved) ? resolved.map(normalizeOption) : [];
}

function findOption(options: FastRenderOption[], value: unknown) {
  return options.find((option) => option?.value == value);
}

function isTranslationTemplate(value: unknown): value is string {
  return typeof value === 'string' && /\{\{\s*t\s*\(/.test(value);
}

function translateOptionLabel(label: React.ReactNode, model: TableColumnModelLike) {
  if (isTranslationTemplate(label) && typeof model.context?.t === 'function') {
    return model.context.t(label);
  }
  return label;
}

function renderOptionIcon(icon: unknown) {
  if (!icon) {
    return undefined;
  }
  if (typeof icon === 'string') {
    return <Icon type={icon} />;
  }
  if (React.isValidElement(icon)) {
    return icon;
  }
  return undefined;
}

function renderSelection(model: TableColumnModelLike, value: unknown) {
  const options = getOptions(model);
  const values = Array.isArray(value) ? value : [value];

  return values.map((item) => {
    const option = findOption(options, item);
    const label = translateOptionLabel(option?.label ?? String(item), model);
    const key = String(option?.value ?? item);
    return (
      <Tag key={key} color={option?.color} icon={renderOptionIcon(option?.icon)}>
        {label}
      </Tag>
    );
  });
}

export function renderFastCell(model: TableColumnModelLike, record: Record<string, unknown>) {
  const collectionField = getCollectionField(model);
  const value = readPath(record, getNamePath(model));
  if (isEmpty(value)) {
    return null;
  }
  if (collectionField?.interface && TEXT_INTERFACES.has(collectionField.interface)) {
    return renderText(model, value);
  }
  if (collectionField?.interface && NUMBER_INTERFACES.has(collectionField.interface)) {
    return renderNumber(model, value);
  }
  if (collectionField?.interface && SELECTION_INTERFACES.has(collectionField.interface)) {
    return renderSelection(model, value);
  }
  return null;
}

export function patchTableColumnFastRender(TableColumnModel: any) {
  const proto = TableColumnModel?.prototype;
  if (!proto || proto[FAST_RENDER_PATCHED]) {
    return;
  }

  const originalRenderItem = proto.renderItem;
  proto[FAST_RENDER_ORIGINAL] = originalRenderItem;
  proto.renderItem = function renderItemWithFastPath(this: TableColumnModelLike) {
    const originalRenderer = originalRenderItem.call(this);
    return (value: unknown, record: Record<string, unknown>, index: number) => {
      if (!canFastRenderColumn(this)) {
        return originalRenderer(value, record, index);
      }
      return renderFastCell(this, record);
    };
  };
  proto[FAST_RENDER_PATCHED] = true;
}
