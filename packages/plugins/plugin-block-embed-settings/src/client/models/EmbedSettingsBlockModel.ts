/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { BlockModel } from '@nocobase/client-v2';
import { escapeT } from '@nocobase/flow-engine';
import React from 'react';
import { EmbedSettingsBlock } from '../EmbedSettingsBlock';
import {
  decodeCollectionPath,
  EmbedSettingsCollectionSelect,
  encodeCollectionPath,
} from '../EmbedSettingsCollectionSelect';
import { EmbedSettingsPluginSelect } from '../EmbedSettingsPluginSelect';
import { EmbedSettingsTabSelect } from '../EmbedSettingsTabSelect';
import { NAMESPACE } from '../locale';
import type { EmbedSettingsTabOption, PluginSettingEntry } from '../types';

type ReactionField = {
  form: { values?: { pluginName?: string } };
  hidden?: boolean;
  required?: boolean;
  value?: unknown;
  setValue: (value: unknown) => void;
};

type SettingsManagerHost = {
  pluginSettingsManager?: {
    has: (name: string) => boolean;
    get: (name: string, filterAuth?: boolean) => PluginSettingEntry | null | undefined;
    getSetting?: (
      name: string,
    ) =>
      | { embedSettings?: PluginSettingEntry['embedSettings']; children?: Record<string, PluginSettingEntry> }
      | undefined;
  };
};

const hasRequiresCollection = (setting?: PluginSettingEntry | EmbedSettingsTabOption): boolean => {
  if (!setting) return false;
  const embedMeta = 'embedSettings' in setting ? setting.embedSettings : undefined;
  if (embedMeta?.requiresCollection) return true;
  const tabs = typeof embedMeta?.tabs === 'function' ? embedMeta.tabs(setting as PluginSettingEntry) : embedMeta?.tabs;
  return (
    Array.isArray(tabs) &&
    tabs.some(
      (tab) =>
        Boolean((tab as PluginSettingEntry)?.embedSettings?.requiresCollection) ||
        Boolean((tab as Record<string, unknown>)?.requiresCollection),
    )
  );
};

export const pluginRequiresCollection = (app: SettingsManagerHost | undefined, pluginName?: string): boolean => {
  const manager = app?.pluginSettingsManager;
  if (!pluginName || !manager?.has(pluginName)) return false;
  const setting = manager.get(pluginName, false) || manager.get(pluginName);
  if (hasRequiresCollection(setting || undefined)) return true;
  if (Array.isArray(setting?.children) && setting.children.some((child) => hasRequiresCollection(child))) {
    return true;
  }
  const rawSetting = manager.getSetting?.(pluginName);
  if (hasRequiresCollection(rawSetting as PluginSettingEntry | undefined)) return true;
  return Object.values(rawSetting?.children || {}).some((child) => hasRequiresCollection(child));
};

export class EmbedSettingsBlockModel extends BlockModel {
  renderComponent() {
    const { pluginName, enabledTabKeys, dataSourceName, collectionName } = this.props;
    return React.createElement(EmbedSettingsBlock, { pluginName, enabledTabKeys, dataSourceName, collectionName });
  }
}

EmbedSettingsBlockModel.registerFlow({
  key: 'embedSettingsBlockSettings',
  title: escapeT('Embed settings block setting', { ns: NAMESPACE }),
  steps: {
    selectPlugin: {
      title: escapeT('Select plugin', { ns: NAMESPACE }),
      uiSchema(ctx) {
        const t = (key: string) => ctx.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback' });
        return {
          pluginName: {
            title: t('Select plugin'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': EmbedSettingsPluginSelect,
            'x-component-props': {
              placeholder: t('Select plugin'),
            },
            required: true,
          },
          enabledTabKeys: {
            title: t('Enabled tabs'),
            type: 'array',
            'x-decorator': 'FormItem',
            'x-component': EmbedSettingsTabSelect,
          },
          collectionPath: {
            title: t('Collection'),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': EmbedSettingsCollectionSelect,
            default: encodeCollectionPath(ctx.model.props.dataSourceName, ctx.model.props.collectionName),
            'x-reactions': (field: ReactionField) => {
              const requiresCollection = pluginRequiresCollection(ctx.app, field.form.values?.pluginName);
              field.hidden = !requiresCollection;
              field.required = requiresCollection;
              if (!requiresCollection && field.value) {
                field.setValue(undefined);
              }
            },
          },
        };
      },
      async handler(ctx, params) {
        const { pluginName, enabledTabKeys, collectionPath } = params;
        const requiresCollection = ctx.app?.pluginSettingsManager
          ? pluginRequiresCollection(ctx.app, pluginName)
          : Boolean(collectionPath);
        const { dataSourceName, collectionName } =
          requiresCollection && collectionPath
            ? decodeCollectionPath(collectionPath)
            : { dataSourceName: undefined, collectionName: undefined };
        ctx.model.setProps({
          pluginName,
          enabledTabKeys: Array.isArray(enabledTabKeys) ? enabledTabKeys : undefined,
          dataSourceName,
          collectionName,
        });
      },
    },
  },
});

EmbedSettingsBlockModel.define({
  label: escapeT('Plugin Settings', { ns: NAMESPACE }),
});
