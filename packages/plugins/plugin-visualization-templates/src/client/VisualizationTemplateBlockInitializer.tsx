import { DashboardOutlined } from '@ant-design/icons';
import { FormLayout } from '@formily/antd-v5';
import { SchemaOptionsContext } from '@formily/react';
import {
  DataBlockInitializer,
  DEFAULT_DATA_SOURCE_KEY,
  FormDialog,
  SchemaComponent,
  SchemaComponentOptions,
  useACLRoleContext,
  useCollectionManager_deprecated,
  useGlobalTheme,
  useSchemaInitializer,
  useSchemaInitializerItem,
} from '@nocobase/client';
import React, { useCallback, useContext, useMemo } from 'react';

import { namespace } from './locale';
import { getVisualizationTemplateRegistry } from './registry';
import type { VisualizationChartTemplate, VisualizationFieldRole, VisualizationTemplate } from './registry';
import { createVisualizationTemplateSchema, inferFieldMapping } from './schema';
import type { VisualizationTemplateMapping } from './schema';

export type VisualizationTemplateBlockInitializerProps = {
  templateGroup?: string;
  templateKeys?: string[];
  title?: string;
  componentType?: string;
};

const workManagementGroup = 'Work management';

const getChartRoles = (chart: VisualizationChartTemplate) => [
  ...(chart.measures || []).map((item) => item.role),
  ...(chart.dimensions || []).map((item) => item.role),
];

const getCreatableChartCount = (template: VisualizationTemplate, mapping: VisualizationTemplateMapping) =>
  template.charts.filter((chart) => getChartRoles(chart).every((role) => Boolean(mapping[role]))).length;

const hasRequiredRoleMapping = (template: VisualizationTemplate, mapping: VisualizationTemplateMapping) =>
  template.roles.every((role) => !role.required || Boolean(mapping[role.name]));

const sortSuitableTemplates = (
  templates: VisualizationTemplate[],
  mappingByTemplate: Map<string, VisualizationTemplateMapping>,
) =>
  [...templates].sort((a, b) => {
    const aIsWork = a.group === workManagementGroup ? 1 : 0;
    const bIsWork = b.group === workManagementGroup ? 1 : 0;
    if (aIsWork !== bIsWork) {
      return bIsWork - aIsWork;
    }

    const aCharts = getCreatableChartCount(a, mappingByTemplate.get(a.key) || {});
    const bCharts = getCreatableChartCount(b, mappingByTemplate.get(b.key) || {});
    if (aCharts !== bCharts) {
      return bCharts - aCharts;
    }

    return a.title.localeCompare(b.title);
  });

export const VisualizationTemplateBlockInitializer = (props: VisualizationTemplateBlockInitializerProps & any = {}) => {
  const { templateGroup, templateKeys, title } = props;
  const itemConfig = useSchemaInitializerItem();
  const { insert } = useSchemaInitializer();
  const { parseAction } = useACLRoleContext();
  const options = useContext(SchemaOptionsContext);
  const { theme } = useGlobalTheme();
  const { getCollectionFields } = useCollectionManager_deprecated();
  const roleMap = useMemo(() => {
    const roles = new Map<string, VisualizationFieldRole>();
    getVisualizationTemplateRegistry()
      .list()
      .forEach((template) => {
        template.roles.forEach((role) => {
          if (!roles.has(role.name)) {
            roles.set(role.name, role);
          }
        });
      });
    return roles;
  }, []);

  const filter = useCallback(
    (item) => {
      return parseAction(`${item.name}:list`);
    },
    [parseAction],
  );

  const getFields = (collectionName?: string, dataSource?: string) => {
    if (!collectionName) {
      return [];
    }
    return getCollectionFields(collectionName, dataSource) || [];
  };

  const getFieldOptions = (collectionName?: string, dataSource?: string) =>
    getFields(collectionName, dataSource)
      .filter((field: any) => field?.name)
      .map((field: any) => ({
        label: field?.uiSchema?.title || field.title || field.name,
        value: field.name,
      }));

  const getTemplate = (key: string, fallback?: VisualizationTemplate) =>
    getVisualizationTemplateRegistry().get(key) || fallback;

  const getInferredMapping = (template: VisualizationTemplate, collectionName?: string, dataSource?: string) =>
    inferFieldMapping(template.roles, getFields(collectionName, dataSource));

  const pickDefinedMapping = (values: Record<string, any>, template: VisualizationTemplate) =>
    template.roles.reduce<VisualizationTemplateMapping>((mapping, role) => {
      if (values?.[role.name]) {
        mapping[role.name] = values[role.name];
      }
      return mapping;
    }, {});

  const getSuitableTemplates = (collectionName: string, dataSource?: string) => {
    const mappingByTemplate = new Map<string, VisualizationTemplateMapping>();
    const templates = getVisualizationTemplateRegistry()
      .list()
      .filter((template) => {
        if (templateGroup && template.group !== templateGroup) {
          return false;
        }
        if (templateKeys?.length && !templateKeys.includes(template.key)) {
          return false;
        }

        const mapping = getInferredMapping(template, collectionName, dataSource);
        mappingByTemplate.set(template.key, mapping);
        return hasRequiredRoleMapping(template, mapping) && getCreatableChartCount(template, mapping) > 0;
      });

    return {
      templates: sortSuitableTemplates(templates, mappingByTemplate),
      mappingByTemplate,
    };
  };

  return (
    <DataBlockInitializer
      {...itemConfig}
      icon={<DashboardOutlined />}
      componentType={props.componentType || 'Visualization templates'}
      filter={filter}
      filterDataSource={(ds) => ds.key === DEFAULT_DATA_SOURCE_KEY || ds.getOptions().isDBInstance}
      title={title || `{{t("Visualization templates", { ns: "${namespace}" })}}`}
      onCreateBlockSchema={async ({ item }) => {
        try {
          const { templates, mappingByTemplate } = getSuitableTemplates(item.name, item.dataSource);

          if (!templates.length) {
            console.warn(
              `[plugin-visualization-templates] No suitable visualization templates found for collection "${item.name}"`,
            );
            return;
          }

          const firstTemplate = templates[0];
          const roleProperties = Array.from(roleMap.values()).reduce<Record<string, any>>((properties, role) => {
            properties[role.name] = {
              title: role.title,
              'x-component': 'Select',
              'x-decorator': 'FormItem',
              'x-component-props': { allowClear: true, showSearch: true },
              'x-reactions': (field: any) => {
                const selectedTemplate = getTemplate(field.form.values.template, firstTemplate);
                const selectedRole = selectedTemplate?.roles.find((item) => item.name === role.name);
                field.hidden = !selectedRole;
                field.required = Boolean(selectedRole?.required);
                if (!selectedRole) {
                  return;
                }

                const fieldOptions = getFieldOptions(item.name, item.dataSource);
                field.dataSource = fieldOptions;
                const valueExists = fieldOptions.some((option) => option.value === field.value);
                if (!field.value || !valueExists) {
                  const inferred =
                    mappingByTemplate.get(selectedTemplate.key)?.[role.name] ||
                    getInferredMapping(selectedTemplate, item.name, item.dataSource)[role.name];
                  field.setValue(inferred || undefined);
                }
              },
            };
            return properties;
          }, {});

          const values = await FormDialog(
            {
              title: `{{t("Create visualization block", { ns: "${namespace}" })}}`,
            },
            () => (
              <SchemaComponentOptions scope={options.scope} components={{ ...options.components }}>
                <FormLayout layout="vertical">
                  <SchemaComponent
                    schema={{
                      type: 'object',
                      properties: {
                        template: {
                          title: `{{t("Template", { ns: "${namespace}" })}}`,
                          required: true,
                          enum: templates.map((template) => ({
                            label: template.title,
                            value: template.key,
                          })),
                          'x-component': 'Select',
                          'x-decorator': 'FormItem',
                        },
                        ...roleProperties,
                      },
                    }}
                  />
                </FormLayout>
              </SchemaComponentOptions>
            ),
            theme,
          ).open({
            initialValues: {
              template: firstTemplate?.key,
            },
          });

          if (!values?.template) {
            return;
          }

          const template = getVisualizationTemplateRegistry().get(values.template);
          if (!template) {
            return;
          }

          const mapping = {
            ...getInferredMapping(template, item.name, item.dataSource),
            ...pickDefinedMapping(values, template),
          };

          insert(
            createVisualizationTemplateSchema({
              dataSource: item.dataSource || DEFAULT_DATA_SOURCE_KEY,
              collection: item.name,
              template,
              mapping,
            }),
          );
        } catch (e) {
          console.error('VisualizationTemplateBlockInitializer onClick error:', e);
        }
      }}
    />
  );
};
