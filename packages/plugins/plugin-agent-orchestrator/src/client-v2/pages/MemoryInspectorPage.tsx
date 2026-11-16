// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { AIEmployeesProvider } from '../components/AIEmployeesContext';
import { MemoryInspectorTab } from '../components/MemoryInspectorTab';

const MemoryInspectorPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <AIEmployeesProvider>
    <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
      <MemoryInspectorTab />
    </div>
  </AIEmployeesProvider>
);

export default MemoryInspectorPage;
