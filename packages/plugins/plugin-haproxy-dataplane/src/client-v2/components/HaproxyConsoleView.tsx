// SPDX-License-Identifier: Apache-2.0

import { Alert, Tabs } from 'antd';
import React from 'react';
import { useHaproxySession } from '../hooks/useHaproxySession';
import { useT } from '../locale';
import { HaproxyConfigView } from './HaproxyConfigView';
import { HaproxyConnectionsView } from './HaproxyConnectionsView';
import { HaproxyFleetView } from './HaproxyFleetView';
import { HaproxyMonitorView, type HaproxyMonitorTabKey } from './HaproxyMonitorView';
import { HaproxyRawConfigView } from './HaproxyRawConfigView';
import { HaproxyReverseProxyView } from './HaproxyReverseProxyView';
import { HaproxyRevisionsView } from './HaproxyRevisionsView';
import { HaproxyStorageView } from './HaproxyStorageView';
import { HaproxyTransactionsView } from './HaproxyTransactionsView';

export type HaproxyBlockViewMode = 'console' | 'monitor' | 'fleet';

export interface HaproxyConsoleViewProps {
  viewMode?: HaproxyBlockViewMode;
  fixedConnectionId?: number;
  defaultRefreshSeconds?: number;
  defaultTab?: HaproxyMonitorTabKey;
}

export const HaproxyConsoleView: React.FC<HaproxyConsoleViewProps> = ({
  viewMode = 'console',
  fixedConnectionId,
  defaultRefreshSeconds = 0,
  defaultTab = 'servers',
}) => {
  const t = useT();
  const { permissions, bootstrapping } = useHaproxySession(fixedConnectionId);

  if (viewMode === 'monitor') {
    return (
      <HaproxyMonitorView
        fixedConnectionId={fixedConnectionId}
        defaultRefreshSeconds={defaultRefreshSeconds}
        defaultTab={defaultTab}
      />
    );
  }

  if (viewMode === 'fleet') {
    return <HaproxyFleetView />;
  }

  if (!bootstrapping && permissions && !permissions.canAccess) {
    return <Alert type="warning" showIcon message={t('You do not have permission to view HAProxy live stats.')} />;
  }

  const canRead = Boolean(
    permissions?.canRead || permissions?.canRuntime || permissions?.canConfig || permissions?.canRawConfig,
  );

  const items = [
    ...(canRead && !fixedConnectionId
      ? [
          {
            key: 'fleet',
            label: t('Fleet Overview'),
            children: <HaproxyFleetView />,
          },
        ]
      : []),
    ...(canRead
      ? [
          {
            key: 'reverse-proxy',
            label: t('Reverse Proxy (In → Out)'),
            children: <HaproxyReverseProxyView fixedConnectionId={fixedConnectionId} />,
          },
          {
            key: 'monitor',
            label: t('Live Stats & Runtime'),
            children: (
              <HaproxyMonitorView
                fixedConnectionId={fixedConnectionId}
                defaultRefreshSeconds={defaultRefreshSeconds}
                defaultTab={defaultTab}
              />
            ),
          },
          {
            key: 'config',
            label: t('Configuration & Routing'),
            children: <HaproxyConfigView fixedConnectionId={fixedConnectionId} />,
          },
          {
            key: 'transactions',
            label: t('Transactions & Reloads'),
            children: <HaproxyTransactionsView fixedConnectionId={fixedConnectionId} />,
          },
          {
            key: 'revisions',
            label: t('Versions, Diff & Audit'),
            children: <HaproxyRevisionsView fixedConnectionId={fixedConnectionId} />,
          },
          {
            key: 'raw',
            label: t('Raw Config & Sync'),
            children: <HaproxyRawConfigView fixedConnectionId={fixedConnectionId} />,
          },
          {
            key: 'storage',
            label: t('SSL, Maps & Storage'),
            children: <HaproxyStorageView fixedConnectionId={fixedConnectionId} />,
          },
        ]
      : []),
    ...(permissions?.canManageConnections && !fixedConnectionId
      ? [
          {
            key: 'connections',
            label: t('Connections'),
            children: <HaproxyConnectionsView />,
          },
        ]
      : []),
  ];

  return <Tabs defaultActiveKey={fixedConnectionId ? 'monitor' : 'fleet'} items={items} />;
};

export default HaproxyConsoleView;
