// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { SkillMetrics } from '../skill-hub/components/SkillMetrics';

const SkillMetricsPage: React.FC<{ embedded?: boolean }> = ({ embedded }) => (
  <div style={embedded ? undefined : { padding: '0 24px 24px' }}>
    <SkillMetrics />
  </div>
);

export default SkillMetricsPage;
