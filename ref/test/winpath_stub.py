#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
winpath_stub.py — core.winpath 的纯 Python 替身。

原版 winpath.pyc 模块级 `import win32`（pywin32 C 扩展）在本机无 pywin32 时
segfault。其行为已从 core__winpath.txt 字符串 + oracle_models.json 的
HYPERLINK 输出完整还原：

    short_path(long_path)   -> 8.3 短路径或 None（本机无 pywin32 → 恒 None）
    full_path(path)         -> file:/// 前缀 + 反斜杠转正斜杠 + '#'/空格百分号编码
    hyperlink(path, label)  -> =HYPERLINK("url", "label")（引号翻倍）

用法：在加载 core.models 前先 install_stub()，把 'core.winpath' 注册进
sys.modules，models.pyc 的 `from core import winpath` 即命中替身。
"""
import sys
import types


def short_path(long_path):
    """Return the Windows 8.3 short path for long_path, or None."""
    return None  # 无 pywin32；原版失败时同样回落 full_path 百分号编码


def full_path(path):
    """Convert a local file path to a file:// URL that Excel can open."""
    s = str(path).replace('\\', '/')
    s = s.replace('#', '%23').replace(' ', '%20')
    return 'file:///' + s


def excel_hyperlink_formula(path, label):
    """Return an Excel HYPERLINK formula string, or plain label if no path."""
    if not path:
        return label if label is not None else ''
    url = full_path(path).replace('"', '""')
    lbl = str(label).replace('"', '""')
    return '=HYPERLINK("' + url + '", "' + lbl + '")'


hyperlink = excel_hyperlink_formula  # 兼容别名（原版函数名为 excel_hyperlink_formula）


def install_stub():
    """注册 core.winpath 替身到 sys.modules（幂等）。"""
    if 'core.winpath' in sys.modules:
        return sys.modules['core.winpath']
    mod = types.ModuleType('core.winpath')
    mod.__file__ = '<winpath_stub>'
    mod.__package__ = 'core'
    mod.short_path = short_path
    mod.full_path = full_path
    mod.excel_hyperlink_formula = excel_hyperlink_formula
    sys.modules['core.winpath'] = mod
    return mod


if __name__ == '__main__':
    # 自检：与 oracle_models.json 捕获的 HYPERLINK 完全一致
    out = excel_hyperlink_formula(r'C:\fake dir\PO_637JO_2627182_2026-01-15.pdf',
                                  'PO_637JO_2627182_2026-01-15.pdf')
    expect = ('=HYPERLINK("file:///C:/fake%20dir/PO_637JO_2627182_2026-01-15.pdf", '
              '"PO_637JO_2627182_2026-01-15.pdf")')
    print('MATCH' if out == expect else 'MISMATCH\n got: %s\nwant: %s' % (out, expect))
