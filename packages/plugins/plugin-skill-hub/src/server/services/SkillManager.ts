import { Database } from '@nocobase/database';
import { stringifyJsonText } from '../utils/json-fields';

export class SkillManager {
  constructor(private db: Database) {}

  async seedDefaults() {
    const repo = this.db.getRepository('skillDefinitions');

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
        name: 'generate-pdf-report',
        title: 'Generate PDF Report',
        description:
          'Generate a professional PDF report with title, sections, and optional table. Suitable for CRM reports, customer summaries, and sales reports.',
        language: 'python',
        codeTemplate: SEED_PDF_REPORT,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Report title' },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  heading: { type: 'string' },
                  body: { type: 'string' },
                },
              },
              description: 'Array of {heading, body} sections',
            },
            tableData: {
              type: 'array',
              items: { type: 'object' },
              description: 'Optional array of objects for a summary table',
            },
          },
          required: ['title', 'sections'],
        },
        packages: ['reportlab'],
        timeoutSeconds: 30,
        enabled: true,
        toolScope: 'CUSTOM',
      },
      {
        name: 'generate-chart-image',
        title: 'Generate Chart Image',
        description:
          'Generate a chart image (PNG) from data. Supports bar, line, pie charts. Useful for visualizing CRM metrics like sales, leads, revenue.',
        language: 'python',
        codeTemplate: SEED_CHART,
        inputSchema: {
          type: 'object',
          properties: {
            chartType: {
              type: 'string',
              enum: ['bar', 'line', 'pie'],
              description: 'Chart type',
            },
            title: { type: 'string', description: 'Chart title' },
            labels: { type: 'array', items: { type: 'string' }, description: 'X-axis labels or pie labels' },
            values: { type: 'array', items: { type: 'number' }, description: 'Data values' },
            xlabel: { type: 'string', description: 'X-axis label (bar/line only)' },
            ylabel: { type: 'string', description: 'Y-axis label (bar/line only)' },
          },
          required: ['chartType', 'title', 'labels', 'values'],
        },
        packages: ['matplotlib'],
        timeoutSeconds: 30,
        enabled: true,
        toolScope: 'CUSTOM',
      },
      {
        name: 'generate-invoice-pdf',
        title: 'Generate Invoice PDF',
        description:
          'Generate a professional invoice PDF with company info, line items, and totals. For CRM billing and quotation workflows.',
        language: 'python',
        codeTemplate: SEED_INVOICE,
        inputSchema: {
          type: 'object',
          properties: {
            invoiceNumber: { type: 'string', description: 'Invoice number' },
            date: { type: 'string', description: 'Invoice date (YYYY-MM-DD)' },
            companyName: { type: 'string', description: 'Your company name' },
            customerName: { type: 'string', description: 'Customer name' },
            customerAddress: { type: 'string', description: 'Customer address' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  quantity: { type: 'number' },
                  unitPrice: { type: 'number' },
                },
              },
              description: 'Line items with description, quantity, unitPrice',
            },
            currency: { type: 'string', description: 'Currency symbol', default: '$' },
            notes: { type: 'string', description: 'Optional notes or payment terms' },
          },
          required: ['invoiceNumber', 'date', 'companyName', 'customerName', 'items'],
        },
        packages: ['reportlab'],
        timeoutSeconds: 30,
        enabled: true,
        toolScope: 'CUSTOM',
      },
      {
        name: 'data-summary-report',
        title: 'Data Summary & Analysis Report',
        description:
          'Analyze tabular data and generate a Word report with summary statistics, top records, and insights. Ideal for CRM data analysis — leads, deals, customers.',
        language: 'python',
        codeTemplate: SEED_DATA_SUMMARY,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Report title' },
            data: {
              type: 'array',
              items: { type: 'object' },
              description: 'Array of data objects (e.g. deals, leads, customers)',
            },
            groupByField: { type: 'string', description: 'Optional field to group and summarize by' },
            sortByField: { type: 'string', description: 'Optional field to sort by (descending)' },
            topN: { type: 'number', description: 'Number of top records to include', default: 10 },
          },
          required: ['title', 'data'],
        },
        packages: ['pandas', 'python-docx'],
        timeoutSeconds: 60,
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
        const count = await repo.count({ filter: { name: seed.name } });
        if (count === 0) {
          await repo.create({
            values: {
              ...seed,
              inputSchema: stringifyJsonText(seed.inputSchema),
              packages: stringifyJsonText(seed.packages, []),
            },
          });
        }
      } catch (err) {
        console.error(`[import-skill] Failed to insert ${seed.name}:`, err);
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

const SEED_PDF_REPORT = `import os, json
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors
from reportlab.lib.units import cm

title = json.loads('''{{title}}''') if '{{title}}'.startswith('"') else '{{title}}'
sections = json.loads('''{{sections}}''')

output_dir = os.environ.get('OUTPUT_DIR', '/output')
filepath = os.path.join(output_dir, 'report.pdf')

doc = SimpleDocTemplate(filepath, pagesize=A4,
    topMargin=2*cm, bottomMargin=2*cm, leftMargin=2*cm, rightMargin=2*cm)
styles = getSampleStyleSheet()
title_style = ParagraphStyle('CustomTitle', parent=styles['Title'], fontSize=22, spaceAfter=20)
heading_style = ParagraphStyle('CustomHeading', parent=styles['Heading2'], fontSize=14, spaceBefore=16, spaceAfter=8)
body_style = styles['BodyText']

story = [Paragraph(title, title_style), Spacer(1, 12)]

for section in sections:
    if section.get('heading'):
        story.append(Paragraph(section['heading'], heading_style))
    if section.get('body'):
        for line in section['body'].split('\\n'):
            story.append(Paragraph(line, body_style))
    story.append(Spacer(1, 8))

table_data_raw = '''{{tableData}}'''
if table_data_raw and table_data_raw != '{{' + 'tableData}}':
    td = json.loads(table_data_raw)
    if td and len(td) > 0:
        headers = list(td[0].keys())
        data = [headers] + [[str(r.get(h, '')) for h in headers] for r in td]
        t = Table(data, repeatRows=1)
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#4472C4')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTSIZE', (0, 0), (-1, 0), 10),
            ('FONTSIZE', (0, 1), (-1, -1), 9),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#D9E2F3')]),
        ]))
        story.append(Spacer(1, 12))
        story.append(t)

doc.build(story)
print('Generated: report.pdf')
`;

const SEED_PPTX = `import os, json
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN

title = json.loads('''{{title}}''') if '{{title}}'.startswith('"') else '{{title}}'
subtitle_raw = '''{{subtitle}}'''
subtitle = json.loads(subtitle_raw) if subtitle_raw.startswith('"') else subtitle_raw if subtitle_raw != '{{' + 'subtitle}}' else ''
slides_data = json.loads('''{{slides}}''')

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

# Title slide
slide = prs.slides.add_slide(prs.slide_layouts[0])
slide.shapes.title.text = title
if subtitle and slide.placeholders[1]:
    slide.placeholders[1].text = subtitle

# Content slides
for s in slides_data:
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = s.get('title', '')
    body = slide.placeholders[1].text_frame
    body.clear()
    for i, bullet in enumerate(s.get('bullets', [])):
        if i == 0:
            body.paragraphs[0].text = bullet
        else:
            p = body.add_paragraph()
            p.text = bullet
        body.paragraphs[-1].font.size = Pt(18)

output_dir = os.environ.get('OUTPUT_DIR', '/output')
filepath = os.path.join(output_dir, 'presentation.pptx')
prs.save(filepath)
print('Generated: presentation.pptx')
`;

const SEED_CHART = `import os, json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

chart_type = '{{chartType}}'
title = json.loads('''{{title}}''') if '{{title}}'.startswith('"') else '{{title}}'
labels = json.loads('''{{labels}}''')
values = json.loads('''{{values}}''')
xlabel_raw = '''{{xlabel}}'''
ylabel_raw = '''{{ylabel}}'''
xlabel = xlabel_raw if xlabel_raw != '{{' + 'xlabel}}' else ''
ylabel = ylabel_raw if ylabel_raw != '{{' + 'ylabel}}' else ''

fig, ax = plt.subplots(figsize=(10, 6))
colors = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#264478', '#9B59B6']

if chart_type == 'bar':
    bars = ax.bar(labels, values, color=colors[:len(labels)])
    for bar, val in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + max(values)*0.01,
                f'{val:,.0f}' if isinstance(val, (int, float)) else str(val),
                ha='center', va='bottom', fontsize=9)
    if xlabel: ax.set_xlabel(xlabel)
    if ylabel: ax.set_ylabel(ylabel)
elif chart_type == 'line':
    ax.plot(labels, values, marker='o', linewidth=2, color='#4472C4', markersize=6)
    for i, val in enumerate(values):
        ax.annotate(f'{val:,.0f}', (labels[i], val), textcoords="offset points",
                    xytext=(0, 10), ha='center', fontsize=9)
    if xlabel: ax.set_xlabel(xlabel)
    if ylabel: ax.set_ylabel(ylabel)
elif chart_type == 'pie':
    ax.pie(values, labels=labels, colors=colors[:len(labels)], autopct='%1.1f%%', startangle=90)

ax.set_title(title, fontsize=14, fontweight='bold', pad=15)
plt.tight_layout()

output_dir = os.environ.get('OUTPUT_DIR', '/output')
filepath = os.path.join(output_dir, 'chart.png')
fig.savefig(filepath, dpi=150, bbox_inches='tight')
plt.close()
print('Generated: chart.png')
`;

const SEED_INVOICE = `import os, json
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import cm, mm
from reportlab.lib import colors

inv_number = json.loads('''{{invoiceNumber}}''') if '{{invoiceNumber}}'.startswith('"') else '{{invoiceNumber}}'
date = json.loads('''{{date}}''') if '{{date}}'.startswith('"') else '{{date}}'
company = json.loads('''{{companyName}}''') if '{{companyName}}'.startswith('"') else '{{companyName}}'
customer = json.loads('''{{customerName}}''') if '{{customerName}}'.startswith('"') else '{{customerName}}'
address_raw = '''{{customerAddress}}'''
address = json.loads(address_raw) if address_raw.startswith('"') else address_raw if address_raw != '{{' + 'customerAddress}}' else ''
items = json.loads('''{{items}}''')
currency_raw = '''{{currency}}'''
currency = currency_raw if currency_raw != '{{' + 'currency}}' else '$'
notes_raw = '''{{notes}}'''
notes = json.loads(notes_raw) if notes_raw.startswith('"') else notes_raw if notes_raw != '{{' + 'notes}}' else ''

output_dir = os.environ.get('OUTPUT_DIR', '/output')
filepath = os.path.join(output_dir, f'invoice_{inv_number}.pdf')
w, h = A4
c = canvas.Canvas(filepath, pagesize=A4)

# Header
c.setFont('Helvetica-Bold', 24)
c.setFillColor(colors.HexColor('#2C3E50'))
c.drawString(2*cm, h - 2.5*cm, 'INVOICE')
c.setFont('Helvetica', 10)
c.setFillColor(colors.HexColor('#7F8C8D'))
c.drawRightString(w - 2*cm, h - 2.5*cm, f'#{inv_number}')
c.drawRightString(w - 2*cm, h - 3*cm, f'Date: {date}')

# Company & Customer
y = h - 4.5*cm
c.setFillColor(colors.HexColor('#2C3E50'))
c.setFont('Helvetica-Bold', 11)
c.drawString(2*cm, y, 'From:')
c.drawString(10*cm, y, 'To:')
c.setFont('Helvetica', 10)
c.setFillColor(colors.black)
c.drawString(2*cm, y - 0.5*cm, company)
c.drawString(10*cm, y - 0.5*cm, customer)
if address:
    for i, line in enumerate(address.split('\\n')):
        c.drawString(10*cm, y - (1 + i*0.5)*cm, line)

# Table header
y = h - 8*cm
c.setFillColor(colors.HexColor('#4472C4'))
c.rect(2*cm, y - 0.1*cm, w - 4*cm, 0.7*cm, fill=1, stroke=0)
c.setFillColor(colors.white)
c.setFont('Helvetica-Bold', 9)
c.drawString(2.2*cm, y + 0.1*cm, 'Description')
c.drawRightString(12*cm, y + 0.1*cm, 'Qty')
c.drawRightString(15*cm, y + 0.1*cm, 'Unit Price')
c.drawRightString(w - 2.2*cm, y + 0.1*cm, 'Amount')

# Items
c.setFillColor(colors.black)
c.setFont('Helvetica', 9)
total = 0
for i, item in enumerate(items):
    row_y = y - (i + 1) * 0.6*cm
    qty = item.get('quantity', 0)
    price = item.get('unitPrice', 0)
    amount = qty * price
    total += amount
    if i % 2 == 1:
        c.setFillColor(colors.HexColor('#F0F4F8'))
        c.rect(2*cm, row_y - 0.1*cm, w - 4*cm, 0.6*cm, fill=1, stroke=0)
        c.setFillColor(colors.black)
    c.drawString(2.2*cm, row_y + 0.1*cm, str(item.get('description', '')))
    c.drawRightString(12*cm, row_y + 0.1*cm, str(qty))
    c.drawRightString(15*cm, row_y + 0.1*cm, f'{currency}{price:,.2f}')
    c.drawRightString(w - 2.2*cm, row_y + 0.1*cm, f'{currency}{amount:,.2f}')

# Total
total_y = y - (len(items) + 1.5) * 0.6*cm
c.setStrokeColor(colors.HexColor('#4472C4'))
c.line(12*cm, total_y + 0.4*cm, w - 2*cm, total_y + 0.4*cm)
c.setFont('Helvetica-Bold', 11)
c.drawRightString(15*cm, total_y, 'Total:')
c.setFillColor(colors.HexColor('#2C3E50'))
c.drawRightString(w - 2.2*cm, total_y, f'{currency}{total:,.2f}')

# Notes
if notes:
    notes_y = total_y - 2*cm
    c.setFillColor(colors.HexColor('#7F8C8D'))
    c.setFont('Helvetica-Bold', 9)
    c.drawString(2*cm, notes_y, 'Notes:')
    c.setFont('Helvetica', 9)
    c.setFillColor(colors.black)
    for i, line in enumerate(notes.split('\\n')):
        c.drawString(2*cm, notes_y - (i + 1) * 0.4*cm, line)

c.save()
print(f'Generated: invoice_{inv_number}.pdf')
`;

const SEED_DATA_SUMMARY = `import os, json
import pandas as pd
from docx import Document
from docx.shared import Inches, Pt
from docx.enum.table import WD_TABLE_ALIGNMENT

title = json.loads('''{{title}}''') if '{{title}}'.startswith('"') else '{{title}}'
raw_data = json.loads('''{{data}}''')
group_by_raw = '''{{groupByField}}'''
group_by = group_by_raw if group_by_raw != '{{' + 'groupByField}}' else None
sort_by_raw = '''{{sortByField}}'''
sort_by = sort_by_raw if sort_by_raw != '{{' + 'sortByField}}' else None
top_n_raw = '''{{topN}}'''
top_n = int(top_n_raw) if top_n_raw != '{{' + 'topN}}' else 10

df = pd.DataFrame(raw_data)
doc = Document()
doc.add_heading(title, 0)

# Overview
doc.add_heading('Overview', level=1)
doc.add_paragraph(f'Total records: {len(df)}')
doc.add_paragraph(f'Fields: {", ".join(df.columns.tolist())}')

# Numeric summary
num_cols = df.select_dtypes(include='number').columns.tolist()
if num_cols:
    doc.add_heading('Numeric Summary', level=1)
    stats = df[num_cols].describe().round(2)
    table = doc.add_table(rows=len(stats) + 1, cols=len(num_cols) + 1)
    table.style = 'Light Grid Accent 1'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.rows[0].cells[0].text = 'Metric'
    for j, col in enumerate(num_cols):
        table.rows[0].cells[j + 1].text = col
    for i, (idx, row) in enumerate(stats.iterrows()):
        table.rows[i + 1].cells[0].text = str(idx)
        for j, col in enumerate(num_cols):
            table.rows[i + 1].cells[j + 1].text = str(row[col])

# Group-by analysis
if group_by and group_by in df.columns:
    doc.add_heading(f'Grouped by: {group_by}', level=1)
    grouped = df.groupby(group_by)
    summary_rows = []
    for name, group in grouped:
        row_info = {'Group': str(name), 'Count': len(group)}
        for nc in num_cols:
            row_info[f'{nc} (sum)'] = round(group[nc].sum(), 2)
            row_info[f'{nc} (avg)'] = round(group[nc].mean(), 2)
        summary_rows.append(row_info)
    if summary_rows:
        headers = list(summary_rows[0].keys())
        table = doc.add_table(rows=len(summary_rows) + 1, cols=len(headers))
        table.style = 'Light Grid Accent 1'
        for j, h in enumerate(headers):
            table.rows[0].cells[j].text = h
        for i, sr in enumerate(summary_rows):
            for j, h in enumerate(headers):
                table.rows[i + 1].cells[j].text = str(sr[h])

# Top records
if sort_by and sort_by in df.columns:
    df_sorted = df.sort_values(sort_by, ascending=False)
else:
    df_sorted = df
top = df_sorted.head(top_n)
doc.add_heading(f'Top {top_n} Records', level=1)
cols = top.columns.tolist()
table = doc.add_table(rows=len(top) + 1, cols=len(cols))
table.style = 'Light Grid Accent 1'
for j, col in enumerate(cols):
    table.rows[0].cells[j].text = str(col)
for i, (_, row) in enumerate(top.iterrows()):
    for j, col in enumerate(cols):
        table.rows[i + 1].cells[j].text = str(row[col])

output_dir = os.environ.get('OUTPUT_DIR', '/output')
filepath = os.path.join(output_dir, 'summary_report.docx')
doc.save(filepath)
print('Generated: summary_report.docx')
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
