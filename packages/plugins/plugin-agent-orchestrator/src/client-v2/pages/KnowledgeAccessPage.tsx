// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { KnowledgeAccessTab } from '../components/KnowledgeAccessTab';

const KnowledgeAccessPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
    <KnowledgeAccessTab />
  </div>
);

export default KnowledgeAccessPage;
