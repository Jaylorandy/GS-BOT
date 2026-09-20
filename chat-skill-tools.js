function uniq(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function getAttachmentText(attachment, maxChars = 28000) {
  if (!attachment) {
    return '';
  }

  if (Array.isArray(attachment.textChunks) && attachment.textChunks.length > 0) {
    let used = 0;
    const sections = [];

    for (const chunk of attachment.textChunks) {
      const body = chunk?.label ? `${chunk.label}\n${chunk.text || ''}` : String(chunk?.text || '');
      if (!body) {
        continue;
      }

      if (sections.length > 0 && used + body.length > maxChars) {
        break;
      }

      sections.push(body);
      used += body.length + 2;
    }

    return sections.join('\n\n');
  }

  return String(attachment.textContent || '');
}

function formatBytes(sizeBytes) {
  const size = Number(sizeBytes) || 0;
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${size} B`;
}

function getRelevantAttachments(attachments = [], extensions = [], categories = []) {
  return attachments.filter((attachment) => {
    const ext = String(attachment?.extension || '').toLowerCase();
    if (extensions.includes(ext)) {
      return true;
    }
    if (categories.includes('document') && ['.docx', '.pdf'].includes(ext)) {
      return true;
    }
    if (categories.includes('spreadsheet') && ['.xlsx', '.xls'].includes(ext)) {
      return true;
    }
    if (categories.includes('presentation') && ext === '.pptx') {
      return true;
    }
    return false;
  });
}

function buildAttachmentInventory(attachments = []) {
  if (attachments.length === 0) {
    return null;
  }

  const lines = attachments.map((attachment) => {
    const embedded = Array.isArray(attachment.embeddedImages) ? attachment.embeddedImages.length : 0;
    const suffix = [];
    if (attachment.isImage) {
      suffix.push('image');
    }
    if (embedded > 0) {
      suffix.push(`${embedded} embedded image${embedded > 1 ? 's' : ''}`);
    }

    return `${attachment.name} (${attachment.extension || 'file'}, ${formatBytes(attachment.sizeBytes)})${suffix.length > 0 ? ` · ${suffix.join(' · ')}` : ''}`;
  });

  return {
    name: 'attachment-inventory',
    summary: `Indexed ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}.`,
    content: `Attachment inventory:\n${lines.join('\n')}`,
  };
}

function buildSheetScan(attachments = []) {
  const spreadsheetFiles = getRelevantAttachments(attachments, ['.xlsx', '.xls'], ['spreadsheet']);
  if (spreadsheetFiles.length === 0) {
    return null;
  }

  const sections = spreadsheetFiles.map((attachment) => {
    const sheetNames = getAttachmentText(attachment)
      .split('\n')
      .filter((line) => line.startsWith('Sheet: '))
      .map((line) => line.replace(/^Sheet:\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 8);

    return `${attachment.name}: ${sheetNames.length > 0 ? sheetNames.join(', ') : 'Sheet preview unavailable'}`;
  });

  return {
    name: 'sheet-scan',
    summary: `Scanned ${spreadsheetFiles.length} spreadsheet attachment${spreadsheetFiles.length > 1 ? 's' : ''}.`,
    content: `Spreadsheet scan:\n${sections.join('\n')}`,
  };
}

function buildSlideScan(attachments = []) {
  const decks = getRelevantAttachments(attachments, ['.pptx'], ['presentation']);
  if (decks.length === 0) {
    return null;
  }

  const sections = decks.map((attachment) => {
    const slideLines = getAttachmentText(attachment)
      .split('\n')
      .filter((line) => /^Slide\s+\d+/i.test(line))
      .slice(0, 10);

    return `${attachment.name}: ${slideLines.length > 0 ? slideLines.join(' | ') : 'Slide preview unavailable'}`;
  });

  return {
    name: 'slide-scan',
    summary: `Scanned ${decks.length} presentation attachment${decks.length > 1 ? 's' : ''}.`,
    content: `Presentation scan:\n${sections.join('\n')}`,
  };
}

function extractLikelyHeadings(text = '') {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length <= 90)
    .filter((line) => /^[A-Z0-9][A-Za-z0-9 .,:/&()'-]{2,}$/.test(line))
    .slice(0, 10);
}

function buildSectionScan(attachments = []) {
  const docs = getRelevantAttachments(attachments, ['.docx', '.pdf'], ['document']);
  if (docs.length === 0) {
    return null;
  }

  const sections = docs.map((attachment) => {
    const headings = extractLikelyHeadings(getAttachmentText(attachment));
    return `${attachment.name}: ${headings.length > 0 ? headings.join(' | ') : 'Section headings not detected'}`;
  });

  return {
    name: 'section-scan',
    summary: `Scanned ${docs.length} document attachment${docs.length > 1 ? 's' : ''}.`,
    content: `Document section scan:\n${sections.join('\n')}`,
  };
}

function buildContractRiskScan(attachments = []) {
  const docs = getRelevantAttachments(attachments, ['.docx', '.pdf'], ['document']);
  if (docs.length === 0) {
    return null;
  }

  const clauses = [
    ['payment', /(payment|fees|invoice|billing)/i],
    ['termination', /(termination|terminate|survival)/i],
    ['liability', /(liability|damages|limitation of liability)/i],
    ['indemnity', /(indemn|hold harmless)/i],
    ['ip', /(intellectual property|ownership|license)/i],
    ['confidentiality', /(confidential|non-disclosure|nda)/i],
    ['governing law', /(governing law|jurisdiction|venue)/i],
  ];

  const sections = docs.map((attachment) => {
    const text = getAttachmentText(attachment);
    const found = clauses.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
    const missing = clauses.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label);
    return `${attachment.name}: found ${found.join(', ') || 'none'}${missing.length > 0 ? ` · missing ${missing.slice(0, 4).join(', ')}` : ''}`;
  });

  return {
    name: 'contract-risk-scan',
    summary: `Scanned ${docs.length} contract-style attachment${docs.length > 1 ? 's' : ''} for common clause areas.`,
    content: `Contract risk scan:\n${sections.join('\n')}`,
  };
}

function buildWebResultAudit(searchResult) {
  const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
  if (results.length === 0) {
    return null;
  }

  const coverage = searchResult?.coverage || {};
  const domains = uniq(results.map((result) => {
    try {
      return new URL(result.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })).slice(0, 8);

  const titles = results.slice(0, 5).map((result, index) => `[${index + 1}] ${result.title}`);
  return {
    name: 'web-result-audit',
    summary: `Reviewed ${results.length} web result${results.length > 1 ? 's' : ''}.`,
    content: [
      'Web result audit:',
      `Queries run: ${(searchResult?.queries || [searchResult?.query]).filter(Boolean).length}`,
      `Coverage: ${coverage.sufficient ? 'sufficient' : 'limited'}`,
      `Unique domains: ${coverage.uniqueDomainCount || 0}`,
      `Domains: ${domains.join(', ') || 'n/a'}`,
      titles.join('\n'),
    ].join('\n'),
  };
}

function buildSkillOutline(message = '') {
  const normalized = String(message || '').trim() || 'new skill';
  return {
    name: 'skill-outline',
    summary: 'Prepared a concrete skill pack outline.',
    content: [
      'Skill pack scaffold:',
      '- Files: skill.json, SKILL.md, optional assets/',
      '- Manifest fields: id, name, description, category, capabilities, triggers, attachmentTypes, execution',
      `- User request focus: ${normalized}`,
    ].join('\n'),
  };
}

function buildSkillRouter(executedSkills = []) {
  const routed = executedSkills.filter((skill) => skill.source === 'routed');
  if (routed.length === 0) {
    return null;
  }

  return {
    name: 'skill-router',
    summary: `Auto-routed ${routed.length} supporting skill${routed.length > 1 ? 's' : ''}.`,
    content: `Auto-routed skills:\n${routed.map((skill) => `${skill.name}: ${skill.reason}`).join('\n')}`,
  };
}

function buildKeywordScan(skill, message = '', attachments = []) {
  const haystack = `${message}\n${attachments.map((attachment) => getAttachmentText(attachment)).join('\n')}`.toLowerCase();
  const matches = (skill.triggers || [])
    .filter((trigger) => haystack.includes(String(trigger || '').toLowerCase()))
    .slice(0, 8);

  if (matches.length === 0) {
    return null;
  }

  return {
    name: 'keyword-scan',
    summary: `Matched ${matches.length} trigger keyword${matches.length > 1 ? 's' : ''} for ${skill.name}.`,
    content: `Keyword scan for ${skill.name}:\n${matches.join(', ')}`,
  };
}

const TOOL_RUNNERS = {
  'attachment-inventory': ({ attachments }) => buildAttachmentInventory(attachments),
  'sheet-scan': ({ attachments }) => buildSheetScan(attachments),
  'slide-scan': ({ attachments }) => buildSlideScan(attachments),
  'section-scan': ({ attachments }) => buildSectionScan(attachments),
  'contract-risk-scan': ({ attachments }) => buildContractRiskScan(attachments),
  'web-result-audit': ({ searchResult }) => buildWebResultAudit(searchResult),
  'skill-outline': ({ message }) => buildSkillOutline(message),
  'skill-router': ({ executedSkills }) => buildSkillRouter(executedSkills),
  'keyword-scan': ({ skill, message, attachments }) => buildKeywordScan(skill, message, attachments),
};

function runSkillTools({ executedSkills = [], attachments = [], message = '', searchResult = null }) {
  const outputs = [];
  const warnings = [];
  const seen = new Set();

  for (const skill of executedSkills) {
    const tools = Array.isArray(skill.tools) && skill.tools.length > 0
      ? skill.tools
      : ['attachment-inventory'];

    for (const toolName of tools) {
      const dedupeKey = `${skill.id}:${toolName}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const runner = TOOL_RUNNERS[toolName];
      if (!runner) {
        warnings.push(`Tool "${toolName}" is not available for ${skill.name}.`);
        continue;
      }

      try {
        const output = runner({
          skill,
          executedSkills,
          attachments,
          message,
          searchResult,
        });

        if (!output) {
          continue;
        }

        outputs.push({
          skillId: skill.id,
          skillName: skill.name,
          tool: toolName,
          summary: output.summary,
          content: output.content,
        });
      } catch (error) {
        warnings.push(`${skill.name} tool "${toolName}" failed: ${error.message}`);
      }
    }
  }

  return {
    outputs,
    warnings,
    usedTools: uniq(outputs.map((item) => item.tool)),
  };
}

function formatToolOutputs(toolOutputs = []) {
  if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
    return '';
  }

  return toolOutputs
    .map((item) => `Tool output for ${item.skillName} · ${item.tool}\n${item.content}`.trim())
    .join('\n\n')
    .slice(0, 14000);
}

module.exports = {
  formatToolOutputs,
  runSkillTools,
};
