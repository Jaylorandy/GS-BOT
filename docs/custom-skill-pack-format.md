# Custom Skill Pack Format

`Chat Studio` can read custom skill metadata from `skill.json` or `SKILL.md` frontmatter.

## Recommended `skill.json`

```json
{
  "id": "industry-teardown",
  "name": "Industry Teardown",
  "description": "Analyze industry structure and competitor signals.",
  "category": "Research",
  "capabilities": ["industry-analysis", "web-research"],
  "triggers": ["industry", "competitor", "market map"],
  "attachmentTypes": [".pdf", ".pptx", "document"],
  "execution": {
    "actions": ["market-map", "signal-extraction"],
    "tools": ["attachment-inventory", "keyword-scan", "web-result-audit"],
    "prompt": "Structure the answer with market structure, competitors, signals, risks, and next actions.",
    "useWebSearch": "prefer",
    "searchProfile": {
      "resultLimit": 10,
      "fetchLimit": 5,
      "maxQueries": 4,
      "maxResults": 24,
      "maxFetch": 12,
      "minUniqueDomains": 8,
      "minExcerptResults": 8,
      "minContextChars": 7000,
      "queryHints": ["market size", "competitors", "industry trends", "outlook"]
    }
  }
}
```

## Supported fields

- `capabilities`: short tags shown in the UI and passed into execution planning
- `triggers`: keywords that let `find-skill` auto-route this skill
- `attachmentTypes`: attachment match rules such as `.pdf`, `.docx`, `.pptx`, `.xlsx`, `image`, `document`, `presentation`, `spreadsheet`, `pdf`
- `execution.actions`: action tags used in the execution plan
- `execution.tools`: local tool adapters to run before the model answers
- `execution.prompt`: extra execution guidance appended to the model context
- `execution.useWebSearch`: `off`, `prefer`, or `required`
- `execution.searchProfile.resultLimit`: preferred search result count
- `execution.searchProfile.fetchLimit`: preferred fetched-page count
- `execution.searchProfile.maxQueries`: maximum search rounds when coverage is still thin
- `execution.searchProfile.maxResults`: overall deduplicated result cap
- `execution.searchProfile.maxFetch`: overall fetched-page cap
- `execution.searchProfile.minUniqueDomains`: stop only after reaching this unique-domain count
- `execution.searchProfile.minExcerptResults`: stop only after reaching this many fetched page excerpts
- `execution.searchProfile.minContextChars`: stop only after collecting enough total snippet/excerpt text
- `execution.searchProfile.queryHints`: extra follow-up query suffixes for adaptive search

## Supported tool adapters

- `attachment-inventory`
- `keyword-scan`
- `sheet-scan`
- `slide-scan`
- `section-scan`
- `contract-risk-scan`
- `web-result-audit`
- `skill-outline`
- `skill-router`

## `SKILL.md` frontmatter fallback

If a pack only ships a `SKILL.md`, these fields can also be declared as comma-separated strings:

```md
---
name: Industry Teardown
description: Analyze industry structure and competitor signals.
capabilities: industry-analysis, web-research
triggers: industry, competitor, market map
attachment_types: .pdf, .pptx, document
execution_actions: market-map, signal-extraction
execution_tools: attachment-inventory, keyword-scan, web-result-audit
execution_prompt: Structure the answer with market structure, competitors, signals, risks, and next actions.
use_web_search: prefer
search_result_limit: 10
search_fetch_limit: 5
search_max_queries: 4
search_max_results: 24
search_max_fetch: 12
search_min_unique_domains: 8
search_min_excerpt_results: 8
search_min_context_chars: 7000
search_query_hints: market size, competitors, industry trends, outlook
---
```
