// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { SkillManager } from '../skill-hub/components/SkillManager';

const SkillDefinitionsPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
    <SkillManager />
  </div>
);

export default SkillDefinitionsPage;
