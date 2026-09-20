/**
 * ref/core/parsers/line_items.js — 行式明细解析器
 * （复刻 Purchase Order Extractor V2 core/parsers/line_items.py）
 *
 * 逆向来源：core__parsers__line_items.txt（83 字符串 dump）+ probe_parsers*.json
 *
 * 职责：每行一个尺码或多个尺码的 PO 解析。
 *   - 使用 recipe.line_pattern 逐行匹配
 *   - 从 entity_anchor 提取 PO 号
 *   - 解析 TJX 风格的 ratio/units 尺码编码
 *   - 从行中间文本提取颜色描述
 *   - 合并重复行（明细表 + 汇总表去重）
 *
 * 关键行为（probe 锁定）：
 *   - _recover_style_from_line：'1-1' + '1-1 AW11078 BLACK...' → 'AW11078'
 *     （扫描行内剩余 token，优先含字母+数字的候选）
 *   - _color_desc_from：
 *     'LADIES TROUSERS 08X 08X SAND' → 'SAND'（最右连续纯字母 token）
 *     '59J 59J DARK BLUE JEANS' → 'DARK BLUE JEANS'（不剥产品名，与 extract_color_from_combined 不同）
 *   - _parse_size_breakdown：
 *     ratio sum == line_qty → 原样返回；ratio sum != line_qty → 按 line_qty//ratio_sum 缩放
 *   - _pick_po_no：优先 named group 'po_no'，否则第一个非空 positional group
 *   - _min_date(recipe, text)：从 text 中按 delivery_anchor 提取最早日期
 *   - LineItemsParser 可无参实例化，layout_type='line_items'
 */

'use strict';

const path = require('path');
const B = require('./base');
const {
  Token, PageWords, BaseParser,
  SIZE_TOKEN, _TOTAL_KW, _COMBINED_ITEM, _TJX_MARKER, _TJX_STANDALONE,
  _STYLE_CODE_RE, _SEQ_NUM_RE, _FOOTER_MARGIN,
  _looks_like_style, _to_int, _to_float, _norm_ship, _clean,
  norm_date, extract_color_from_combined, merge_wrapped_rows,
  merge_order_lines, size_columns, is_size_header, split_row_total,
  parse_total_row,
} = B;

// ============================================================================
// 模块级工具函数
// ============================================================================

/**
 * 全文档文本，页间用 form-feed 分隔。
 * crop_footer=True 时裁剪最后一个有价行 + TOTAL 行之后的签名/法律页脚区域。
 * @param {PageWords[]} pages
 * @param {boolean} crop_footer
 * @returns {string}
 */
function doc_text(pages, { crop_footer = true } = {}) {
  if (!pages || !pages.length) return '';
  const parts = [];
  for (const pw of pages) {
    parts.push(pw.text());
  }
  let text = parts.join('\n\x0c\n');

  if (crop_footer && text) {
    // 找最后一个 TOTAL 行的位置
    const lines = text.split('\n');
    let lastTotalIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (_TOTAL_KW.test(lines[i])) {
        lastTotalIdx = i;
        break;
      }
    }
    if (lastTotalIdx >= 0 && lastTotalIdx + _FOOTER_MARGIN < lines.length) {
      lines.splice(lastTotalIdx + _FOOTER_MARGIN + 1);
      text = lines.join('\n');
    }
  }

  return text;
}

/**
 * 从 anchor match 中提取 PO 号。
 * 优先 named group 'po_no'，否则第一个非空 positional group。
 * 如果取到的值是 1-2 位数字且匹配文本含更长数字，取更长数字。
 * @param {RegExpMatchArray} m - 正则匹配结果
 * @returns {string}
 */
function _pick_po_no(m) {
  let val = '';
  // 优先 named group
  if (m.groups && m.groups.po_no) {
    val = m.groups.po_no;
  } else {
    // 第一个非空 positional group
    for (let i = 1; i < (m.length || 0); i++) {
      if (m[i]) {
        val = m[i];
        break;
      }
    }
  }
  if (!val) val = m[0] || '';

  // 如果值是 1-2 位数字，检查匹配文本中是否有更长的数字
  if (/^\d{1,2}$/.test(val)) {
    const fullText = m.input || '';
    const longerMatch = fullText.match(/\d{4,}/);
    if (longerMatch && longerMatch[0] !== val) {
      val = longerMatch[0];
    }
  }

  return val;
}

/**
 * 从行文本中恢复真实款号。
 * 当 line_pattern 捕获到序号（如 '1-1'）而非真实款号时，
 * 扫描行内剩余 token，优先含字母+数字的候选。
 * @param {string} style - 捕获到的 style 值
 * @param {string} line - 整行文本
 * @returns {string}
 */
function _recover_style_from_line(style, line) {
  // 如果 style 已经是合理的款号，直接返回
  if (_looks_like_style(style)) return style;

  // 扫描行内 token
  const tokens = line.split(/\s+/);
  for (const tok of tokens) {
    if (tok === style) continue;
    if (!_looks_like_style(tok)) continue;
    // 优先含字母+数字的
    if (/[A-Za-z]/.test(tok) && /\d/.test(tok)) {
      return tok;
    }
  }

  // 没找到含字母+数字的，取任意合理的
  for (const tok of tokens) {
    if (tok === style) continue;
    if (_looks_like_style(tok)) return tok;
  }

  return style;
}

/**
 * 从 middle block 智能提取颜色描述。
 * 策略 1（LPP/VPN Color 列）：取最右侧连续纯字母 token
 *   'LADIES TROUSERS 08X 08X SAND' → 'SAND'
 *   '59J 59J DARK BLUE JEANS' → 'DARK BLUE JEANS'
 * 策略 2（TJX 风格，颜色在左）：从左取连续纯字母 token，遇到含数字/%/斜杠即停
 * 策略 1 先执行，有结果则返回；否则 fallback 到 extract_color_from_combined。
 * @param {string} middle
 * @returns {string}
 */
function _color_desc_from(middle) {
  if (!middle) return '';
  const tokens = middle.split(/\s+/).filter(t => t);

  // 策略 1：最右侧连续纯字母 token
  const pureLetterTokens = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (/^[A-Za-z]+$/.test(tokens[i])) {
      pureLetterTokens.unshift(tokens[i]);
    } else {
      break;
    }
  }
  if (pureLetterTokens.length > 0) {
    return pureLetterTokens.join(' ');
  }

  // 策略 2：从左取连续纯字母 token，遇到含数字/%/斜杠即停
  const leftTokens = [];
  for (let i = 0; i < tokens.length; i++) {
    if (/^[A-Za-z]+$/.test(tokens[i])) {
      leftTokens.push(tokens[i]);
    } else {
      break;
    }
  }
  if (leftTokens.length > 0) {
    return leftTokens.join(' ');
  }

  // Fallback
  return extract_color_from_combined(middle);
}

/**
 * 解析 TJX ratio/units 尺码编码。
 * 行携带 LABEL:N 对（逗号分隔）：
 *   S:1, M:2, L:2, XL:1  (ratio: 6 per pack)
 *   S:150, M:300, L:300, XL:150  (absolute)
 * 如果 absolute sum == line_qty，直接用；否则按 line_qty // ratio_sum 缩放。
 * @param {string} line - 尺码编码行
 * @param {number} line_qty - 行总量
 * @returns {SizeQty[]}
 */
function _parse_size_breakdown(line, line_qty) {
  if (!line) return [];

  // 解析 LABEL:N 对
  const pairs = [];
  const parts = line.split(/[,\s]+/);
  for (const part of parts) {
    const m = part.match(/^([A-Za-z0-9]+):(\d+)$/);
    if (m) {
      pairs.push([m[1], parseInt(m[2], 10)]);
    }
  }

  if (pairs.length === 0) return [];

  const sum = pairs.reduce((a, [_, n]) => a + n, 0);
  if (sum === 0) return [];

  // 如果 sum == line_qty，是 absolute，直接用
  if (sum === line_qty) {
    return pairs.map(([size, qty]) => ({ size, qty }));
  }

  // 否则是 ratio，按 line_qty // sum 缩放
  const scale = Math.floor(line_qty / sum);
  // ratio 必须能整除 line_qty 才有效
  if (scale <= 0 || sum * scale !== line_qty) return [];

  return pairs.map(([size, qty]) => ({ size, qty: qty * scale }));
}

/**
 * 从 text 中按 recipe.delivery_anchor 提取最早日期。
 * @param {Object} recipe - PoRecipe
 * @param {string} text - 文档文本
 * @returns {string} - YYYY-MM-DD 或空串
 */
function _min_date(recipe, text) {
  if (!text || !recipe) return '';
  const anchor = recipe.delivery_anchor;
  if (!anchor) return '';

  let earliest = '';
  try {
    const re = new RegExp(anchor, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      const rawDate = m[1] || m[0] || '';
      const normalized = norm_date(rawDate);
      if (normalized) {
        if (!earliest || normalized < earliest) {
          earliest = normalized;
        }
      }
    }
  } catch {}

  return earliest;
}

/**
 * 合并同一实体内重复的行（相同 style/color/color_desc/inseam）。
 * 用于 TJX Import 等重复打印明细表+汇总表的场景。
 * @param {OrderLine[]} lines
 * @returns {OrderLine[]}
 */
function _dedup_entity_lines(lines) {
  if (!lines || lines.length <= 1) return lines;
  const seen = new Map();
  const result = [];
  for (const ln of lines) {
    const key = `${ln.style_no}|${ln.color_code}|${ln.color_desc}|${ln.inseam}`;
    if (seen.has(key)) {
      const existing = seen.get(key);
      for (const sq of (ln.sizes || [])) {
        const idx = existing.sizes.findIndex(s => s.size === sq.size);
        if (idx >= 0) {
          existing.sizes[idx].qty = _to_int(existing.sizes[idx].qty) + _to_int(sq.qty);
        } else {
          existing.sizes.push({ size: sq.size, qty: sq.qty });
        }
      }
    } else {
      seen.set(key, ln);
      result.push(ln);
    }
  }
  return result;
}

// ============================================================================
// LineItemsParser 类
// ============================================================================

class LineItemsParser extends BaseParser {
  constructor() {
    super('line_items');
  }

  /**
   * 解析文档。
   * @param {PageWords[]} pages
   * @param {Object} recipe - PoRecipe
   * @param {string} source_file
   * @returns {Object} PurchaseOrder
   */
  parse(pages, recipe, source_file = '') {
    if (!recipe || !recipe.line_pattern) {
      throw new Error('line_items parser requires recipe.line_pattern');
    }

    // 1. 构建文档文本
    const text = doc_text(pages, { crop_footer: true });

    // 2. 合并 TJX 风格的换行行
    const logicalLines = merge_wrapped_rows(text);

    // 3. 找 entity anchors
    const entities = [];
    const poNoFromCustomer = this._extract_customer_po_no(logicalLines, recipe);

    if (recipe.entity_anchor) {
      const re = new RegExp(recipe.entity_anchor, 'gi');
      let m;
      let segStart = 0;
      const segments = [];

      // 找所有 entity anchor 的位置
      const anchors = [];
      const fullText = logicalLines.join('\n');
      while ((m = re.exec(fullText)) !== null) {
        anchors.push({
          match: m,
          po_no: _pick_po_no(m),
          channel: B.BaseParser._channel(m[0], recipe),
          start: m.index,
        });
      }

      // 每个 entity 的文本段 = 从 anchor 到下一个 anchor
      for (let i = 0; i < anchors.length; i++) {
        const start = anchors[i].start;
        const end = i + 1 < anchors.length ? anchors[i + 1].start : fullText.length;
        const seg = fullText.slice(start, end);
        anchors[i].seg = seg;
      }

      // 如果没有 entity anchor，整个文档作为一个 entity
      if (anchors.length === 0) {
        anchors.push({
          po_no: poNoFromCustomer || '',
          channel: '',
          seg: fullText,
        });
      }

      // 4. 为每个 entity 解析行
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        const entity = this._build_entity(
          recipe, a.seg, a.po_no || poNoFromCustomer || '', a.channel || '', fullText
        );
        entities.push(entity);
      }
    } else {
      // 无 entity anchor，整个文档一个 entity
      const entity = this._build_entity(
        recipe, fullText, poNoFromCustomer || '', '', fullText
      );
      entities.push(entity);
    }

    // 5. 构建 PurchaseOrder
    const po = {
      customer: recipe.customer || '',
      source_file: source_file || '',
      source_file_path: source_file || '',
      order_date: _min_date(recipe, text),
      per_destination: false,
      fingerprint: recipe.fingerprint || '',
      entities,
      validation_warnings: [],
    };

    return po;
  }

  /**
   * 从文档中提取 customer PO 号（使用 po_no_anchor 或 customer_anchor）。
   */
  _extract_customer_po_no(lines, recipe) {
    if (!recipe) return '';
    const text = Array.isArray(lines) ? lines.join('\n') : lines;

    // 先用 po_no_anchor
    if (recipe.po_no_anchor) {
      try {
        const re = new RegExp(recipe.po_no_anchor, 'i');
        const m = re.exec(text);
        if (m) return _pick_po_no(m);
      } catch {}
    }

    // 再用 entity_anchor 的第一个匹配
    if (recipe.entity_anchor) {
      try {
        const re = new RegExp(recipe.entity_anchor, 'i');
        const m = re.exec(text);
        if (m) return _pick_po_no(m);
      } catch {}
    }

    return '';
  }

  /**
   * 从 entity segment 构建 OrderEntity。
   * @param {Object} recipe - PoRecipe
   * @param {string} seg - entity 的文本段
   * @param {string} po_no - PO 号
   * @param {string} chan - channel
   * @param {string} doc - 全文档文本（用于 header anchor fallback）
   * @returns {Object} OrderEntity
   */
  _build_entity(recipe, seg, po_no, chan, doc = '') {
    const entity = {
      entity_index: 0,
      po_no: po_no || '',
      channel: chan || '',
      season: this._scoped(recipe.season_anchor, seg, doc),
      delivery_date: this._extract_delivery_date(recipe, seg, doc),
      currency: this._scoped(recipe.currency_anchor, seg, doc),
      price_term: this._scoped(recipe.price_term_anchor, seg, doc),
      payment_terms: this._scoped(recipe.payment_terms_anchor, seg, doc),
      product_desc: this._scoped(recipe.style_anchor, seg, doc) || '',
      port_discharge: this._scoped(recipe.port_discharge_anchor, seg, doc),
      port_loading: this._scoped(recipe.port_loading_anchor, seg, doc),
      ship_mode: _norm_ship(this._scoped(recipe.ship_mode_anchor, seg, doc)),
      vendor_name: this._scoped(recipe.vendor_anchor, seg, doc),
      agent_name: this._scoped(recipe.agent_anchor, seg, doc),
      import_po_no: this._scoped(recipe.import_po_no_anchor, seg, doc),
      reference_no: this._scoped(recipe.reference_no_anchor, seg, doc),
      cir_no: this._scoped(recipe.cir_no_anchor, seg, doc),
      freight_terms: this._scoped(recipe.freight_terms_anchor, seg, doc),
      country_of_origin: this._scoped(recipe.country_of_origin_anchor, seg, doc),
      dc_address: this._scoped(recipe.dc_address_anchor, seg, doc),
      packing_method: this._scoped(recipe.packing_anchor, seg, doc) || recipe.packing_method || '',
      lines: [],
      printed_size_totals: {},
      printed_total_qty: null,
      printed_total_amount: null,
      extra: {},
    };

    // 解析行
    const lines = seg.split('\n');
    const lineRe = new RegExp(recipe.line_pattern, 'i');
    let currentStyle = '';
    let currentColor = '';
    let currentColorDesc = '';

    for (const ln of lines) {
      const trimmed = ln.trim();
      if (!trimmed) continue;

      const m = lineRe.exec(trimmed);
      if (!m) continue;

      const groups = m.groups || {};

      // 提取字段
      let style = groups.style || groups.style_no || m[1] || '';
      const colorCode = groups.color_code || groups.color || m[2] || '';
      const size = groups.size || '';
      const unit = groups.unit || '';
      const qty = _to_int(groups.qty || m[m.length - 1] || 0);
      const middle = groups.middle || '';
      const unitPrice = groups.unit_price ? _to_float(groups.unit_price) : null;

      // 恢复真实款号
      if (style && !_looks_like_style(style)) {
        style = _recover_style_from_line(style, trimmed);
      }
      if (style) currentStyle = style;

      // 颜色描述
      let colorDesc = '';
      if (middle) {
        colorDesc = _color_desc_from(middle);
      }
      if (colorDesc) currentColorDesc = colorDesc;

      // 尺码分解
      let sizes = [];
      if (size) {
        sizes = [{ size, qty }];
      } else if (groups.ratio_units || middle) {
        // 尝试 TJX 风格的尺码分解
        const ratioLine = groups.ratio_units || middle;
        const parsed = _parse_size_breakdown(ratioLine, qty);
        if (parsed.length > 0) {
          sizes = parsed;
        } else {
          sizes = [{ size: '', qty }];
        }
      } else {
        sizes = [{ size: '', qty }];
      }

      // 创建 OrderLine
      const orderLine = {
        style_no: style || currentStyle,
        color_code: colorCode,
        color_desc: colorDesc || currentColorDesc,
        inseam: groups.inseam || '',
        su: unit || recipe.order_unit || 'PCS',
        unit_price: unitPrice,
        printed_row_total: null,
        net_amount: null,
        sizes,
        extra: {},
      };

      entity.lines.push(orderLine);
    }

    // 去重
    if (recipe.dedup_style_size) {
      entity.lines = _dedup_entity_lines(entity.lines);
    }

    return entity;
  }

  /**
   * 解析 header anchor：先在 entity segment 中查找，再在全文中查找。
   * @param {string} anchor - 正则字符串
   * @param {string} seg - entity 文本段
   * @param {string} doc - 全文档文本
   * @returns {string} - 匹配到的值或空串
   */
  _scoped(anchor, seg, doc) {
    if (!anchor) return '';

    // 先在 entity segment 中查找
    try {
      const re = new RegExp(anchor, 'i');
      let m = re.exec(seg);
      if (m) {
        return _clean_match(m);
      }
      // 再在全文中查找
      if (doc) {
        m = re.exec(doc);
        if (m) {
          return _clean_match(m);
        }
      }
    } catch {}

    return '';
  }

  /**
   * 提取交货日期（从 delivery_anchor 或 date anchor）。
   */
  _extract_delivery_date(recipe, seg, doc) {
    if (!recipe) return '';

    // 先用 delivery_anchor
    if (recipe.delivery_anchor) {
      try {
        const re = new RegExp(recipe.delivery_anchor, 'i');
        let m = re.exec(seg);
        if (!m && doc) m = re.exec(doc);
        if (m) {
          const rawDate = m[1] || m[0] || '';
          return norm_date(rawDate);
        }
      } catch {}
    }

    // 通用 Date 模式
    const dateRe = /(?:Date|[A-Z]late):\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/;
    let m = dateRe.exec(seg);
    if (!m && doc) m = dateRe.exec(doc);
    if (m) return norm_date(m[1]);

    return '';
  }
}

/**
 * 清洗正则匹配结果，提取值。
 */
function _clean_match(m) {
  if (!m) return '';
  // 优先取第一个捕获组
  if (m[1]) return _clean(m[1]);
  // 否则取整个匹配
  return _clean(m[0]);
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  LineItemsParser,
  // 模块级函数
  doc_text,
  _pick_po_no,
  _recover_style_from_line,
  _color_desc_from,
  _parse_size_breakdown,
  _min_date,
  _dedup_entity_lines,
};
