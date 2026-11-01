/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CreateFormModel, FormSubmitActionModel } from '@nocobase/client-v2';
import { SingleRecordResource, tExpr } from '@nocobase/flow-engine';
import type { AxiosRequestConfig } from 'axios';

export class SharedSubmitResource extends SingleRecordResource<Record<string, unknown>> {
  async save(values: Record<string, unknown>, options?: AxiosRequestConfig): Promise<void> {
    this.setMeta({ sharedSubmitSucceeded: false });
    if (this.context.flowSettingsEnabled)
      throw new Error(this.context.t('Preview cannot submit records', { ns: 'plugin-shared-forms' }));
    await this.runAction('sharedSubmit', {
      params: options?.params,
      data: values,
      headers: { ...options?.headers, 'X-Shared-Form-Key': this.context.sharedFormKey, 'X-Shared-Form-Version': '2' },
    });
    this.markDataSourceDirty();
    this.setMeta({ sharedSubmitSucceeded: true });
    this.emit('saved', values);
  }
}

export class SharedFormModel extends CreateFormModel {
  createResource() {
    const resource = this.context.createResource(SharedSubmitResource);
    resource.isNewRecord = true;
    return resource;
  }
}

export class SharedFormSubmitActionModel extends FormSubmitActionModel {
  onClick(event: React.MouseEvent) {
    this.context.resource?.setMeta({ sharedSubmitSucceeded: false });
    this.dispatchEvent('click', { event }, { debounce: true, sequential: true });
  }
}
SharedFormSubmitActionModel.define({
  label: tExpr('Submit'),
  hide: (ctx) => !ctx.allowedFormActionModelNames?.includes('SharedFormSubmitActionModel'),
});
SharedFormSubmitActionModel.registerFlow({
  key: 'sharedFormSubmission',
  on: { eventName: 'click', phase: 'afterAllFlows' },
  steps: {
    success: {
      handler(ctx) {
        if (ctx.publicFormRuntime && ctx.resource?.getMeta('sharedSubmitSucceeded')) ctx.setSharedFormSubmitted(true);
      },
    },
  },
});

export function formModelOptions(dataSourceKey: string, collectionName: string) {
  return {
    use: 'SharedFormModel',
    stepParams: { resourceSettings: { init: { dataSourceKey, collectionName } } },
    subModels: { grid: { use: 'FormGridModel' }, actions: [{ use: 'SharedFormSubmitActionModel' }] },
  };
}
