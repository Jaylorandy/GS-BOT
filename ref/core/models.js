/**
 * ref/core/models.js — 数据契约（复刻 Purchase Order Extractor V2 core/models.py）
 *
 * 逆向来源：复刻分析/core__models.txt（378 个字符串 dump）+ 反汇编；
 * 验证基准：ref/test/oracle_models.json / oracle_models_extra.json / probe_oracle.json
 * （原版 models.pyc 直接采样生成，py311 运行）。
 *
 * 契约总览（与 Python dataclass 字段序逐一对齐，Object.keys 即字段序）：
 *   SizeQty       { size, qty }                       + qty_safe（计算属性）
 *   OrderLine     { style_no, color_code, color_desc, inseam, sizes,
 *                   unit_price, su, printed_row_total, net_amount, extra } + total_qty
 *   OrderEntity   33 字段（entity_index, style_no, 26 个表头字段, lines,
 *                   printed_size_totals, printed_total_qty, printed_total_amount, extra）
 *   PurchaseOrder { customer, source_file, source_file_path, order_date,
 *                   per_destination, entities, validation_warnings, fingerprint }
 *                   + total_qty + 配方应用方法族
 *   PoRecipe      58 字段（客户/版式差异全部数据化，JSON 可序列化，按指纹缓存）
 *
 * 关键语义（oracle 锁定，详见 README §3）：
 *   - apply_recipe_overrides 返回 null：
 *       color_edits 仅 JSON 字符串形式生效（dict 输入被忽略，oracle overrides_j）；
 *       __line_overrides__ 键优先级 combined > combined+␟+inseam > code-only（与 dict 顺序无关）；
 *       sizes 为合并语义（只更新已存在尺寸键；数量 int(float(x)) 截断，解析失败保留原值）；
 *       全局 unit_price 剥离所有逗号后 float（失败 → null，非欧式规则）；
 *       全局 su 空串也传播；26 个表头键（含 currency）写所有实体。
 *   - apply_field_defaults / apply_value_clean：diff-on-_cleanable_pairs() 变更日志
 *     （changes 顺序 = pairs 顺序；su 应用于行但不在 pairs → 不进 changes，oracle E）。
 *   - SizeQty.qty_safe（strip→int，失败 0）与 override sizes 数量解析（int(float())）是两条路径，勿混用。
 *   - PoRecipe.to_json 逐字节等价 Python json.dumps(indent=2, ensure_ascii=False)。
 *
 * 与 Python 的已知差异（无法从 oracle 区分处，取保守实现并在注释标注）：
 *   - __line_overrides__ 的 ␟ 键仅在 inseam 为 truthy 时构造（空 inseam 不构造）。
 *   - __ent_overrides__ / 全局键 / field_defaults 的 style_no 只写行级，不写 entity.style_no
 *     （oracle 仅观察到行级变化；entity.style_no 由 _clean_field 单独清洗，clean_field_style 证实）。
 */

'use strict';

const { _pyRepr, _pyLen, _pySlice29, _hasAttr, _getAttr, _setAttr } = require('./normalize');
const { excel_hyperlink_formula } = require('./winpath');

// ============================================================================
// 常量
// ============================================================================

/** 版式类型枚举（LayoutType，14 值，oracle 逐值确认） */
const LayoutType = Object.freeze({
  MATRIX_2AXIS: 'matrix_2axis',
  MATRIX_1AXIS: 'matrix_1axis',
  LINE_ITEMS: 'line_items',
  CONTROL_SHEET: 'control_sheet',
  MATRIX_PERCARTON: 'matrix_percarton',
  LINE_ITEMS_EU: 'line_items_eu',
  COSTCO_HYBRID: 'costco_hybrid',
  COSTCO_ECOM: 'costco_ecom',
  CELIO: 'celio',
  FRANKIE_ECOM: 'frankie_ecom',
  BASS_PRO_ACK: 'bass_pro_ack',
  IMPORT_PO: 'import_po',
  ANF_PO: 'anf_po',
  ANF_COMMITMENT: 'anf_commitment',
});

/** 行键分隔符（Template B 去重键 7 段连接符） */
const _ROW_KEY_SEP = '|';

/** 行级覆盖键的内长分隔符（␟，U+241F） */
const _INSEAM_SEP = '\u241f';

/** 标签前缀分隔符（·，U+00B7） */
const _LABEL_SEP = '\u00b7';

/**
 * 实体可覆盖表头字段（26 个，含 currency——oracle overrides_c 的 currency='EUR'
 * 证实 currency 在列）。顺序与 _FIELD_LABELS 一致。仅用于成员判断。
 */
const _ENTITY_FIELDS = [
  'po_no', 'season', 'currency', 'price_term', 'payment_terms', 'port_loading',
  'port_discharge', 'ship_mode', 'vendor_name', 'agent_name', 'channel', 'size_scale',
  'product_group', 'age_sex_desc', 'product_desc', 'destination_code', 'wash_method',
  'washing_color', 'packing_method', 'delivery_date', 'import_po_no', 'reference_no',
  'cir_no', 'freight_terms', 'country_of_origin', 'dc_address',
];
const _ENTITY_FIELD_SET = new Set(_ENTITY_FIELDS);

/**
 * _cleanable_pairs 的 H1 级标签顺序（26 字段；customer 在 _cleanable_pairs 中
 * 单独追加为第 27 对，标签 'H1·customer'）。
 */
const _FIELD_LABELS = [
  'po_no', 'season', 'currency', 'price_term', 'payment_terms', 'port_loading',
  'port_discharge', 'ship_mode', 'vendor_name', 'agent_name', 'channel', 'size_scale',
  'product_group', 'age_sex_desc', 'product_desc', 'destination_code', 'wash_method',
  'washing_color', 'packing_method', 'delivery_date', 'import_po_no', 'reference_no',
  'cir_no', 'freight_terms', 'country_of_origin', 'dc_address',
];

/** 变更日志截断（32 字符以上 → 前 29 + '…'，与 normalize.js 一致） */
const _TRUNC_MAX = 32;
const _TRUNC_KEEP = 29;

// ============================================================================
// 工具（Python 语义等价）
// ============================================================================

/**
 * Python str.split(sep, maxsplit) 等价。
 * maxsplit < 0 或 undefined → 无限分割（与 Python 一致）；
 * 否则最多 maxsplit 次分割，剩余部分合并为最后一个元素。
 */
function _pySplit(s, sep, maxsplit) {
  if (maxsplit === undefined || maxsplit < 0) return String(s).split(sep);
  const parts = String(s).split(sep);
  if (parts.length <= maxsplit + 1) return parts;
  const result = parts.slice(0, maxsplit);
  result.push(parts.slice(maxsplit).join(sep));
  return result;
}

/** 变更日志值截断：>32 字符 → 前 29 + '…'（U+2026） */
function _truncPy(s) {
  s = String(s);
  return _pyLen(s) <= _TRUNC_MAX ? s : _pySlice29(s) + '\u2026';
}

/** 变更日志行："{label}: {repr(old)} → {repr(new)}{suffix}" */
function _changeLine(label, oldVal, newVal, suffix) {
  return `${label}: ${_pyRepr(_truncPy(oldVal))} \u2192 ${_pyRepr(_truncPy(newVal))}${suffix}`;
}

/**
 * 行级 unit_price 解析：剥离所有逗号 → float，失败/空 → null。
 * '12,50'→1250、'10,5,5'→1055、'10'→10、'abc'→null（oracle B 组逐条确认；
 * 注意与 normalize.js _normalize_amount 的欧式规则不同）。
 */
function _parseUnitPrice(v) {
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/**
 * __line_overrides__ sizes 数量解析：int(float(str(x).replace(',',''))) 语义。
 * 空/NaN/非有限 → 返回 {keep: true} 表示保留原值（Python 侧为异常捕获路径）；
 * 否则返回 Math.trunc(Number(s))。
 */
function _parseOverrideQty(x) {
  const s = String(x).replace(/,/g, '').trim();
  if (s === '') return { keep: true };
  const n = Number(s);
  if (Number.isNaN(n) || !Number.isFinite(n)) return { keep: true };
  return Math.trunc(n);
}

// ============================================================================
// build_row_key —— 7 段 Template B 去重键（模块级导出）
// ============================================================================

/**
 * 7-segment Template B dedup key（列 V，_Row Key）：
 *   Customer | PO | Style | ColorCode | Size | Inseam | Destination
 * falsy 段一律空串，'|' 连接（原版 docstring：V2.0.5 起 28 列改造去掉了第 8 段 PackingMethod）。
 * @returns {string}
 */
function build_row_key(customer, po_no, style, color_code, size, inseam, destination) {
  return [customer, po_no, style, color_code, size, inseam, destination]
    .map((x) => (x ? String(x) : ''))
    .join(_ROW_KEY_SEP);
}

// ============================================================================
// SizeQty
// ============================================================================

class SizeQty {
  constructor(opts = {}) {
    this.size = opts.size !== undefined ? opts.size : '';
    this.qty = opts.qty !== undefined ? opts.qty : 0;
  }

  /**
   * 数量安全取值（oracle G 组）：
   * strip→int 语义 —— ' 5 '→5、'-3'→-3、'0'→0；'5.7'/'abc'/''→0；
   * number → 向零截断（5.7→5，Python int() 语义）；bool → 1/0；null/undefined → 0。
   * 与 __line_overrides__ sizes 的 int(float()) 解析是两条不同路径。
   */
  get qty_safe() {
    const v = this.qty;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
    if (typeof v === 'string') {
      const t = v.trim();
      return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : 0;
    }
    return 0;
  }
}

// ============================================================================
// OrderLine
// ============================================================================

class OrderLine {
  constructor(opts = {}) {
    this.style_no = opts.style_no !== undefined ? opts.style_no : '';
    this.color_code = opts.color_code !== undefined ? opts.color_code : '';
    this.color_desc = opts.color_desc !== undefined ? opts.color_desc : '';
    this.inseam = opts.inseam !== undefined ? opts.inseam : '';
    this.sizes = opts.sizes !== undefined ? opts.sizes : [];
    this.unit_price = opts.unit_price !== undefined ? opts.unit_price : null;
    this.su = opts.su !== undefined ? opts.su : '';
    this.printed_row_total = opts.printed_row_total !== undefined ? opts.printed_row_total : null;
    this.net_amount = opts.net_amount !== undefined ? opts.net_amount : null;
    this.extra = opts.extra !== undefined ? opts.extra : {};
  }

  /** Σ sizes qty_safe（normalize.js _validate_lines 依赖本属性） */
  get total_qty() {
    return (this.sizes || []).reduce((acc, sq) => acc + sq.qty_safe, 0);
  }
}

// ============================================================================
// OrderEntity（33 字段，字段序 = Python dataclass 声明序 = oracle 确认序）
// ============================================================================

const _ENTITY_FIELD_DEFS = [
  ['entity_index', 0],
  ['style_no', ''],
  ['po_no', ''], ['channel', ''], ['delivery_date', ''], ['destination_code', ''],
  ['packing_method', ''], ['wash_method', ''], ['washing_color', ''], ['payment_terms', ''],
  ['price_term', ''], ['currency', ''], ['size_scale', ''], ['product_group', ''],
  ['age_sex_desc', ''], ['product_desc', ''], ['season', ''], ['port_loading', ''],
  ['port_discharge', ''], ['ship_mode', ''], ['vendor_name', ''], ['agent_name', ''],
  ['import_po_no', ''], ['reference_no', ''], ['cir_no', ''], ['freight_terms', ''],
  ['country_of_origin', ''], ['dc_address', ''],
  ['lines', () => []],
  ['printed_size_totals', () => ({})],
  ['printed_total_qty', null],
  ['printed_total_amount', null],
  ['extra', () => ({})],
];

class OrderEntity {
  constructor(opts = {}) {
    if (opts === null || typeof opts !== 'object') opts = {};
    for (const [name, def] of _ENTITY_FIELD_DEFS) {
      this[name] = opts[name] !== undefined ? opts[name] : (typeof def === 'function' ? def() : def);
    }
  }
}

// ============================================================================
// PurchaseOrder
// ============================================================================

class PurchaseOrder {
  constructor(opts = {}) {
    if (opts === null || typeof opts !== 'object') opts = {};
    this.customer = opts.customer !== undefined ? opts.customer : '';
    this.source_file = opts.source_file !== undefined ? opts.source_file : '';
    this.source_file_path = opts.source_file_path !== undefined ? opts.source_file_path : '';
    this.order_date = opts.order_date !== undefined ? opts.order_date : '';
    this.per_destination = opts.per_destination !== undefined ? opts.per_destination : false;
    this.entities = opts.entities !== undefined ? opts.entities : [];
    this.validation_warnings = opts.validation_warnings !== undefined ? opts.validation_warnings : [];
    this.fingerprint = opts.fingerprint !== undefined ? opts.fingerprint : '';
  }

  /** Σ 实体→行→sizes qty_safe（'abc' 计 0；sample = 1444） */
  get total_qty() {
    let total = 0;
    for (const ent of this.entities || []) {
      for (const ln of ent.lines || []) {
        total += typeof ln.total_qty === 'number' ? ln.total_qty : 0;
      }
    }
    return total;
  }

  /** 按尺码汇总（插入序）：sample {S:944, M:500, L:0} */
  size_totals() {
    const out = {};
    for (const ent of this.entities || []) {
      for (const ln of ent.lines || []) {
        for (const sq of ln.sizes || []) {
          const k = sq.size;
          out[k] = (out[k] || 0) + sq.qty_safe;
        }
      }
    }
    return out;
  }

  /** 按色码汇总（插入序）：sample {80X:1244, 90Z:200} */
  color_totals() {
    const out = {};
    for (const ent of this.entities || []) {
      for (const ln of ent.lines || []) {
        const k = ln.color_code;
        out[k] = (out[k] || 0) + ln.total_qty;
      }
    }
    return out;
  }

  /**
   * Template B 行集（27 列 A..AA，每个 SizeQty 一行）。
   * L=null 由 writer 填公式 =I*K；V=7 段去重键；Y=源文件 HYPERLINK 公式。
   * po_version 为数字、is_current/import_batch 为字符串（oracle sample 逐列确认）。
   */
  template_b_rows(po_version = '', is_current = '', import_batch = '') {
    const rows = [];
    for (const ent of this.entities || []) {
      for (const ln of ent.lines || []) {
        for (const sq of ln.sizes || []) {
          rows.push({
            A: this.customer,
            B: ln.style_no,
            C: ent.po_no,
            D: ent.season,
            E: ln.color_code,
            F: ln.color_desc,
            G: sq.size,
            H: ln.inseam,
            I: sq.qty_safe,
            J: ln.su,
            K: ln.unit_price,
            L: null,
            M: ent.price_term,
            N: ent.currency,
            O: ent.delivery_date,
            P: ent.port_loading,
            Q: ent.port_discharge,
            R: ent.ship_mode,
            S: ent.destination_code,
            T: ent.payment_terms,
            U: ent.country_of_origin,
            V: build_row_key(
              this.customer, ent.po_no, ln.style_no, ln.color_code,
              sq.size, ln.inseam, ent.destination_code
            ),
            W: po_version,
            X: is_current,
            Y: excel_hyperlink_formula(this.source_file_path, this.source_file),
            Z: import_batch,
            AA: this.fingerprint,
          });
        }
      }
    }
    return rows;
  }

  /** 非空段以 ' / ' 连接（filter(Boolean) 语义）：('80X','')→'80X'、('','')→'' */
  static _color_combined(code, desc) {
    return [code, desc].filter(Boolean).join(' / ');
  }

  /**
   * (label, value) 快照 —— value/color_clean 影响面的可读 diff 基础
   * （原版 docstring：Snapshot of all (label, value) strings affected by value/color_clean）。
   * H1 级：27 对 = 26 个 H1·字段（_FIELD_LABELS 序，从 entity[0] 取值）+ H1·customer（po.customer）。
   * 行级：每实体每行 L{i}-{j}·款式 / L{i}-{j}·颜色。
   */
  _cleanable_pairs() {
    const pairs = [];
    const ents = this.entities || [];

    // H1 级：27 对，从 entity[0] 取值
    if (ents.length > 0) {
      const ent = ents[0];
      for (const fld of _FIELD_LABELS) {
        pairs.push(['H1' + _LABEL_SEP + fld, _getAttr(ent, fld, '')]);
      }
      pairs.push(['H1' + _LABEL_SEP + 'customer', this.customer]);
    }

    // 行级：每实体每行
    for (let ei = 0; ei < ents.length; ei++) {
      const ent = ents[ei];
      const lines = ent.lines || [];
      for (let li = 0; li < lines.length; li++) {
        const ln = lines[li];
        const lPrefix = `L${ei + 1}-${li + 1}`;
        pairs.push([lPrefix + _LABEL_SEP + '\u6b3e\u5f0f', ln.style_no]);
        pairs.push([lPrefix + _LABEL_SEP + '\u989c\u8272', PurchaseOrder._color_combined(ln.color_code, ln.color_desc)]);
      }
    }
    return pairs;
  }

  /**
   * 配方覆盖（返回 null）。处理顺序：color_edits → __ent_overrides__ →
   * __line_overrides__ → 全局键（customer/style_no/unit_price/su/26 表头键）。
   */
  apply_recipe_overrides(overrides) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;

    // ---- 1. color_edits：仅 JSON 字符串形式生效（dict 输入被忽略，oracle overrides_j；
    //         非法 JSON / 'null' 静默跳过，oracle F 组）。
    const ceRaw = overrides.color_edits;
    if (typeof ceRaw === 'string') {
      let parsed = null;
      try { parsed = JSON.parse(ceRaw); } catch (e) { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const ent of this.entities || []) {
          for (const ln of ent.lines || []) {
            const combined = PurchaseOrder._color_combined(ln.color_code, ln.color_desc);
            if (Object.prototype.hasOwnProperty.call(parsed, combined)) {
              const parts = _pySplit(parsed[combined], ' / ', 1);
              ln.color_code = parts[0];
              ln.color_desc = parts.length > 1 ? parts[1] : '';
            }
          }
        }
      }
    }

    // ---- 2. __ent_overrides__：键 = str(entity_index)；int() 非法/越界跳过
    //         （负索引按 Python 语义从尾部取）。
    const entOv = overrides['__ent_overrides__'];
    if (entOv && typeof entOv === 'object' && !Array.isArray(entOv)) {
      const ents = this.entities || [];
      for (const [key, ov] of Object.entries(entOv)) {
        const n = Number(key);
        if (!Number.isInteger(n)) continue;
        const idx = n < 0 ? ents.length + n : n;
        const ent = ents[idx];
        if (!ent) continue;
        if (!ov || typeof ov !== 'object' || Array.isArray(ov)) continue;
        for (const [k, v] of Object.entries(ov)) {
          if (k === 'style_no' || k === 'su' || k === 'unit_price') {
            // 行级键作用于该实体全部行（style_no 行级传播由 oracle overrides_e 证实；
            // su/unit_price 行级传播为合理外推，oracle 仅直接证实 style_no）。
            for (const ln of ent.lines || []) {
              if (k === 'unit_price') ln.unit_price = _parseUnitPrice(v);
              else ln[k] = v;
            }
          } else {
            _setAttr(ent, k, v);
          }
        }
      }
    }

    // ---- 3. __line_overrides__：候选键优先级 combined > combined+␟+inseam > code-only
    //         （P2/H 双向验证，与 dict 顺序无关；␟ 键仅在 inseam truthy 时构造）。
    const lineOv = overrides['__line_overrides__'];
    if (lineOv && typeof lineOv === 'object' && !Array.isArray(lineOv)) {
      const has = (k) => Object.prototype.hasOwnProperty.call(lineOv, k);
      for (const ent of this.entities || []) {
        for (const ln of ent.lines || []) {
          const combined = PurchaseOrder._color_combined(ln.color_code, ln.color_desc);
          let ov = null;
          if (has(combined)) ov = lineOv[combined];
          else if (ln.inseam && has(combined + _INSEAM_SEP + ln.inseam)) {
            ov = lineOv[combined + _INSEAM_SEP + ln.inseam];
          } else if (has(ln.color_code)) ov = lineOv[ln.color_code];
          if (!ov || typeof ov !== 'object' || Array.isArray(ov)) continue;
          for (const [k, v] of Object.entries(ov)) {
            if (k === 'sizes') _mergeLineSizes(ln, v);
            else if (k === 'unit_price') ln.unit_price = _parseUnitPrice(v);
            else _setAttr(ln, k, v);
          }
        }
      }
    }

    // ---- 4. 全局键（插入序，__ 开头跳过，color_edits 已处理跳过）。
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'color_edits' || key.startsWith('__')) continue;
      if (key === 'customer') {
        this.customer = value;
      } else if (key === 'style_no') {
        // 写所有行（即使为空也传播，oracle overrides_c：两行均 '12345'）。
        for (const ent of this.entities || []) {
          for (const ln of ent.lines || []) ln.style_no = value;
        }
      } else if (key === 'unit_price') {
        const price = _parseUnitPrice(value);
        for (const ent of this.entities || []) {
          for (const ln of ent.lines || []) ln.unit_price = price;
        }
      } else if (key === 'su') {
        // 空串也传播（oracle D_su_empty）。
        for (const ent of this.entities || []) {
          for (const ln of ent.lines || []) ln.su = value;
        }
      } else if (_ENTITY_FIELD_SET.has(key)) {
        for (const ent of this.entities || []) _setAttr(ent, key, value);
      }
    }
    return null;
  }

  /**
   * 配方默认值回填（覆盖语义，非只填空；recipe 为 null / 无 field_defaults → []）。
   * customer→po；style_no/su/unit_price→所有行；其余已知键→所有实体。
   * 返回 diff-on-pairs 变更日志（顺序 = pairs 序；su 不在 pairs → 不进 changes，oracle E）。
   */
  apply_field_defaults(recipe) {
    const defaults = recipe ? _getAttr(recipe, 'field_defaults', null) : null;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return [];

    const before = this._cleanable_pairs();

    for (const [key, value] of Object.entries(defaults)) {
      if (key === 'customer') {
        this.customer = value;
      } else if (key === 'style_no' || key === 'su') {
        for (const ent of this.entities || []) {
          for (const ln of ent.lines || []) ln[key] = value;
        }
      } else if (key === 'unit_price') {
        const price = _parseUnitPrice(value);
        for (const ent of this.entities || []) {
          for (const ln of ent.lines || []) ln.unit_price = price;
        }
      } else if (_ENTITY_FIELD_SET.has(key)) {
        for (const ent of this.entities || []) _setAttr(ent, key, value);
      }
    }

    const after = this._cleanable_pairs();
    return _diffPairs(before, after, ' (\u9ed8\u8ba4)');
  }

  /**
   * 正则清洗（返回 []，不是 null）。recipe.cleans: {field: [{pat, repl}]}；
   * field='color' 走 _clean_color（每行），其余走 _clean_field（customer→po / 实体字段）；
   * 非法正则 / rules 非 list / spec 非 dict / pat 非字符串 → 静默跳过（oracle badpat/skip）。
   * 返回 diff-on-pairs 变更日志（无后缀）。
   */
  apply_value_clean(recipe) {
    const cleans = recipe ? _getAttr(recipe, 'cleans', null) : null;
    if (!cleans || typeof cleans !== 'object' || Array.isArray(cleans)) return [];

    const before = this._cleanable_pairs();

    for (const [field, rules] of Object.entries(cleans)) {
      if (!Array.isArray(rules)) continue;
      for (const spec of rules) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
        const pat = _getAttr(spec, 'pat', undefined);
        const repl = _getAttr(spec, 'repl', undefined);
        if (typeof pat !== 'string') continue;
        try { new RegExp(pat); } catch (e) { continue; } // 非法正则静默跳过
        if (field === 'color') this._clean_color(pat, repl);
        else this._clean_field(field, pat, repl);
      }
    }

    const after = this._cleanable_pairs();
    return _diffPairs(before, after, '');
  }

  /**
   * 字段正则清洗（返回 null）。'customer'→po.customer；其余已知实体字段→每个实体该属性
   * （不作用于行：clean_field_style 证实 entity.style_no 保持 ''、行 style_no 不动）；
   * 未知字段/非法正则静默跳过。
   */
  _clean_field(field_name, pat, repl) {
    if (typeof pat !== 'string') return null;
    let rx;
    try { rx = new RegExp(pat, 'g'); } catch (e) { return null; }
    if (field_name === 'customer') {
      this.customer = String(this.customer).replace(rx, repl);
      return null;
    }
    for (const ent of this.entities || []) {
      if (_hasAttr(ent, field_name)) {
        const old = _getAttr(ent, field_name, '');
        _setAttr(ent, field_name, String(old).replace(rx, repl));
      }
    }
    return null;
  }

  /**
   * 颜色正则清洗（返回 null）。每行 combined 串 re.sub 后按首个 ' / ' 拆回 code/desc：
   *   desc 替换（BEIGE→IVORY）；code-only 替换（(80X|90Z)→'0' 变 '0 / BEIGE'）；
   *   整串替换（'80X / BEIGE'→'55X / TAUPE'）。无 ' / ' 时 desc 置空。
   */
  _clean_color(pat, repl) {
    if (typeof pat !== 'string') return null;
    let rx;
    try { rx = new RegExp(pat, 'g'); } catch (e) { return null; }
    for (const ent of this.entities || []) {
      for (const ln of ent.lines || []) {
        const combined = PurchaseOrder._color_combined(ln.color_code, ln.color_desc);
        const newCombined = String(combined).replace(rx, repl);
        if (newCombined !== combined) {
          const parts = _pySplit(newCombined, ' / ', 1);
          ln.color_code = parts[0];
          ln.color_desc = parts.length > 1 ? parts[1] : '';
        }
      }
    }
    return null;
  }
}

/** __line_overrides__ sizes 合并：只更新已存在尺寸键、不新增、未提及保留（P4 空表/非 dict 跳过） */
function _mergeLineSizes(ln, sizesOv) {
  if (!sizesOv || typeof sizesOv !== 'object' || Array.isArray(sizesOv)) return;
  for (const sq of ln.sizes || []) {
    if (Object.prototype.hasOwnProperty.call(sizesOv, sq.size)) {
      const parsed = _parseOverrideQty(sizesOv[sq.size]);
      if (typeof parsed === 'number') sq.qty = parsed;
    }
  }
}

/** pairs diff：label 相同且值变化 → 变更行（顺序 = pairs 序） */
function _diffPairs(before, after, suffix) {
  const changes = [];
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const [la, va] = before[i];
    const [lb, vb] = after[i];
    if (la === lb && va !== vb) {
      changes.push(_changeLine(la, String(va), String(vb), suffix));
    }
  }
  return changes;
}

// ============================================================================
// PoRecipe（58 字段，字段序 = Python dataclass 声明序 = to_json 键序）
// ============================================================================

const _RECIPE_FIELDS = [
  ['fingerprint', ''],
  ['customer', ''],
  ['layout_type', 'matrix_2axis'],
  ['version', '1'],
  ['note', ''],
  ['po_no_anchor', 'ORDER NO[.\\s:]+(\\S+)'],
  ['customer_anchor', '^(.*?)\\s+Purchase Order'],
  ['season_anchor', 'Season:\\s*(\\S+)'],
  ['delivery_anchor', 'Shipment date:\\s*(\\S+)'],
  ['currency_anchor', 'Currency:\\s*(\\S+)'],
  ['price_term_anchor', 'Terms of payment:\\s*(.+)'],
  ['style_anchor', '(?:Model\\s+No\\.|STYLE\\s+NO)[\\s.]*[:.]?\\s*(\\S+)'],
  ['price_anchor', 'UNIT PR[\u0130I]CE\\S*:\\s*([\\d.,]+)'],
  ['packing_anchor', 'MULTIPACK'],
  ['packing_method', ''],
  ['port_discharge_anchor', 'Port of discharge:\\s*(\\S+)'],
  ['port_loading_anchor', '(?:Port of loading|Loading port|Place of receipt)[.\\s:]+(\\S+(?:\\s+\\S+)?)'],
  ['ship_mode_anchor', 'Transport Type:\\s*(\\S+)'],
  ['agent_anchor', 'Agent:\\s*(.+)'],
  ['vendor_anchor', 'Supplier:\\s*(.+)'],
  ['payment_terms_anchor', ''],
  ['import_po_no_anchor', 'Import\\s*PO\\s*(?:#|No|Number)?[.\\s:]+(\\S+)'],
  ['reference_no_anchor', 'Reference\\s*(?:#|No)?[.\\s:]+(\\S+)'],
  ['cir_no_anchor', 'CIR\\s*(?:#|No)?[.\\s:]+(\\S+)'],
  ['freight_terms_anchor', 'Freight\\s*Terms?[.\\s:]+(\\S+(?:\\s+\\S+)?)'],
  ['country_of_origin_anchor', '(?:Country\\s*of\\s*Origin|Origin\\s*Country|Exiting\\s*Country)[.\\s:]+(\\S+)'],
  ['dc_address_anchor', '(?:DC\\s*Address|Distribution\\s*Center|Deliver\\s*to)[.\\s:]+(\\S.+)'],
  ['channel_anchor', 'E-COMM'],
  ['channel_value', ''],
  ['entity_anchor', 'Entity\\s+\\d+\\s+Order No:\\s*(\\S+)(?:\\s+(E-COMM))?'],
  ['destination_anchor', 'Destination Code:(\\S+)'],
  ['section_anchor', ''],
  ['section_delim_pattern', '^(DESTINATION|PACKAGING|COLOR) DETAILS$'],
  ['line_pattern', ''],
  ['order_unit', 'PCS'],
  ['color_anchor', 'COLOR NO\\s*:\\s*(\\S+)\\s+(.+)'],
  ['has_inseam', false],
  ['size_header_token', 'COLOR NO'],
  ['total_token', 'TOTAL'],
  ['grid_orientation', 'rows'],
  ['size_header_anchor', ''],
  ['color_code_pattern', ''],
  ['require_row_total', false],
  ['breakdown_anchor', ''],
  ['summary_anchor', ''],
  ['line_field_map', () => ({})],
  ['field_map', () => ({})],
  ['has_color_total', false],
  ['has_size_total', false],
  ['size_encoding', ''],
  ['dedup_style_size', false],
  ['field_overrides', () => ({})],
  ['field_defaults', () => ({})],
  ['cleans', () => ({})],
  ['color_vocab', () => ({})],
  ['validators', () => ({})],
  ['date_format', ''],
  ['date_dayfirst', false],
];

/** Python json.dumps 的字符串转义（ensure_ascii=False：非 ASCII 字面保留，İ 不转义） */
function _pyJsonStr(s) {
  let out = '"';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (cp < 32) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/**
 * Python json.dumps(v, indent=2, ensure_ascii=False) 等价序列化：
 * 2 空格缩进逐层展开、空 dict/list 内联 {} / []、item 分隔 ',\n'、键值分隔 ': '。
 * 数字字段：PoRecipe 无数字字段，Number 用 String(v)（整数值浮点 repr 差异不受影响）。
 */
function _pyJsonDumps(v, level) {
  const pad = '  '.repeat(level);
  const padIn = '  '.repeat(level + 1);
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return _pyJsonStr(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map((x) => padIn + _pyJsonDumps(x, level + 1));
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    const items = keys.map((k) => padIn + _pyJsonStr(k) + ': ' + _pyJsonDumps(v[k], level + 1));
    return `{\n${items.join(',\n')}\n${pad}}`;
  }
  return String(v);
}

class PoRecipe {
  constructor(opts = {}) {
    if (opts === null || typeof opts !== 'object') opts = {};
    for (const [name, def] of _RECIPE_FIELDS) {
      this[name] = opts[name] !== undefined ? opts[name] : (typeof def === 'function' ? def() : def);
    }
  }

  /** 键序 = 字段声明序的 dict 快照 */
  _asDict() {
    const d = {};
    for (const [name] of _RECIPE_FIELDS) d[name] = this[name];
    return d;
  }

  /** Python json.dumps(self._asDict(), indent=2, ensure_ascii=False) 逐字节等价（oracle 2459 字符） */
  to_json() {
    return _pyJsonDumps(this._asDict(), 0);
  }

  /**
   * 反序列化 + legacy 键合并：
   *   value_clean: {field: {pat, repl}} → cleans[field] = [{pat, repl}]
   *   color_clean: {pat, repl}          → cleans.color   = [{pat, repl}]
   * legacy 键随后丢弃（oracle from_json_legacy）。
   */
  static from_json(s) {
    const data = JSON.parse(s);
    const d = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    const cleans = (d.cleans && typeof d.cleans === 'object' && !Array.isArray(d.cleans))
      ? { ...d.cleans } : {};
    if (d.value_clean && typeof d.value_clean === 'object' && !Array.isArray(d.value_clean)) {
      for (const [field, spec] of Object.entries(d.value_clean)) {
        if (spec && typeof spec === 'object' && !Array.isArray(spec)) cleans[field] = [spec];
      }
    }
    if (d.color_clean && typeof d.color_clean === 'object' && !Array.isArray(d.color_clean)) {
      cleans.color = [d.color_clean];
    }
    delete d.value_clean;
    delete d.color_clean;
    d.cleans = cleans;
    return new PoRecipe(d);
  }
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  // 常量
  LayoutType,
  _ENTITY_FIELDS,
  _FIELD_LABELS,
  _ROW_KEY_SEP,
  _INSEAM_SEP,
  // 类
  SizeQty,
  OrderLine,
  OrderEntity,
  PurchaseOrder,
  PoRecipe,
  // 模块级函数
  build_row_key,
  // 内部工具（供测试/后续模块复用）
  _color_combined: PurchaseOrder._color_combined,
  _colorCombined: PurchaseOrder._color_combined,
  _parseUnitPrice,
  _parseOverrideQty,
  _pySplit,
  _pyJsonDumps,
};
