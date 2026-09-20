#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""probe_oracle.py — 消歧 2 个残留问题：
  P1. __line_overrides__ sizes 数量解析（已有尺码 M 上 '3,000' / '12,5' / 'x' / '5.7'）
  P2. __line_overrides__ 多键同时命中时的应用顺序（combined vs combined␟inseam）
输出: probe_oracle.json
"""
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
install_stub()
m = load_pyc('core.models', os.path.join(BASE, 'core', 'models.pyc'), package='core')

out = {}


def make_po():
    return m.PurchaseOrder(
        customer='LPP SA', source_file='f.pdf', source_file_path=r'C:\f.pdf',
        order_date='', per_destination=False, fingerprint='FP',
        entities=[m.OrderEntity(entity_index=0, po_no='11321589', lines=[
            m.OrderLine(style_no='637JO', color_code='80X', color_desc='BEIGE', inseam='',
                        su='PCS', unit_price=10.2,
                        sizes=[m.SizeQty(size='S', qty=744), m.SizeQty(size='M', qty=500)]),
            m.OrderLine(style_no='637JO', color_code='90Z', color_desc='BLACK', inseam='30',
                        su='PR', unit_price=8.5,
                        sizes=[m.SizeQty(size='S', qty=200), m.SizeQty(size='L', qty='abc')]),
        ])],
    )


def sizes_of(po):
    return [[sq.size, sq.qty] for sq in po.entities[0].lines[0].sizes]


# ---------- P1. sizes 数量解析（命中已有尺码 M=500） ----------
for label, qv in [('3,000', '3,000'), ('12,5', '12,5'), ('x', 'x'), ('5.7', '5.7'), ('3000', '3000')]:
    po = make_po()
    po.apply_recipe_overrides({'__line_overrides__': {'80X / BEIGE': {'sizes': {'M': qv}}}})
    out['P1_' + label] = {'sizes': sizes_of(po), 'total': po.total_qty}

# ---------- P2. 多键命中顺序 ----------
po = make_po()
po.apply_recipe_overrides({'__line_overrides__': {
    '90Z / BLACK': {'inseam': '31'},
    '90Z / BLACK\u241f30': {'inseam': '32'},
}})
out['P2_combined_then_inseam'] = po.entities[0].lines[1].inseam

po = make_po()
po.apply_recipe_overrides({'__line_overrides__': {
    '90Z / BLACK\u241f30': {'inseam': '32'},
    '90Z / BLACK': {'inseam': '31'},
}})
out['P2_inseam_then_combined'] = po.entities[0].lines[1].inseam

# ---------- P3. 行级 unit_price 解析（'9.99'） ----------
po = make_po()
po.apply_recipe_overrides({'__line_overrides__': {'90Z / BLACK': {'unit_price': '9.99'}}})
out['P3_line_price'] = po.entities[0].lines[1].unit_price

# ---------- P4. sizes 空 dict / 非 dict ----------
po = make_po()
po.apply_recipe_overrides({'__line_overrides__': {'90Z / BLACK': {'sizes': {}}}})
out['P4_empty_sizes'] = {'sizes': po.entities[0].lines[1].sizes and [[sq.size, sq.qty] for sq in po.entities[0].lines[1].sizes]}

po = make_po()
po.apply_recipe_overrides({'__line_overrides__': {'90Z / BLACK': {'sizes': 'not-a-dict'}}})
out['P4_non_dict_sizes'] = {'sizes': [[sq.size, sq.qty] for sq in po.entities[0].lines[1].sizes]}

sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1, default=str))
