#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""probe_parsers2.py — 深入探查 parser 方法行为。"""
import json
import os
import sys
import inspect
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

# ---------- Token properties ----------
out['Token_props'] = {}
t = Tok(text='500', x0=10, y0=20, x1=30, y1=30, page=0)
out['Token_props']['xc'] = t.xc
out['Token_props']['yc'] = t.yc
out['Token_props']['is_number_500'] = t.is_number
t2 = Tok(text='abc', x0=0, y0=0, x1=10, y1=10, page=0)
out['Token_props']['is_number_abc'] = t2.is_number
t3 = Tok(text='12.50', x0=0, y0=0, x1=10, y1=10, page=0)
out['Token_props']['is_number_12.50'] = t3.is_number
t4 = Tok(text='', x0=0, y0=0, x1=10, y1=10, page=0)
out['Token_props']['is_number_empty'] = t4.is_number

# ---------- PageWords.lines ----------
out['PageWords_lines'] = {}
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
try:
    lines = pw.lines
    out['PageWords_lines']['nlines'] = len(lines)
    out['PageWords_lines']['line0_texts'] = [t.text for t in lines[0]]
    out['PageWords_lines']['line1_texts'] = [t.text for t in lines[1]]
except Exception as e:
    out['PageWords_lines']['error'] = str(e)

# ---------- PageWords.text ----------
try:
    out['PageWords_text'] = pw.text
except Exception as e:
    out['PageWords_text'] = f'error: {e}'

# ---------- merge_wrapped_rows ----------
out['merge_wrapped_rows'] = {}
test_lines = [
    'PURCHASE ORDER',
    '1-1 AW11078 BLACK T-SHIRT 100 200 50',
    '1-2 AW11079 WHITE T-SHIRT 200 100 50',
    'TOTAL 300 300 100',
]
text = '\n'.join(test_lines)
try:
    out['merge_wrapped_rows']['simple'] = base.merge_wrapped_rows(text)
except Exception as e:
    out['merge_wrapped_rows']['simple_err'] = str(e)

# Test with TJX-style wrapped lines
tjx_text = '1-1 AW11078\nBLACK T-SHIRT\n100 200 50\n1-2 AW11079\nWHITE T-SHIRT\n200 100 50'
try:
    out['merge_wrapped_rows']['tjx'] = base.merge_wrapped_rows(tjx_text)
except Exception as e:
    out['merge_wrapped_rows']['tjx_err'] = str(e)

# ---------- extract_color_from_combined edge cases ----------
out['color_edge'] = {}
for txt in ['', 'BLACK', '59J', '59J 59J', 'MULTICOLOR', 'TIE DYE', 'ASST 1-3',
            '99J 99J LIGHT BLUE JEANS', 'C1 C1 NAVY BLUE', 'HEATHER GREY']:
    try:
        out['color_edge'][txt] = base.extract_color_from_combined(txt)
    except Exception as e:
        out['color_edge'][txt] = f'error: {e}'

# ---------- _PRODUCT_NAME_PATTERNS detail ----------
out['_PRODUCT_NAME_PATTERNS_detail'] = base._PRODUCT_NAME_PATTERNS

# ---------- BaseParser._channel ----------
out['BaseParser_channel'] = {}
BP = base.BaseParser
# Check if _channel is a method
try:
    sig = inspect.signature(BP._channel)
    out['BaseParser_channel']['sig'] = str(sig)
except Exception as e:
    out['BaseParser_channel']['sig_err'] = str(e)

# ---------- LineItemsParser methods detail ----------
out['LineItemsParser_detail'] = {}
LP = li.LineItemsParser
for mname in ['_build_entity', '_scoped', '_SIZE_TOKEN']:
    meth = getattr(LP, mname, None)
    if meth:
        try:
            sig = inspect.signature(meth)
            out['LineItemsParser_detail'][mname] = str(sig)
        except:
            out['LineItemsParser_detail'][mname] = 'no sig'

# Check _SIZE_TOKEN as property
if isinstance(getattr(LP, '_SIZE_TOKEN', None), property):
    out['LineItemsParser_detail']['_SIZE_TOKEN_is_property'] = True

# ---------- Check module-level attrs ----------
out['base_module_attrs'] = [a for a in dir(base) if not a.startswith('__')]
out['li_module_attrs'] = [a for a in dir(li) if not a.startswith('__')]

# ---------- Check for whole_document_text ----------
for attr in ['whole_document_text', 'is_total_line', 'is_data_line',
             'is_plausible_style', 'is_noise_line', 'split_packed_line',
             '_is_size_header_line', '_find_nearest_column', '_size_header',
             '_split_data_row', '_map_total_row', '_normalize_date',
             '_group_color_blocks', '_strip_product_name', '_strip_sku_prefix',
             '_is_sku_word']:
    val = getattr(base, attr, None)
    if val is not None:
        if callable(val):
            try:
                out.setdefault('base_callables', {})[attr] = str(inspect.signature(val))
            except:
                out.setdefault('base_callables', {})[attr] = 'no sig'
        else:
            out.setdefault('base_attrs', {})[attr] = repr(val)

# Same for line_items
for attr in ['_resolve_anchor', '_resolve_style', '_parse_tjx_sizes',
             '_extract_po_no', '_extract_color_from_middle', '_collapse_duplicate_lines',
             '_resolve_channel']:
    val = getattr(li, attr, None)
    if val is not None:
        if callable(val):
            try:
                out.setdefault('li_callables', {})[attr] = str(inspect.signature(val))
            except:
                out.setdefault('li_callables', {})[attr] = 'no sig'

sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1, default=str))
