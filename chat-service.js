const LLMClient = require('./llm-client');
const llmConfigManager = require('./llm-config');
const { parseAttachments } = require('./attachment-parser');
const webSearch = require('./web-search');
const skillEngine = require('./chat-skill-engine');
const skillTools = require('./chat-skill-tools');
const ragService = require('./rag-service');

const MAX_HISTORY_ITEMS = 10;
const MAX_SKILL_CONTEXT_CHARS = 12000;
const MAX_ATTACHMENT_CONTEXT_CHARS = 42000;
const MAX_ATTACHMENT_CHUNKS_PER_FILE = 6;
const MAX_ATTACHMENT_CHARS_PER_FILE = 16000;
const ATTACHMENT_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'any', 'are', 'around', 'been', 'before', 'being',
  'between', 'both', 'but', 'could', 'does', 'each', 'from', 'have', 'into', 'more', 'most',
  'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'under', 'using', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
]);
const FRESHNESS_PATTERN = /\b(latest|today|current|this year|this week|right now|weather|forecast|trend|trends|news|headline|headlines|breaking|update|updates|recent)\b|最新|今日|今天|今年|本周|最近|实时|天气|温度|气温|流行趋势|新闻|头条|快讯|资讯|动态/iu;
const WEATHER_PATTERN = /\b(weather|forecast|temperature|temperatures|rain|snow|storm|sunny|cloudy)\b|天气|温度|气温|降雨|下雨|下雪|暴雨|晴天|阴天|预报/iu;
const TREND_PATTERN = /\b(trend|trends|fashion trend|style trend|fashion|style|runway|collection|collections)\b|流行趋势|趋势|爆款|时尚|服装|穿搭|秀场|系列/iu;
const NEWS_PATTERN = /\b(news|headline|headlines|breaking|update|updates|latest news|current news)\b|新闻|头条|快讯|资讯|动态|最新消息/iu;

function uniqStrings(items = []) {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

function resolveChatConfig(fullConfig, wantsVision) {
  const config = llmConfigManager.mergeWithDefaults(fullConfig || llmConfigManager.loadConfig());

  if (config.mode === 'cloud') {
    return {
      mode: 'cloud',
      baseUrl: config.cloud.baseUrl,
      model: config.cloud.model,
      apiKey: config.cloud.apiKey,
      label: 'Cloud',
      isCloudBacked: true,
    };
  }

  if (config.mode === 'hybrid') {
    const route = wantsVision ? config.hybrid.extractionEndpoint : config.hybrid.analysisEndpoint;
    const useCloud = route === 'cloud';
    return {
      mode: 'hybrid',
      baseUrl: useCloud ? config.cloud.baseUrl : config.local.baseUrl,
      model: useCloud ? config.cloud.model : config.local.model,
      apiKey: useCloud ? config.cloud.apiKey : '',
      label: `Hybrid (${route})`,
      isCloudBacked: useCloud,
    };
  }

  return {
    mode: 'local',
    baseUrl: config.local.baseUrl,
    model: config.local.model,
    apiKey: '',
    label: 'Local',
    isCloudBacked: false,
  };
}

function serializeHistory(history = []) {
  return history
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .slice(-MAX_HISTORY_ITEMS)
    .map((item) => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${String(item.content || '').trim()}`)
    .join('\n');
}

function buildSkillContext(skills, executionContext = '') {
  const sections = [];
  let usedChars = 0;

  if (executionContext) {
    sections.push(`Execution plan:\n${executionContext}`);
    usedChars += executionContext.length;
  }

  for (const skill of skills) {
    const snippet = String(skill.instructions || '').trim();
    if (!snippet) {
      continue;
    }

    const section = `Skill: ${skill.name}\n${snippet}`;
    if (usedChars + section.length > MAX_SKILL_CONTEXT_CHARS) {
      break;
    }

    sections.push(section);
    usedChars += section.length;
  }

  return sections.join('\n\n');
}

function buildAttachmentKeywords(message = '', activeSkills = []) {
  const source = [
    message,
    ...activeSkills.flatMap((skill) => [
      skill?.name,
      ...(Array.isArray(skill?.triggers) ? skill.triggers : []),
    ]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const tokens = source.match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) || [];
  return [...new Set(tokens)]
    .filter((token) => token.length >= 2)
    .filter((token) => !ATTACHMENT_STOP_WORDS.has(token))
    .slice(0, 24);
}

function scoreAttachmentChunk(chunk, keywords = [], index = 0) {
  const haystack = `${chunk?.label || ''}\n${chunk?.text || ''}`.toLowerCase();
  let score = Math.max(0, 10 - index);

  for (const keyword of keywords) {
    if (haystack.includes(keyword)) {
      score += keyword.length >= 6 ? 6 : 3;
    }
  }

  return score;
}

function selectAttachmentChunks(attachment, keywords = [], options = {}) {
  const chunks = Array.isArray(attachment?.textChunks) && attachment.textChunks.length > 0
    ? attachment.textChunks.map((chunk, index) => ({ ...chunk, index }))
    : (attachment?.textContent
      ? [{ label: attachment.name, text: attachment.textContent, index: 0 }]
      : []);

  if (chunks.length === 0) {
    return { text: '', selectedCount: 0, totalCount: 0 };
  }

  const ranked = [...chunks].sort((left, right) => {
    const scoreDelta = scoreAttachmentChunk(right, keywords, right.index) - scoreAttachmentChunk(left, keywords, left.index);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return left.index - right.index;
  });

  const selected = [];
  let usedChars = 0;
  const maxChunks = options.maxChunks || MAX_ATTACHMENT_CHUNKS_PER_FILE;
  const maxChars = options.maxChars || MAX_ATTACHMENT_CHARS_PER_FILE;

  for (const chunk of ranked) {
    const body = chunk.label ? `${chunk.label}\n${chunk.text}` : chunk.text;
    if (!body) {
      continue;
    }

    if (selected.length >= maxChunks) {
      break;
    }

    if (selected.length > 0 && usedChars + body.length > maxChars) {
      continue;
    }

    selected.push(chunk);
    usedChars += body.length + 2;
  }

  const ordered = selected.sort((left, right) => left.index - right.index);
  const note = ordered.length < chunks.length
    ? `[Showing ${ordered.length} of ${chunks.length} indexed chunks for chat context]`
    : '';

  return {
    text: [...ordered.map((chunk) => (chunk.label ? `${chunk.label}\n${chunk.text}` : chunk.text)), note]
      .filter(Boolean)
      .join('\n\n'),
    selectedCount: ordered.length,
    totalCount: chunks.length,
  };
}

function buildAttachmentTextContext(attachments, { message = '', activeSkills = [] } = {}) {
  const sections = [];
  const keywords = buildAttachmentKeywords(message, activeSkills);
  let usedChars = 0;

  for (const attachment of attachments) {
    const remainingChars = MAX_ATTACHMENT_CONTEXT_CHARS - usedChars;
    if (remainingChars < 1200) {
      break;
    }

    if (!attachment.textContent && (!Array.isArray(attachment.textChunks) || attachment.textChunks.length === 0)) {
      continue;
    }

    const selection = selectAttachmentChunks(attachment, keywords, {
      maxChars: Math.min(MAX_ATTACHMENT_CHARS_PER_FILE, remainingChars),
    });
    if (!selection.text) {
      continue;
    }

    const headerBits = [`Attachment: ${attachment.name}`];
    if (selection.totalCount > 1) {
      headerBits.push(`${selection.totalCount} chunks indexed`);
    }
    if (Array.isArray(attachment.embeddedImages) && attachment.embeddedImages.length > 0) {
      headerBits.push(`${attachment.embeddedImages.length} embedded image${attachment.embeddedImages.length > 1 ? 's' : ''}`);
    }

    const section = `${headerBits.join(' · ')}\n${selection.text}`;
    sections.push(section);
    usedChars += section.length + 2;
  }

  return sections.join('\n\n');
}

function collectVisionImages(attachments) {
  const images = [];

  for (const attachment of attachments) {
    if (attachment.isImage && attachment.imageData) {
      images.push({
        data: attachment.imageData,
        mime: attachment.mimeType,
      });
    }

    if (Array.isArray(attachment.embeddedImages)) {
      for (const embeddedImage of attachment.embeddedImages) {
        if (!embeddedImage?.imageData || !embeddedImage?.mimeType) {
          continue;
        }

        images.push({
          data: embeddedImage.imageData,
          mime: embeddedImage.mimeType,
        });
      }
    }
  }

  return images;
}

function buildSystemPrompt(skillContext) {
  const parts = [
    'You are GS Bot Chat Studio, a practical assistant inside a desktop productivity app.',
    'Answer clearly and directly, using uploaded attachments and selected skill packs when they are relevant.',
    'If a selected skill is not relevant, ignore it instead of forcing it into the answer.',
    'Never copy replacement characters, garbled glyphs, or mojibake such as "�" into the final answer. If a phrase is obviously damaged but recoverable from context, repair it; otherwise omit the damaged glyphs and continue cleanly.',
    'Do not mention chat history, prior records, previous results, or earlier turns unless the user explicitly asks for continuation, comparison, or recap.',
    'Avoid phrases such as "上次记录结果", "根据历史记录", "previous result", or "based on prior conversation" in normal answers.',
    'When knowledge base references are provided, cite factual claims inline with square-bracket numbers such as [1] or [2]. Reuse only the provided reference numbers and keep each number next to the sentence it supports.',
  ];

  if (skillContext) {
    parts.push(`Selected skill packs:\n${skillContext}`);
  }

  return parts.join('\n\n');
}

function getCurrentDateFacts() {
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const year = now.getFullYear();
  const longDate = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return {
    year,
    isoDate,
    longDate,
  };
}

function isFreshnessCriticalQuery(message = '') {
  return FRESHNESS_PATTERN.test(String(message || '').trim());
}

function isWeatherQuery(message = '') {
  return WEATHER_PATTERN.test(String(message || '').trim());
}

function isNewsQuery(message = '') {
  return NEWS_PATTERN.test(String(message || '').trim());
}

function isTrendQuery(message = '') {
  return TREND_PATTERN.test(String(message || '').trim());
}

function requiresLiveWebEvidence(message = '') {
  const normalized = String(message || '').trim();
  if (!normalized) {
    return false;
  }

  return isFreshnessCriticalQuery(normalized)
    || isWeatherQuery(normalized)
    || isNewsQuery(normalized)
    || isTrendQuery(normalized);
}

function weatherQueryNeedsLocation(message = '') {
  if (!isWeatherQuery(message)) {
    return false;
  }

  const stripped = String(message || '')
    .toLowerCase()
    .replace(/\b(today|tomorrow|weather|forecast|temperature|temperatures|current|now|rain|snow|storm|sunny|cloudy)\b/gi, ' ')
    .replace(/今天|今日|明天|天气|温度|气温|预报|降雨|下雨|下雪|暴雨|晴天|阴天|实时/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  return stripped.length === 0;
}

function buildFreshSearchQuery(message = '', dateFacts = getCurrentDateFacts()) {
  let query = String(message || '').trim();
  if (!query) {
    return '';
  }

  query = query
    .replace(/今年/gu, ` ${dateFacts.year} `)
    .replace(/\bthis year\b/gi, ` ${dateFacts.year} `)
    .replace(/\bcurrent year\b/gi, ` ${dateFacts.year} `)
    .replace(/今天|今日/gu, ` ${dateFacts.isoDate} `)
    .replace(/\btoday\b/gi, ` ${dateFacts.isoDate} `)
    .replace(/\s+/g, ' ')
    .trim();

  if (isTrendQuery(query) && !/\b20\d{2}\b/.test(query)) {
    query = `${query} ${dateFacts.year}`.trim();
  }

  if (isWeatherQuery(query) && !/\b20\d{2}\b/.test(query)) {
    query = `${query} ${dateFacts.isoDate}`.trim();
  }

  if (isNewsQuery(query) && !/\b20\d{2}\b/.test(query)) {
    query = `${query} ${dateFacts.isoDate}`.trim();
  }

  return query;
}

function buildFreshSearchHints(message = '', dateFacts = getCurrentDateFacts()) {
  if (!requiresLiveWebEvidence(message)) {
    return [];
  }

  const hints = [dateFacts.isoDate, String(dateFacts.year)];
  const normalized = String(message || '').trim().toLowerCase();

  if (isTrendQuery(message)) {
    hints.push('fashion trends');
    hints.push(`spring summer ${dateFacts.year}`);
    hints.push(`fall winter ${dateFacts.year}`);
    hints.push(`fashion trends ${dateFacts.year}`);
  }

  if (isWeatherQuery(message)) {
    hints.push(`weather ${dateFacts.isoDate}`);
    hints.push(`forecast ${dateFacts.longDate}`);
    hints.push(`current weather ${dateFacts.isoDate}`);
  }

  if (isNewsQuery(message)) {
    hints.push(`news ${dateFacts.isoDate}`);
    hints.push(`latest headlines ${dateFacts.isoDate}`);
    hints.push(`breaking news ${dateFacts.isoDate}`);
  }

  if (/zara/i.test(normalized)) {
    hints.push(`zara ${dateFacts.year}`);
    hints.push(`zara fashion trends ${dateFacts.year}`);
  }

  return uniqStrings(hints);
}

function buildFreshnessInstruction(message = '', dateFacts = getCurrentDateFacts()) {
  if (!requiresLiveWebEvidence(message)) {
    return '';
  }

  const lines = [
    `Freshness requirement: today's date is ${dateFacts.longDate} (${dateFacts.isoDate}).`,
    `If the user asks about "today", "latest", "current", or "this year", interpret that using ${dateFacts.year} and do not answer with older dates unless you clearly label them as historical background.`,
  ];

  if (isTrendQuery(message)) {
    lines.push(`For trend questions, prefer ${dateFacts.year} evidence and current-season signals over prior-year summaries.`);
  }

  if (isWeatherQuery(message)) {
    lines.push('For weather questions, use only current-date conditions or ask for the city if no location is provided.');
  }

  if (isNewsQuery(message)) {
    lines.push('For news questions, answer only from current-date reporting and label anything older as background.');
  }

  return lines.join(' ');
}

function getArtifactSkillPreference(selectedSkillIds = [], activeSkills = []) {
  const skillById = new Map(activeSkills.map((skill) => [skill.id, skill]));
  const matches = [];

  for (const skillId of selectedSkillIds) {
    const skill = skillById.get(skillId);
    if (!skill) {
      continue;
    }

    const capabilities = Array.isArray(skill.capabilities) ? skill.capabilities : [];
    if (capabilities.includes('artifact-word')) {
      matches.push({ format: 'word', label: 'Word', skillName: skill.name, skillId });
      continue;
    }
    if (capabilities.includes('artifact-excel')) {
      matches.push({ format: 'excel', label: 'Excel', skillName: skill.name, skillId });
      continue;
    }
    if (capabilities.includes('artifact-ppt')) {
      matches.push({ format: 'ppt', label: 'PPT', skillName: skill.name, skillId });
    }
  }

  return {
    primary: matches[0] || null,
    all: matches,
  };
}

function buildArtifactInstruction(artifactPreference) {
  const target = artifactPreference?.primary;
  if (!target) {
    return '';
  }

  if (target.format === 'word') {
    return [
      'Primary deliverable: Word report.',
      'Write in a formal report structure that is ready for DOCX export.',
      'Include a strong executive summary, clear section headings, concise paragraphs, bullet lists, and markdown tables whenever information belongs in a real table.',
      'Prefer depth and completeness over brevity, and make the report feel client-ready rather than conversational.',
      'Avoid chatty filler and avoid saying "here is your report".',
    ].join(' ');
  }

  if (target.format === 'excel') {
    return [
      'Primary deliverable: Excel workbook.',
      'After a brief overview, produce clearly labeled markdown tables with consistent columns and raw numeric values whenever possible.',
      'Separate each table under its own heading, keep the data chart-ready for XLSX export, and include enough detail for a serious working file rather than a sketch.',
      'Follow tables with short analytical bullets instead of long prose.',
    ].join(' ');
  }

  if (target.format === 'ppt') {
    return [
      'Primary deliverable: PowerPoint deck.',
      'Structure the response as slide-ready sections using headings as slide titles.',
      'Keep each section presentation-friendly, but still substantial enough for a real deck instead of a thin outline.',
      'Use markdown tables for data slides and keep numeric summaries chart-ready for PPT export.',
    ].join(' ');
  }

  return '';
}

function wantsDeepReport(activeSkills = [], artifactPreference = null) {
  const ids = new Set(activeSkills.map((skill) => skill.id));

  return Boolean(
    artifactPreference?.primary
    || ids.has('market-research-reports')
    || ids.has('docx')
    || ids.has('xlsx')
    || ids.has('pptx')
  );
}

function buildDepthInstruction(activeSkills = [], artifactPreference = null) {
  if (!wantsDeepReport(activeSkills, artifactPreference)) {
    return '';
  }

  const ids = new Set(activeSkills.map((skill) => skill.id));
  const sections = [
    'Depth requirement: produce the most complete, detailed, and professional answer you can support with the available evidence.',
    'Use all relevant attachment context, tool outputs, and live web research when available.',
    'When information is incomplete, keep the report substantial by separating verified evidence, synthesis, and clearly labeled assumptions instead of stopping at a temporary outline.',
    'Do not label the report as temporary, provisional, or draft just because some live research is missing. Only mention remaining data gaps briefly in a short follow-up note when it materially matters.',
  ];

  if (ids.has('market-research-reports')) {
    sections.push(
      'For market research, prefer a full structure such as executive summary, market definition, size signals, customer segments, competitor landscape, positioning, pricing cues, growth drivers, risks, opportunities, and recommended next steps.',
    );
  }

  return sections.join(' ');
}

function sanitizeGeneratedText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\uFFFD{2,}/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/(^|\n)\s*(根据)?上次记录结果[:：，,\s-]*/g, '$1')
    .replace(/(^|\n)\s*根据历史记录[:：，,\s-]*/g, '$1')
    .replace(/(^|\n)\s*基于(?:之前|先前|上次)(?:对话|记录|结果)[:：，,\s-]*/g, '$1')
    .replace(/(^|\n)\s*(based on prior conversation|based on previous result|according to previous results?)[:：,\s-]*/gi, '$1')
    .replace(/\bprovisional (report|version)\b/gi, 'current report')
    .replace(/\btemporary (report|version)\b/gi, 'current report')
    .replace(/临时版本/g, '当前版本')
    .replace(/临时报告/g, '当前报告')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildNativeWebResearchPrompt({ message, activeSkills = [], artifactPreference = null }) {
  const ids = new Set(activeSkills.map((skill) => skill.id));
  const sections = [
    `Research the following request using native web search when available: ${String(message || '').trim()}`,
    'Return a concise research digest with: fresh findings, source names, notable numbers or facts, and unresolved gaps.',
  ];

  if (ids.has('market-research-reports')) {
    sections.push('Bias the research toward market size, customer segments, competitors, pricing, growth signals, and strategic implications.');
  }

  if (artifactPreference?.primary?.format === 'word') {
    sections.push('Organize the digest so it can support a detailed written report.');
  } else if (artifactPreference?.primary?.format === 'excel') {
    sections.push('Prioritize structured facts, numbers, comparable metrics, and table-ready details.');
  } else if (artifactPreference?.primary?.format === 'ppt') {
    sections.push('Prioritize concise slide-ready findings, comparisons, and key proof points.');
  }

  return sections.join(' ');
}

function filterWebWarnings(warnings = [], { nativeWebUsed = false } = {}) {
  if (!nativeWebUsed) {
    return warnings;
  }

  return warnings.filter((warning) => !/^Live web research /i.test(String(warning || '').trim()));
}

function buildUserPrompt({
  message,
  historyText,
  attachmentText,
  toolText,
  knowledgeText,
}) {
  const parts = [];

  if (historyText) {
    parts.push(`Conversation so far:\n${historyText}`);
  }

  if (knowledgeText) {
    parts.push(`Knowledge base context:\n${knowledgeText}`);
  }

  if (attachmentText) {
    parts.push(`Attachment context:\n${attachmentText}`);
  }

  if (toolText) {
    parts.push(`Tool outputs:\n${toolText}`);
  }

  parts.push(`Current user request:\n${String(message || '').trim()}`);
  return parts.join('\n\n');
}

function buildKnowledgeCitationGuide(references = []) {
  if (!Array.isArray(references) || references.length === 0) {
    return '';
  }

  return references.map((reference, index) => {
    const label = `[${index + 1}]`;
    const source = reference.relativePath || reference.path || 'Source';
    const anchor = reference.anchorLabel || `Chunk ${(reference.chunkIndex || 0) + 1}`;
    const quote = String(reference.quote || '').trim();

    return [
      `${label} ${source} · ${anchor}`,
      quote ? `Quoted passage:\n${quote}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

async function sendChatMessage({
  history = [],
  message = '',
  attachments = [],
  selectedSkillIds = [],
  webEnabled = false,
  knowledgeBase = {},
}) {
  const trimmedMessage = String(message || '').trim();
  if (!trimmedMessage) {
    return { success: false, error: 'Please enter a message.' };
  }

  const dateFacts = getCurrentDateFacts();
  if (weatherQueryNeedsLocation(trimmedMessage)) {
    return {
      success: true,
      message: `To answer today's weather accurately, tell me the city or area first. For example: "Shanghai weather today". Current date: ${dateFacts.longDate} (${dateFacts.isoDate}).`,
      warnings: [],
      usedSkills: [],
      executedSkills: [],
      routedSkills: [],
      usedTools: [],
      preferredExport: '',
      endpoint: 'Weather needs location',
      model: '',
      web: {
        enabled: false,
        automatic: false,
        results: 0,
        native: false,
      },
      knowledgeBase: {
        enabled: false,
        collectionId: '',
        collectionName: '',
        citations: [],
        references: [],
        results: 0,
      },
      attachments: [],
    };
  }

  const parsedAttachments = await parseAttachments(attachments);
  const visionImages = collectVisionImages(parsedAttachments);
  const wantsVision = visionImages.length > 0;
  const fullConfig = llmConfigManager.loadConfig();
  const resolvedConfig = resolveChatConfig(fullConfig, wantsVision);

  if (!resolvedConfig.baseUrl || !resolvedConfig.model) {
    return {
      success: false,
      error: 'Configure a model in Setup before using Chat Studio.',
    };
  }

  const client = new LLMClient({
    baseUrl: resolvedConfig.baseUrl,
    model: resolvedConfig.model,
    apiKey: resolvedConfig.apiKey,
  });

  const shouldUseWebSearch = resolvedConfig.isCloudBacked || Boolean(webEnabled);
  const freshnessCritical = shouldUseWebSearch && isFreshnessCriticalQuery(trimmedMessage);
  const liveWebRequired = shouldUseWebSearch && requiresLiveWebEvidence(trimmedMessage);
  const searchQuery = liveWebRequired ? buildFreshSearchQuery(trimmedMessage, dateFacts) : trimmedMessage;
  const skillPlan = skillEngine.prepareSkillExecution({
    message: trimmedMessage,
    parsedAttachments,
    selectedSkillIds,
    webSearchEnabled: shouldUseWebSearch,
  });

  const skillContext = buildSkillContext(skillPlan.activeSkills, skillPlan.executionContext);
  const artifactPreference = getArtifactSkillPreference(selectedSkillIds, skillPlan.activeSkills);
  const artifactInstruction = buildArtifactInstruction(artifactPreference);
  const depthInstruction = buildDepthInstruction(skillPlan.activeSkills, artifactPreference);
  const freshnessInstruction = buildFreshnessInstruction(trimmedMessage, dateFacts);
  const historyText = serializeHistory(history);
  const attachmentText = buildAttachmentTextContext(parsedAttachments, {
    message: trimmedMessage,
    activeSkills: skillPlan.activeSkills,
  });
  const warnings = parsedAttachments
    .map((attachment) => attachment.warning)
    .filter(Boolean);
  warnings.push(...skillPlan.warnings);

  let knowledgeContext = '';
  let knowledgeMeta = {
    enabled: false,
    collectionId: '',
    collectionName: '',
    citations: [],
    references: [],
    results: 0,
  };

  if (knowledgeBase?.enabled && knowledgeBase.collectionId) {
    try {
      const directKnowledgeAnswer = ragService.getDirectCollectionAnswer(knowledgeBase.collectionId, trimmedMessage);
      if (directKnowledgeAnswer) {
        return {
          success: true,
          message: sanitizeGeneratedText(String(directKnowledgeAnswer.answer || '').trim()) || 'No response was returned by the knowledge base.',
          warnings: [],
          usedSkills: skillPlan.executedSkills.map((skill) => skill.id),
          executedSkills: skillPlan.executedSkills,
          routedSkills: skillPlan.routedSkillIds,
          usedTools: [],
          preferredExport: artifactPreference.primary?.format || '',
          endpoint: 'Knowledge Base',
          model: directKnowledgeAnswer.provider || 'Inventory',
          web: {
            enabled: false,
            automatic: false,
            results: 0,
            native: false,
          },
          knowledgeBase: {
            enabled: true,
            collectionId: knowledgeBase.collectionId,
            collectionName: directKnowledgeAnswer.collection?.name || 'Knowledge Base',
            citations: directKnowledgeAnswer.citations || [],
            references: directKnowledgeAnswer.references || [],
            results: Array.isArray(directKnowledgeAnswer.retrieval) ? directKnowledgeAnswer.retrieval.length : 0,
          },
          attachments: parsedAttachments.map((attachment) => ({
            name: attachment.name,
            isImage: attachment.isImage,
            chunkCount: Array.isArray(attachment.textChunks) ? attachment.textChunks.length : 0,
            previewTruncated: Boolean(attachment.previewTruncated),
            embeddedImages: Array.isArray(attachment.embeddedImages) ? attachment.embeddedImages.length : 0,
          })),
        };
      }

      const knowledgeSearch = await ragService.searchCollection(knowledgeBase.collectionId, trimmedMessage, {
        topK: 8,
      });

      knowledgeContext = knowledgeSearch.promptContext || '';
      knowledgeMeta = {
        enabled: true,
        collectionId: knowledgeBase.collectionId,
        collectionName: knowledgeSearch.collection?.name || 'Knowledge Base',
        citations: uniqStrings(
          (knowledgeSearch.results || []).map((item) => item.relativePath || item.name),
        ).slice(0, 12),
        references: Array.isArray(knowledgeSearch.references) ? knowledgeSearch.references.slice(0, 8) : [],
        results: Array.isArray(knowledgeSearch.results) ? knowledgeSearch.results.length : 0,
      };

      const citationGuide = buildKnowledgeCitationGuide(knowledgeMeta.references);
      if (citationGuide) {
        knowledgeContext = [
          'Knowledge reference map:',
          citationGuide,
          knowledgeContext,
        ].filter(Boolean).join('\n\n');
      }

      if (!knowledgeContext) {
        warnings.push(`No relevant indexed context was found in ${knowledgeMeta.collectionName}.`);
      }
    } catch (error) {
      return {
        success: false,
        error: `Knowledge base search failed: ${error.message}`,
      };
    }
  }

  if (artifactPreference.all.length > 1) {
    warnings.push(
      `Multiple file-output skills were selected. ${artifactPreference.primary.label} is being used as the primary export format.`,
    );
  }

  let webContext = '';
  let nativeWebContext = '';
  let searchResult = null;
  let agentToolUsage = [];
  let webContextMeta = {
    enabled: shouldUseWebSearch,
    automatic: resolvedConfig.isCloudBacked,
    results: 0,
    native: false,
  };
  const prefersDeepOutput = wantsDeepReport(skillPlan.activeSkills, artifactPreference);
  const baseMaxTokens = prefersDeepOutput
    ? (artifactPreference.primary?.format === 'ppt' ? 2600 : 3400)
    : 1800;
  const generationOptions = {
    temperature: prefersDeepOutput ? 0.35 : 0.4,
    maxTokens: wantsVision ? Math.min(baseMaxTokens, 3000) : baseMaxTokens,
  };
  const cloudSearchPreferenceEnabled = fullConfig.cloud?.nativeWebSearch !== false;
  const cloudSearchClientAvailable = Boolean(fullConfig.cloud?.baseUrl && fullConfig.cloud?.apiKey);
  const cloudSearchClient = cloudSearchClientAvailable
    ? new LLMClient({
      baseUrl: fullConfig.cloud.baseUrl,
      model: fullConfig.cloud.model || 'qwen3',
      apiKey: fullConfig.cloud.apiKey,
    })
    : null;
  const nativeWebEnabled = resolvedConfig.isCloudBacked && cloudSearchPreferenceEnabled && !liveWebRequired;
  const localToolBridgePossible =
    shouldUseWebSearch
    && !resolvedConfig.isCloudBacked
    && cloudSearchPreferenceEnabled
    && Boolean(cloudSearchClient)
    && !wantsVision;
  const localToolAgentEnabled = localToolBridgePossible && client.supportsTools();

  if (localToolBridgePossible && !localToolAgentEnabled) {
    warnings.push('Current local model does not support tool-based cloud search, so GS BOT is using software-side web retrieval instead.');
  }

  if (localToolAgentEnabled) {
    const agentResult = await client.runWebToolAgent(
      buildNativeWebResearchPrompt({
        message: trimmedMessage,
        activeSkills: skillPlan.activeSkills,
        artifactPreference,
      }),
      {
        searchClient: cloudSearchClient,
        maxTokens: prefersDeepOutput ? 1400 : 900,
        temperature: 0.2,
        maxIterations: 4,
      },
    );

    if (agentResult?.success && agentResult.text && Array.isArray(agentResult.usedTools) && agentResult.usedTools.length > 0) {
      nativeWebContext = agentResult.text;
      agentToolUsage = agentResult.usedTools;
      webContextMeta.native = true;
      webContextMeta.nativeMethod = 'local-agent:ollama-cloud-tools';
      warnings.push('Local model used Ollama Cloud web_search/web_fetch tools for live research.');
    }
  }

  if (nativeWebEnabled && shouldUseWebSearch) {
    const nativeWebResult = await client.researchWithNativeWeb(
      buildNativeWebResearchPrompt({
        message: searchQuery,
        activeSkills: skillPlan.activeSkills,
        artifactPreference,
      }),
      {
        maxTokens: prefersDeepOutput ? 1400 : 900,
        temperature: 0.2,
      },
    );

    if (nativeWebResult?.success && nativeWebResult.text) {
      nativeWebContext = nativeWebResult.text;
      webContextMeta.native = true;
      webContextMeta.nativeMethod = nativeWebResult.method || '';
    }
  }

  if (shouldUseWebSearch && (!nativeWebContext || prefersDeepOutput || freshnessCritical || liveWebRequired)) {
    searchResult = await webSearch.searchWeb(searchQuery, {
      resultLimit: skillPlan.searchProfile.resultLimit || (resolvedConfig.isCloudBacked ? 8 : 5),
      fetchLimit: skillPlan.searchProfile.fetchLimit || (resolvedConfig.isCloudBacked ? 4 : 2),
      maxQueries: skillPlan.searchProfile.maxQueries,
      maxResults: skillPlan.searchProfile.maxResults,
      maxFetch: skillPlan.searchProfile.maxFetch,
      minUniqueDomains: skillPlan.searchProfile.minUniqueDomains,
      minExcerptResults: skillPlan.searchProfile.minExcerptResults,
      minContextChars: skillPlan.searchProfile.minContextChars,
      queryHints: uniqStrings([
        ...(Array.isArray(skillPlan.searchProfile.queryHints) ? skillPlan.searchProfile.queryHints : []),
        ...buildFreshSearchHints(trimmedMessage, dateFacts),
      ]),
      adaptive: skillPlan.searchProfile.adaptive,
      tavilyApiKey: fullConfig.cloud?.tavilyApiKey || '',
    });
    webContext = webSearch.formatWebContext(searchResult);
    warnings.push(...(searchResult.warnings || []));
    webContextMeta = {
      ...webContextMeta,
      enabled: shouldUseWebSearch,
      automatic: resolvedConfig.isCloudBacked,
      results: searchResult.results.length,
      provider: searchResult.provider || '',
    };
  }

  const toolResult = skillTools.runSkillTools({
    executedSkills: skillPlan.executedSkills,
    attachments: parsedAttachments,
    message: trimmedMessage,
    searchResult,
  });
  const toolContext = skillTools.formatToolOutputs(toolResult.outputs);
  warnings.push(...(toolResult.warnings || []));

  const finalWarnings = uniqStrings(filterWebWarnings(warnings, { nativeWebUsed: Boolean(nativeWebContext) })).slice(0, 4);

  try {
    let responseText = '';
    const effectiveNativeWebContext = (freshnessCritical || liveWebRequired) && webContext ? '' : nativeWebContext;
    const combinedWebContext = [
      webContext ? `${liveWebRequired ? 'Fresh live web research' : 'Supplemental web research'}:\n${webContext}` : '',
      effectiveNativeWebContext ? `Native cloud web research:\n${effectiveNativeWebContext}` : '',
    ].filter(Boolean).join('\n\n');

    if (wantsVision && client.supportsVision()) {
      responseText = await client.generateWithImages(
        `${buildSystemPrompt([
          skillContext,
          freshnessInstruction ? `Freshness guidance:\n${freshnessInstruction}` : '',
          artifactInstruction ? `Delivery format guidance:\n${artifactInstruction}` : '',
          depthInstruction ? `Depth guidance:\n${depthInstruction}` : '',
        ].filter(Boolean).join('\n\n'))}\n\n${buildUserPrompt({
          message: trimmedMessage,
          historyText,
          knowledgeText: knowledgeContext,
          attachmentText: [
            attachmentText,
            combinedWebContext,
          ].filter(Boolean).join('\n\n'),
          toolText: toolContext,
        })}`,
        visionImages,
        generationOptions,
      );
    } else {
      if (wantsVision && !client.supportsVision()) {
        finalWarnings.push('The current model does not advertise vision support, so attached and embedded images were passed as text context only.');
      }

      responseText = await client.chat(
        [
          {
            role: 'system',
            content: buildSystemPrompt([
              skillContext,
              freshnessInstruction ? `Freshness guidance:\n${freshnessInstruction}` : '',
              artifactInstruction ? `Delivery format guidance:\n${artifactInstruction}` : '',
              depthInstruction ? `Depth guidance:\n${depthInstruction}` : '',
            ].filter(Boolean).join('\n\n')),
          },
          ...history
            .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && item.content)
            .slice(-MAX_HISTORY_ITEMS)
            .map((item) => ({ role: item.role, content: String(item.content) })),
          {
            role: 'user',
            content: buildUserPrompt({
              message: trimmedMessage,
              historyText: '',
              knowledgeText: knowledgeContext,
              attachmentText: [
                attachmentText,
                combinedWebContext,
              ].filter(Boolean).join('\n\n'),
              toolText: toolContext,
            }),
          },
        ],
        generationOptions,
      );
    }

    return {
      success: true,
      message: sanitizeGeneratedText(String(responseText || '').trim()) || 'No response was returned by the model.',
      warnings: uniqStrings(finalWarnings).slice(0, 4),
      usedSkills: skillPlan.executedSkills.map((skill) => skill.id),
      executedSkills: skillPlan.executedSkills,
      routedSkills: skillPlan.routedSkillIds,
      usedTools: uniqStrings([...(toolResult.usedTools || []), ...agentToolUsage]),
      preferredExport: artifactPreference.primary?.format || '',
      endpoint: resolvedConfig.label,
      model: resolvedConfig.model,
      web: webContextMeta,
      knowledgeBase: knowledgeMeta,
      attachments: parsedAttachments.map((attachment) => ({
        name: attachment.name,
        isImage: attachment.isImage,
        chunkCount: Array.isArray(attachment.textChunks) ? attachment.textChunks.length : 0,
        previewTruncated: Boolean(attachment.previewTruncated),
        embeddedImages: Array.isArray(attachment.embeddedImages) ? attachment.embeddedImages.length : 0,
      })),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Chat request failed.',
      warnings: uniqStrings(finalWarnings).slice(0, 4),
    };
  }
}

module.exports = {
  sendChatMessage,
};
