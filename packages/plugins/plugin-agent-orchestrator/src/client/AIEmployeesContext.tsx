import React, { createContext, useContext } from 'react';
import { useRequest } from '@nocobase/client';

interface AIEmployeeInfo {
  username: string;
  nickname: string;
  about?: string;
  skills: string[];
}

interface AIEmployeesContextType {
  employees: AIEmployeeInfo[];
  employeeMap: Map<string, string>;
  skillsMap: Map<string, Set<string>>;
  loading: boolean;
  refresh: () => void;
}

const AIEmployeesContext = createContext<AIEmployeesContextType>({
  employees: [],
  employeeMap: new Map(),
  skillsMap: new Map(),
  loading: false,
  refresh: () => {},
});

/**
 * P3 FIX: Shared context provider that fetches aiEmployees once
 * and shares the data across RulesTab, TracingTab, and AIEmployeeSelect.
 *
 * Also exposes each employee's configured skills so RulesTab can warn when
 * a delegation rule exists but the leader hasn't added the corresponding
 * delegate_<leader>_to_<sub> tool to its skillSettings.
 */
export const AIEmployeesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data, loading, refresh } = useRequest({
    url: 'aiEmployees:list',
    params: { pageSize: 200 },
  });

  const value = React.useMemo(() => {
    const rawEmployees = (data as any)?.data || [];
    const employees: AIEmployeeInfo[] = rawEmployees.map((emp: any) => {
      const skills = Array.isArray(emp.skillSettings?.skills)
        ? emp.skillSettings.skills
            .map((s: any) => (typeof s === 'string' ? s : s?.name))
            .filter((name: any): name is string => typeof name === 'string' && name.length > 0)
        : [];
      return {
        username: emp.username,
        nickname: emp.nickname || emp.username,
        about: emp.about?.substring(0, 80),
        skills,
      };
    });

    const employeeMap = new Map<string, string>();
    const skillsMap = new Map<string, Set<string>>();
    for (const emp of employees) {
      employeeMap.set(emp.username, emp.nickname);
      skillsMap.set(emp.username, new Set(emp.skills));
    }

    return { employees, employeeMap, skillsMap, loading, refresh };
  }, [data, loading, refresh]);

  return <AIEmployeesContext.Provider value={value}>{children}</AIEmployeesContext.Provider>;
};

/**
 * Hook to access shared AI employees data.
 */
export const useAIEmployees = () => useContext(AIEmployeesContext);
