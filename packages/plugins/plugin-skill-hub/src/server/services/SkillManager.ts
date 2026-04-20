import { Database } from '@nocobase/database';

export class SkillManager {
  constructor(private db: Database) {}

  async seedDefaults() {
    const repo = this.db.getRepository('skillDefinitions');
    const count = await repo.count();
    if (count > 0) return;

    const seeds = [
      {
        name: 'generate-word-report',
        title: 'Generate Word Report',
        description: 'Generate a Word document (.docx) with title, content, and optional table data.',
        language: 'python',
        codeTemplate: SEED_WORD_REPORT,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Report title' },
            content: { type: 'string', description: 'Report body text' },
            tableData: {
              type: 'array',
              items: { type: 'object' },
              description: 'Optional array of objects for table rows',
            },
          },
          required: ['title', 'content'],
        },
        packages: ['python-docx'],
        timeoutSeconds: 30,
        enabled: true,
        toolScope: 'CUSTOM',
      },
      {
        name: 'generate-excel',
        title: 'Generate Excel Spreadsheet',
        description: 'Generate an Excel file (.xlsx) with headers and row data.',
        language: 'python',
        codeTemplate: SEED_EXCEL,
        inputSchema: {
          type: 'object',
          properties: {
            sheetName: { type: 'string', description: 'Sheet name', default: 'Sheet1' },
            headers: { type: 'array', items: { type: 'string' }, description: 'Column headers' },
            rows: { type: 'array', items: { type: 'array' }, description: 'Row data (array of arrays)' },
          },
          required: ['headers', 'rows'],
        },
        packages: ['openpyxl'],
        timeoutSeconds: 30,
        enabled: true,
        toolScope: 'CUSTOM',
      },
      {
        name: 'data-transform',
        title: 'Data Transform (CSV/JSON)',
        description: 'Transform data array to CSV or JSON file for download.',
        language: 'node',
        codeTemplate: SEED_DATA_TRANSFORM,
        inputSchema: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object' }, description: 'Array of data objects' },
            format: { type: 'string', enum: ['csv', 'json'], description: 'Output format' },
            filename: { type: 'string', description: 'Output filename (without extension)' },
          },
          required: ['data', 'format'],
        },
        packages: [],
        timeoutSeconds: 30,
        enabled: true,
        toolScope: 'CUSTOM',
      },
    ];

    for (const seed of seeds) {
      try {
        await repo.create({ values: seed });
      } catch (err) {
        // Skip if already exists (unique constraint on name)
      }
    }
  }
}

// ─── Seed Code Templates ───

const SEED_WORD_REPORT = `import os, json
from docx import Document

title = json.loads('''{{title}}''') if '{{title}}'.startswith('"') else '{{title}}'
content = json.loads('''{{content}}''') if '{{content}}'.startswith('"') else '{{content}}'

doc = Document()
doc.add_heading(title, 0)
doc.add_paragraph(content)

table_data_raw = '''{{tableData}}'''
if table_data_raw and table_data_raw != '{{' + 'tableData}}':
    table_data = json.loads(table_data_raw)
    if table_data and len(table_data) > 0:
        headers = list(table_data[0].keys())
        table = doc.add_table(rows=1, cols=len(headers))
        table.style = 'Light Grid Accent 1'
        for i, header in enumerate(headers):
            table.rows[0].cells[i].text = str(header)
        for row_data in table_data:
            row = table.add_row()
            for i, header in enumerate(headers):
                row.cells[i].text = str(row_data.get(header, ''))

output_dir = os.environ.get('OUTPUT_DIR', '/output')
filepath = os.path.join(output_dir, 'report.docx')
doc.save(filepath)
print(f'Generated: report.docx')
`;

const SEED_EXCEL = `import os, json
import openpyxl

sheet_name_raw = '{{sheetName}}'
sheet_name = sheet_name_raw if sheet_name_raw != '{{' + 'sheetName}}' else 'Sheet1'
headers = json.loads('''{{headers}}''')
rows = json.loads('''{{rows}}''')

wb = openpyxl.Workbook()
ws = wb.active
ws.title = sheet_name

for col, header in enumerate(headers, 1):
    ws.cell(row=1, column=col, value=header)

for row_idx, row_data in enumerate(rows, 2):
    for col_idx, value in enumerate(row_data, 1):
        ws.cell(row=row_idx, column=col_idx, value=value)

output_dir = os.environ.get('OUTPUT_DIR', '/output')
filepath = os.path.join(output_dir, 'data.xlsx')
wb.save(filepath)
print(f'Generated: data.xlsx')
`;

const SEED_DATA_TRANSFORM = `const fs = require('fs');
const path = require('path');

const data = {{data}};
const format = '{{format}}';
const filename = '{{filename}}' !== '{{' + 'filename}}' ? '{{filename}}' : 'result';
const outputDir = process.env.OUTPUT_DIR || '/output';

if (format === 'csv') {
  const headers = Object.keys(data[0] || {});
  const csv = [
    headers.join(','),
    ...data.map(row => headers.map(h => JSON.stringify(row[h] ?? '')).join(','))
  ].join('\\n');
  const outPath = path.join(outputDir, filename + '.csv');
  fs.writeFileSync(outPath, csv, 'utf-8');
  console.log('Generated: ' + filename + '.csv');
} else {
  const outPath = path.join(outputDir, filename + '.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log('Generated: ' + filename + '.json');
}
`;
