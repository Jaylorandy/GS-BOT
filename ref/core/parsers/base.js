/**
 * ref/core/parsers/base.js — 公共基类：行级字段提取、Token 流
 * （复刻 Purchase Order Extractor V2 core/parsers/base.py）
 *
 * 逆向来源：core__parsers__base.txt（138 字符串 dump）+ probe_parsers*.json
 *
 * 核心抽象：
 *   Token      — PDF/OCR 产出的最小文本单元（text + bbox + page）
 *   PageWords  — 一页的全部 token，提供 lines()（按 y 中心分组为视觉行）和 text()
 *   BaseParser — 所有 17 个解析器的公共基类（channel 解析、ship_mode 归一等）
 *
 * 设计要点（probe 锁定）：
 *   - Token.is_number()：纯数字（含逗号/小数点）→ true，含字母/连字符 → false
 *   - PageWords.lines()：按 yc（y 中心）邻近度分组，组内按 x0 排序
 *   - _to_int：剥离逗号 → int(float(x)) 截断（'3,000'→3000, '5.7'→5, 'abc'→0）
 *   - _to_float：逗号→小数点（欧式）→ float（'12,50'→12.5, '3,000'→3.0）
 *   - _looks_like_style：2-16 字母数字+[-./_]，拒绝纯数字/数字-数字
 *   - _looks_like_sku：含数字或含非字母字符（比 _looks_like_style 宽松，接受纯数字）
 *   - norm_date：dd.mm.yyyy / dd.mm.yy → YYYY-MM-DD；失败原样返回
 *   - _SHIP_MAP：VESSEL/SEA/OCEAN→Sea, AIR→Air
 *   - extract_color_from_combined：右剥产品名 → 左剥 SKU 代码 → 保留颜色描述
 */

'use strict';

// ============================================================================
// 常量与正则
// ============================================================================

/** 尺码 token 正则（XS/S/M/L/XL 及数字尺码 30/31/32/34-36 等） */
const SIZE_TOKEN = /^(?:\d{1,3}(?:[./-]\d{1,3})?|X{0,4}S|M|X{0,4}L)$/;

/** TJX Import 风格合并行的 item 标记：N-N 或 N/N 后跟 STYLECODE */
const _COMBINED_ITEM = /(?<!\S)(\d+[/-]\d+)\s+([A-Z]{1,3}\d{3,})/;

/** 价格正则：N.NN 形式 */
const _PRICE_RE = /^\d+\.\d{2}$/;

/** 合理款号正则：2-16 字母数字+[-./_]，排除纯数字 */
const _STYLE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9\-./_]{1,15}$/;

/** TJX 标签行正则（Label: 形式） */
const _TJX_LABEL = /^[A-Z][A-Za-z0-9 .&/#'()-]*:/;

/** TJX 行号前缀正则 */
const _TJX_LINE_NO = /^\d+\s/;

/** TJX item 标记正则：N-N 或 N/N 后跟空格 */
const _TJX_MARKER = /^\d{1,2}[-/]\d{1,2}\s/;

/** TJX 独立噪声行正则（PURCHASE, Page, VENDOR 等标题/页脚/说明行） */
const _TJX_STANDALONE = /^(?:PURCHASE|Page|VENDOR|VAT|REGNO|DEPTNO|THE CONTRACT|THIS PURCHASE|PLEASE|TJX|BUYER|FOR EVERY|GENERAL|YOU CAN|INDIVIDUAL|TO AVOID|STEP|IN ADDITION|FULL|BOOKING|UPLOADING|PLEASE NOTE|FOR IN DEPTH|ANY INFORMATION|IF YOU|DOCUMENTATION|PACKING|GENERAL LOGISTICS)/;

/** TOTAL 关键词正则 */
const _TOTAL_KW = /TOTAL|GRAND|SUBTOTAL|SUM\b|合计|小计|总计/;

/** TJX UK Vendor 首行标记：数字 + 空格 + 大写字母 */
const _UK_LEAD = /^\d{1,2}\s+[A-Z]/;

/** 序号正则（纯数字或数字-数字形式，用于排除序号 vs 款号） */
const _SEQ_NUM_RE = /\d+|\d+[\-./]\d+/;

/** 页脚边距（行数） */
const _FOOTER_MARGIN = 2;

/** 运输方式映射 */
const _SHIP_MAP = {
  'VESSEL': 'Sea', 'BY SEA': 'Sea', 'SEA': 'Sea', 'OCEAN': 'Sea', 'BY OCEAN': 'Sea',
  'AIR': 'Air', 'BY AIR': 'Air', 'AIR FREIGHT': 'Air',
};

/** 已知产品名词（用于从颜色描述中剥离） */
const _PRODUCT_NAME_PATTERNS = [
  'jeans', 'jean', 'shirt', 't-shirt', 'tee', 'polo', 'sweater', 'hoodie',
  'jacket', 'coat', 'blazer', 'vest', 'cardigan', 'pullover', 'trousers',
  'pant', 'pants', 'short', 'shorts', 'skirt', 'dress', 'jumpsuit', 'overall',
  'overalls', 'jogger', 'joggers', 'legging', 'leggings', 'chino', 'chinos',
  'denim', 'sweatshirt', 'sweatpant', 'sweatpants', 'parka', 'blouson',
  'tunic', 'bomber', 'windbreaker', 'fleece', 'track', 'tracksuit',
  'footwear', 'sneaker', 'boot', 'capsule', 'pack', 'set', 'combo', 'bundle',
];

// ============================================================================
// Token 类
// ============================================================================

class Token {
  constructor({ text, x0, y0, x1, y1, page }) {
    this.text = String(text);
    this.x0 = Number(x0);
    this.y0 = Number(y0);
    this.x1 = Number(x1);
    this.y1 = Number(y1);
    this.page = page;
  }

  /** x 中心 */
  get xc() { return (this.x0 + this.x1) / 2; }

  /** y 中心 */
  get yc() { return (this.y0 + this.y1) / 2; }

  /** 是否为数字 token（纯数字，含逗号/小数点） */
  is_number() {
    const t = this.text;
    if (!t) return false;
    return /^[0-9,.\s]+$/.test(t) && !isNaN(parseFloat(t.replace(/,/g, '')));
  }

  /** 等值比较（text + bbox） */
  equals(other) {
    return other instanceof Token &&
      this.text === other.text &&
      this.x0 === other.x0 &&
      this.y0 === other.y0 &&
      this.x1 === other.x1 &&
      this.y1 === other.y1 &&
      this.page === other.page;
  }

  toString() {
    return `Token(text='${this.text}', x0=${this.x0}, y0=${this.y0}, x1=${this.x1}, y1=${this.y1}, page=${this.page})`;
  }
}

// ============================================================================
// PageWords 类
// ============================================================================

class PageWords {
  constructor({ page, width, height, tokens }) {
    this.page = page;
    this.width = width;
    this.height = height;
    this.tokens = tokens || [];
  }

  /**
   * 按 y 中心邻近度分组为视觉行，组内按 x0 排序。
   * @param {number} y_tol - y 中心容差（默认 5）
   * @returns {Token[][]}
   */
  lines(y_tol = 5) {
    if (!this.tokens.length) return [];
    const sorted = [...this.tokens].sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
    const groups = [];
    let current = [sorted[0]];
    let currentYc = sorted[0].yc;

    for (let i = 1; i < sorted.length; i++) {
      const t = sorted[i];
      if (Math.abs(t.yc - currentYc) <= y_tol) {
        current.push(t);
      } else {
        groups.push(current.sort((a, b) => a.x0 - b.x0));
        current = [t];
        currentYc = t.yc;
      }
    }
    groups.push(current.sort((a, b) => a.x0 - b.x0));
    return groups;
  }

  /** 整页文本（行用 \n 连接，行内 token 用空格连接） */
  text() {
    return this.lines().map(line => line.map(t => t.text).join(' ')).join('\n');
  }
}

// ============================================================================
// 模块级工具函数
// ============================================================================

/**
 * 剥离所有逗号 → int(float(x)) 截断。
 * '3,000'→3000, '5.7'→5, 'abc'→0, ''→0, '-3'→-3
 */
function _to_int(val) {
  if (val === null || val === undefined) return 0;
  const s = String(val).replace(/,/g, '').trim();
  if (s === '') return 0;
  const f = parseFloat(s);
  if (isNaN(f)) return 0;
  return parseInt(f, 10);
}

/**
 * 逗号→小数点（欧式）→ float。
 * '12,50'→12.5, '3,000'→3.0, 'abc'→null, ''→null
 */
function _to_float(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).replace(/,/g, '.').trim();
  if (s === '') return null;
  const f = parseFloat(s);
  return isNaN(f) ? null : f;
}

/**
 * 合理款号判断：2-16 字母数字+[-./_]，拒绝纯数字/数字-数字。
 * '637JO'→true, '1'→false, '1-1'→false, 'AB'→true
 */
function _looks_like_style(cand) {
  if (!cand || typeof cand !== 'string') return false;
  if (!_STYLE_CODE_RE.test(cand)) return false;
  return !/^\d+$/.test(cand) && !/^\d+[-/]\d+$/.test(cand);
}

/**
 * SKU/代码编号判断：含数字或含非字母字符，且非纯字母短颜色词。
 * '59J'→true, '08X'→true, '1'→true, 'ABC'→false
 */
function _looks_like_sku(word) {
  if (!word || typeof word !== 'string') return false;
  if (!word.trim()) return false;
  if (/\s/.test(word)) return false;
  if (/^[A-Za-z]+$/.test(word) && word.length <= 3) return false;
  return /\d/.test(word) || /[^A-Za-z]/.test(word);
}

/** 行是否含价格（N.NN 格式） */
function _line_is_priced(ln) {
  const tokens = ln.split(/\s+/);
  return tokens.some(t => _PRICE_RE.test(t));
}

/** TJX "其他"行判断（标签行、噪声行等非数据行） */
function _is_tjx_other(ln) {
  if (!ln) return false;
  if (_TJX_STANDALONE.test(ln)) return true;
  if (_TJX_LABEL.test(ln)) return true;
  if (_TJX_LINE_NO.test(ln) && !_TJX_MARKER.test(ln)) return true;
  if (/^(?:TOTAL|SUMMARY|GRAND)\b/.test(ln)) return true;
  return false;
}

/** 返回 x 中心最接近 xc 的列 (label, xc)，否则 null */
function _nearest(line, xc) {
  let best = null;
  let bestDist = Infinity;
  for (const tok of line) {
    const dist = Math.abs(tok.xc - xc);
    if (dist < bestDist) {
      bestDist = dist;
      best = tok;
    }
  }
  return best;
}

/** 取两个日期字符串中的较早者（YYYY-MM-DD 格式） */
function _min_date(a, b) {
  if (!a && !b) return '';
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** 运输方式归一：SEA/VESSEL→Sea, AIR→Air, 否则原样 */
function _norm_ship(text) {
  if (!text) return '';
  const upper = text.trim().toUpperCase();
  return _SHIP_MAP[upper] || text;
}

/** 清洗：去除多余空白 */
function _clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ── 日期归一 ──────────────────────────────────────────────

/**
 * 日期归一：dd.mm.yyyy / dd.mm.yy → YYYY-MM-DD；YYYY-MM-DD 原样；失败原样返回。
 * '15.03.2024'→'2024-03-15', '15.03.24'→'2024-03-15', 'invalid'→'invalid'
 */
function norm_date(s) {
  if (!s) return '';
  s = String(s).trim();
  if (!s) return '';

  // dd.mm.yyyy or dd.mm.yy
  let m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) {
    let [_, dd, mm, yy] = m;
    if (yy.length === 2) yy = '20' + yy;
    return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  // YYYY-MM-DD
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    let [_, yy, mm, dd] = m;
    return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  return s;
}

// ── 颜色提取 ──────────────────────────────────────────────

/**
 * 从右侧逐词剥离已知的产品名词（如 JEANS / SHIRT），保留颜色描述。
 * '59J 59J DARK BLUE JEANS' → '59J 59J DARK BLUE'
 */
function strip_product_name_suffix(text) {
  const words = text.split(/\s+/);
  while (words.length > 0) {
    const last = words[words.length - 1].toLowerCase();
    if (_PRODUCT_NAME_PATTERNS.includes(last)) {
      words.pop();
    } else {
      break;
    }
  }
  return words.join(' ');
}

/**
 * 从左侧逐词剥离看起来像 SKU 编号的词。
 * '59J 59J DARK BLUE' → 'DARK BLUE'
 */
function strip_sku_code_prefix(text) {
  const words = text.split(/\s+/);
  while (words.length > 0) {
    if (_looks_like_sku(words[0])) {
      words.shift();
    } else {
      break;
    }
  }
  return words.join(' ');
}

/**
 * 从合并的「CODE / DESC」字符串中智能提取颜色描述。
 * 1. 先 strip 右侧产品名词
 * 2. 再 strip 左侧 SKU 代码前缀
 * 3. 若只剩下 SKU（无颜色描述），回退 ''
 */
function extract_color_from_combined(combined) {
  if (!combined) return '';
  let s = String(combined).trim();
  if (!s) return '';

  s = strip_product_name_suffix(s);
  s = strip_sku_code_prefix(s);
  s = s.trim();

  if (!s) return '';
  if (_looks_like_sku(s)) return '';

  return s;
}

// ── 行合并与拆分 ──────────────────────────────────────────

/**
 * 重组 TJX 风格的换行物理行为逻辑行。
 * 对不使用 N-N / N/N 标记的文档无影响（原样返回）。
 */
function merge_wrapped_rows(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const result = [];

  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln || !ln.trim()) {
      i++;
      continue;
    }

    // TJX Import 风格：一行携带多个 item（N-N STYLECODE 标记）
    const packed = _COMBINED_ITEM.exec(ln);
    if (packed) {
      // 检查是否有多个 item 标记（packed table 模式）
      const matches = [...ln.matchAll(new RegExp(_COMBINED_ITEM.source, 'g'))];
      if (matches.length >= 2) {
        // 按标记拆分
        let lastEnd = 0;
        for (const m of matches) {
          if (m.index > lastEnd) {
            const prefix = ln.slice(lastEnd, m.index).trim();
            if (prefix) result.push(prefix);
          }
          result.push(ln.slice(m.index).trim());
          lastEnd = m.index + m[0].length;
          // After first match, find the next match position
          break;
        }
        // Actually, the packed table: all items share one physical line
        // Split at every N-N/N/N marker
        const parts = ln.split(/(?=\d{1,2}[-/]\d{1,2}\s)/).filter(p => p.trim());
        result.push(...parts);
        i++;
        continue;
      }
    }

    // TJX UK Vendor 风格：每 item 的 fragments 分布在多行
    if (_TJX_MARKER.test(ln)) {
      // This line starts with N-N marker → new logical row
      let combined = ln;
      // Collect following lines until next marker or noise line
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next || !next.trim()) break;
        if (_TJX_MARKER.test(next)) break;
        if (_is_tjx_other(next)) break;
        combined += ' ' + next;
        j++;
      }
      result.push(combined);
      i = j;
      continue;
    }

    // Normal line
    result.push(ln);
    i++;
  }

  return result;
}

/**
 * 合并同一实体内重复的行（相同 style/color/size）。
 * 用于 TJX Import 等重复打印明细表+汇总表的场景。
 */
function merge_order_lines(lines) {
  if (!lines || !lines.length) return lines;
  const seen = new Map();
  const result = [];
  for (const ln of lines) {
    const key = `${ln.style_no}|${ln.color_code}|${ln.color_desc}|${ln.inseam}`;
    if (seen.has(key)) {
      // Merge sizes
      const existing = seen.get(key);
      for (const sq of ln.sizes) {
        const idx = existing.sizes.findIndex(s => s.size === sq.size);
        if (idx >= 0) {
          existing.sizes[idx].qty = _to_int(existing.sizes[idx].qty) + _to_int(sq.qty);
        } else {
          existing.sizes.push({ ...sq });
        }
      }
    } else {
      seen.set(key, ln);
      result.push(ln);
    }
  }
  return result;
}

/**
 * 拆分 TJX 风格的合并物理行（一行携带多个 item）。
 */
function _split_combined_item_lines(phys) {
  if (!phys) return [];
  const matches = [...phys.matchAll(new RegExp(_COMBINED_ITEM.source, 'g'))];
  if (matches.length < 2) return [phys];
  // Split at each N-N marker position
  const parts = [];
  let lastIdx = 0;
  for (const m of matches) {
    if (m.index > lastIdx) {
      const prefix = phys.slice(lastIdx, m.index).trim();
      if (prefix) parts.push(prefix);
    }
    lastIdx = m.index;
  }
  if (lastIdx < phys.length) {
    const tail = phys.slice(lastIdx).trim();
    if (tail) parts.push(tail);
  }
  return parts.length > 1 ? parts : [phys];
}

// ── 尺码表头与数据行解析 ──────────────────────────────────

/**
 * 从表头行提取尺码列 [(Token, xc), ...]。
 * 尺码 run = 紧邻 TOTAL token 之前的连续 size-like token 块。
 * @param {Token[]} tokens - 表头行的 token 列表
 * @param {string} total_token - TOTAL 关键词（如 'TOTAL'）
 * @returns {Array<[Token, number]>|null} - [(label_token, xc), ...] 或 null
 */
function size_columns(tokens, total_token) {
  if (!tokens || !tokens.length) return null;
  const totalLower = (total_token || 'TOTAL').toLowerCase();

  // 找 TOTAL token 的位置
  let totalIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].text.toLowerCase() === totalLower ||
        tokens[i].text.toUpperCase().includes(total_token || 'TOTAL')) {
      totalIdx = i;
      break;
    }
  }
  if (totalIdx === -1) return null;

  // 从 TOTAL 往左收集连续的 size-like token
  const cols = [];
  for (let i = totalIdx - 1; i >= 0; i--) {
    const t = tokens[i];
    if (SIZE_TOKEN.test(t.text)) {
      cols.unshift([t, t.xc]);
    } else {
      break;
    }
  }

  return cols.length > 0 ? cols : null;
}

/**
 * 判断一行是否为尺码表头行。
 * @param {PoRecipe} recipe
 * @param {string} line_text
 * @returns {boolean}
 */
function is_size_header(recipe, line_text) {
  if (!line_text) return false;
  const upper = line_text.toUpperCase();

  // 优先：size_header_anchor（全行 fullmatch）
  if (recipe && recipe.size_header_anchor) {
    try {
      const re = new RegExp(recipe.size_header_anchor);
      if (re.test(line_text)) return true;
    } catch {}
  }

  // 其次：size_header_token（子串检查）
  if (recipe && recipe.size_header_token) {
    if (upper.includes(recipe.size_header_token.toUpperCase())) return true;
  }

  // 兜底：含 TOTAL 关键词即认为是
  if (_TOTAL_KW.test(line_text)) return true;

  return false;
}

/**
 * 拆分数据行的数字 token 为 (qty tokens, printed row total)。
 * token 属于 TOTAL 列当且仅当该列是其最近列。
 * @param {Token[]} qty_tokens - 数据行的数字 token
 * @param {Array<[Token, number]>} cols - 尺码列 [(label, xc), ...]
 * @param {number} total_xc - TOTAL 列的 x 中心
 * @returns {[Token[], Token|null]} - [qty_tokens, total_token_or_None]
 */
function split_row_total(qty_tokens, cols, total_xc) {
  if (!qty_tokens || !qty_tokens.length) return [[], null];

  const qtys = [];
  let totalTok = null;
  let totalDist = Infinity;

  for (const tok of qty_tokens) {
    // 找最近的列
    let nearestCol = null;
    let nearestDist = Infinity;
    for (const [label, xc] of cols) {
      const d = Math.abs(tok.xc - xc);
      if (d < nearestDist) {
        nearestDist = d;
        nearestCol = xc;
      }
    }

    // 也检查 TOTAL 列
    const totalDist_ = Math.abs(tok.xc - total_xc);
    if (totalDist_ < nearestDist) {
      // token 属于 TOTAL 列
      if (totalDist_ < totalDist) {
        totalDist = totalDist_;
        totalTok = tok;
      }
    } else {
      qtys.push(tok);
    }
  }

  return [qtys, totalTok];
}

/**
 * 将 TOTAL 行的数字 token 映射到 {size_label: qty}。
 * @param {Token[]} tokens_after_first - TOTAL 行去掉 TOTAL 关键词后的 token
 * @param {Array<[Token, number]>} ref - 尺码列 [(label, xc), ...]
 * @param {number} total_xc - TOTAL 列的 x 中心
 * @returns {Object} - {size_label: qty}
 */
function parse_total_row(tokens_after_first, ref, total_xc) {
  if (!tokens_after_first || !tokens_after_first.length || !ref || !ref.length) return {};

  const result = {};
  for (const tok of tokens_after_first) {
    // 找最近的列
    let nearestLabel = null;
    let nearestDist = Infinity;
    for (const [label, xc] of ref) {
      const d = Math.abs(tok.xc - xc);
      if (d < nearestDist) {
        nearestDist = d;
        nearestLabel = label;
      }
    }

    // 检查 TOTAL 列
    const totalDist_ = Math.abs(tok.xc - total_xc);
    if (totalDist_ < nearestDist) {
      // 属于 TOTAL 列，跳过
      continue;
    }

    if (nearestLabel) {
      result[nearestLabel.text] = tok.text;
    }
  }

  return result;
}

// ============================================================================
// BaseParser 类
// ============================================================================

class BaseParser {
  constructor(layout_type) {
    this.layout_type = layout_type || '';
  }

  /**
   * Channel 解析：E-COMM token 存在 → E-COMM；否则 recipe fallback。
   * @param {string} entity_line - 实体行的文本
   * @param {PoRecipe} recipe
   * @returns {string}
   */
  static _channel(entity_line, recipe) {
    if (entity_line && /E-COMM/i.test(entity_line)) return 'E-COMM';
    if (recipe) {
      if (recipe.channel_value) return recipe.channel_value;
      if (recipe.channel_anchor && recipe.channel_anchor !== 'E-COMM') return '';
    }
    return '';
  }

  /**
   * 取第一个非空匹配组。
   */
  static _first(...args) {
    for (const a of args) {
      if (a !== undefined && a !== null && a !== '') return a;
    }
    return '';
  }

  /**
   * 抽象 parse 方法 — 子类必须实现。
   */
  parse(pages, recipe, source_file = '') {
    throw new Error('BaseParser.parse() must be overridden');
  }
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  // 正则常量
  SIZE_TOKEN,
  _COMBINED_ITEM,
  _PRICE_RE,
  _STYLE_CODE_RE,
  _TJX_LABEL,
  _TJX_LINE_NO,
  _TJX_MARKER,
  _TJX_STANDALONE,
  _TOTAL_KW,
  _UK_LEAD,
  _SEQ_NUM_RE,
  _FOOTER_MARGIN,
  _SHIP_MAP,
  _PRODUCT_NAME_PATTERNS,
  // 类
  Token,
  PageWords,
  BaseParser,
  // 工具函数
  _to_int,
  _to_float,
  _looks_like_style,
  _looks_like_sku,
  _line_is_priced,
  _is_tjx_other,
  _nearest,
  _min_date,
  _norm_ship,
  _clean,
  _split_combined_item_lines,
  norm_date,
  strip_product_name_suffix,
  strip_sku_code_prefix,
  extract_color_from_combined,
  merge_wrapped_rows,
  merge_order_lines,
  size_columns,
  is_size_header,
  split_row_total,
  parse_total_row,
};
