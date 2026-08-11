import React, { createContext, useContext, useState, useEffect, useMemo, useRef } from 'react';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';
import { getListRows } from '../utils/apiResponse';
import type { DateRangeValue } from '../utils/odataFilters';
import { selectInitialFolder } from '../utils/folderSelection';

interface UiPathInstanceRecord {
  id: number;
  isDefault?: boolean;
  defaultFolderId?: number | null;
  defaultFolderKey?: string | null;
  defaultFolderPath?: string | null;
  [key: string]: unknown;
}

interface UiPathFolderRecord {
  folderId: number;
  folderKey?: string | null;
  fullyQualifiedName?: string | null;
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
  folderPath: string | null;
  folderReady: boolean;
  setFolder: (folderId: number | null, folderKey: string | null, folderPath?: string | null) => void;
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
  folderPath: null,
  folderReady: false,
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
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folderReady, setFolderReady] = useState(false);
  const syncAttemptedForInstance = useRef<number | null>(null);
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
  } = useRequest(
    async () => ({
      instanceId,
      response: await api.resource('uipathFoldersCache').list({ pageSize: 500, filter: { instanceId } }),
    }),
    {
      ready: !!instanceId,
      refreshDeps: [instanceId],
    },
  );
  const folders = useMemo(
    () => (folderData?.instanceId === instanceId ? getListRows<UiPathFolderRecord>(folderData.response) : []),
    [folderData, instanceId],
  );

  // Reset the folder while the selected instance's cache is loading. This prevents
  // folder-scoped requests from being sent with an old or missing folder header.
  useEffect(() => {
    setFolderId(null);
    setFolderKey(null);
    setFolderPath(null);
    setFolderReady(false);
    syncAttemptedForInstance.current = null;
  }, [instanceId]);

  // Select the configured default folder when it still exists; otherwise use the
  // first cached folder. If the cache is empty, synchronize it once from UiPath.
  useEffect(() => {
    if (!instanceId || foldersLoading || folderData?.instanceId !== instanceId) return;

    const inst = instances.find((item) => item.id === instanceId);
    const selectedFolder = selectInitialFolder(inst, folders);

    if (selectedFolder) {
      setFolderId(selectedFolder.folderId);
      setFolderKey(selectedFolder.folderKey || null);
      setFolderPath(selectedFolder.fullyQualifiedName || inst?.defaultFolderPath || null);
      setFolderReady(true);
      return;
    }

    if (syncAttemptedForInstance.current === instanceId) return;
    syncAttemptedForInstance.current = instanceId;
    const syncFolders = async () => {
      try {
        await api.request({ url: 'uipathFolders:sync', params: { instanceId } });
        refreshFolders();
      } catch {
        // Keep folderReady=false: folder-scoped requests must not run without context.
      }
    };

    syncFolders();
  }, [api, folderData?.instanceId, folders, foldersLoading, instanceId, instances, refreshFolders]);

  const setFolder = (id: number | null, key: string | null, path?: string | null) => {
    setFolderId(id);
    setFolderKey(key);
    setFolderPath(path || null);
    setFolderReady(Boolean(id || key || path));
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
        folderPath,
        folderReady,
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
