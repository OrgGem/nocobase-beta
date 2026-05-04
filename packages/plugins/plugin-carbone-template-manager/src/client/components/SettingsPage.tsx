import React from 'react';
import { Card, Tabs } from 'antd';
import { useCarboneTranslation } from '../locale';
import { ConnectionSettings } from './ConnectionSettings';
import { TemplatesTab } from './TemplatesTab';

/**
 * Settings page is split into tabs. Connection + Templates implemented;
 * remaining tabs render a placeholder until P3 / P4 / P5 land.
 */
export const SettingsPage: React.FC = () => {
  const { t } = useCarboneTranslation();

  const items = [
    { key: 'templates', label: t('Templates'), children: <TemplatesTab /> },
    { key: 'connection', label: t('Connection'), children: <ConnectionSettings /> },
    { key: 'playground', label: t('Test playground'), children: <Placeholder phase="P4" /> },
    { key: 'monitoring', label: t('Monitoring'), children: <Placeholder phase="P5" /> },
    { key: 'cache', label: t('Cache'), children: <Placeholder phase="P5" /> },
  ];

  return (
    <Card>
      <Tabs items={items} />
    </Card>
  );
};

const Placeholder: React.FC<{ phase: string }> = ({ phase }) => {
  const { t } = useCarboneTranslation();
  return (
    <div style={{ padding: 32, textAlign: 'center', color: 'rgba(0,0,0,0.45)' }}>
      {t('Coming in {{phase}}', { phase })}
    </div>
  );
};

export default SettingsPage;
