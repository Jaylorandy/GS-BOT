const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
} = require('docx');
const XLSX = require('xlsx');
const runtimeResolver = require('./runtime-resolver');

function stripMarkdown(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\uFFFD{2,}/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    .replace(/\r/g, '')
    .trim();
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function extractTitle(content, fallbackTitle = 'Chat Studio Export') {
  const lines = String(content || '')
    .split('\n')
    .map((line) => stripMarkdown(line.replace(/^#+\s*/, '').replace(/^\d+\.\s*/, '').replace(/^[-*]\s*/, '')))
    .filter(Boolean);

  return sanitizeFilenamePart(lines[0] || fallbackTitle) || fallbackTitle;
}

function getSuggestedFilename(format, title, fallbackTitle = 'Chat Studio Export') {
  const safeTitle = extractTitle(title, fallbackTitle);
  const ext = format === 'excel' ? 'xlsx' : format === 'ppt' ? 'pptx' : 'docx';
  return `${safeTitle}.${ext}`;
}

function cleanCellText(value) {
  return stripMarkdown(String(value || '').replace(/\s+/g, ' ').trim());
}

function splitTableCells(line) {
  let normalized = String(line || '').trim();
  if (normalized.startsWith('|')) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith('|')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.split('|').map((cell) => cleanCellText(cell));
}

function isTableDelimiterLine(line) {
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRowLine(line) {
  const trimmed = String(line || '').trim();
  return trimmed.includes('|') && !trimmed.startsWith('```');
}

function parseMarkdownTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length) {
    return null;
  }

  const headerLine = lines[startIndex];
  const delimiterLine = lines[startIndex + 1];
  if (!isTableRowLine(headerLine) || !isTableDelimiterLine(delimiterLine)) {
    return null;
  }

  const headers = splitTableCells(headerLine);
  if (headers.length === 0) {
    return null;
  }

  const rows = [];
  let cursor = startIndex + 2;

  while (cursor < lines.length && isTableRowLine(lines[cursor]) && !isTableDelimiterLine(lines[cursor])) {
    const values = splitTableCells(lines[cursor]);
    if (values.length > 0) {
      while (values.length < headers.length) {
        values.push('');
      }
      rows.push(values.slice(0, headers.length));
    }
    cursor += 1;
  }

  if (rows.length === 0) {
    return null;
  }

  return {
    block: {
      type: 'table',
      headers,
      rows,
    },
    nextIndex: cursor,
  };
}

function parseBlocks(content) {
  const blocks = [];
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  let paragraphLines = [];
  let cursor = 0;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push({
      type: 'paragraph',
      text: stripMarkdown(paragraphLines.join(' ').trim()),
    });
    paragraphLines = [];
  };

  while (cursor < lines.length) {
    const rawLine = lines[cursor];
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      cursor += 1;
      continue;
    }

    if (line.startsWith('```')) {
      flushParagraph();
      const codeLines = [];
      cursor += 1;
      while (cursor < lines.length && !String(lines[cursor] || '').trim().startsWith('```')) {
        codeLines.push(lines[cursor]);
        cursor += 1;
      }
      cursor += 1;
      if (codeLines.length > 0) {
        blocks.push({
          type: 'paragraph',
          text: stripMarkdown(codeLines.join('\n')),
        });
      }
      continue;
    }

    const tableMatch = parseMarkdownTable(lines, cursor);
    if (tableMatch) {
      flushParagraph();
      blocks.push(tableMatch.block);
      cursor = tableMatch.nextIndex;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: Math.min(headingMatch[1].length, 3),
        text: stripMarkdown(headingMatch[2]),
      });
      cursor += 1;
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      blocks.push({
        type: 'bullet',
        text: stripMarkdown(bulletMatch[1]),
      });
      cursor += 1;
      continue;
    }

    const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      flushParagraph();
      blocks.push({
        type: 'numbered',
        number: numberedMatch[1],
        text: stripMarkdown(numberedMatch[2]),
      });
      cursor += 1;
      continue;
    }

    paragraphLines.push(line);
    cursor += 1;
  }

  flushParagraph();
  return blocks.filter((block) => {
    if (block.type === 'table') {
      return block.rows.length > 0;
    }
    return Boolean(block.text);
  });
}

function annotateTables(blocks, fallbackTitle) {
  let currentHeading = fallbackTitle;
  let tableCount = 0;

  return blocks.map((block) => {
    if (block.type === 'heading' && block.level <= 2) {
      currentHeading = block.text;
      return block;
    }

    if (block.type === 'table') {
      tableCount += 1;
      return {
        ...block,
        title: `${currentHeading || fallbackTitle} Table ${tableCount}`,
      };
    }

    return block;
  });
}

function parseNumber(value) {
  const normalized = String(value || '')
    .replace(/[,%$]/g, '')
    .replace(/\s+/g, '')
    .trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferChartFromTable(table) {
  if (!table || !Array.isArray(table.headers) || table.headers.length < 2 || table.rows.length < 2) {
    return null;
  }

  let numericColumn = -1;
  for (let col = 1; col < table.headers.length; col += 1) {
    const numericValues = table.rows
      .map((row) => parseNumber(row[col]))
      .filter((value) => value !== null);
    if (numericValues.length >= Math.max(2, Math.ceil(table.rows.length / 2))) {
      numericColumn = col;
      break;
    }
  }

  if (numericColumn === -1) {
    return null;
  }

  const categoryColumn = table.headers.findIndex((_, index) => index !== numericColumn);
  if (categoryColumn === -1) {
    return null;
  }

  const points = table.rows
    .map((row) => ({
      category: cleanCellText(row[categoryColumn]),
      value: parseNumber(row[numericColumn]),
    }))
    .filter((item) => item.category && item.value !== null)
    .slice(0, 10);

  if (points.length < 2) {
    return null;
  }

  return {
    title: table.title,
    categoryHeader: table.headers[categoryColumn] || 'Category',
    valueHeader: table.headers[numericColumn] || 'Value',
    categories: points.map((item) => item.category),
    values: points.map((item) => item.value),
    chartType: points.length > 6 ? 'bar' : 'column',
  };
}

function buildSections(blocks, fallbackTitle) {
  const sections = [];
  let current = {
    title: fallbackTitle,
    bullets: [],
  };

  const pushCurrent = () => {
    if (current.bullets.length === 0 && sections.length > 0) {
      return;
    }
    sections.push({
      title: current.title || fallbackTitle,
      bullets: current.bullets.slice(0, 6),
    });
  };

  for (const block of blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      pushCurrent();
      current = {
        title: block.text,
        bullets: [],
      };
      continue;
    }

    if (block.type === 'table') {
      current.bullets.push(`Includes table: ${block.title}`);
      continue;
    }

    current.bullets.push(block.text);
  }

  pushCurrent();
  return sections.slice(0, 10);
}

function buildStructuredContent(content, fallbackTitle) {
  const title = extractTitle(content, fallbackTitle);
  const blocks = annotateTables(parseBlocks(content), title);
  const tables = blocks
    .filter((block) => block.type === 'table')
    .map((table) => ({
      ...table,
      chart: inferChartFromTable(table),
    }));

  return {
    title,
    blocks,
    tables,
    sections: buildSections(blocks, title),
  };
}

function createTableCell(text, { bold = false } = {}) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: cleanCellText(text) || ' ',
            bold,
            size: 20,
          }),
        ],
      }),
    ],
  });
}

function createWordTable(table) {
  const rows = [
    new TableRow({
      children: table.headers.map((header) => createTableCell(header, { bold: true })),
    }),
    ...table.rows.slice(0, 20).map((row) => (
      new TableRow({
        children: row.map((cell) => createTableCell(cell)),
      })
    )),
  ];

  return new Table({
    width: {
      size: 100,
      type: WidthType.PERCENTAGE,
    },
    rows,
  });
}

async function exportDocx({ title, content, meta, outputPath }) {
  const structured = buildStructuredContent(content, 'Chat Studio Report');
  const exportTitle = extractTitle(title || structured.title, 'Chat Studio Report');
  const body = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 280 },
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: exportTitle, bold: true, size: 32 })],
    }),
  ];

  if (meta) {
    body.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 320 },
      children: [new TextRun({ text: String(meta), italics: true, color: '666666', size: 20 })],
    }));
  }

  for (const block of structured.blocks) {
    if (block.type === 'heading') {
      body.push(new Paragraph({
        heading: block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
        spacing: { before: 220, after: 140 },
        children: [new TextRun({ text: block.text })],
      }));
      continue;
    }

    if (block.type === 'table') {
      body.push(new Paragraph({
        spacing: { before: 180, after: 100 },
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun({ text: block.title })],
      }));
      body.push(createWordTable(block));
      if (block.chart) {
        body.push(new Paragraph({
          spacing: { before: 120, after: 140 },
          children: [
            new TextRun({
              text: `Chart-ready data detected: ${block.chart.categoryHeader} vs ${block.chart.valueHeader}.`,
              italics: true,
              color: '666666',
            }),
          ],
        }));
      }
      continue;
    }

    if (block.type === 'bullet') {
      body.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 100 },
        children: [new TextRun({ text: block.text, size: 22 })],
      }));
      continue;
    }

    if (block.type === 'numbered') {
      body.push(new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: `${block.number}. ${block.text}`, size: 22 })],
      }));
      continue;
    }

    body.push(new Paragraph({
      spacing: { after: 160 },
      children: [new TextRun({ text: block.text, size: 22 })],
    }));
  }

  const doc = new Document({
    sections: [{ children: body }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  return { outputPath, title: exportTitle };
}

function sanitizeSheetName(name, existingNames = new Set()) {
  let safeName = sanitizeFilenamePart(name || 'Sheet')
    .replace(/[\[\]:*?/\\]/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet';

  let suffix = 1;
  const baseName = safeName;
  while (existingNames.has(safeName)) {
    const tail = ` ${suffix}`;
    safeName = `${baseName.slice(0, Math.max(1, 31 - tail.length))}${tail}`;
    suffix += 1;
  }
  existingNames.add(safeName);
  return safeName;
}

function exportExcelFallback({ title, content, meta, outputPath }) {
  const structured = buildStructuredContent(content, 'Chat Studio Report');
  const exportTitle = extractTitle(title || structured.title, 'Chat Studio Report');
  const workbook = XLSX.utils.book_new();
  const usedSheetNames = new Set();

  const overviewRows = [
    ['Title', exportTitle],
    ['Source', meta || 'Chat Studio'],
    ['Exported At', new Date().toLocaleString()],
    ['Sections', structured.sections.length],
    ['Tables', structured.tables.length],
  ];

  const contentRows = structured.blocks.flatMap((block, index) => {
    if (block.type === 'table') {
      return [[index + 1, block.type, block.title, `${block.rows.length} rows × ${block.headers.length} columns`]];
    }

    return [[index + 1, block.type, block.text, '']];
  });

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(overviewRows),
    sanitizeSheetName('Overview', usedSheetNames),
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([['Order', 'Type', 'Content', 'Details'], ...contentRows]),
    sanitizeSheetName('Content', usedSheetNames),
  );

  structured.tables.forEach((table, index) => {
    const rows = [table.headers, ...table.rows];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(rows),
      sanitizeSheetName(table.title || `Table ${index + 1}`, usedSheetNames),
    );
  });

  XLSX.writeFile(workbook, outputPath);
  return { outputPath, title: exportTitle };
}

function runPythonExport(pythonRuntime, scriptPath, payloadPath, outputPath) {
  return new Promise((resolve, reject) => {
    const pythonEnv = runtimeResolver.getPythonSpawnEnv(pythonRuntime);
    const child = spawn(
      pythonRuntime.command,
      [...pythonRuntime.args, scriptPath, payloadPath, outputPath],
      {
        env: pythonEnv,
        windowsHide: true,
      },
    );

    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `Export failed with exit code ${code}`));
    });
  });
}

async function exportExcel({ title, content, meta, outputPath }) {
  const structured = buildStructuredContent(content, 'Chat Studio Report');
  const exportTitle = extractTitle(title || structured.title, 'Chat Studio Report');
  const pythonRuntime = runtimeResolver.findPythonRuntime();

  if (!pythonRuntime) {
    return exportExcelFallback({ title: exportTitle, content, meta, outputPath });
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsbot-chat-export-'));
  const payloadPath = path.join(tempDir, 'payload.json');
  const scriptPath = path.join(tempDir, 'export_xlsx.py');
  const payload = {
    title: exportTitle,
    meta: String(meta || 'Chat Studio'),
    exportedAt: new Date().toLocaleString(),
    contentRows: structured.blocks.flatMap((block, index) => {
      if (block.type === 'table') {
        return [[index + 1, block.type, block.title, `${block.rows.length} rows x ${block.headers.length} columns`]];
      }
      return [[index + 1, block.type, block.text, '']];
    }),
    tables: structured.tables.map((table) => ({
      title: table.title,
      headers: table.headers,
      rows: table.rows,
      chart: table.chart,
    })),
  };

  const script = `
import json
import re
import sys
import xlsxwriter

payload_path, output_path = sys.argv[1], sys.argv[2]
with open(payload_path, 'r', encoding='utf-8') as fh:
    payload = json.load(fh)

def safe_sheet_name(value, used):
    text = re.sub(r'[\\[\\]:*?/\\\\]', ' ', str(value or 'Sheet')).strip()[:31] or 'Sheet'
    base = text
    index = 1
    while text in used:
        suffix = f" {index}"
        text = (base[: max(1, 31 - len(suffix))] + suffix).strip()
        index += 1
    used.add(text)
    return text

workbook = xlsxwriter.Workbook(output_path)
used_names = set()

title_fmt = workbook.add_format({'bold': True, 'font_size': 14})
header_fmt = workbook.add_format({'bold': True, 'bg_color': '#EAF2FF', 'border': 1})
cell_fmt = workbook.add_format({'text_wrap': True, 'valign': 'top', 'border': 1})

overview = workbook.add_worksheet(safe_sheet_name('Overview', used_names))
overview.write_row(0, 0, ['Title', payload.get('title')], cell_fmt)
overview.write_row(1, 0, ['Source', payload.get('meta')], cell_fmt)
overview.write_row(2, 0, ['Exported At', payload.get('exportedAt')], cell_fmt)
overview.write_row(3, 0, ['Tables', len(payload.get('tables') or [])], cell_fmt)
overview.set_column(0, 0, 18)
overview.set_column(1, 1, 48)

content = workbook.add_worksheet(safe_sheet_name('Content', used_names))
content.write_row(0, 0, ['Order', 'Type', 'Content', 'Details'], header_fmt)
for row_index, row in enumerate(payload.get('contentRows') or [], start=1):
    content.write_row(row_index, 0, row, cell_fmt)
content.set_column(0, 0, 8)
content.set_column(1, 1, 12)
content.set_column(2, 3, 42)

for table_index, table in enumerate(payload.get('tables') or [], start=1):
    sheet = workbook.add_worksheet(safe_sheet_name(table.get('title') or f'Table {table_index}', used_names))
    headers = table.get('headers') or []
    rows = table.get('rows') or []

    for col, header in enumerate(headers):
        sheet.write(0, col, header, header_fmt)

    for row_offset, row in enumerate(rows, start=1):
        for col, value in enumerate(row):
            try:
                number = float(str(value).replace(',', '').replace('%', '').replace('$', '').strip())
                sheet.write_number(row_offset, col, number, cell_fmt)
            except Exception:
                sheet.write(row_offset, col, value, cell_fmt)

    sheet.freeze_panes(1, 0)
    sheet.set_column(0, max(len(headers) - 1, 0), 22)

    chart_spec = table.get('chart') or {}
    categories = chart_spec.get('categories') or []
    values = chart_spec.get('values') or []
    if categories and values and len(categories) == len(values):
        chart = workbook.add_chart({'type': chart_spec.get('chartType') or 'column'})
        chart.add_series({
            'name': chart_spec.get('valueHeader') or 'Value',
            'categories': [sheet.name, 1, 0, len(categories), 0],
            'values': [sheet.name, 1, 1, len(values), 1],
        })
        chart.set_title({'name': chart_spec.get('title') or table.get('title') or f'Chart {table_index}'})
        chart.set_legend({'none': True})
        sheet.insert_chart(max(len(rows) + 3, 3), 0, chart, {'x_scale': 1.25, 'y_scale': 1.15})

workbook.close()
`;

  try {
    fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(scriptPath, script.trimStart(), 'utf8');
    await runPythonExport(pythonRuntime, scriptPath, payloadPath, outputPath);
    return { outputPath, title: exportTitle };
  } catch {
    return exportExcelFallback({ title: exportTitle, content, meta, outputPath });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function exportPpt({ title, content, meta, outputPath }) {
  const structured = buildStructuredContent(content, 'Chat Studio Deck');
  const exportTitle = extractTitle(title || structured.title, 'Chat Studio Deck');
  const pythonRuntime = runtimeResolver.findPythonRuntime();

  if (!pythonRuntime) {
    throw new Error('Python 3 was not found, so PPT export is unavailable on this machine.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsbot-chat-export-'));
  const payloadPath = path.join(tempDir, 'payload.json');
  const scriptPath = path.join(tempDir, 'export_ppt.py');
  const payload = {
    title: exportTitle,
    meta: String(meta || 'Chat Studio'),
    sections: structured.sections,
    tables: structured.tables.slice(0, 4),
    charts: structured.tables
      .map((table) => table.chart)
      .filter(Boolean)
      .slice(0, 4),
  };

  const script = `
import json
import sys
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt

payload_path, output_path = sys.argv[1], sys.argv[2]
with open(payload_path, 'r', encoding='utf-8') as fh:
    payload = json.load(fh)

prs = Presentation()

def add_title(slide, text):
    textbox = slide.shapes.add_textbox(Inches(0.6), Inches(0.35), Inches(8.2), Inches(0.6))
    paragraph = textbox.text_frame.paragraphs[0]
    paragraph.text = text
    paragraph.font.bold = True
    paragraph.font.size = Pt(24)

title_slide = prs.slide_layouts[0]
slide = prs.slides.add_slide(title_slide)
slide.shapes.title.text = payload.get('title') or 'Chat Studio Deck'
slide.placeholders[1].text = payload.get('meta') or 'Chat Studio'

for section in payload.get('sections', [])[:8]:
    content_slide = prs.slide_layouts[1]
    slide = prs.slides.add_slide(content_slide)
    slide.shapes.title.text = section.get('title') or 'Section'
    text_frame = slide.placeholders[1].text_frame
    text_frame.clear()
    bullets = section.get('bullets') or ['']
    for idx, bullet in enumerate(bullets[:6]):
        paragraph = text_frame.paragraphs[0] if idx == 0 else text_frame.add_paragraph()
        paragraph.text = str(bullet)
        paragraph.level = 0
        paragraph.font.size = Pt(20)

for table in payload.get('tables', []):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_title(slide, table.get('title') or 'Table')
    headers = table.get('headers') or []
    rows = table.get('rows') or []
    row_count = min(len(rows) + 1, 8)
    col_count = max(len(headers), 1)
    graphic_frame = slide.shapes.add_table(row_count, col_count, Inches(0.5), Inches(1.2), Inches(9.0), Inches(4.8))
    ppt_table = graphic_frame.table
    for col, header in enumerate(headers[:col_count]):
        ppt_table.cell(0, col).text = str(header)
    for row_index, row in enumerate(rows[: row_count - 1], start=1):
        for col in range(col_count):
            ppt_table.cell(row_index, col).text = str(row[col] if col < len(row) else '')

for chart in payload.get('charts', []):
    categories = chart.get('categories') or []
    values = chart.get('values') or []
    if len(categories) < 2 or len(categories) != len(values):
        continue
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_title(slide, chart.get('title') or 'Chart')
    chart_data = CategoryChartData()
    chart_data.categories = categories
    chart_data.add_series(chart.get('valueHeader') or 'Value', values)
    chart_type = XL_CHART_TYPE.BAR_CLUSTERED if chart.get('chartType') == 'bar' else XL_CHART_TYPE.COLUMN_CLUSTERED
    slide.shapes.add_chart(chart_type, Inches(0.7), Inches(1.3), Inches(8.4), Inches(4.6), chart_data)

prs.save(output_path)
`;

  try {
    fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(scriptPath, script.trimStart(), 'utf8');
    await runPythonExport(pythonRuntime, scriptPath, payloadPath, outputPath);
    return { outputPath, title: exportTitle };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function exportChatMessage({ format, title, content, meta, outputPath }) {
  switch (format) {
    case 'word':
      return exportDocx({ title, content, meta, outputPath });
    case 'excel':
      return exportExcel({ title, content, meta, outputPath });
    case 'ppt':
      return exportPpt({ title, content, meta, outputPath });
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}

module.exports = {
  exportChatMessage,
  getSuggestedFilename,
};
