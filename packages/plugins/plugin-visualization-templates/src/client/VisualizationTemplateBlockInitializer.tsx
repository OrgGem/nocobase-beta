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
  useCollectionManager_deprecated, // TODO: replace with useCollectionManager from data-source (C3)
  useGlobalTheme,
  useSchemaInitializer,
  useSchemaInitializerItem,
} from '@nocobase/client';
import React, { useCallback, useContext } from 'react';

import { namespace } from './locale';
import { getVisualizationTemplateRegistry } from './registry';
import { createVisualizationTemplateSchema, inferFieldMapping } from './schema';

const fieldTitle = (field: any) => field?.uiSchema?.title || field?.title || field?.name;

export const VisualizationTemplateBlockInitializer = () => {
  const itemConfig = useSchemaInitializerItem();
  const { insert } = useSchemaInitializer();
  const { parseAction } = useACLRoleContext();
  const options = useContext(SchemaOptionsContext);
  const { theme } = useGlobalTheme();
  const { getCollectionFields } = useCollectionManager_deprecated();

  const filter = useCallback(
    (item) => {
      return parseAction(`${item.name}:list`);
    },
    [parseAction],
  );

  return (
    <DataBlockInitializer
      {...itemConfig}
      icon={<DashboardOutlined />}
      componentType="Visualization templates"
      title={`{{t("Visualization templates", { ns: "${namespace}" })}}`}
      filter={filter}
      filterDataSource={(ds) => ds.key === DEFAULT_DATA_SOURCE_KEY || ds.getOptions().isDBInstance}
      onCreateBlockSchema={async ({ item }) => {
        const templates = getVisualizationTemplateRegistry().list();
        const fields = getCollectionFields(item.name, item.dataSource) || [];
        const fieldOptions = fields.map((field) => ({
          label: fieldTitle(field),
          value: field.name,
        }));
        const firstTemplate = templates[0];
        const initialMapping = inferFieldMapping(firstTemplate?.roles || [], fields);
        const values = await FormDialog(
          {
            title: `{{t("Create visualization template", { ns: "${namespace}" })}}`,
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
                      record: {
                        title: `{{t("Record field", { ns: "${namespace}" })}}`,
                        required: true,
                        enum: fieldOptions,
                        'x-component': 'Select',
                        'x-decorator': 'FormItem',
                      },
                      status: {
                        title: `{{t("Status field", { ns: "${namespace}" })}}`,
                        enum: fieldOptions,
                        'x-component': 'Select',
                        'x-decorator': 'FormItem',
                        'x-component-props': { allowClear: true },
                      },
                      assignee: {
                        title: `{{t("Assignee field", { ns: "${namespace}" })}}`,
                        enum: fieldOptions,
                        'x-component': 'Select',
                        'x-decorator': 'FormItem',
                        'x-component-props': { allowClear: true },
                      },
                      priority: {
                        title: `{{t("Priority field", { ns: "${namespace}" })}}`,
                        enum: fieldOptions,
                        'x-component': 'Select',
                        'x-decorator': 'FormItem',
                        'x-component-props': { allowClear: true },
                      },
                      createdAt: {
                        title: `{{t("Created at field", { ns: "${namespace}" })}}`,
                        enum: fieldOptions,
                        'x-component': 'Select',
                        'x-decorator': 'FormItem',
                        'x-component-props': { allowClear: true },
                      },
                      updatedAt: {
                        title: `{{t("Updated at field", { ns: "${namespace}" })}}`,
                        enum: fieldOptions,
                        'x-component': 'Select',
                        'x-decorator': 'FormItem',
                        'x-component-props': { allowClear: true },
                      },
                      completedAt: {
                        title: `{{t("Completed at field", { ns: "${namespace}" })}}`,
                        enum: fieldOptions,
                        'x-component': 'Select',
                        'x-decorator': 'FormItem',
                        'x-component-props': { allowClear: true },
                      },
                      dueDate: {
                        title: `{{t("Due date field", { ns: "${namespace}" })}}`,
                        enum: fieldOptions,
                        'x-component': 'Select',
                        'x-decorator': 'FormItem',
                        'x-component-props': { allowClear: true },
                      },
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
            ...initialMapping,
          },
        });

        if (!values?.template) {
          return;
        }

        const template = getVisualizationTemplateRegistry().get(values.template);
        if (!template) {
          return;
        }

        insert(
          createVisualizationTemplateSchema({
            dataSource: item.dataSource,
            collection: item.name,
            template,
            mapping: values,
          }),
        );
      }}
    />
  );
};
