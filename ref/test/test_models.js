#!/usr/bin/env node
/**
 * test_models.js — 校验 ref/core/models.js 与原版 models.pyc oracle 输出一致。
 *
 * 覆盖 3 个 oracle 真值文件的全量键：
 *   oracle_models.json       — LayoutType、dataclass_fields×5、sample、qty_safe、
 *                               build_row_key、_color_combined、overrides_a–k、
 *                               field_defaults、value_clean×4、clean_field×4、
 *                               clean_color×3、to_json、from_json_roundtrip、from_json_legacy
 *   oracle_models_extra.json — A_sizes_merge、B_price×4、C_header_generic、
 *                               D_su×2、E_defaults_line、F×2、G_qty_safe、H×2、I_ent1
 *   probe_oracle.json        — P1×5、P2×2、P3_line_price、P4×2
 *
 * 风格对齐 test_normalize.js：deepEqual + ok/FAIL + fail 计数 + process.exit。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const M = require('../core/models');

const oracle = JSON.parse(fs.readFileSync(path.join(__dirname, 'oracle_models.json'), 'utf8'));
const oracleExtra = JSON.parse(fs.readFileSync(path.join(__dirname, 'oracle_models_extra.json'), 'utf8'));
const probe = JSON.parse(fs.readFileSync(path.join(__dirname, 'probe_oracle.json'), 'utf8'));

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { fail++; console.log(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
};

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  return false;
}

// ── make_po（oracle_models.py 精确复刻）──────────────────────────────────
function make_po() {
  return new M.PurchaseOrder({
    customer: 'LPP SA',
    source_file: 'PO_637JO_2627182_2026-01-15.pdf',
    source_file_path: 'C:\\fake dir\\PO_637JO_2627182_2026-01-15.pdf',
    order_date: '2026-01-15',
    per_destination: false,
    fingerprint: 'FP123',
    entities: [
      new M.OrderEntity({
        entity_index: 0, po_no: '11321589', channel: 'STANDARD', season: 'SS26',
        delivery_date: '2026-03-02', destination_code: '', packing_method: 'MULTIPACK',
        wash_method: '', washing_color: '', payment_terms: 'TT HSBC 180 Days',
        price_term: 'FOB', currency: 'USD', size_scale: 'ALPHA', product_group: 'C_trousers',
        age_sex_desc: 'MENS', product_desc: "MEN'S TROUSERS",
        port_loading: 'Sihanoukville', port_discharge: 'Gdynia', ship_mode: 'Sea',
        vendor_name: 'Gs Global Sourcing Co.,Ltd', agent_name: '', import_po_no: '',
        reference_no: '', cir_no: '', freight_terms: '', country_of_origin: '', dc_address: '',
        lines: [
          new M.OrderLine({
            style_no: '637JO', color_code: '80X', color_desc: 'BEIGE', inseam: '',
            su: 'PCS', unit_price: 10.2,
            sizes: [new M.SizeQty({ size: 'S', qty: 744 }), new M.SizeQty({ size: 'M', qty: 500 })],
          }),
          new M.OrderLine({
            style_no: '637JO', color_code: '90Z', color_desc: 'BLACK', inseam: '30',
            su: 'PR', unit_price: 8.5,
            sizes: [new M.SizeQty({ size: 'S', qty: 200 }), new M.SizeQty({ size: 'L', qty: 'abc' })],
          }),
        ],
        printed_size_totals: {}, printed_total_qty: null, printed_total_amount: null,
        extra: {},
      }),
    ],
  });
}

// ── make_po_probe（probe_oracle.py 精确复刻）─────────────────────────────
function make_po_probe() {
  return new M.PurchaseOrder({
    customer: 'LPP SA', source_file: 'f.pdf', source_file_path: 'C:\\f.pdf',
    order_date: '', per_destination: false, fingerprint: 'FP',
    entities: [
      new M.OrderEntity({
        entity_index: 0, po_no: '11321589',
        lines: [
          new M.OrderLine({
            style_no: '637JO', color_code: '80X', color_desc: 'BEIGE', inseam: '',
            su: 'PCS', unit_price: 10.2,
            sizes: [new M.SizeQty({ size: 'S', qty: 744 }), new M.SizeQty({ size: 'M', qty: 500 })],
          }),
          new M.OrderLine({
            style_no: '637JO', color_code: '90Z', color_desc: 'BLACK', inseam: '30',
            su: 'PR', unit_price: 8.5,
            sizes: [new M.SizeQty({ size: 'S', qty: 200 }), new M.SizeQty({ size: 'L', qty: 'abc' })],
          }),
        ],
      }),
    ],
  });
}

// ── dump helpers（与 oracle 捕获脚本一致）──────────────────────────────
function dumpPoState(po) {
  return { customer: po.customer, pairs: po._cleanable_pairs() };
}

function lineState(po, ent = 0, ln = 1) {
  const l = po.entities[ent].lines[ln];
  return {
    style_no: l.style_no, color_code: l.color_code, color_desc: l.color_desc,
    inseam: l.inseam, su: l.su, unit_price: l.unit_price,
    printed_row_total: l.printed_row_total, net_amount: l.net_amount,
    sizes: l.sizes.map(sq => [sq.size, sq.qty]),
  };
}

const _ENT_STATE_FIELDS = [
  'entity_index', 'style_no', 'po_no', 'channel', 'delivery_date', 'destination_code',
  'packing_method', 'wash_method', 'washing_color', 'payment_terms', 'price_term',
  'currency', 'size_scale', 'product_group', 'age_sex_desc', 'product_desc', 'season',
  'port_loading', 'port_discharge', 'ship_mode', 'vendor_name', 'agent_name',
  'import_po_no', 'reference_no', 'cir_no', 'freight_terms', 'country_of_origin', 'dc_address',
];

function entState(po, ent = 0) {
  const e = po.entities[ent];
  const out = {};
  for (const f of _ENT_STATE_FIELDS) out[f] = e[f];
  return out;
}

// ============================================================================
// 1. LayoutType
// ============================================================================
console.log('== LayoutType ==');
ok(deepEqual(M.LayoutType, oracle.LayoutType), 'LayoutType 14 值深比较一致');

// ============================================================================
// 2. dataclass_fields × 5
// ============================================================================
console.log('== dataclass_fields ==');

function checkFields(clsName, cls, oracleFields) {
  const inst = new cls();
  const jsNames = Object.keys(inst);
  const orcNames = oracleFields.map(f => f.name);
  ok(deepEqual(jsNames, orcNames), `${clsName} 字段名序一致 (${jsNames.length} 字段)`);

  for (let i = 0; i < oracleFields.length; i++) {
    const f = oracleFields[i];
    const jsVal = inst[f.name];
    if (f.factory === 'list') {
      ok(Array.isArray(jsVal) && jsVal.length === 0, `${clsName}.${f.name} 默认值 = [] (factory=list)`);
    } else if (f.factory === 'dict') {
      ok(typeof jsVal === 'object' && jsVal !== null && !Array.isArray(jsVal) && Object.keys(jsVal).length === 0, `${clsName}.${f.name} 默认值 = {} (factory=dict)`);
    } else {
      ok(deepEqual(jsVal, f.default), `${clsName}.${f.name} 默认值 = ${JSON.stringify(f.default)}`);
    }
  }
}

checkFields('SizeQty', M.SizeQty, oracle.dataclass_fields.SizeQty);
checkFields('OrderLine', M.OrderLine, oracle.dataclass_fields.OrderLine);
checkFields('OrderEntity', M.OrderEntity, oracle.dataclass_fields.OrderEntity);
checkFields('PurchaseOrder', M.PurchaseOrder, oracle.dataclass_fields.PurchaseOrder);
checkFields('PoRecipe', M.PoRecipe, oracle.dataclass_fields.PoRecipe);

// ============================================================================
// 3. sample
// ============================================================================
console.log('== sample ==');

const samplePO = make_po();
const tbr = samplePO.template_b_rows(2, 'Y', 'B2026-01');
ok(tbr.length === oracle.sample.template_b_rows.length, `template_b_rows 行数 = ${oracle.sample.template_b_rows.length}`);
for (let i = 0; i < tbr.length; i++) {
  ok(deepEqual(tbr[i], oracle.sample.template_b_rows[i]), `template_b_rows[${i}] 逐键一致`);
}

ok(make_po().total_qty === oracle.sample.total_qty, `total_qty = ${oracle.sample.total_qty}`);
ok(deepEqual(make_po().size_totals(), oracle.sample.size_totals), 'size_totals 一致');
ok(deepEqual(make_po().color_totals(), oracle.sample.color_totals), 'color_totals 一致');

// ============================================================================
// 4. qty_safe
// ============================================================================
console.log('== qty_safe ==');
ok(new M.SizeQty({ size: 'S', qty: 5 }).qty_safe === oracle.qty_safe['int 5'], 'qty_safe int 5 → 5');
ok(new M.SizeQty({ size: 'S', qty: '5' }).qty_safe === oracle.qty_safe['str 5'], 'qty_safe str 5 → 5');
ok(new M.SizeQty({ size: 'S', qty: 'abc' }).qty_safe === oracle.qty_safe['abc'], 'qty_safe abc → 0');
ok(new M.SizeQty({ size: 'S', qty: null }).qty_safe === oracle.qty_safe['None'], 'qty_safe None → 0');
ok(new M.SizeQty({ size: 'S', qty: 5.7 }).qty_safe === oracle.qty_safe['float 5.7'], 'qty_safe float 5.7 → 5');

// ============================================================================
// 5. build_row_key
// ============================================================================
console.log('== build_row_key ==');
ok(M.build_row_key('LPP SA', '11321589', '637JO', '80X', 'S', '', '') === oracle.build_row_key['full'], 'build_row_key full');
ok(M.build_row_key('A', 'B', 'C', 'D', 'E', 'F', 'G') === oracle.build_row_key['with_inseam_dest'], 'build_row_key with_inseam_dest');
ok(M.build_row_key('', '', '', '', '', '', '') === oracle.build_row_key['empty'], 'build_row_key empty');
ok(M.build_row_key(null, 'B', null, 'D', 'E', '', null) === oracle.build_row_key['none_as_falsy'], 'build_row_key none_as_falsy');

// ============================================================================
// 6. _color_combined
// ============================================================================
console.log('== _color_combined ==');
ok(M._color_combined('80X', 'BEIGE') === oracle._color_combined['both'], '_color_combined both');
ok(M._color_combined('80X', '') === oracle._color_combined['code_only'], '_color_combined code_only');
ok(M._color_combined('', 'BEIGE') === oracle._color_combined['desc_only'], '_color_combined desc_only');
ok(M._color_combined('', '') === oracle._color_combined['none'], '_color_combined none');
ok(M._color_combined(null, null) === oracle._color_combined['none2'], '_color_combined none2');

// ============================================================================
// 7. overrides a–k
// ============================================================================
console.log('== overrides ==');

function testOverride(key, overridesInput) {
  const po = make_po();
  let ret;
  try {
    ret = po.apply_recipe_overrides(overridesInput);
  } catch (e) {
    ok(false, `${key} 不应抛异常 (${e.message})`);
    return;
  }
  const orc = oracle[key];
  const normRet = ret === undefined ? null : ret;
  if (orc.error !== undefined) {
    ok(orc.error === null, `${key} error=null (不抛异常)`);
  }
  if (orc.ret !== undefined) {
    ok(normRet === orc.ret, `${key} ret = ${JSON.stringify(orc.ret)}`);
  }
  if (orc.state) {
    ok(deepEqual(dumpPoState(po), orc.state), `${key} state 一致`);
  }
}

testOverride('overrides_a', { color_edits: '{"80X / BEIGE": "85X / IVORY"}' });
testOverride('overrides_b', { color_edits: '{"80X / BEIGE": "NATURAL"}' });
testOverride('overrides_c', { customer: 'NEW CUST', style_no: '12345', unit_price: '12,50', su: 'PCS', currency: 'EUR' });
testOverride('overrides_d', { unit_price: 'abc' });
testOverride('overrides_e', { __ent_overrides__: { '0': { po_no: '999', style_no: 'NEWSTYLE' } } });
testOverride('overrides_f', { __ent_overrides__: { '9': { po_no: 'X' }, bad: { po_no: 'Y' } } });
testOverride('overrides_g', { __line_overrides__: { '90Z / BLACK': { unit_price: '9.99', inseam: '32', su: 'PR', style_no: '637JO2' } } });
testOverride('overrides_h', { __line_overrides__: { '90Z': { sizes: { S: '250', M: '3,000' }, inseam: '28', su: 'SET' } } });
testOverride('overrides_i', { __line_overrides__: { '90Z / BLACK\u241f30': { unit_price: '7.77' } } });
testOverride('overrides_j', { color_edits: { '80X / BEIGE': 'NATURAL' } });
testOverride('overrides_k', null);

// ============================================================================
// 8. field_defaults
// ============================================================================
console.log('== field_defaults ==');

const fdPO = make_po();
const fdRecipe = new M.PoRecipe({ field_defaults: { currency: 'EUR', payment_terms: 'CAD 30D' } });
const fdChanges = fdPO.apply_field_defaults(fdRecipe);
ok(deepEqual(fdChanges, oracle.field_defaults.changes), 'field_defaults changes 一致');
ok(deepEqual(dumpPoState(fdPO), oracle.field_defaults.state), 'field_defaults state 一致');

const fdNonePO = make_po();
ok(deepEqual(fdNonePO.apply_field_defaults(null), oracle.field_defaults_none), 'field_defaults(None) = []');

// ============================================================================
// 9. value_clean
// ============================================================================
console.log('== value_clean ==');

const vcPO = make_po();
const vcRecipe = new M.PoRecipe({ cleans: { currency: [{ pat: 'USD', repl: 'US$' }], payment_terms: [{ pat: '\\d+D', repl: '' }] } });
const vcChanges = vcPO.apply_value_clean(vcRecipe);
ok(deepEqual(vcChanges, oracle.value_clean.changes), 'value_clean changes 一致');
ok(deepEqual(dumpPoState(vcPO), oracle.value_clean.state), 'value_clean state 一致');

const vcBadPO = make_po();
const vcBadRecipe = new M.PoRecipe({ cleans: { currency: [{ pat: '(', repl: 'X' }] } });
const vcBadRet = vcBadPO.apply_value_clean(vcBadRecipe);
ok(deepEqual(vcBadRet, oracle.value_clean_badpat.ret), 'value_clean_badpat ret = []');
ok(deepEqual(dumpPoState(vcBadPO), oracle.value_clean_badpat.state), 'value_clean_badpat state 一致');

const vcColorPO = make_po();
const vcColorRecipe = new M.PoRecipe({ cleans: { color: [{ pat: 'BEIGE', repl: 'IVORY' }] } });
const vcColorChanges = vcColorPO.apply_value_clean(vcColorRecipe);
ok(deepEqual(vcColorChanges, oracle.value_clean_color.changes), 'value_clean_color changes 一致');
ok(deepEqual(dumpPoState(vcColorPO), oracle.value_clean_color.state), 'value_clean_color state 一致');

const vcSkipPO = make_po();
const vcSkipRecipe = new M.PoRecipe({ cleans: { currency: 'not-a-list', price_term: [42] } });
const vcSkipRet = vcSkipPO.apply_value_clean(vcSkipRecipe);
ok(deepEqual(vcSkipRet, oracle.value_clean_skip.ret), 'value_clean_skip ret = []');
ok(deepEqual(dumpPoState(vcSkipPO), oracle.value_clean_skip.state), 'value_clean_skip state 一致');

// ============================================================================
// 10. _clean_field × 4
// ============================================================================
console.log('== _clean_field ==');

const cf1PO = make_po();
const cf1Ret = cf1PO._clean_field('currency', 'USD', 'US$');
ok(cf1Ret === oracle.clean_field_currency.ret, 'clean_field_currency ret = null');
ok(deepEqual(dumpPoState(cf1PO), oracle.clean_field_currency.state), 'clean_field_currency state 一致');

const cf2PO = make_po();
const cf2Ret = cf2PO._clean_field('customer', 'LPP', 'NEW');
ok(cf2Ret === oracle.clean_field_customer.ret, 'clean_field_customer ret = null');
ok(deepEqual(dumpPoState(cf2PO), oracle.clean_field_customer.state), 'clean_field_customer state 一致');

const cf3PO = make_po();
const cf3Ret = cf3PO._clean_field('style_no', '637JO', '9999');
ok(cf3Ret === oracle.clean_field_style.ret, 'clean_field_style ret = null');
ok(deepEqual(dumpPoState(cf3PO), oracle.clean_field_style.state), 'clean_field_style state 一致');

const cf4PO = make_po();
const cf4Ret = cf4PO._clean_field('not_a_field', 'X', 'Y');
ok(cf4Ret === oracle.clean_field_unknown.ret, 'clean_field_unknown ret = null');
ok(deepEqual(dumpPoState(cf4PO), oracle.clean_field_unknown.state), 'clean_field_unknown state 一致');

// ============================================================================
// 11. _clean_color × 3
// ============================================================================
console.log('== _clean_color ==');

const cc1PO = make_po();
const cc1Ret = cc1PO._clean_color('BEIGE', 'IVORY');
ok(cc1Ret === oracle.clean_color_desc.ret, 'clean_color_desc ret = null');
ok(deepEqual(dumpPoState(cc1PO), oracle.clean_color_desc.state), 'clean_color_desc state 一致');

const cc2PO = make_po();
const cc2Ret = cc2PO._clean_color('(80X|90Z)', '0');
ok(cc2Ret === oracle.clean_color_code_only.ret, 'clean_color_code_only ret = null');
ok(deepEqual(dumpPoState(cc2PO), oracle.clean_color_code_only.state), 'clean_color_code_only state 一致');

const cc3PO = make_po();
const cc3Ret = cc3PO._clean_color('80X / BEIGE', '55X / TAUPE');
ok(cc3Ret === oracle.clean_color_split.ret, 'clean_color_split ret = null');
ok(deepEqual(dumpPoState(cc3PO), oracle.clean_color_split.state), 'clean_color_split state 一致');

// ============================================================================
// 12. to_json（逐字节比较）
// ============================================================================
console.log('== to_json ==');

const recipeForJson = new M.PoRecipe({
  fingerprint: 'F1', customer: 'LPP SA', layout_type: 'line_items',
  po_no_anchor: 'ORDER NO[.\\s:]+(\\S+)', has_inseam: true,
  line_field_map: { style_no: 'A' }, field_defaults: { currency: 'EUR' },
  cleans: { currency: [{ pat: 'USD', repl: 'US$' }] },
  color_vocab: { '80X': '80X' }, validators: {}, date_format: '%Y-%m-%d',
});
const jsonStr = recipeForJson.to_json();
ok(jsonStr === oracle.to_json, `to_json 逐字节一致 (${jsonStr.length} chars)`);

// ============================================================================
// 13. from_json_roundtrip
// ============================================================================
console.log('== from_json_roundtrip ==');

const r2 = M.PoRecipe.from_json(oracle.to_json);
for (const [field, expected] of Object.entries(oracle.from_json_roundtrip)) {
  ok(deepEqual(r2[field], expected), `from_json_roundtrip.${field} 一致`);
}

// ============================================================================
// 14. from_json_legacy
// ============================================================================
console.log('== from_json_legacy ==');

const legacyJson = JSON.stringify({
  fingerprint: 'L1', customer: 'C',
  value_clean: { payment_terms: { pat: 'X', repl: 'Y' } },
  color_clean: { pat: 'BEIGE', repl: 'IVORY' },
});
const r3 = M.PoRecipe.from_json(legacyJson);
ok(deepEqual(r3.cleans, oracle.from_json_legacy.cleans), 'from_json_legacy cleans 合并一致');
ok(deepEqual(r3.field_defaults, oracle.from_json_legacy.field_defaults), 'from_json_legacy field_defaults = {}');

// ============================================================================
// 15. oracle_models_extra tests
// ============================================================================
console.log('== oracle_models_extra ==');

// A. sizes 合并语义
const aPO = make_po();
aPO.apply_recipe_overrides({ __line_overrides__: { '90Z': { sizes: { S: '250', M: '3,000' }, inseam: '28', su: 'SET' } } });
ok(deepEqual(lineState(aPO, 0, 1), oracleExtra.A_sizes_merge.line), 'A_sizes_merge line state 一致');
ok(aPO.total_qty === oracleExtra.A_sizes_merge.total_qty, `A_sizes_merge total_qty = ${oracleExtra.A_sizes_merge.total_qty}`);

// B. 全局 unit_price 解析
const b1PO = make_po();
b1PO.apply_recipe_overrides({ unit_price: '12,50' });
ok(deepEqual(lineState(b1PO, 0, 0), oracleExtra.B_price_12_50.line0), 'B_price_12_50 line0 一致');
ok(deepEqual(lineState(b1PO, 0, 1), oracleExtra.B_price_12_50.line1), 'B_price_12_50 line1 一致');

const b2PO = make_po();
b2PO.apply_recipe_overrides({ unit_price: 'abc' });
ok(deepEqual(lineState(b2PO, 0, 0), oracleExtra.B_price_abc.line0), 'B_price_abc line0 一致');

const b3PO = make_po();
b3PO.apply_recipe_overrides({ unit_price: '10' });
ok(deepEqual(lineState(b3PO, 0, 0), oracleExtra.B_price_10.line0), 'B_price_10 line0 一致');

const b4PO = make_po();
b4PO.apply_recipe_overrides({ unit_price: '10,5,5' });
ok(deepEqual(lineState(b4PO, 0, 0), oracleExtra.B_price_multi_comma.line0), 'B_price_multi_comma line0 一致');

// C. 表头通用键
const cPO = make_po();
cPO.apply_recipe_overrides({
  po_no: '888', season: 'FW27', channel: 'E-COMM', delivery_date: '2027-01-01',
  destination_code: 'EG.CL.R', packing_method: 'FLAT', price_term: 'CIF',
  payment_terms: 'CAD', port_loading: 'Shanghai', port_discharge: 'NY',
  ship_mode: 'Air', vendor_name: 'V', agent_name: 'A', size_scale: 'NUM',
  product_group: 'G', age_sex_desc: 'W', product_desc: 'P', wash_method: 'WM',
  washing_color: 'WC', import_po_no: 'I', reference_no: 'R', cir_no: 'CC',
  freight_terms: 'F', country_of_origin: 'CN', dc_address: 'D',
});
ok(deepEqual(entState(cPO), oracleExtra.C_header_generic), 'C_header_generic entState 一致');

// D. su 空串
const d1PO = make_po();
d1PO.apply_recipe_overrides({ su: '' });
ok(deepEqual(lineState(d1PO, 0, 0), oracleExtra.D_su_empty.line0), 'D_su_empty line0 一致');
ok(deepEqual(lineState(d1PO, 0, 1), oracleExtra.D_su_empty.line1), 'D_su_empty line1 一致');

const d2PO = make_po();
d2PO.apply_recipe_overrides({ su: 'PAIR' });
ok(deepEqual(lineState(d2PO, 0, 0), oracleExtra.D_su_pair.line0), 'D_su_pair line0 一致');
ok(deepEqual(lineState(d2PO, 0, 1), oracleExtra.D_su_pair.line1), 'D_su_pair line1 一致');

// E. field_defaults 行级字段
const ePO = make_po();
const eRecipe = new M.PoRecipe({ field_defaults: { style_no: 'X1', su: 'PAIR', customer: 'NEW CUST', po_no: 'P9' } });
const eChanges = ePO.apply_field_defaults(eRecipe);
ok(deepEqual(eChanges, oracleExtra.E_defaults_line.changes), 'E_defaults_line changes 一致');
ok(deepEqual(lineState(ePO, 0, 0), oracleExtra.E_defaults_line.line0), 'E_defaults_line line0 一致');
ok(deepEqual(lineState(ePO, 0, 1), oracleExtra.E_defaults_line.line1), 'E_defaults_line line1 一致');
ok(ePO.customer === oracleExtra.E_defaults_line.customer, 'E_defaults_line customer 一致');
ok(ePO.entities[0].po_no === oracleExtra.E_defaults_line.po_no, 'E_defaults_line po_no 一致');

// F. color_edits 非法 JSON
const f1PO = make_po();
try {
  f1PO.apply_recipe_overrides({ color_edits: '{invalid json' });
  ok(oracleExtra.F_bad_json.error === null, 'F_bad_json 不抛异常');
} catch (e) {
  ok(false, `F_bad_json 不应抛异常 (${e.message})`);
}

const f2PO = make_po();
f2PO.apply_recipe_overrides({ color_edits: 'null' });
ok(deepEqual({ customer: f2PO.customer, pairs: f2PO._cleanable_pairs() }, oracleExtra.F_null_str), 'F_null_str state 一致');

// G. qty_safe 更多边界
ok(new M.SizeQty({ size: 'S', qty: ' 5 ' }).qty_safe === oracleExtra.G_qty_safe.spaced, 'G qty_safe spaced → 5');
ok(new M.SizeQty({ size: 'S', qty: '5.7' }).qty_safe === oracleExtra.G_qty_safe.float_str, 'G qty_safe float_str → 0');
ok(new M.SizeQty({ size: 'S', qty: true }).qty_safe === oracleExtra.G_qty_safe.bool_true, 'G qty_safe bool_true → 1');
ok(new M.SizeQty({ size: 'S', qty: '' }).qty_safe === oracleExtra.G_qty_safe.empty_str, 'G qty_safe empty_str → 0');
ok(new M.SizeQty({ size: 'S', qty: '-3' }).qty_safe === oracleExtra.G_qty_safe.neg_str, 'G qty_safe neg_str → -3');
ok(new M.SizeQty({ size: 'S', qty: '0' }).qty_safe === oracleExtra.G_qty_safe.zero_str, 'G qty_safe zero_str → 0');

// H. 组合键优先级
const h1PO = make_po();
h1PO.apply_recipe_overrides({ __line_overrides__: { '90Z / BLACK': { inseam: '31' }, '90Z': { inseam: '29' } } });
ok(h1PO.entities[0].lines[1].inseam === oracleExtra.H_key_priority.line1_inseam, 'H_key_priority combined > code-only');

const h2PO = make_po();
h2PO.apply_recipe_overrides({ __line_overrides__: { '90Z / BLACK\u241f30': { inseam: '32' }, '90Z / BLACK': { inseam: '31' } } });
ok(h2PO.entities[0].lines[1].inseam === oracleExtra.H_key_priority_inseam.line1_inseam, 'H_key_priority_inseam combined > combined␟inseam');

// I. 多实体索引
const iPO = make_po();
iPO.entities.push(new M.OrderEntity({
  entity_index: 1, po_no: 'AAAA',
  lines: [new M.OrderLine({ style_no: 'S2', color_code: '10', color_desc: 'RED', sizes: [new M.SizeQty({ size: 'M', qty: 3 })] })],
}));
iPO.apply_recipe_overrides({ __ent_overrides__: { '1': { po_no: 'BBBB' } } });
ok(iPO.entities[0].po_no === oracleExtra.I_ent1.po_no_0, 'I_ent1 po_no_0 = 11321589');
ok(iPO.entities[1].po_no === oracleExtra.I_ent1.po_no_1, 'I_ent1 po_no_1 = BBBB');

// ============================================================================
// 16. probe_oracle tests
// ============================================================================
console.log('== probe_oracle ==');

// P1. sizes 数量解析（命中已有尺码 M=500）
const p1Cases = [
  { label: 'P1_3,000', qv: '3,000', expected: probe['P1_3,000'] },
  { label: 'P1_12,5', qv: '12,5', expected: probe['P1_12,5'] },
  { label: 'P1_x', qv: 'x', expected: probe['P1_x'] },
  { label: 'P1_5.7', qv: '5.7', expected: probe['P1_5.7'] },
  { label: 'P1_3000', qv: '3000', expected: probe['P1_3000'] },
];
for (const { label, qv, expected } of p1Cases) {
  const po = make_po_probe();
  po.apply_recipe_overrides({ __line_overrides__: { '80X / BEIGE': { sizes: { M: qv } } } });
  const sizes = po.entities[0].lines[0].sizes.map(sq => [sq.size, sq.qty]);
  ok(deepEqual(sizes, expected.sizes), `${label} sizes 一致`);
  ok(po.total_qty === expected.total, `${label} total = ${expected.total}`);
}

// P2. 多键命中顺序
const p2aPO = make_po_probe();
p2aPO.apply_recipe_overrides({ __line_overrides__: { '90Z / BLACK': { inseam: '31' }, '90Z / BLACK\u241f30': { inseam: '32' } } });
ok(p2aPO.entities[0].lines[1].inseam === probe.P2_combined_then_inseam, 'P2_combined_then_inseam = 31 (combined 优先)');

const p2bPO = make_po_probe();
p2bPO.apply_recipe_overrides({ __line_overrides__: { '90Z / BLACK\u241f30': { inseam: '32' }, '90Z / BLACK': { inseam: '31' } } });
ok(p2bPO.entities[0].lines[1].inseam === probe.P2_inseam_then_combined, 'P2_inseam_then_combined = 31 (combined 优先，与 dict 顺序无关)');

// P3. 行级 unit_price 解析
const p3PO = make_po_probe();
p3PO.apply_recipe_overrides({ __line_overrides__: { '90Z / BLACK': { unit_price: '9.99' } } });
ok(p3PO.entities[0].lines[1].unit_price === probe.P3_line_price, `P3_line_price = ${probe.P3_line_price}`);

// P4. sizes 空 dict / 非 dict
const p4aPO = make_po_probe();
p4aPO.apply_recipe_overrides({ __line_overrides__: { '90Z / BLACK': { sizes: {} } } });
const p4aSizes = p4aPO.entities[0].lines[1].sizes.map(sq => [sq.size, sq.qty]);
ok(deepEqual(p4aSizes, probe.P4_empty_sizes.sizes), 'P4_empty_sizes 不变');

const p4bPO = make_po_probe();
p4bPO.apply_recipe_overrides({ __line_overrides__: { '90Z / BLACK': { sizes: 'not-a-dict' } } });
const p4bSizes = p4bPO.entities[0].lines[1].sizes.map(sq => [sq.size, sq.qty]);
ok(deepEqual(p4bSizes, probe.P4_non_dict_sizes.sizes), 'P4_non_dict_sizes 不变');

// ============================================================================
// Result
// ============================================================================
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
