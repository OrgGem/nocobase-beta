import { defaultProps, operators, CollectionFieldInterface } from '@nocobase/client';
import {
  VIETNAM_REGION_BASE_COMPONENT_PROPS,
  VIETNAM_REGION_BASE_DEFAULT,
  VIETNAM_REGION_FILTERABLE_CHILD_BASE,
  VIETNAM_REGION_INTERFACE_NAME,
  VIETNAM_REGION_LEVEL_OPTIONS,
  initializeVietnamRegionValues,
} from '../client-v2/vietnamRegionConstants';

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
      'x-component-props': {
        ...VIETNAM_REGION_BASE_COMPONENT_PROPS,
        useDataSource: '{{ useVietnamRegionDataSource }}',
        useLoadData: '{{ useVietnamRegionLoadData }}',
      },
    },
  };
  availableTypes = ['belongsToMany'];
  initialize(values: any): void {
    initializeVietnamRegionValues(values);
  }

  properties = {
    ...defaultProps,
    'uiSchema.x-component-props.maxLevel': {
      type: 'number',
      'x-component': 'Radio.Group',
      'x-decorator': 'FormItem',
      title: '{{t("Select level")}}',
      default: 2,
      enum: VIETNAM_REGION_LEVEL_OPTIONS,
    },
    'uiSchema.x-component-props.changeOnSelectLast': {
      type: 'boolean',
      'x-component': 'Checkbox',
      'x-content': '{{t("Must select to the last level")}}',
      'x-decorator': 'FormItem',
    },
  };

  filterable = {
    children: [
      {
        ...VIETNAM_REGION_FILTERABLE_CHILD_BASE,
        operators: operators.string,
      },
    ],
  };
}
