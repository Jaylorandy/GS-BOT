#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
oracle_models.py — 加载原版 core/models.pyc（含 core/winpath.pyc 依赖），
导出数据契约 + 全部方法行为，作为 JS 翻译 models.js 的 ground truth。
用法: python oracle_models.py > oracle_models.json
"""
import dataclasses
import json
import os
import sys

# 原版 models.pyc 的 apply_recipe_overrides 会 print 日志（如 [override] ...），
# 必须重定向到 stderr，避免污染 stdout 的 JSON 输出。
import builtins
_orig_print = builtins.print
def _quiet_print(*args, **kwargs):
    kwargs.pop('file', None)
    _orig_print(*args, file=sys.stderr, **kwargs)
builtins.print = _quiet_print

BASE = r'C:\Users\Administrator\.workbuddy\binaries\python\pyinstxtractor_tool\Purchase_Order_Extractor.exe_extracted\PYZ.pyz_extracted'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyc_loader import load_pyc, make_package  # noqa: E402

make_package('core', os.path.join(BASE, 'core'))
load_pyc('core.winpath', os.path.join(BASE, 'core', 'winpath.pyc'), package='core')
m = load_pyc('core.models', os.path.join(BASE, 'core', 'models.pyc'), package='core')

out = {}

# ---------- 1. LayoutType ----------
out['LayoutType'] = {k: v.value for k, v in m.LayoutType.__members__.items()}

# ---------- 2. dataclass 字段契约 ----------
def field_dump(cls):
    res = []
    for f in dataclasses.fields(cls):
        default = f.default
        factory = f.default_factory
        entry = {
            'name': f.name,
            'type': str(f.type),
            'default': '<MISSING>' if default is dataclasses.MISSING else default,
            'factory': None if factory is dataclasses.MISSING else factory.__name__,
        }
        res.append(entry)
    return res

out['dataclass_fields'] = {
    'SizeQty': field_dump(m.SizeQty),
    'OrderLine': field_dump(m.OrderLine),
    'OrderEntity': field_dump(m.OrderEntity),
    'PurchaseOrder': field_dump(m.PurchaseOrder),
    'PoRecipe': field_dump(m.PoRecipe),
}

# ---------- 3. 采样 PO ----------
def make_po():
    po = m.PurchaseOrder(
        customer='LPP SA',
        source_file='PO_637JO_2627182_2026-01-15.pdf',
        source_file_path=r'C:\fake dir\PO_637JO_2627182_2026-01-15.pdf',
        order_date='2026-01-15',
        per_destination=False,
        fingerprint='FP123',
        entities=[
            m.OrderEntity(
                entity_index=0, po_no='11321589', channel='STANDARD', season='SS26',
                delivery_date='2026-03-02', destination_code='', packing_method='MULTIPACK',
                wash_method='', washing_color='', payment_terms='TT HSBC 180 Days',
                price_term='FOB', currency='USD', size_scale='ALPHA', product_group='C_trousers',
                age_sex_desc='MENS', product_desc="MEN'S TROUSERS",
                port_loading='Sihanoukville', port_discharge='Gdynia', ship_mode='Sea',
                vendor_name='Gs Global Sourcing Co.,Ltd', agent_name='', import_po_no='',
                reference_no='', cir_no='', freight_terms='', country_of_origin='', dc_address='',
                lines=[
                    m.OrderLine(style_no='637JO', color_code='80X', color_desc='BEIGE', inseam='',
                                su='PCS', unit_price=10.2,
                                sizes=[m.SizeQty(size='S', qty=744), m.SizeQty(size='M', qty=500)]),
                    m.OrderLine(style_no='637JO', color_code='90Z', color_desc='BLACK', inseam='30',
                                su='PR', unit_price=8.5,
                                sizes=[m.SizeQty(size='S', qty=200), m.SizeQty(size='L', qty='abc')]),
                ],
                printed_size_totals={}, printed_total_qty=None, printed_total_amount=None,
                extra={},
            ),
        ],
    )
    return po

out['sample'] = {
    'template_b_rows': make_po().template_b_rows(po_version=2, is_current='Y', import_batch='B2026-01'),
    'total_qty': make_po().total_qty,
    'size_totals': make_po().size_totals(),
    'color_totals': make_po().color_totals(),
}

# ---------- 4. qty_safe 边界 ----------
out['qty_safe'] = {
    'int 5': m.SizeQty('S', 5).qty_safe,
    'str 5': m.SizeQty('S', '5').qty_safe,
    'abc': m.SizeQty('S', 'abc').qty_safe,
    'None': m.SizeQty('S', None).qty_safe,
    'float 5.7': m.SizeQty('S', 5.7).qty_safe,
}

# ---------- 5. build_row_key ----------
out['build_row_key'] = {
    'full': m.build_row_key('LPP SA', '11321589', '637JO', '80X', 'S', '', ''),
    'with_inseam_dest': m.build_row_key('A', 'B', 'C', 'D', 'E', 'F', 'G'),
    'empty': m.build_row_key('', '', '', '', '', '', ''),
    'none_as_falsy': m.build_row_key(None, 'B', None, 'D', 'E', '', None),
}

# ---------- 6. _color_combined ----------
out['_color_combined'] = {
    'both': m.PurchaseOrder._color_combined('80X', 'BEIGE'),
    'code_only': m.PurchaseOrder._color_combined('80X', ''),
    'desc_only': m.PurchaseOrder._color_combined('', 'BEIGE'),
    'none': m.PurchaseOrder._color_combined('', ''),
    'none2': m.PurchaseOrder._color_combined(None, None),
}

# ---------- 7. apply_recipe_overrides 行为 ----------
def dump_po_state(po):
    return {
        'customer': po.customer,
        'pairs': po._cleanable_pairs(),
    }

# 7a. color_edits JSON 串（含 ' / '）→ 拆回 code/desc
po = make_po()
ret = po.apply_recipe_overrides({'color_edits': '{"80X / BEIGE": "85X / IVORY"}'})
out['overrides_a'] = {'ret': ret, 'state': dump_po_state(po)}

# 7b. color_edits 无 ' / ' → desc 变 new、code 清空
po = make_po()
ret = po.apply_recipe_overrides({'color_edits': '{"80X / BEIGE": "NATURAL"}'})
out['overrides_b'] = {'ret': ret, 'state': dump_po_state(po)}

# 7c. 全局键（customer/style_no/unit_price/su/currency）
po = make_po()
ret = po.apply_recipe_overrides({'customer': 'NEW CUST', 'style_no': '12345',
                                 'unit_price': '12,50', 'su': 'PCS', 'currency': 'EUR'})
out['overrides_c'] = {'ret': ret, 'state': dump_po_state(po)}

# 7d. unit_price 非法串 → price=None
po = make_po()
ret = po.apply_recipe_overrides({'unit_price': 'abc'})
out['overrides_d'] = {'ret': ret, 'state': dump_po_state(po)}

# 7e. __ent_overrides__
po = make_po()
ret = po.apply_recipe_overrides({'__ent_overrides__': {'0': {'po_no': '999', 'style_no': 'NEWSTYLE'}}})
out['overrides_e'] = {'ret': ret, 'state': dump_po_state(po)}

# 7f. __ent_overrides__ 越界/非法 idx → 跳过
po = make_po()
ret = po.apply_recipe_overrides({'__ent_overrides__': {'9': {'po_no': 'X'}, 'bad': {'po_no': 'Y'}}})
out['overrides_f'] = {'ret': ret, 'state': dump_po_state(po)}

# 7g. __line_overrides__ 命中 combined key
po = make_po()
ret = po.apply_recipe_overrides({'__line_overrides__': {
    '90Z / BLACK': {'unit_price': '9.99', 'inseam': '32', 'su': 'PR', 'style_no': '637JO2'},
}})
out['overrides_g'] = {'ret': ret, 'state': dump_po_state(po)}

# 7h. __line_overrides__ 命中 color_code key + sizes dict + inseam 键
po = make_po()
ret = po.apply_recipe_overrides({'__line_overrides__': {
    '90Z': {'sizes': {'S': '250', 'M': '3,000'}, 'inseam': '28', 'su': 'SET'},
}})
out['overrides_h'] = {'ret': ret, 'state': dump_po_state(po)}

# 7i. __line_overrides__ 命中 combined␟inseam key
po = make_po()
ret = po.apply_recipe_overrides({'__line_overrides__': {
    '90Z / BLACK\u241f30': {'unit_price': '7.77'},
}})
out['overrides_i'] = {'ret': ret, 'state': dump_po_state(po)}

# 7j. color_edits 传 dict（非 str）→ UnboundLocalError？
po = make_po()
try:
    ret = po.apply_recipe_overrides({'color_edits': {'80X / BEIGE': 'NATURAL'}})
    out['overrides_j'] = {'error': None, 'ret': ret, 'state': dump_po_state(po)}
except Exception as e:
    out['overrides_j'] = {'error': type(e).__name__, 'state': dump_po_state(po)}

# 7k. overrides 为空 → None
po = make_po()
ret = po.apply_recipe_overrides(None)
out['overrides_k'] = {'ret': ret, 'state': dump_po_state(po)}

# ---------- 8. apply_field_defaults ----------
po = make_po()
recipe = m.PoRecipe(field_defaults={'currency': 'EUR', 'payment_terms': 'CAD 30D'})
changes = po.apply_field_defaults(recipe)
out['field_defaults'] = {'changes': changes, 'state': dump_po_state(po)}

# 8b. recipe 为空 → []
po = make_po()
out['field_defaults_none'] = po.apply_field_defaults(None)

# ---------- 9. apply_value_clean ----------
po = make_po()
recipe = m.PoRecipe(cleans={'currency': [{'pat': 'USD', 'repl': 'US$'}],
                            'payment_terms': [{'pat': '\\d+D', 'repl': ''}]})
changes = po.apply_value_clean(recipe)
out['value_clean'] = {'changes': changes, 'state': dump_po_state(po)}

# 9b. 非法 pat → 静默跳过（re.error → None）
po = make_po()
recipe = m.PoRecipe(cleans={'currency': [{'pat': '(', 'repl': 'X'}]})
ret = po.apply_value_clean(recipe)
out['value_clean_badpat'] = {'ret': ret, 'state': dump_po_state(po)}

# 9c. field_name='color' → _clean_color 路径
po = make_po()
recipe = m.PoRecipe(cleans={'color': [{'pat': 'BEIGE', 'repl': 'IVORY'}]})
changes = po.apply_value_clean(recipe)
out['value_clean_color'] = {'changes': changes, 'state': dump_po_state(po)}

# 9d. rules 非 list / spec 非 dict → 跳过
po = make_po()
recipe = m.PoRecipe(cleans={'currency': 'not-a-list', 'price_term': [42]})
ret = po.apply_value_clean(recipe)
out['value_clean_skip'] = {'ret': ret, 'state': dump_po_state(po)}

# ---------- 10. _clean_field ----------
po = make_po()
ret = po._clean_field('currency', 'USD', 'US$')
out['clean_field_currency'] = {'ret': ret, 'state': dump_po_state(po)}

po = make_po()
ret = po._clean_field('customer', 'LPP', 'NEW')
out['clean_field_customer'] = {'ret': ret, 'state': dump_po_state(po)}

po = make_po()
ret = po._clean_field('style_no', '637JO', '9999')
out['clean_field_style'] = {'ret': ret, 'state': dump_po_state(po)}

po = make_po()
ret = po._clean_field('not_a_field', 'X', 'Y')
out['clean_field_unknown'] = {'ret': ret, 'state': dump_po_state(po)}

# ---------- 11. _clean_color ----------
po = make_po()
ret = po._clean_color('BEIGE', 'IVORY')
out['clean_color_desc'] = {'ret': ret, 'state': dump_po_state(po)}

po = make_po()
ret = po._clean_color('(80X|90Z)', '0')
out['clean_color_code_only'] = {'ret': ret, 'state': dump_po_state(po)}

po = make_po()
ret = po._clean_color('80X / BEIGE', '55X / TAUPE')
out['clean_color_split'] = {'ret': ret, 'state': dump_po_state(po)}

# ---------- 12. to_json / from_json ----------
r = m.PoRecipe(fingerprint='F1', customer='LPP SA', layout_type='line_items',
               po_no_anchor='ORDER NO[.\\s:]+(\\S+)', has_inseam=True,
               line_field_map={'style_no': 'A'}, field_defaults={'currency': 'EUR'},
               cleans={'currency': [{'pat': 'USD', 'repl': 'US$'}]},
               color_vocab={'80X': '80X'}, validators={}, date_format='%Y-%m-%d')
s = r.to_json()
out['to_json'] = s
r2 = m.PoRecipe.from_json(s)
out['from_json_roundtrip'] = {f.name: getattr(r2, f.name) for f in dataclasses.fields(m.PoRecipe)}

# from_json legacy: value_clean / color_clean 合并进 cleans
legacy = json.dumps({'fingerprint': 'L1', 'customer': 'C',
                     'value_clean': {'payment_terms': {'pat': 'X', 'repl': 'Y'}},
                     'color_clean': {'pat': 'BEIGE', 'repl': 'IVORY'}})
r3 = m.PoRecipe.from_json(legacy)
out['from_json_legacy'] = {'cleans': r3.cleans, 'field_defaults': r3.field_defaults}

sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1, default=str))
