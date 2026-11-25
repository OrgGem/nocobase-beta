// SPDX-License-Identifier: Apache-2.0

import { observer, useFieldSchema } from '@formily/react';
import React from 'react';
import { HaproxyConsoleView, type HaproxyBlockViewMode } from '../client-v2/components/HaproxyConsoleView';
import type { HaproxyMonitorTabKey } from '../client-v2/components/HaproxyMonitorView';

export interface HaproxyDataplaneBlockLegacyProps {
  viewMode?: HaproxyBlockViewMode;
  connectionId?: number;
  refreshSeconds?: number;
  defaultTab?: HaproxyMonitorTabKey;
}

export const HaproxyDataplaneBlock = observer(
  (props: HaproxyDataplaneBlockLegacyProps) => {
    const fieldSchema = useFieldSchema();
    const schemaProps = (fieldSchema?.['x-component-props'] ?? {}) as HaproxyDataplaneBlockLegacyProps;
    const viewMode = props.viewMode ?? schemaProps.viewMode ?? 'console';
    const connectionId = props.connectionId ?? schemaProps.connectionId;
    const refreshSeconds = props.refreshSeconds ?? schemaProps.refreshSeconds ?? 0;
    const defaultTab = props.defaultTab ?? schemaProps.defaultTab ?? 'servers';

    return (
      <HaproxyConsoleView
        viewMode={viewMode}
        fixedConnectionId={connectionId}
        defaultRefreshSeconds={refreshSeconds}
        defaultTab={defaultTab}
      />
    );
  },
  { displayName: 'HaproxyDataplaneBlock' },
);
