const ISSUE_SECTIONS = [
  {
    key: 'missingFront',
    label: (tx) => tx('Styles missing F', '缺少 F 的款'),
  },
  {
    key: 'missingBack',
    label: (tx) => tx('Styles missing B', '缺少 B 的款'),
  },
  {
    key: 'emptyLabels',
    label: (tx) => tx('Labels with no usable text', '标签识别为空'),
  },
  {
    key: 'skippedFiles',
    label: (tx) => tx('Skipped files', '被跳过的文件'),
  },
  {
    key: 'unchangedFiles',
    label: (tx) => tx('Files with no size reduction', '未缩小的文件'),
  },
];

function normalizeItems(items = []) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

export function buildCompletionIssues(issues = {}, tx = (en) => en) {
  if (!issues || typeof issues !== 'object') {
    return [];
  }

  return ISSUE_SECTIONS
    .map((section) => {
      const items = normalizeItems(issues?.[section.key]);
      if (!items.length) {
        return null;
      }

      return {
        key: section.key,
        title: section.label(tx),
        items,
      };
    })
    .filter(Boolean);
}
