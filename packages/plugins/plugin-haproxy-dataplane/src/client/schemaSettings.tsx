// SPDX-License-Identifier: Apache-2.0

import { useFieldSchema } from '@formily/react';
import { ACLContext, SchemaSettings, useACLContext, useDesignable } from '@nocobase/client';
import { createElement, type PropsWithChildren } from 'react';
import { ConnectionSelect } from '../client-v2/components/ConnectionSelect';
import type { HaproxyBlockViewMode } from '../client-v2/components/HaproxyConsoleView';
import type { HaproxyMonitorTabKey } from '../client-v2/components/HaproxyMonitorView';
import { useT } from '../client-v2/locale';

interface HaproxySettingsSubmitValues {
  viewMode?: HaproxyBlockViewMode;
  connectionId?: number;
  refreshSeconds?: number;
  defaultTab?: HaproxyMonitorTabKey;
}

export const haproxyDataplaneBlockSettings = new SchemaSettings({
  name: 'haproxyDataplaneBlockSettings',
  items: [
    {
      name: 'configureMonitor',
      type: 'modal',
      useComponentProps() {
        const fieldSchema = useFieldSchema();
        const { dn } = useDesignable();
        const acl = useACLContext();
        const t = useT();

        const currentProps = (fieldSchema?.['x-component-props'] ?? {}) as HaproxySettingsSubmitValues;

        return {
          title: t('Configure HAProxy monitor'),
          ModalContextProvider({ children }: PropsWithChildren) {
            return createElement(ACLContext.Provider, { value: acl }, children);
          },
          schema: {
            type: 'object',
            properties: {
              viewMode: {
                title: t('Mode'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'Select',
                default: currentProps.viewMode ?? 'console',
                enum: [
                  { value: 'console', label: t('HAProxy Data Plane') },
                  { value: 'monitor', label: t('Live Stats & Runtime') },
                  { value: 'fleet', label: t('Fleet Overview') },
                ],
              },
              connectionId: {
                title: t('Fixed connection (optional)'),
                type: 'number',
                'x-decorator': 'FormItem',
                'x-component': ConnectionSelect,
                default: currentProps.connectionId,
              },
              refreshSeconds: {
                title: t('Auto-refresh interval (seconds)'),
                type: 'number',
                'x-decorator': 'FormItem',
                'x-component': 'Select',
                default: currentProps.refreshSeconds ?? 0,
                enum: [
                  { value: 0, label: t('Off') },
                  { value: 5, label: '5s' },
                  { value: 10, label: '10s' },
                  { value: 30, label: '30s' },
                ],
              },
              defaultTab: {
                title: t('Default tab'),
                type: 'string',
                'x-decorator': 'FormItem',
                'x-component': 'Select',
                default: currentProps.defaultTab ?? 'servers',
                enum: [
                  { value: 'servers', label: t('Servers (Runtime)') },
                  { value: 'backends', label: t('Backends') },
                  { value: 'frontends', label: t('Frontends') },
                  { value: 'runtimeMaps', label: t('Runtime Maps & Stick Tables') },
                ],
              },
            },
          },
          onSubmit(values: HaproxySettingsSubmitValues) {
            const componentProps = {
              ...fieldSchema['x-component-props'],
              viewMode: values.viewMode ?? 'console',
              connectionId: values.connectionId,
              refreshSeconds: values.refreshSeconds ?? 0,
              defaultTab: values.defaultTab ?? 'servers',
            };
            fieldSchema['x-component-props'] = componentProps;
            dn.emit('patch', {
              schema: {
                'x-uid': fieldSchema['x-uid'],
                'x-component-props': componentProps,
              },
            });
            dn.refresh();
          },
        };
      },
    },
    {
      name: 'divider',
      type: 'divider',
    },
    {
      name: 'delete',
      type: 'remove',
      useComponentProps() {
        return {
          removeParentsIfNoChildren: true,
          breakRemoveOn: {
            'x-component': 'Grid',
          },
        };
      },
    },
  ],
});
