import React, { createContext, useContext, useState, useEffect } from 'react';
import { useRequest } from '@nocobase/client';

interface InstanceContextType {
  instanceId: number | null;
  setInstanceId: (id: number | null) => void;
  instances: any[];
  loading: boolean;
  folderId: number | null;
  folderKey: string | null;
  setFolder: (folderId: number | null, folderKey: string | null) => void;
  folders: any[];
  foldersLoading: boolean;
}

const InstanceContext = createContext<InstanceContextType>({
  instanceId: null,
  setInstanceId: () => {},
  instances: [],
  loading: false,
  folderId: null,
  folderKey: null,
  setFolder: () => {},
  folders: [],
  foldersLoading: false,
});

export const useCurrentInstance = () => useContext(InstanceContext);

export const InstanceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [folderKey, setFolderKey] = useState<string | null>(null);

  // Fetch instances
  const { data: instData, loading } = useRequest<any>({
    resource: 'uipathInstances',
    action: 'list',
    params: { pageSize: 100, filter: { enabled: true } },
  });
  const instances = instData?.data || [];

  // Auto-select default instance
  useEffect(() => {
    if (instances.length > 0 && instanceId === null) {
      const defaultInst = instances.find((i: any) => i.isDefault);
      setInstanceId(defaultInst ? defaultInst.id : instances[0].id);
    }
  }, [instances, instanceId]);

  // Fetch cached folders for current instance
  const { data: folderData, loading: foldersLoading } = useRequest<any>(
    {
      resource: 'uipathFoldersCache',
      action: 'list',
      params: { pageSize: 500, filter: { instanceId } },
    },
    { ready: !!instanceId, refreshDeps: [instanceId] },
  );
  const folders = folderData?.data || [];

  // Auto-select default folder from instance config
  useEffect(() => {
    if (instanceId && instances.length > 0) {
      const inst = instances.find((i: any) => i.id === instanceId);
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
        instanceId, setInstanceId, instances, loading,
        folderId, folderKey, setFolder, folders, foldersLoading,
      }}
    >
      {children}
    </InstanceContext.Provider>
  );
};
