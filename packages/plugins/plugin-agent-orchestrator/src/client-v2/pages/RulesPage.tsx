import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { RulesTab } from '../components/RulesTab';

const RulesPage: React.FC = () => (
  <AIEmployeesProvider>
    <div style={{ padding: '0 24px 24px' }}>
      <RulesTab />
    </div>
  </AIEmployeesProvider>
);

export default RulesPage;
