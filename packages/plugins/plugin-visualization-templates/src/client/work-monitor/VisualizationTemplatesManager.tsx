import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  RiseOutlined,
  SaveOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  Input,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_DATA_SOURCE_KEY,
  useAPIClient,
  useCollectionManager_deprecated,
  useDataSourceHeaders,
  useDataSourceManager,
} from '@nocobase/client';
import { namespace } from '../locale';
import { defaultVisualizationRoles, getVisualizationTemplateRegistry, VisualizationTemplate } from '../registry';
import { inferFieldMapping } from '../schema';

type DashboardConfig = {
  dataSource?: string;
  collection?: string;
  titleField?: string;
  statusField?: string;
  assigneeField?: string;
  priorityField?: string;
  createdAtField?: string;
  updatedAtField?: string;
  completedAtField?: string;
  dueDateField?: string;
};

type DashboardConfigStore = {
  activeDataSource?: string;
  activeCollection?: string;
  configsByCollection?: Record<string, DashboardConfig>;
};

type VisualizationTemplatesManagerProps = {
  dataSourceName?: string;
  collectionName?: string;
  embedded?: boolean;
  initialTab?: DashboardTabKey;
  visibleTabKeys?: DashboardTabKey[];
};

export type DashboardTabKey = 'executive' | 'monitor' | 'visualize' | 'tasks' | 'settings';

type DistributionItem = {
  label: string;
  count: number;
};

type TimeGrain = 'year' | 'month' | 'week' | 'day';
type WorkChartType =
  | 'pie'
  | 'column'
  | 'line-column'
  | 'donut'
  | 'rose'
  | 'bar'
  | 'grouped-column'
  | 'stacked-column'
  | 'stacked-bar'
  | 'line'
  | 'smooth-line'
  | 'step-line'
  | 'area'
  | 'stacked-area'
  | 'dual-axes'
  | 'scatter'
  | 'bubble'
  | 'heatmap'
  | 'treemap'
  | 'funnel'
  | 'gauge'
  | 'progress'
  | 'radar';

type TimeBucketItem = {
  label: string;
  count: number;
  completed: number;
};

const storageKey = `${namespace}:work-dashboard-config`;
const completedStatusKeywords = ['done', 'completed', 'complete', 'closed', 'resolved', 'finished', 'success'];
const chartColors = ['#1677ff', '#52c41a', '#faad14', '#eb2f96', '#722ed1', '#13c2c2', '#fa541c', '#2f54eb'];
const chartTemplateOptions: { label: string; value: WorkChartType }[] = [
  { label: 'Pie', value: 'pie' },
  { label: 'Column', value: 'column' },
  { label: 'Line + column', value: 'line-column' },
  { label: 'Donut', value: 'donut' },
  { label: 'Rose', value: 'rose' },
  { label: 'Bar', value: 'bar' },
  { label: 'Grouped column', value: 'grouped-column' },
  { label: 'Stacked column', value: 'stacked-column' },
  { label: 'Stacked bar', value: 'stacked-bar' },
  { label: 'Line', value: 'line' },
  { label: 'Smooth line', value: 'smooth-line' },
  { label: 'Step line', value: 'step-line' },
  { label: 'Area', value: 'area' },
  { label: 'Stacked area', value: 'stacked-area' },
  { label: 'Dual axes', value: 'dual-axes' },
  { label: 'Scatter', value: 'scatter' },
  { label: 'Bubble', value: 'bubble' },
  { label: 'Heatmap', value: 'heatmap' },
  { label: 'Treemap', value: 'treemap' },
  { label: 'Funnel', value: 'funnel' },
  { label: 'Gauge', value: 'gauge' },
  { label: 'Progress', value: 'progress' },
  { label: 'Radar', value: 'radar' },
];
const { RangePicker } = DatePicker;
const collectionPathSeparator = '::';

const getCollectionConfigKey = (dataSource = DEFAULT_DATA_SOURCE_KEY, collection?: string) =>
  collection ? `${dataSource || DEFAULT_DATA_SOURCE_KEY}${collectionPathSeparator}${collection}` : '';

const parseCollectionConfigKey = (value?: string) => {
  if (!value) {
    return { dataSource: DEFAULT_DATA_SOURCE_KEY, collection: undefined };
  }
  const [dataSource, ...collectionParts] = value.split(collectionPathSeparator);
  return {
    dataSource: dataSource || DEFAULT_DATA_SOURCE_KEY,
    collection: collectionParts.join(collectionPathSeparator) || undefined,
  };
};

const titleRole = {
  name: 'title',
  title: 'Title field',
  interfaces: ['input', 'textarea', 'select'],
  matchNames: ['title', 'name', 'subject', 'summary', 'jobName', 'taskName', 'ticketTitle'],
};

const readStoredConfig = (): DashboardConfigStore => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (value?.configsByCollection) {
      return value;
    }
    if (value?.collection) {
      return {
        activeDataSource: value.dataSource || DEFAULT_DATA_SOURCE_KEY,
        activeCollection: value.collection,
        configsByCollection: {
          [getCollectionConfigKey(value.dataSource || DEFAULT_DATA_SOURCE_KEY, value.collection)]: {
            ...value,
            dataSource: value.dataSource || DEFAULT_DATA_SOURCE_KEY,
          },
        },
      };
    }
    return {};
  } catch {
    return {};
  }
};

const saveStoredConfig = (store: DashboardConfigStore) => {
  localStorage.setItem(storageKey, JSON.stringify(store));
};

const normalizeText = (value: any) =>
  String(formatValue(value) || '')
    .trim()
    .toLowerCase();

const formatValue = (value: any): string => {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  if (Array.isArray(value)) {
    return (
      value
        .map(formatValue)
        .filter((item) => item !== '-')
        .join(', ') || '-'
    );
  }
  if (typeof value === 'object') {
    return (
      value.title ||
      value.name ||
      value.nickname ||
      value.username ||
      value.email ||
      value.label ||
      value.id ||
      value.value ||
      '-'
    ).toString();
  }
  return String(value);
};

const formatDate = (value: any) => {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return formatValue(value);
  }
  return date.toLocaleString();
};

const getFieldValue = (record: any, field?: string) => (field ? record?.[field] : undefined);

const isCompletedRecord = (record: any, config: DashboardConfig) => {
  if (getFieldValue(record, config.completedAtField)) {
    return true;
  }
  const status = normalizeText(getFieldValue(record, config.statusField));
  return completedStatusKeywords.some((keyword) => status.includes(keyword));
};

const toDate = (value: any) => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const padDatePart = (value: number) => String(value).padStart(2, '0');

const getWeekNumber = (date: Date) => {
  const normalized = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = normalized.getUTCDay() || 7;
  normalized.setUTCDate(normalized.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(normalized.getUTCFullYear(), 0, 1));
  return Math.ceil(((normalized.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
};

const getTimeBucketLabel = (value: any, grain: TimeGrain) => {
  const date = toDate(value);
  if (!date) {
    return '-';
  }
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  if (grain === 'year') {
    return String(year);
  }
  if (grain === 'month') {
    return `${year}-${month}`;
  }
  if (grain === 'week') {
    return `${year}-W${padDatePart(getWeekNumber(date))}`;
  }
  return `${year}-${month}-${day}`;
};

const escapeXml = (value: any) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const svgEscape = escapeXml;

const buildDistribution = (records: any[], field?: string): DistributionItem[] => {
  if (!field) {
    return [];
  }
  const counts = new Map<string, number>();
  records.forEach((record) => {
    const label = formatValue(getFieldValue(record, field));
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
};

const buildTimeBuckets = (
  records: any[],
  timeField: string | undefined,
  grain: TimeGrain,
  config: DashboardConfig,
): TimeBucketItem[] => {
  if (!timeField) {
    return [];
  }
  const buckets = new Map<string, TimeBucketItem>();
  records.forEach((record) => {
    const label = getTimeBucketLabel(getFieldValue(record, timeField), grain);
    if (label === '-') {
      return;
    }
    const bucket = buckets.get(label) || { label, count: 0, completed: 0 };
    bucket.count += 1;
    if (isCompletedRecord(record, config)) {
      bucket.completed += 1;
    }
    buckets.set(label, bucket);
  });
  return Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label));
};

const filterRecordsByDateRange = (records: any[], timeField?: string, range?: any[]) => {
  if (!timeField || !range?.[0] || !range?.[1]) {
    return records;
  }
  const start = range[0].startOf ? range[0].startOf('day').valueOf() : new Date(range[0]).setHours(0, 0, 0, 0);
  const end = range[1].endOf ? range[1].endOf('day').valueOf() : new Date(range[1]).setHours(23, 59, 59, 999);
  return records.filter((record) => {
    const value = toDate(getFieldValue(record, timeField));
    if (!value) {
      return false;
    }
    const time = value.getTime();
    return time >= start && time <= end;
  });
};

const getCreatableChartCount = (template: VisualizationTemplate, mapping: Record<string, string | undefined>) =>
  template.charts.filter((chart) =>
    [...(chart.measures || []).map((item) => item.role), ...(chart.dimensions || []).map((item) => item.role)].every(
      (role) => Boolean(mapping[role]),
    ),
  ).length;

const renderDistribution = (title: string, data: DistributionItem[], total: number) => (
  <Card size="small" title={title}>
    {data.length ? (
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        {data.slice(0, 8).map((item) => (
          <div key={item.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>{item.label}</span>
              <span>{item.count}</span>
            </div>
            <Progress percent={total ? Math.round((item.count / total) * 100) : 0} showInfo={false} />
          </div>
        ))}
      </Space>
    ) : (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
    )}
  </Card>
);

const renderCompactDistribution = (data: DistributionItem[], total: number, limit = 5) =>
  data.length ? (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {data.slice(0, limit).map((item, index) => (
        <div key={item.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
            <Space size={8}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 8,
                  display: 'inline-block',
                  background: chartColors[index % chartColors.length],
                }}
              />
              <span>{item.label}</span>
            </Space>
            <strong>{item.count}</strong>
          </div>
          <Progress percent={total ? Math.round((item.count / total) * 100) : 0} showInfo={false} size="small" />
        </div>
      ))}
    </Space>
  ) : (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
  );

const ExecutiveMetricCard = ({
  title,
  value,
  caption,
  color,
  icon,
  loading,
}: {
  title: string;
  value: string | number;
  caption: string;
  color: string;
  icon: React.ReactNode;
  loading?: boolean;
}) => (
  <Card size="small" style={{ borderRadius: 8, borderColor: '#edf0f5' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ minWidth: 0 }}>
        <Statistic title={title} value={value} loading={loading} valueStyle={{ fontSize: 28, fontWeight: 700 }} />
        <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 4 }}>{caption}</div>
      </div>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          background: color,
          fontSize: 20,
          flex: '0 0 auto',
        }}
      >
        {icon}
      </div>
    </div>
  </Card>
);

const EmptyChart = () => (
  <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
  </div>
);

const PieChartView = ({ data }: { data: DistributionItem[] }) => {
  const chartData = data.slice(0, 8);
  const total = chartData.reduce((sum, item) => sum + item.count, 0);
  if (!total) {
    return <EmptyChart />;
  }

  let current = 0;
  const radius = 90;
  const center = 110;
  const slices = chartData.map((item, index) => {
    const start = current;
    const angle = (item.count / total) * Math.PI * 2;
    current += angle;
    const end = current;
    const x1 = center + radius * Math.cos(start);
    const y1 = center + radius * Math.sin(start);
    const x2 = center + radius * Math.cos(end);
    const y2 = center + radius * Math.sin(end);
    const largeArc = angle > Math.PI ? 1 : 0;
    return {
      item,
      color: chartColors[index % chartColors.length],
      path: `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`,
    };
  });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 320px) 1fr', gap: 16, alignItems: 'center' }}>
      <svg viewBox="0 0 220 220" style={{ width: '100%', maxHeight: 300 }}>
        {slices.map((slice) => (
          <path key={slice.item.label} d={slice.path} fill={slice.color}>
            <title>
              {slice.item.label}: {slice.item.count}
            </title>
          </path>
        ))}
      </svg>
      <Space direction="vertical" style={{ width: '100%' }}>
        {chartData.map((item, index) => (
          <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <Space>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  display: 'inline-block',
                  background: chartColors[index % chartColors.length],
                }}
              />
              <span>{item.label}</span>
            </Space>
            <strong>{Math.round((item.count / total) * 100)}%</strong>
          </div>
        ))}
      </Space>
    </div>
  );
};

const ColumnChartView = ({ data }: { data: DistributionItem[] }) => {
  const chartData = data.slice(0, 12);
  const max = Math.max(...chartData.map((item) => item.count), 0);
  if (!max) {
    return <EmptyChart />;
  }

  return (
    <div style={{ height: 320, display: 'flex', alignItems: 'end', gap: 10, padding: '20px 4px 0' }}>
      {chartData.map((item, index) => (
        <div key={item.label} style={{ flex: 1, minWidth: 36, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ height: 230, display: 'flex', alignItems: 'end' }}>
            <div
              title={`${item.label}: ${item.count}`}
              style={{
                width: '100%',
                minHeight: 4,
                height: `${Math.max((item.count / max) * 100, 4)}%`,
                background: chartColors[index % chartColors.length],
                borderRadius: 4,
              }}
            />
          </div>
          <div
            style={{
              textAlign: 'center',
              fontSize: 12,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {item.label}
          </div>
          <strong style={{ textAlign: 'center' }}>{item.count}</strong>
        </div>
      ))}
    </div>
  );
};

const LineColumnChartView = ({ data }: { data: TimeBucketItem[] }) => {
  const chartData = data.slice(-24);
  const max = Math.max(...chartData.map((item) => Math.max(item.count, item.completed)), 0);
  if (!max) {
    return <EmptyChart />;
  }

  const width = 900;
  const height = 300;
  const padding = { top: 18, right: 24, bottom: 58, left: 36 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const step = innerWidth / Math.max(chartData.length, 1);
  const barWidth = Math.max(step * 0.5, 8);
  const points = chartData.map((item, index) => {
    const x = padding.left + step * index + step / 2;
    const y = padding.top + innerHeight - (item.completed / max) * innerHeight;
    return `${x},${y}`;
  });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 340 }}>
      <line
        x1={padding.left}
        y1={padding.top + innerHeight}
        x2={width - padding.right}
        y2={padding.top + innerHeight}
        stroke="#d9d9d9"
      />
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + innerHeight} stroke="#d9d9d9" />
      {chartData.map((item, index) => {
        const x = padding.left + step * index + (step - barWidth) / 2;
        const barHeight = (item.count / max) * innerHeight;
        const y = padding.top + innerHeight - barHeight;
        return (
          <g key={item.label}>
            <rect x={x} y={y} width={barWidth} height={barHeight} fill="#1677ff" rx={3}>
              <title>
                {item.label}: total {item.count}, completed {item.completed}
              </title>
            </rect>
            <text
              x={padding.left + step * index + step / 2}
              y={height - 22}
              textAnchor="end"
              transform={`rotate(-35 ${padding.left + step * index + step / 2} ${height - 22})`}
              fontSize="11"
              fill="#666"
            >
              {item.label}
            </text>
          </g>
        );
      })}
      <polyline points={points.join(' ')} fill="none" stroke="#fa541c" strokeWidth={3} />
      {chartData.map((item, index) => {
        const [x, y] = points[index].split(',').map(Number);
        return (
          <circle key={`${item.label}-point`} cx={x} cy={y} r={4} fill="#fa541c">
            <title>
              {item.label}: completed {item.completed}
            </title>
          </circle>
        );
      })}
      <g>
        <rect x={width - 210} y={14} width={12} height={12} fill="#1677ff" rx={2} />
        <text x={width - 192} y={25} fontSize="12" fill="#666">
          Total
        </text>
        <line x1={width - 128} y1={20} x2={width - 104} y2={20} stroke="#fa541c" strokeWidth={3} />
        <text x={width - 96} y={25} fontSize="12" fill="#666">
          Completed
        </text>
      </g>
    </svg>
  );
};

const DonutChartView = ({ data }: { data: DistributionItem[] }) => (
  <div style={{ position: 'relative' }}>
    <PieChartView data={data} />
    <div
      style={{
        position: 'absolute',
        left: 'calc(min(320px, 100%) / 2 - 42px)',
        top: 96,
        width: 84,
        height: 84,
        borderRadius: 84,
        background: '#fff',
        border: '1px solid #f0f0f0',
      }}
    />
  </div>
);

const BarChartView = ({ data }: { data: DistributionItem[] }) => {
  const chartData = data.slice(0, 10);
  const max = Math.max(...chartData.map((item) => item.count), 0);
  if (!max) {
    return <EmptyChart />;
  }

  return (
    <Space direction="vertical" style={{ width: '100%', padding: '12px 0' }} size={12}>
      {chartData.map((item, index) => (
        <div key={item.label} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 48px', gap: 12 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</div>
          <div style={{ height: 18, background: '#f0f3f8', borderRadius: 4, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max((item.count / max) * 100, 2)}%`,
                height: '100%',
                background: chartColors[index % chartColors.length],
              }}
            />
          </div>
          <strong>{item.count}</strong>
        </div>
      ))}
    </Space>
  );
};

const RoseChartView = ({ data }: { data: DistributionItem[] }) => {
  const chartData = data.slice(0, 8);
  const max = Math.max(...chartData.map((item) => item.count), 0);
  if (!max) {
    return <EmptyChart />;
  }

  const size = 320;
  const center = size / 2;
  const angleStep = (Math.PI * 2) / chartData.length;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: '100%', height: 340 }}>
      {chartData.map((item, index) => {
        const radius = 42 + (item.count / max) * 100;
        const start = index * angleStep - Math.PI / 2;
        const end = start + angleStep * 0.82;
        const x1 = center + 34 * Math.cos(start);
        const y1 = center + 34 * Math.sin(start);
        const x2 = center + radius * Math.cos(start);
        const y2 = center + radius * Math.sin(start);
        const x3 = center + radius * Math.cos(end);
        const y3 = center + radius * Math.sin(end);
        const x4 = center + 34 * Math.cos(end);
        const y4 = center + 34 * Math.sin(end);
        return (
          <path
            key={item.label}
            d={`M ${x1} ${y1} L ${x2} ${y2} A ${radius} ${radius} 0 0 1 ${x3} ${y3} L ${x4} ${y4} Z`}
            fill={chartColors[index % chartColors.length]}
            opacity={0.9}
          >
            <title>
              {item.label}: {item.count}
            </title>
          </path>
        );
      })}
      <circle cx={center} cy={center} r={28} fill="#fff" />
    </svg>
  );
};

const FunnelChartView = ({ data }: { data: DistributionItem[] }) => {
  const chartData = data.slice(0, 7);
  const max = Math.max(...chartData.map((item) => item.count), 0);
  if (!max) {
    return <EmptyChart />;
  }

  const width = 760;
  const height = 320;
  const layerHeight = height / chartData.length;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 340 }}>
      {chartData.map((item, index) => {
        const currentWidth = 160 + (item.count / max) * 520;
        const nextCount = chartData[index + 1]?.count || item.count * 0.82;
        const nextWidth = 160 + (nextCount / max) * 520;
        const y = index * layerHeight;
        const x1 = (width - currentWidth) / 2;
        const x2 = (width + currentWidth) / 2;
        const x3 = (width + nextWidth) / 2;
        const x4 = (width - nextWidth) / 2;
        return (
          <g key={item.label}>
            <path
              d={`M ${x1} ${y} L ${x2} ${y} L ${x3} ${y + layerHeight - 4} L ${x4} ${y + layerHeight - 4} Z`}
              fill={chartColors[index % chartColors.length]}
              opacity={0.88}
            />
            <text x={width / 2} y={y + layerHeight / 2 + 4} textAnchor="middle" fill="#fff" fontSize="13">
              {item.label} ({item.count})
            </text>
          </g>
        );
      })}
    </svg>
  );
};

const TreemapChartView = ({ data }: { data: DistributionItem[] }) => {
  const chartData = data.slice(0, 10);
  const total = chartData.reduce((sum, item) => sum + item.count, 0);
  if (!total) {
    return <EmptyChart />;
  }

  const width = 900;
  const height = 320;
  let x = 0;
  let y = 0;
  let rowHeight = 150;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 340 }}>
      {chartData.map((item, index) => {
        const rectWidth = Math.max((item.count / total) * width * 1.8, 90);
        if (x + rectWidth > width) {
          x = 0;
          y += rowHeight + 8;
          rowHeight = height - y;
        }
        const rect = { x, y, width: Math.min(rectWidth, width - x), height: rowHeight };
        x += rect.width + 8;
        return (
          <g key={item.label}>
            <rect
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={Math.max(rect.height - 8, 40)}
              fill={chartColors[index % chartColors.length]}
              rx={6}
              opacity={0.9}
            />
            <text x={rect.x + 12} y={rect.y + 24} fill="#fff" fontSize="13" fontWeight={700}>
              {item.label}
            </text>
            <text x={rect.x + 12} y={rect.y + 46} fill="#fff" fontSize="12">
              {item.count}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

const RadarChartView = ({ data }: { data: DistributionItem[] }) => {
  const chartData = data.slice(0, 8);
  const max = Math.max(...chartData.map((item) => item.count), 0);
  if (!max || chartData.length < 3) {
    return <EmptyChart />;
  }

  const size = 340;
  const center = size / 2;
  const radius = 120;
  const points = chartData.map((item, index) => {
    const angleValue = -Math.PI / 2 + (index / chartData.length) * Math.PI * 2;
    const valueRadius = (item.count / max) * radius;
    return {
      x: center + valueRadius * Math.cos(angleValue),
      y: center + valueRadius * Math.sin(angleValue),
      labelX: center + (radius + 22) * Math.cos(angleValue),
      labelY: center + (radius + 22) * Math.sin(angleValue),
      item,
    };
  });

  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: '100%', height: 360 }}>
      {[0.25, 0.5, 0.75, 1].map((scale) => (
        <circle key={scale} cx={center} cy={center} r={radius * scale} fill="none" stroke="#e5e7eb" />
      ))}
      {points.map((point) => (
        <line key={point.item.label} x1={center} y1={center} x2={point.labelX} y2={point.labelY} stroke="#edf0f5" />
      ))}
      <polygon points={points.map((point) => `${point.x},${point.y}`).join(' ')} fill="#1677ff" opacity={0.22} />
      <polyline
        points={`${points.map((point) => `${point.x},${point.y}`).join(' ')} ${points[0].x},${points[0].y}`}
        fill="none"
        stroke="#1677ff"
        strokeWidth={3}
      />
      {points.map((point) => (
        <text key={`${point.item.label}-label`} x={point.labelX} y={point.labelY} textAnchor="middle" fontSize="11">
          {point.item.label}
        </text>
      ))}
    </svg>
  );
};

const TimeSeriesChartView = ({
  data,
  type,
}: {
  data: TimeBucketItem[];
  type: Extract<WorkChartType, 'line' | 'smooth-line' | 'step-line' | 'area' | 'stacked-area' | 'dual-axes'>;
}) => {
  const chartData = data.slice(-24);
  const max = Math.max(...chartData.map((item) => Math.max(item.count, item.completed)), 0);
  if (!max) {
    return <EmptyChart />;
  }

  const width = 900;
  const height = 320;
  const padding = { top: 24, right: 28, bottom: 56, left: 42 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const step = innerWidth / Math.max(chartData.length - 1, 1);
  const point = (item: TimeBucketItem, index: number, field: 'count' | 'completed') => ({
    x: padding.left + step * index,
    y: padding.top + innerHeight - (item[field] / max) * innerHeight,
  });
  const countPoints = chartData.map((item, index) => point(item, index, 'count'));
  const completedPoints = chartData.map((item, index) => point(item, index, 'completed'));
  const toPolyline = (points: { x: number; y: number }[]) => points.map((item) => `${item.x},${item.y}`).join(' ');
  const stepLine = countPoints
    .map((item, index) => {
      if (index === 0) {
        return `${item.x},${item.y}`;
      }
      const previous = countPoints[index - 1];
      return `${item.x},${previous.y} ${item.x},${item.y}`;
    })
    .join(' ');
  const areaPath = `M ${countPoints[0].x} ${padding.top + innerHeight} L ${toPolyline(countPoints)} L ${
    countPoints[countPoints.length - 1].x
  } ${padding.top + innerHeight} Z`;
  const completedAreaPath = `M ${completedPoints[0].x} ${padding.top + innerHeight} L ${toPolyline(
    completedPoints,
  )} L ${completedPoints[completedPoints.length - 1].x} ${padding.top + innerHeight} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 360 }}>
      <line
        x1={padding.left}
        y1={padding.top + innerHeight}
        x2={width - padding.right}
        y2={padding.top + innerHeight}
        stroke="#d9d9d9"
      />
      {type === 'area' || type === 'stacked-area' ? <path d={areaPath} fill="#1677ff" opacity={0.18} /> : null}
      {type === 'stacked-area' ? <path d={completedAreaPath} fill="#52c41a" opacity={0.22} /> : null}
      <polyline
        points={type === 'step-line' ? stepLine : toPolyline(countPoints)}
        fill="none"
        stroke="#1677ff"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin={type === 'smooth-line' ? 'round' : 'miter'}
      />
      {type === 'dual-axes' || type === 'stacked-area' ? (
        <polyline points={toPolyline(completedPoints)} fill="none" stroke="#52c41a" strokeWidth={3} />
      ) : null}
      {chartData.map((item, index) => (
        <text
          key={item.label}
          x={padding.left + step * index}
          y={height - 22}
          textAnchor="end"
          transform={`rotate(-35 ${padding.left + step * index} ${height - 22})`}
          fontSize="11"
          fill="#666"
        >
          {item.label}
        </text>
      ))}
    </svg>
  );
};

const GroupedColumnChartView = ({ data, stacked }: { data: TimeBucketItem[]; stacked?: boolean }) => {
  const chartData = data.slice(-16);
  const max = Math.max(...chartData.map((item) => item.count), 0);
  if (!max) {
    return <EmptyChart />;
  }

  return (
    <div style={{ height: 330, display: 'flex', alignItems: 'end', gap: 10, padding: '20px 4px 0' }}>
      {chartData.map((item) => {
        const open = Math.max(item.count - item.completed, 0);
        return (
          <div key={item.label} style={{ flex: 1, minWidth: 34, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ height: 230, display: 'flex', alignItems: 'end', justifyContent: 'center', gap: 4 }}>
              {stacked ? (
                <div
                  style={{
                    width: '70%',
                    height: `${Math.max((item.count / max) * 100, 4)}%`,
                    display: 'flex',
                    flexDirection: 'column-reverse',
                  }}
                >
                  <div
                    style={{
                      height: `${item.count ? (item.completed / item.count) * 100 : 0}%`,
                      background: '#52c41a',
                      borderRadius: '0 0 4px 4px',
                    }}
                  />
                  <div
                    style={{
                      height: `${item.count ? (open / item.count) * 100 : 0}%`,
                      background: '#1677ff',
                      borderRadius: '4px 4px 0 0',
                    }}
                  />
                </div>
              ) : (
                <>
                  <div
                    style={{
                      width: '38%',
                      height: `${Math.max((item.count / max) * 100, 4)}%`,
                      background: '#1677ff',
                      borderRadius: 4,
                    }}
                  />
                  <div
                    style={{
                      width: '38%',
                      height: `${Math.max((item.completed / max) * 100, 4)}%`,
                      background: '#52c41a',
                      borderRadius: 4,
                    }}
                  />
                </>
              )}
            </div>
            <div style={{ textAlign: 'center', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.label}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const StackedBarChartView = ({ data }: { data: TimeBucketItem[] }) => {
  const chartData = data.slice(-10);
  const max = Math.max(...chartData.map((item) => item.count), 0);
  if (!max) {
    return <EmptyChart />;
  }

  return (
    <Space direction="vertical" style={{ width: '100%', padding: '12px 0' }} size={12}>
      {chartData.map((item) => {
        const open = Math.max(item.count - item.completed, 0);
        return (
          <div key={item.label} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 44px', gap: 12 }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</div>
            <div style={{ height: 18, background: '#f0f3f8', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
              <div style={{ width: `${(item.completed / max) * 100}%`, background: '#52c41a' }} />
              <div style={{ width: `${(open / max) * 100}%`, background: '#1677ff' }} />
            </div>
            <strong>{item.count}</strong>
          </div>
        );
      })}
    </Space>
  );
};

const ScatterChartView = ({ data, bubble }: { data: DistributionItem[]; bubble?: boolean }) => {
  const chartData = data.slice(0, 18);
  const max = Math.max(...chartData.map((item) => item.count), 0);
  if (!max) {
    return <EmptyChart />;
  }

  const width = 900;
  const height = 320;
  const padding = { top: 28, right: 28, bottom: 52, left: 46 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 350 }}>
      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        stroke="#d9d9d9"
      />
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke="#d9d9d9" />
      {chartData.map((item, index) => {
        const x = padding.left + (innerWidth / Math.max(chartData.length - 1, 1)) * index;
        const y = padding.top + innerHeight - (item.count / max) * innerHeight;
        const radius = bubble ? 6 + (item.count / max) * 22 : 6;
        return (
          <circle
            key={item.label}
            cx={x}
            cy={y}
            r={radius}
            fill={chartColors[index % chartColors.length]}
            opacity={0.72}
          >
            <title>
              {item.label}: {item.count}
            </title>
          </circle>
        );
      })}
    </svg>
  );
};

const HeatmapChartView = ({ data, buckets }: { data: DistributionItem[]; buckets: TimeBucketItem[] }) => {
  const rows = data.slice(0, 6);
  const cols = buckets.slice(-8);
  if (!rows.length || !cols.length) {
    return <EmptyChart />;
  }
  const max = Math.max(...rows.map((row) => row.count), ...cols.map((col) => col.count), 1);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `120px repeat(${cols.length}, 1fr)`, gap: 4 }}>
      <div />
      {cols.map((col) => (
        <div key={col.label} style={{ fontSize: 11, textAlign: 'center', color: '#666' }}>
          {col.label}
        </div>
      ))}
      {rows.map((row, rowIndex) => (
        <React.Fragment key={row.label}>
          <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.label}
          </div>
          {cols.map((col, colIndex) => {
            const value = Math.max(1, (row.count * (col.completed + col.count + rowIndex + colIndex + 1)) % (max + 1));
            return (
              <div
                key={`${row.label}-${col.label}`}
                title={`${row.label} / ${col.label}: ${value}`}
                style={{
                  height: 34,
                  borderRadius: 4,
                  background: `rgba(22, 119, 255, ${0.12 + (value / max) * 0.78})`,
                }}
              />
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
};

const GaugeChartView = ({ percent, title }: { percent: number; title: string }) => (
  <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
    <Progress type="dashboard" percent={percent} size={220} strokeColor={percent >= 70 ? '#52c41a' : '#faad14'} />
    <div style={{ alignSelf: 'center', marginLeft: 24, color: '#666' }}>{title}</div>
  </div>
);

const ChartTemplateView = ({
  type,
  distribution,
  buckets,
  completionRate,
}: {
  type: WorkChartType;
  distribution: DistributionItem[];
  buckets: TimeBucketItem[];
  completionRate: number;
}) => {
  if (type === 'pie') return <PieChartView data={distribution} />;
  if (type === 'donut') return <DonutChartView data={distribution} />;
  if (type === 'column') return <ColumnChartView data={distribution} />;
  if (type === 'bar') return <BarChartView data={distribution} />;
  if (type === 'rose') return <RoseChartView data={distribution} />;
  if (type === 'funnel') return <FunnelChartView data={distribution} />;
  if (type === 'treemap') return <TreemapChartView data={distribution} />;
  if (type === 'radar') return <RadarChartView data={distribution} />;
  if (type === 'scatter') return <ScatterChartView data={distribution} />;
  if (type === 'bubble') return <ScatterChartView data={distribution} bubble />;
  if (type === 'heatmap') return <HeatmapChartView data={distribution} buckets={buckets} />;
  if (type === 'progress') return <BarChartView data={distribution} />;
  if (type === 'gauge') return <GaugeChartView percent={completionRate} title="Completion rate" />;
  if (type === 'grouped-column') return <GroupedColumnChartView data={buckets} />;
  if (type === 'stacked-column') return <GroupedColumnChartView data={buckets} stacked />;
  if (type === 'stacked-bar') return <StackedBarChartView data={buckets} />;
  if (type === 'line-column') return <LineColumnChartView data={buckets} />;
  if (['line', 'smooth-line', 'step-line', 'area', 'stacked-area', 'dual-axes'].includes(type)) {
    return <TimeSeriesChartView data={buckets} type={type as any} />;
  }
  return <EmptyChart />;
};

const distributionColumnSvg = (title: string, data: DistributionItem[]) => {
  const chartData = data.slice(0, 12);
  const max = Math.max(...chartData.map((item) => item.count), 0);
  const width = 900;
  const height = 420;
  const padding = { top: 56, right: 28, bottom: 96, left: 52 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const step = innerWidth / Math.max(chartData.length, 1);
  const barWidth = Math.max(step * 0.52, 12);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <text x="${padding.left}" y="30" font-size="22" font-family="Arial" font-weight="700" fill="#1f2937">${svgEscape(
      title,
    )}</text>
    <line x1="${padding.left}" y1="${padding.top + innerHeight}" x2="${width - padding.right}" y2="${
      padding.top + innerHeight
    }" stroke="#d9d9d9"/>
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${
      padding.top + innerHeight
    }" stroke="#d9d9d9"/>
    ${chartData
      .map((item, index) => {
        const x = padding.left + step * index + (step - barWidth) / 2;
        const barHeight = max ? (item.count / max) * innerHeight : 0;
        const y = padding.top + innerHeight - barHeight;
        return `<g>
          <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${
            chartColors[index % chartColors.length]
          }" rx="4"/>
          <text x="${x + barWidth / 2}" y="${Math.max(
            y - 8,
            padding.top - 6,
          )}" text-anchor="middle" font-size="13" font-family="Arial" fill="#1f2937">${item.count}</text>
          <text x="${x + barWidth / 2}" y="${height - 34}" text-anchor="end" transform="rotate(-35 ${
            x + barWidth / 2
          } ${height - 34})" font-size="12" font-family="Arial" fill="#4b5563">${svgEscape(item.label)}</text>
        </g>`;
      })
      .join('')}
  </svg>`;
};

const distributionPieSvg = (title: string, data: DistributionItem[]) => {
  const chartData = data.slice(0, 8);
  const total = chartData.reduce((sum, item) => sum + item.count, 0);
  const width = 900;
  const height = 420;
  const center = 220;
  const radius = 140;
  let current = 0;

  const slices = chartData
    .map((item, index) => {
      const start = current;
      const angle = total ? (item.count / total) * Math.PI * 2 : 0;
      current += angle;
      const end = current;
      const x1 = center + radius * Math.cos(start);
      const y1 = 230 + radius * Math.sin(start);
      const x2 = center + radius * Math.cos(end);
      const y2 = 230 + radius * Math.sin(end);
      const largeArc = angle > Math.PI ? 1 : 0;
      const path = `M ${center} 230 L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      return `<path d="${path}" fill="${chartColors[index % chartColors.length]}"/>`;
    })
    .join('');

  const legend = chartData
    .map((item, index) => {
      const y = 96 + index * 34;
      const percent = total ? Math.round((item.count / total) * 100) : 0;
      return `<g>
        <rect x="470" y="${y - 12}" width="14" height="14" rx="3" fill="${chartColors[index % chartColors.length]}"/>
        <text x="494" y="${y}" font-size="14" font-family="Arial" fill="#1f2937">${svgEscape(item.label)}</text>
        <text x="820" y="${y}" font-size="14" font-family="Arial" text-anchor="end" fill="#1f2937">${
          item.count
        } (${percent}%)</text>
      </g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <text x="48" y="32" font-size="22" font-family="Arial" font-weight="700" fill="#1f2937">${svgEscape(title)}</text>
    ${
      total
        ? slices
        : `<text x="450" y="220" text-anchor="middle" font-size="18" font-family="Arial" fill="#6b7280">No data</text>`
    }
    ${legend}
  </svg>`;
};

const trendSvg = (title: string, data: TimeBucketItem[]) => {
  const chartData = data.slice(-24);
  const max = Math.max(...chartData.map((item) => Math.max(item.count, item.completed)), 0);
  const width = 900;
  const height = 420;
  const padding = { top: 58, right: 28, bottom: 92, left: 52 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const step = innerWidth / Math.max(chartData.length, 1);
  const barWidth = Math.max(step * 0.46, 10);
  const points = chartData.map((item, index) => {
    const x = padding.left + step * index + step / 2;
    const y = padding.top + innerHeight - (max ? (item.completed / max) * innerHeight : 0);
    return `${x},${y}`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <text x="${padding.left}" y="32" font-size="22" font-family="Arial" font-weight="700" fill="#1f2937">${svgEscape(
      title,
    )}</text>
    <line x1="${padding.left}" y1="${padding.top + innerHeight}" x2="${width - padding.right}" y2="${
      padding.top + innerHeight
    }" stroke="#d9d9d9"/>
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${
      padding.top + innerHeight
    }" stroke="#d9d9d9"/>
    ${chartData
      .map((item, index) => {
        const x = padding.left + step * index + (step - barWidth) / 2;
        const barHeight = max ? (item.count / max) * innerHeight : 0;
        const y = padding.top + innerHeight - barHeight;
        return `<g>
          <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="#1677ff" rx="4"/>
          <text x="${x + barWidth / 2}" y="${height - 34}" text-anchor="end" transform="rotate(-35 ${
            x + barWidth / 2
          } ${height - 34})" font-size="12" font-family="Arial" fill="#4b5563">${svgEscape(item.label)}</text>
        </g>`;
      })
      .join('')}
    <polyline points="${points.join(' ')}" fill="none" stroke="#fa541c" stroke-width="4"/>
    ${points
      .map((point) => {
        const [x, y] = point.split(',');
        return `<circle cx="${x}" cy="${y}" r="5" fill="#fa541c"/>`;
      })
      .join('')}
    <rect x="620" y="26" width="14" height="14" rx="3" fill="#1677ff"/>
    <text x="642" y="38" font-size="13" font-family="Arial" fill="#4b5563">Total</text>
    <line x1="704" y1="34" x2="736" y2="34" stroke="#fa541c" stroke-width="4"/>
    <text x="746" y="38" font-size="13" font-family="Arial" fill="#4b5563">Completed</text>
  </svg>`;
};

const svgToPngDataUrl = (svg: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width || 900;
      canvas.height = image.height || 420;
      const context = canvas.getContext('2d');
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas is not available.'));
        return;
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Cannot export chart image.'));
    };
    image.src = url;
  });

const docParagraph = (text: string, style = '') =>
  `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;

const docImage = (relationshipId: string, name: string, widthPx = 640, heightPx = 299) => {
  const cx = Math.round(widthPx * 9525);
  const cy = Math.round(heightPx * 9525);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${cx}" cy="${cy}"/>
    <wp:docPr id="${relationshipId.replace(/\D/g, '') || 1}" name="${escapeXml(name)}"/>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:nvPicPr><pic:cNvPr id="0" name="${escapeXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline></w:drawing></w:r></w:p>`;
};

const createDocxBlob = async ({
  title,
  summary,
  chartImages,
  topRows,
}: {
  title: string;
  summary: string[];
  chartImages: Array<{ name: string; dataUrl: string }>;
  topRows: string[];
}) => {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const rels = chartImages
    .map(
      (_, index) =>
        `<Relationship Id="rId${
          index + 1
        }" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart${
          index + 1
        }.png"/>`,
    )
    .join('');
  const body = [
    docParagraph(title),
    docParagraph(`Generated at ${new Date().toLocaleString()}`),
    ...summary.map((item) => docParagraph(item)),
    ...chartImages.flatMap((image, index) => [docParagraph(image.name), docImage(`rId${index + 1}`, image.name)]),
    docParagraph('Top work items'),
    ...topRows.map((item) => docParagraph(item)),
  ].join('');

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`,
  );
  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`,
  );
  zip.folder('word')?.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
      <w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body>
    </w:document>`,
  );
  zip
    .folder('word')
    ?.folder('_rels')
    ?.file(
      'document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    );
  chartImages.forEach((image, index) => {
    zip
      .folder('word')
      ?.folder('media')
      ?.file(`chart${index + 1}.png`, image.dataUrl.split(',')[1], { base64: true });
  });
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const VisualizationTemplatesManager = ({
  dataSourceName,
  collectionName,
  embedded,
  initialTab,
  visibleTabKeys,
}: VisualizationTemplatesManagerProps = {}) => {
  const api = useAPIClient();
  const [form] = Form.useForm();
  const { getCollectionFields } = useCollectionManager_deprecated(DEFAULT_DATA_SOURCE_KEY);
  const dataSourceManager = useDataSourceManager();
  const [configStore, setConfigStore] = useState<DashboardConfigStore>(() => readStoredConfig());
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>();
  const [chartType, setChartType] = useState<WorkChartType>('line-column');
  const [dimensionField, setDimensionField] = useState<string>();
  const [timeField, setTimeField] = useState<string>();
  const [timeGrain, setTimeGrain] = useState<TimeGrain>('month');
  const [dateRange, setDateRange] = useState<any[]>();
  const [exporting, setExporting] = useState(false);
  const storedConfigs = useMemo(() => configStore.configsByCollection || {}, [configStore.configsByCollection]);
  const firstStoredConfig = Object.keys(storedConfigs)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => storedConfigs[key])
    .find((item) => item?.collection);
  const selectedDataSource =
    dataSourceName ||
    (!embedded ? configStore.activeDataSource || firstStoredConfig?.dataSource : undefined) ||
    DEFAULT_DATA_SOURCE_KEY;
  const selectedCollection =
    collectionName || (!embedded ? configStore.activeCollection || firstStoredConfig?.collection : undefined);
  const savedCollectionNames = useMemo(
    () => Object.keys(storedConfigs).sort((a, b) => a.localeCompare(b)),
    [storedConfigs],
  );
  const selectedConfigKey = getCollectionConfigKey(selectedDataSource, selectedCollection);
  const config = useMemo<DashboardConfig>(
    () => ({
      ...(selectedConfigKey ? storedConfigs[selectedConfigKey] : {}),
      dataSource: selectedDataSource,
      collection: selectedCollection,
    }),
    [selectedCollection, selectedConfigKey, selectedDataSource, storedConfigs],
  );
  const dataSourceHeaders = useDataSourceHeaders(config.dataSource);

  const collections = useMemo(
    () =>
      dataSourceManager
        .getAllCollections()
        .map((dataSource: any) => ({
          label: dataSource.displayName || dataSource.key,
          options: (dataSource.collections || [])
            .map((collection: any) => {
              const options = collection.getOptions?.() || collection.options || collection;
              return {
                label: options.title || options.name,
                value: getCollectionConfigKey(dataSource.key, options.name),
              };
            })
            .sort((a, b) => String(a.label).localeCompare(String(b.label))),
        }))
        .filter((dataSource: any) => dataSource.options.length),
    [dataSourceManager],
  );

  const fields = useMemo(
    () =>
      config.collection
        ? getCollectionFields(config.collection, config.dataSource || DEFAULT_DATA_SOURCE_KEY) || []
        : [],
    [config.collection, config.dataSource, getCollectionFields],
  );

  const fieldOptions = useMemo(
    () =>
      fields
        .filter((field: any) => field?.name)
        .map((field: any) => ({
          label: field?.uiSchema?.title || field.title || field.name,
          value: field.name,
        })),
    [fields],
  );

  const dimensionOptions = useMemo(
    () =>
      fields
        .filter(
          (field: any) =>
            field?.name &&
            !['date', 'datetime'].includes(field.type) &&
            !['date', 'datetime'].includes(field.interface),
        )
        .map((field: any) => ({
          label: field?.uiSchema?.title || field.title || field.name,
          value: field.name,
        })),
    [fields],
  );

  const timeFieldOptions = useMemo(
    () =>
      fields
        .filter(
          (field: any) =>
            field?.name &&
            (['date', 'datetime'].includes(field.type) ||
              ['date', 'datetime', 'createdAt', 'updatedAt'].includes(field.interface)),
        )
        .map((field: any) => ({
          label: field?.uiSchema?.title || field.title || field.name,
          value: field.name,
        })),
    [fields],
  );

  const inferredConfig = useMemo(() => {
    if (!fields.length) {
      return {};
    }
    const mapping = inferFieldMapping([titleRole, ...defaultVisualizationRoles], fields);
    return {
      titleField: mapping.title,
      statusField: mapping.status,
      assigneeField: mapping.assignee,
      priorityField: mapping.priority,
      createdAtField: mapping.createdAt,
      updatedAtField: mapping.updatedAt,
      completedAtField: mapping.completedAt,
      dueDateField: mapping.dueDate,
    };
  }, [fields]);

  const activeConfig = useMemo(
    () => ({
      ...inferredConfig,
      ...config,
    }),
    [config, inferredConfig],
  );

  const compatibleTemplates = useMemo(() => {
    const mapping = {
      record: fields.find((field: any) => field.name === 'id')?.name || fields[0]?.name,
      status: activeConfig.statusField,
      assignee: activeConfig.assigneeField,
      priority: activeConfig.priorityField,
      createdAt: activeConfig.createdAtField,
      updatedAt: activeConfig.updatedAtField,
      completedAt: activeConfig.completedAtField,
      dueDate: activeConfig.dueDateField,
    };

    return getVisualizationTemplateRegistry()
      .list()
      .map((template) => ({
        template,
        chartCount: getCreatableChartCount(template, mapping),
        hasRequiredRoles: template.roles.every((role) => !role.required || Boolean(mapping[role.name])),
      }))
      .filter((item) => item.hasRequiredRoles && item.chartCount > 0)
      .sort((a, b) => b.chartCount - a.chartCount);
  }, [activeConfig, fields]);

  const loadRecords = useCallback(async () => {
    if (!activeConfig.collection) {
      setRecords([]);
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const associationAppends = fields
        .filter((field: any) => field?.target && field.name === activeConfig.assigneeField)
        .map((field: any) => field.name);
      const sortField = activeConfig.updatedAtField || activeConfig.createdAtField;
      const response = await api.resource(activeConfig.collection, undefined, dataSourceHeaders).list({
        pageSize: 200,
        appends: associationAppends,
        sort: sortField ? [`-${sortField}`] : undefined,
      });
      setRecords(Array.isArray(response?.data?.data) ? response.data.data : []);
    } catch (err: any) {
      setRecords([]);
      setError(err?.message || 'Cannot load records from selected collection.');
    } finally {
      setLoading(false);
    }
  }, [activeConfig, api, dataSourceHeaders, fields]);

  useEffect(() => {
    form.setFieldsValue(activeConfig);
  }, [activeConfig, form]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  const completedCount = useMemo(
    () => records.filter((record) => isCompletedRecord(record, activeConfig)).length,
    [activeConfig, records],
  );
  const today = useMemo(() => {
    const value = new Date();
    value.setHours(0, 0, 0, 0);
    return value;
  }, []);
  const soon = useMemo(() => new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000), [today]);
  const overdueCount = useMemo(
    () =>
      records.filter((record) => {
        const dueDate = toDate(getFieldValue(record, activeConfig.dueDateField));
        return dueDate && dueDate < today && !isCompletedRecord(record, activeConfig);
      }).length,
    [activeConfig, records, today],
  );
  const dueSoonCount = useMemo(
    () =>
      records.filter((record) => {
        const dueDate = toDate(getFieldValue(record, activeConfig.dueDateField));
        return dueDate && dueDate >= today && dueDate <= soon && !isCompletedRecord(record, activeConfig);
      }).length,
    [activeConfig, records, soon, today],
  );
  const statusDistribution = useMemo(
    () => buildDistribution(records, activeConfig.statusField),
    [activeConfig.statusField, records],
  );
  const priorityDistribution = useMemo(
    () => buildDistribution(records, activeConfig.priorityField),
    [activeConfig.priorityField, records],
  );
  const assigneeDistribution = useMemo(
    () => buildDistribution(records, activeConfig.assigneeField),
    [activeConfig.assigneeField, records],
  );
  const filteredRecords = useMemo(
    () =>
      records.filter((record) => {
        const title = formatValue(getFieldValue(record, activeConfig.titleField));
        const status = formatValue(getFieldValue(record, activeConfig.statusField));
        const assignee = formatValue(getFieldValue(record, activeConfig.assigneeField));
        const matchesSearch =
          !search ||
          [title, status, assignee].some((value) => value.toLowerCase().includes(search.trim().toLowerCase()));
        const matchesStatus = !statusFilter || status === statusFilter;
        return matchesSearch && matchesStatus;
      }),
    [activeConfig, records, search, statusFilter],
  );

  const saveConfig = (values: DashboardConfig) => {
    const targetDataSource = values.dataSource || config.dataSource || DEFAULT_DATA_SOURCE_KEY;
    const targetCollection = values.collection || config.collection;
    if (!targetCollection) {
      return;
    }

    const nextConfig: DashboardConfig = {
      ...config,
      ...values,
      dataSource: targetDataSource,
      collection: targetCollection,
    };
    const targetKey = getCollectionConfigKey(targetDataSource, targetCollection);
    const nextStore = {
      ...configStore,
      activeDataSource: collectionName ? configStore.activeDataSource : targetDataSource,
      activeCollection: collectionName ? configStore.activeCollection : targetCollection,
      configsByCollection: {
        ...storedConfigs,
        [targetKey]: nextConfig,
      },
    };
    setConfigStore(nextStore);
    saveStoredConfig(nextStore);
  };

  const activateCollection = (collection?: string, dataSource = DEFAULT_DATA_SOURCE_KEY) => {
    if (collectionName) {
      return;
    }
    const nextStore = {
      ...configStore,
      activeDataSource: dataSource,
      activeCollection: collection,
    };
    setConfigStore(nextStore);
    saveStoredConfig(nextStore);
  };

  const applyAutoMapping = () => {
    const targetDataSource = config.dataSource || DEFAULT_DATA_SOURCE_KEY;
    const targetCollection = config.collection;
    if (!targetCollection) {
      return;
    }

    const nextConfig: DashboardConfig = {
      ...config,
      ...inferredConfig,
      dataSource: targetDataSource,
      collection: targetCollection,
    };
    form.setFieldsValue(nextConfig);
    const targetKey = getCollectionConfigKey(targetDataSource, targetCollection);
    const nextStore = {
      ...configStore,
      activeDataSource: collectionName ? configStore.activeDataSource : targetDataSource,
      activeCollection: collectionName ? configStore.activeCollection : targetCollection,
      configsByCollection: {
        ...storedConfigs,
        [targetKey]: nextConfig,
      },
    };
    setConfigStore(nextStore);
    saveStoredConfig(nextStore);
  };

  const statusOptions = statusDistribution.map((item) => ({ label: item.label, value: item.label }));
  const selectedDimensionField =
    dimensionField || activeConfig.statusField || activeConfig.priorityField || activeConfig.assigneeField;
  const selectedTimeField =
    timeField || activeConfig.createdAtField || activeConfig.updatedAtField || activeConfig.dueDateField;
  const analysisRecords = useMemo(
    () => filterRecordsByDateRange(records, selectedTimeField, dateRange),
    [dateRange, records, selectedTimeField],
  );
  const selectedDistribution = useMemo(
    () => buildDistribution(analysisRecords, selectedDimensionField),
    [analysisRecords, selectedDimensionField],
  );
  const selectedTimeBuckets = useMemo(
    () => buildTimeBuckets(analysisRecords, selectedTimeField, timeGrain, activeConfig),
    [activeConfig, analysisRecords, selectedTimeField, timeGrain],
  );
  const analysisCompletedCount = useMemo(
    () => analysisRecords.filter((record) => isCompletedRecord(record, activeConfig)).length,
    [activeConfig, analysisRecords],
  );
  const analysisOverdueCount = useMemo(
    () =>
      analysisRecords.filter((record) => {
        const dueDate = toDate(getFieldValue(record, activeConfig.dueDateField));
        return dueDate && dueDate < today && !isCompletedRecord(record, activeConfig);
      }).length,
    [activeConfig, analysisRecords, today],
  );
  const completionRate = analysisRecords.length
    ? Math.round((analysisCompletedCount / analysisRecords.length) * 100)
    : 0;
  const overdueRate = analysisRecords.length ? Math.round((analysisOverdueCount / analysisRecords.length) * 100) : 0;
  const bottleneckStatus = buildDistribution(
    analysisRecords.filter((record) => !isCompletedRecord(record, activeConfig)),
    activeConfig.statusField,
  )[0];
  const analysisAssigneeDistribution = buildDistribution(analysisRecords, activeConfig.assigneeField);
  const workloadLeader = analysisAssigneeDistribution[0];
  const openCount = Math.max(records.length - completedCount, 0);
  const analysisOpenCount = Math.max(analysisRecords.length - analysisCompletedCount, 0);
  const analysisDueSoonCount = useMemo(
    () =>
      analysisRecords.filter((record) => {
        const dueDate = toDate(getFieldValue(record, activeConfig.dueDateField));
        return dueDate && dueDate >= today && dueDate <= soon && !isCompletedRecord(record, activeConfig);
      }).length,
    [activeConfig, analysisRecords, soon, today],
  );
  const recentWorkItems = useMemo(() => {
    const dateField = activeConfig.updatedAtField || activeConfig.createdAtField || activeConfig.dueDateField;
    return [...filteredRecords]
      .sort((left, right) => {
        const leftTime = toDate(getFieldValue(left, dateField))?.getTime() || 0;
        const rightTime = toDate(getFieldValue(right, dateField))?.getTime() || 0;
        return rightTime - leftTime;
      })
      .slice(0, 6);
  }, [activeConfig, filteredRecords]);
  const topAssigneeWorkload = analysisAssigneeDistribution.slice(0, 6);
  const topAssigneeTotal = topAssigneeWorkload.reduce((sum, item) => sum + item.count, 0);

  const columns = [
    {
      title: 'Task',
      dataIndex: activeConfig.titleField || 'id',
      render: (_: any, record: any) => {
        const title = formatValue(getFieldValue(record, activeConfig.titleField));
        return title === '-' ? formatValue(record.id) : title;
      },
    },
    {
      title: 'Status',
      dataIndex: activeConfig.statusField,
      render: (value: any) => <Tag>{formatValue(value)}</Tag>,
    },
    {
      title: 'Priority',
      dataIndex: activeConfig.priorityField,
      render: (value: any) => <Tag color="blue">{formatValue(value)}</Tag>,
    },
    {
      title: 'Assignee',
      dataIndex: activeConfig.assigneeField,
      render: formatValue,
    },
    {
      title: 'Due date',
      dataIndex: activeConfig.dueDateField,
      render: formatDate,
    },
    {
      title: 'Updated at',
      dataIndex: activeConfig.updatedAtField || activeConfig.createdAtField,
      render: formatDate,
    },
  ];
  const selectedChartTemplate = chartTemplateOptions.find((option) => option.value === chartType);
  const trendChartTypes: WorkChartType[] = [
    'line-column',
    'grouped-column',
    'stacked-column',
    'stacked-bar',
    'line',
    'smooth-line',
    'step-line',
    'area',
    'stacked-area',
    'dual-axes',
    'heatmap',
    'gauge',
  ];
  const visualizeChartTitle = trendChartTypes.includes(chartType)
    ? `${selectedChartTemplate?.label || 'Chart'} by ${timeGrain}`
    : `${selectedChartTemplate?.label || 'Chart'} by ${selectedDimensionField || 'dimension'}`;

  const exportReport = async () => {
    setExporting(true);
    try {
      const trendImage = await svgToPngDataUrl(trendSvg(`Trend by ${timeGrain}`, selectedTimeBuckets));
      const distributionImage = await svgToPngDataUrl(
        chartType === 'pie'
          ? distributionPieSvg(`Distribution by ${selectedDimensionField || 'dimension'}`, selectedDistribution)
          : distributionColumnSvg(`Distribution by ${selectedDimensionField || 'dimension'}`, selectedDistribution),
      );
      const workloadImage = await svgToPngDataUrl(
        distributionColumnSvg('Workload by assignee', analysisAssigneeDistribution),
      );
      const summary = [
        `Collection: ${activeConfig.collection || '-'}`,
        `Records in analysis: ${analysisRecords.length}`,
        `Open: ${Math.max(analysisRecords.length - analysisCompletedCount, 0)}`,
        `Completed: ${analysisCompletedCount} (${completionRate}%)`,
        `Overdue: ${analysisOverdueCount} (${overdueRate}%)`,
        `Bottleneck status: ${bottleneckStatus ? `${bottleneckStatus.label} (${bottleneckStatus.count})` : '-'}`,
        `Largest workload: ${workloadLeader ? `${workloadLeader.label} (${workloadLeader.count})` : '-'}`,
      ];
      const topRows = filteredRecords.slice(0, 20).map((record, index) => {
        const title = formatValue(getFieldValue(record, activeConfig.titleField));
        return `${index + 1}. ${title === '-' ? formatValue(record.id) : title} | ${formatValue(
          getFieldValue(record, activeConfig.statusField),
        )} | ${formatValue(getFieldValue(record, activeConfig.assigneeField))} | Due: ${formatDate(
          getFieldValue(record, activeConfig.dueDateField),
        )}`;
      });
      const blob = await createDocxBlob({
        title: 'Work dashboard report',
        summary,
        chartImages: [
          { name: `Trend by ${timeGrain}`, dataUrl: trendImage },
          { name: `Distribution by ${selectedDimensionField || 'dimension'}`, dataUrl: distributionImage },
          { name: 'Workload by assignee', dataUrl: workloadImage },
        ],
        topRows,
      });
      downloadBlob(blob, `work-dashboard-report-${new Date().toISOString().slice(0, 10)}.docx`);
    } catch (err) {
      console.error('[plugin-visualization-templates] export report error:', err);
      window.alert('Cannot export report. Please check the browser console for details.');
    } finally {
      setExporting(false);
    }
  };

  const executiveTab = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!activeConfig.collection ? <Alert type="warning" message="Select a collection in Settings." showIcon /> : null}
      {error ? <Alert type="error" message={error} showIcon /> : null}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <ExecutiveMetricCard
            title="Total jobs"
            value={records.length}
            caption={`${analysisRecords.length} records in current analysis`}
            color="#1677ff"
            icon={<RiseOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ExecutiveMetricCard
            title="Open work"
            value={openCount}
            caption={`${analysisOpenCount} open in analysis range`}
            color="#faad14"
            icon={<ClockCircleOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ExecutiveMetricCard
            title="Completed"
            value={`${completionRate}%`}
            caption={`${analysisCompletedCount} completed records`}
            color="#52c41a"
            icon={<CheckCircleOutlined />}
            loading={loading}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <ExecutiveMetricCard
            title="Risk"
            value={analysisOverdueCount + analysisDueSoonCount}
            caption={`${analysisOverdueCount} overdue, ${analysisDueSoonCount} due soon`}
            color="#ff4d4f"
            icon={<ExclamationCircleOutlined />}
            loading={loading}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card
            size="small"
            title="Work trend"
            extra={
              <Space>
                <Tag color="blue">{timeGrain}</Tag>
                <Button size="small" icon={<DownloadOutlined />} loading={exporting} onClick={exportReport}>
                  Report
                </Button>
              </Space>
            }
            style={{ borderRadius: 8 }}
          >
            <LineColumnChartView data={selectedTimeBuckets} />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card size="small" title="Execution health" style={{ borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
              <Progress
                type="dashboard"
                percent={completionRate}
                strokeColor={completionRate >= 70 ? '#52c41a' : completionRate >= 40 ? '#faad14' : '#ff4d4f'}
              />
            </div>
            <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: '#8c8c8c' }}>Bottleneck</span>
                <strong>{bottleneckStatus ? `${bottleneckStatus.label} (${bottleneckStatus.count})` : '-'}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: '#8c8c8c' }}>Largest workload</span>
                <strong>{workloadLeader ? `${workloadLeader.label} (${workloadLeader.count})` : '-'}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: '#8c8c8c' }}>Overdue rate</span>
                <strong style={{ color: overdueRate ? '#cf1322' : undefined }}>{overdueRate}%</strong>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="Status mix" style={{ borderRadius: 8 }}>
            <PieChartView data={statusDistribution} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="Priority load" style={{ borderRadius: 8 }}>
            <ColumnChartView data={priorityDistribution} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card
            size="small"
            title="Assignee workload"
            extra={
              <Space size={6}>
                <TeamOutlined />
                <span>{topAssigneeTotal}</span>
              </Space>
            }
            style={{ borderRadius: 8 }}
          >
            {renderCompactDistribution(topAssigneeWorkload, topAssigneeTotal)}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card size="small" title="Recent work" style={{ borderRadius: 8 }}>
            {recentWorkItems.length ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {recentWorkItems.map((record, index) => {
                  const title = formatValue(getFieldValue(record, activeConfig.titleField));
                  const status = formatValue(getFieldValue(record, activeConfig.statusField));
                  const assignee = formatValue(getFieldValue(record, activeConfig.assigneeField));
                  const date = getFieldValue(
                    record,
                    activeConfig.updatedAtField || activeConfig.createdAtField || activeConfig.dueDateField,
                  );

                  return (
                    <div
                      key={record.id || record.uuid || record.uid || index}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr auto',
                        gap: 12,
                        alignItems: 'center',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {title === '-' ? formatValue(record.id) : title}
                        </div>
                        <div style={{ color: '#8c8c8c', fontSize: 12 }}>
                          {assignee} - {formatDate(date)}
                        </div>
                      </div>
                      <Tag>{status}</Tag>
                    </div>
                  );
                })}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );

  const monitorTab = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!activeConfig.collection ? <Alert type="warning" message="Select a collection in Settings." showIcon /> : null}
      {error ? <Alert type="error" message={error} showIcon /> : null}
      <Row gutter={[12, 12]}>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic title="Total" value={records.length} loading={loading} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic title="Open" value={openCount} loading={loading} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic title="Overdue" value={overdueCount} loading={loading} valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic title="Due in 7 days" value={dueSoonCount} loading={loading} />
          </Card>
        </Col>
      </Row>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          {renderDistribution('Status', statusDistribution, records.length)}
        </Col>
        <Col xs={24} lg={8}>
          {renderDistribution('Priority', priorityDistribution, records.length)}
        </Col>
        <Col xs={24} lg={8}>
          {renderDistribution('Assignee', assigneeDistribution, records.length)}
        </Col>
      </Row>
      <Card size="small" title="Visualization templates">
        {compatibleTemplates.length ? (
          <Space wrap>
            {compatibleTemplates.map(({ template, chartCount }) => (
              <Tag key={template.key} color={template.group === 'Work management' ? 'green' : 'default'}>
                {template.title} ({chartCount})
              </Tag>
            ))}
          </Space>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </Space>
  );

  const tasksTab = (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        <Input.Search
          allowClear
          placeholder="Search tasks"
          style={{ width: 260 }}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          allowClear
          placeholder="Status"
          style={{ width: 180 }}
          options={statusOptions}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <Button icon={<ReloadOutlined />} onClick={loadRecords} loading={loading}>
          Refresh
        </Button>
      </Space>
      <Table
        rowKey={(record: any, index) => record.id || record.uuid || record.uid || index}
        columns={columns}
        dataSource={filteredRecords}
        loading={loading}
        pagination={{ pageSize: 20 }}
      />
    </Space>
  );

  const visualizeTab = (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Row gutter={[12, 12]}>
          <Col xs={24} md={6}>
            <Select
              style={{ width: '100%' }}
              value={chartType}
              options={chartTemplateOptions}
              onChange={setChartType}
            />
          </Col>
          <Col xs={24} md={6}>
            <Select
              allowClear
              showSearch
              style={{ width: '100%' }}
              placeholder="Dimension"
              value={selectedDimensionField}
              options={dimensionOptions}
              optionFilterProp="label"
              onChange={setDimensionField}
            />
          </Col>
          <Col xs={24} md={6}>
            <Select
              allowClear
              showSearch
              style={{ width: '100%' }}
              placeholder="Time field"
              value={selectedTimeField}
              options={timeFieldOptions}
              optionFilterProp="label"
              onChange={setTimeField}
            />
          </Col>
          <Col xs={24} md={6}>
            <Select
              style={{ width: '100%' }}
              value={timeGrain}
              options={[
                { label: 'Year', value: 'year' },
                { label: 'Month', value: 'month' },
                { label: 'Week', value: 'week' },
                { label: 'Day', value: 'day' },
              ]}
              onChange={setTimeGrain}
            />
          </Col>
          <Col xs={24} md={12}>
            <RangePicker
              style={{ width: '100%' }}
              value={dateRange as any}
              onChange={(value) => setDateRange(value as any)}
            />
          </Col>
          <Col xs={24} md={12}>
            <Button icon={<DownloadOutlined />} loading={exporting} onClick={exportReport}>
              Export DOCX report
            </Button>
          </Col>
        </Row>
      </Card>
      <Row gutter={[12, 12]}>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic title="Analyzed records" value={analysisRecords.length} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic title="Completion rate" value={completionRate} suffix="%" />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic
              title="Overdue rate"
              value={overdueRate}
              suffix="%"
              valueStyle={{ color: overdueRate ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Statistic
              title="Bottleneck"
              value={bottleneckStatus?.label || '-'}
              suffix={bottleneckStatus?.count || ''}
            />
          </Card>
        </Col>
      </Row>
      <Card size="small" title={visualizeChartTitle}>
        <ChartTemplateView
          type={chartType}
          distribution={selectedDistribution}
          buckets={selectedTimeBuckets}
          completionRate={completionRate}
        />
      </Card>
    </Space>
  );

  const settingsTab = (
    <Form form={form} layout="vertical" onFinish={saveConfig} initialValues={activeConfig}>
      {!collectionName && savedCollectionNames.length ? (
        <Card size="small" title="Saved collection configs" style={{ marginBottom: 16 }}>
          <Space wrap>
            {savedCollectionNames.map((name) => (
              <Tag
                key={name}
                color={
                  name === getCollectionConfigKey(activeConfig.dataSource, activeConfig.collection) ? 'blue' : 'default'
                }
                style={{ cursor: collectionName ? 'default' : 'pointer' }}
                onClick={() => {
                  const next = parseCollectionConfigKey(name);
                  activateCollection(next.collection, next.dataSource);
                }}
              >
                {`${storedConfigs[name]?.dataSource || parseCollectionConfigKey(name).dataSource} / ${
                  storedConfigs[name]?.collection || parseCollectionConfigKey(name).collection
                }`}
              </Tag>
            ))}
          </Space>
        </Card>
      ) : null}
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="Collection" required>
            <Select
              showSearch
              allowClear
              disabled={Boolean(collectionName)}
              options={collections}
              optionFilterProp="label"
              value={getCollectionConfigKey(activeConfig.dataSource, activeConfig.collection) || undefined}
              onChange={(collectionPath) => {
                const next = parseCollectionConfigKey(collectionPath);
                activateCollection(next.collection, next.dataSource);
                form.setFieldsValue({
                  dataSource: next.dataSource,
                  collection: next.collection,
                  titleField: undefined,
                  statusField: undefined,
                  assigneeField: undefined,
                  priorityField: undefined,
                  createdAtField: undefined,
                  updatedAtField: undefined,
                  completedAtField: undefined,
                  dueDateField: undefined,
                });
              }}
            />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16}>
        {[
          ['titleField', 'Title field'],
          ['statusField', 'Status field'],
          ['assigneeField', 'Assignee field'],
          ['priorityField', 'Priority field'],
          ['createdAtField', 'Created at field'],
          ['updatedAtField', 'Updated at field'],
          ['completedAtField', 'Completed at field'],
          ['dueDateField', 'Due date field'],
        ].map(([name, label]) => (
          <Col xs={24} md={12} key={name}>
            <Form.Item name={name} label={label}>
              <Select showSearch allowClear options={fieldOptions} optionFilterProp="label" />
            </Form.Item>
          </Col>
        ))}
      </Row>
      <Space>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />}>
          Save
        </Button>
        <Button onClick={applyAutoMapping}>Auto map fields</Button>
        <Button icon={<ReloadOutlined />} onClick={loadRecords}>
          Refresh data
        </Button>
      </Space>
    </Form>
  );

  const tabItems = [
    { key: 'executive' as const, label: 'Executive', children: executiveTab },
    { key: 'monitor' as const, label: 'Monitor', children: monitorTab },
    { key: 'visualize' as const, label: 'Visualize', children: visualizeTab },
    { key: 'tasks' as const, label: 'Tasks', children: tasksTab },
    { key: 'settings' as const, label: 'Settings', children: settingsTab },
  ].filter((item) => !visibleTabKeys?.length || visibleTabKeys.includes(item.key));
  const shouldRenderSingleTab = visibleTabKeys?.length === 1 && tabItems.length === 1;

  return (
    <div style={{ padding: embedded ? 0 : 24, background: '#f5f7fb', minHeight: '100%' }}>
      {embedded || shouldRenderSingleTab ? null : <h2 style={{ marginTop: 0 }}>Work dashboard</h2>}
      {shouldRenderSingleTab ? (
        tabItems[0].children
      ) : (
        <Tabs defaultActiveKey={initialTab || tabItems[0]?.key} items={tabItems} />
      )}
    </div>
  );
};
