/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface FormModelSchema {
  use: string;
  uid?: string;
  stepParams?: Record<string, Record<string, Record<string, unknown>>>;
  props?: Record<string, unknown>;
  subModels?: Record<string, FormModelSchema | FormModelSchema[]>;
  [key: string]: unknown;
}
export interface SharedFormConfig {
  version: 2;
  model: FormModelSchema;
  successMessage: string;
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function collectionBinding(value: string) {
  const parts = value.split(':');
  const collectionName = parts.pop() || '';
  return { dataSourceKey: parts.pop() || 'main', collectionName };
}
export function parseConfig(value: unknown, collection: string): SharedFormConfig {
  if (
    !isObject(value) ||
    value.version !== 2 ||
    !isObject(value.model) ||
    value.model.use !== 'SharedFormModel' ||
    typeof value.successMessage !== 'string'
  )
    throw new Error('Invalid V2 form configuration');
  if (JSON.stringify(value).length > 1000000) throw new Error('V2 form configuration is too large');
  let nodes = 0;
  function validateNode(node: unknown, depth: number) {
    if (!isObject(node) || typeof node.use !== 'string' || depth > 40 || ++nodes > 2000)
      throw new Error('Invalid V2 form configuration');
    if (node.subModels !== undefined) {
      if (!isObject(node.subModels)) throw new Error('Invalid V2 form configuration');
      for (const child of Object.values(node.subModels))
        for (const item of Array.isArray(child) ? child : [child]) validateNode(item, depth + 1);
    }
  }
  validateNode(value.model, 0);
  const model = value.model as FormModelSchema;
  const expected = collectionBinding(collection);
  const binding = model.stepParams?.resourceSettings?.init;
  if (
    !binding ||
    binding.dataSourceKey !== expected.dataSourceKey ||
    binding.collectionName !== expected.collectionName
  )
    throw new Error('Form collection does not match');
  return value as unknown as SharedFormConfig;
}
export function configuredFields(model: FormModelSchema): string[] {
  const fields = new Set<string>();
  const rootBinding = model.stepParams?.resourceSettings?.init;
  function visit(node: FormModelSchema) {
    const binding = node.stepParams?.fieldSettings?.init;
    const matches =
      binding?.dataSourceKey === rootBinding?.dataSourceKey && binding?.collectionName === rootBinding?.collectionName;
    const path = node.use === 'FormItemModel' && matches && binding?.fieldPath;
    if (typeof path === 'string' && path && !['__proto__', 'constructor', 'prototype'].includes(path.split('.')[0]))
      fields.add(path.split('.')[0]);
    for (const child of Object.values(node.subModels || {}))
      for (const item of Array.isArray(child) ? child : [child]) visit(item);
  }
  const grid = model.subModels?.grid;
  if (grid && !Array.isArray(grid)) visit(grid);
  return [...fields];
}
/** Preserve V1 storage. Import only field choices; complex V1 rules require review in the native designer. */
export function legacyFields(schema: unknown, collection: string): string[] {
  const names = new Set<string>();
  function visit(value: unknown) {
    if (!isObject(value)) return;
    const full = value['x-collection-field'];
    if (typeof full === 'string' && full.startsWith(collection + '.'))
      names.add(full.slice(collection.length + 1).split('.')[0]);
    if (isObject(value.properties)) Object.values(value.properties).forEach(visit);
  }
  visit(schema);
  return [...names];
}
