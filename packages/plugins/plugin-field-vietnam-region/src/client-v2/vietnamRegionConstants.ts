import { uid } from '@formily/shared';

export const VIETNAM_REGION_INTERFACE_NAME = 'vietnamRegion';
export const VIETNAM_REGION_TARGET = 'vietnamRegions';

export const VIETNAM_REGION_FIELD_NAMES = {
  label: 'name',
  value: 'code',
  children: 'children',
};

// Vietnam post-2025 structure: province -> commune (2 levels).
export const VIETNAM_REGION_LEVEL_OPTIONS = [
  { value: 1, label: '{{t("Province")}}' },
  { value: 2, label: '{{t("Commune")}}' },
];

export const VIETNAM_REGION_BASE_COMPONENT_PROPS = {
  changeOnSelectLast: false,
  labelInValue: true,
  maxLevel: 2,
  fieldNames: VIETNAM_REGION_FIELD_NAMES,
};

export const VIETNAM_REGION_BASE_DEFAULT = {
  interface: VIETNAM_REGION_INTERFACE_NAME,
  type: 'belongsToMany',
  target: VIETNAM_REGION_TARGET,
  targetKey: 'code',
  sortBy: 'level',
  uiSchema: {
    type: 'array',
    'x-component': 'Cascader',
  },
};

export const VIETNAM_REGION_FILTERABLE_CHILD_BASE = {
  name: 'name',
  title: '{{t("Province/commune name")}}',
  schema: {
    title: '{{t("Province/commune name")}}',
    type: 'string',
    'x-component': 'Input',
  },
};

export function initializeVietnamRegionValues(values: any): void {
  if (!values.through) {
    values.through = `t_${uid()}`;
  }
  if (!values.foreignKey) {
    values.foreignKey = `f_${uid()}`;
  }
  if (!values.otherKey) {
    values.otherKey = `f_${uid()}`;
  }
  if (!values.sourceKey) {
    values.sourceKey = 'id';
  }
  if (!values.targetKey) {
    values.targetKey = 'id';
  }
}
