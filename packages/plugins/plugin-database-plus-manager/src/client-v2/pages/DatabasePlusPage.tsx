import { Tabs } from 'antd';
import React from 'react';
import { useT } from '../locale';
import AggregatePane from './AggregatePane';
import IndexesPane from './IndexesPane';
import PaginationSettingsPage from './PaginationSettingsPage';
import SqlConsolePane from './SqlConsolePane';
import StatisticsPane from './StatisticsPane';

export default function DatabasePlusPage() {
  const t = useT();

  return (
    <Tabs
      items={[
        { key: 'pagination', label: t('Pagination'), children: <PaginationSettingsPage /> },
        { key: 'statistics', label: t('Statistics'), children: <StatisticsPane /> },
        { key: 'indexes', label: t('Indexes'), children: <IndexesPane /> },
        { key: 'sql', label: t('SQL Console'), children: <SqlConsolePane /> },
        { key: 'aggregate', label: t('Aggregate'), children: <AggregatePane /> },
      ]}
    />
  );
}
