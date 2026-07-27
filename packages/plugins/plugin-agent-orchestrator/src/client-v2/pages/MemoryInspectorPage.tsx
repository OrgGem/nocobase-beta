import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { MemoryInspectorTab } from '../components/MemoryInspectorTab';

const MemoryInspectorPage: React.FC = () => (
  <AIEmployeesProvider>
    <div style={{ padding: '0 24px 24px' }}>
      <MemoryInspectorTab />
    </div>
  </AIEmployeesProvider>
);

export default MemoryInspectorPage;
