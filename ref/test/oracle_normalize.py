#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
oracle_normalize.py — 加载原版 normalize.pyc，导出词表 dict + 关键函数行为，
作为 JS 翻译 normalize.js 的 ground truth。
用法: ./py311/python.exe oracle_normalize.py > oracle_normalize.json
"""
import importlib.util
import json
import os
import sys
import types

BASE = r'C:\Users\Administrator\.workbuddy\binaries\python\pyinstxtractor_tool\Purchase_Order_Extractor.exe_extracted\PYZ.pyz_extracted'


def load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, os.path.join(BASE, relpath))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_pkg_core = types.ModuleType('core')
_pkg_core.__path__ = [os.path.join(BASE, 'core')]
sys.modules['core'] = _pkg_core
_pkg_store = types.ModuleType('core.store')
_pkg_store.__path__ = [os.path.join(BASE, 'core', 'store')]
sys.modules['core.store'] = _pkg_store

load('core.winpath', 'core/winpath.pyc')
load('core.models', 'core/models.pyc')
norm = load('core.normalize', 'core/normalize.pyc')

out = {}
for k in ('_SU_VOCAB', '_CURRENCY_VOCAB', '_PRICE_TERM_VOCAB', '_SHIP_MODE_VOCAB',
          '_COUNTRY_VOCAB', '_SIZE_VOCAB', '_PORT_FORBIDDEN_SHIP_WORDS',
          '_NORMALIZERS', '_DATE_FIELDS', '_EXPLICIT_FORMATS', '_NUMERIC_FORMATS'):
    out[k] = getattr(norm, k, None)

# 关键函数行为采样
out['_normalize_amount'] = {
    '1.234,56': norm._normalize_amount('1.234,56'),
    '1,234.56': norm._normalize_amount('1,234.56'),
    '26.000': norm._normalize_amount('26.000'),
    '158,00': norm._normalize_amount('158,00'),
    'USD 12.50': norm._normalize_amount('USD 12.50'),
    '12,345.67': norm._normalize_amount('12,345.67'),
    '1234': norm._normalize_amount('1234'),
    '': norm._normalize_amount(''),
    'FOB 8.77': norm._normalize_amount('FOB 8.77'),
}
out['_normalize_season'] = {
    'S/S 27': norm._normalize_season('S/S 27', {}),
    'SS 2027': norm._normalize_season('SS 2027', {}),
    'ss27': norm._normalize_season('ss27', {}),
    'FW2026': norm._normalize_season('FW2026', {}),
    'A/W 26': norm._normalize_season('A/W 26', {}),
    'SP 2025': norm._normalize_season('SP 2025', {}),
    'SU25': norm._normalize_season('SU25', {}),
    'HOLIDAY 26': norm._normalize_season('HOLIDAY 26', {}),
    '': norm._normalize_season('', {}),
}
out['_normalize_inseam'] = {
    '30 INCH': norm._normalize_inseam('30 INCH', {}),
    '30"': norm._normalize_inseam('30"', {}),
    '30IN': norm._normalize_inseam('30IN', {}),
    '30.5 INCHES': norm._normalize_inseam('30.5 INCHES', {}),
    'L': norm._normalize_inseam('L', {}),
    'LONG': norm._normalize_inseam('LONG', {}),
    '': norm._normalize_inseam('', {}),
}
out['_normalize_payment_terms'] = {
    'T/T 30 DAYS': norm._normalize_payment_terms('T/T 30 DAYS', {}),
    'TT 30D': norm._normalize_payment_terms('TT 30D', {}),
    'TT30DAYS': norm._normalize_payment_terms('TT30DAYS', {}),
    'L/C AT SIGHT': norm._normalize_payment_terms('L/C AT SIGHT', {}),
    'LC 60 DAYS': norm._normalize_payment_terms('LC 60 DAYS', {}),
    'DP 45 DAYS': norm._normalize_payment_terms('DP 45 DAYS', {}),
    'DA 90 DAYS': norm._normalize_payment_terms('DA 90 DAYS', {}),
    'OA 30 DAYS': norm._normalize_payment_terms('OA 30 DAYS', {}),
    'CASH AGAINST DOCUMENTS': norm._normalize_payment_terms('CASH AGAINST DOCUMENTS', {}),
    'TT HSBC 180 Days': norm._normalize_payment_terms('TT HSBC 180 Days', {}),
    '30 DAYS': norm._normalize_payment_terms('30 DAYS', {}),
    '': norm._normalize_payment_terms('', {}),
}
out['_normalize_size'] = {
    'XS': norm._normalize_size('XS', norm._SIZE_VOCAB),
    'X-S': norm._normalize_size('X-S', norm._SIZE_VOCAB),
    'EXTRA SMALL': norm._normalize_size('EXTRA SMALL', norm._SIZE_VOCAB),
    'SMALL': norm._normalize_size('SMALL', norm._SIZE_VOCAB),
    'MED': norm._normalize_size('MED', norm._SIZE_VOCAB),
    'LGE': norm._normalize_size('LGE', norm._SIZE_VOCAB),
    'EXTRA LARGE': norm._normalize_size('EXTRA LARGE', norm._SIZE_VOCAB),
    '30/32': norm._normalize_size('30/32', norm._SIZE_VOCAB),
    '30': norm._normalize_size('30', norm._SIZE_VOCAB),
    '2XL': norm._normalize_size('2XL', norm._SIZE_VOCAB),
}
out['_normalize_term'] = {
    'usd': norm._normalize_term('usd', norm._CURRENCY_VOCAB),
    'EUROS': norm._normalize_term('EUROS', norm._CURRENCY_VOCAB),
    'by sea': norm._normalize_term('by sea', norm._SHIP_MODE_VOCAB),
    'VESSEL': norm._normalize_term('VESSEL', norm._SHIP_MODE_VOCAB),
    'P.R.CHINA': norm._normalize_term('P.R.CHINA', norm._COUNTRY_VOCAB),
    'pc': norm._normalize_term('pc', norm._SU_VOCAB),
    'PAIRS': norm._normalize_term('PAIRS', norm._SU_VOCAB),
    'DOZENS': norm._normalize_term('DOZENS', norm._SU_VOCAB),
}
out['_normalize_date'] = {
    '13.03.2026': norm._normalize_date('13.03.2026', None, False),
    '2026-03-02': norm._normalize_date('2026-03-02', None, False),
    '02/03/2026': norm._normalize_date('02/03/2026', None, False),
    '02/03/2026_dayfirst': norm._normalize_date('02/03/2026', None, True),
    '13/03/2026': norm._normalize_date('13/03/2026', None, False),
    '26-03-02': norm._normalize_date('26-03-02', None, False),
    '03 Mar 2026': norm._normalize_date('03 Mar 2026', None, False),
    'Mar 3, 2026': norm._normalize_date('Mar 3, 2026', None, False),
    'not a date': norm._normalize_date('not a date', None, False),
    '3/4/2026': norm._normalize_date('3/4/2026', None, False),
}
print(json.dumps(out, ensure_ascii=False, indent=1, default=lambda o: sorted(o) if isinstance(o, (set, frozenset)) else str(o)))
