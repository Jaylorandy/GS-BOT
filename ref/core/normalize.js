/**
 * ref/core/normalize.js — 业务字段归一与校验管线（复刻 Purchase Order Extractor V2 core/normalize.py）
 *
 * 逆向来源：tools/poe-reverse/dis/core/normalize.txt（4333 行反汇编，逐字节码还原）
 * 验证基准：ref/test/oracle_normalize.json（原版 normalize.pyc 直接采样生成）
 *
 * 管线语义（normalize_po 主流程 9 步）：
 *   [default]     po.apply_field_defaults(recipe)   —— 配方默认值回填（models.js 实现）
 *   [consolidate] 按 (po_no, style_no, destination) 归组实体
 *   [override]    po.apply_recipe_overrides(overrides)（传入时）
 *   [clean]       po.apply_value_clean(recipe)      —— 正则清洗（models.js 实现）
 *   [norm]        apply_normalizers —— recipe.cleans 规则驱动（type 键分派 _NORMALIZERS）
 *   [date]        _normalize_date_fields —— order_date / delivery_date 解析（歧义不落值）
 *   [hygiene]     _auto_clean —— 硬编码词表归一（代码/季节/币种/价格术语/运输方式/产地/港口/付款条件/行级）
 *   [warn]        validate_fields —— 4 校验器 + 行级对账
 *
 * 设计铁律（对齐原版 docstring）：
 *  - 归一由 recipe.cleans 的 {type} 键驱动，向后兼容 {pat,repl} 正则清洗
 *  - normalize_amount 遵循欧式数字规则（单分隔符+恰 2 位小数才视为小数，否则整段删除）
 *  - 日期解析三分支：date_format 精确 → 8 显式格式 → 6 数字格式收集候选；歧义不覆盖
 *  - 所有变化以 4 元组 (entity, field, old, new) 上报，校验警告追加 validation_warnings
 */

'use strict';

// ============================================================================
// 常量 —— 与原版模块级常量逐一对应（值取自 oracle_normalize.json）
// ============================================================================

/** 销售单位（SU）词表 */
const _SU_VOCAB = {
  PCS: 'PCS', PC: 'PCS', PCE: 'PCS', PCES: 'PCS', PIECE: 'PCS', PIECES: 'PCS', 'PCS.': 'PCS',
  SET: 'SET', SETS: 'SET', ST: 'SET',
  PR: 'PR', PRS: 'PR', PAIR: 'PR', PAIRS: 'PR',
  DZN: 'DZN', DOZ: 'DZN', DOZEN: 'DZN', DOZENS: 'DZN',
};

/** 币种词表 */
const _CURRENCY_VOCAB = {
  USD: 'USD', 'US$': 'USD', $: 'USD', 'U.S.DOLLAR': 'USD', 'U.S. DOLLAR': 'USD', 'US DOLLAR': 'USD', DOLLARS: 'USD',
  EUR: 'EUR', EURO: 'EUR', '€': 'EUR', EUROS: 'EUR',
  GBP: 'GBP', '£': 'GBP', STERLING: 'GBP',
  CNY: 'CNY', RMB: 'CNY', '¥': 'CNY', '￥': 'CNY',
  HKD: 'HKD', 'HK$': 'HKD',
  JPY: 'JPY', KRW: 'KRW', VND: 'VND', BDT: 'BDT', INR: 'INR', TRY: 'TRY', PLN: 'PLN', CHF: 'CHF', CAD: 'CAD',
};

/** 价格术语词表 */
const _PRICE_TERM_VOCAB = {
  FOB: 'FOB', 'FOB HK': 'FOB', 'FOB-HK': 'FOB', FOBHK: 'FOB', 'FOB HONG KONG': 'FOB', FOBHONGKONG: 'FOB',
  CIF: 'CIF',
  CFR: 'CFR', CNF: 'CFR', 'C&F': 'CFR', 'C&F HK': 'CFR',
  EXW: 'EXW', FCA: 'FCA', FAS: 'FAS', DDP: 'DDP', DDU: 'DDU', DAP: 'DAP', DAT: 'DAT', CPT: 'CPT', CIP: 'CIP',
};

/** 运输方式词表 */
const _SHIP_MODE_VOCAB = {
  SEA: 'SEA', 'BY SEA': 'SEA', OCEAN: 'SEA', 'SEA FREIGHT': 'SEA', SEAFREIGHT: 'SEA', 'SEA SHIPMENT': 'SEA',
  VESSEL: 'SEA', SHIP: 'SEA', BOAT: 'SEA',
  AIR: 'AIR', 'BY AIR': 'AIR', 'AIR FREIGHT': 'AIR', AIRFREIGHT: 'AIR', PLANE: 'AIR',
  COURIER: 'COURIER', EXPRESS: 'EXPRESS',
  TRUCK: 'TRUCK', 'BY TRUCK': 'TRUCK', ROAD: 'TRUCK',
  RAIL: 'RAIL', 'BY RAIL': 'RAIL', TRAIN: 'RAIL',
  COMBINED: 'COMBINED', MULTIMODAL: 'COMBINED',
};

/** 产地词表（映射为 ISO 2 位码） */
const _COUNTRY_VOCAB = {
  CHINA: 'CN', CN: 'CN', 'P.R.CHINA': 'CN', PRC: 'CN', 'P.R. CHINA': 'CN', "PEOPLE'S REPUBLIC OF CHINA": 'CN',
  'HONG KONG': 'HK', HK: 'HK', HONGKONG: 'HK', 'HONG KONG SAR': 'HK',
  VIETNAM: 'VN', VN: 'VN', 'VIET NAM': 'VN',
  BANGLADESH: 'BD', BD: 'BD',
  INDIA: 'IN', IN: 'IN',
  CAMBODIA: 'KH', KH: 'KH',
  TURKEY: 'TR', TR: 'TR', TURKIYE: 'TR',
  INDONESIA: 'ID', ID: 'ID',
  PAKISTAN: 'PK', PK: 'PK',
  THAILAND: 'TH', TH: 'TH',
  MYANMAR: 'MM', MM: 'MM',
  'SRI LANKA': 'LK', LK: 'LK',
  POLAND: 'PL', PL: 'PL',
  USA: 'US', US: 'US', 'U.S.A': 'US', 'U.S.A.': 'US', 'UNITED STATES': 'US', AMERICA: 'US',
  FRANCE: 'FR', FR: 'FR',
  GERMANY: 'DE', DE: 'DE',
  ITALY: 'IT', IT: 'IT',
  SPAIN: 'ES', ES: 'ES',
  'UNITED KINGDOM': 'GB', UK: 'GB', GB: 'GB', ENGLAND: 'GB',
};

/** 尺码词表 */
const _SIZE_VOCAB = {
  XS: 'XS', 'X-S': 'XS', 'X SMALL': 'XS', XSMALL: 'XS', 'EXTRA SMALL': 'XS',
  S: 'S', SMALL: 'S',
  M: 'M', MEDIUM: 'M', MED: 'M',
  L: 'L', LARGE: 'L', LGE: 'L',
  XL: 'XL', 'X-L': 'XL', 'X L': 'XL', 'EXTRA LARGE': 'XL', XLARGE: 'XL',
  XXL: 'XXL', '2XL': 'XXL', 'XX-L': 'XXL', '2X-L': 'XXL', 'DOUBLE XL': 'XXL',
  XXXL: 'XXXL', '3XL': 'XXXL', 'XXX-L': 'XXXL', '3X-L': 'XXXL',
};

/** 港口字段禁止词（命中即清空：运输方式误填进装/卸港） */
const _PORT_FORBIDDEN_SHIP_WORDS = [
  'AIR', 'AIR FREIGHT', 'AIRFREIGHT', 'BOAT', 'BY AIR', 'BY RAIL', 'BY SEA', 'BY TRUCK', 'COMBINED',
  'COURIER', 'EXPRESS', 'MULTIMODAL', 'OCEAN', 'OCEAN FREIGHT', 'PLANE', 'RAIL', 'ROAD', 'SEA',
  'SEA FREIGHT', 'SEA SHIPMENT', 'SEAFREIGHT', 'SHIP', 'TRAIN', 'TRUCK', 'VESSEL',
];

/** 显式日期格式（含英文月份缩写/全称） */
const _EXPLICIT_FORMATS = [
  '%Y-%m-%d', '%Y/%m/%d', '%d %b %Y', '%d %B %Y', '%b %d, %Y', '%B %d, %Y', '%d-%b-%Y', '%d-%B-%Y',
];

/** 数字日期格式（第二元素 = dayfirst 偏好标记） */
const _NUMERIC_FORMATS = [
  ['%d.%m.%Y', true],
  ['%m.%d.%Y', false],
  ['%d/%m/%Y', true],
  ['%m/%d/%Y', false],
  ['%d-%m-%Y', true],
  ['%m-%d-%Y', false],
];

/** 需要走日期归一/校验的字段 */
const _DATE_FIELDS = ['delivery_date', 'order_date'];

// ============================================================================
// 日期解析 —— Python strptime 等价子集（仅支持 _EXPLICIT/_NUMERIC 用到的指令）
// 关键语义（经原版 pyc + CPython 3.13 实测锁定）：
//   %Y 严格 4 位数字（'26-03-02' 因此无法解析，oracle 返回原值）
//   %d/%m 允许 1-2 位；%b/%B 大小写不敏感；格式中的空白匹配 \s+（'03Mar2026' 失败）
//   解析后按日历校验（Feb 30 → 失败）；年份须 1..9999
// ============================================================================

/** strptime 解析失败错误类型（对应 Python ValueError/TypeError 捕获点） */
class _StrptimeError extends Error {}

const _MONTH_ABBR_LC = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const _MONTH_FULL_LC = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Python strptime 等价解析：格式 → {y, m, d}，失败抛 _StrptimeError */
function _strptime(s, fmt) {
  const pat = ['^'];
  const groups = []; // [directive, groupIndex]
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '%') {
      const dir = fmt[i + 1];
      i += 1;
      if (dir === 'Y') { pat.push('(\\d{4})'); }
      else if (dir === 'm') { pat.push('(\\d{1,2})'); }
      else if (dir === 'd') { pat.push('(\\d{1,2})'); }
      else if (dir === 'b') { pat.push('(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'); }
      else if (dir === 'B') { pat.push('(January|February|March|April|May|June|July|August|September|October|November|December)'); }
      else throw new _StrptimeError(`unsupported directive %${dir}`);
      groups.push(dir);
    } else if (/\s/.test(ch)) {
      pat.push('\\s+');
    } else {
      pat.push(ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }
  pat.push('$');
  const m = new RegExp(pat.join(''), 'i').exec(s);
  if (!m) throw new _StrptimeError();

  let y = 0, mo = 0, d = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const raw = m[gi + 1];
    const dir = groups[gi];
    if (dir === 'Y') y = parseInt(raw, 10);
    else if (dir === 'm') mo = parseInt(raw, 10);
    else if (dir === 'd') d = parseInt(raw, 10);
    else if (dir === 'b') mo = _MONTH_ABBR_LC[raw.toLowerCase()];
    else if (dir === 'B') mo = _MONTH_FULL_LC[raw.toLowerCase()];
  }
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31) throw new _StrptimeError();
  // 日历校验（对齐 datetime(y,m,d) 的 ValueError）
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new _StrptimeError();
  }
  return { y, m: mo, d };
}

/** Python strftime('%Y-%m-%d') 等价 */
function _strftimeIso({ y, m, d }) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 日期解析三分支（原版 69-124 行）：
 *  date_format 有值 → 精确 strptime（失败静默落入下两分支）
 *  遍历 _EXPLICIT_FORMATS 逐一尝试，首个命中即返回 (iso, False)
 *  遍历 _NUMERIC_FORMATS 收集全部候选 (dt, df)；0 候选 → (None, False)；
 *  1 候选 → (iso, False)；多候选 → dayfirst 时取首个 df=True 候选，
 *  否则取首个候选并标 ambiguous=True。
 * @param {string} s
 * @param {string} [date_format]
 * @param {boolean} [dayfirst]
 * @returns {[string|null, boolean]} [iso, ambiguous]
 */
function _try_parse_date(s, date_format = '', dayfirst = false) {
  s = s ? String(s).trim() : '';
  if (!s) return [null, false];

  if (date_format) {
    try {
      return [_strftimeIso(_strptime(s, date_format)), false];
    } catch (e) {
      if (!(e instanceof _StrptimeError)) throw e;
    }
  }

  for (const fmt of _EXPLICIT_FORMATS) {
    try {
      return [_strftimeIso(_strptime(s, fmt)), false];
    } catch (e) {
      if (!(e instanceof _StrptimeError)) throw e;
    }
  }

  const cands = [];
  for (const [fmt, df] of _NUMERIC_FORMATS) {
    try {
      cands.push([_strptime(s, fmt), df]);
    } catch (e) {
      if (!(e instanceof _StrptimeError)) throw e;
    }
  }

  if (cands.length === 0) return [null, false];
  if (cands.length === 1) return [_strftimeIso(cands[0][0]), false];
  if (dayfirst) {
    // Python: next(c for c, df in cands if df) —— 无 df=True 候选时抛 StopIteration（忠实保留）
    const chosen = cands.find(([, df]) => df);
    if (chosen === undefined) throw new Error('StopIteration');
    return [_strftimeIso(chosen[0]), false];
  }
  return [_strftimeIso(cands[0][0]), true];
}

/** 歧义判定：解析失败 或 多候选歧义（_is_ambiguous_date） */
function _is_ambiguous_date(s, date_format = '', dayfirst = false) {
  const [norm, ambiguous] = _try_parse_date(s, date_format, dayfirst);
  return norm === null || ambiguous;
}

// ============================================================================
// 标量归一函数
// ============================================================================

/**
 * 金额归一（原版 136-185 行，欧式数字硬规则）：
 *  空 → ''；剥前缀 ^[^\d.,-]+；
 *  无双分隔符 → 原样返回；
 *  双分隔符（.和, 均出现）→ 取 rfind 靠后者为小数分隔符；
 *  单分隔符（仅 . 或仅 ,）→ 恰为 2 位小数（\.\d{2}$ 或 ,\d{2}$）且数量 1 才视为小数，
 *  否则整个删除该分隔符并立即返回（'26.000'→'26000'）；
 *  统一收尾：去千分位 → dec≠'.' 则替换为 '.' → 去尾部非 [\d.-] → 去头部非 [\d-]。
 * @param {string} s
 * @returns {string}
 */
function _normalize_amount(s) {
  s = String(s);
  if (!s || !s.trim()) return '';
  s = s.trim();
  s = s.replace(/^[^\d.,-]+/, '');

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (dots === 0 && commas === 0) return s;

  let dec_sep, thou_sep;
  if (dots >= 1 && commas >= 1) {
    const last_dot = s.lastIndexOf('.');
    const last_comma = s.lastIndexOf(',');
    if (last_comma > last_dot) { dec_sep = ','; thou_sep = '.'; }
    else { dec_sep = '.'; thou_sep = ','; }
  } else if (dots > 0) {
    if (/\.\d{2}$/.test(s) && dots === 1) { dec_sep = '.'; thou_sep = ''; }
    else return s.replace(/\./g, '');
  } else {
    if (/,\d{2}$/.test(s) && commas === 1) { dec_sep = ','; thou_sep = ''; }
    else return s.replace(/,/g, '');
  }

  s = s.split(thou_sep).join('');
  if (dec_sep !== '.') s = s.split(dec_sep).join('.');
  s = s.replace(/[^\d.-]+$/, '');
  s = s.replace(/^[^\d-]+/, '');
  return s;
}

/**
 * 日期归一（原版 187-201 行）：解析成功且无歧义 → ISO；失败或歧义 → 原值（strip 后）。
 * @param {string} s
 * @param {string} [date_format]
 * @param {boolean} [dayfirst]
 * @returns {string}
 */
function _normalize_date(s, date_format = '', dayfirst = false) {
  s = String(s);
  if (!s || !s.trim()) return '';
  s = s.trim();
  const [norm, ambiguous] = _try_parse_date(s, date_format, dayfirst);
  if (norm === null || ambiguous) return s;
  return norm;
}

/**
 * 词表归一（原版 203-216 行）：大小写不敏感精确匹配。
 * 先原键命中，再 lower 遍历；未命中返回原始 s（含空白）。
 * @param {string} s
 * @param {object} vocab
 * @returns {string}
 */
function _normalize_term(s, vocab) {
  s = String(s);
  if (!s || !vocab) return s;
  const key = s.trim();
  if (Object.prototype.hasOwnProperty.call(vocab, key)) return vocab[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(vocab)) {
    if (k.toLowerCase() === lower) return v;
  }
  return s;
}

/**
 * 颜色归一（原版 218-229 行）：按斜杠分隔（两侧允许空白）split，逐 token 过词表，' / ' 重连。
 * @param {string} s
 * @param {object} vocab
 * @returns {string}
 */
function _normalize_color(s, vocab) {
  s = String(s);
  if (!s || !vocab) return s;
  const parts = s.split(/\s*\/\s*/);
  for (let i = 0; i < parts.length; i++) parts[i] = _normalize_term(parts[i], vocab);
  return parts.join(' / ');
}

/**
 * 代码归一（原版 329-341 行）：去空白 + 大写。spec 参数仅占位。
 * @param {string} s
 * @param {object} [spec]
 * @returns {string}
 */
function _normalize_code(s, spec) {
  s = String(s);
  if (!s || !s.trim()) return '';
  s = s.trim();
  s = s.replace(/\s+/g, '');
  return s.toUpperCase();
}

/**
 * 季节归一（原版 343-360 行）：6 前缀替换（含斜杠与横线变体）→ 去空白 →
 * ^(SS|FW|AW|FA|SP|SU|HO)(\d{4})$ 命中则取前缀 + 年份后两位（'SS 2027'→'SS27'）。
 * @param {string} s
 * @param {object} [spec]
 * @returns {string}
 */
function _normalize_season(s, spec) {
  s = String(s);
  if (!s || !s.trim()) return '';
  s = s.trim().toUpperCase();
  s = s.replace(/S\/S/g, 'SS').replace(/F\/W/g, 'FW').replace(/A\/W/g, 'AW');
  s = s.replace(/S-S/g, 'SS').replace(/F-W/g, 'FW').replace(/A-W/g, 'AW');
  s = s.replace(/\s+/g, '');
  const m = /^(SS|FW|AW|FA|SP|SU|HO)(\d{4})$/.exec(s);
  if (m) return m[1] + m[2].slice(2);
  return s;
}

/**
 * 尺码归一（原版 362-373 行）：数字样式 \d[\d\s/.\-]* fullmatch → 去空白返回；
 * 否则 spec.get('vocab') or _SIZE_VOCAB 过词表。
 * @param {string} s
 * @param {object} [spec]
 * @returns {string}
 */
function _normalize_size(s, spec) {
  s = String(s);
  if (!s || !s.trim()) return '';
  s = s.trim().toUpperCase();
  if (/^\d[\d\s/.\-]*$/.test(s)) return s.replace(/\s+/g, '');
  const vocab = (spec || {}).vocab || _SIZE_VOCAB;
  return _normalize_term(s, vocab);
}

/**
 * 内长归一（原版 375-394 行）：剥 (INCHES|INCH|INS) / 引号 → 去空白 →
 * ^(\d+(?:\.\d+)?)IN$ → \1 → 纯数字原样 → L/M/S/R 原样 → 'LONG'→'L'。
 * @param {string} s
 * @param {object} [spec]
 * @returns {string}
 */
function _normalize_inseam(s, spec) {
  s = String(s);
  if (!s || !s.trim()) return '';
  s = s.trim().toUpperCase();
  s = s.replace(/(INCHES|INCH|INS)/g, '');
  s = s.replace(/"/g, '').replace(/'/g, '');
  s = s.replace(/\s+/g, '');
  s = s.replace(/^(\d+(?:\.\d+)?)IN$/, '$1');
  if (/^\d+(?:\.\d+)?$/.test(s)) return s;
  if (['L', 'M', 'S', 'R'].includes(s)) return s;
  if (s === 'LONG') return 'L';
  return s;
}

/**
 * 付款条件归一（原版 396-436 行）：压缩空白 + 大写 → 8 词序匹配 instrument →
 * 无 instrument 返回原值；天数先搜 (\d{1,3})\s*(?:DAYS?|D\b)，失败再搜 \b(\d{1,3})\b；
 * 有天数 → '{instrument} {days}D'，否则仅 instrument。
 * @param {string} s
 * @param {object} [spec]
 * @returns {string}
 */
function _normalize_payment_terms(s, spec) {
  s = String(s);
  if (!s || !s.trim()) return '';
  const raw = s.trim();
  const up = raw.toUpperCase().replace(/\s+/g, ' ');

  let instrument = null;
  if (/T\/?T/.test(up) || /\bTT\b/.test(up)) instrument = 'T/T';
  else if (/L\/?C/.test(up) || /\bLC\b/.test(up)) instrument = 'L/C';
  else if (/\bD\/?P\b/.test(up)) instrument = 'D/P';
  else if (/\bD\/?A\b/.test(up)) instrument = 'D/A';
  else if (/\bO\/?A\b/.test(up)) instrument = 'O/A';
  else if (/\bCAD\b/.test(up)) instrument = 'CAD';
  else if (/\bCOD\b/.test(up)) instrument = 'COD';
  else if (/\bCASH\b/.test(up)) instrument = 'CASH';
  if (instrument === null) return raw;

  let days = null;
  const m = /(\d{1,3})\s*(?:DAYS?|D\b)/.exec(up);
  if (m) days = m[1];
  else {
    const m2 = /\b(\d{1,3})\b/.exec(up);
    if (m2) days = m2[1];
  }
  if (days) return `${instrument} ${days}D`;
  return instrument;
}

// ============================================================================
// _NORMALIZERS 分派表 —— lambda 语义（v, r → fn(v, spec)），spec=rule dict
//   normalize_date / normalize_amount: 忽略 spec（单参）
//   normalize_term / normalize_color: spec.get('vocab') or {}
//   其余: 双参直传
// ============================================================================

const _NORMALIZERS = {
  normalize_date: (v, r) => _normalize_date(v),
  normalize_amount: (v, r) => _normalize_amount(v),
  normalize_term: (v, r) => _normalize_term(v, r.get('vocab') || {}),
  normalize_color: (v, r) => _normalize_color(v, r.get('vocab') || {}),
  normalize_code: (v, r) => _normalize_code(v, r),
  normalize_season: (v, r) => _normalize_season(v, r),
  normalize_size: (v, r) => _normalize_size(v, r),
  normalize_inseam: (v, r) => _normalize_inseam(v, r),
  normalize_payment_terms: (v, r) => _normalize_payment_terms(v, r),
};

// ============================================================================
// 工具函数（Python 语义等价）
// ============================================================================

/** hasattr 等价：原型链 in 检查 */
function _hasAttr(obj, name) {
  return name in Object(obj);
}

/** getattr(obj, name, default) 等价（含 falsy 兜底由调用方处理） */
function _getAttr(obj, name, def) {
  return obj[name] === undefined ? def : obj[name];
}

/** setattr 等价 */
function _setAttr(obj, name, value) {
  obj[name] = value;
}

/** Python str.rstrip(charset) 等价：剥尾部属于字符集的任意字符 */
function _rstripChars(s, chars) {
  const set = new Set(chars);
  let end = s.length;
  while (end > 0 && set.has(s[end - 1])) end -= 1;
  return s.slice(0, end);
}

/** Python len(str) 等价（按码点计，非 UTF-16 单元） */
function _pyLen(s) {
  return [...String(s)].length;
}

/** Python s[:29] 等价（按码点切片） */
function _pySlice29(s) {
  return [...String(s)].slice(0, 29).join('');
}

/** Python repr(str) 等价：单引号 + 转义反斜杠/引号/控制符；非 ASCII 可打印原样 */
function _pyRepr(v) {
  let out = "'";
  for (const ch of String(v)) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 32 || cp === 127) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + "'";
}

/** Python str(number) 等价：JS 最短往返 repr 与 Python 一致（整数值浮点差异可接受） */
function _pyStr(v) {
  return String(v);
}

/** Python round(x, 2) 等价（round-half-even，受浮点表示影响） */
function _pyRound2(x) {
  const v = x * 100;
  const fl = Math.floor(v);
  const frac = v - fl;
  if (frac < 0.5) return fl / 100;
  if (frac > 0.5) return (fl + 1) / 100;
  return (fl % 2 === 0 ? fl : fl + 1) / 100;
}

// ============================================================================
// 校验函数
// ============================================================================

/** positive_number 校验：_normalize_amount 后 float()>0，异常 → False */
function _check_positive(v) {
  const n = _normalize_amount(v);
  if (n === '') return false;
  const f = Number(n);
  if (Number.isNaN(f)) return false;
  return f > 0;
}

/** non_negative_int 校验：_normalize_amount 后 int(float())>=0，异常 → False */
function _check_non_negative_int(v) {
  const n = _normalize_amount(v);
  if (n === '') return false;
  const f = Number(n);
  if (Number.isNaN(f)) return false;
  return Math.trunc(f) >= 0;
}

/**
 * 校验警告追加（原版 448-462 行）：4 键 dict {entity, field, value:str, reason}；
 * 与既有警告完全相同（entity+field+value+reason 全等）则去重跳过；
 * po 缺 validation_warnings 属性时以 object.__setattr__ 语义补空列表；
 * AttributeError/TypeError 静默吞掉（返回 None）。
 */
function _append_warning(po, entity, field, value, reason) {
  const w = { entity, field, value: String(value), reason };
  try {
    if (!_hasAttr(po, 'validation_warnings')) po.validation_warnings = [];
    const existing = po.validation_warnings;
    for (const e of existing) {
      if (e.entity === entity && e.field === field
        && String(e.value) === String(value) && e.reason === reason) return;
    }
    existing.push(w);
  } catch (err) {
    if (err instanceof TypeError) return;
    throw err;
  }
}

/** 校验默认消息（原版 755-762 行） */
function _default_validation_message(vtype) {
  const map = {
    date_parseable: '无法解析为日期',
    positive_number: '值必须大于 0',
    not_empty: '字段不能为空',
    non_negative_int: '必须为非负整数',
    net_amount_consistent: '行金额对账不一致',
  };
  return map[vtype] || `校验失败: ${vtype}`;
}

/**
 * 行级校验（原版 730-763 行）：
 *  qty_safe<0 → '数量不能为负数，请人工确认'（value=str(qty)）
 *  net_amount 与 unit_price 均非 None → |round(unit_price*total_qty,2) - net|>0.5 →
 *  '行金额对账不一致，请人工确认'（value=f'{net} (计算={expected:.2f})'）
 */
function _validate_lines(po) {
  for (let ei = 0; ei < po.entities.length; ei++) {
    const ent = po.entities[ei];
    const elab = `E${ei + 1}`;
    for (let li = 0; li < ent.lines.length; li++) {
      const ln = ent.lines[li];
      const llab = `${elab}-L${li + 1}`;

      for (const sq of ln.sizes) {
        if (sq.qty_safe < 0) {
          _append_warning(po, llab, 'qty', String(sq.qty), '数量不能为负数，请人工确认');
        }
      }

      const net = _getAttr(ln, 'net_amount', null);
      if (net !== null && ln.unit_price !== null && ln.unit_price !== undefined) {
        const expected = _pyRound2(ln.unit_price * ln.total_qty);
        if (Math.abs(expected - net) > 0.5) {
          _append_warning(
            po, llab, 'net_amount',
            `${_pyStr(net)} (计算=${expected.toFixed(2)})`,
            '行金额对账不一致，请人工确认'
          );
        }
      }
    }
  }
}

/**
 * 字段校验（原版 662-709 行）：recipe.validators 规则驱动。
 * 4 校验器：date_parseable（可解析且非歧义）/ positive_number / not_empty / non_negative_int；
 * 非 dict 规则、未知 vtype 跳过；失败 → reason=rule.message or 默认 → _append_warning；
 * 最后 _validate_lines；返回 po.validation_warnings（hasattr 否则本地 warnings）。
 */
function validate_fields(po, recipe) {
  if (!recipe) return [];
  const validates_spec = _getAttr(recipe, 'validators', null) || {};
  if (typeof validates_spec !== 'object' || Array.isArray(validates_spec)) return [];
  const warnings = [];

  const dfmt = _getAttr(recipe, 'date_format', '') || '';
  const dfirst = Boolean(_getAttr(recipe, 'date_dayfirst', false));

  const _v_date_parseable = (v) => {
    const [norm, ambiguous] = _try_parse_date(v, dfmt, dfirst);
    return norm !== null && !ambiguous;
  };
  const _VALIDATOR_FUNCS = {
    date_parseable: _v_date_parseable,
    positive_number: (v) => _check_positive(v),
    not_empty: (v) => Boolean(v) && Boolean(String(v).trim()),
    non_negative_int: (v) => _check_non_negative_int(v),
  };

  for (let ei = 0; ei < po.entities.length; ei++) {
    const ent = po.entities[ei];
    const entity_label = `E${ei + 1}`;
    for (const [field_name, rules] of Object.entries(validates_spec)) {
      if (!Array.isArray(rules)) continue;
      const old = _getAttr(ent, field_name, '') || '';
      for (const rule of rules) {
        const vtype = (typeof rule === 'object' && rule !== null && !Array.isArray(rule) ? rule.get('type') : '') || '';
        if (!vtype || !(vtype in _VALIDATOR_FUNCS)) continue;
        const ok = _VALIDATOR_FUNCS[vtype](String(old));
        if (!ok) {
          const reason = (typeof rule === 'object' && rule !== null ? rule.get('message') : null) || _default_validation_message(vtype);
          _append_warning(po, entity_label, field_name, old, reason);
        }
      }
    }
  }

  _validate_lines(po);
  return _hasAttr(po, 'validation_warnings') ? po.validation_warnings : warnings;
}

// ============================================================================
// 日期字段归一（原版 464-498 行）
// ============================================================================

/**
 * 日期字段归一：PO order_date + 各实体 delivery_date。
 * 空值跳过；解析失败 → 警告 '无法解析为日期，请人工确认（Ship Date）'；
 * 歧义 → 警告 '日期格式歧义（日/月均≤12，无法判定 DD/MM 还是 MM/DD），请人工确认'；
 * 均不改写原值；解析成功且非歧义且变化 → setattr + 4 元组。
 * @returns {Array<[string, string, string, string]>}
 */
function _normalize_date_fields(po, recipe) {
  const changes = [];
  const dfmt = _getAttr(recipe, 'date_format', '') || '';
  const dfirst = Boolean(_getAttr(recipe, 'date_dayfirst', false));

  const _process = (target, label, fld) => {
    const old = _getAttr(target, fld, '') || '';
    if (!String(old).trim()) return;
    const [norm, ambiguous] = _try_parse_date(String(old), dfmt, dfirst);
    if (norm === null) {
      _append_warning(po, label, fld, old, '无法解析为日期，请人工确认（Ship Date）');
      return;
    }
    if (ambiguous) {
      _append_warning(po, label, fld, old, '日期格式歧义（日/月均≤12，无法判定 DD/MM 还是 MM/DD），请人工确认');
      return;
    }
    if (norm !== old) {
      _setAttr(target, fld, norm);
      changes.push([label, fld, old, norm]);
    }
  };

  _process(po, 'PO', 'order_date');
  po.entities.forEach((ent, ei) => _process(ent, `E${ei + 1}`, 'delivery_date'));
  return changes;
}

// ============================================================================
// 硬编码自动清洗（原版 503-576 行）
// ============================================================================

/**
 * _auto_clean —— 不依赖配方规则的固定归一：
 *  实体级：po_no/season/currency/price_term/ship_mode/country_of_origin 六字段词表归一；
 *          port_loading/port_discharge 命中 _PORT_FORBIDDEN_SHIP_WORDS → 清空；
 *          payment_terms 非空 → _normalize_payment_terms
 *  行级：  style_no(_normalize_code) / su(_SU_VOCAB) / inseam(_normalize_inseam) /
 *          sizes[].size(_normalize_size 单参 → 默认 _SIZE_VOCAB)
 * @returns {Array<[string, string, string, string]>}
 */
function _auto_clean(po, recipe) {
  const changes = [];
  for (let ei = 0; ei < po.entities.length; ei++) {
    const ent = po.entities[ei];
    const label = `E${ei + 1}`;

    // 实体级六字段词表归一（old 从 ent 读取；new 直接用 ent 属性计算，语义等价）
    const pairs = [
      ['po_no', _normalize_code(ent.po_no)],
      ['season', _normalize_season(ent.season)],
      ['currency', _normalize_term(ent.currency, _CURRENCY_VOCAB)],
      ['price_term', _normalize_term(ent.price_term, _PRICE_TERM_VOCAB)],
      ['ship_mode', _normalize_term(ent.ship_mode, _SHIP_MODE_VOCAB)],
      ['country_of_origin', _normalize_term(ent.country_of_origin, _COUNTRY_VOCAB)],
    ];
    for (const [fld, newVal] of pairs) {
      const old = _getAttr(ent, fld, '') || '';
      if (newVal !== old) {
        _setAttr(ent, fld, newVal);
        changes.push([label, fld, old, newVal]);
      }
    }

    // 港口字段：运输方式词误填 → 清空
    for (const fld of ['port_loading', 'port_discharge']) {
      const raw = (_getAttr(ent, fld, '') || '').trim();
      if (raw && _PORT_FORBIDDEN_SHIP_WORDS.includes(raw.toUpperCase())) {
        _setAttr(ent, fld, '');
        changes.push([label, fld, raw, '']);
      }
    }

    // 付款条件
    if (((ent.payment_terms || '')).trim()) {
      const newVal = _normalize_payment_terms(ent.payment_terms);
      if (newVal !== ent.payment_terms) {
        changes.push([label, 'payment_terms', ent.payment_terms, newVal]);
        ent.payment_terms = newVal;
      }
    }

    // 行级
    for (let li = 0; li < ent.lines.length; li++) {
      const ln = ent.lines[li];
      const llab = `${label}-L${li + 1}`;

      const styleOld = ln.style_no || '';
      const styleNew = _normalize_code(styleOld);
      if (styleNew !== styleOld) {
        ln.style_no = styleNew;
        changes.push([llab, 'style_no', styleOld, styleNew]);
      }

      const suOld = ln.su || '';
      const suNew = _normalize_term(suOld, _SU_VOCAB);
      if (suNew !== suOld) {
        ln.su = suNew;
        changes.push([llab, 'su', suOld, suNew]);
      }

      const inseamOld = ln.inseam || '';
      const inseamNew = _normalize_inseam(inseamOld);
      if (inseamNew !== inseamOld) {
        ln.inseam = inseamNew;
        changes.push([llab, 'inseam', inseamOld, inseamNew]);
      }

      for (const sq of ln.sizes) {
        const sizeOld = sq.size || '';
        const sizeNew = _normalize_size(sizeOld);
        if (sizeNew !== sizeOld) {
          sq.size = sizeNew;
          changes.push([llab, 'size', sizeOld, sizeNew]);
        }
      }
    }
  }
  return changes;
}

// ============================================================================
// 配方规则归一（原版 595-655 行）
// ============================================================================

/**
 * apply_normalizers —— recipe.cleans 规则驱动（含 color 特殊路径）。
 * 常规字段：跳过 color；rules 需 list、spec 需 dict、ntype 需在 _NORMALIZERS；
 * normalize_date 走 recipe.date_format/date_dayfirst，其余 _NORMALIZERS[ntype](str(old), spec)；
 * color 独立：combined = "{code} / {desc}".rstrip(' /')（desc 空再 rstrip 一次）→
 * _normalize_color(combined, spec.vocab or {}) → split(' / ', 1) 回写 code/desc。
 * @returns {Array<[string, string, string, string]>}
 */
function apply_normalizers(po, recipe) {
  if (!recipe) return [];
  const cleans = _getAttr(recipe, 'cleans', null) || {};
  const changes = [];

  for (let ei = 0; ei < po.entities.length; ei++) {
    const ent = po.entities[ei];
    const entity_label = `E${ei + 1}`;

    for (const [field_name, rules] of Object.entries(cleans)) {
      if (field_name === 'color') continue;
      if (!Array.isArray(rules)) continue;
      for (const spec of rules) {
        if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) continue;
        const ntype = spec.get('type') || '';
        if (!ntype || !(ntype in _NORMALIZERS)) continue;
        const old = _getAttr(ent, field_name, '') || '';
        let newVal;
        if (ntype === 'normalize_date') {
          newVal = _normalize_date(String(old), recipe.date_format, recipe.date_dayfirst);
        } else {
          newVal = _NORMALIZERS[ntype](String(old), spec);
        }
        if (newVal !== old) {
          _setAttr(ent, field_name, newVal);
          changes.push([entity_label, field_name, old, newVal]);
        }
      }
    }

    // color 特殊路径
    if (Object.prototype.hasOwnProperty.call(cleans, 'color') && Array.isArray(cleans.color)) {
      for (const spec of cleans.color) {
        if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) continue;
        const ntype = spec.get('type') || '';
        if (ntype !== 'normalize_color') continue;
        const vocab = spec.get('vocab') || {};

        for (let li = 0; li < ent.lines.length; li++) {
          const ln = ent.lines[li];
          let combined = `${ln.color_code || ''} / ${ln.color_desc || ''}`;
          combined = _rstripChars(combined, ' /');
          if (!ln.color_desc) combined = _rstripChars(combined, ' /');
          const new_combined = _normalize_color(combined, vocab);
          if (new_combined !== combined) {
            const idx = new_combined.indexOf(' / ');
            const parts = idx === -1 ? [new_combined] : [new_combined.slice(0, idx), new_combined.slice(idx + 3)];
            ln.color_code = parts[0];
            ln.color_desc = parts.length > 1 ? parts[1] : '';
            changes.push([`${entity_label}-L${li + 1}`, 'color', combined, new_combined]);
          }
        }
      }
    }
  }
  return changes;
}

// ============================================================================
// 归并（原版 769-820 行）
// ============================================================================

/**
 * 按 (po_no, style_no, destination) 归并实体：
 *  header-only 实体（lines 空）单独保留；key = ((po_no or '').strip().upper(),
 *  (line.style_no or '').strip().upper(), destination_code or '')；
 *  新 key → dataclasses.replace(ent, lines=[])（JS：浅拷贝 + 空 lines）并回写
 *  key 的 style_no/destination_code；行按 key 归组 append；
 *  po.entities = 按序分组 + header_only；entity_index 按 enumerate 重置（0 基）；
 *  @returns {number} 新实体数
 */
function consolidate_entities_by_style_dest(po) {
  const groups = new Map();
  const order = [];
  const header_only_entities = [];

  for (const ent of po.entities) {
    if (!ent.lines || ent.lines.length === 0) {
      header_only_entities.push(ent);
      continue;
    }
    const dest = ent.destination_code || '';
    for (const ln of ent.lines) {
      const key = [
        String(ent.po_no || '').trim().toUpperCase(),
        String(ln.style_no || '').trim().toUpperCase(),
        dest,
      ];
      let g = groups.get(key);
      if (g === undefined) {
        g = { ...ent, lines: [] };
        g.style_no = key[1];
        g.destination_code = key[2];
        groups.set(key, g);
        order.push(key);
      }
      g.lines.push(ln);
    }
  }

  po.entities = order.map((k) => groups.get(k)).concat(header_only_entities);
  po.entities.forEach((e, i) => { e.entity_index = i; });
  return po.entities.length;
}

// ============================================================================
// 主流程（原版 823-889 行）
// ============================================================================

/**
 * normalize_po —— 归一总入口，返回 log_lines。
 * 步骤：默认值回填 → 归并 → 配方覆盖（传入时）→ 正则清洗 → 规则归一 →
 * 日期归一 → 硬编码清洗 → 校验；变化日志 5 类前缀，>32 字符截 29+…，repr 语义。
 * @param {object} po PurchaseOrder 或鸭子对象
 * @param {object} recipe PoRecipe 或鸭子对象
 * @param {object|null} [overrides] 配方覆盖 dict
 * @returns {string[]}
 */
function normalize_po(po, recipe, overrides = null) {
  const log_lines = [];

  // [default] —— apply_field_defaults 返回 string 列表
  if (_hasAttr(po, 'apply_field_defaults')) {
    const ch = po.apply_field_defaults(recipe) || [];
    for (const c of ch) log_lines.push(`[default] ${c}`);
  }

  // 归并
  const n_before = po.entities.length;
  consolidate_entities_by_style_dest(po);
  if (po.entities.length !== n_before) {
    log_lines.push(`[consolidate] ${n_before} -> ${po.entities.length} entities (style x destination)`);
  }

  // 配方覆盖
  if (overrides && _hasAttr(po, 'apply_recipe_overrides')) {
    po.apply_recipe_overrides(overrides);
  }

  // [clean] —— apply_value_clean 返回 string 列表
  if (_hasAttr(po, 'apply_value_clean')) {
    const ch = po.apply_value_clean(recipe) || [];
    for (const c of ch) log_lines.push(`[clean] ${c}`);
  }

  // [norm] —— 规则归一
  for (const [ent, fld, old, newVal] of apply_normalizers(po, recipe)) {
    const o = _pyLen(old) <= 32 ? old : `${_pySlice29(old)}…`;
    const n = _pyLen(newVal) <= 32 ? newVal : `${_pySlice29(newVal)}…`;
    log_lines.push(`[norm] ${ent}:${fld}: ${_pyRepr(o)} → ${_pyRepr(n)}`);
  }

  // [date] —— 日期字段归一
  for (const [ent, fld, old, newVal] of _normalize_date_fields(po, recipe)) {
    const o = _pyLen(old) <= 32 ? old : `${_pySlice29(old)}…`;
    const n = _pyLen(newVal) <= 32 ? newVal : `${_pySlice29(newVal)}…`;
    log_lines.push(`[date] ${ent}:${fld}: ${_pyRepr(o)} → ${_pyRepr(n)}`);
  }

  // [hygiene] —— 硬编码清洗
  for (const [ent, fld, old, newVal] of _auto_clean(po, recipe)) {
    const o = _pyLen(old) <= 32 ? old : `${_pySlice29(old)}…`;
    const n = _pyLen(newVal) <= 32 ? newVal : `${_pySlice29(newVal)}…`;
    log_lines.push(`[hygiene] ${ent}:${fld}: ${_pyRepr(o)} → ${_pyRepr(n)}`);
  }

  // 校验
  validate_fields(po, recipe);
  for (const w of _getAttr(po, 'validation_warnings', [])) {
    log_lines.push(`[warn] ${w.entity}:${w.field} = ${_pyRepr(w.value)} → ${w.reason}`);
  }

  return log_lines;
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  // 常量
  _SU_VOCAB,
  _CURRENCY_VOCAB,
  _PRICE_TERM_VOCAB,
  _SHIP_MODE_VOCAB,
  _COUNTRY_VOCAB,
  _SIZE_VOCAB,
  _PORT_FORBIDDEN_SHIP_WORDS,
  _EXPLICIT_FORMATS,
  _NUMERIC_FORMATS,
  _DATE_FIELDS,
  _NORMALIZERS,
  // 日期
  _strptime,
  _try_parse_date,
  _is_ambiguous_date,
  // 标量归一
  _normalize_amount,
  _normalize_date,
  _normalize_term,
  _normalize_color,
  _normalize_code,
  _normalize_season,
  _normalize_size,
  _normalize_inseam,
  _normalize_payment_terms,
  // 校验
  _check_positive,
  _check_non_negative_int,
  _default_validation_message,
  _validate_lines,
  // 编排
  _append_warning,
  _normalize_date_fields,
  _auto_clean,
  apply_normalizers,
  validate_fields,
  consolidate_entities_by_style_dest,
  normalize_po,
  // 工具（供测试/后续模块复用）
  _hasAttr,
  _getAttr,
  _setAttr,
  _pyRepr,
  _pyLen,
  _pySlice29,
  _pyStr,
  _pyRound2,
};
