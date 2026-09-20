#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""probe_parsers3.py — 探查方法调用行为。"""
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

# ---------- Token.is_number ----------
out['Token_is_number'] = {}
for txt in ['500', '100', '12.50', 'abc', '', '3,000', '1-1', '-', '.', '0', '-3', '+5']:
    t = Tok(text=txt, x0=0, y0=0, x1=10, y1=10, page=0)
    try:
        out['Token_is_number'][txt] = t.is_number()
    except Exception as e:
        out['Token_is_number'][txt] = f'error: {e}'

# ---------- PageWords.lines (call as method) ----------
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
    lines = pw.lines()
    out['PageWords_lines']['nlines'] = len(lines)
    out['PageWords_lines']['line0'] = [t.text for t in lines[0]]
    out['PageWords_lines']['line1'] = [t.text for t in lines[1]]
except Exception as e:
    out['PageWords_lines']['error'] = str(e)
    # Try with y_tol
    try:
        lines = pw.lines(y_tol=5)
        out['PageWords_lines']['y_tol5_nlines'] = len(lines)
        out['PageWords_lines']['y_tol5_line0'] = [t.text for t in lines[0]]
    except Exception as e2:
        out['PageWords_lines']['y_tol5_error'] = str(e2)

# ---------- PageWords.text (call as method) ----------
try:
    out['PageWords_text'] = pw.text()
except Exception as e:
    out['PageWords_text'] = f'error: {e}'

# ---------- _SHIP_MAP ----------
out['_SHIP_MAP'] = getattr(base, '_SHIP_MAP', None)

# ---------- _FOOTER_MARGIN ----------
out['_FOOTER_MARGIN'] = getattr(base, '_FOOTER_MARGIN', None)

# ---------- size_columns ----------
out['size_columns'] = {}
if hasattr(base, 'size_columns'):
    try:
        sig = inspect.signature(base.size_columns)
        out['size_columns']['sig'] = str(sig)
    except:
        pass
    # Test with a header line
    header_tokens = [
        Tok(text='COLOR', x0=0, y0=0, x1=50, y1=10, page=0),
        Tok(text='NO', x0=55, y0=0, x1=70, y1=10, page=0),
        Tok(text='XS', x0=80, y0=0, x1=90, y1=10, page=0),
        Tok(text='S', x0=95, y0=0, x1=105, y1=10, page=0),
        Tok(text='M', x0=110, y0=0, x1=120, y1=10, page=0),
        Tok(text='L', x0=125, y0=0, x1=135, y1=10, page=0),
        Tok(text='XL', x0=140, y0=0, x1=155, y1=10, page=0),
        Tok(text='TOTAL', x0=200, y0=0, x1=240, y1=10, page=0),
    ]
    try:
        result = base.size_columns(header_tokens)
        out['size_columns']['result'] = [[t.text, t.xc] for t in result] if result else None
    except Exception as e:
        out['size_columns']['error'] = str(e)
    # Try with total_token param
    try:
        result = base.size_columns(header_tokens, total_token='TOTAL')
        out['size_columns']['with_total'] = [[t.text, t.xc] for t in result] if result else None
    except Exception as e:
        out['size_columns']['with_total_err'] = str(e)

# ---------- split_row_total ----------
out['split_row_total'] = {}
if hasattr(base, 'split_row_total'):
    try:
        sig = inspect.signature(base.split_row_total)
        out['split_row_total']['sig'] = str(sig)
    except:
        pass
    data_tokens = [
        Tok(text='637JO', x0=0, y0=20, x1=40, y1=30, page=0),
        Tok(text='80X', x0=45, y0=20, x1=65, y1=30, page=0),
        Tok(text='100', x0=80, y0=20, x1=95, y1=30, page=0),
        Tok(text='200', x0=95, y0=20, x1=110, y1=30, page=0),
        Tok(text='150', x0=110, y0=20, x1=125, y1=30, page=0),
        Tok(text='450', x0=200, y0=20, x1=240, y1=30, page=0),
    ]
    size_cols = [
        (Tok(text='XS', x0=80, y0=0, x1=90, y1=10, page=0), 85),
        (Tok(text='S', x0=95, y0=0, x1=105, y1=10, page=0), 100),
        (Tok(text='M', x0=110, y0=0, x1=120, y1=10, page=0), 115),
        (Tok(text='L', x0=125, y0=0, x1=135, y1=10, page=0), 130),
        (Tok(text='XL', x0=140, y0=0, x1=155, y1=10, page=0), 147.5),
        (Tok(text='TOTAL', x0=200, y0=0, x1=240, y1=10, page=0), 220),
    ]
    try:
        result = base.split_row_total(data_tokens, size_cols)
        out['split_row_total']['result'] = [[t.text for t in result[0]], result[1].text if result[1] else None]
    except Exception as e:
        out['split_row_total']['error'] = str(e)

# ---------- norm_date ----------
out['norm_date'] = {}
if hasattr(base, 'norm_date'):
    for dt in ['15.03.2024', '15.03.24', '2024-03-15', '1.5.2024', '2024-12-01', '', 'invalid']:
        try:
            out['norm_date'][dt] = base.norm_date(dt)
        except Exception as e:
            out['norm_date'][dt] = f'error: {e}'

# ---------- is_size_header ----------
out['is_size_header'] = {}
if hasattr(base, 'is_size_header'):
    try:
        sig = inspect.signature(base.is_size_header)
        out['is_size_header']['sig'] = str(sig)
    except:
        pass

# ---------- _to_int / _to_float ----------
out['_to_int'] = {}
for v in ['100', '200', '3,000', '12.5', 'abc', '', '5.7', '-3']:
    try:
        out['_to_int'][v] = base._to_int(v)
    except Exception as e:
        out['_to_int'][v] = f'error: {e}'

out['_to_float'] = {}
for v in ['10.20', '3,000', 'abc', '', '5.7', '12,50']:
    try:
        out['_to_float'][v] = base._to_float(v)
    except Exception as e:
        out['_to_float'][v] = f'error: {e}'

# ---------- _looks_like_style / _looks_like_sku ----------
out['_looks_like_style'] = {}
for v in ['637JO', 'AW11078', '1', '1-1', 'AB', 'ABC123', '12345', 'X-100']:
    try:
        out['_looks_like_style'][v] = base._looks_like_style(v)
    except Exception as e:
        out['_looks_like_style'][v] = f'error: {e}'

out['_looks_like_sku'] = {}
for v in ['59J', '08X', '1', 'ABC', '59J59J', '80X']:
    try:
        out['_looks_like_sku'][v] = base._looks_like_sku(v)
    except Exception as e:
        out['_looks_like_sku'][v] = f'error: {e}'

# ---------- merge_order_lines ----------
out['merge_order_lines'] = {}
if hasattr(base, 'merge_order_lines'):
    try:
        sig = inspect.signature(base.merge_order_lines)
        out['merge_order_lines']['sig'] = str(sig)
    except:
        pass

# ---------- parse_total_row ----------
out['parse_total_row'] = {}
if hasattr(base, 'parse_total_row'):
    try:
        sig = inspect.signature(base.parse_total_row)
        out['parse_total_row']['sig'] = str(sig)
    except:
        pass

# ---------- _line_is_priced ----------
out['_line_is_priced'] = {}
if hasattr(base, '_line_is_priced'):
    try:
        sig = inspect.signature(base._line_is_priced)
        out['_line_is_priced']['sig'] = str(sig)
    except:
        pass

sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1, default=str))
