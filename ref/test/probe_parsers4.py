#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""probe_parsers4.py — 深入探查 line_items 模块级函数行为。"""
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

# ---------- Module-level function signatures ----------
for name in ['_color_desc_from', '_dedup_entity_lines', '_parse_size_breakdown',
             '_pick_po_no', '_recover_style_from_line', 'merge_wrapped_rows',
             '_looks_like_style', '_min_date', '_norm_ship', '_to_float', '_to_int',
             '_clean', 'doc_text']:
    fn = getattr(li, name, None)
    if fn is not None:
        try:
            out.setdefault('sigs', {})[name] = str(inspect.signature(fn))
        except:
            out.setdefault('sigs', {})[name] = 'no sig'

# ---------- _pick_po_no behavior ----------
out['_pick_po_no'] = {}
if hasattr(li, '_pick_po_no'):
    import re
    # Simulate a match with named groups
    class FakeMatch:
        def __init__(self, gd):
            self._gd = gd
        def group(self, name=None):
            if name is None:
                return ' '.join(self._gd.values())
            return self._gd.get(name, '')
        def groupdict(self):
            return dict(self._gd)

    # Test: po_no as named group
    try:
        m1 = FakeMatch({'po_no': '11321589', 'channel': '1'})
        out['_pick_po_no']['named'] = li._pick_po_no(m1, 'Entity 1 Order No: 11321589 E-COMM')
    except Exception as e:
        out['_pick_po_no']['named_err'] = str(e)

    # Test: positional groups
    try:
        m2 = FakeMatch({'channel': '1', '': '11321589'})
        out['_pick_po_no']['positional'] = li._pick_po_no(m2, 'Entity 1 Order No: 11321589 E-COMM')
    except Exception as e:
        out['_pick_po_no']['positional_err'] = str(e)

# ---------- _recover_style_from_line ----------
out['_recover_style_from_line'] = {}
if hasattr(li, '_recover_style_from_line'):
    try:
        sig = inspect.signature(li._recover_style_from_line)
        out['_recover_style_from_line']['sig'] = str(sig)
    except:
        pass
    for captured, line in [
        ('1-1', '1-1 AW11078 BLACK T-SHIRT 100 200 50'),
        ('1-2', '1-2 AW11079 WHITE T-SHIRT 200 100 50'),
        ('637JO', '637JO 80X BEIGE 100 200'),
        ('1', '1 AW11078 BLACK 100'),
    ]:
        try:
            out['_recover_style_from_line'][f'{captured}|{line[:30]}'] = li._recover_style_from_line(captured, line)
        except Exception as e:
            out['_recover_style_from_line'][f'{captured}|{line[:30]}'] = f'error: {e}'

# ---------- _color_desc_from ----------
out['_color_desc_from'] = {}
if hasattr(li, '_color_desc_from'):
    try:
        sig = inspect.signature(li._color_desc_from)
        out['_color_desc_from']['sig'] = str(sig)
    except:
        pass
    # Test with various middle strings
    for middle in [
        'LADIES TROUSERS 08X 08X SAND',
        'SILVER CLOUD 53% LINEN',
        'DARK BLUE',
        'BLACK',
        '',
        '59J 59J DARK BLUE JEANS',
    ]:
        try:
            out['_color_desc_from'][middle[:40]] = li._color_desc_from(middle)
        except Exception as e:
            out['_color_desc_from'][middle[:40]] = f'error: {e}'

# ---------- _parse_size_breakdown ----------
out['_parse_size_breakdown'] = {}
if hasattr(li, '_parse_size_breakdown'):
    try:
        sig = inspect.signature(li._parse_size_breakdown)
        out['_parse_size_breakdown']['sig'] = str(sig)
    except:
        pass
    # Test ratio encoding: S:1, M:2, L:2, XL:1
    for line, row_total in [
        ('S:1, M:2, L:2, XL:1', 6),
        ('S:150, M:300, L:300, XL:150', 900),
        ('S:1, M:2, L:2, XL:1', 12),
        ('', 0),
    ]:
        try:
            result = li._parse_size_breakdown(line, row_total)
            out['_parse_size_breakdown'][f'{line[:30]}|{row_total}'] = [
                [sq.size, sq.qty] for sq in result
            ] if result else []
        except Exception as e:
            out['_parse_size_breakdown'][f'{line[:30]}|{row_total}'] = f'error: {e}'

# ---------- _dedup_entity_lines ----------
out['_dedup_entity_lines'] = {}
if hasattr(li, '_dedup_entity_lines'):
    try:
        sig = inspect.signature(li._dedup_entity_lines)
        out['_dedup_entity_lines']['sig'] = str(sig)
    except:
        pass

# ---------- LineItemsParser._build_entity ----------
out['_build_entity_test'] = {}
LP = li.LineItemsParser
# Create a simple recipe
recipe = m.PoRecipe(
    fingerprint='FP', customer='LPP SA', layout_type='line_items',
    line_pattern=r'^(\S+)\s+(\S+)\s+(\S+)\s+PACK\s+(\d+)\s+(\d+)$',
    order_unit='PCS',
)
try:
    # Can we instantiate?
    parser = LP()
    out['_build_entity_test']['instance'] = str(type(parser))
    out['_build_entity_test']['layout_type'] = parser.layout_type
except Exception as e:
    out['_build_entity_test']['init_err'] = str(e)

# ---------- doc_text ----------
out['doc_text_sig'] = {}
dt = getattr(li, 'doc_text', None) or getattr(base, 'doc_text', None)
if dt:
    try:
        out['doc_text_sig'] = str(inspect.signature(dt))
    except:
        out['doc_text_sig'] = 'no sig'

sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1, default=str))
