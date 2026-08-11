import React from 'react';
import { CorrelationTracePanel } from '../CorrelationTracePanel';
import { useCurrentInstance } from '../context/InstanceContext';

export const QueueItemTracePanel: React.FC<{ itemId: number }> = ({ itemId }) => {
  const { instanceId, folderId, folderKey, folderPath, folderReady } = useCurrentInstance();
  return (
    <CorrelationTracePanel
      target={{ kind: 'queueItem', id: itemId }}
      instanceId={instanceId}
      folderId={folderId}
      folderKey={folderKey}
      folderPath={folderPath}
      folderReady={folderReady}
    />
  );
};
