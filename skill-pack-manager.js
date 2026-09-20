const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const JSZip = require('jszip');

const ROOT_DIR = path.join(os.homedir(), '.gsbot');
const SKILLS_DIR = path.join(ROOT_DIR, 'skills');

const DEFAULT_SKILLS = [
  {
    id: 'find-skill',
    name: 'find-skill',
    category: 'Routing',
    description: 'Find the best skill or workflow for the current request.',
    capabilities: ['routing', 'auto-select'],
    triggers: ['best skill', 'which skill', 'find a skill', 'workflow'],
    attachmentTypes: [],
    execution: {
      actions: ['routing', 'auto-select'],
      tools: ['skill-router'],
      prompt: 'State which installed skills are the best fit, and automatically include the relevant ones in the response plan.',
      useWebSearch: 'off',
      searchProfile: { resultLimit: 0, fetchLimit: 0 },
    },
    markdown: `---
name: find-skill
description: Match a user request to the most relevant installed skill and explain why it fits.
---

# Find Skill

Use this skill when the user needs help choosing the best installed skill or workflow.

## Workflow

1. Inspect the requested outcome, attachment types, and domain.
2. Suggest the 1-3 best matching skills.
3. Explain why each skill is relevant.
4. Call out missing capabilities when no installed skill is a strong fit.

## Output

- Best skill choice
- Why it matches
- Optional fallback skill
- Missing capability if one exists
`,
  },
  {
    id: 'skill-creator',
    name: 'skill-creator',
    category: 'Authoring',
    description: 'Create or refine reusable skill packs with clear structure and prompts.',
    capabilities: ['authoring', 'pack-structure'],
    triggers: ['create skill', 'build skill', 'new skill', 'workflow pack'],
    attachmentTypes: [],
    execution: {
      actions: ['skill-design', 'pack-structure'],
      tools: ['skill-outline'],
      prompt: 'When the user wants a new skill, produce a reusable package structure, manifest fields, instructions, and installation guidance.',
      useWebSearch: 'off',
      searchProfile: { resultLimit: 0, fetchLimit: 0 },
    },
    markdown: `---
name: skill-creator
description: Design or improve a reusable skill pack with concise instructions, references, and assets.
---

# Skill Creator

Use this skill when the user wants to create a new skill pack or improve an existing one.

## Workflow

1. Clarify the job the skill should do.
2. Define the smallest reusable workflow that solves it.
3. Keep instructions concise and procedural.
4. Recommend optional references, scripts, or assets only when they add value.

## Deliverables

- Skill purpose
- Suggested folder layout
- Core instructions
- Optional references or bundled assets
`,
  },
  {
    id: 'xlsx',
    name: 'Xlsx',
    category: 'Documents',
    description: 'Inspect spreadsheets, summarize sheets, and highlight formulas, anomalies, and trends.',
    capabilities: ['spreadsheet-analysis', 'tabular-review', 'artifact-excel'],
    triggers: ['excel', 'spreadsheet', 'workbook', 'sheet'],
    attachmentTypes: ['.xlsx', '.xls', 'spreadsheet'],
    execution: {
      actions: ['sheet-summary', 'anomaly-review'],
      tools: ['attachment-inventory', 'sheet-scan'],
      prompt: 'Use spreadsheet files as the primary evidence. Prepare the result so it can be exported as a real Excel workbook with clear sections, structured tables, and chart-ready numeric summaries.',
      useWebSearch: 'off',
      searchProfile: { resultLimit: 0, fetchLimit: 0 },
    },
    markdown: `---
name: Xlsx
description: Analyze spreadsheet attachments, summarize sheet structure, and extract key numeric findings.
---

# Xlsx

Use this skill when the user uploads Excel workbooks or asks for spreadsheet analysis.

## Focus

- Sheet overview
- Header and column interpretation
- Formula-heavy areas
- Outliers, totals, and trends
- Actionable next steps

## Output

- Workbook summary
- Sheet-by-sheet highlights
- Important metrics or anomalies
- Recommended follow-up checks
`,
  },
  {
    id: 'pptx',
    name: 'PPTX',
    category: 'Documents',
    description: 'Review slide decks, summarize structure, and extract talking points or rewrite ideas.',
    capabilities: ['slide-review', 'presentation-summary', 'artifact-ppt'],
    triggers: ['ppt', 'pptx', 'slides', 'deck', 'presentation'],
    attachmentTypes: ['.pptx', 'presentation'],
    execution: {
      actions: ['slide-summary', 'storyline-review'],
      tools: ['attachment-inventory', 'slide-scan'],
      prompt: 'Review slide decks slide by slide, summarize the storyline, and structure the answer so it can be exported into a presentation with slide titles, bullet points, tables, and chart-ready data.',
      useWebSearch: 'off',
      searchProfile: { resultLimit: 0, fetchLimit: 0 },
    },
    markdown: `---
name: PPTX
description: Read PowerPoint decks, summarize slide flow, and extract or improve key talking points.
---

# PPTX

Use this skill for slide decks, presentations, and pitch materials.

## Focus

- Slide storyline
- Repeated themes
- Weak or missing transitions
- Executive summary
- Rewrite opportunities

## Output

- Deck overview
- Slide flow summary
- Strong points
- Weak points
- Suggested revisions
`,
  },
  {
    id: 'docx',
    name: 'DOCX',
    category: 'Documents',
    description: 'Summarize Word documents, extract clauses, and prepare structured review notes.',
    capabilities: ['document-review', 'section-summary', 'artifact-word'],
    triggers: ['docx', 'word', 'document', 'report', 'brief'],
    attachmentTypes: ['.docx', '.pdf', 'document', 'pdf'],
    execution: {
      actions: ['section-summary', 'clause-extraction'],
      tools: ['attachment-inventory', 'section-scan'],
      prompt: 'Use document files as the primary evidence. Prepare the result as a formal Word-ready report with headings, concise paragraphs, bullet lists, and markdown tables wherever structured data should become a real table in the document.',
      useWebSearch: 'off',
      searchProfile: { resultLimit: 0, fetchLimit: 0 },
    },
    markdown: `---
name: DOCX
description: Analyze Word documents, summarize content, extract key sections, and support review workflows.
---

# DOCX

Use this skill for reports, briefs, contracts, and structured Word files.

## Focus

- Purpose of the document
- Section-by-section summary
- Key obligations or recommendations
- Missing or ambiguous language

## Output

- High-level summary
- Important clauses or sections
- Risks, gaps, or open questions
- Suggested next action
`,
  },
  {
    id: 'market-research-reports',
    name: 'Market-research-reports',
    category: 'Research',
    description: 'Create structured market research outputs with market size, competitors, risks, and opportunities.',
    capabilities: ['web-research', 'market-analysis'],
    triggers: ['market', 'competitor', 'industry', 'research', 'tam', 'sam', 'som', 'buyer'],
    attachmentTypes: ['.pdf', '.docx', '.pptx'],
    execution: {
      actions: ['market-analysis', 'web-research'],
      tools: ['attachment-inventory', 'web-result-audit'],
      prompt: 'Produce a professional market research report with maximum useful detail. Cover market definition, market size signals, customer segments, competitor landscape, positioning, pricing cues, demand drivers, risks, opportunities, and recommended next steps. If live research is incomplete, keep going with attachment evidence and model synthesis, but clearly distinguish verified evidence from inference.',
      useWebSearch: 'prefer',
      searchProfile: {
        resultLimit: 12,
        fetchLimit: 7,
        maxQueries: 6,
        maxResults: 36,
        maxFetch: 18,
        minUniqueDomains: 10,
        minExcerptResults: 10,
        minContextChars: 12000,
        queryHints: ['market size', 'customer segments', 'competitors', 'pricing', 'industry trends', 'outlook'],
      },
    },
    markdown: `---
name: Market-research-reports
description: Produce practical market research reports from notes, files, and user questions.
---

# Market Research Reports

Use this skill when the user wants a market snapshot, competitor review, or structured research report.

## Structure

- Market context
- Customer or buyer segments
- Competitor landscape
- Key signals, risks, and opportunities
- Recommended next actions

## Output

- Crisp executive summary
- Evidence-backed observations
- Clear assumptions
- Actionable recommendations
`,
  },
  {
    id: 'contract-review',
    name: 'Contract-review',
    category: 'Legal',
    description: 'Review contracts for risk, obligations, negotiation points, and missing protections.',
    capabilities: ['contract-review', 'risk-analysis'],
    triggers: ['contract', 'agreement', 'nda', 'msa', 'liability', 'indemnity', 'termination', 'clause'],
    attachmentTypes: ['.pdf', '.docx', 'document', 'pdf'],
    execution: {
      actions: ['clause-review', 'risk-analysis'],
      tools: ['attachment-inventory', 'contract-risk-scan'],
      prompt: 'Perform a contract review. Separate obligations, payment terms, liability, IP, termination, missing protections, and negotiation points.',
      useWebSearch: 'off',
      searchProfile: { resultLimit: 0, fetchLimit: 0 },
    },
    markdown: `---
name: Contract-review
description: Review contract language, flag risks, summarize obligations, and suggest negotiation points.
---

# Contract Review

Use this skill when the user uploads agreements or asks for clause-level review.

## Focus

- Obligations by party
- Payment and termination risk
- Liability, indemnity, and IP clauses
- Missing protections
- Negotiation priorities

## Output

- Executive summary
- Key risks
- Critical obligations
- Missing protections
- Negotiation suggestions
`,
  },
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeSkillId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill-pack';
}

function parseFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { data: {}, body: String(markdown || '') };
  }

  const data = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key) {
      data[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return {
    data,
    body: String(markdown || '').slice(match[0].length),
  };
}

function parseListValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAttachmentTypes(values = []) {
  return parseListValue(values).map((value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
      return '';
    }
    if (['image', 'spreadsheet', 'document', 'presentation', 'pdf'].includes(normalized)) {
      return normalized;
    }
    return normalized.startsWith('.') ? normalized : `.${normalized}`;
  }).filter(Boolean);
}

function normalizeUseWebSearch(value) {
  if (value === true || value === 'true' || value === 'required') {
    return value === true || value === 'true' ? 'required' : 'required';
  }
  if (value === 'prefer') {
    return 'prefer';
  }
  return 'off';
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readSkillExecutionConfig(manifest = {}, frontmatter = {}) {
  const manifestExecution = manifest.execution || {};
  const capabilities = parseListValue(manifest.capabilities || frontmatter.capabilities);
  const triggers = parseListValue(manifest.triggers || frontmatter.triggers);
  const attachmentTypes = normalizeAttachmentTypes(
    manifest.attachmentTypes
    || manifest.attachments
    || frontmatter.attachment_types
    || frontmatter.attachments
  );
  const actions = parseListValue(manifestExecution.actions || frontmatter.execution_actions);
  const tools = parseListValue(manifestExecution.tools || frontmatter.execution_tools);
  const prompt = String(manifestExecution.prompt || frontmatter.execution_prompt || '').trim();
  const useWebSearch = normalizeUseWebSearch(manifestExecution.useWebSearch || frontmatter.use_web_search);
  const resultLimit = normalizePositiveInteger(
    manifestExecution.searchProfile?.resultLimit || frontmatter.search_result_limit
  );
  const fetchLimit = normalizePositiveInteger(
    manifestExecution.searchProfile?.fetchLimit || frontmatter.search_fetch_limit
  );
  const maxQueries = normalizePositiveInteger(
    manifestExecution.searchProfile?.maxQueries || frontmatter.search_max_queries
  );
  const maxResults = normalizePositiveInteger(
    manifestExecution.searchProfile?.maxResults || frontmatter.search_max_results
  );
  const maxFetch = normalizePositiveInteger(
    manifestExecution.searchProfile?.maxFetch || frontmatter.search_max_fetch
  );
  const minUniqueDomains = normalizePositiveInteger(
    manifestExecution.searchProfile?.minUniqueDomains || frontmatter.search_min_unique_domains
  );
  const minExcerptResults = normalizePositiveInteger(
    manifestExecution.searchProfile?.minExcerptResults || frontmatter.search_min_excerpt_results
  );
  const minContextChars = normalizePositiveInteger(
    manifestExecution.searchProfile?.minContextChars || frontmatter.search_min_context_chars
  );
  const queryHints = parseListValue(
    manifestExecution.searchProfile?.queryHints || frontmatter.search_query_hints
  );

  return {
    capabilities,
    triggers,
    attachmentTypes,
    execution: {
      actions,
      tools,
      prompt,
      useWebSearch,
      searchProfile: {
        resultLimit,
        fetchLimit,
        maxQueries,
        maxResults,
        maxFetch,
        minUniqueDomains,
        minExcerptResults,
        minContextChars,
        queryHints,
      },
    },
  };
}

function readOpenAIYamlPreview(skillDir) {
  const yamlPath = path.join(skillDir, 'agents', 'openai.yaml');
  if (!fs.existsSync(yamlPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(yamlPath, 'utf8');
    const displayName = raw.match(/display_name:\s*(.+)/)?.[1]?.trim()?.replace(/^['"]|['"]$/g, '');
    const shortDescription = raw.match(/short_description:\s*(.+)/)?.[1]?.trim()?.replace(/^['"]|['"]$/g, '');
    return {
      displayName,
      shortDescription,
    };
  } catch {
    return {};
  }
}

function readSkillMetadataFromDirectory(skillDir) {
  const manifestPath = path.join(skillDir, 'skill.json');
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      manifest = {};
    }
  }

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  let skillMarkdown = '';
  let frontmatter = {};
  if (fs.existsSync(skillMdPath)) {
    skillMarkdown = fs.readFileSync(skillMdPath, 'utf8');
    frontmatter = parseFrontmatter(skillMarkdown).data;
  }

  const yamlPreview = readOpenAIYamlPreview(skillDir);
  const fallbackId = path.basename(skillDir);
  const id = sanitizeSkillId(manifest.id || frontmatter.name || fallbackId);
  const executionConfig = readSkillExecutionConfig(manifest, frontmatter);

  return {
    id,
    name: manifest.name || yamlPreview.displayName || frontmatter.name || fallbackId,
    description: manifest.description || yamlPreview.shortDescription || frontmatter.description || 'Skill pack',
    category: manifest.category || 'General',
    version: manifest.version || '1.0.0',
    capabilities: executionConfig.capabilities,
    triggers: executionConfig.triggers,
    attachmentTypes: executionConfig.attachmentTypes,
    execution: executionConfig.execution,
    defaultInstalled: Boolean(manifest.defaultInstalled),
    installedFrom: manifest.installedFrom || (manifest.defaultInstalled ? 'default' : 'manual'),
    installedAt: manifest.installedAt || '',
    path: skillDir,
    hasSkillMarkdown: Boolean(skillMarkdown),
  };
}

function writeDefaultSkill(skill) {
  const skillDir = path.join(SKILLS_DIR, skill.id);
  ensureDir(skillDir);

  const manifest = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    capabilities: Array.isArray(skill.capabilities) ? skill.capabilities : [],
    triggers: Array.isArray(skill.triggers) ? skill.triggers : [],
    attachmentTypes: Array.isArray(skill.attachmentTypes) ? skill.attachmentTypes : [],
    execution: skill.execution || {},
    version: '1.0.0',
    defaultInstalled: true,
    installedFrom: 'default',
    installedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(skillDir, 'skill.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.markdown.trim() + '\n', 'utf8');
}

function ensureDefaultSkillsInstalled() {
  ensureDir(SKILLS_DIR);
  for (const skill of DEFAULT_SKILLS) {
    writeDefaultSkill(skill);
  }
}

function listSkills() {
  ensureDefaultSkillsInstalled();
  const skills = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkillMetadataFromDirectory(path.join(SKILLS_DIR, entry.name)))
    .sort((left, right) => {
      if (left.defaultInstalled !== right.defaultInstalled) {
        return left.defaultInstalled ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  return skills;
}

function loadSkillInstructions(skillId) {
  ensureDefaultSkillsInstalled();
  const normalizedId = sanitizeSkillId(skillId);
  const skillDir = path.join(SKILLS_DIR, normalizedId);
  if (!fs.existsSync(skillDir)) {
    return null;
  }

  const metadata = readSkillMetadataFromDirectory(skillDir);
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const instructions = fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, 'utf8') : '';

  return {
    ...metadata,
    instructions,
  };
}

function copyRecursive(sourcePath, destinationPath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    ensureDir(destinationPath);
    for (const entry of fs.readdirSync(sourcePath)) {
      copyRecursive(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
    return;
  }

  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
}

function resolveSkillIdentity(fallbackName, manifest = {}, markdown = '') {
  const frontmatter = parseFrontmatter(markdown).data;
  const id = sanitizeSkillId(manifest.id || frontmatter.name || fallbackName);
  return {
    id,
    name: manifest.name || frontmatter.name || fallbackName,
    description: manifest.description || frontmatter.description || 'Imported skill pack',
    category: manifest.category || 'General',
  };
}

function normalizeNestedPath(nestedPath = '') {
  return String(nestedPath || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

async function installSkillFromZipBuffer(buffer, fallbackName = 'skill-pack', installedFrom = 'upload', nestedPath = '') {
  ensureDefaultSkillsInstalled();

  const zip = await JSZip.loadAsync(buffer);
  const rawEntries = Object.keys(zip.files).filter((entry) => !zip.files[entry].dir);
  if (rawEntries.length === 0) {
    throw new Error('The selected archive does not contain any files.');
  }

  const normalizedEntries = rawEntries.map((entry) => path.posix.normalize(entry).replace(/^\/+/, ''));
  const topLevel = normalizedEntries.map((entry) => entry.split('/')[0]).filter(Boolean);
  const commonRoot = topLevel.length > 0 && topLevel.every((value) => value === topLevel[0]) ? topLevel[0] : '';
  const stripPrefix = commonRoot && normalizedEntries.every((entry) => entry.startsWith(`${commonRoot}/`))
    ? `${commonRoot}/`
    : '';
  const nestedPrefix = normalizeNestedPath(nestedPath);

  let manifest = {};
  let markdown = '';
  for (const entry of normalizedEntries) {
    const strippedPath = stripPrefix ? entry.slice(stripPrefix.length) : entry;
    if (!strippedPath || strippedPath.startsWith('..')) {
      continue;
    }

    const relativePath = nestedPrefix
      ? (
        strippedPath === nestedPrefix
          ? ''
          : strippedPath.startsWith(`${nestedPrefix}/`)
            ? strippedPath.slice(nestedPrefix.length + 1)
            : null
      )
      : strippedPath;

    if (relativePath == null || !relativePath) {
      continue;
    }

    if (relativePath === 'skill.json') {
      manifest = JSON.parse(await zip.file(entry).async('string'));
    }
    if (relativePath === 'SKILL.md') {
      markdown = await zip.file(entry).async('string');
    }
  }

  const identity = resolveSkillIdentity(fallbackName, manifest, markdown);
  const skillDir = path.join(SKILLS_DIR, identity.id);
  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill "${identity.name}" is already installed.`);
  }

  if (!markdown && Object.keys(manifest).length === 0) {
    throw new Error('The selected package does not contain a detectable skill pack.');
  }

  for (const entry of normalizedEntries) {
    const strippedPath = stripPrefix ? entry.slice(stripPrefix.length) : entry;
    if (!strippedPath || strippedPath.startsWith('..')) {
      continue;
    }

    const relativePath = nestedPrefix
      ? (
        strippedPath === nestedPrefix
          ? ''
          : strippedPath.startsWith(`${nestedPrefix}/`)
            ? strippedPath.slice(nestedPrefix.length + 1)
            : null
      )
      : strippedPath;

    if (relativePath == null || !relativePath || relativePath.startsWith('..')) {
      continue;
    }

    const zipEntry = zip.file(entry);
    if (!zipEntry) {
      continue;
    }

    const destinationPath = path.join(skillDir, relativePath);
    ensureDir(path.dirname(destinationPath));
    const content = await zipEntry.async('nodebuffer');
    fs.writeFileSync(destinationPath, content);
  }

  const manifestPath = path.join(skillDir, 'skill.json');
  const finalManifest = {
    id: identity.id,
    name: identity.name,
    description: identity.description,
    category: identity.category,
    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
    triggers: Array.isArray(manifest.triggers) ? manifest.triggers : [],
    attachmentTypes: normalizeAttachmentTypes(manifest.attachmentTypes || manifest.attachments),
    execution: manifest.execution || {},
    version: manifest.version || '1.0.0',
    defaultInstalled: false,
    installedFrom,
    installedAt: new Date().toISOString(),
  };

  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8');
  }

  return readSkillMetadataFromDirectory(skillDir);
}

async function installSkillFromPath(sourcePath) {
  ensureDefaultSkillsInstalled();

  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('The selected skill package does not exist.');
  }

  const stat = fs.statSync(sourcePath);
  const ext = path.extname(sourcePath).toLowerCase();

  if (stat.isFile() && ext === '.zip') {
    return installSkillFromZipBuffer(fs.readFileSync(sourcePath), path.basename(sourcePath, ext), 'upload');
  }

  if (stat.isFile() && ext === '.md' && path.basename(sourcePath).toLowerCase() === 'skill.md') {
    const markdown = fs.readFileSync(sourcePath, 'utf8');
    const identity = resolveSkillIdentity(path.basename(path.dirname(sourcePath)), {}, markdown);
    const skillDir = path.join(SKILLS_DIR, identity.id);
    if (fs.existsSync(skillDir)) {
      throw new Error(`Skill "${identity.name}" is already installed.`);
    }
    ensureDir(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), markdown, 'utf8');
    fs.writeFileSync(
      path.join(skillDir, 'skill.json'),
      `${JSON.stringify({
        id: identity.id,
        name: identity.name,
        description: identity.description,
        category: identity.category,
        capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
        triggers: Array.isArray(manifest.triggers) ? manifest.triggers : [],
        attachmentTypes: normalizeAttachmentTypes(manifest.attachmentTypes || manifest.attachments),
        execution: manifest.execution || {},
        version: '1.0.0',
        defaultInstalled: false,
        installedFrom: 'upload',
        installedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      'utf8',
    );
    return readSkillMetadataFromDirectory(skillDir);
  }

  if (!stat.isDirectory()) {
    throw new Error('Please upload a skill folder, a .zip package, or a SKILL.md file.');
  }

  const manifestPath = path.join(sourcePath, 'skill.json');
  const markdownPath = path.join(sourcePath, 'SKILL.md');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const markdown = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, 'utf8') : '';

  const identity = resolveSkillIdentity(path.basename(sourcePath), manifest, markdown);
  const skillDir = path.join(SKILLS_DIR, identity.id);
  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill "${identity.name}" is already installed.`);
  }

  copyRecursive(sourcePath, skillDir);

  const finalManifestPath = path.join(skillDir, 'skill.json');
  if (!fs.existsSync(finalManifestPath)) {
    fs.writeFileSync(
      finalManifestPath,
      `${JSON.stringify({
        id: identity.id,
        name: identity.name,
        description: identity.description,
        category: identity.category,
        capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
        triggers: Array.isArray(manifest.triggers) ? manifest.triggers : [],
        attachmentTypes: normalizeAttachmentTypes(manifest.attachmentTypes || manifest.attachments),
        execution: manifest.execution || {},
        version: '1.0.0',
        defaultInstalled: false,
        installedFrom: 'upload',
        installedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      'utf8',
    );
  }

  return readSkillMetadataFromDirectory(skillDir);
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const request = lib.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadBuffer(nextUrl).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}.`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });

    request.on('error', (error) => reject(new Error(`Download failed: ${error.message}`)));
  });
}

async function downloadFirstAvailable(urls) {
  let lastError = null;

  for (const url of urls) {
    try {
      return { url, buffer: await downloadBuffer(url) };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Download failed.');
}

function parseGitHubSkillUrl(parsedUrl) {
  if (!/github\.com$/i.test(parsedUrl.hostname)) {
    return null;
  }

  const parts = parsedUrl.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const fallbackName = repo;

  if (parts[2] === 'tree' && parts[3]) {
    return {
      urls: [`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${parts[3]}`],
      fallbackName,
      nestedPath: parts.slice(4).join('/'),
    };
  }

  if (parts[2] === 'archive') {
    return {
      urls: [parsedUrl.toString()],
      fallbackName,
      nestedPath: '',
    };
  }

  return {
    urls: [
      `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/main`,
      `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/master`,
    ],
    fallbackName,
    nestedPath: '',
  };
}

async function installSkillFromUrl(url) {
  ensureDefaultSkillsInstalled();

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Please provide a valid skill package URL.');
  }

  const fileName = path.basename(parsedUrl.pathname || '') || 'skill-package.zip';
  const ext = path.extname(fileName).toLowerCase();

  if (ext === '.zip') {
    const buffer = await downloadBuffer(parsedUrl.toString());
    return installSkillFromZipBuffer(buffer, path.basename(fileName, ext), 'url');
  }

  const githubSource = parseGitHubSkillUrl(parsedUrl);
  if (!githubSource) {
    throw new Error('Use a .zip skill package URL or a GitHub repository / tree URL.');
  }

  const downloaded = await downloadFirstAvailable(githubSource.urls);
  const derivedName = path.basename(new URL(downloaded.url).pathname || '') || githubSource.fallbackName;
  const fallbackName = derivedName.replace(/\.zip$/i, '') || githubSource.fallbackName;

  return installSkillFromZipBuffer(
    downloaded.buffer,
    fallbackName,
    'url',
    githubSource.nestedPath,
  );
}

module.exports = {
  SKILLS_DIR,
  installSkillFromPath,
  installSkillFromUrl,
  listSkills,
  loadSkillInstructions,
};
