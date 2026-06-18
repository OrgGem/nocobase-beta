import React, { createContext, useContext, useState, useEffect } from 'react';
import { useRequest } from 'ahooks';
import { useApp } from '@nocobase/client-v2';

interface InstanceContextType {
  instanceId: number | null;
  setInstanceId: (id: number | null) => void;
  instances: any[];
  loading: boolean;
}

const InstanceContext = createContext<InstanceContextType>({
  instanceId: null,
  setInstanceId: () => {},
  instances: [],
  loading: false,
});

export const useCurrentInstance = () => useContext(InstanceContext);

export const InstanceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [instanceId, setInstanceId] = useState<number | null>(null);

  const api = useApp().apiClient;
  const { data, loading } = useRequest<any>(() =>
    api.resource('n8nInstances').list({ pageSize: 100, filter: { enabled: true } }),
  );

  const instances = data?.data || [];

  useEffect(() => {
    if (instances.length > 0 && instanceId === null) {
      const defaultInst = instances.find((i: any) => i.isDefault);
      setInstanceId(defaultInst ? defaultInst.id : instances[0].id);
    }
  }, [instances, instanceId]);

  return (
    <InstanceContext.Provider value={{ instanceId, setInstanceId, instances, loading }}>
      {children}
    </InstanceContext.Provider>
  );
};
