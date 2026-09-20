const http = require('http');
const https = require('https');
const zlib = require('zlib');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

const SEARCH_ENDPOINTS = [
  (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  (query) => `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
];
const TAVILY_BASE_URL = 'https://api.tavily.com';

function uniqWarnings(items = []) {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeSearchFailureMessage(error) {
  const message = String(error?.message || '').trim();

  if (/secure TLS connection|EPROTO|ECONNRESET|SSL|CERT_/i.test(message)) {
    return 'Live web research could not reach the search provider from the current network. The report will continue with attachments and model knowledge.';
  }

  if (/timed out/i.test(message)) {
    return 'Live web research timed out before the search provider responded. The report will continue with the sources already available.';
  }

  if (/ENOTFOUND|EAI_AGAIN|network/i.test(message)) {
    return 'Live web research is temporarily unavailable. The report will continue with the sources already available.';
  }

  return 'Live web research could not complete during this run. The report will continue with the sources already available.';
}

function decodeHtmlEntities(input) {
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return String(input || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = String(entity).toLowerCase();
    if (normalized.startsWith('#x')) {
      const code = parseInt(normalized.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (normalized.startsWith('#')) {
      const code = parseInt(normalized.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entities[normalized] || match;
  });
}

function cleanText(input) {
  return decodeHtmlEntities(
    String(input || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function toAbsoluteUrl(rawUrl) {
  if (!rawUrl) {
    return '';
  }

  let value = decodeHtmlEntities(rawUrl).trim();

  if (value.startsWith('//')) {
    value = `https:${value}`;
  } else if (value.startsWith('/')) {
    value = `https://duckduckgo.com${value}`;
  }

  try {
    const parsed = new URL(value);
    if (parsed.hostname.includes('duckduckgo.com') && parsed.pathname === '/l/') {
      const target = parsed.searchParams.get('uddg') || parsed.searchParams.get('rut');
      if (target) {
        return decodeURIComponent(target);
      }
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function requestUrl(targetUrl, options = {}, redirectCount = 0) {
  const timeoutMs = options.timeoutMs || 12000;
  const maxBytes = options.maxBytes || 1024 * 1024 * 2;

  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch {
      reject(new Error(`Invalid URL: ${targetUrl}`));
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          ...DEFAULT_HEADERS,
          ...(options.headers || {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const statusCode = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          if (redirectCount >= 4) {
            reject(new Error('Too many redirects'));
            return;
          }
          const redirectedUrl = new URL(res.headers.location, url).toString();
          resolve(requestUrl(redirectedUrl, options, redirectCount + 1));
          return;
        }

        const chunks = [];
        let size = 0;

        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const encoding = String(res.headers['content-encoding'] || '').toLowerCase();

          const finalize = (decodedBuffer) => {
            resolve({
              statusCode,
              headers: res.headers,
              body: decodedBuffer.toString('utf8'),
            });
          };

          if (encoding.includes('gzip')) {
            zlib.gunzip(buffer, (error, decoded) => {
              if (error) {
                reject(error);
                return;
              }
              finalize(decoded);
            });
            return;
          }

          if (encoding.includes('br')) {
            zlib.brotliDecompress(buffer, (error, decoded) => {
              if (error) {
                reject(error);
                return;
              }
              finalize(decoded);
            });
            return;
          }

          if (encoding.includes('deflate')) {
            zlib.inflate(buffer, (error, decoded) => {
              if (error) {
                reject(error);
                return;
              }
              finalize(decoded);
            });
            return;
          }

          finalize(buffer);
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

function parseSearchResults(html, limit) {
  const results = [];
  const seenUrls = new Set();
  const anchorRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = anchorRegex.exec(html)) !== null && results.length < limit) {
    const url = toAbsoluteUrl(match[1]);
    if (!url || seenUrls.has(url)) {
      continue;
    }

    const nearbyHtml = html.slice(match.index, match.index + 1600);
    const snippetMatch = nearbyHtml.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    const title = cleanText(match[2]);
    const snippet = cleanText(snippetMatch?.[1] || '');

    if (!title) {
      continue;
    }

    seenUrls.add(url);
    results.push({
      title,
      url,
      snippet,
    });
  }

  return results;
}

function parseTavilyResults(payload = {}, limit = 8) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.slice(0, limit).map((result) => ({
    title: cleanText(result?.title || '') || result?.url || 'Untitled result',
    url: String(result?.url || '').trim(),
    snippet: cleanText(result?.content || '').slice(0, 900),
    excerpt: cleanText(result?.raw_content || result?.content || '').slice(0, 2200),
  })).filter((result) => result.url);
}

function inferTavilyTopic(query = '', options = {}) {
  if (options.topic === 'news') {
    return 'news';
  }

  const text = String(query || '').toLowerCase();
  if (/(latest|today|this week|breaking|news|current|实时|最新|今日)/i.test(text)) {
    return 'news';
  }

  return 'general';
}

function inferTavilySearchDepth(options = {}) {
  if (Number(options.minContextChars) > 12000 || Number(options.maxResults) > 10 || Number(options.fetchLimit) > 4) {
    return 'advanced';
  }

  return 'basic';
}

async function searchWithTavily(query, options = {}) {
  const apiKey = String(options.tavilyApiKey || '').trim();
  if (!apiKey) {
    return null;
  }

  const searchDepth = inferTavilySearchDepth(options);
  const body = {
    query: String(query || '').trim(),
    topic: inferTavilyTopic(query, options),
    search_depth: searchDepth,
    max_results: Math.max(1, Math.min(Number(options.resultLimit) || 8, 20)),
    include_answer: false,
    include_images: false,
    include_favicon: false,
    auto_parameters: false,
  };

  if (searchDepth === 'advanced') {
    body.chunks_per_source = 3;
    body.include_raw_content = 'text';
  }

  const requestBody = JSON.stringify(body);

  const response = await requestUrl(`${TAVILY_BASE_URL}/search`, {
    method: 'POST',
    timeoutMs: options.timeoutMs || 12000,
    maxBytes: 1024 * 1024 * 3,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody),
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    body: requestBody,
  });

  const payload = JSON.parse(response.body || '{}');
  if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
    throw new Error(payload?.error || payload?.detail || `Tavily request failed with status ${response.statusCode || 0}`);
  }

  const results = parseTavilyResults(payload, body.max_results);
  if (results.length === 0 && payload?.error) {
    throw new Error(payload.error);
  }

  return {
    query: String(query || '').trim(),
    results,
    warnings: [],
    failed: false,
    provider: 'tavily',
  };
}

function getResultDomain(result) {
  try {
    return new URL(result.url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function summarizeCoverage(results = []) {
  const uniqueDomains = [...new Set(results.map((result) => getResultDomain(result)).filter(Boolean))];
  const excerptResults = results.filter((result) => Boolean(result.excerpt)).length;
  const totalContextChars = results.reduce(
    (sum, result) => sum + String(result.snippet || '').length + String(result.excerpt || '').length,
    0,
  );

  return {
    resultCount: results.length,
    uniqueDomainCount: uniqueDomains.length,
    excerptResultCount: excerptResults,
    totalContextChars,
    uniqueDomains,
  };
}

function hasEnoughCoverage(coverage = {}, options = {}) {
  if (Number(options.minUniqueDomains) > 0 && Number(coverage.uniqueDomainCount) < Number(options.minUniqueDomains)) {
    return false;
  }
  if (Number(options.minExcerptResults) > 0 && Number(coverage.excerptResultCount) < Number(options.minExcerptResults)) {
    return false;
  }
  if (Number(options.minContextChars) > 0 && Number(coverage.totalContextChars) < Number(options.minContextChars)) {
    return false;
  }
  return true;
}

function mergeUniqueResults(existingResults = [], incomingResults = [], maxResults = 15) {
  const merged = [...existingResults];
  const seenUrls = new Set(existingResults.map((result) => result.url));

  for (const result of incomingResults) {
    if (!result?.url || seenUrls.has(result.url)) {
      continue;
    }

    merged.push(result);
    seenUrls.add(result.url);

    if (merged.length >= maxResults) {
      break;
    }
  }

  return merged;
}

function buildQueryVariants(query, options = {}) {
  const baseQuery = String(query || '').trim();
  const queryHints = Array.isArray(options.queryHints) ? options.queryHints : [];
  const variants = [baseQuery];

  for (const hint of queryHints) {
    const normalizedHint = String(hint || '').trim();
    if (!normalizedHint) {
      continue;
    }

    const candidate = `${baseQuery} ${normalizedHint}`.trim();
    if (!variants.includes(candidate)) {
      variants.push(candidate);
    }
  }

  return variants;
}

async function fetchPageExcerpt(result) {
  try {
    const response = await requestUrl(result.url, { timeoutMs: 9000, maxBytes: 1024 * 1024 });
    const contentType = String(response.headers['content-type'] || '');
    if (!contentType.includes('text/html')) {
      return result;
    }

    const titleMatch = response.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = cleanText(titleMatch?.[1] || '') || result.title;
    const excerpt = cleanText(response.body).slice(0, 2200);

    return {
      ...result,
      title: pageTitle,
      excerpt,
    };
  } catch {
    return result;
  }
}

async function searchSingleQuery(query, options = {}) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    return {
      query: '',
      results: [],
      warnings: ['Web search skipped because the query was empty.'],
    };
  }

  const resultLimit = Math.max(1, Math.min(Number(options.resultLimit) || 8, 18));
  const fetchLimit = Math.max(0, Math.min(Number(options.fetchLimit) || 3, 10));
  let lastError = null;

  if (options.tavilyApiKey) {
    try {
      const tavilyResult = await searchWithTavily(normalizedQuery, {
        ...options,
        resultLimit,
      });

      if (tavilyResult && tavilyResult.results.length > 0) {
        return tavilyResult;
      }
    } catch (error) {
      lastError = error;
    }
  }

  for (const buildUrl of SEARCH_ENDPOINTS) {
    try {
      const response = await requestUrl(buildUrl(normalizedQuery), { timeoutMs: 10000, maxBytes: 1024 * 1024 * 1.5 });
      const results = parseSearchResults(response.body, resultLimit);

      if (results.length === 0) {
        continue;
      }

      const enrichedResults = [];
      for (let index = 0; index < results.length; index += 1) {
        if (index < fetchLimit) {
          enrichedResults.push(await fetchPageExcerpt(results[index]));
        } else {
          enrichedResults.push(results[index]);
        }
      }

      return {
        query: normalizedQuery,
        results: enrichedResults,
        warnings: [],
        failed: false,
        provider: 'duckduckgo-html',
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    return {
      query: normalizedQuery,
      results: [],
      warnings: [normalizeSearchFailureMessage(lastError)],
      failed: true,
    };
  }

  return {
    query: normalizedQuery,
    results: [],
    warnings: ['No live web results were returned for this query.'],
    failed: false,
  };
}

async function searchWeb(query, options = {}) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    return {
      query: '',
      queries: [],
      results: [],
      warnings: ['Web search skipped because the query was empty.'],
      coverage: summarizeCoverage([]),
    };
  }

  const resultLimit = Math.max(1, Math.min(Number(options.resultLimit) || 8, 18));
  const fetchLimit = Math.max(0, Math.min(Number(options.fetchLimit) || 3, 10));
  const maxQueries = Math.max(1, Math.min(Number(options.maxQueries) || 1, 8));
  const maxResults = Math.max(resultLimit, Math.min(Number(options.maxResults) || resultLimit, 48));
  const maxFetch = Math.max(fetchLimit, Math.min(Number(options.maxFetch) || fetchLimit, 24));
  const adaptive = Boolean(
    options.adaptive
    || maxQueries > 1
    || Number(options.minUniqueDomains) > 0
    || Number(options.minExcerptResults) > 0
    || Number(options.minContextChars) > 0
    || (Array.isArray(options.queryHints) && options.queryHints.length > 0)
  );

  const queryVariants = buildQueryVariants(normalizedQuery, options).slice(0, maxQueries);
  let aggregatedResults = [];
  let warnings = [];
  const executedQueries = [];
  let failedQueryCount = 0;
  let provider = '';

  for (const currentQuery of queryVariants) {
    const remainingResults = Math.max(1, Math.min(resultLimit, maxResults - aggregatedResults.length));
    const currentCoverage = summarizeCoverage(aggregatedResults);
    const remainingFetch = Math.max(0, Math.min(fetchLimit, maxFetch - currentCoverage.excerptResultCount));

    const searchResult = await searchSingleQuery(currentQuery, {
      ...options,
      resultLimit: remainingResults,
      fetchLimit: remainingFetch,
    });

    executedQueries.push(currentQuery);
    if (searchResult.failed) {
      failedQueryCount += 1;
    }
    provider = provider || searchResult.provider || '';
    warnings = warnings.concat(searchResult.warnings || []);
    aggregatedResults = mergeUniqueResults(aggregatedResults, searchResult.results, maxResults);

    const coverage = summarizeCoverage(aggregatedResults);
    if (!adaptive || hasEnoughCoverage(coverage, options) || aggregatedResults.length >= maxResults) {
      return {
        query: normalizedQuery,
        queries: executedQueries,
        results: aggregatedResults,
        warnings: uniqWarnings(warnings),
        provider,
        coverage: {
          ...coverage,
          sufficient: hasEnoughCoverage(coverage, options),
        },
      };
    }
  }

  const finalCoverage = summarizeCoverage(aggregatedResults);
  if (adaptive && !hasEnoughCoverage(finalCoverage, options)) {
    if (aggregatedResults.length > 0) {
      warnings.push(
        `Live web research remained partial after ${executedQueries.length} search${executedQueries.length > 1 ? 'es' : ''}. The report blends the gathered sources with attachment-based analysis.`,
      );
    } else if (failedQueryCount > 0) {
      warnings.push('Live web research was unavailable during this run, so the report relied more heavily on attachments and model knowledge.');
    } else {
      warnings.push(
        `Live web research returned too little usable data after ${executedQueries.length} search${executedQueries.length > 1 ? 'es' : ''}. The report relied on the sources already available.`,
      );
    }
  }

  return {
    query: normalizedQuery,
    queries: executedQueries,
    results: aggregatedResults,
    warnings: uniqWarnings(warnings),
    provider,
    coverage: {
      ...finalCoverage,
      sufficient: hasEnoughCoverage(finalCoverage, options),
    },
  };
}

function formatWebContext(searchResult) {
  if (!searchResult || !Array.isArray(searchResult.results) || searchResult.results.length === 0) {
    return '';
  }

  const coverage = searchResult.coverage || summarizeCoverage(searchResult.results);
  const header = [
    `Provider: ${searchResult.provider || 'web'}`,
    `Research coverage: ${coverage.sufficient ? 'broad' : 'partial'}`,
    `Queries run: ${(searchResult.queries || [searchResult.query]).length}`,
    `Unique domains: ${coverage.uniqueDomainCount}`,
    `Excerpt results: ${coverage.excerptResultCount}`,
  ].join('\n');

  return [
    header,
    ...searchResult.results
    .map((result, index) => {
      const lines = [
        `[${index + 1}] ${result.title}`,
        `URL: ${result.url}`,
      ];

      if (result.snippet) {
        lines.push(`Snippet: ${result.snippet}`);
      }

      if (result.excerpt) {
        lines.push(`Page excerpt: ${result.excerpt}`);
      }

      return lines.join('\n');
    })
    ,
  ]
    .join('\n\n')
    .slice(0, 22000);
}

module.exports = {
  formatWebContext,
  searchSingleQuery,
  searchWeb,
  searchWithTavily,
};
