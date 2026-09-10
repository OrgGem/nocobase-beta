/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { tExpr } from '../i18n';
import {
  applyTimelineFieldNames,
  COLOR_FIELD_TYPES,
  DATE_FIELD_TYPES,
  normalizePageSize,
  TEXT_FIELD_TYPES,
} from './TimelineBlockModel.helpers';
import type { TimelineBlockModel } from './TimelineBlockModel';

type SettingsContext = { model: unknown; t?: (str: string) => string };

const getTimelineModel = (ctx: SettingsContext): TimelineBlockModel => ctx.model as TimelineBlockModel;

export function registerTimelineBlockModelSettings(Model: typeof TimelineBlockModel): void {
  Model.registerFlow({
    key: 'timelineSettings',
    sort: 500,
    title: tExpr('Timeline'),
    steps: {
      fields: {
        title: tExpr('Timeline fields'),
        uiSchema(ctx: SettingsContext) {
          const model = getTimelineModel(ctx);
          const dateOptions = model.getFieldOptions(DATE_FIELD_TYPES);
          const titleOptions = model.getFieldOptions(TEXT_FIELD_TYPES);
          const contentOptions = model.getFieldOptions(TEXT_FIELD_TYPES);
          const statusOptions = model.getFieldOptions(COLOR_FIELD_TYPES);
          const fieldNames = model.getFieldNames();

          return {
            date: {
              type: 'string',
              title: tExpr('Date field'),
              required: true,
              enum: dateOptions,
              default: fieldNames.date,
              'x-component': 'Select',
              'x-decorator': 'FormItem',
              'x-component-props': { options: dateOptions },
            },
            title: {
              type: 'string',
              title: tExpr('Title field'),
              required: true,
              enum: titleOptions,
              default: fieldNames.title,
              'x-component': 'Select',
              'x-decorator': 'FormItem',
              'x-component-props': { options: titleOptions },
            },
            content: {
              type: 'string',
              title: tExpr('Content field'),
              enum: contentOptions,
              default: fieldNames.content ?? null,
              'x-component': 'Select',
              'x-decorator': 'FormItem',
              'x-component-props': { options: contentOptions, allowClear: true },
            },
            status: {
              type: 'string',
              title: tExpr('Status field'),
              enum: statusOptions,
              default: fieldNames.status ?? null,
              'x-component': 'Select',
              'x-decorator': 'FormItem',
              'x-component-props': { options: statusOptions, allowClear: true },
            },
          };
        },
        defaultParams() {
          return {};
        },
        handler(ctx: SettingsContext, params: Record<string, unknown>) {
          applyTimelineFieldNames(ctx.model as TimelineBlockModel, params);
        },
        beforeParamsSave(ctx: SettingsContext, params: Record<string, unknown>) {
          applyTimelineFieldNames(ctx.model as TimelineBlockModel, params);
        },
      },
      colorByStatus: {
        title: tExpr('Color by status'),
        uiMode: { type: 'switch', key: 'colorByStatus' },
        defaultParams(ctx: SettingsContext) {
          return { colorByStatus: getTimelineModel(ctx).isColorByStatusEnabled() };
        },
        handler(ctx: SettingsContext, params: Record<string, unknown>) {
          getTimelineModel(ctx).setProps({ colorByStatus: !!params.colorByStatus });
        },
        beforeParamsSave(ctx: SettingsContext, params: Record<string, unknown>) {
          getTimelineModel(ctx).setProps({ colorByStatus: !!params.colorByStatus });
        },
      },
      order: {
        title: tExpr('Sort order'),
        uiMode() {
          return {
            type: 'select',
            key: 'order',
            props: {
              options: [
                { label: tExpr('Newest first'), value: 'desc' },
                { label: tExpr('Oldest first'), value: 'asc' },
              ],
            },
          };
        },
        defaultParams(ctx: SettingsContext) {
          return { order: getTimelineModel(ctx).getOrder() };
        },
        handler(ctx: SettingsContext, params: Record<string, unknown>) {
          getTimelineModel(ctx).setProps({ order: params.order === 'asc' ? 'asc' : 'desc' });
        },
        beforeParamsSave(ctx: SettingsContext, params: Record<string, unknown>) {
          getTimelineModel(ctx).setProps({ order: params.order === 'asc' ? 'asc' : 'desc' });
        },
      },
      pageSize: {
        title: tExpr('Page size'),
        uiSchema() {
          return {
            pageSize: {
              type: 'number',
              title: tExpr('Page size'),
              'x-component': 'InputNumber',
              'x-decorator': 'FormItem',
              'x-component-props': { min: 1, step: 1, style: { width: '100%' } },
            },
          };
        },
        defaultParams(ctx: SettingsContext) {
          return { pageSize: getTimelineModel(ctx).getPageSize() };
        },
        async handler(ctx: SettingsContext, params: Record<string, unknown>) {
          const model = getTimelineModel(ctx);
          const pageSize = normalizePageSize(params.pageSize);
          model.setProps({ pageSize });
          model.resource.loading = true;
          model.resource.setPage(1);
          model.resource.setPageSize(pageSize);
          await model.resource.refresh();
        },
        beforeParamsSave(ctx: SettingsContext, params: Record<string, unknown>) {
          getTimelineModel(ctx).setProps({ pageSize: normalizePageSize(params.pageSize) });
        },
      },
    },
  });
}
