import React, { createContext, useContext } from 'react';
import { useRequest } from '@nocobase/client';

interface AIEmployeeInfo {
  username: string;
  nickname: string;
  about?: string;
}

interface AIEmployeesContextType {
  employees: AIEmployeeInfo[];
  employeeMap: Map<string, string>;
  loading: boolean;
}

const AIEmployeesContext = createContext<AIEmployeesContextType>({
  employees: [],
  employeeMap: new Map(),
  loading: false,
});

/**
 * P3 FIX: Shared context provider that fetches aiEmployees once
 * and shares the data across RulesTab, TracingTab, and AIEmployeeSelect.
 */
export const AIEmployeesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data, loading } = useRequest({
    url: 'aiEmployees:list',
    params: { pageSize: 200 },
  });

  const value = React.useMemo(() => {
    const rawEmployees = (data as any)?.data || [];
    const employees: AIEmployeeInfo[] = rawEmployees.map((emp: any) => ({
      username: emp.username,
      nickname: emp.nickname || emp.username,
      about: emp.about?.substring(0, 80),
    }));

    const employeeMap = new Map<string, string>();
    for (const emp of employees) {
      employeeMap.set(emp.username, emp.nickname);
    }

    return { employees, employeeMap, loading };
  }, [data, loading]);

  return (
    <AIEmployeesContext.Provider value={value}>
      {children}
    </AIEmployeesContext.Provider>
  );
};

/**
 * Hook to access shared AI employees data.
 */
export const useAIEmployees = () => useContext(AIEmployeesContext);
