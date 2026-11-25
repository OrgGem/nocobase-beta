// SPDX-License-Identifier: Apache-2.0

import { BlockModel } from '@nocobase/client';
import React from 'react';
import { ConnectionSelect } from '../../client-v2/components/ConnectionSelect';
import { HaproxyConsoleView, type HaproxyBlockViewMode } from '../../client-v2/components/HaproxyConsoleView';
import type { HaproxyMonitorTabKey } from '../../client-v2/components/HaproxyMonitorView';
import { tExpr } from '../../client-v2/locale';

interface HaproxyBlockProps {
  viewMode?: HaproxyBlockViewMode;
  connectionId?: number;
  refreshSeconds?: number;
  defaultTab?: HaproxyMonitorTabKey;
}

export class HaproxyDataplaneBlockModel extends BlockModel {
  renderComponent() {
    const typedProps = (this.props ?? {}) as HaproxyBlockProps;
    return (
      <HaproxyConsoleView
        viewMode={typedProps.viewMode ?? 'console'}
        fixedConnectionId={typedProps.connectionId}
        defaultRefreshSeconds={typedProps.refreshSeconds ?? 0}
        defaultTab={typedProps.defaultTab ?? 'servers'}
      />
    );
  }
}

HaproxyDataplaneBlockModel.define({
  label: tExpr('HAProxy Data Plane'),
  createModelOptions: {
    use: 'HaproxyDataplaneBlockModel',
  },
});

HaproxyDataplaneBlockModel.registerFlow({
  key: 'haproxyDataplaneBlockSettings',
  title: tExpr('HAProxy block settings'),
  steps: {
    configureMonitor: {
      title: tExpr('Configure HAProxy monitor'),
      uiSchema: {
        viewMode: {
          title: tExpr('Mode'),
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          enum: [
            { value: 'console', label: tExpr('HAProxy Data Plane') },
            { value: 'monitor', label: tExpr('Live Stats & Runtime') },
            { value: 'fleet', label: tExpr('Fleet Overview') },
          ],
        },
        connectionId: {
          title: tExpr('Fixed connection (optional)'),
          type: 'number',
          'x-decorator': 'FormItem',
          'x-component': ConnectionSelect,
        },
        refreshSeconds: {
          title: tExpr('Auto-refresh interval (seconds)'),
          type: 'number',
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          enum: [
            { value: 0, label: tExpr('Off') },
            { value: 5, label: '5s' },
            { value: 10, label: '10s' },
            { value: 30, label: '30s' },
          ],
        },
        defaultTab: {
          title: tExpr('Default tab'),
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          enum: [
            { value: 'servers', label: tExpr('Servers (Runtime)') },
            { value: 'backends', label: tExpr('Backends') },
            { value: 'frontends', label: tExpr('Frontends') },
            { value: 'runtimeMaps', label: tExpr('Runtime Maps & Stick Tables') },
          ],
        },
      },
      defaultParams: {
        viewMode: 'console',
        refreshSeconds: 0,
        defaultTab: 'servers',
      },
      handler(ctx, params: HaproxyBlockProps) {
        ctx.model.setProps({
          viewMode: params.viewMode ?? 'console',
          connectionId: params.connectionId,
          refreshSeconds: params.refreshSeconds ?? 0,
          defaultTab: params.defaultTab ?? 'servers',
        });
      },
    },
  },
});
