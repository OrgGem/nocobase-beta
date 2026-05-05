import React from 'react';
import { Card, Tabs } from 'antd';
import { useCarboneTranslation } from '../locale';
import { ConnectionSettings } from './ConnectionSettings';
import { TemplatesTab } from './TemplatesTab';
import { TestPlaygroundTab } from './TestPlaygroundTab';
import { CacheTab } from './CacheTab';
import { MonitoringTab } from './MonitoringTab';

/**
 * Settings page is split into tabs. Templates / Connection / Playground /
 * Cache / Monitoring are implemented through P5.
 */
export const SettingsPage: React.FC = () => {
  const { t } = useCarboneTranslation();

  const items = [
    { key: 'templates', label: t('Templates'), children: <TemplatesTab /> },
    { key: 'connection', label: t('Connection'), children: <ConnectionSettings /> },
    { key: 'playground', label: t('Test playground'), children: <TestPlaygroundTab /> },
    { key: 'cache', label: t('Cache'), children: <CacheTab /> },
    { key: 'monitoring', label: t('Monitoring'), children: <MonitoringTab /> },
  ];

  return (
    <Card>
      <Tabs items={items} />
    </Card>
  );
};

export default SettingsPage;
