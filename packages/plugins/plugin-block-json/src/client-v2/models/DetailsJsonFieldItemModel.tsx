import { DetailsCustomItemModel } from '@nocobase/client-v2';
import type { Collection, FlowModelContext, SubModelItem } from '@nocobase/flow-engine';
import { tExpr } from '../locale';
import { isJsonField } from './JsonBlockModel';

function getDetailsCollectionName(ctx: FlowModelContext, fallback: Collection) {
  const blockModel = ctx.model?.context?.blockModel as { collection?: Collection } | undefined;
  return blockModel?.collection?.name || fallback.name;
}

export class DetailsJsonFieldItemModel extends DetailsCustomItemModel {
  static defineChildren(ctx: FlowModelContext): SubModelItem[] {
    const collection = ctx.collection as Collection | undefined;
    if (!collection) {
      return [];
    }

    return collection
      .getFields()
      .filter(isJsonField)
      .map((field) => {
        const fullName = ctx.prefixFieldPath ? `${ctx.prefixFieldPath}.${field.name}` : field.name;
        return {
          key: fullName,
          label: field.title || field.name,
          refreshTargets: ['DetailsItemModel'],
          toggleable: (subModel) => {
            const fieldPath = subModel.getStepParams('fieldSettings', 'init')?.fieldPath;
            return fieldPath === fullName;
          },
          useModel: 'DetailsItemModel',
          createModelOptions: () => ({
            use: 'DetailsItemModel',
            stepParams: {
              fieldSettings: {
                init: {
                  dataSourceKey: collection.dataSourceKey,
                  collectionName: getDetailsCollectionName(ctx, collection),
                  fieldPath: fullName,
                },
              },
            },
            subModels: {
              field: {
                use: 'DisplayJsonPreviewFieldModel',
                props: {
                  defaultExpandAll: true,
                  showRoot: true,
                },
              },
            },
          }),
        };
      });
  }
}

DetailsJsonFieldItemModel.define({
  label: tExpr('JSON fields'),
  searchable: true,
  searchPlaceholder: tExpr('Search fields'),
  sort: 115,
});
