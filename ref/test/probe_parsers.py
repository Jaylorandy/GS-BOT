#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""probe_parsers.py — 探查 base.pyc / line_items.pyc 的类结构、方法签名、关键行为。

输出: probe_parsers.json
"""
import json
import os
import sys
import inspect
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

# Register packages
make_package('core', os.path.join(BASE, 'core'))
make_package('core.parsers', os.path.join(BASE, 'core', 'parsers'))
install_stub()

# Load dependencies first
m = load_pyc('core.models', os.path.join(BASE, 'core', 'models.pyc'), package='core')

# Try to load normalize
try:
    load_pyc('core.normalize', os.path.join(BASE, 'core', 'normalize.pyc'), package='core')
except Exception as e:
    sys.stderr.write(f'normalize load warning: {e}\n')

# Load base parser
base = load_pyc('core.parsers.base', os.path.join(BASE, 'core', 'parsers', 'base.pyc'), package='core.parsers')

# Load line_items parser
li = load_pyc('core.parsers.line_items', os.path.join(BASE, 'core', 'parsers', 'line_items.pyc'), package='core.parsers')

out = {}

# ---------- 1. Token class ----------
out['Token'] = {}
if hasattr(base, 'Token'):
    Tok = base.Token
    out['Token']['fields'] = [f for f in dir(Tok) if not f.startswith('_')]
    out['Token']['slots'] = getattr(Tok, '__slots__', None)
    # Try to create a Token
    try:
        t = Tok(text='hello', x0=1.0, y0=2.0, x1=3.0, y1=4.0, page=0)
        out['Token']['sample'] = {'text': t.text, 'x0': t.x0, 'y0': t.y0, 'x1': t.x1, 'y1': t.y1, 'page': t.page}
        out['Token']['repr'] = repr(t)
        out['Token']['eq_same'] = t == Tok(text='hello', x0=1.0, y0=2.0, x1=3.0, y1=4.0, page=0)
        out['Token']['eq_diff'] = t == Tok(text='world', x0=1.0, y0=2.0, x1=3.0, y1=4.0, page=0)
    except Exception as e:
        out['Token']['create_error'] = str(e)

# ---------- 2. PageWords class ----------
out['PageWords'] = {}
if hasattr(base, 'PageWords'):
    PW = base.PageWords
    out['PageWords']['fields'] = [f for f in dir(PW) if not f.startswith('_')]
    out['PageWords']['slots'] = getattr(PW, '__slots__', None)
    try:
        tokens = [
            Tok(text='A', x0=0, y0=0, x1=10, y1=10, page=0),
            Tok(text='B', x0=20, y0=0, x1=30, y1=10, page=0),
            Tok(text='C', x0=0, y0=15, x1=10, y1=25, page=0),
            Tok(text='D', x0=20, y0=15, x1=30, y1=25, page=0),
        ]
        pw = PW(page=0, width=100, height=100, tokens=tokens)
        out['PageWords']['sample'] = {'page': pw.page, 'width': pw.width, 'height': pw.height, 'ntokens': len(pw.tokens)}
        # Test group_lines
        try:
            lines = pw.group_lines(y_tol=5)
            out['PageWords']['group_lines'] = [[t.text for t in line] for line in lines]
        except Exception as e:
            out['PageWords']['group_lines_error'] = str(e)
    except Exception as e:
        out['PageWords']['create_error'] = str(e)

# ---------- 3. Module-level functions ----------
out['functions'] = {}
for name in ['is_total_line', 'is_data_line', 'is_plausible_style', 'is_noise_line',
             'split_packed_line', 'merge_wrapped_rows', 'whole_document_text',
             'extract_color_from_combined']:
    fn = getattr(base, name, None)
    if fn is None:
        out['functions'][name] = None
        continue
    try:
        sig = inspect.signature(fn)
        out['functions'][name] = {'sig': str(sig)}
    except Exception:
        out['functions'][name] = {'sig': 'unknown'}

# ---------- 4. Test is_total_line ----------
out['is_total_line'] = {}
if hasattr(base, 'is_total_line'):
    for txt in ['TOTAL', 'GRAND TOTAL', 'SUBTOTAL', 'SUM', '合计', '小计', '总计',
                'TOTAL QTY', 'No total here', '']:
        try:
            out['is_total_line'][txt] = base.is_total_line(txt)
        except Exception as e:
            out['is_total_line'][txt] = f'error: {e}'

# ---------- 5. Test is_plausible_style ----------
out['is_plausible_style'] = {}
if hasattr(base, 'is_plausible_style'):
    for cand in ['637JO', 'AW11078', '1', '1-1', '2-3', 'AB', 'ABC123', 'a', '12345', 'X-100', 'style_code']:
        try:
            out['is_plausible_style'][cand] = base.is_plausible_style(cand)
        except Exception as e:
            out['is_plausible_style'][cand] = f'error: {e}'

# ---------- 6. Test is_noise_line ----------
out['is_noise_line'] = {}
if hasattr(base, 'is_noise_line'):
    for ln in ['PURCHASE ORDER', 'Page 1 of 3', 'VENDOR: ABC CORP', 'TOTAL 500',
               '637JO-80X-S PACK 2 372', 'VAT REGNO: 12345', 'PLEASE NOTE:',
               'THE CONTRACT IS SUBJECT TO', 'Style No: 637JO', '']:
        try:
            out['is_noise_line'][ln] = base.is_noise_line(ln)
        except Exception as e:
            out['is_noise_line'][ln] = f'error: {e}'

# ---------- 7. Test extract_color_from_combined ----------
out['extract_color_from_combined'] = {}
if hasattr(base, 'extract_color_from_combined'):
    for txt in ['59J 59J DARK BLUE JEANS', '55J 99J LIGHT BLUE', 'DARK BLUE JEANS',
                'LIGHT BLUE', 'AW11078 BLACK', '08X 08X SAND', 'SILVER CLOUD']:
        try:
            out['extract_color_from_combined'][txt] = base.extract_color_from_combined(txt)
        except Exception as e:
            out['extract_color_from_combined'][txt] = f'error: {e}'

# ---------- 8. BaseParser class ----------
out['BaseParser'] = {}
if hasattr(base, 'BaseParser'):
    BP = base.BaseParser
    out['BaseParser']['methods'] = [f for f in dir(BP) if not f.startswith('__')]
    # Get __init__ signature
    try:
        sig = inspect.signature(BP.__init__)
        out['BaseParser']['init_sig'] = str(sig)
    except Exception:
        pass

# ---------- 9. LineItemsParser class ----------
out['LineItemsParser'] = {}
if hasattr(li, 'LineItemsParser'):
    LP = li.LineItemsParser
    out['LineItemsParser']['methods'] = [f for f in dir(LP) if not f.startswith('__')]
    out['LineItemsParser']['bases'] = [c.__name__ for c in LP.__bases__]
    try:
        sig = inspect.signature(LP.__init__)
        out['LineItemsParser']['init_sig'] = str(sig)
    except Exception:
        pass
    # Check if it has parse method
    if hasattr(LP, 'parse'):
        try:
            sig = inspect.signature(LP.parse)
            out['LineItemsParser']['parse_sig'] = str(sig)
        except Exception:
            pass

# ---------- 10. Test _normalize_date ----------
out['_normalize_date'] = {}
if hasattr(base, 'BaseParser'):
    # _normalize_date might be a method of BaseParser or module-level
    nd = getattr(base, '_normalize_date', None) or getattr(base.BaseParser, '_normalize_date', None)
    if nd:
        for dt in ['15.03.2024', '15.03.24', '2024-03-15', '1.5.2024', '2024-12-01']:
            try:
                if hasattr(nd, '__func__'):
                    out['_normalize_date'][dt] = nd.__func__(dt)
                else:
                    out['_normalize_date'][dt] = nd(dt)
            except Exception as e:
                out['_normalize_date'][dt] = f'error: {e}'

# ---------- 11. Test size regexes ----------
out['size_regex'] = {}
if hasattr(base, 'BaseParser'):
    # Check _SIZE_RE or similar
    for attr in dir(base):
        val = getattr(base, attr)
        if isinstance(val, re.Pattern):
            out['size_regex'][attr] = val.pattern

# ---------- 12. Product name patterns ----------
out['_PRODUCT_NAME_PATTERNS'] = getattr(base, '_PRODUCT_NAME_PATTERNS', None)

sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1, default=str))
