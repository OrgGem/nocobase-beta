import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { AgentBindingsTab } from '../components/AgentBindingsTab';

const AgentBindingsPage: React.FC = () => (
  <AIEmployeesProvider>
    <div style={{ padding: '0 24px 24px' }}>
      <AgentBindingsTab />
    </div>
  </AIEmployeesProvider>
);

export default AgentBindingsPage;
