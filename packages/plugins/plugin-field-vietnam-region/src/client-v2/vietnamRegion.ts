import { CollectionFieldInterface } from '@nocobase/client-v2';
import {
  VIETNAM_REGION_BASE_COMPONENT_PROPS,
  VIETNAM_REGION_BASE_DEFAULT,
  VIETNAM_REGION_FILTERABLE_CHILD_BASE,
  VIETNAM_REGION_INTERFACE_NAME,
  VIETNAM_REGION_LEVEL_OPTIONS,
  initializeVietnamRegionValues,
} from './vietnamRegionConstants';

export class VietnamRegionFieldInterface extends CollectionFieldInterface {
  name = VIETNAM_REGION_INTERFACE_NAME;
  type = 'object';
  group = 'choices';
  order = 8;
  title = '{{t("Vietnam region")}}';
  isAssociation = true;
  default = {
    ...VIETNAM_REGION_BASE_DEFAULT,
    uiSchema: {
      ...VIETNAM_REGION_BASE_DEFAULT.uiSchema,
      'x-component-props': { ...VIETNAM_REGION_BASE_COMPONENT_PROPS },
    },
  };
  availableTypes = ['belongsToMany'];

  initialize(values: any): void {
    initializeVietnamRegionValues(values);
  }

  configure = {
    items: [
      {
        name: 'uiSchema.x-component-props.maxLevel',
        title: '{{t("Select level")}}',
        component: 'Radio.Group',
        defaultValue: 2,
        options: VIETNAM_REGION_LEVEL_OPTIONS,
      },
      {
        name: 'uiSchema.x-component-props.changeOnSelectLast',
        title: '{{t("Must select to the last level")}}',
        component: 'Checkbox',
      },
    ],
  };

  filterable = {
    children: [
      {
        ...VIETNAM_REGION_FILTERABLE_CHILD_BASE,
        operators: 'string',
      },
    ],
  };
}
