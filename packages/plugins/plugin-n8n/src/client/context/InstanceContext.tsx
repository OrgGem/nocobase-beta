import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAPIClient, useRequest } from '@nocobase/client';

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

  const { data, loading } = useRequest<any>({
    resource: 'n8nInstances',
    action: 'list',
    params: { pageSize: 100, filter: { enabled: true } },
  });

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
