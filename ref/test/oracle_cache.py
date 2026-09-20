#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
oracle_cache.py — 直接加载原版 Purchase Order Extractor V2 的 cache.pyc（PYZ 提取物），
对多组测试文本输出 layout_fingerprint / skeleton，作为 JS 翻译的 ground truth。
用法: ./py311/python.exe oracle_cache.py > oracle_cache.json
"""
import importlib.util
import json
import os
import sys

BASE = r'C:\Users\Administrator\.workbuddy\binaries\python\pyinstxtractor_tool\Purchase_Order_Extractor.exe_extracted\PYZ.pyz_extracted'


def load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, os.path.join(BASE, relpath))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# 构造 namespace packages（PYZ 提取的 pyc 树无 __init__.py）
import types
_pkg_core = types.ModuleType('core')
_pkg_core.__path__ = [os.path.join(BASE, 'core')]
sys.modules['core'] = _pkg_core
_pkg_store = types.ModuleType('core.store')
_pkg_store.__path__ = [os.path.join(BASE, 'core', 'store')]
sys.modules['core.store'] = _pkg_store

winpath = load('core.winpath', 'core/winpath.pyc')
models = load('core.models', 'core/models.pyc')
cache = load('core.store.cache', 'core/store/cache.pyc')

SAMPLES = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'oracle_samples.json'), encoding='utf-8'))

out = {"samples": {}}
for name, text in SAMPLES.items():
    out["samples"][name] = {
        "skeleton": cache.skeleton(text),
        "fp": cache.layout_fingerprint(text),
    }
print(json.dumps(out, ensure_ascii=False, indent=1))
