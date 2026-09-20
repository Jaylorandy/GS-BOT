const skillPackManager = require('./skill-pack-manager');

const BUILT_IN_IDS = new Set([
  'find-skill',
  'skill-creator',
  'xlsx',
  'pptx',
  'docx',
  'market-research-reports',
  'contract-review',
]);

function uniq(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function countByExtension(attachments = []) {
  return attachments.reduce((accumulator, attachment) => {
    const extension = String(attachment?.extension || '').toLowerCase();
    if (extension) {
      accumulator[extension] = (accumulator[extension] || 0) + 1;
    }
    if (attachment?.isImage) {
      accumulator.images = (accumulator.images || 0) + 1;
    }
    return accumulator;
  }, {});
}

function detectSignals(message = '', attachments = []) {
  const text = String(message || '').toLowerCase();
  const byExtension = countByExtension(attachments);

  return {
    text,
    byExtension,
    contractLike: /(contract|agreement|nda|msa|liability|indemn|termination|clause|governing law)/i.test(text),
    marketLike: /(market|competitor|industry|research|tam|sam|som|buyer|opportunity|landscape)/i.test(text),
    skillLike: /(skill|workflow|prompt pack|agent pack|create a skill|build a skill)/i.test(text),
    spreadsheetLike: /(xlsx|excel|spreadsheet|sheet|workbook|table)/i.test(text),
    presentationLike: /(ppt|pptx|presentation|slides|deck)/i.test(text),
    documentLike: /(docx|word|document|brief|report|memo|proposal)/i.test(text),
  };
}

function mergePrompts(...parts) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function routeAdditionalSkillIds(signals, installedIds, selectedIds) {
  const next = [];

  const push = (skillId) => {
    if (!installedIds.has(skillId) || selectedIds.has(skillId) || next.includes(skillId)) {
      return;
    }
    next.push(skillId);
  };

  if (signals.byExtension['.xlsx'] || signals.byExtension['.xls'] || signals.spreadsheetLike) {
    push('xlsx');
  }

  if (signals.byExtension['.docx'] || signals.documentLike) {
    push('docx');
  }

  if (signals.byExtension['.pptx'] || signals.presentationLike) {
    push('pptx');
  }

  if (signals.marketLike) {
    push('market-research-reports');
  }

  if (signals.contractLike || signals.byExtension['.pdf']) {
    push('contract-review');
  }

  if (signals.skillLike) {
    push('skill-creator');
  }

  return next;
}

function matchesAttachmentType(pattern, signals) {
  const normalized = String(pattern || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized === 'image') {
    return Boolean(signals.byExtension.images);
  }

  if (normalized === 'spreadsheet') {
    return Boolean(signals.byExtension['.xlsx'] || signals.byExtension['.xls']);
  }

  if (normalized === 'document') {
    return Boolean(signals.byExtension['.docx'] || signals.byExtension['.pdf']);
  }

  if (normalized === 'presentation') {
    return Boolean(signals.byExtension['.pptx']);
  }

  if (normalized === 'pdf') {
    return Boolean(signals.byExtension['.pdf']);
  }

  const extension = normalized.startsWith('.') ? normalized : `.${normalized}`;
  return Boolean(signals.byExtension[extension]);
}

function getSkillMatchSummary(skill, signals) {
  const triggerMatches = (skill.triggers || [])
    .filter((trigger) => signals.text.includes(String(trigger || '').toLowerCase()))
    .slice(0, 3);
  const attachmentMatches = (skill.attachmentTypes || [])
    .filter((pattern) => matchesAttachmentType(pattern, signals))
    .slice(0, 3);

  return {
    matched: triggerMatches.length > 0 || attachmentMatches.length > 0,
    triggerMatches,
    attachmentMatches,
  };
}

function routeManifestSkillIds(signals, installedSkills, selectedIds) {
  const matches = [];

  for (const skill of installedSkills) {
    if (!skill || selectedIds.has(skill.id) || BUILT_IN_IDS.has(skill.id)) {
      continue;
    }

    const summary = getSkillMatchSummary(skill, signals);
    if (!summary.matched) {
      continue;
    }

    matches.push({
      id: skill.id,
      score: summary.triggerMatches.length * 3 + summary.attachmentMatches.length,
    });
  }

  return matches
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 3)
    .map((item) => item.id);
}

function applyCustomOverrides(baseExecution, skill, matchSummary, webSearchEnabled) {
  const customActions = uniq([
    ...(baseExecution.actions || []),
    ...(skill.capabilities || []),
    ...(skill.execution?.actions || []),
  ]);
  const customTools = uniq([
    ...(baseExecution.tools || []),
    ...(skill.execution?.tools || []),
  ]);

  const reasons = [];
  if (matchSummary.triggerMatches.length > 0) {
    reasons.push(`keywords: ${matchSummary.triggerMatches.join(', ')}`);
  }
  if (matchSummary.attachmentMatches.length > 0) {
    reasons.push(`attachments: ${matchSummary.attachmentMatches.join(', ')}`);
  }

  let reason = baseExecution.reason;
  if (reasons.length > 0) {
    reason = `Matched ${reasons.join(' · ')}.`;
  }

  if (skill.execution?.useWebSearch === 'required') {
    reason = webSearchEnabled
      ? `${reason} Web research is required and available.`
      : `${reason} Web research is required by this skill but is currently unavailable.`;
  }

  return {
    ...baseExecution,
    actions: customActions.length > 0 ? customActions : ['prompt-guidance'],
    tools: customTools,
    reason,
    prompt: mergePrompts(baseExecution.prompt, skill.execution?.prompt),
  };
}

function buildSkillActions(skill, signals, webSearchEnabled) {
  const matchSummary = getSkillMatchSummary(skill, signals);
  const defaultExecution = {
    id: skill.id,
    name: skill.name,
    source: 'selected',
    actions: uniq([...(skill.capabilities || []), ...(skill.execution?.actions || []), 'prompt-guidance']),
    tools: uniq([...(skill.execution?.tools || [])]),
    reason: 'Loaded the selected skill instructions into the model context.',
    prompt: skill.execution?.prompt || '',
  };

  let execution;

  switch (skill.id) {
    case 'find-skill':
      execution = {
        ...defaultExecution,
        actions: ['routing', 'auto-select'],
        reason: 'Matched the request against installed skills and routed extra support when relevant.',
        prompt: 'If multiple skills are available, state which ones are being used and why each one is relevant.',
      };
      break;
    case 'xlsx':
      execution = signals.byExtension['.xlsx'] || signals.byExtension['.xls'] || signals.spreadsheetLike
        ? {
          ...defaultExecution,
          actions: ['sheet-summary', 'anomaly-review'],
          reason: 'Spreadsheet content was detected in the request or attachments.',
          prompt: 'Use spreadsheet attachments as primary evidence. Summarize sheet structure, notable tables, anomalies, trends, and next actions.',
        }
        : defaultExecution;
      break;
    case 'pptx':
      execution = signals.byExtension['.pptx'] || signals.presentationLike
        ? {
          ...defaultExecution,
          actions: ['slide-summary', 'storyline-review'],
          reason: 'Slide deck content was detected in the request or attachments.',
          prompt: 'Review the deck slide by slide, summarize the storyline, flag weak transitions, and suggest stronger framing where helpful.',
        }
        : defaultExecution;
      break;
    case 'docx':
      execution = signals.byExtension['.docx'] || signals.byExtension['.pdf'] || signals.documentLike
        ? {
          ...defaultExecution,
          actions: ['section-summary', 'clause-extraction'],
          reason: 'Document-style content was detected in the request or attachments.',
          prompt: 'Use attached documents as primary evidence. Summarize section by section, extract key clauses or recommendations, and call out ambiguity.',
        }
        : defaultExecution;
      break;
    case 'market-research-reports':
      execution = {
        ...defaultExecution,
        actions: webSearchEnabled ? ['market-analysis', 'web-research'] : ['market-analysis'],
        reason: webSearchEnabled
          ? 'Market research mode is active and web research is available.'
          : 'Market research mode is active and will use the attachments plus model knowledge.',
        prompt: 'Structure the answer as a professional market research report. Push for maximum useful detail: market definition, market size signals, segment structure, competitor map, positioning, pricing cues, demand drivers, constraints, risks, opportunities, and next actions. Separate verified evidence, synthesis, and assumptions.',
      };
      break;
    case 'contract-review':
      execution = signals.contractLike || signals.byExtension['.pdf'] || signals.byExtension['.docx']
        ? {
          ...defaultExecution,
          actions: ['clause-review', 'risk-analysis'],
          reason: 'Contract-like wording or attachments were detected.',
          prompt: 'Perform a contract review. Separate obligations, payment terms, liability, IP, termination, missing protections, and negotiation points.',
        }
        : defaultExecution;
      break;
    case 'skill-creator':
      execution = signals.skillLike
        ? {
          ...defaultExecution,
          actions: ['skill-design', 'pack-structure'],
          reason: 'The user is asking for a skill or workflow design.',
          prompt: 'When drafting a new skill, provide a concise pack structure, SKILL.md outline, skill.json fields, and installation guidance.',
        }
        : defaultExecution;
      break;
    default:
      execution = defaultExecution;
      break;
  }

  return applyCustomOverrides(execution, skill, matchSummary, webSearchEnabled);
}

function buildExecutionContext(executedSkills = []) {
  const sections = executedSkills
    .filter((skill) => skill.prompt)
    .map((skill) => `Skill execution: ${skill.name}\nReason: ${skill.reason}\nActions: ${skill.actions.join(', ')}\n${skill.prompt}`.trim());

  return sections.join('\n\n');
}

function buildSearchProfile(activeSkills = [], webSearchEnabled) {
  if (!webSearchEnabled) {
    return {
      resultLimit: 0,
      fetchLimit: 0,
      maxQueries: 0,
      maxResults: 0,
      maxFetch: 0,
      minUniqueDomains: 0,
      minExcerptResults: 0,
      minContextChars: 0,
      queryHints: [],
      adaptive: false,
    };
  }

  const ids = new Set(activeSkills.map((skill) => skill.id));
  const profile = ids.has('market-research-reports')
    ? {
      resultLimit: 12,
      fetchLimit: 7,
      maxQueries: 6,
      maxResults: 36,
      maxFetch: 18,
      minUniqueDomains: 10,
      minExcerptResults: 10,
      minContextChars: 12000,
      queryHints: ['market size', 'customer segments', 'competitors', 'pricing', 'industry trends', 'outlook'],
      adaptive: true,
    }
    : ids.has('contract-review')
      ? {
        resultLimit: 6,
        fetchLimit: 3,
        maxQueries: 1,
        maxResults: 6,
        maxFetch: 3,
        minUniqueDomains: 0,
        minExcerptResults: 0,
        minContextChars: 0,
        queryHints: [],
        adaptive: false,
      }
      : {
        resultLimit: 5,
        fetchLimit: 2,
        maxQueries: 1,
        maxResults: 5,
        maxFetch: 2,
        minUniqueDomains: 0,
        minExcerptResults: 0,
        minContextChars: 0,
        queryHints: [],
        adaptive: false,
      };

  for (const skill of activeSkills) {
    const executionProfile = skill.execution?.searchProfile || {};
    profile.resultLimit = Math.max(profile.resultLimit, Number(executionProfile.resultLimit) || 0);
    profile.fetchLimit = Math.max(profile.fetchLimit, Number(executionProfile.fetchLimit) || 0);
    profile.maxQueries = Math.max(profile.maxQueries, Number(executionProfile.maxQueries) || 0);
    profile.maxResults = Math.max(profile.maxResults, Number(executionProfile.maxResults) || 0);
    profile.maxFetch = Math.max(profile.maxFetch, Number(executionProfile.maxFetch) || 0);
    profile.minUniqueDomains = Math.max(profile.minUniqueDomains, Number(executionProfile.minUniqueDomains) || 0);
    profile.minExcerptResults = Math.max(profile.minExcerptResults, Number(executionProfile.minExcerptResults) || 0);
    profile.minContextChars = Math.max(profile.minContextChars, Number(executionProfile.minContextChars) || 0);
    profile.queryHints = uniq([...(profile.queryHints || []), ...(executionProfile.queryHints || [])]);
  }

  profile.maxResults = Math.max(profile.maxResults, profile.resultLimit);
  profile.maxFetch = Math.max(profile.maxFetch, profile.fetchLimit);
  profile.maxQueries = Math.max(profile.maxQueries, profile.adaptive ? 2 : 1);
  profile.adaptive = Boolean(
    profile.adaptive
    || profile.maxQueries > 1
    || profile.minUniqueDomains > 0
    || profile.minExcerptResults > 0
    || profile.minContextChars > 0
    || profile.queryHints.length > 0
  );

  return profile;
}

function prepareSkillExecution({ message = '', parsedAttachments = [], selectedSkillIds = [], webSearchEnabled = false }) {
  const selectedIds = uniq(selectedSkillIds);
  const selectedIdSet = new Set(selectedIds);
  const installedSkills = skillPackManager.listSkills();
  const installedIds = new Set(installedSkills.map((skill) => skill.id));
  const skillMap = new Map(installedSkills.map((skill) => [skill.id, skill]));
  const signals = detectSignals(message, parsedAttachments);

  const selectedSkills = selectedIds
    .map((skillId) => skillPackManager.loadSkillInstructions(skillId) || skillMap.get(skillId))
    .filter(Boolean);

  const routedBuiltInIds = selectedIdSet.has('find-skill')
    ? routeAdditionalSkillIds(signals, installedIds, selectedIdSet)
    : [];
  const routedManifestIds = selectedIdSet.has('find-skill')
    ? routeManifestSkillIds(signals, installedSkills, selectedIdSet)
    : [];
  const routedSkillIds = uniq([...routedBuiltInIds, ...routedManifestIds]);

  const routedSkills = routedSkillIds
    .map((skillId) => skillPackManager.loadSkillInstructions(skillId) || skillMap.get(skillId))
    .filter(Boolean);

  const activeSkills = [];
  const seenIds = new Set();
  for (const skill of [...selectedSkills, ...routedSkills]) {
    if (!skill || seenIds.has(skill.id)) {
      continue;
    }
    seenIds.add(skill.id);
    activeSkills.push(skill);
  }

  const executedSkills = activeSkills.map((skill) => {
    const execution = buildSkillActions(skill, signals, webSearchEnabled);
    if (routedSkillIds.includes(skill.id)) {
      return {
        ...execution,
        source: 'routed',
        reason: execution.reason === 'Loaded the selected skill instructions into the model context.'
          ? 'Automatically routed by find-skill based on the request and attachments.'
          : execution.reason,
      };
    }
    return execution;
  });

  const warnings = [];
  if (activeSkills.some((skill) => skill.id === 'market-research-reports') && !webSearchEnabled) {
    warnings.push('Market research skill ran without web access, so it relied on attachments and model knowledge only.');
  }

  for (const skill of activeSkills) {
    if (skill.execution?.useWebSearch === 'required' && !webSearchEnabled) {
      warnings.push(`${skill.name} requires web access for best results, but web search is currently off.`);
    }
  }

  return {
    activeSkills,
    routedSkillIds,
    executedSkills,
    executionContext: buildExecutionContext(executedSkills),
    searchProfile: buildSearchProfile(activeSkills, webSearchEnabled),
    warnings,
  };
}

module.exports = {
  prepareSkillExecution,
};
