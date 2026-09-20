#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
oracle_models_extra.py — 补充捕获 oracle_models.py 未覆盖的行为：
  A. __line_overrides__ sizes 合并语义 + 数量解析（'3,000'）
  B. 全局 unit_price 欧式解析（'12,50'→12.5 / 'abc'→None）
  C. 表头通用键全局覆盖（season/channel/delivery_date/...）
  D. su='' 空串是否传播
  E. field_defaults 对行级字段（style_no/su）是否传播
  F. color_edits 非法 JSON 串行为
  G. qty_safe 更多边界（' 5 ' / '5.7' / True / ''）
输出: oracle_models_extra.json
"""
import dataclasses
import json
import os
import sys

import builtins
_orig_print = builtins.print
def _quiet_print(*args, **kwargs):
    kwargs.pop('file', None)
    _orig_print(*args, file=sys.stderr, **kwargs)
builtins.print = _quiet_print

BASE = r'C:\Users\Administrator\.workbuddy\binaries\python\pyinstxtractor_tool\Purchase_Order_Extractor.exe_extracted\PYZ.pyz_extracted'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyc_loader import load_pyc, make_package  # noqa: E402
from winpath_stub import install_stub  # noqa: E402

make_package('core', os.path.join(BASE, 'core'))
install_stub()  # 原版 winpath.pyc 需 pywin32（本机缺失 segfault），用行为等价替身
m = load_pyc('core.models', os.path.join(BASE, 'core', 'models.pyc'), package='core')

out = {}


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


def line_state(po, ent=0, ln=1):
    l = po.entities[ent].lines[ln]
    return {
        'style_no': l.style_no, 'color_code': l.color_code, 'color_desc': l.color_desc,
        'inseam': l.inseam, 'su': l.su, 'unit_price': l.unit_price,
        'printed_row_total': l.printed_row_total, 'net_amount': l.net_amount,
        'sizes': [[sq.size, sq.qty] for sq in l.sizes],
    }


def ent_state(po, ent=0):
    e = po.entities[ent]
    return {f.name: getattr(e, f.name) for f in dataclasses.fields(m.OrderEntity)
            if f.name not in ('lines', 'extra', 'printed_size_totals', 'printed_total_qty', 'printed_total_amount')}


# ---------- A. sizes 合并语义 ----------
po = make_po()
po.apply_recipe_overrides({'__line_overrides__': {'90Z': {'sizes': {'S': '250', 'M': '3,000'}, 'inseam': '28', 'su': 'SET'}}})
out['A_sizes_merge'] = {'line': line_state(po, 0, 1), 'total_qty': po.total_qty}

# ---------- B. 全局 unit_price 解析 ----------
po = make_po()
po.apply_recipe_overrides({'unit_price': '12,50'})
out['B_price_12_50'] = {'line0': line_state(po, 0, 0), 'line1': line_state(po, 0, 1)}

po = make_po()
po.apply_recipe_overrides({'unit_price': 'abc'})
out['B_price_abc'] = {'line0': line_state(po, 0, 0)}

po = make_po()
po.apply_recipe_overrides({'unit_price': '10'})
out['B_price_10'] = {'line0': line_state(po, 0, 0)}

po = make_po()
po.apply_recipe_overrides({'unit_price': '10,5,5'})
out['B_price_multi_comma'] = {'line0': line_state(po, 0, 0)}

# ---------- C. 表头通用键 ----------
po = make_po()
po.apply_recipe_overrides({
    'po_no': '888', 'season': 'FW27', 'channel': 'E-COMM', 'delivery_date': '2027-01-01',
    'destination_code': 'EG.CL.R', 'packing_method': 'FLAT', 'price_term': 'CIF',
    'payment_terms': 'CAD', 'port_loading': 'Shanghai', 'port_discharge': 'NY',
    'ship_mode': 'Air', 'vendor_name': 'V', 'agent_name': 'A', 'size_scale': 'NUM',
    'product_group': 'G', 'age_sex_desc': 'W', 'product_desc': 'P', 'wash_method': 'WM',
    'washing_color': 'WC', 'import_po_no': 'I', 'reference_no': 'R', 'cir_no': 'CC',
    'freight_terms': 'F', 'country_of_origin': 'CN', 'dc_address': 'D',
})
out['C_header_generic'] = ent_state(po)

# ---------- D. su 空串 ----------
po = make_po()
po.apply_recipe_overrides({'su': ''})
out['D_su_empty'] = {'line0': line_state(po, 0, 0), 'line1': line_state(po, 0, 1)}

po = make_po()
po.apply_recipe_overrides({'su': 'PAIR'})
out['D_su_pair'] = {'line0': line_state(po, 0, 0), 'line1': line_state(po, 0, 1)}

# ---------- E. field_defaults 行级字段 ----------
po = make_po()
recipe = m.PoRecipe(field_defaults={'style_no': 'X1', 'su': 'PAIR', 'customer': 'NEW CUST', 'po_no': 'P9'})
changes = po.apply_field_defaults(recipe)
out['E_defaults_line'] = {'changes': changes,
                          'line0': line_state(po, 0, 0), 'line1': line_state(po, 0, 1),
                          'customer': po.customer, 'po_no': po.entities[0].po_no}

# ---------- F. color_edits 非法 JSON ----------
po = make_po()
try:
    po.apply_recipe_overrides({'color_edits': '{invalid json'})
    out['F_bad_json'] = {'error': None}
except Exception as e:
    out['F_bad_json'] = {'error': type(e).__name__}

po = make_po()
po.apply_recipe_overrides({'color_edits': 'null'})
out['F_null_str'] = {'customer': po.customer, 'pairs': po._cleanable_pairs()}

# ---------- G. qty_safe 更多边界 ----------
out['G_qty_safe'] = {
    'spaced': m.SizeQty('S', ' 5 ').qty_safe,
    'float_str': m.SizeQty('S', '5.7').qty_safe,
    'bool_true': m.SizeQty('S', True).qty_safe,
    'empty_str': m.SizeQty('S', '').qty_safe,
    'neg_str': m.SizeQty('S', '-3').qty_safe,
    'zero_str': m.SizeQty('S', '0').qty_safe,
}

# ---------- H. 组合键优先级（同 dict 含 combined 与 code 两个键） ----------
po = make_po()
po.apply_recipe_overrides({'__line_overrides__': {
    '90Z / BLACK': {'inseam': '31'},
    '90Z': {'inseam': '29'},
}})
out['H_key_priority'] = {'line1_inseam': po.entities[0].lines[1].inseam}

po = make_po()
po.apply_recipe_overrides({'__line_overrides__': {
    '90Z / BLACK\u241f30': {'inseam': '32'},
    '90Z / BLACK': {'inseam': '31'},
}})
out['H_key_priority_inseam'] = {'line1_inseam': po.entities[0].lines[1].inseam}

# ---------- I. 多实体索引在 __ent_overrides__ 的行为 ----------
po = make_po()
po.entities.append(m.OrderEntity(entity_index=1, po_no='AAAA', lines=[
    m.OrderLine(style_no='S2', color_code='10', color_desc='RED',
                sizes=[m.SizeQty(size='M', qty=3)])]))
po.apply_recipe_overrides({'__ent_overrides__': {'1': {'po_no': 'BBBB'}}})
out['I_ent1'] = {'po_no_0': po.entities[0].po_no, 'po_no_1': po.entities[1].po_no}

sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1, default=str))
