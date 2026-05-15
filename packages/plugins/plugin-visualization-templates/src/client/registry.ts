export type VisualizationRoleName =
  | 'record'
  | 'status'
  | 'assignee'
  | 'priority'
  | 'createdAt'
  | 'updatedAt'
  | 'completedAt'
  | 'dueDate';

export type VisualizationFieldRole = {
  name: VisualizationRoleName | string;
  title: string;
  required?: boolean;
  fieldTypes?: string[];
  interfaces?: string[];
  matchNames?: string[];
};

export type VisualizationMeasure = {
  role: string;
  aggregation?: 'count' | 'sum' | 'avg' | 'max' | 'min';
  alias: string;
  distinct?: boolean;
};

export type VisualizationDimension = {
  role: string;
  alias?: string;
  format?: string;
};

export type VisualizationChartTemplate = {
  key: string;
  title: string;
  chartType: string;
  measures: VisualizationMeasure[];
  dimensions?: VisualizationDimension[];
  config?: Record<string, any>;
  advanced?: Record<string, any>;
  transform?: Record<string, any>;
};

export type VisualizationTemplate = {
  key: string;
  title: string;
  description?: string;
  group?: string;
  roles: VisualizationFieldRole[];
  charts: VisualizationChartTemplate[];
};

/** Central registry for visualization templates. Extensions register here at plugin load time. */
class VisualizationTemplateRegistry {
  private templates = new Map<string, VisualizationTemplate>();

  /** Register a single template. Overwrites any existing template with the same key. */
  register(template: VisualizationTemplate) {
    this.templates.set(template.key, template);
  }

  /** Register multiple templates at once. */
  registerMany(templates: VisualizationTemplate[]) {
    templates.forEach((template) => this.register(template));
  }

  /** Remove a template by key. Returns true if the template was found and removed. */
  remove(key: string): boolean {
    return this.templates.delete(key);
  }

  /** Get a template by key. */
  get(key: string) {
    return this.templates.get(key);
  }

  /** List all registered templates. */
  list() {
    return Array.from(this.templates.values());
  }
}

const registry = new VisualizationTemplateRegistry();

export const getVisualizationTemplateRegistry = () => registry;

export const defaultVisualizationRoles: VisualizationFieldRole[] = [
  {
    name: 'record',
    title: 'Record field',
    required: true,
    matchNames: ['id', 'uid', 'uuid', 'key'],
  },
  {
    name: 'status',
    title: 'Status field',
    fieldTypes: ['string'],
    interfaces: ['select', 'radioGroup', 'input'],
    matchNames: ['status', 'state', 'stage', 'workflowStatus'],
  },
  {
    name: 'assignee',
    title: 'Assignee field',
    interfaces: ['m2o', 'o2o', 'obo', 'user', 'users'],
    matchNames: ['assignee', 'owner', 'handler', 'assignedTo', 'userId'],
  },
  {
    name: 'priority',
    title: 'Priority field',
    fieldTypes: ['string'],
    interfaces: ['select', 'radioGroup', 'input'],
    matchNames: ['priority', 'severity', 'level', 'importance'],
  },
  {
    name: 'createdAt',
    title: 'Created at field',
    fieldTypes: ['date'],
    interfaces: ['createdAt', 'datetime', 'date'],
    matchNames: ['createdAt', 'created_at', 'createAt', 'creationDate'],
  },
  {
    name: 'updatedAt',
    title: 'Updated at field',
    fieldTypes: ['date'],
    interfaces: ['updatedAt', 'datetime', 'date'],
    matchNames: ['updatedAt', 'updated_at', 'modifiedAt'],
  },
  {
    name: 'completedAt',
    title: 'Completed at field',
    fieldTypes: ['date'],
    interfaces: ['datetime', 'date'],
    matchNames: ['completedAt', 'completed_at', 'finishedAt', 'doneAt', 'closedAt'],
  },
  {
    name: 'dueDate',
    title: 'Due date field',
    fieldTypes: ['date'],
    interfaces: ['datetime', 'date'],
    matchNames: ['dueDate', 'due_date', 'deadline', 'endDate', 'endAt'],
  },
];

export const genericCollectionOverviewTemplate: VisualizationTemplate = {
  key: 'generic.collection-overview',
  title: 'Collection overview',
  description: 'A compact overview that works with most collections.',
  group: 'Generic',
  roles: defaultVisualizationRoles,
  charts: [
    {
      key: 'total-records',
      title: 'Total records',
      chartType: 'antd.statistic',
      measures: [{ role: 'record', aggregation: 'count', alias: 'value' }],
      config: { field: 'value', title: 'Total records' },
    },
    {
      key: 'records-by-status',
      title: 'Records by status',
      chartType: 'ant-design-charts.pie',
      measures: [{ role: 'record', aggregation: 'count', alias: 'value' }],
      dimensions: [{ role: 'status' }],
      config: { angleField: 'value', colorField: 'status' },
    },
    {
      key: 'created-trend',
      title: 'Created trend',
      chartType: 'ant-design-charts.line',
      measures: [{ role: 'record', aggregation: 'count', alias: 'value' }],
      dimensions: [{ role: 'createdAt', format: 'YYYY-MM-DD', alias: 'createdAt' }],
      config: { xField: 'createdAt', yField: 'value', smooth: true },
    },
  ],
};

registry.register(genericCollectionOverviewTemplate);
