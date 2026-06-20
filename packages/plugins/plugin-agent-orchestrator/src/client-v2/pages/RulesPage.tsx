import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { AgentRunsTab } from '../components/AgentRunsTab';

const RulesPage: React.FC = () => (
  <AIEmployeesProvider>
    <div style={{ padding: '0 24px 24px' }}>
      <AgentRunsTab />
    </div>
  </AIEmployeesProvider>
);

export default RulesPage;
