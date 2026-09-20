#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""oracle_parsers.py — 生成 base.pyc / line_items.pyc 的行为基准。
输出: oracle_parsers.json
"""
import json
import os
import sys
import re
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
make_package('core.parsers', os.path.join(BASE, 'core', 'parsers'))
install_stub()

m = load_pyc('core.models', os.path.join(BASE, 'core', 'models.pyc'), package='core')
try:
    load_pyc('core.normalize', os.path.join(BASE, 'core', 'normalize.pyc'), package='core')
except Exception as e:
    sys.stderr.write(f'normalize: {e}\n')
base = load_pyc('core.parsers.base', os.path.join(BASE, 'core', 'parsers', 'base.pyc'), package='core.parsers')
li = load_pyc('core.parsers.line_items', os.path.join(BASE, 'core', 'parsers', 'line_items.pyc'), package='core.parsers')

out = {}
Tok = base.Token
PW = base.PageWords

# ════════════════════════════════════════
# A. Token
# ════════════════════════════════════════
out['Token'] = {}
# A1. xc / yc
t = Tok(text='hello', x0=1, y0=2, x1=3, y1=4, page=0)
out['Token']['xc'] = t.xc
out['Token']['yc'] = t.yc

# A2. is_number
out['Token']['is_number'] = {}
for txt in ['500', '100', '12.50', 'abc', '', '3,000', '1-1', '-', '.', '0', '-3', '+5',
            '200', '150', '450', '0.00', 'N/A', '--', '1,000,000']:
    try:
        t2 = Tok(text=txt, x0=0, y0=0, x1=10, y1=10, page=0)
        out['Token']['is_number'][txt] = t2.is_number()
    except Exception as e:
        out['Token']['is_number'][txt] = f'ERR:{e}'

# A3. eq
out['Token']['eq_same'] = Tok(text='A', x0=0, y0=0, x1=10, y1=10, page=0) == Tok(text='A', x0=0, y0=0, x1=10, y1=10, page=0)
out['Token']['eq_diff_text'] = Tok(text='A', x0=0, y0=0, x1=10, y1=10, page=0) == Tok(text='B', x0=0, y0=0, x1=10, y1=10, page=0)
out['Token']['eq_diff_x'] = Tok(text='A', x0=0, y0=0, x1=10, y1=10, page=0) == Tok(text='A', x0=1, y0=0, x1=10, y1=10, page=0)

# ════════════════════════════════════════
# B. PageWords
# ════════════════════════════════════════
out['PageWords'] = {}
tokens = [
    Tok(text='COLOR', x0=0, y0=0, x1=50, y1=10, page=0),
    Tok(text='NO', x0=55, y0=0, x1=70, y1=10, page=0),
    Tok(text='XS', x0=80, y0=0, x1=90, y1=10, page=0),
    Tok(text='S', x0=95, y0=0, x1=105, y1=10, page=0),
    Tok(text='M', x0=110, y0=0, x1=120, y1=10, page=0),
    Tok(text='TOTAL', x0=200, y0=0, x1=240, y1=10, page=0),
    Tok(text='637JO', x0=0, y0=20, x1=40, y1=30, page=0),
    Tok(text='80X', x0=45, y0=20, x1=65, y1=30, page=0),
    Tok(text='100', x0=80, y0=20, x1=95, y1=30, page=0),
    Tok(text='200', x0=95, y0=20, x1=110, y1=30, page=0),
    Tok(text='150', x0=110, y0=20, x1=125, y1=30, page=0),
    Tok(text='450', x0=200, y0=20, x1=240, y1=30, page=0),
]
pw = PW(page=0, width=300, height=100, tokens=tokens)
lines = pw.lines()
out['PageWords']['lines_count'] = len(lines)
out['PageWords']['line0'] = [t.text for t in lines[0]]
out['PageWords']['line1'] = [t.text for t in lines[1]]
out['PageWords']['text'] = pw.text()

# PageWords with 3 lines
tokens3 = [
    Tok(text='A', x0=0, y0=0, x1=10, y1=10, page=0),
    Tok(text='B', x0=20, y0=0, x1=30, y1=10, page=0),
    Tok(text='C', x0=0, y0=20, x1=10, y1=30, page=0),
    Tok(text='D', x0=20, y0=20, x1=30, y1=30, page=0),
    Tok(text='E', x0=0, y0=40, x1=10, y1=50, page=0),
]
pw3 = PW(page=1, width=100, height=100, tokens=tokens3)
lines3 = pw3.lines()
out['PageWords']['lines3_count'] = len(lines3)
out['PageWords']['lines3'] = [[t.text for t in ln] for ln in lines3]

# Empty page
pw_empty = PW(page=0, width=100, height=100, tokens=[])
out['PageWords']['empty_lines'] = pw_empty.lines()
out['PageWords']['empty_text'] = pw_empty.text()

# ════════════════════════════════════════
# C. _to_int
# ════════════════════════════════════════
out['_to_int'] = {}
for v in ['100', '200', '3,000', '12.5', 'abc', '', '5.7', '-3', '0', '150', '450',
          '1,000,000', '12,50', None]:
    try:
        out['_to_int'][str(v)] = base._to_int(v)
    except Exception as e:
        out['_to_int'][str(v)] = f'ERR:{e}'

# ════════════════════════════════════════
# D. _to_float
# ════════════════════════════════════════
out['_to_float'] = {}
for v in ['10.20', '3,000', 'abc', '', '5.7', '12,50', '150', None]:
    try:
        out['_to_float'][str(v)] = base._to_float(v)
    except Exception as e:
        out['_to_float'][str(v)] = f'ERR:{e}'

# ════════════════════════════════════════
# E. _looks_like_style
# ════════════════════════════════════════
out['_looks_like_style'] = {}
for v in ['637JO', 'AW11078', '1', '1-1', 'AB', 'ABC123', '12345', 'X-100',
          '', 'XL901', '80X', '90Z', 'a', 'AB-', 'A1B2']:
    try:
        out['_looks_like_style'][v] = base._looks_like_style(v)
    except Exception as e:
        out['_looks_like_style'][v] = f'ERR:{e}'

# ════════════════════════════════════════
# F. _looks_like_sku
# ════════════════════════════════════════
out['_looks_like_sku'] = {}
for v in ['59J', '08X', '1', 'ABC', '59J59J', '80X', '', '90Z', '637JO', 'XL']:
    try:
        out['_looks_like_sku'][v] = base._looks_like_sku(v)
    except Exception as e:
        out['_looks_like_sku'][v] = f'ERR:{e}'

# ════════════════════════════════════════
# G. norm_date
# ════════════════════════════════════════
out['norm_date'] = {}
for v in ['15.03.2024', '15.03.24', '2024-03-15', '1.5.2024', '2024-12-01',
          '', 'invalid', '3.1.25', '01.01.2026', '2026-01-01']:
    try:
        out['norm_date'][v] = base.norm_date(v)
    except Exception as e:
        out['norm_date'][v] = f'ERR:{e}'

# ════════════════════════════════════════
# H. extract_color_from_combined
# ════════════════════════════════════════
out['extract_color_from_combined'] = {}
for v in ['59J 59J DARK BLUE JEANS', '55J 99J LIGHT BLUE', 'DARK BLUE JEANS',
          'LIGHT BLUE', 'AW11078 BLACK', '08X 08X SAND', 'SILVER CLOUD',
          '', 'BLACK', '59J', '59J 59J', 'MULTICOLOR', 'TIE DYE',
          'C1 C1 NAVY BLUE', 'HEATHER GREY', '99J 99J LIGHT BLUE JEANS']:
    try:
        out['extract_color_from_combined'][v] = base.extract_color_from_combined(v)
    except Exception as e:
        out['extract_color_from_combined'][v] = f'ERR:{e}'

# ════════════════════════════════════════
# I. merge_wrapped_rows
# ════════════════════════════════════════
out['merge_wrapped_rows'] = {}
# Simple (no markers)
out['merge_wrapped_rows']['simple'] = base.merge_wrapped_rows('PURCHASE ORDER\n637JO 80X BEIGE 100\nTOTAL 100')
# TJX packed table
out['merge_wrapped_rows']['packed'] = base.merge_wrapped_rows('1-1 AW11078 BLACK 100\n1-2 AW11079 WHITE 200')
# TJX wrapped
out['merge_wrapped_rows']['wrapped'] = base.merge_wrapped_rows('1-1 AW11078\nBLACK T-SHIRT\n100 200')
# Empty
out['merge_wrapped_rows']['empty'] = base.merge_wrapped_rows('')

# ════════════════════════════════════════
# J. _color_desc_from (line_items)
# ════════════════════════════════════════
out['_color_desc_from'] = {}
for v in ['LADIES TROUSERS 08X 08X SAND', 'SILVER CLOUD 53% LINEN',
          'DARK BLUE', 'BLACK', '', '59J 59J DARK BLUE JEANS',
          'BEIGE', 'NAVY BLUE', 'C1 C1 NAVY BLUE', 'HEATHER GREY',
          'ASST 1-3', 'MULTICOLOR']:
    try:
        out['_color_desc_from'][v] = li._color_desc_from(v)
    except Exception as e:
        out['_color_desc_from'][v] = f'ERR:{e}'

# ════════════════════════════════════════
# K. _recover_style_from_line
# ════════════════════════════════════════
out['_recover_style_from_line'] = {}
for style, line in [
    ('1-1', '1-1 AW11078 BLACK T-SHIRT 100 200 50'),
    ('1-2', '1-2 AW11079 WHITE T-SHIRT 200 100 50'),
    ('637JO', '637JO 80X BEIGE 100 200'),
    ('1', '1 AW11078 BLACK 100'),
    ('637JO', '637JO 80X BEIGE'),
    ('1-3', '1-3 XL901 RED 300'),
]:
    try:
        out['_recover_style_from_line'][f'{style}|{line}'] = li._recover_style_from_line(style, line)
    except Exception as e:
        out['_recover_style_from_line'][f'{style}|{line}'] = f'ERR:{e}'

# ════════════════════════════════════════
# L. _parse_size_breakdown
# ════════════════════════════════════════
out['_parse_size_breakdown'] = {}
for line, qty in [
    ('S:1, M:2, L:2, XL:1', 6),
    ('S:150, M:300, L:300, XL:150', 900),
    ('S:1, M:2, L:2, XL:1', 12),
    ('S:1, M:2, L:2, XL:1', 0),
    ('', 0),
    ('S:1, M:2, L:2', 6),
    ('S:1, M:1, L:1', 12),
]:
    try:
        result = li._parse_size_breakdown(line, qty)
        out['_parse_size_breakdown'][f'{line}|{qty}'] = [[sq.size, sq.qty] for sq in result]
    except Exception as e:
        out['_parse_size_breakdown'][f'{line}|{qty}'] = f'ERR:{e}'

# ════════════════════════════════════════
# M. _norm_ship
# ════════════════════════════════════════
out['_norm_ship'] = {}
for v in ['SEA', 'AIR', 'VESSEL', 'BY SEA', 'OCEAN', 'TRUCK', '', 'BY AIR', 'AIR FREIGHT']:
    try:
        out['_norm_ship'][v] = base._norm_ship(v)
    except Exception as e:
        out['_norm_ship'][v] = f'ERR:{e}'

# ════════════════════════════════════════
# N. LineItemsParser
# ════════════════════════════════════════
out['LineItemsParser'] = {}
parser = li.LineItemsParser()
out['LineItemsParser']['layout_type'] = parser.layout_type

sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1, default=str))
