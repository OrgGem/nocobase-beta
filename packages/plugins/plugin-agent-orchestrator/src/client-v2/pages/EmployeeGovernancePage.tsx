// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { EmployeeGovernanceTab } from '../components/EmployeeGovernanceTab';

const EmployeeGovernancePage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <AIEmployeesProvider>
    <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
      <EmployeeGovernanceTab />
    </div>
  </AIEmployeesProvider>
);

export default EmployeeGovernancePage;
