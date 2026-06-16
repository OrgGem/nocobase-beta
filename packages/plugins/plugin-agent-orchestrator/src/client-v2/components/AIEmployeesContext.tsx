import React, { createContext, useContext } from 'react';
import { useRequest } from '../hooks/useApiRequest';

interface AIEmployeeInfo {
  username: string;
  nickname: string;
  about?: string;
  tools: string[];
}

interface AIEmployeesContextType {
  employees: AIEmployeeInfo[];
  employeeMap: Map<string, string>;
  toolNamesMap: Map<string, Set<string>>;
  loading: boolean;
  refresh: () => void;
}

const AIEmployeesContext = createContext<AIEmployeesContextType>({
  employees: [],
  employeeMap: new Map(),
  toolNamesMap: new Map(),
  loading: false,
  refresh: () => {},
});

const orchestratorToolNames = new Set([
  'orchestrator_plan_goal',
  'orchestrator_execute_plan',
  'orchestrator_status',
  'orchestrator_cancel',
  'external_rag_search',
  'skill_hub_execute',
]);

function isToolLikeName(name: string) {
  return (
    orchestratorToolNames.has(name) ||
    name.startsWith('delegate_') ||
    name.startsWith('dispatch_subagents_') ||
    name.startsWith('skill_hub_') ||
    name.startsWith('browser_') ||
    name.startsWith('drawio-')
  );
}

function extractToolNames(skillSettings: any) {
  const tools = Array.isArray(skillSettings?.tools)
    ? skillSettings.tools
        .map((tool: any) => (typeof tool === 'string' ? tool : tool?.name))
        .filter((name: any): name is string => typeof name === 'string' && name.length > 0)
    : [];

  const legacyTools = Array.isArray(skillSettings?.skills)
    ? skillSettings.skills
        .map((skill: any) => {
          if (typeof skill === 'string') {
            return isToolLikeName(skill) ? skill : null;
          }
          return skill?.name;
        })
        .filter((name: any): name is string => typeof name === 'string' && name.length > 0)
    : [];

  return Array.from(new Set([...tools, ...legacyTools]));
}

/**
 * Shared context provider that fetches aiEmployees once and shares the data
 * across RulesTab, TracingTab, AgentRunsTab, and AIEmployeeSelect.
 *
 * Also exposes each employee's configured tools so RulesTab can warn when a
 * delegation rule exists but the leader hasn't added the corresponding
 * delegate_<leader>_to_<sub> tool to its skillSettings.tools.
 */
export const AIEmployeesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data, loading, refresh } = useRequest({
    url: 'aiEmployees:list',
    params: { pageSize: 200 },
  });

  const value = React.useMemo(() => {
    const rawEmployees = (data as any)?.data || [];
    const employees: AIEmployeeInfo[] = rawEmployees.map((emp: any) => {
      const tools = extractToolNames(emp.skillSettings);
      return {
        username: emp.username,
        nickname: emp.nickname || emp.username,
        about: emp.about?.substring(0, 80),
        tools,
      };
    });

    const employeeMap = new Map<string, string>();
    const toolNamesMap = new Map<string, Set<string>>();
    for (const emp of employees) {
      employeeMap.set(emp.username, emp.nickname);
      toolNamesMap.set(emp.username, new Set(emp.tools));
    }

    return { employees, employeeMap, toolNamesMap, loading, refresh };
  }, [data, loading, refresh]);

  return <AIEmployeesContext.Provider value={value}>{children}</AIEmployeesContext.Provider>;
};

/**
 * Hook to access shared AI employees data.
 */
export const useAIEmployees = () => useContext(AIEmployeesContext);
