const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const JSZip = require('jszip');

const MAX_PREVIEW_TEXT_CHARS = 12000;
const MAX_TEXT_CHUNK_CHARS = 4200;
const MAX_TEXT_CHUNKS = 24;
const MAX_ATTACHMENT_FILES = 12;
const MAX_EMBEDDED_IMAGES = 8;
const MAX_SPREADSHEET_SHEETS = 8;
const MAX_SPREADSHEET_ROWS = 300;
const SPREADSHEET_ROWS_PER_CHUNK = 50;
const MAX_PPT_SLIDES = 60;
const MIN_EXTRACTED_IMAGE_BYTES = 128;
const MAX_EXTRACTED_IMAGE_BYTES = 8 * 1024 * 1024;

function sanitizeExtractedText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\uFFFD{2,}/g, ' ')
    .replace(/\uFFFD/g, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function limitText(text) {
  const normalized = sanitizeExtractedText(String(text || '').replace(/\r\n/g, '\n'));
  if (normalized.length <= MAX_PREVIEW_TEXT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_PREVIEW_TEXT_CHARS)}\n\n[Truncated for chat context]`;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlToPlainText(xml) {
  const withParagraphs = String(xml || '')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<\/text:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<a:tab\/>/g, '\t');

  return decodeXmlEntities(
    withParagraphs
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' '),
  ).trim();
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/jpeg';
}

function isImageExtension(ext) {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'].includes(ext);
}

function createAttachmentResult(filePath, stats) {
  return {
    path: filePath,
    name: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
    sizeBytes: stats.size,
    isImage: false,
    mimeType: '',
    textContent: '',
    textChunks: [],
    textTotalChars: 0,
    previewTruncated: false,
    imageData: '',
    embeddedImages: [],
    warning: '',
  };
}

function appendEmbeddedImage(result, sourcePath, buffer, mimeType, label, dedupeSet, options = {}) {
  const minBytes = Number(options.minBytes) || MIN_EXTRACTED_IMAGE_BYTES;

  if (!buffer || buffer.length < minBytes || buffer.length > MAX_EXTRACTED_IMAGE_BYTES) {
    return;
  }

  if (result.embeddedImages.length >= MAX_EMBEDDED_IMAGES) {
    return;
  }

  const hash = crypto.createHash('sha1').update(buffer).digest('hex');
  if (dedupeSet.has(hash)) {
    return;
  }
  dedupeSet.add(hash);

  result.embeddedImages.push({
    name: label,
    source: path.basename(sourcePath),
    mimeType,
    imageData: buffer.toString('base64'),
    sizeBytes: buffer.length,
  });
}

function buildEmbeddedImageSummary(result) {
  if (!result.embeddedImages || result.embeddedImages.length === 0) {
    return '';
  }

  return `Embedded images extracted: ${result.embeddedImages.length}.`;
}

function splitOversizedText(text, maxChars = MAX_TEXT_CHUNK_CHARS) {
  const normalized = sanitizeExtractedText(text);
  if (!normalized) {
    return [];
  }

  const slices = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    slices.push(normalized.slice(cursor, cursor + maxChars));
    cursor += maxChars;
  }
  return slices;
}

function buildTextChunksFromSections(sections = []) {
  const chunks = [];
  let totalChars = 0;
  let overflow = false;

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (!section) {
      continue;
    }

    const label = sanitizeExtractedText(section.label || '');
    const text = sanitizeExtractedText(section.text || '');
    if (!text) {
      continue;
    }

    totalChars += text.length;
    const parts = splitOversizedText(text);

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      if (chunks.length >= MAX_TEXT_CHUNKS) {
        overflow = true;
        break;
      }

      chunks.push({
        label: parts.length > 1
          ? `${label || `Section ${index + 1}`} · Part ${partIndex + 1}`
          : (label || `Section ${index + 1}`),
        text: parts[partIndex],
      });
    }

    if (overflow) {
      break;
    }
  }

  return {
    chunks,
    totalChars,
    overflow,
  };
}

function buildPreviewText(chunks = [], notes = []) {
  const noteText = notes.filter(Boolean).join('\n');
  const budget = Math.max(1000, MAX_PREVIEW_TEXT_CHARS - noteText.length - 40);
  const sections = [];
  let used = 0;

  for (const chunk of chunks) {
    const body = chunk.label ? `${chunk.label}\n${chunk.text}` : chunk.text;
    if (!body) {
      continue;
    }

    if (used + body.length > budget) {
      break;
    }

    sections.push(body);
    used += body.length + 2;
  }

  return limitText([...sections, noteText].filter(Boolean).join('\n\n'));
}

function setAttachmentText(result, sections, options = {}) {
  const list = Array.isArray(sections)
    ? sections
    : [{ label: options.defaultLabel || 'Content', text: sections }];
  const normalizedSections = list
    .map((section, index) => {
      if (!section) {
        return null;
      }

      if (typeof section === 'string') {
        return {
          label: `${options.defaultLabel || 'Content'} ${index + 1}`,
          text: section,
        };
      }

      return {
        label: section.label || `${options.defaultLabel || 'Content'} ${index + 1}`,
        text: section.text || '',
      };
    })
    .filter(Boolean);

  const { chunks, totalChars, overflow } = buildTextChunksFromSections(normalizedSections);
  const notes = [];

  if (chunks.length > 1) {
    notes.push(`Indexed text chunks: ${chunks.length}.`);
  }

  if (overflow) {
    notes.push('Additional text exists beyond the indexed chat chunks.');
  }

  if (options.summary) {
    notes.push(options.summary);
  }

  result.textChunks = chunks;
  result.textTotalChars = totalChars;
  result.previewTruncated = overflow || totalChars > MAX_PREVIEW_TEXT_CHARS;
  result.textContent = buildPreviewText(chunks, notes);

  if (!result.textContent) {
    result.textContent = options.fallbackText || `Attachment: ${result.name}`;
  }
}

async function parsePdfText(buffer) {
  const result = await pdfParse(buffer);
  return sanitizeExtractedText(result.text || '');
}

function parseSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sections = [];
  const includedSheets = workbook.SheetNames.slice(0, MAX_SPREADSHEET_SHEETS);

  for (const sheetName of includedSheets) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      blankrows: false,
      raw: false,
    });
    const indexedRows = rows.slice(0, MAX_SPREADSHEET_ROWS);

    for (let start = 0; start < indexedRows.length; start += SPREADSHEET_ROWS_PER_CHUNK) {
      const slice = indexedRows.slice(start, start + SPREADSHEET_ROWS_PER_CHUNK);
      const preview = slice
        .map((row) => row.map((cell) => String(cell ?? '')).join('\t'))
        .join('\n')
        .trim();

      if (!preview) {
        continue;
      }

      sections.push({
        label: `Sheet: ${sheetName} · Rows ${start + 1}-${start + slice.length}`,
        text: preview,
      });
    }
  }

  const omittedSheetCount = Math.max(0, workbook.SheetNames.length - includedSheets.length);
  const summary = omittedSheetCount > 0
    ? `Only the first ${includedSheets.length} sheets were indexed for chat context.`
    : '';

  return { sections, summary };
}

async function collectZipMedia(zip, prefixes, result) {
  const dedupeSet = new Set();
  const entries = Object.keys(zip.files)
    .filter((entry) => !zip.files[entry].dir)
    .filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix)))
    .filter((entry) => isImageExtension(path.extname(entry).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));

  for (const entry of entries) {
    if (result.embeddedImages.length >= MAX_EMBEDDED_IMAGES) {
      break;
    }

    const file = zip.file(entry);
    if (!file) {
      continue;
    }

    const content = await file.async('nodebuffer');
    appendEmbeddedImage(
      result,
      entry,
      content,
      getMimeType(entry),
      path.basename(entry),
      dedupeSet,
      { minBytes: 16 },
    );
  }
}

async function parseDocx(buffer, result) {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    return '';
  }

  const xml = await docFile.async('string');
  await collectZipMedia(zip, ['word/media/'], result);
  return sanitizeExtractedText(xmlToPlainText(xml));
}

async function parsePptx(buffer, result) {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
    .sort((left, right) => {
      const leftIndex = Number(left.match(/slide(\d+)\.xml/i)?.[1] || '0');
      const rightIndex = Number(right.match(/slide(\d+)\.xml/i)?.[1] || '0');
      return leftIndex - rightIndex;
    });

  const sections = [];
  for (const slideName of slideNames.slice(0, MAX_PPT_SLIDES)) {
    const file = zip.file(slideName);
    if (!file) {
      continue;
    }

    const xml = await file.async('string');
    const index = slideName.match(/slide(\d+)\.xml/i)?.[1] || '?';
    const text = sanitizeExtractedText(xmlToPlainText(xml));
    if (text) {
      sections.push({
        label: `Slide ${index}`,
        text,
      });
    }
  }

  await collectZipMedia(zip, ['ppt/media/'], result);
  const omittedSlideCount = Math.max(0, slideNames.length - MAX_PPT_SLIDES);

  return {
    sections,
    summary: omittedSlideCount > 0
      ? `Only the first ${MAX_PPT_SLIDES} slides were indexed for chat context.`
      : '',
  };
}

function findBufferSequence(buffer, sequence, start) {
  for (let index = start; index <= buffer.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (buffer[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }
  return -1;
}

function extractRawImagesFromPdf(buffer, result) {
  const dedupeSet = new Set();
  const jpegStart = Buffer.from([0xff, 0xd8, 0xff]);
  const jpegEnd = Buffer.from([0xff, 0xd9]);
  const pngStart = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngEnd = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

  let cursor = 0;
  while (result.embeddedImages.length < MAX_EMBEDDED_IMAGES) {
    const start = findBufferSequence(buffer, jpegStart, cursor);
    if (start === -1) {
      break;
    }
    const end = findBufferSequence(buffer, jpegEnd, start + jpegStart.length);
    if (end === -1) {
      break;
    }
    const slice = buffer.slice(start, end + jpegEnd.length);
    appendEmbeddedImage(result, result.path, slice, 'image/jpeg', `pdf-image-${result.embeddedImages.length + 1}.jpg`, dedupeSet);
    cursor = end + jpegEnd.length;
  }

  cursor = 0;
  while (result.embeddedImages.length < MAX_EMBEDDED_IMAGES) {
    const start = findBufferSequence(buffer, pngStart, cursor);
    if (start === -1) {
      break;
    }
    const end = findBufferSequence(buffer, pngEnd, start + pngStart.length);
    if (end === -1) {
      break;
    }
    const slice = buffer.slice(start, end + pngEnd.length);
    appendEmbeddedImage(result, result.path, slice, 'image/png', `pdf-image-${result.embeddedImages.length + 1}.png`, dedupeSet);
    cursor = end + pngEnd.length;
  }
}

function parsePlainText(buffer, extension) {
  const text = buffer.toString('utf8');
  if (extension === '.json') {
    try {
      return sanitizeExtractedText(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      return sanitizeExtractedText(text);
    }
  }
  return sanitizeExtractedText(text);
}

async function parseAttachment(filePath) {
  const stats = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);
  const result = createAttachmentResult(filePath, stats);
  const ext = result.extension;

  if (isImageExtension(ext)) {
    result.isImage = true;
    result.mimeType = getMimeType(filePath);
    result.imageData = buffer.toString('base64');
    result.textContent = `Image attachment: ${result.name}`;
    return result;
  }

  try {
    if (ext === '.pdf') {
      let text = '';
      try {
        text = await parsePdfText(buffer);
      } catch (pdfError) {
        result.warning = `Text parsing was limited for ${result.name}: ${pdfError.message}`;
      }
      extractRawImagesFromPdf(buffer, result);
      setAttachmentText(result, text || `Attachment: ${result.name}`, {
        defaultLabel: 'PDF content',
        summary: buildEmbeddedImageSummary(result),
        fallbackText: `Attachment: ${result.name}`,
      });
      return result;
    }

    if (ext === '.xlsx' || ext === '.xls') {
      const spreadsheet = parseSpreadsheet(buffer);
      setAttachmentText(result, spreadsheet.sections, {
        defaultLabel: 'Sheet',
        summary: spreadsheet.summary,
        fallbackText: `Attachment: ${result.name}`,
      });
      return result;
    }

    if (ext === '.docx') {
      const text = await parseDocx(buffer, result);
      setAttachmentText(result, text || `Attachment: ${result.name}`, {
        defaultLabel: 'Document',
        summary: buildEmbeddedImageSummary(result),
        fallbackText: `Attachment: ${result.name}`,
      });
      return result;
    }

    if (ext === '.pptx') {
      const deck = await parsePptx(buffer, result);
      setAttachmentText(result, deck.sections, {
        defaultLabel: 'Slide',
        summary: [deck.summary, buildEmbeddedImageSummary(result)].filter(Boolean).join(' '),
        fallbackText: `Attachment: ${result.name}`,
      });
      return result;
    }

    if (['.txt', '.md', '.csv', '.json', '.js', '.ts', '.jsx', '.tsx', '.html', '.css'].includes(ext)) {
      setAttachmentText(result, parsePlainText(buffer, ext), {
        defaultLabel: 'Text',
        fallbackText: `Attachment: ${result.name}`,
      });
      return result;
    }

    if (stats.size <= 1024 * 1024) {
      setAttachmentText(result, parsePlainText(buffer, ext), {
        defaultLabel: 'Text',
        fallbackText: `Attachment: ${result.name}`,
      });
      return result;
    }

    result.warning = `Unsupported attachment preview for ${result.name}.`;
    result.textContent = `Attachment: ${result.name} (${Math.round(result.sizeBytes / 1024)} KB)`;
    return result;
  } catch (error) {
    result.warning = `Could not parse ${result.name}: ${error.message}`;
    result.textContent = `Attachment: ${result.name}`;
    return result;
  }
}

async function parseAttachments(filePaths = []) {
  const parsed = [];
  for (const filePath of filePaths.slice(0, MAX_ATTACHMENT_FILES)) {
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }
    parsed.push(await parseAttachment(filePath));
  }
  return parsed;
}

module.exports = {
  parseAttachments,
};
