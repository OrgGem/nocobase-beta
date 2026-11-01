/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { BlockModel } from '@nocobase/client-v2';
import { tExpr } from '@nocobase/flow-engine';
import React from 'react';
import { OcrVerifyBlock } from '../components/OcrVerifyBlock';
import { NAMESPACE } from '../../shared/constants';
import type { OcrBlockProps } from '../types';
import { CategorySelect } from '../components/CategorySelect';

export class OcrVerifyBlockModel extends BlockModel {
  // Only override renderComponent — base BlockModel.render() wraps this in
  // BlockItemCard with title, description, heightMode, and settings toolbar.
  renderComponent() {
    const blockProps = this.props || {};
    return <OcrVerifyBlock {...blockProps} />;
  }
}

OcrVerifyBlockModel.define({
  label: tExpr('OCR Verify', { ns: NAMESPACE }),
  createModelOptions: {
    use: 'OcrVerifyBlockModel',
  },
});

// Settings flow for v2 runtime.
// Title, description, block height, linkage rules, and remove are inherited
// from BlockModel.registerFlow('cardSettings') automatically.
OcrVerifyBlockModel.registerFlow({
  key: 'ocrVerifyBlockSettings',
  title: tExpr('OCR Verify block settings', { ns: NAMESPACE }),
  sort: -100,
  steps: {
    editOcrVerifyBlock: {
      title: tExpr('Edit OCR Verify block', { ns: NAMESPACE }),
      uiSchema(ctx) {
        const t = (key: string) => ctx.t(key, { ns: NAMESPACE });
        return {
          sourceMode: {
            title: t('Source mode'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Select',
            default: 'currentRecord',
            enum: [
              { label: t('Current record'), value: 'currentRecord' },
              { label: t('Manual record'), value: 'manualRecord' },
            ],
            required: true,
          },
          collection: {
            title: t('Collection'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            description: t('Optional for current-record blocks.'),
          },
          recordId: {
            title: t('Record ID'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            description: t('Only used in manual-record mode.'),
          },
          pdfField: {
            title: t('PDF attachment field'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            required: true,
          },
          jsonField: {
            title: t('OCR JSON field'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            required: true,
          },
          statusField: {
            title: t('Status field'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            description: t('String field updated to accepted/rejected.'),
          },
          categoryId: {
            title: t('Verify category / profile'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': CategorySelect,
            required: true,
          },
        };
      },
      handler(ctx, params: OcrBlockProps) {
        ctx.model.setProps(params);
      },
    },
  },
});
