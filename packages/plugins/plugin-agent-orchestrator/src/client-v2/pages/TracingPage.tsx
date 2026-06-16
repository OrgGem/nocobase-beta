import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { TracingTab } from '../components/TracingTab';

const TracingPage: React.FC = () => (
  <AIEmployeesProvider>
    <div style={{ padding: '0 24px 24px' }}>
      <TracingTab />
    </div>
  </AIEmployeesProvider>
);

export default TracingPage;
