#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pyc_loader.py — 绕过魔数检查直接加载原版 .pyc（3.13 读 3.11 pyc）。
原理：pyc 头部 16 字节（magic+flags+timestamp+size）后用 marshal.loads 还原 code object，
再手动 exec 到 ModuleType 中。依赖模块需按 sys.modules 注册链预先注入。

用法：
    from pyc_loader import load_pyc
    mod = load_pyc('core.winpath', BASE + '/core/winpath.pyc', package='core')
"""
import marshal
import os
import sys
import types

HEADER_BYTES = 16  # Python 3.11 pyc 头长度


def load_pyc(name, pyc_path, package=None, path=None):
    """加载单个 .pyc 到 sys.modules[name]，返回模块对象。"""
    with open(pyc_path, 'rb') as fh:
        data = fh.read()
    code = marshal.loads(data[HEADER_BYTES:])
    mod = types.ModuleType(name)
    mod.__file__ = pyc_path
    mod.__name__ = name
    if package:
        mod.__package__ = package
    if path is not None:
        mod.__path__ = path
    sys.modules[name] = mod
    exec(code, mod.__dict__)
    return mod


def make_package(name, path):
    """注册一个包占位（带 __path__），使其可被 import 解析。"""
    pkg = types.ModuleType(name)
    pkg.__path__ = [path]
    sys.modules[name] = pkg
    return pkg
