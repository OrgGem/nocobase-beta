import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { getListRows } from '../utils/apiResponse';
import type { DateRangeValue } from '../utils/odataFilters';

interface UiPathInstanceRecord {
  id: number;
  isDefault?: boolean;
  defaultFolderId?: number | null;
  defaultFolderKey?: string | null;
  [key: string]: unknown;
}

interface UiPathFolderRecord {
  folderId: number;
  folderKey?: string | null;
  [key: string]: unknown;
}

interface InstanceContextType {
  instanceId: number | null;
  setInstanceId: (id: number | null) => void;
  instances: UiPathInstanceRecord[];
  loading: boolean;
  refreshInstances: () => void;
  folderId: number | null;
  folderKey: string | null;
  setFolder: (folderId: number | null, folderKey: string | null) => void;
  folders: UiPathFolderRecord[];
  foldersLoading: boolean;
  refreshFolders: () => void;
  dateRange: DateRangeValue;
  setDateRange: (range: DateRangeValue) => void;
  processFilter: string;
  setProcessFilter: (value: string) => void;
  queueFilter: string;
  setQueueFilter: (value: string) => void;
}

const InstanceContext = createContext<InstanceContextType>({
  instanceId: null,
  setInstanceId: () => {},
  instances: [],
  loading: false,
  refreshInstances: () => {},
  folderId: null,
  folderKey: null,
  setFolder: () => {},
  folders: [],
  foldersLoading: false,
  refreshFolders: () => {},
  dateRange: null,
  setDateRange: () => {},
  processFilter: '',
  setProcessFilter: () => {},
  queueFilter: '',
  setQueueFilter: () => {},
});

export const useCurrentInstance = () => useContext(InstanceContext);

export const InstanceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [folderKey, setFolderKey] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeValue>(null);
  const [processFilter, setProcessFilter] = useState('');
  const [queueFilter, setQueueFilter] = useState('');

  const api = useApp().apiClient;

  // Fetch instances
  const {
    data: instData,
    loading,
    refresh: refreshInstances,
  } = useRequest<any>(() => api.resource('uipathInstances').list({ pageSize: 100, filter: { enabled: true } }));
  const instances = useMemo(() => getListRows<UiPathInstanceRecord>(instData), [instData]);

  // Auto-select default instance
  useEffect(() => {
    if (instances.length === 0) {
      if (instanceId !== null) {
        setInstanceId(null);
      }
      return;
    }

    if (instanceId === null || !instances.some((i: UiPathInstanceRecord) => i.id === instanceId)) {
      const defaultInst = instances.find((i: UiPathInstanceRecord) => i.isDefault);
      setInstanceId(defaultInst ? defaultInst.id : instances[0].id);
    }
  }, [instances, instanceId]);

  // Fetch cached folders for current instance
  const {
    data: folderData,
    loading: foldersLoading,
    refresh: refreshFolders,
  } = useRequest<any>(() => api.resource('uipathFoldersCache').list({ pageSize: 500, filter: { instanceId } }), {
    ready: !!instanceId,
    refreshDeps: [instanceId],
  });
  const folders = useMemo(() => getListRows<UiPathFolderRecord>(folderData), [folderData]);

  // Auto-select default folder from instance config
  useEffect(() => {
    if (instanceId && instances.length > 0) {
      const inst = instances.find((i: UiPathInstanceRecord) => i.id === instanceId);
      if (inst) {
        setFolderId(inst.defaultFolderId || null);
        setFolderKey(inst.defaultFolderKey || null);
      }
    }
  }, [instanceId, instances]);

  const setFolder = (id: number | null, key: string | null) => {
    setFolderId(id);
    setFolderKey(key);
  };

  return (
    <InstanceContext.Provider
      value={{
        instanceId,
        setInstanceId,
        instances,
        loading,
        refreshInstances,
        folderId,
        folderKey,
        setFolder,
        folders,
        foldersLoading,
        refreshFolders,
        dateRange,
        setDateRange,
        processFilter,
        setProcessFilter,
        queueFilter,
        setQueueFilter,
      }}
    >
      {children}
    </InstanceContext.Provider>
  );
};
