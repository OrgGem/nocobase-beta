import React from 'react';
import { Alert, Card, Space } from 'antd';

import { useT } from '../locale';
import { VersionManagement } from './VersionManagement';

export default function VersionsPage() {
  const t = useT();

  return (
    <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
      <Alert
        type="info"
        showIcon
        message={t(
          'Version audit is an administrative view. Use Manage versions in Catalog for skill-focused install and yank decisions.',
        )}
      />
      <Card title={t('Version audit')}>
        <VersionManagement auditMode />
      </Card>
    </Space>
  );
}
