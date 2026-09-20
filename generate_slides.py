#!/usr/bin/env python3
"""
Zara PPT Lookbook Generator v3
- 图片保持原始比例（缩放适配，不拉伸）
- 文字不重叠，固定Y坐标布局
- 统一Helvetica字体
- 统一字号规范
"""

import sys
import json
import re
import math
import base64
import io
import datetime
from pathlib import Path

# Force unbuffered stdout/stderr so Electron sees per-style progress lines.
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from PIL import Image
import os
import glob
from slides_scan_utils import (
    ensure_unique_output_path,
    find_any_image,
    find_image,
    list_folder_images,
    resolve_display_images,
    scan_style_entries as scan_style_entries_impl,
)
from slides_render_utils import (
    add_custom_text as render_custom_text,
    add_image_fit as render_image_fit,
    add_text as render_text,
    get_image_size as render_get_image_size,
)

if hasattr(sys.stdin, 'reconfigure'):
    sys.stdin.reconfigure(encoding='utf-8')
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')


# ── LLM 配置 ─────────────────────────────────────
# 这些配置会被前端传入的配置覆盖
LLM_ENABLED = False
LLM_TIMEOUT = 300  # 增加到 5 分钟，适应云端和复杂请求
LLM_MODEL = "qwen3-vl:8b"
LLM_URL = "http://localhost:11434"
LLM_API_KEY = None
LLM_PROVIDER = "ollama"  # 'ollama' 或 'openai'
ENABLE_VISION = False  # 视觉分析开关
PRECOMPUTED_INFO = {}
APPAREL_VISION_CONFIG = {}
ORGANIZE_METADATA_DIR = '_organize_meta'

CURRENCY_CODES = {
    'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'RMB', 'CHF', 'CAD', 'AUD', 'NZD',
    'HKD', 'SGD', 'KRW', 'THB', 'MYR', 'IDR', 'PHP', 'VND', 'INR', 'PKR',
    'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'RSD',
    'RUB', 'UAH', 'TRY', 'ILS', 'SAR', 'AED', 'QAR', 'KWD', 'BHD', 'OMR',
    'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'VES', 'UYU', 'BOB',
    'ZAR', 'EGP', 'NGN', 'KES', 'GHS', 'TZS', 'UGX', 'MAD', 'TND', 'DZD',
    'FJD', 'PGK', 'WST', 'TOP', 'VUV', 'ALL', 'AMD', 'AZN', 'BDT', 'BYN',
    'GEL', 'KZT', 'LKR', 'MMK', 'NPR', 'UZS', 'AFN', 'IRR', 'IQD', 'JOD',
    'LBP', 'SYP', 'YER',
}

COLOR_WORDS = {
    'black', 'white', 'red', 'blue', 'green', 'yellow', 'pink', 'purple',
    'orange', 'brown', 'grey', 'gray', 'beige', 'navy', 'khaki', 'olive',
    'cream', 'ivory', 'tan', 'camel', 'burgundy', 'maroon', 'teal',
    'cyan', 'magenta', 'lime', 'indigo', 'violet', 'gold', 'silver',
    'charcoal', 'chocolate', 'coral', 'crimson', 'fuchsia', 'lavender',
    'light', 'dark', 'bright', 'pale', 'deep', 'soft', 'pastel', 'sand',
    'stone', 'ecru', 'off-white', 'offwhite', 'natural',
}

# 向后兼容的旧变量名
OLLAMA_ENABLED = False
OLLAMA_TIMEOUT = 300
OLLAMA_MODEL = "qwen3-vl:8b"
OLLAMA_URL = "http://localhost:11434"


# ── 页面常量 ──────────────────────────────────────────
PAGE_WIDTH  = Inches(13.333)   # 16:9
PAGE_HEIGHT = Inches(7.5)

# ── 颜色 ─────────────────────────────────────────────
BLACK      = RGBColor(0, 0, 0)
GRAY       = RGBColor(128, 128, 128)
LIGHT_GRAY = RGBColor(180, 180, 180)
WHITE      = RGBColor(255, 255, 255)

# ── 主题模板 ─────────────────────────────────────────
# 每个主题定义：封面背景色、封面文字色、封面强调色、产品页背景色、
# 产品页文字色、标签色、分隔线色、品牌名色
THEMES = {
    'classic': {
        'name': 'Classic (Black & White)',
        'cover_bg': BLACK,
        'cover_text': WHITE,
        'cover_accent': RGBColor(220, 220, 220),
        'page_bg': WHITE,
        'page_text': BLACK,
        'label_color': GRAY,
        'divider': RGBColor(230, 230, 230),
        'brand_color': BLACK,
        'category_bg': RGBColor(245, 245, 245),
        'category_text': BLACK,
        'summary_bg': RGBColor(250, 250, 250),
    },
    'business': {
        'name': 'Business (Navy)',
        'cover_bg': RGBColor(26, 52, 92),
        'cover_text': WHITE,
        'cover_accent': RGBColor(100, 141, 201),
        'page_bg': WHITE,
        'page_text': RGBColor(33, 33, 33),
        'label_color': RGBColor(90, 90, 110),
        'divider': RGBColor(200, 210, 225),
        'brand_color': RGBColor(26, 52, 92),
        'category_bg': RGBColor(235, 240, 248),
        'category_text': RGBColor(26, 52, 92),
        'summary_bg': RGBColor(238, 242, 248),
    },
    'fashion': {
        'name': 'Fashion (Warm Earth)',
        'cover_bg': RGBColor(92, 64, 51),
        'cover_text': RGBColor(255, 248, 235),
        'cover_accent': RGBColor(210, 175, 140),
        'page_bg': RGBColor(253, 250, 247),
        'page_text': RGBColor(60, 45, 35),
        'label_color': RGBColor(140, 120, 100),
        'divider': RGBColor(225, 215, 200),
        'brand_color': RGBColor(92, 64, 51),
        'category_bg': RGBColor(245, 238, 230),
        'category_text': RGBColor(92, 64, 51),
        'summary_bg': RGBColor(248, 243, 237),
    },
    'modern': {
        'name': 'Modern (Minimal Gray)',
        'cover_bg': RGBColor(45, 45, 50),
        'cover_text': WHITE,
        'cover_accent': RGBColor(180, 180, 190),
        'page_bg': RGBColor(252, 252, 254),
        'page_text': RGBColor(40, 40, 48),
        'label_color': RGBColor(130, 130, 140),
        'divider': RGBColor(225, 225, 232),
        'brand_color': RGBColor(45, 45, 50),
        'category_bg': RGBColor(240, 240, 244),
        'category_text': RGBColor(45, 45, 50),
        'summary_bg': RGBColor(245, 245, 248),
    },
}

ACTIVE_THEME = THEMES['classic']

# ── 统一字体 ─────────────────────────────────────────
FONT_NAME = "Helvetica"

# ── 左侧文字区域（固定Y坐标，避免重叠）──────────────
LEFT_MARGIN   = Inches(0.5)
TEXT_WIDTH    = Inches(3.5)

# 每个文本块的 Y 坐标和高度（精心计算，不会重叠）
LAYOUT = {
    'style_number': {'y': 0.5,  'h': 0.3,  'size': 11, 'bold': True,  'color': 'gray'},
    'name':         {'y': 0.9,  'h': 0.8,  'size': 22, 'bold': True,  'color': 'black'},
    'price':        {'y': 1.8,  'h': 0.35, 'size': 16, 'bold': False, 'color': 'black'},
    'color_ref':    {'y': 2.2,  'h': 0.3,  'size': 10, 'bold': False, 'color': 'gray'},
    'desc_label':   {'y': 2.7,  'h': 0.25, 'size': 10, 'bold': True,  'color': 'black'},
    'description':  {'y': 3.0,  'h': 1.5,  'size': 10, 'bold': False, 'color': 'black'},
    'comp_label':   {'y': 4.7,  'h': 0.25, 'size': 10, 'bold': True,  'color': 'black'},
    'composition':  {'y': 5.0,  'h': 1.2,  'size': 10, 'bold': False, 'color': 'black'},
    'logo':         {'y': 6.8,  'h': 0.3,  'size': 14, 'bold': True,  'color': 'black'},
}

LABEL_MODE_LAYOUT = {
    'style_label':  {'y': 0.5,  'h': 0.2,  'size': 10, 'bold': False, 'color': 'gray'},
    'style_value':  {'y': 0.72, 'h': 0.45, 'size': 22, 'bold': True,  'color': 'black'},
    'fabric_label': {'y': 1.45, 'h': 0.22, 'size': 10, 'bold': True,  'color': 'black'},
    'fabric_value': {'y': 1.72, 'h': 0.4,  'size': 14, 'bold': False, 'color': 'black'},
    'desc_label':   {'y': 2.35, 'h': 0.22, 'size': 10, 'bold': True,  'color': 'black'},
    'description':  {'y': 2.62, 'h': 1.7,  'size': 10, 'bold': False, 'color': 'black'},
    'comp_label':   {'y': 4.38, 'h': 0.22, 'size': 10, 'bold': True,  'color': 'black'},
    'composition':  {'y': 4.65, 'h': 0.5,  'size': 10, 'bold': False, 'color': 'black'},
    'width_label':  {'y': 5.18, 'h': 0.22, 'size': 10, 'bold': True,  'color': 'black'},
    'width_value':  {'y': 5.45, 'h': 0.3,  'size': 10, 'bold': False, 'color': 'black'},
    'cuttable_label': {'y': 5.82, 'h': 0.22, 'size': 10, 'bold': True, 'color': 'black'},
    'cuttable_value': {'y': 6.09, 'h': 0.3, 'size': 10, 'bold': False, 'color': 'black'},
    'weight_label': {'y': 6.42, 'h': 0.22, 'size': 10, 'bold': True,  'color': 'black'},
    'weight_value': {'y': 6.69, 'h': 0.22,  'size': 10, 'bold': False, 'color': 'black'},
    'logo':         {'y': 6.8,  'h': 0.3,  'size': 14, 'bold': True,  'color': 'black'},
}

STYLE_MODE_LAYOUT = {
    'style_label':  {'y': 0.5,  'h': 0.2,  'size': 10, 'bold': False, 'color': 'gray'},
    'style_value':  {'y': 0.72, 'h': 0.35, 'size': 18, 'bold': True,  'color': 'black'},
    'name':         {'y': 1.15, 'h': 0.7,  'size': 18, 'bold': True,  'color': 'black'},
    'price':        {'y': 1.95, 'h': 0.32, 'size': 14, 'bold': False, 'color': 'black'},
    'color_label':  {'y': 2.45, 'h': 0.2,  'size': 10, 'bold': True,  'color': 'black'},
    'color_value':  {'y': 2.70, 'h': 0.42, 'size': 9,  'bold': False, 'color': 'gray'},
    'desc_label':   {'y': 3.18, 'h': 0.22, 'size': 10, 'bold': True,  'color': 'black'},
    'description':  {'y': 3.45, 'h': 0.78, 'size': 9,  'bold': False, 'color': 'black'},
    'fabric_label': {'y': 4.32, 'h': 0.2,  'size': 10, 'bold': True,  'color': 'black'},
    'fabric_value': {'y': 4.56, 'h': 0.24, 'size': 9,  'bold': False, 'color': 'black'},
    'comp_label':   {'y': 4.85, 'h': 0.22, 'size': 10, 'bold': True,  'color': 'black'},
    'composition':  {'y': 5.12, 'h': 0.48, 'size': 9,  'bold': False, 'color': 'black'},
    'width_label':  {'y': 5.66, 'h': 0.2,  'size': 10, 'bold': True,  'color': 'black'},
    'width_value':  {'y': 5.90, 'h': 0.24, 'size': 9,  'bold': False, 'color': 'black'},
    'cuttable_label': {'y': 6.17, 'h': 0.2, 'size': 10, 'bold': True, 'color': 'black'},
    'cuttable_value': {'y': 6.41, 'h': 0.24, 'size': 9, 'bold': False, 'color': 'black'},
    'weight_label': {'y': 6.68, 'h': 0.2,  'size': 10, 'bold': True,  'color': 'black'},
    'weight_value': {'y': 6.92, 'h': 0.24, 'size': 9,  'bold': False, 'color': 'black'},
    'logo':         {'y': 7.20, 'h': 0.3,  'size': 14, 'bold': True,  'color': 'black'},
}

LINDI_LAYOUT = {
    'style_value':  {'x': Inches(0.78), 'w': Inches(3.3), 'y': 0.48, 'h': 0.32, 'size': 18, 'bold': False, 'color': 'black'},
    'brand_value':  {'x': Inches(9.9),  'w': Inches(2.3), 'y': 0.48, 'h': 0.32, 'size': 18, 'bold': False, 'color': 'black'},
    'fabric_value': {'x': Inches(0.82), 'w': Inches(4.55), 'y': 6.34, 'h': 0.28, 'size': 13, 'bold': False, 'color': 'black'},
    'width_value':  {'x': Inches(0.82), 'w': Inches(4.55), 'y': 6.84, 'h': 0.28, 'size': 13, 'bold': False, 'color': 'black'},
    'cuttable_value': {'x': Inches(6.05), 'w': Inches(4.4), 'y': 6.34, 'h': 0.28, 'size': 13, 'bold': False, 'color': 'black'},
    'comp_value':   {'x': Inches(6.05), 'w': Inches(4.4), 'y': 6.84, 'h': 0.28, 'size': 13, 'bold': False, 'color': 'black'},
    'weight_value': {'x': Inches(9.25), 'w': Inches(3.0), 'y': 6.84, 'h': 0.28, 'size': 13, 'bold': False, 'color': 'black'},
    'remark_label': {'x': Inches(9.55), 'w': Inches(2.1), 'y': 2.18, 'h': 0.24, 'size': 16, 'bold': False, 'color': 'black'},
    'remark_value': {'x': Inches(9.55), 'w': Inches(3.0), 'y': 2.55, 'h': 2.15, 'size': 11, 'bold': False, 'color': 'black'},
}

# ── 右侧图片区域 ────────────────────────────────────
MODEL_X      = Inches(4.3)
MODEL_Y      = Inches(0.5)
MODEL_MAX_W  = Inches(4.2)
MODEL_MAX_H  = Inches(6.5)

FLAT_X       = Inches(9.2)
FLAT_TOP_Y   = Inches(0.3)
FLAT_BOT_Y   = Inches(3.9)
FLAT_MAX_W   = Inches(3.5)
FLAT_MAX_H   = Inches(3.3)

FRONTBACK_LEFT_X = Inches(4.55)
FRONTBACK_TOP_Y = Inches(0.45)
FRONTBACK_GAP = Inches(0.25)
FRONTBACK_MAX_W = Inches(4.1)
FRONTBACK_MAX_H = Inches(6.45)
FRONTBACK_RIGHT_X = FRONTBACK_LEFT_X + FRONTBACK_MAX_W + FRONTBACK_GAP

LINDI_FRONT_X = Inches(1.0)
LINDI_FRONT_Y = Inches(1.25)
LINDI_IMAGE_W = Inches(2.65)
LINDI_IMAGE_H = Inches(4.85)
LINDI_BACK_X = Inches(5.55)

FABRIC_SINGLE_LAYOUT = {
    'style':        {'x': Inches(0.78), 'w': Inches(4.8), 'y': 0.58, 'h': 0.4,  'size': 22, 'bold': True,  'color': 'black'},
    'brand':        {'x': Inches(0.82), 'w': Inches(3.0), 'y': 6.62, 'h': 0.32, 'size': 16, 'bold': True,  'color': 'black'},
    'fabric_code':  {'x': Inches(0.82), 'w': Inches(5.1), 'y': 1.38, 'h': 0.36, 'size': 14, 'bold': False, 'color': 'black'},
    'composition':  {'x': Inches(0.82), 'w': Inches(5.1), 'y': 1.84, 'h': 0.36, 'size': 14, 'bold': False, 'color': 'black'},
    'width':        {'x': Inches(0.82), 'w': Inches(5.1), 'y': 2.30, 'h': 0.34, 'size': 14, 'bold': False, 'color': 'black'},
    'cuttable':     {'x': Inches(0.82), 'w': Inches(5.1), 'y': 2.76, 'h': 0.34, 'size': 14, 'bold': False, 'color': 'black'},
    'weight':       {'x': Inches(0.82), 'w': Inches(5.1), 'y': 3.22, 'h': 0.34, 'size': 14, 'bold': False, 'color': 'black'},
    'description_label': {'x': Inches(0.82), 'w': Inches(5.1), 'y': 3.68, 'h': 0.24, 'size': 11, 'bold': True, 'color': 'black'},
    'description':  {'x': Inches(0.82), 'w': Inches(5.1), 'y': 3.97, 'h': 1.72, 'size': 11, 'bold': False, 'color': 'black'},
}

FABRIC_SINGLE_IMAGE = {
    'x': Inches(6.65),
    'y': Inches(1.0),
    'w': Inches(5.7),
    'h': Inches(5.75),
}

FABRIC_DOUBLE_BRAND = {'x': Inches(10.0), 'w': Inches(2.3), 'y': 0.32, 'h': 0.3, 'size': 16, 'bold': True, 'color': 'black'}
FABRIC_DOUBLE_DIVIDER_Y = Inches(3.82)
FABRIC_DOUBLE_ROWS = [
    {
        'style':       {'x': Inches(0.78), 'w': Inches(4.6), 'y': 0.58, 'h': 0.3,  'size': 17, 'bold': True,  'color': 'black'},
        'fabric_code': {'x': Inches(0.82), 'w': Inches(5.0), 'y': 1.14, 'h': 0.28, 'size': 12, 'bold': False, 'color': 'black'},
        'composition': {'x': Inches(0.82), 'w': Inches(5.0), 'y': 1.48, 'h': 0.28, 'size': 12, 'bold': False, 'color': 'black'},
        'width':       {'x': Inches(0.82), 'w': Inches(5.0), 'y': 1.82, 'h': 0.26, 'size': 12, 'bold': False, 'color': 'black'},
        'cuttable':    {'x': Inches(0.82), 'w': Inches(5.0), 'y': 2.16, 'h': 0.26, 'size': 12, 'bold': False, 'color': 'black'},
        'weight':      {'x': Inches(0.82), 'w': Inches(5.0), 'y': 2.50, 'h': 0.26, 'size': 12, 'bold': False, 'color': 'black'},
        'image':       {'x': Inches(7.2),  'y': Inches(0.78), 'w': Inches(4.7), 'h': Inches(2.8)},
    },
    {
        'style':       {'x': Inches(0.78), 'w': Inches(4.6), 'y': 4.1, 'h': 0.3,  'size': 17, 'bold': True,  'color': 'black'},
        'fabric_code': {'x': Inches(0.82), 'w': Inches(5.0), 'y': 4.66, 'h': 0.28, 'size': 12, 'bold': False, 'color': 'black'},
        'composition': {'x': Inches(0.82), 'w': Inches(5.0), 'y': 5.00, 'h': 0.28, 'size': 12, 'bold': False, 'color': 'black'},
        'width':       {'x': Inches(0.82), 'w': Inches(5.0), 'y': 5.34, 'h': 0.26, 'size': 12, 'bold': False, 'color': 'black'},
        'cuttable':    {'x': Inches(0.82), 'w': Inches(5.0), 'y': 5.68, 'h': 0.26, 'size': 12, 'bold': False, 'color': 'black'},
        'weight':      {'x': Inches(0.82), 'w': Inches(5.0), 'y': 6.02, 'h': 0.26, 'size': 12, 'bold': False, 'color': 'black'},
        'image':       {'x': Inches(7.2),  'y': Inches(4.3), 'w': Inches(4.7), 'h': Inches(2.8)},
    },
]

# Side-by-side fabric layout: two images per slide, each with a text box BELOW.
# Brand/folder name sits at the top-left; creation date sits at the bottom-left.
FABRIC_PAIR_BRAND = {'x': Inches(0.78), 'w': Inches(5.0), 'y': 0.32, 'h': 0.3, 'size': 16, 'bold': True, 'color': 'black'}
FABRIC_PAIR_DATE = {'x': Inches(0.78), 'w': Inches(3.0), 'y': 6.88, 'h': 0.3, 'size': 12, 'bold': True, 'color': 'black'}

FABRIC_PAIR_COLS = [
    {
        'image':       {'x': Inches(0.78), 'y': Inches(0.80), 'w': Inches(5.0), 'h': Inches(3.45)},
        'style':       {'x': Inches(0.78), 'w': Inches(5.0), 'y': 0.50, 'h': 0.28, 'size': 11, 'bold': True,  'color': 'black'},
        'fabric_code': {'x': Inches(0.78), 'w': Inches(5.0), 'y': 4.40, 'h': 0.30, 'size': 11, 'bold': False, 'color': 'black'},
        'composition': {'x': Inches(0.78), 'w': Inches(5.0), 'y': 4.78, 'h': 0.24, 'size': 10, 'bold': False, 'color': 'black'},
        'width':       {'x': Inches(0.78), 'w': Inches(5.0), 'y': 5.08, 'h': 0.24, 'size': 10, 'bold': False, 'color': 'black'},
        'cuttable':    {'x': Inches(0.78), 'w': Inches(5.0), 'y': 5.36, 'h': 0.24, 'size': 10, 'bold': False, 'color': 'black'},
        'weight':      {'x': Inches(0.78), 'w': Inches(5.0), 'y': 5.64, 'h': 0.24, 'size': 10, 'bold': False, 'color': 'black'},
        'description': {'x': Inches(0.78), 'w': Inches(5.0), 'y': 5.92, 'h': 0.85, 'size': 10, 'bold': False, 'color': 'black'},
    },
    {
        'image':       {'x': Inches(7.55), 'y': Inches(0.80), 'w': Inches(5.0), 'h': Inches(3.45)},
        'style':       {'x': Inches(7.55), 'w': Inches(5.0), 'y': 0.50, 'h': 0.28, 'size': 11, 'bold': True,  'color': 'black'},
        'fabric_code': {'x': Inches(7.55), 'w': Inches(5.0), 'y': 4.40, 'h': 0.30, 'size': 11, 'bold': False, 'color': 'black'},
        'composition': {'x': Inches(7.55), 'w': Inches(5.0), 'y': 4.78, 'h': 0.24, 'size': 10, 'bold': False, 'color': 'black'},
        'width':       {'x': Inches(7.55), 'w': Inches(5.0), 'y': 5.08, 'h': 0.24, 'size': 10, 'bold': False, 'color': 'black'},
        'cuttable':    {'x': Inches(7.55), 'w': Inches(5.0), 'y': 5.36, 'h': 0.24, 'size': 10, 'bold': False, 'color': 'black'},
        'weight':      {'x': Inches(7.55), 'w': Inches(5.0), 'y': 5.64, 'h': 0.24, 'size': 10, 'bold': False, 'color': 'black'},
        'description': {'x': Inches(7.55), 'w': Inches(5.0), 'y': 5.92, 'h': 0.85, 'size': 10, 'bold': False, 'color': 'black'},
    },
]


# ── AI 智能解析 ───────────────────────────────────
import concurrent.futures
import urllib.request
import urllib.error
import ssl

class LLMClient:
    """通用 LLM 客户端，支持 Ollama 和 OpenAI 兼容 API"""
    
    def __init__(self, base_url, model, api_key=None, provider='ollama'):
        self.base_url = base_url.rstrip('/') if base_url else ''
        self.model = model
        self.api_key = api_key
        self.provider = provider.lower()
        
    def validate_config(self):
        """验证配置是否有效"""
        if not self.base_url or not self.base_url.startswith(('http://', 'https://')):
            return False, f"无效的 URL: {self.base_url}"
        if not self.model:
            return False, "模型未配置"
        if self.provider in ('cloud', 'openai') and not self.api_key:
            return False, "云端/OpenAI 模式需要提供 API Key"
        return True, None
    
    def _create_ssl_context(self):
        """创建 SSL 上下文"""
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        return ssl_context
    
    def _build_request(self, prompt):
        """构建 HTTP 请求"""
        if self.provider == 'ollama':
            return self._build_ollama_request(prompt)
        else:
            return self._build_openai_request(prompt)
    
    def _build_ollama_request(self, prompt):
        """构建 Ollama 格式请求"""
        data = json.dumps({
            "model": self.model,
            "prompt": prompt,
            "stream": False
        }).encode('utf-8')
        
        req = urllib.request.Request(
            f'{self.base_url}/api/generate',
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        return req
    
    def _build_openai_request(self, prompt):
        """构建 OpenAI 兼容格式请求"""
        data = json.dumps({
            "model": self.model,
            "messages": [
                {"role": "system", "content": "You are a helpful assistant that extracts product information from text. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.3,
            "max_tokens": 1024
        }).encode('utf-8')
        
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {self.api_key}'
        }
        
        # 支持自定义端点或标准 OpenAI 端点（与 JS 侧 llm-client 一致：
        # baseUrl 已含 chat/completions 则原样使用，否则直接追加，不硬拼 /v1）
        if 'chat/completions' in self.base_url:
            url = self.base_url
        else:
            url = f'{self.base_url}/chat/completions'
        
        req = urllib.request.Request(
            url,
            data=data,
            headers=headers,
            method='POST'
        )
        return req
    
    def _parse_response(self, response_data):
        """解析响应数据"""
        if self.provider == 'ollama':
            return response_data.get('response', '')
        else:
            # OpenAI 格式
            choices = response_data.get('choices', [])
            if choices and len(choices) > 0:
                return choices[0].get('message', {}).get('content', '')
            return ''
    
    def call(self, prompt, timeout=300):
        """调用 LLM API"""
        try:
            req = self._build_request(prompt)
            ssl_context = self._create_ssl_context()
            
            with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as response:
                res = json.loads(response.read().decode('utf-8'))
                response_text = self._parse_response(res)
                
                # 使用安全解析
                parsed = safe_json_parse(response_text)
                if parsed:
                    return {'success': True, 'data': parsed}
                else:
                    return {'success': False, 'error': f'无法解析响应: {response_text[:200]}'}
                    
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8') if e.read() else str(e)
            return {'success': False, 'error': f'HTTP {e.code}: {error_body}'}
        except urllib.error.URLError as e:
            return {'success': False, 'error': f'连接错误: {e.reason}'}
        except Exception as e:
            return {'success': False, 'error': str(e)}


def validate_llm_config():
    """验证 LLM 配置是否有效（向后兼容）"""
    # 优先使用新的全局变量
    url = LLM_URL if LLM_ENABLED else OLLAMA_URL
    model = LLM_MODEL if LLM_ENABLED else OLLAMA_MODEL
    
    if not url or not url.startswith(('http://', 'https://')):
        return False, f"无效的 URL: {url}"
    if not model:
        return False, "模型未配置"
    return True, None

# 向后兼容
validate_ollama_config = validate_llm_config

def safe_json_parse(text, max_retries=3):
    """安全解析 JSON，支持多种格式容错"""
    if not text:
        return None
    
    # 清理文本
    text = text.strip()
    
    # 尝试直接解析
    for attempt in range(max_retries):
        try:
            # 方法1: 直接解析
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        
        # 方法2: 提取 JSON 对象（支持嵌套）
        try:
            # 匹配最外层的大括号
            depth = 0
            start = -1
            for i, char in enumerate(text):
                if char == '{':
                    if depth == 0:
                        start = i
                    depth += 1
                elif char == '}':
                    depth -= 1
                    if depth == 0 and start != -1:
                        json_str = text[start:i+1]
                        return json.loads(json_str)
        except (json.JSONDecodeError, ValueError):
            pass
        
        # 方法3: 使用正则表达式提取
        try:
            json_match = re.search(r'\{[\s\S]*?\}', text)
            if json_match:
                return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass
        
        # 如果还有重试次数，尝试清理文本
        if attempt < max_retries - 1:
            # 移除可能的 Markdown 代码块标记
            text = re.sub(r'```json\s*|\s*```', '', text)
            # 移除控制字符
            text = ''.join(char for char in text if ord(char) >= 32 or char in '\n\r\t')
    
    return None

def call_llm_api(prompt, timeout):
    """调用 LLM API，支持 Ollama 和 OpenAI 格式"""
    # 优先使用新的全局变量
    url = LLM_URL if LLM_ENABLED else OLLAMA_URL
    model = LLM_MODEL if LLM_ENABLED else OLLAMA_MODEL
    api_key = LLM_API_KEY
    provider = LLM_PROVIDER if LLM_ENABLED else 'ollama'
    
    client = LLMClient(url, model, api_key, provider)
    return client.call(prompt, timeout)

# 向后兼容
call_ollama_api = call_llm_api

def call_llm_api_with_image(prompt, image_base64, timeout, override=None):
    """调用支持图片的 LLM API"""
    override = override or {}
    url = override.get('url') or (LLM_URL if LLM_ENABLED else OLLAMA_URL)
    model = override.get('model') or (LLM_MODEL if LLM_ENABLED else OLLAMA_MODEL)
    api_key = override.get('api_key') if 'api_key' in override else LLM_API_KEY
    provider = override.get('provider') or (LLM_PROVIDER if LLM_ENABLED else 'ollama')
    
    try:
        if provider == 'ollama':
            # Ollama 视觉模型格式
            data = json.dumps({
                "model": model,
                "prompt": prompt,
                "images": [image_base64],
                "stream": False,
                "options": {
                    "temperature": 0.3,
                    "num_predict": 1024,
                }
            }).encode('utf-8')
            
            req = urllib.request.Request(
                f'{url}/api/generate',
                data=data,
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
        else:
            # OpenAI 兼容格式（GPT-4V 等）
            data = json.dumps({
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{image_base64}"
                                }
                            }
                        ]
                    }
                ],
                "temperature": 0.3,
                "max_tokens": 1024
            }).encode('utf-8')
            
            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {api_key}'
            }
            
            if 'chat/completions' in url:
                api_url = url
            else:
                api_url = f'{url}/chat/completions'
            
            req = urllib.request.Request(
                api_url,
                data=data,
                headers=headers,
                method='POST'
            )
        
        # 创建 SSL 上下文
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as response:
            res = json.loads(response.read().decode('utf-8'))
            
            # 解析响应
            if provider == 'ollama':
                response_text = res.get('response', '')
            else:
                choices = res.get('choices', [])
                if choices and len(choices) > 0:
                    response_text = choices[0].get('message', {}).get('content', '')
                else:
                    response_text = ''
            
            # 使用安全解析
            parsed = safe_json_parse(response_text)
            if parsed:
                return {'success': True, 'data': parsed}
            else:
                return {'success': False, 'error': f'无法解析响应: {response_text[:200]}'}
                
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8') if e.read() else str(e)
        return {'success': False, 'error': f'HTTP {e.code}: {error_body}'}
    except urllib.error.URLError as e:
        return {'success': False, 'error': f'连接错误: {e.reason}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def parse_with_llm(text, folder_name, brand, max_retries=2, image_path=None):
    """使用 LLM 智能解析产品信息（通用版，支持 Ollama 和 OpenAI）
    
    Args:
        text: 要解析的文本
        folder_name: 文件夹名称（作为备用款号）
        brand: 品牌名称
        max_retries: 最大重试次数
        image_path: 可选，款式图片路径（用于视觉分析）
    
    Returns:
        dict: 解析成功返回数据字典，失败返回 None
    """
    # 优先使用新的全局变量
    enabled = LLM_ENABLED if LLM_ENABLED else OLLAMA_ENABLED
    timeout = LLM_TIMEOUT if LLM_ENABLED else OLLAMA_TIMEOUT
    provider = LLM_PROVIDER if LLM_ENABLED else 'ollama'
    enable_vision = ENABLE_VISION if ENABLE_VISION else False
    
    if not enabled:
        return None
    
    # 验证配置
    is_valid, error_msg = validate_llm_config()
    if not is_valid:
        print(f"  ⚠️ LLM 配置错误: {error_msg}")
        return None

    # 准备图片数据（如果启用视觉分析且有图片路径）
    image_data = None
    if enable_vision and image_path and os.path.exists(image_path):
        try:
            from PIL import Image
            # 压缩图片以减少传输大小
            with Image.open(image_path) as img:
                # 调整大小到最大 800px
                max_size = 800
                if img.width > max_size or img.height > max_size:
                    ratio = min(max_size / img.width, max_size / img.height)
                    new_size = (int(img.width * ratio), int(img.height * ratio))
                    img = img.resize(new_size, Image.Resampling.LANCZOS)
                
                # 转换为 base64
                import io
                buffer = io.BytesIO()
                img_format = 'JPEG' if img.mode == 'RGB' else 'PNG'
                if img.mode in ('RGBA', 'P'):
                    img = img.convert('RGB')
                img.save(buffer, format=img_format, quality=85)
                image_data = base64.b64encode(buffer.getvalue()).decode('utf-8')
                print(f"  📷 已加载图片: {os.path.basename(image_path)} ({len(image_data)} bytes)")
        except Exception as e:
            print(f"  ⚠️ 图片处理失败: {e}")
            image_data = None

    # 构建 prompt
    if image_data:
        # 视觉分析模式 - 更详细的 prompt，强制 JSON 格式
        prompt = f"""You are a product information extraction system. Analyze the product image and return ONLY a valid JSON object.

IMPORTANT: Return ONLY the JSON object, no other text, no markdown, no explanations.

Analyze the clothing item in the image and extract:
1. Product type (dress, jacket, pants, shirt, etc.)
2. Style/cut description  
3. Key design features (collar, sleeves, patterns, etc.)
4. Overall aesthetic
5. Dominant color

Based on your analysis, generate:
- A concise product name (2-5 words describing the garment)
- A brief description (1-2 sentences about style and features)

Return this JSON format (replace the example values with your actual analysis):
{{"styleNumber": "{folder_name}", "name": "Cargo Pants", "color": "Olive Green", "price": "", "description": "Relaxed fit cargo pants with multiple pockets and adjustable cuffs.", "composition": ""}}

Text reference (optional):
{text[:300]}

REMEMBER: Return ONLY the JSON object with real values, not placeholder text."""
    else:
        # 纯文本模式
        prompt = f"""Extract product info from text. Return JSON only:
{{
  "styleNumber": "use folder name if not found: {folder_name}",
  "name": "product name",
  "color": "color",
  "price": "",
  "description": "short description",
  "composition": "fabric composition"
}}

Text:
{text[:1000]}
"""

    last_error = None
    provider_name = "OpenAI" if provider != 'ollama' else "Ollama"
    analysis_mode = "视觉分析" if image_data else "文本分析"
    
    for attempt in range(max_retries + 1):
        try:
            print(f"  🔍 {analysis_mode}中...")
            
            # 使用 ThreadPoolExecutor 实现超时控制
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                if image_data:
                    # 视觉分析模式
                    future = executor.submit(call_llm_api_with_image, prompt, image_data, timeout + 5)
                else:
                    # 纯文本模式
                    future = executor.submit(call_llm_api, prompt, timeout + 5)
                try:
                    result = future.result(timeout=timeout)
                except concurrent.futures.TimeoutError:
                    print(f"  ⏱️ {provider_name} 请求超时 ({timeout}s)")
                    last_error = "请求超时"
                    continue
            
            if result.get('success'):
                data = result.get('data')
                if data and isinstance(data, dict):
                    print(f"  ✓ {provider_name} {analysis_mode}成功")
                    return data
                else:
                    last_error = "返回数据格式无效"
            else:
                error = result.get('error', '未知错误')
                print(f"  ⚠️ {provider_name} 调用失败 (尝试 {attempt + 1}/{max_retries + 1}): {error}")
                last_error = error
                
                # 如果是配置错误，不再重试
                if '配置错误' in error or '无效的' in error:
                    break
                    
        except Exception as e:
            last_error = str(e)
            print(f"  ⚠️ {provider_name} 异常 (尝试 {attempt + 1}/{max_retries + 1}): {e}")
    
    print(f"  ✗ {provider_name} 解析失败: {last_error}")
    return None

# 向后兼容
parse_with_ollama = parse_with_llm


# ── 工具函数 ─────────────────────────────────────────

def resolve_apparel_vision_settings():
    config = APPAREL_VISION_CONFIG or {}
    # When no fabric model is explicitly configured, fall back to the main LLM model
    # instead of relying on a default (gr3-fabric) that may not be installed.
    fabric_model = config.get('fabricModel')
    if not fabric_model:
        fabric_model = LLM_MODEL if LLM_ENABLED else 'gr3-fabric'
    # When no explicit apparel vision config exists, fully inherit api_key and
    # provider from the main LLM so the API call format matches (OpenAI vs Ollama).
    # Ollama endpoints (local / ollama.com) stay on the Ollama REST format even
    # when an api key is present.
    base_url = config.get('baseUrl') or LLM_URL or OLLAMA_URL
    api_key = config.get('apiKey') or (LLM_API_KEY if LLM_ENABLED else '')
    provider = (LLM_PROVIDER if LLM_ENABLED else 'ollama')
    if config.get('apiKey') and not _is_ollama_url(base_url):
        provider = 'openai'
    return {
        'enabled': bool(config.get('enabled', True)),
        'base_url': base_url,
        'garment_model': config.get('garmentModel') or 'moondream:1.8b',
        'fabric_model': fabric_model,
        'api_key': api_key,
        'provider': provider,
    }


def load_image_as_base64(image_path, max_size=800):
    if not image_path or not os.path.exists(image_path):
        return None

    with Image.open(image_path) as img:
        if img.width > max_size or img.height > max_size:
            ratio = min(max_size / img.width, max_size / img.height)
            new_size = (int(img.width * ratio), int(img.height * ratio))
            img = img.resize(new_size, Image.Resampling.LANCZOS)

        buffer = io.BytesIO()
        img_format = 'JPEG' if img.mode == 'RGB' else 'PNG'
        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')
        img.save(buffer, format=img_format, quality=85)
        return base64.b64encode(buffer.getvalue()).decode('utf-8')


def parse_with_apparel_vision(text, folder_name, image_path):
    settings = resolve_apparel_vision_settings()
    if not settings['enabled']:
        return None

    image_data = load_image_as_base64(image_path)
    if not image_data:
        return None

    context = text[:500] if text else 'No additional context provided.'
    garment_prompt = f"""You are a specialist garment vision model for apparel presentations.
Return ONLY JSON:
{{
  "name": "",
  "category": "",
  "fit": "",
  "details": ["", ""],
  "description": ""
}}

Rules:
- Ignore tiny attached hangtags or care labels on the garment itself.
- Focus on garment category, fit, silhouette, and visible construction details.
- Keep the description short and presentation-ready.
- If style number is not visible, reuse {folder_name}.

Context:
{context}
"""
    fabric_prompt = f"""You are a specialist fabric-reading vision model for apparel.
Return ONLY JSON:
{{
  "fabricAppearance": "",
  "textileSignals": ["", ""],
  "description": ""
}}

Rules:
- Describe weave, texture, wash, finish, and surface cues only.
- Do not invent composition percentages.

Context:
{context}
"""

    garment_result = call_llm_api_with_image(
        garment_prompt,
        image_data,
        LLM_TIMEOUT,
        {
            'url': settings['base_url'],
            'model': settings['garment_model'],
            'api_key': settings['api_key'],
            'provider': settings['provider'],
        },
    )
    fabric_result = call_llm_api_with_image(
        fabric_prompt,
        image_data,
        LLM_TIMEOUT,
        {
            'url': settings['base_url'],
            'model': settings['fabric_model'],
            'api_key': settings['api_key'],
            'provider': settings['provider'],
        },
    )

    garment_data = garment_result.get('data') if garment_result.get('success') else {}
    fabric_data = fabric_result.get('data') if fabric_result.get('success') else {}
    if not garment_data and not fabric_data:
        return None

    detail_bits = [str(item).strip() for item in garment_data.get('details', []) if str(item).strip()]
    textile_bits = [str(item).strip() for item in fabric_data.get('textileSignals', []) if str(item).strip()]

    merged_description_parts = []
    if garment_data.get('description'):
        merged_description_parts.append(str(garment_data.get('description')).strip())
    if fabric_data.get('description'):
        merged_description_parts.append(str(fabric_data.get('description')).strip())
    elif fabric_data.get('fabricAppearance'):
        merged_description_parts.append(f"Fabric appearance: {str(fabric_data.get('fabricAppearance')).strip()}")
    if textile_bits:
        merged_description_parts.append(f"Textile cues: {', '.join(textile_bits[:4])}")

    merged_description = ' '.join(part for part in merged_description_parts if part).strip()
    return {
        'styleNumber': folder_name,
        'name': str(garment_data.get('name') or '').strip(),
        'category': str(garment_data.get('category') or '').strip(),
        'fit': str(garment_data.get('fit') or '').strip(),
        'description': merged_description,
        'details': detail_bits,
        'textileSignals': textile_bits,
    }


def parse_with_fabric_vision(text, folder_name, image_path):
    settings = resolve_apparel_vision_settings()
    if not settings['enabled']:
        return None

    image_data = load_image_as_base64(image_path)
    if not image_data:
        return None

    context = text[:500] if text else 'No additional context provided.'
    fabric_prompt = f"""You are a specialist fabric-reading vision model for apparel imagery.
Return ONLY JSON:
{{
  "fabricAppearance": "",
  "textileSignals": ["", ""],
  "description": ""
}}

Rules:
- Focus on weave, surface texture, wash, finish, handfeel cues, density, and textile appearance.
- Keep the description short, professional, and presentation-ready.
- Do not invent composition percentages or lab-tested specs.

Context:
{context}
"""

    fabric_result = call_llm_api_with_image(
        fabric_prompt,
        image_data,
        LLM_TIMEOUT,
        {
            'url': settings['base_url'],
            'model': settings['fabric_model'],
            'api_key': settings['api_key'],
            'provider': settings['provider'],
        },
    )

    if not fabric_result.get('success'):
        error_msg = fabric_result.get('error', 'Unknown error')
        print(f"  ⚠️ Fabric vision call failed ({settings['fabric_model']}): {error_msg}")
        return None

    fabric_data = fabric_result.get('data') if fabric_result.get('success') else {}
    if not fabric_data:
        return None

    textile_bits = [str(item).strip() for item in fabric_data.get('textileSignals', []) if str(item).strip()]
    description_parts = []
    if fabric_data.get('description'):
        description_parts.append(str(fabric_data.get('description')).strip())
    elif fabric_data.get('fabricAppearance'):
        description_parts.append(str(fabric_data.get('fabricAppearance')).strip())
    if textile_bits:
        description_parts.append(f"Textile cues: {', '.join(textile_bits[:4])}")

    return {
        'styleNumber': folder_name,
        'description': ' '.join(part for part in description_parts if part).strip(),
        'textileSignals': textile_bits,
    }

def get_image_size(img_path):
    return render_get_image_size(img_path)


def add_image_fit(slide, img_path, x, y, max_w, max_h):
    return render_image_fit(slide, img_path, x, y, max_w, max_h)


def add_text(slide, text, y_key, override_text=None):
    return render_text(
        slide,
        text,
        y_key,
        LAYOUT,
        LEFT_MARGIN,
        TEXT_WIDTH,
        FONT_NAME,
        {'black': BLACK, 'gray': GRAY, 'white': WHITE, 'light_gray': LIGHT_GRAY},
        override_text=override_text,
    )


def add_custom_text(slide, text, cfg):
    return render_custom_text(
        slide,
        text,
        cfg,
        FONT_NAME,
        {'black': BLACK, 'gray': GRAY, 'white': WHITE, 'light_gray': LIGHT_GRAY},
        LEFT_MARGIN,
        TEXT_WIDTH,
    )


# ── 流式文字布局 ────────────────────────────────────
# 固定 Y 坐标会在字段被关闭或文本过长时造成空隙或重叠。FlowColumn 维护一个
# 自上而下的游标，按每个文本块的真实行数估算高度后顺序排布，保证"灵活分布、
# 不挤压重叠"。logo 始终固定在底部安全边距之上。
SLIDE_HEIGHT_IN = 7.5


def _estimate_text_height(text, cfg, width_in):
    """估算一段文本在给定字号/宽度下的渲染高度（英寸）。"""
    size = cfg.get('size', 10)
    # 每英寸宽度约可容纳的字符数（按字号反比，经验值）。
    chars_per_inch = max(1.0, 110.0 / size)
    max_chars_per_line = max(1, int(width_in * chars_per_inch))
    line_count = 0
    for raw_line in str(text).split('\n'):
        line = raw_line.rstrip()
        if not line:
            line_count += 1
            continue
        line_count += max(1, math.ceil(len(line) / max_chars_per_line))
    line_count = max(1, line_count)
    # 行高（英寸）≈ 字号(pt) * 行距 / 72。
    line_height = size * 1.2 / 72.0
    return line_count * line_height


class FlowColumn:
    """自上而下顺序排布文本块，避免重叠/空隙。"""

    def __init__(self, slide, top=0.5, left_margin=None, text_width=None,
                 gap=0.12, label_gap=0.04, bottom_limit=None):
        self.slide = slide
        self.y = float(top)
        self.left_margin = left_margin if left_margin is not None else LEFT_MARGIN
        self.text_width = text_width if text_width is not None else TEXT_WIDTH
        self.gap = gap
        self.label_gap = label_gap
        self.bottom_limit = bottom_limit if bottom_limit is not None else (SLIDE_HEIGHT_IN - 0.3)

    def add(self, text, base_cfg, gap_before=None, tight=False):
        """排布一个文本块；tight=True 表示与下一块（值）贴紧（用于 label）。"""
        if text is None or str(text) == '':
            return
        if gap_before is not None:
            self.y += gap_before
        # 估算宽度（英寸）：cfg 里的 w 可能是 Emu(Inches(...)) 整数，也可能缺省。
        raw_w = base_cfg.get('w', self.text_width)
        try:
            width_in = Emu(raw_w).inches if isinstance(raw_w, int) else float(raw_w)
        except Exception:
            width_in = 3.5
        est_h = _estimate_text_height(text, base_cfg, max(0.5, width_in))
        if self.y + est_h > self.bottom_limit:
            est_h = max(0.18, self.bottom_limit - self.y)
        cfg = dict(base_cfg)
        cfg['y'] = self.y
        cfg['h'] = est_h
        add_custom_text(self.slide, text, cfg)
        self.y += est_h + (self.label_gap if tight else self.gap)


def add_logo_pinned(slide, brand, base_cfg):
    """品牌名固定在底部安全边距之上（不贴页边）。"""
    cfg = dict(base_cfg)
    cfg['h'] = 0.3
    # 底边距 0.32"：避免太靠近页边。
    cfg['y'] = SLIDE_HEIGHT_IN - cfg['h'] - 0.32
    add_custom_text(slide, brand.upper() if brand else 'BRAND', cfg)


def looks_like_price_text(line):
    text = str(line or '').strip()
    if not text or not re.search(r'\d', text):
        return False
    if re.search(r'[$€¥£₹₽₩฿₪₱₦₴₡₵₸₺₼₾₿]', text):
        return True
    if re.search(r'\b(?:' + '|'.join(sorted(CURRENCY_CODES)) + r')\b', text, re.I):
        return True
    if re.search(r'\d{1,3}[,\.]\d{3}', text) and not re.search(r'\d{4}[\.]\d{2}[\.]\d{2}', text):
        return True
    return False


def looks_like_color_text(line):
    text = str(line or '').strip()
    if not text:
        return False
    if '|' in text and re.search(r'\d{3,4}\s*[/ ]\s*\d{3}', text):
        return True
    if re.match(r'^(color|colour|颜色)\s*[:：]', text, re.I):
        return True
    words = re.findall(r'[A-Za-z-]+', text.lower())
    if 0 < len(words) <= 3 and any(word in COLOR_WORDS for word in words):
        return True
    return False


def sanitize_text_block(value):
    if value is None:
        return ''
    if isinstance(value, list):
        value = '\n'.join(str(item or '') for item in value if item)
    elif isinstance(value, dict):
        value = '\n'.join(f"{key}: {item}" for key, item in value.items() if item)
    text = str(value).replace('\r', '\n')
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    return '\n'.join(lines).strip()


def sanitize_description_text(value):
    lines = sanitize_text_block(value).split('\n')
    filtered = []
    for line in lines:
        if not line:
            continue
        if looks_like_price_text(line) or looks_like_color_text(line):
            continue
        if re.match(r'^(outer shell|lining|composition|main fabric|secondary fabric|shell|filling|padding)\b', line, re.I):
            continue
        if re.match(r'^(received on)\b', line, re.I):
            continue
        filtered.append(line)

    collapsed = ' '.join(filtered)
    return re.sub(r'\s{2,}', ' ', collapsed).strip()


def sanitize_color_ref(value):
    text = sanitize_text_block(value)
    if not text:
        return ''
    lines = [line for line in text.split('\n') if looks_like_color_text(line) or re.search(r'\d{3,4}\s*[/ ]\s*\d{3}', line)]
    return '\n'.join(lines).strip() if lines else text


def merge_info_records(base, overlay):
    result = dict(base or {})
    for key, value in (overlay or {}).items():
        if value is None:
            continue
        if isinstance(value, str):
            if value.strip():
                result[key] = value
            continue
        if isinstance(value, (list, dict)):
            if value:
                result[key] = value
            continue
        result[key] = value
    return result


def load_saved_info_file(folder, style_number):
    direct_candidates = [
        os.path.join(folder, f"{style_number}_info.json"),
        os.path.join(folder, f"{style_number}.json"),
        os.path.join(folder, "info.json"),
    ]
    wildcard_candidates = glob.glob(os.path.join(folder, "*_info.json"))
    candidates = [path for path in direct_candidates if os.path.exists(path)]
    if not candidates and len(wildcard_candidates) == 1:
        candidates = wildcard_candidates

    for p in candidates:
        try:
            with open(p, 'r', encoding='utf-8') as f:
                info = json.load(f)
            return {
                'styleNumber': info.get('styleNumber') or style_number,
                'name': sanitize_text_block(info.get('name', '')),
                'price': sanitize_text_block(info.get('price', '')),
                'colorRef': sanitize_color_ref(info.get('colorRef', '')),
                'description': sanitize_description_text(info.get('description', '')),
                'composition': info.get('composition'),
                'fabricCode': sanitize_text_block(info.get('fabricCode', '')),
                'width': sanitize_text_block(info.get('width', '')),
                'cuttable': sanitize_text_block(info.get('cuttable', '')),
                'weight': sanitize_text_block(info.get('weight', '')),
            }
        except Exception:
            pass

    txt_path = find_txt_info_file(folder, style_number)
    if txt_path:
        txt = read_text_file(txt_path)
        if txt:
            parsed = parse_txt_info(txt, style_number, folder)
            if parsed:
                return parsed

    return {}


def load_info(folder, style_number, settings=None):
    """加载款式JSON信息"""
    settings = settings or {}
    source_mode = settings.get('sourceMode', 'document-images')
    precomputed_info = settings.get('precomputedInfo') or PRECOMPUTED_INFO or {}
    saved_info = load_saved_info_file(folder, style_number)

    if source_mode in ('label-images', 'fabric-images', 'style-images-only'):
        label_info = precomputed_info.get(style_number)
        if label_info:
            merged = merge_info_records(saved_info, {
                'styleNumber': label_info.get('styleNumber') or style_number,
                'name': label_info.get('name', ''),
                'price': label_info.get('price', ''),
                'colorRef': label_info.get('colorRef', ''),
                'description': label_info.get('description', ''),
                'composition': label_info.get('composition'),
                'fabricCode': label_info.get('fabricCode', ''),
                'width': label_info.get('width', ''),
                'cuttable': label_info.get('cuttable', ''),
                'weight': label_info.get('weight', ''),
                'labelOcrText': label_info.get('labelOcrText', ''),
                'labelImagePath': label_info.get('labelImagePath', ''),
                'fabricImagePath': label_info.get('fabricImagePath', ''),
                'galleryImagePaths': label_info.get('galleryImagePaths', []),
                'frontImagePath': label_info.get('frontImagePath', ''),
                'backImagePath': label_info.get('backImagePath', ''),
                'visionImagePath': label_info.get('visionImagePath', ''),
            })
            return merged

    if saved_info:
        return merge_info_records({
            'styleNumber': style_number,
            'name': '',
            'price': '',
            'colorRef': '',
            'description': '',
            'composition': None,
            'fabricCode': '',
            'width': '',
            'cuttable': '',
            'weight': '',
            'labelOcrText': '',
            'labelImagePath': '',
            'fabricImagePath': '',
            'galleryImagePaths': [],
            'frontImagePath': '',
            'backImagePath': '',
            'visionImagePath': '',
        }, saved_info)

    return {
        'styleNumber': style_number,
        'name': '',
        'price': '',
        'colorRef': '',
        'description': '',
        'composition': None,
        'fabricCode': '',
        'width': '',
        'cuttable': '',
        'weight': '',
        'labelOcrText': '',
        'labelImagePath': '',
        'fabricImagePath': '',
        'galleryImagePaths': [],
        'frontImagePath': '',
        'backImagePath': '',
        'visionImagePath': '',
    }


def scan_style_entries(source, settings=None, precomputed_info=None, load_info=None, organize_metadata_dir=None, **kwargs):
    resolved_precomputed_info = kwargs.get('precomputed_info', precomputed_info)
    resolved_load_info = kwargs.get('load_info', load_info)
    resolved_metadata_dir = kwargs.get('organize_metadata_dir', organize_metadata_dir)
    return scan_style_entries_impl(
        source,
        settings,
        precomputed_info=resolved_precomputed_info if resolved_precomputed_info is not None else (settings or {}).get('precomputedInfo') or PRECOMPUTED_INFO or {},
        load_info=resolved_load_info or globals()['load_info'],
        organize_metadata_dir=resolved_metadata_dir or ORGANIZE_METADATA_DIR,
    )

def read_text_file(path):
    """读取文本文件，兼容多种编码，支持RTF"""
    # 检查是否是RTF文件
    if path.lower().endswith('.rtf'):
        return read_rtf_file(path)

    encodings = ['utf-8-sig', 'utf-16', 'gb18030', 'latin-1']
    for enc in encodings:
        try:
            with open(path, 'r', encoding=enc) as f:
                return f.read()
        except Exception:
            continue
    try:
        with open(path, 'r', errors='ignore') as f:
            return f.read()
    except Exception:
        return None


def read_rtf_file(path):
    """读取RTF文件并提取纯文本"""
    try:
        from striprtf.striprtf import rtf_to_text
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            rtf_content = f.read()
        return rtf_to_text(rtf_content)
    except Exception as e:
        print(f"Error reading RTF file: {e}")
        return None


def find_txt_info_file(folder, style_number):
    """查找可能的TXT/RTF信息文件"""
    candidates = [
        # TXT files
        os.path.join(folder, f"{style_number}_info.txt"),
        os.path.join(folder, "info.txt"),
        os.path.join(folder, f"{style_number}.txt"),
        # RTF files
        os.path.join(folder, f"{style_number}_info.rtf"),
        os.path.join(folder, "info.rtf"),
        os.path.join(folder, f"{style_number}.rtf"),
    ]
    candidates.extend(glob.glob(os.path.join(folder, "*_info.txt")))
    candidates.extend(glob.glob(os.path.join(folder, "*.txt")))
    candidates.extend(glob.glob(os.path.join(folder, "*_info.rtf")))
    candidates.extend(glob.glob(os.path.join(folder, "*.rtf")))

    files = []
    seen = set()
    for p in candidates:
        if not p or p in seen:
            continue
        seen.add(p)
        if os.path.exists(p) and os.path.isfile(p):
            base = os.path.basename(p)
            if base.startswith('.'):
                continue
            files.append(p)

    if not files:
        return None

    files.sort(key=lambda x: os.path.getsize(x), reverse=True)
    return files[0]


def parse_txt_info(text, fallback_style_number, folder=None):
    """从TXT内容中解析款式信息
    
    Args:
        text: TXT文件内容
        fallback_style_number: 备用款号（文件夹名）
        folder: 款式文件夹路径（用于视觉分析查找图片）
    """
    raw_lines = [ln.strip() for ln in text.replace('\r', '').split('\n')]
    lines = [ln for ln in raw_lines if ln]
    if not lines:
        return None

    def looks_like_price(line):
        return looks_like_price_text(line)

    def is_bad_headline(line):
        bad = {
            'FEW ITEMS LEFT',
            'LIMITED STOCK',
            'LAST UNITS',
            'COMING SOON',
            'JOIN LIFE',
            'SPECIAL PRICE',
        }
        return line.strip().upper() in bad

    def looks_like_color_line(line):
        return looks_like_color_text(line)

    def is_comp_header(line):
        headers = [
            'OUTER SHELL',
            'LINING',
            'COMPOSITION',
            'MAIN FABRIC',
            'SECONDARY FABRIC',
            'SHELL',
            'FILLING',
            'PADDING',
        ]
        up = line.upper()
        return any(up.startswith(h) for h in headers)

    def is_received_line(line):
        return re.search(r'received\s*on', line, re.I) is not None

    def extract_style_number(text_line):
        m = re.search(r'(\d{4})\s*[/ ]\s*(\d{3})(?:\s*[/ ]\s*(\d{3}))?', text_line)
        if not m:
            return None
        if m.group(3):
            return f"{m.group(1)}/{m.group(2)}/{m.group(3)}"
        return f"{m.group(1)}/{m.group(2)}"

    def normalize_style_number(sn, is_zara=False):
        """解析款号
        - ZARA: 格式为 前4位/中3位/后3位 (如 1538/451/711)
        - 其他品牌: 直接使用文件夹名作为款号
        """
        if not sn:
            return sn
        if is_zara:
            # 提取所有数字
            digits = re.findall(r'\d', sn)
            if len(digits) >= 10:
                # 前4位 + / + 第5-7位 + / + 第8-10位
                return f"{''.join(digits[:4])}/{''.join(digits[4:7])}/{''.join(digits[7:10])}"
            elif len(digits) >= 7:
                # 前4位 + / + 第5-7位
                return f"{''.join(digits[:4])}/{''.join(digits[4:7])}"
        # 其他品牌：直接使用文件夹名
        return sn

    def extract_color_ref(line):
        if '|' in line:
            left = line.split('|')[0].strip()
            left = re.sub(r'^(color|colour|颜色)\s*[:：]\s*', '', left, flags=re.I)
            return left or line.strip()
        if re.match(r'^(color|colour|颜色)\s*[:：]', line, re.I):
            return re.sub(r'^(color|colour|颜色)\s*[:：]\s*', '', line, flags=re.I).strip()
        return line.strip()

    price_line = ''
    price_idx = None
    for i, line in enumerate(lines):
        if looks_like_price(line):
            price_line = line.strip()
            price_idx = i
            break

    color_line = ''
    color_idx = None
    for i, line in enumerate(lines):
        if looks_like_color_line(line):
            color_line = line.strip()
            color_idx = i
            break

    comp_idx = None
    for i, line in enumerate(lines):
        if is_comp_header(line):
            comp_idx = i
            break
    if comp_idx is None:
        for i, line in enumerate(lines):
            if re.search(r'\d+%\s*[A-Za-z]', line):
                comp_idx = i
                break

    # 名称：取价格行之前的第一个有效行
    name = ''
    cutoff = price_idx if price_idx is not None else (color_idx if color_idx is not None else len(lines))
    for i in range(0, cutoff):
        line = lines[i]
        if is_bad_headline(line):
            continue
        if looks_like_price(line) or looks_like_color_line(line) or is_comp_header(line):
            continue
        name = line
        break

    # 描述：价格行之后到成分前，排除颜色行和其他非描述内容
    desc_lines = []
    desc_start = (price_idx + 1) if price_idx is not None else 0
    desc_end = comp_idx if comp_idx is not None else len(lines)
    for i in range(desc_start, desc_end):
        line = lines[i]
        # 严格过滤：颜色行、价格行、成分头、款号行
        if looks_like_color_line(line) or looks_like_price(line) or is_comp_header(line):
            continue
        # 过滤掉可能是款号的行（纯数字或特定格式）
        if re.match(r'^\d{4,}$', line.replace(".", "").replace("-", "")):
            continue
        # 过滤掉太短或太长的行（描述通常是句子）
        if len(line) < 10 or len(line) > 200:
            continue
        if line == name:
            continue
        desc_lines.append(line)
    description = sanitize_description_text('\n'.join(desc_lines))

    # 成分：从成分头开始，直到 received on
    comp_lines = []
    if comp_idx is not None:
        for i in range(comp_idx, len(lines)):
            line = lines[i]
            if is_received_line(line):
                break
            if looks_like_color_line(line) or looks_like_price(line):
                continue
            comp_lines.append(line)
    composition = '\n'.join(comp_lines).strip() if comp_lines else None

    # 款号：TXT文件直接使用文件夹名作为款号，不从内容中提取
    # （txt中的7位数字通常是颜色号，不是款号）
    # 检测是否是ZARA品牌（根据文件夹名称判断）
    is_zara = 'zara' in fallback_style_number.lower() or len(re.findall(r'\d', fallback_style_number)) == 10
    style_number = normalize_style_number(fallback_style_number, is_zara)

    color_ref = sanitize_color_ref(extract_color_ref(color_line) if color_line else '')

    # 构建基础解析结果
    result = {
        'styleNumber': style_number or fallback_style_number,
        'name': name or '',
        'price': price_line,
        'colorRef': color_ref,
        'description': description,
        'composition': composition,
    }

    # 查找可用于视觉分析的图片
    vision_image_path = None
    if ENABLE_VISION:
        # 优先找模特图（_1, _01, _2, _02 等）
        vision_image_path = find_image(folder, style_number, ['1', '01', '2', '02', 'X01', 'X02'])
        if not vision_image_path:
            # 其次找任意图片
            vision_image_path = find_any_image(folder)
        if vision_image_path:
            print(f"  📷 找到图片用于视觉分析: {os.path.basename(vision_image_path)}")

    # Ollama智能解析（如果开启）
    if OLLAMA_ENABLED:
        print("  尝试使用AI智能解析...")
        ollama_result = parse_with_ollama(text, fallback_style_number, 'Unknown', image_path=vision_image_path)
        
        if ollama_result:
            # 模式1: 补充缺失字段 或 用AI结果覆盖（当启用视觉分析时）
            use_ai_name = ENABLE_VISION and vision_image_path and ollama_result.get('name')
            use_ai_desc = ENABLE_VISION and vision_image_path and ollama_result.get('description')
            
            if ollama_result.get('name') and (not result['name'] or use_ai_name):
                result['name'] = ollama_result['name']
                print(f"  ✓ Ollama补充产品名称: {result['name'][:30]}...")
            
            if ollama_result.get('description') and (not result['description'] or use_ai_desc):
                result['description'] = ollama_result['description']
                print(f"  ✓ Ollama补充产品描述")
            
            if ollama_result.get('composition') and not result['composition']:
                result['composition'] = ollama_result['composition']
                print(f"  ✓ Ollama补充面料成分")
            
            if ollama_result.get('color') and not result['colorRef']:
                result['colorRef'] = ollama_result['color']
                print(f"  ✓ Ollama补充颜色: {result['colorRef']}")
            
            # 模式2: 验证和纠正错误提取
            # 如果基础解析的结果看起来不合理，用AI结果替换
            
            # 验证产品名称（如果基础解析结果太短或包含数字过多）
            if result['name'] and ollama_result.get('name'):
                basic_name = result['name']
                ai_name = ollama_result['name']
                
                # 判断基础解析结果是否可疑
                is_suspicious = (
                    len(basic_name) < 3 or  # 太短
                    sum(c.isdigit() for c in basic_name) > len(basic_name) * 0.5 or  # 数字过多
                    basic_name.upper() == basic_name and len(basic_name) < 10  # 全大写且很短
                )
                
                if is_suspicious and len(ai_name) > len(basic_name):
                    result['name'] = ai_name
                    print(f"  ⚠️  Ollama纠正产品名称: {basic_name} → {ai_name[:30]}...")
            
            # 验证颜色（如果基础解析结果包含非颜色词）
            if result['colorRef'] and ollama_result.get('color'):
                basic_color = result['colorRef'].lower()
                ai_color = ollama_result['color']
                
                # 常见非颜色词
                non_color_words = ['cotton', 'polyester', 'wool', 'linen', 'silk', 
                                   'material', 'fabric', 'shell', 'outer', 'inner']
                
                has_non_color = any(word in basic_color for word in non_color_words)
                
                if has_non_color and ai_color:
                    result['colorRef'] = ai_color
                    print(f"  ⚠️  Ollama纠正颜色: {result['colorRef']} → {ai_color}")
            
            # 验证面料成分（如果基础解析结果太短或不包含百分号）
            if result['composition'] and ollama_result.get('composition'):
                basic_comp = result['composition']
                ai_comp = ollama_result['composition']
                
                # 判断基础解析结果是否不完整
                is_incomplete = (
                    len(basic_comp) < 10 or  # 太短
                    '%' not in basic_comp  # 没有百分比
                )
                
                if is_incomplete and '%' in ai_comp:
                    result['composition'] = ai_comp
                    print(f"  ⚠️  Ollama纠正面料成分")
        else:
            print("  ✗ Ollama解析失败或未返回结果")

    return result


def format_composition(comp):
    """格式化面料信息 - 按分类换行显示"""
    if not comp:
        return ''
    if isinstance(comp, str):
        return parse_composition_string(comp)
    
    parts = []
    if isinstance(comp, dict):
        if comp.get('outerShell'):
            parts.append(f"OUTER SHELL: {comp['outerShell']}")
        if comp.get('lining'):
            parts.append(f"LINING: {comp['lining']}")
        if comp.get('other'):
            # other字段可能是未分类的混合文本，需要智能解析
            parsed = parse_composition_string(comp['other'])
            if parsed:
                parts.append(parsed)
    return '\n'.join(parts)


def ensure_label_mode_description(info, style_number, image_paths):
    """标签模式下按需基于图片生成描述。"""
    if info.get('description'):
        return info

    vision_image_path = image_paths.get('vision')
    if not (LLM_ENABLED and ENABLE_VISION and vision_image_path and os.path.exists(vision_image_path)):
        return info

    context_parts = [
        f"Style number: {info.get('styleNumber') or style_number}",
    ]
    if info.get('fabricCode'):
        context_parts.append(f"Fabric Code: {info['fabricCode']}")
    comp_text = format_composition(info.get('composition'))
    if comp_text:
        context_parts.append(f"Composition: {comp_text}")
    if info.get('labelOcrText'):
        context_parts.append(f"Label OCR:\n{info['labelOcrText']}")

    print("  🤖 Generating description from garment image...")
    llm_result = parse_with_apparel_vision('\n'.join(context_parts), info.get('styleNumber') or style_number, vision_image_path)
    if not llm_result:
        llm_result = parse_with_llm('\n'.join(context_parts), info.get('styleNumber') or style_number, 'Unknown', image_path=vision_image_path)
    if llm_result and llm_result.get('description'):
        info['description'] = llm_result['description']
        if llm_result.get('name') and not info.get('name'):
            info['name'] = llm_result['name']
        print("  ✓ AI description generated")
    else:
        print("  ⚠️ AI description unavailable")

    return info


def ensure_style_only_mode_description(info, style_number, image_paths):
    """仅款式图片模式下按需基于图片生成描述。"""
    if info.get('description'):
        return info

    vision_image_path = image_paths.get('vision')
    if not (LLM_ENABLED and ENABLE_VISION and vision_image_path and os.path.exists(vision_image_path)):
        return info

    context_parts = [
        f"Style number: {info.get('styleNumber') or style_number}",
    ]
    if info.get('fabricCode'):
        context_parts.append(f"Fabric Code: {info['fabricCode']}")
    if info.get('composition'):
        context_parts.append(f"Composition: {format_composition(info.get('composition'))}")

    print("  🤖 Generating description from style images...")
    llm_result = parse_with_apparel_vision('\n'.join(context_parts), info.get('styleNumber') or style_number, vision_image_path)
    if not llm_result:
        llm_result = parse_with_llm('\n'.join(context_parts), info.get('styleNumber') or style_number, 'Unknown', image_path=vision_image_path)
    if llm_result and llm_result.get('description'):
        info['description'] = llm_result['description']
        if llm_result.get('name') and not info.get('name'):
            info['name'] = llm_result['name']
        print("  ✓ AI description generated")
    else:
        print("  ⚠️ AI description unavailable")

    return info


def ensure_document_mode_description(info, style_number, image_paths):
    """文档模式下按需基于图片补齐描述。"""
    if info.get('description'):
        return info

    vision_image_path = image_paths.get('vision')
    if not (LLM_ENABLED and ENABLE_VISION and vision_image_path and os.path.exists(vision_image_path)):
        return info

    context_parts = [
        f"Style number: {info.get('styleNumber') or style_number}",
    ]
    if info.get('name'):
      context_parts.append(f"Name: {info['name']}")
    if info.get('price'):
      context_parts.append(f"Price: {info['price']}")
    if info.get('colorRef'):
      context_parts.append(f"Color: {info['colorRef']}")

    comp_text = format_composition(info.get('composition'))
    if comp_text:
        context_parts.append(f"Composition: {comp_text}")

    print("  🤖 Generating description from product image...")
    llm_result = parse_with_apparel_vision('\n'.join(context_parts), info.get('styleNumber') or style_number, vision_image_path)
    if not llm_result:
        llm_result = parse_with_llm('\n'.join(context_parts), info.get('styleNumber') or style_number, 'Unknown', image_path=vision_image_path)
    if llm_result:
        if llm_result.get('description'):
            info['description'] = llm_result['description']
        if llm_result.get('name') and not info.get('name'):
            info['name'] = llm_result['name']
        if llm_result.get('color') and not info.get('colorRef'):
            info['colorRef'] = llm_result['color']
        if llm_result.get('composition') and not info.get('composition'):
            info['composition'] = llm_result['composition']

        if info.get('description'):
            print("  ✓ AI description generated")
        else:
            print("  ⚠️ AI description unavailable")
    else:
        print("  ⚠️ AI description unavailable")

    return info


def ensure_fabric_mode_description(info, style_number, image_paths):
    """面料模式下按需基于面料图生成描述。"""
    if info.get('description'):
        return info

    vision_image_path = image_paths.get('vision') or image_paths.get('fabric')
    if not (LLM_ENABLED and ENABLE_VISION and vision_image_path and os.path.exists(vision_image_path)):
        return info

    context_parts = [
        f"Style number: {info.get('styleNumber') or style_number}",
    ]
    if info.get('fabricCode'):
        context_parts.append(f"Fabric Code: {info['fabricCode']}")
    comp_text = format_composition(info.get('composition'))
    if comp_text:
        context_parts.append(f"Composition: {comp_text}")
    if info.get('width'):
        context_parts.append(f"Width: {info.get('width')}")
    if info.get('weight'):
        context_parts.append(f"Weight: {info.get('weight')}")

    print("  🤖 Generating description from fabric image...")
    llm_result = parse_with_fabric_vision('\n'.join(context_parts), info.get('styleNumber') or style_number, vision_image_path)
    if llm_result and llm_result.get('description'):
        info['description'] = llm_result['description']
        print("  ✓ AI fabric description generated")
    else:
        print("  ⚠️ AI fabric description unavailable")

    return info


def normalize_width_fraction_display(numerator, denominator):
    left = str(numerator or '').strip()
    right = str(denominator or '').strip()
    if not left or not right:
        return ''
    if right == '1' and re.fullmatch(r'[234568]', left):
        return f"1/{left}"
    return f"{left}/{right}"


def normalize_width_display(value='', raw_text=''):
    text = str(value or '').strip().upper().replace('”', '"').replace('″', '"').replace("''", '"')
    raw = str(raw_text or '').strip().upper().replace('”', '"').replace('″', '"').replace("''", '"')
    prefix = 'CW' if ('CW' in text or 'CW' in raw) else ''

    for candidate in (text, raw):
        if not candidate:
            continue
        body = candidate
        width_match = re.search(r'WIDTH\s*[:：-]?\s*(.+)', body)
        if width_match:
            body = width_match.group(1)
        body = re.sub(r'^CW\s*[:：-]?\s*', '', body).strip()

        match = re.search(r'(\d{2,3})\s*"\s*(\d)\s*/\s*(\d)', body)
        if match:
            fraction = normalize_width_fraction_display(match.group(2), match.group(3))
            return f"{prefix + ' ' if prefix else ''}{match.group(1)}'' {fraction}".strip()

        match = re.search(r'\b(\d{2})(\d)\s*/\s*1\b', body)
        if match:
            return f"{prefix + ' ' if prefix else ''}{match.group(1)}'' 1/{match.group(2)}".strip()

        match = re.search(r'\b(\d{2,3})\s*/\s*(\d{2,3})\s*(?:"|”)?', body)
        if match:
            return f"{prefix + ' ' if prefix else ''}{match.group(1)}/{match.group(2)}''".strip()

        match = re.search(r'\b(\d{2,3})\s*(?:"|”)', body)
        if match:
            return f"{prefix + ' ' if prefix else ''}{match.group(1)}''".strip()

        match = re.search(r'\b(\d{2,3})\b', body)
        if match and (prefix or not re.search(r'[A-Z]', body)):
            return f"{prefix + ' ' if prefix else ''}{match.group(1)}''".strip()

    return str(value or '').strip()


def normalize_weight_display(value='', raw_text=''):
    text = str(value or '').strip().upper().replace('M²', 'M2')
    raw = str(raw_text or '').strip().upper().replace('M²', 'M2')
    has_bw = 'BW' in text or 'BW' in raw
    source = text or raw
    compact = re.sub(r'^BW\s*[:：-]?\s*', '', source).strip()
    compact = re.sub(r'\s*BW$', '', compact).strip()

    match = re.search(r'(\d+(?:\.\d+)?)\s*(G/M2|GSM|OZ/YD2|OZ/YD|OZ)', compact)
    if not match:
        return str(value or '').strip()

    amount = match.group(1)
    unit = match.group(2)
    if 'OZ' in unit and '.' not in amount:
        numeric = float(amount)
        if numeric >= 30:
            amount = f"{amount[:-1]}.{amount[-1]}"
    if unit in ('G/M2', 'GSM') and '.' not in amount:
        numeric = float(amount)
        if numeric >= 1000:
            amount = f"{amount[:-1]}.{amount[-1]}"

    return f"{'BW ' if has_bw else ''}{amount}{unit}".strip()


def format_width_value(info):
    width = normalize_width_display(str(info.get('width') or '').strip(), str(info.get('labelOcrText') or '').strip())
    return width


def format_cuttable_value(info):
    return str(info.get('cuttable') or '').strip()


def format_weight_value(info):
    return normalize_weight_display(str(info.get('weight') or '').strip(), str(info.get('labelOcrText') or '').strip())


def blank_if_empty(value):
    text = str(value or '').strip()
    return text if text else ' '


def add_label_mode_text(slide, info, style_number, settings, brand='BRAND', allow_empty_fields=False):
    """标签图模式的左侧文字布局（流式排布，避免重叠/空隙）。"""
    style_value = info.get('styleNumber') or style_number
    fabric_code = info.get('fabricCode', '')
    description = info.get('description', '')
    composition = format_composition(info.get('composition'))
    width_value = format_width_value(info)
    cuttable_value = format_cuttable_value(info)
    weight_value = format_weight_value(info)

    L = LABEL_MODE_LAYOUT
    flow = FlowColumn(slide, top=0.5, gap=0.14, label_gap=0.03,
                      bottom_limit=SLIDE_HEIGHT_IN - 0.5)

    if settings.get('includeStyleNumber', True) and style_value:
        flow.add('STYLE NUMBER', L['style_label'], tight=True)
        flow.add(style_value, L['style_value'])

    if settings.get('includeFabricCode', True):
        flow.add('FABRIC CODE', L['fabric_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(fabric_code), L['fabric_value'])

    if settings.get('includeDescription', True):
        flow.add('DESCRIPTION', L['desc_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(description), L['description'])

    if settings.get('includeComposition', True):
        flow.add('COMPOSITION', L['comp_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(composition), L['composition'])

    if settings.get('includeWidth', True):
        flow.add('WIDTH', L['width_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(width_value), L['width_value'])

    if settings.get('includeCuttable', True):
        flow.add('CUTTABLE', L['cuttable_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(cuttable_value), L['cuttable_value'])

    if settings.get('includeWeight', True):
        flow.add('WEIGHT', L['weight_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(weight_value), L['weight_value'])

    add_logo_pinned(slide, brand, L['logo'])


def add_style_mode_text(slide, info, style_number, settings, brand='BRAND'):
    """款式图片模式的左侧商品信息布局（流式排布，避免重叠/空隙）。"""
    style_value = info.get('styleNumber') or style_number
    name = str(info.get('name') or '').strip()
    price = str(info.get('price') or '').strip()
    color_ref = sanitize_color_ref(info.get('colorRef', ''))
    description = str(info.get('description') or '').strip()
    composition = format_composition(info.get('composition'))
    fabric_code = str(info.get('fabricCode') or '').strip()
    width_value = format_width_value(info)
    cuttable_value = format_cuttable_value(info)
    weight_value = format_weight_value(info)

    L = STYLE_MODE_LAYOUT
    # 给 logo 预留底部空间。
    flow = FlowColumn(slide, top=0.5, gap=0.14, label_gap=0.03,
                      bottom_limit=SLIDE_HEIGHT_IN - 0.5)

    if settings.get('includeStyleNumber', True) and style_value:
        flow.add('STYLE NUMBER', L['style_label'], tight=True)
        flow.add(style_value, L['style_value'])

    if settings.get('includeName', True) and name:
        flow.add(name, L['name'], gap_before=0.04)

    if settings.get('includePrice', True) and price:
        flow.add(price, L['price'])

    if settings.get('includeColorRef') is True:
        flow.add('COLOR', L['color_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(color_ref), L['color_value'])

    if settings.get('includeDescription', True) and description:
        flow.add('DESCRIPTION', L['desc_label'], gap_before=0.06, tight=True)
        flow.add(description, L['description'])

    if settings.get('includeFabricCode', True):
        flow.add('FABRIC CODE', L['fabric_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(fabric_code), L['fabric_value'])

    if settings.get('includeComposition', True):
        flow.add('COMPOSITION', L['comp_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(composition), L['composition'])

    if settings.get('includeWidth', True):
        flow.add('WIDTH', L['width_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(width_value), L['width_value'])

    if settings.get('includeCuttable', True):
        flow.add('CUTTABLE', L['cuttable_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(cuttable_value), L['cuttable_value'])

    if settings.get('includeWeight', True):
        flow.add('WEIGHT', L['weight_label'], gap_before=0.06, tight=True)
        flow.add(blank_if_empty(weight_value), L['weight_value'])

    add_logo_pinned(slide, brand, L['logo'])


def add_lindi_template_text(slide, info, style_number, settings, brand='BRAND'):
    style_value = info.get('styleNumber') or style_number
    fabric_code = info.get('fabricCode', '')
    composition = format_composition(info.get('composition'))
    width_value = format_width_value(info)
    cuttable_value = format_cuttable_value(info)
    weight_value = format_weight_value(info)
    description = info.get('description', '')

    if settings.get('includeStyleNumber', True) and style_value:
        add_custom_text(slide, style_value, LINDI_LAYOUT['style_value'])

    add_custom_text(slide, brand.upper() if brand else 'BRAND', {**LINDI_LAYOUT['brand_value'], 'bold': True})

    if settings.get('includeFabricCode', True):
        add_custom_text(slide, f"Fabric Code:  {blank_if_empty(fabric_code)}", LINDI_LAYOUT['fabric_value'])

    if settings.get('includeWidth', True):
        add_custom_text(slide, f"Width:  {blank_if_empty(width_value)}", LINDI_LAYOUT['width_value'])

    if settings.get('includeCuttable', True):
        add_custom_text(slide, f"Cuttable:  {blank_if_empty(cuttable_value)}", LINDI_LAYOUT['cuttable_value'])

    if settings.get('includeComposition', True):
        add_custom_text(slide, f"Composition:  {blank_if_empty(composition)}", LINDI_LAYOUT['comp_value'])

    if settings.get('includeWeight', True):
        add_custom_text(slide, f"Weight:  {blank_if_empty(weight_value)}", LINDI_LAYOUT['weight_value'])

    if settings.get('includeDescription', True):
        add_custom_text(slide, 'Remark:', LINDI_LAYOUT['remark_label'])
        add_custom_text(slide, blank_if_empty(description), LINDI_LAYOUT['remark_value'])


def get_fabric_image_path(folder, info):
    fabric_img = info.get('fabricImagePath') or info.get('visionImagePath') or info.get('labelImagePath')
    if fabric_img and os.path.exists(fabric_img):
        return fabric_img
    return find_any_image(folder)


def add_style_gallery_layout(slide, images, image_count):
    visible_images = [img for img in (images or []) if img and os.path.exists(img)][:max(1, int(image_count or 1))]
    if not visible_images:
        return

    if image_count == 1:
        add_image_fit(slide, visible_images[0], MODEL_X, MODEL_Y, MODEL_MAX_W + FLAT_MAX_W + Inches(0.9), MODEL_MAX_H)
        return

    if image_count == 2:
        add_image_fit(slide, visible_images[0], FRONTBACK_LEFT_X, FRONTBACK_TOP_Y, FRONTBACK_MAX_W, FRONTBACK_MAX_H)
        if len(visible_images) > 1:
            add_image_fit(slide, visible_images[1], FRONTBACK_RIGHT_X, FRONTBACK_TOP_Y, FRONTBACK_MAX_W, FRONTBACK_MAX_H)
        return

    if image_count == 3:
        add_image_fit(slide, visible_images[0], MODEL_X, MODEL_Y, MODEL_MAX_W, MODEL_MAX_H)
        if len(visible_images) > 1:
            add_image_fit(slide, visible_images[1], FLAT_X, FLAT_TOP_Y, FLAT_MAX_W, FLAT_MAX_H)
        if len(visible_images) > 2:
            add_image_fit(slide, visible_images[2], FLAT_X, FLAT_BOT_Y, FLAT_MAX_W, FLAT_MAX_H)
        return

    cols = 2 if image_count == 4 else 3
    rows = 2 if image_count in (4, 6) else 1
    cell_w = Inches(3.55) if image_count == 4 else Inches(2.45)
    cell_h = Inches(2.95)
    start_x = Inches(4.6)
    start_y = Inches(0.55)
    gap_x = Inches(0.22)
    gap_y = Inches(0.24)

    for idx, img in enumerate(visible_images):
      col = idx % cols
      row = idx // cols
      if row >= rows:
        break
      add_image_fit(
          slide,
          img,
          start_x + col * (cell_w + gap_x),
          start_y + row * (cell_h + gap_y),
          cell_w,
          cell_h,
      )


def add_fabric_info_line(slide, prefix, value, cfg):
    add_custom_text(slide, f"{prefix}:  {blank_if_empty(value)}", cfg)

def add_fabric_single_slide(prs, style_number, folder, settings, brand='BRAND', info=None):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    info = info or load_info(folder, style_number, settings)
    image_path = get_fabric_image_path(folder, info)
    if settings.get('includeStyleNumber', True):
        add_custom_text(slide, 'Fabric Info', FABRIC_SINGLE_LAYOUT['style'])

    add_custom_text(slide, brand.upper() if brand else 'BRAND', FABRIC_SINGLE_LAYOUT['brand'])

    if settings.get('includeFabricCode', True):
        add_custom_text(slide, f"Fabric Code:  {blank_if_empty(info.get('fabricCode', ''))}", FABRIC_SINGLE_LAYOUT['fabric_code'])
    if settings.get('includeComposition', True):
        add_custom_text(slide, f"Composition:  {blank_if_empty(format_composition(info.get('composition')))}", FABRIC_SINGLE_LAYOUT['composition'])
    if settings.get('includeWidth', True):
        add_custom_text(slide, f"Width:  {blank_if_empty(format_width_value(info))}", FABRIC_SINGLE_LAYOUT['width'])
    if settings.get('includeCuttable', True):
        add_custom_text(slide, f"Cuttable:  {blank_if_empty(format_cuttable_value(info))}", FABRIC_SINGLE_LAYOUT['cuttable'])
    if settings.get('includeWeight', True):
        add_custom_text(slide, f"Weight:  {blank_if_empty(format_weight_value(info))}", FABRIC_SINGLE_LAYOUT['weight'])
    if settings.get('includeDescription', False):
        add_custom_text(slide, 'Description', FABRIC_SINGLE_LAYOUT['description_label'])
        add_custom_text(slide, blank_if_empty(info.get('description')), FABRIC_SINGLE_LAYOUT['description'])

    if image_path:
        add_image_fit(slide, image_path, FABRIC_SINGLE_IMAGE['x'], FABRIC_SINGLE_IMAGE['y'], FABRIC_SINGLE_IMAGE['w'], FABRIC_SINGLE_IMAGE['h'])
        print(f"  ✓ Fabric image: {os.path.basename(image_path)}")
    else:
        print("  ✗ No fabric image")


def add_fabric_double_slide(prs, entries, settings, brand='BRAND'):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_custom_text(slide, brand.upper() if brand else 'BRAND', FABRIC_DOUBLE_BRAND)

    if len(entries) > 1:
        divider = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.8), FABRIC_DOUBLE_DIVIDER_Y, Inches(11.7), Inches(0.02))
        divider.fill.solid()
        divider.fill.fore_color.rgb = LIGHT_GRAY
        divider.line.fill.background()

    for index, entry in enumerate(entries[:2]):
        style_number, folder, info = entry
        row = FABRIC_DOUBLE_ROWS[index]
        style_value = info.get('styleNumber') or style_number
        image_path = get_fabric_image_path(folder, info)

        if settings.get('includeStyleNumber', True):
            add_custom_text(slide, style_value, row['style'])
        if settings.get('includeFabricCode', True):
            add_fabric_info_line(slide, 'Fabric Code', info.get('fabricCode', ''), row['fabric_code'])
        if settings.get('includeComposition', True):
            add_fabric_info_line(slide, 'Composition', format_composition(info.get('composition')), row['composition'])
        if settings.get('includeWidth', True):
            add_fabric_info_line(slide, 'Width', format_width_value(info), row['width'])
        if settings.get('includeCuttable', True):
            add_fabric_info_line(slide, 'Cuttable', format_cuttable_value(info), row['cuttable'])
        if settings.get('includeWeight', True):
            add_fabric_info_line(slide, 'Weight', format_weight_value(info), row['weight'])

        if image_path:
            add_image_fit(slide, image_path, row['image']['x'], row['image']['y'], row['image']['w'], row['image']['h'])
            print(f"  ✓ Fabric image: {os.path.basename(image_path)}")
        else:
            print("  ✗ No fabric image")


def add_fabric_pair_slide(prs, entries, settings, brand='BRAND'):
    """Two fabric images side by side, each with its own text box BELOW the image.

    Text columns start just below the images. When two images have different
    heights after aspect-ratio fitting, both text columns align to the bottom
    of the taller image so they stay horizontally aligned.
    """
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_custom_text(slide, brand.upper() if brand else 'BRAND', FABRIC_PAIR_BRAND)

    # Creation date at the bottom-left (e.g., 2026.7.1)
    today = datetime.date.today()
    add_custom_text(slide, f"{today.year}.{today.month}.{today.day}", FABRIC_PAIR_DATE)

    # ── Pre-compute actual image bottom positions ──
    # add_image_fit centers the image within the target box, so the rendered
    # bottom may differ from the target bottom when aspect ratios differ.
    actual_bottoms_emu = []
    col_copies = []
    for index, entry in enumerate(entries[:2]):
        style_number, folder, info = entry
        col = dict(FABRIC_PAIR_COLS[index])  # shallow copy so we can mutate Y values
        image_path = get_fabric_image_path(folder, info)

        img_meta = get_image_size(image_path) if image_path else (None, None)
        orig_w, orig_h = img_meta
        img_x = col['image']['x']
        img_y = col['image']['y']
        img_w = col['image']['w']
        img_h = col['image']['h']
        actual_top = img_y
        actual_bottom = img_y + img_h
        if orig_w and orig_h and orig_w > 0 and orig_h > 0:
            ratio = orig_w / orig_h
            target_ratio = img_w / img_h
            if ratio > target_ratio:
                final_h = int(img_w / ratio)
                actual_top = img_y + (img_h - final_h) // 2
                actual_bottom = actual_top + final_h
            # else: image is taller → fills full height, bottom == img_y + img_h

        actual_bottoms_emu.append(actual_bottom)
        col_copies.append((col, image_path, style_number, folder, info))

    # Align both text columns to the bottom of the taller (largest bottom Y) image
    target_image_y = col_copies[0][0]['image']['y']
    max_actual_bottom = max(actual_bottoms_emu) if actual_bottoms_emu else (target_image_y + col_copies[0][0]['image']['h'])
    # Text nominal start is 4.40" below the 0.80" image top → 0.15" gap from target bottom.
    # Rebase all text Y values so the first text line starts below the taller image.
    text_start_inches = max_actual_bottom / 914400 + 0.15
    y_delta_inches = text_start_inches - 4.40

    for index, (col, image_path, style_number, folder, info) in enumerate(col_copies):
        style_value = info.get('styleNumber') or style_number

        if image_path:
            add_image_fit(slide, image_path, col['image']['x'], col['image']['y'],
                          col['image']['w'], col['image']['h'])
            print(f"  ✓ Fabric image: {os.path.basename(image_path)}")
        else:
            print("  ✗ No fabric image")

        # Shift text boxes so they start below the taller rendered image.
        text_keys = ['fabric_code', 'composition', 'width', 'cuttable', 'weight', 'description']
        for key in text_keys:
            if key in col:
                col[key]['y'] = col[key]['y'] + y_delta_inches

        if settings.get('includeFabricCode', True):
            add_fabric_info_line(slide, 'Fabric Code', info.get('fabricCode', ''), col['fabric_code'])
        if settings.get('includeComposition', True):
            add_fabric_info_line(slide, 'Composition', format_composition(info.get('composition')), col['composition'])
        if settings.get('includeWidth', True):
            add_fabric_info_line(slide, 'Width', format_width_value(info), col['width'])
        if settings.get('includeCuttable', True):
            add_fabric_info_line(slide, 'Cuttable', format_cuttable_value(info), col['cuttable'])
        if settings.get('includeWeight', True):
            add_fabric_info_line(slide, 'Weight', format_weight_value(info), col['weight'])
        if settings.get('includeDescription', False):
            desc = info.get('description', '')
            if desc:
                add_custom_text(slide, desc, col['description'])


def parse_composition_string(text):
    """
    智能解析混合在一起的面料信息字符串
    例如: "OUTER SHELL76% viscose24% polyamideLININGMAIN FABRIC100% polyester..."
    """
    import re
    if not text:
        return ''
    
    # 分类关键词（按长度从长到短，避免 SHELL 先于 OUTER SHELL 匹配）
    categories = [
        'SECONDARY FABRIC',
        'MAIN FABRIC',
        'OUTER SHELL',
        'LINING',
        'FILLING',
        'PADDING',
    ]
    
    # 第一步：用占位符标记所有分类关键词的位置
    processed = text
    placeholder_map = {}
    for i, cat in enumerate(categories):
        ph = f'§§{i}§§'
        placeholder_map[ph] = cat
        pattern = re.compile(re.escape(cat), re.IGNORECASE)
        processed = pattern.sub(ph, processed)
    
    # 第二步：在占位符前插入换行
    for ph in placeholder_map:
        processed = processed.replace(ph, f'\n{placeholder_map[ph]}')
    
    # 按行处理
    lines = [line.strip() for line in processed.split('\n') if line.strip()]
    
    result_lines = []
    for line in lines:
        # 在百分比数字前加逗号（如 "76% viscose24% polyamide" → "76% viscose, 24% polyamide"）
        line = re.sub(r'([a-zA-Z])(\d+%)', r'\1, \2', line)
        # 去掉开头多余的逗号和空格
        line = re.sub(r'^,\s*', '', line)
        
        # 如果行以分类名开头，在分类名后加冒号
        for cat in categories:
            if line.upper().startswith(cat.upper()):
                rest = line[len(cat):].strip()
                # 去掉rest开头的逗号
                rest = re.sub(r'^,\s*', '', rest)
                if rest:
                    line = f"{cat}: {rest}"
                else:
                    line = f"{cat}:"
                break
        
        result_lines.append(line)
    
    return '\n'.join(result_lines)


# ── 页面生成 ─────────────────────────────────────────

def add_cover(prs, title, count, brand='BRAND'):
    """封面页"""
    global ACTIVE_THEME
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # 主题背景
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    bg.fill.solid()
    bg.fill.fore_color.rgb = ACTIVE_THEME['cover_bg']
    bg.line.fill.background()

    # 品牌名
    b1 = slide.shapes.add_textbox(0, Inches(2.2), PAGE_WIDTH, Inches(1.5))
    f1 = b1.text_frame
    f1.text = brand.upper() if brand else 'BRAND'
    p1 = f1.paragraphs[0]
    p1.font.name = FONT_NAME
    p1.font.size = Pt(72)
    p1.font.bold = True
    p1.font.color.rgb = ACTIVE_THEME['cover_text']
    p1.alignment = PP_ALIGN.CENTER

    # 副标题
    b2 = slide.shapes.add_textbox(0, Inches(3.8), PAGE_WIDTH, Inches(0.6))
    f2 = b2.text_frame
    f2.text = title or f"{brand.upper() if brand else 'BRAND'} STYLE COLLECTION LOOKBOOK"
    p2 = f2.paragraphs[0]
    p2.font.name = FONT_NAME
    p2.font.size = Pt(24)
    p2.font.color.rgb = ACTIVE_THEME['cover_accent']
    p2.alignment = PP_ALIGN.CENTER

    # 数量信息
    b3 = slide.shapes.add_textbox(0, Inches(4.6), PAGE_WIDTH, Inches(0.3))
    f3 = b3.text_frame
    f3.text = f"{count} Styles"
    p3 = f3.paragraphs[0]
    p3.font.name = FONT_NAME
    p3.font.size = Pt(14)
    p3.font.color.rgb = ACTIVE_THEME['cover_accent']
    p3.alignment = PP_ALIGN.CENTER


def add_toc_slide(prs, categories, brand='BRAND'):
    """目录页"""
    global ACTIVE_THEME
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # 背景
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    bg.fill.solid()
    bg.fill.fore_color.rgb = ACTIVE_THEME['page_bg']
    bg.line.fill.background()

    # 标题
    tb = slide.shapes.add_textbox(Inches(1.0), Inches(0.6), Inches(11.3), Inches(0.8))
    tf = tb.text_frame
    tf.text = "CONTENTS"
    p = tf.paragraphs[0]
    p.font.name = FONT_NAME
    p.font.size = Pt(36)
    p.font.bold = True
    p.font.color.rgb = ACTIVE_THEME['brand_color']

    # 分隔线
    ln = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1.0), Inches(1.5), Inches(4.0), Pt(2))
    ln.fill.solid()
    ln.fill.fore_color.rgb = ACTIVE_THEME['cover_bg']
    ln.line.fill.background()

    # 目录条目
    y = 1.9
    for i, (cat_name, cat_count) in enumerate(categories):
        # 编号
        nb = slide.shapes.add_textbox(Inches(1.0), Inches(y), Inches(0.6), Inches(0.4))
        nf = nb.text_frame
        nf.text = f"{i+1:02d}"
        np = nf.paragraphs[0]
        np.font.name = FONT_NAME
        np.font.size = Pt(16)
        np.font.color.rgb = ACTIVE_THEME['label_color']

        # 类别名
        cb = slide.shapes.add_textbox(Inches(1.8), Inches(y), Inches(7.0), Inches(0.4))
        cf = cb.text_frame
        cf.text = cat_name
        cp = cf.paragraphs[0]
        cp.font.name = FONT_NAME
        cp.font.size = Pt(16)
        cp.font.bold = True
        cp.font.color.rgb = ACTIVE_THEME['page_text']

        # 数量
        cnt_b = slide.shapes.add_textbox(Inches(9.5), Inches(y), Inches(2.8), Inches(0.4))
        cnt_f = cnt_b.text_frame
        cnt_f.text = f"{cat_count} styles"
        cnt_p = cnt_f.paragraphs[0]
        cnt_p.font.name = FONT_NAME
        cnt_p.font.size = Pt(12)
        cnt_p.font.color.rgb = ACTIVE_THEME['label_color']
        cnt_p.alignment = PP_ALIGN.RIGHT

        y += 0.55


def add_category_divider(prs, category_name, category_index, total_categories, count, brand='BRAND'):
    """分类分隔页"""
    global ACTIVE_THEME
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # 主题背景
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    bg.fill.solid()
    bg.fill.fore_color.rgb = ACTIVE_THEME['category_bg']
    bg.line.fill.background()

    # 左侧强调条
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0), Inches(0), Inches(0.3), PAGE_HEIGHT)
    bar.fill.solid()
    bar.fill.fore_color.rgb = ACTIVE_THEME['cover_bg']
    bar.line.fill.background()

    # 类别名
    tb = slide.shapes.add_textbox(Inches(1.2), Inches(2.5), Inches(10.5), Inches(1.2))
    tf = tb.text_frame
    tf.text = category_name
    p = tf.paragraphs[0]
    p.font.name = FONT_NAME
    p.font.size = Pt(44)
    p.font.bold = True
    p.font.color.rgb = ACTIVE_THEME['category_text']

    # 数量信息
    b2 = slide.shapes.add_textbox(Inches(1.2), Inches(3.8), Inches(10.5), Inches(0.4))
    f2 = b2.text_frame
    f2.text = f"{count} styles"
    p2 = f2.paragraphs[0]
    p2.font.name = FONT_NAME
    p2.font.size = Pt(16)
    p2.font.color.rgb = ACTIVE_THEME['label_color']

    # 进度指示
    b3 = slide.shapes.add_textbox(Inches(1.2), Inches(6.5), Inches(10.5), Inches(0.3))
    f3 = b3.text_frame
    f3.text = f"Section {category_index} / {total_categories}"
    p3 = f3.paragraphs[0]
    p3.font.name = FONT_NAME
    p3.font.size = Pt(10)
    p3.font.color.rgb = ACTIVE_THEME['label_color']


def add_summary_slide(prs, styles, brand='BRAND'):
    """数据汇总页"""
    global ACTIVE_THEME
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # 背景
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    bg.fill.solid()
    bg.fill.fore_color.rgb = ACTIVE_THEME['summary_bg']
    bg.line.fill.background()

    # 标题
    tb = slide.shapes.add_textbox(Inches(1.0), Inches(0.5), Inches(11.3), Inches(0.7))
    tf = tb.text_frame
    tf.text = "COLLECTION SUMMARY"
    p = tf.paragraphs[0]
    p.font.name = FONT_NAME
    p.font.size = Pt(28)
    p.font.bold = True
    p.font.color.rgb = ACTIVE_THEME['brand_color']

    # 分隔线
    ln = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1.0), Inches(1.3), Inches(4.0), Pt(2))
    ln.fill.solid()
    ln.fill.fore_color.rgb = ACTIVE_THEME['cover_bg']
    ln.line.fill.background()

    # 收集统计数据
    total = len(styles)
    prices = []
    categories = {}
    compositions = {}

    for sn, folder, info in styles:
        # 价格
        price_val = info.get('price', '')
        price_num = extract_price_sort_value(price_val)
        if price_num != float('inf'):
            prices.append(price_val.strip())

        # 品类
        cat = info.get('category', '') or info.get('productGroup', '') or 'Other'
        cat = str(cat).strip() or 'Other'
        categories[cat] = categories.get(cat, 0) + 1

        # 成分
        comp = info.get('composition', '')
        if comp:
            comp_str = str(comp).strip()
            compositions[comp_str] = compositions.get(comp_str, 0) + 1

    # ── 统计卡片 ──
    card_y = 1.7
    card_w = 2.6
    card_h = 1.0
    card_gap = 0.3
    cards = []

    # 款式总数
    cards.append(('Total Styles', str(total), ACTIVE_THEME['brand_color']))
    # 品类数
    cards.append(('Categories', str(len(categories)), ACTIVE_THEME['cover_bg']))
    # 价格区间
    if len(prices) >= 2:
        cards.append(('Price Range', f"{prices[0]} ~ {prices[-1]}", ACTIVE_THEME['label_color']))
    elif len(prices) == 1:
        cards.append(('Price', prices[0], ACTIVE_THEME['label_color']))
    else:
        cards.append(('Price', 'N/A', ACTIVE_THEME['label_color']))
    # 成分种类
    cards.append(('Compositions', str(len(compositions)), ACTIVE_THEME['label_color']))

    for i, (label, value, color) in enumerate(cards):
        x = 1.0 + i * (card_w + card_gap)

        # 卡片背景
        card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
            Inches(x), Inches(card_y), Inches(card_w), Inches(card_h))
        card.fill.solid()
        card.fill.fore_color.rgb = WHITE
        card.line.color.rgb = ACTIVE_THEME['divider']
        card.line.width = Pt(1)

        # 数值
        vb = slide.shapes.add_textbox(Inches(x), Inches(card_y + 0.12), Inches(card_w), Inches(0.5))
        vf = vb.text_frame
        vf.text = value
        vp = vf.paragraphs[0]
        vp.font.name = FONT_NAME
        vp.font.size = Pt(22)
        vp.font.bold = True
        vp.font.color.rgb = color
        vp.alignment = PP_ALIGN.CENTER

        # 标签
        lb = slide.shapes.add_textbox(Inches(x), Inches(card_y + 0.6), Inches(card_w), Inches(0.3))
        lf = lb.text_frame
        lf.text = label
        lp = lf.paragraphs[0]
        lp.font.name = FONT_NAME
        lp.font.size = Pt(10)
        lp.font.color.rgb = ACTIVE_THEME['label_color']
        lp.alignment = PP_ALIGN.CENTER

    # ── 品类分布 ──
    cat_y = 3.2
    cat_title = slide.shapes.add_textbox(Inches(1.0), Inches(cat_y), Inches(5.5), Inches(0.35))
    ct_f = cat_title.text_frame
    ct_f.text = "Category Distribution"
    ct_p = ct_f.paragraphs[0]
    ct_p.font.name = FONT_NAME
    ct_p.font.size = Pt(13)
    ct_p.font.bold = True
    ct_p.font.color.rgb = ACTIVE_THEME['page_text']

    # 按数量排序
    sorted_cats = sorted(categories.items(), key=lambda x: -x[1])
    max_count = sorted_cats[0][1] if sorted_cats else 1

    bar_y = cat_y + 0.5
    bar_h = 0.22
    bar_max_w = 4.5

    for i, (cat_name, cat_count) in enumerate(sorted_cats[:8]):
        y = bar_y + i * 0.32

        # 类别标签
        lb = slide.shapes.add_textbox(Inches(1.0), Inches(y), Inches(2.0), Inches(0.25))
        lf = lb.text_frame
        lf.text = cat_name[:20]
        lp = lf.paragraphs[0]
        lp.font.name = FONT_NAME
        lp.font.size = Pt(9)
        lp.font.color.rgb = ACTIVE_THEME['page_text']

        # 条形背景
        bg_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
            Inches(3.1), Inches(y), Inches(bar_max_w), Inches(bar_h))
        bg_bar.fill.solid()
        bg_bar.fill.fore_color.rgb = ACTIVE_THEME['divider']
        bg_bar.line.fill.background()

        # 条形数据
        fill_w = Inches(bar_max_w * cat_count / max_count)
        fill_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
            Inches(3.1), Inches(y), fill_w, Inches(bar_h))
        fill_bar.fill.solid()
        fill_bar.fill.fore_color.rgb = ACTIVE_THEME['cover_bg']
        fill_bar.line.fill.background()

        # 数值
        nb = slide.shapes.add_textbox(Inches(3.1 + bar_max_w + 0.1), Inches(y), Inches(1.0), Inches(0.25))
        nf = nb.text_frame
        nf.text = str(cat_count)
        np = nf.paragraphs[0]
        np.font.name = FONT_NAME
        np.font.size = Pt(9)
        np.font.color.rgb = ACTIVE_THEME['label_color']

    # ── 成分分布（右侧）──
    comp_title = slide.shapes.add_textbox(Inches(7.5), Inches(cat_y), Inches(5.0), Inches(0.35))
    cpt_f = comp_title.text_frame
    cpt_f.text = "Composition Breakdown"
    cpt_p = cpt_f.paragraphs[0]
    cpt_p.font.name = FONT_NAME
    cpt_p.font.size = Pt(13)
    cpt_p.font.bold = True
    cpt_p.font.color.rgb = ACTIVE_THEME['page_text']

    sorted_comps = sorted(compositions.items(), key=lambda x: -x[1])
    max_comp = sorted_comps[0][1] if sorted_comps else 1

    for i, (comp_name, comp_count) in enumerate(sorted_comps[:8]):
        y = bar_y + i * 0.32

        # 成分标签
        lb = slide.shapes.add_textbox(Inches(7.5), Inches(y), Inches(3.0), Inches(0.25))
        lf = lb.text_frame
        lf.text = comp_name[:30]
        lp = lf.paragraphs[0]
        lp.font.name = FONT_NAME
        lp.font.size = Pt(9)
        lp.font.color.rgb = ACTIVE_THEME['page_text']

        # 条形背景
        comp_bar_w = 2.0
        bg_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
            Inches(10.6), Inches(y), Inches(comp_bar_w), Inches(bar_h))
        bg_bar.fill.solid()
        bg_bar.fill.fore_color.rgb = ACTIVE_THEME['divider']
        bg_bar.line.fill.background()

        fill_w = Inches(comp_bar_w * comp_count / max_comp)
        fill_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
            Inches(10.6), Inches(y), fill_w, Inches(bar_h))
        fill_bar.fill.solid()
        fill_bar.fill.fore_color.rgb = ACTIVE_THEME['cover_accent']
        fill_bar.line.fill.background()

        # 数值
        nb = slide.shapes.add_textbox(Inches(10.6 + comp_bar_w + 0.1), Inches(y), Inches(0.8), Inches(0.25))
        nf = nb.text_frame
        nf.text = str(comp_count)
        np = nf.paragraphs[0]
        np.font.name = FONT_NAME
        np.font.size = Pt(9)
        np.font.color.rgb = ACTIVE_THEME['label_color']

    # 底部品牌名
    add_logo_pinned(slide, brand, {'size': 12, 'bold': True, 'color': 'brand'})


def add_product_slide(prs, style_number, folder, settings, brand='BRAND', info=None):
    """产品页"""
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    source_mode = settings.get('sourceMode', 'document-images')
    slide_template = settings.get('slideTemplate', 'default')
    info = info or load_info(folder, style_number, settings)
    image_paths = resolve_display_images(folder, style_number, info, source_mode, settings)

    gen_desc = settings.get('generateDescription', False)
    print(f"  [debug] generateDescription={gen_desc} source_mode={source_mode} LLM_ENABLED={LLM_ENABLED} ENABLE_VISION={ENABLE_VISION} has_desc={bool(info.get('description'))} vision_img={image_paths.get('vision')!r} exists={os.path.exists(image_paths.get('vision') or '')}")
    if gen_desc:
        if source_mode == 'label-images':
            info = ensure_label_mode_description(info, style_number, image_paths)
        elif source_mode == 'style-images-only':
            info = ensure_style_only_mode_description(info, style_number, image_paths)
        else:
            info = ensure_document_mode_description(info, style_number, image_paths)

    # ── 左侧文字（固定坐标，不会重叠）──
    if source_mode == 'label-images':
        if slide_template == 'lindi-model':
            add_lindi_template_text(slide, info, style_number, settings, brand)
        else:
            add_label_mode_text(slide, info, style_number, settings, brand)
    elif source_mode == 'style-images-only':
        add_style_mode_text(slide, info, style_number, settings, brand)
    else:
        L = LAYOUT
        flow = FlowColumn(slide, top=0.5, gap=0.16, label_gap=0.04,
                          bottom_limit=SLIDE_HEIGHT_IN - 0.5)
        # 款号
        flow.add(info.get('styleNumber', style_number), L['style_number'])

        # 产品名称
        name = info.get('name', '')
        if settings.get('includeName', True) and name:
            flow.add(name, L['name'], gap_before=0.04)

        # 价格
        price = info.get('price', '')
        if price and settings.get('includePrice', True):
            flow.add(price, L['price'])

        # 颜色参考
        color_ref = info.get('colorRef', '')
        if color_ref and settings.get('includeColorRef') is True:
            first_line = color_ref.split('\n')[0].strip()
            flow.add(first_line, L['color_ref'], gap_before=0.04)

        # 商品描述
        desc = info.get('description', '')
        if desc and settings.get('includeDescription', True):
            flow.add('DESCRIPTION', L['desc_label'], gap_before=0.08, tight=True)
            flow.add(desc, L['description'])

        # 面料成分
        comp_text = format_composition(info.get('composition'))
        if comp_text and settings.get('includeComposition', True):
            flow.add('COMPOSITION', L['comp_label'], gap_before=0.08, tight=True)
            flow.add(comp_text, L['composition'])

        # 品牌logo
        add_logo_pinned(slide, brand, L['logo'])

    # ── 右侧图片（保持比例缩放）──

    layout = settings.get('imageLayout', 'model-front-back')
    if source_mode == 'label-images' and slide_template == 'lindi-model':
        layout = 'lindi-front-back'
    style_page_image_count = int(settings.get('stylePageImageCount', 3) or 3)
    if source_mode == 'style-images-only' and not layout.startswith('style-gallery-'):
        layout = f'style-gallery-{style_page_image_count}'
    if layout.startswith('style-gallery-'):
        gallery_images = image_paths.get('ordered') or image_paths.get('grid') or []
        # Fill missing slots: if fewer ordered images than slots and option is on,
        # pad with any grid images not already used rather than leaving blanks.
        fill_missing = settings.get('fillMissingSlots', False)
        if fill_missing and len(gallery_images) < style_page_image_count:
            already_used = set(gallery_images)
            extras = [img for img in (image_paths.get('grid') or []) if img not in already_used and img and os.path.exists(img)]
            gallery_images = gallery_images + extras
        add_style_gallery_layout(slide, gallery_images, style_page_image_count)
    elif layout == 'model-front-back':
        model_img = image_paths.get('model')

        if model_img:
            add_image_fit(slide, model_img,
                          MODEL_X, MODEL_Y, MODEL_MAX_W, MODEL_MAX_H)
            print(f"  ✓ Model: {os.path.basename(model_img)}")
        else:
            print(f"  ✗ No model image")

        # 正面图（右上）
        front_img = image_paths.get('front')
        if front_img:
            add_image_fit(slide, front_img,
                          FLAT_X, FLAT_TOP_Y, FLAT_MAX_W, FLAT_MAX_H)
            print(f"  ✓ Front: {os.path.basename(front_img)}")
        else:
            print(f"  ✗ No front image")

        # 背面图（右下）
        back_img = image_paths.get('back')
        if back_img:
            add_image_fit(slide, back_img,
                          FLAT_X, FLAT_BOT_Y, FLAT_MAX_W, FLAT_MAX_H)
            print(f"  ✓ Back: {os.path.basename(back_img)}")
        else:
            print(f"  ✗ No back image")

    elif layout == 'front-back':
        front_img = image_paths.get('front')
        back_img = image_paths.get('back')

        if front_img:
            add_image_fit(slide, front_img,
                          FRONTBACK_LEFT_X, FRONTBACK_TOP_Y, FRONTBACK_MAX_W, FRONTBACK_MAX_H)
            print(f"  ✓ Front: {os.path.basename(front_img)}")
        else:
            print("  ✗ No front image")

        if back_img:
            add_image_fit(slide, back_img,
                          FRONTBACK_RIGHT_X, FRONTBACK_TOP_Y, FRONTBACK_MAX_W, FRONTBACK_MAX_H)
            print(f"  ✓ Back: {os.path.basename(back_img)}")
        else:
            print("  ✗ No back image")

    elif layout == 'lindi-front-back':
        front_img = image_paths.get('front')
        back_img = image_paths.get('back')

        if front_img:
            add_image_fit(slide, front_img,
                          LINDI_FRONT_X, LINDI_FRONT_Y, LINDI_IMAGE_W, LINDI_IMAGE_H)
            print(f"  ✓ Front: {os.path.basename(front_img)}")
        else:
            print("  ✗ No front image")

        if back_img:
            add_image_fit(slide, back_img,
                          LINDI_BACK_X, LINDI_FRONT_Y, LINDI_IMAGE_W, LINDI_IMAGE_H)
            print(f"  ✓ Back: {os.path.basename(back_img)}")
        else:
            print("  ✗ No back image")

    elif layout == 'grid':
        all_imgs = image_paths.get('grid', [])[:6]

        cols, img_w, img_h = 3, Inches(2.5), Inches(3)
        gap = Inches(0.2)
        start_x, start_y = Inches(4.5), Inches(0.5)

        for i, img in enumerate(all_imgs):
            col = i % cols
            row = i // cols
            x = start_x + col * (img_w + gap)
            y = start_y + row * (img_h + gap)
            add_image_fit(slide, img, x, y, img_w, img_h)


# ── 品类分类 ─────────────────────────────────────────

CATEGORY_KEYWORDS = {
    'Jackets': [
        'jacket', 'jassen', 'jacke', 'chaqueta', 'giacca',
        'down', 'puffer', 'bomber', 'parka', 'anorak', 'windbreaker',
        'softshell', 'hardshell', 'fleece', 'gilet', 'vest',
        'raincoat', 'shell', 'functional jacket',
    ],
    'Tops': [
        't-shirt', 'tshirt', 't shirt', 'tee', 'polo', 'tank',
        'sleeveless', 'henley', 'blouse', 'top',
    ],
    'Sweaters & Knitwear': [
        'sweater', 'pullover', 'jumper', 'cardigan', 'knit',
        'hoodie', 'sweatshirt', 'fleece sweater', 'jumper',
    ],
    'Pants': [
        'pant', 'trouser', 'jogger', 'legging', 'tight',
        'jean', 'chino', 'cargo', 'short', 'bermuda',
        'hose', 'hosen', 'wanderhose', 'funktionshose',
        'tracksuit', 'sweatpant',
    ],
    'Dresses & Skirts': [
        'dress', 'skirt', 'gown', 'frock', 'midi', 'maxi', 'mini',
    ],
    'Underwear & Base': [
        'underwear', 'boxer', 'brief', 'sock', 'bra', 'panty',
        'base layer', 'functional underwear', 'funktionswasche',
        'thermo', 'thermal',
    ],
    'Accessories': [
        'cap', 'hat', 'beanie', 'scarf', 'glove', 'mitten',
        'belt', 'tie', 'bag', 'backpack', 'wallet',
        'sunglass', 'watch', 'jewelry',
    ],
    'Shoes': [
        'shoe', 'sneaker', 'boot', 'sandal', 'slipper', 'loafer',
    ],
}

def classify_by_keyword(style_number, folder, info):
    """从文件夹名、款号和已有信息文本中通过关键词匹配品类。
    返回品类名或 None。"""
    candidates = []
    candidates.append(style_number or '')
    candidates.append(os.path.basename(folder or '') or '')
    name = str(info.get('name', '') or '')
    desc = str(info.get('description', '') or '')
    candidates.append(name)
    candidates.append(desc)
    # 图片文件名也作为候选
    try:
        if folder and os.path.isdir(folder):
            for f in os.listdir(folder)[:20]:
                candidates.append(os.path.splitext(f)[0])
    except Exception:
        pass

    combined = ' '.join(candidates).lower()
    if not combined.strip():
        return None

    best_cat = None
    best_score = 0
    for cat, keywords in CATEGORY_KEYWORDS.items():
        score = 0
        for kw in keywords:
            if kw in combined:
                score += combined.count(kw)
        if score > best_score:
            best_score = score
            best_cat = cat

    return best_cat if best_score > 0 else None


def classify_by_ai(style_number, folder, info, image_paths):
    """用 LLM 视觉模型做轻量品类分类。
    只问一个问题：这是什么服装品类？
    返回品类名或 None。"""
    if not LLM_ENABLED:
        return None

    # 选一张可用的图片
    image_path = ''
    if image_paths:
        image_path = image_paths.get('vision') or image_paths.get('flat') or image_paths.get('model') or ''
        if not image_path:
            for v in image_paths.values():
                if v and os.path.exists(v):
                    image_path = v
                    break

    image_data = load_image_as_base64(image_path) if image_path and os.path.exists(image_path) else None

    prompt = f"""You are a garment classification assistant. Look at this image and determine the garment category.
Return ONLY a single JSON object: {{"category": "<category name>"}}

Categories must be one of: {', '.join(CATEGORY_KEYWORDS.keys())}
If the image is not a garment or unclear, return {{"category": ""}}.

Style number: {style_number}
"""
    try:
        if image_data:
            result = call_llm_api_with_image(
                prompt, image_data, 60,
                {
                    'url': LLM_URL,
                    'model': LLM_MODEL,
                    'api_key': LLM_API_KEY,
                    'provider': LLM_PROVIDER,
                },
            )
        else:
            result = call_llm_api(
                f"Classify this garment into one of these categories: {', '.join(CATEGORY_KEYWORDS.keys())}. "
                f"Style number: {style_number}. "
                f"Description: {str(info.get('description', ''))[:200]}. "
                f"Return ONLY JSON: {{\"category\": \"<name>\"}}",
                60,
            )

        if result.get('success'):
            data = result.get('data', {})
            cat = str(data.get('category', '')).strip() if isinstance(data, dict) else ''
            # 验证返回的品类在已知列表中（模糊匹配）
            if cat:
                cat_lower = cat.lower()
                for known_cat in CATEGORY_KEYWORDS.keys():
                    if known_cat.lower() in cat_lower or cat_lower in known_cat.lower():
                        return known_cat
                # 不在列表中但有效，直接使用
                return cat
    except Exception as e:
        print(f"  [classify_ai] error: {e}")

    return None


def ensure_category(style_number, folder, info, image_paths):
    """分类 fallback 链：已有数据 → 关键词匹配 → AI 视觉 → None"""
    # 1) 已有 category/productGroup 字段
    cat = str(info.get('category', '') or info.get('productGroup', '') or '').strip()
    if cat:
        return cat

    # 2) 关键词匹配
    cat = classify_by_keyword(style_number, folder, info)
    if cat:
        print(f"  [category] keyword match: {cat}")
        return cat

    # 3) AI fallback
    cat = classify_by_ai(style_number, folder, info, image_paths)
    if cat:
        print(f"  [category] AI match: {cat}")
        return cat

    return None


# ── 主入口 ───────────────────────────────────────────

def extract_price_sort_value(value):
    if value is None:
        return float('inf')
    if isinstance(value, (int, float)):
        return float(value)
    match = re.search(r'(\d+(?:[.,]\d+)?)', str(value))
    if not match:
        return float('inf')
    return float(match.group(1).replace(',', '.'))


def _is_ollama_url(url):
    """判断 URL 是否为 Ollama 原生 API 端点（本地 11434 或 Ollama Cloud）。
    与 JS 侧 llm-client.isOllamaLike() 对齐：这些端点即使带 API key
    也使用 /api/generate（Ollama REST），而非 /chat/completions。"""
    try:
        u = url.lower()
        return (
            'ollama.com' in u
            or 'localhost' in u
            or '127.0.0.1' in u
            or '0.0.0.0' in u
            or '::1' in u
            or ':11434' in u
        )
    except Exception:
        return False


def convert_to_pdf(pptx_path):
    """将 PPTX 转换为 PDF。
    优先使用 LibreOffice（soffice），回退到 COM 自动化（Windows 上的 PowerPoint）。
    返回 PDF 路径或 None。"""
    import subprocess
    import shutil

    pdf_path = os.path.splitext(pptx_path)[0] + '.pdf'

    # 1) 尝试 LibreOffice / soffice
    soffice_candidates = []
    if sys.platform == 'win32':
        soffice_candidates = [
            r'C:\Program Files\LibreOffice\program\soffice.exe',
            r'C:\Program Files (x86)\LibreOffice\program\soffice.exe',
        ]
    else:
        soffice_candidates = [
            '/usr/bin/soffice',
            '/usr/bin/libreoffice',
            '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        ]

    soffice = next((p for p in soffice_candidates if os.path.isfile(p)), None)
    if not soffice:
        soffice = shutil.which('soffice') or shutil.which('libreoffice')

    if soffice:
        try:
            print(f"Converting to PDF via LibreOffice: {soffice}")
            result = subprocess.run(
                [soffice, '--headless', '--convert-to', 'pdf',
                 '--outdir', os.path.dirname(pdf_path) or '.',
                 pptx_path],
                capture_output=True, text=True, timeout=120,
            )
            if os.path.isfile(pdf_path):
                print(f"PDF created: {pdf_path}")
                return pdf_path
            print(f"LibreOffice conversion failed: {result.stderr}")
        except Exception as e:
            print(f"LibreOffice conversion error: {e}")

    # 2) 尝试 Windows COM (PowerPoint)
    if sys.platform == 'win32':
        try:
            print("Trying PowerPoint COM automation...")
            import win32com.client
            ppt_app = win32com.client.Dispatch("PowerPoint.Application")
            ppt_app.Visible = 1
            deck = ppt_app.Presentations.Open(pptx_path, WithWindow=False)
            deck.SaveAs(pdf_path, 32)  # 32 = ppFixedFormatTypePDF
            deck.Close()
            ppt_app.Quit()
            if os.path.isfile(pdf_path):
                print(f"PDF created: {pdf_path}")
                return pdf_path
        except Exception as e:
            print(f"PowerPoint COM not available: {e}")

    print("PDF conversion skipped: no LibreOffice or PowerPoint found.")
    return None


def generate_ppt(config):
    global LLM_ENABLED, LLM_MODEL, LLM_URL, LLM_API_KEY, LLM_PROVIDER, ENABLE_VISION, PRECOMPUTED_INFO, APPAREL_VISION_CONFIG
    global OLLAMA_ENABLED, OLLAMA_MODEL, OLLAMA_URL, ACTIVE_THEME
    
    source = os.path.normpath(config['sourceFolder'])
    requested_output = os.path.normpath(config.get('outputPath', os.path.join(source, 'Lookbook.pptx')))
    output = ensure_unique_output_path(requested_output)
    settings = config.get('config', {})
    PRECOMPUTED_INFO = settings.get('precomputedInfo') or {}
    APPAREL_VISION_CONFIG = settings.get('apparelVision') or {}

    # 从一级文件夹名称获取品牌名
    brand = os.path.basename(source)
    print(f"Source: {source}")
    print(f"Brand: {brand}")
    print(f"Output: {output}")
    if output != requested_output:
        print(f"Output exists. Saving as: {output}")

    # 主题选择
    theme_name = settings.get('pptTheme', 'classic')
    ACTIVE_THEME = THEMES.get(theme_name, THEMES['classic'])
    print(f"Theme: {theme_name} ({ACTIVE_THEME['name']})")

    # 从前端配置更新 LLM 设置
    # 支持两种格式:
    # 1. settings.ollamaEnabled + settings.ollamaModel + settings.ollamaUrl (旧格式)
    # 2. settings.ollamaEnabled + settings.llmConfig (新格式，包含完整配置)
    ollama_enabled = settings.get('ollamaEnabled', False)
    llm_config = settings.get('llmConfig', None)
    
    if ollama_enabled:
        LLM_ENABLED = True
        OLLAMA_ENABLED = True  # 向后兼容
        
        # 优先从 llmConfig 读取配置
        if llm_config:
            mode = llm_config.get('mode', 'local')
            
            if mode == 'hybrid':
                # 混合模式：使用分析端点
                analysis = llm_config.get('analysis', {})
                # 使用分析端点的配置（因为这是主要生成内容的时候）
                LLM_URL = analysis.get('baseUrl', 'http://localhost:11434')
                LLM_MODEL = analysis.get('model', 'qwen3-vl:8b')
                LLM_API_KEY = analysis.get('apiKey', '')
                # 判断是否使用 OpenAI 格式（Ollama 端点除外——即使带 key 也是 Ollama REST API）
                LLM_PROVIDER = 'ollama' if _is_ollama_url(LLM_URL) else ('openai' if LLM_API_KEY or 'openai' in LLM_URL.lower() else 'ollama')
            else:
                # 本地、云端或通用 API 云端模式
                if mode == 'cloud':
                    LLM_URL = llm_config.get('baseUrl', llm_config.get('cloud', {}).get('baseUrl', ''))
                    LLM_MODEL = llm_config.get('model', llm_config.get('cloud', {}).get('model', ''))
                    LLM_API_KEY = llm_config.get('apiKey', llm_config.get('cloud', {}).get('apiKey', ''))
                    # Ollama Cloud (ollama.com) 带 key 仍走 /api/generate；其他云端点按 key 判断
                    LLM_PROVIDER = 'ollama' if _is_ollama_url(LLM_URL) else ('openai' if LLM_API_KEY else 'ollama')
                elif mode == 'apiCloud':
                    # 通用 API 云端模式（GLM / DeepSeek / Qwen 等，均为 OpenAI 兼容端点）
                    LLM_URL = llm_config.get('baseUrl', '')
                    LLM_MODEL = llm_config.get('model', '')
                    LLM_API_KEY = llm_config.get('apiKey', '')
                    LLM_PROVIDER = 'ollama' if _is_ollama_url(LLM_URL) else 'openai'
                else:
                    # local 模式
                    LLM_URL = llm_config.get('baseUrl', llm_config.get('local', {}).get('baseUrl', 'http://localhost:11434'))
                    LLM_MODEL = llm_config.get('model', llm_config.get('local', {}).get('model', ''))
                    LLM_API_KEY = None
                    LLM_PROVIDER = 'ollama'
            
            # 同步到旧变量（向后兼容）
            OLLAMA_URL = LLM_URL
            OLLAMA_MODEL = LLM_MODEL
        else:
            # 旧格式兼容
            LLM_MODEL = settings.get('ollamaModel', 'qwen3-vl:8b')
            LLM_URL = settings.get('ollamaUrl', 'http://localhost:11434')
            LLM_API_KEY = None
            LLM_PROVIDER = 'ollama'
            OLLAMA_MODEL = LLM_MODEL
            OLLAMA_URL = LLM_URL
        
        # 读取视觉分析开关
        ENABLE_VISION = settings.get('enableVision', False)
        
        provider_display = "OpenAI" if LLM_PROVIDER == 'openai' else "Ollama"
        vision_status = " + 视觉分析" if ENABLE_VISION else ""
        print(f"LLM enabled: {provider_display} - {LLM_MODEL} @ {LLM_URL}{vision_status}")
    else:
        LLM_ENABLED = False
        OLLAMA_ENABLED = False
        ENABLE_VISION = False
        print("LLM disabled")

    # 扫描款式来源（支持一款一个文件夹，也支持顶层已命名图片）
    styles = scan_style_entries(
        source,
        settings,
        precomputed_info=PRECOMPUTED_INFO,
        load_info=load_info,
        organize_metadata_dir=ORGANIZE_METADATA_DIR,
    )

    sort_key = settings.get('sortBy', 'styleNumber')
    if sort_key == 'name':
        styles.sort(key=lambda entry: (str(entry[2].get('name') or '').lower(), str(entry[0]).lower()))
    elif sort_key == 'price':
        styles.sort(key=lambda entry: (extract_price_sort_value(entry[2].get('price')), str(entry[0]).lower()))
    else:
        styles.sort(key=lambda entry: (str(entry[2].get('styleNumber') or entry[0]).lower(), str(entry[0]).lower()))

    source_mode = settings.get('sourceMode', 'document-images')
    print(f"Found {len(styles)} {'fabrics' if source_mode == 'fabric-images' else 'styles'}")
    print(f"  [settings] includeStyleNumber={settings.get('includeStyleNumber')} includeName={settings.get('includeName')} includePrice={settings.get('includePrice')} includeDescription={settings.get('includeDescription')} includeFabricCode={settings.get('includeFabricCode')} includeComposition={settings.get('includeComposition')} includeWidth={settings.get('includeWidth')} includeCuttable={settings.get('includeCuttable')} includeWeight={settings.get('includeWeight')}")

    if not styles:
        return {'success': False, 'error': '文件夹中没有找到任何款式'}

    # 创建PPT
    prs = Presentation()
    prs.slide_width = PAGE_WIDTH
    prs.slide_height = PAGE_HEIGHT

    # 封面
    add_cover(prs, settings.get('title'), len(styles), brand)

    # 目录页 + 分类分隔页（仅款式模式且用户启用时）
    enable_toc = settings.get('enableToc', False)
    enable_summary = settings.get('enableSummary', False)

    # 按品类分组（使用 fallback 链：已有数据 → 关键词 → AI → None）
    category_groups = {}
    category_order = []
    unclassified = []
    for sn, folder, info in styles:
        # 解析图片路径用于 AI 分类
        image_paths = {}
        try:
            image_paths = resolve_display_images(folder, sn, info, source_mode, settings)
        except Exception:
            pass

        cat = ensure_category(sn, folder, info, image_paths)
        if cat:
            if cat not in category_groups:
                category_groups[cat] = []
                category_order.append(cat)
            category_groups[cat].append((sn, folder, info))
        else:
            unclassified.append((sn, folder, info))

    # 未分类的款式如果启用了目录但无法分类，归入 Uncategorized
    if unclassified:
        if enable_toc and category_order:
            cat = 'Uncategorized'
            category_groups[cat] = unclassified
            category_order.append(cat)
        else:
            # 没有任何分类成功，把全部款式作为无分类处理
            category_groups = {}
            category_order = []
            # styles 保持原样，不分组

    # 判断是否真正可以分类
    has_categories = enable_toc and len(category_order) > 1

    if has_categories:
        toc_data = [(cat, len(category_groups[cat])) for cat in category_order]
        add_toc_slide(prs, toc_data, brand)
        print(f"Added TOC slide with {len(toc_data)} categories")

    # 产品页 / 面料页
    if has_categories and source_mode != 'fabric-images':
        total_cats = len(category_order)
        for cat_idx, cat_name in enumerate(category_order):
            cat_styles = category_groups[cat_name]
            add_category_divider(prs, cat_name, cat_idx + 1, total_cats, len(cat_styles), brand)
            print(f"\n--- Category: {cat_name} ({len(cat_styles)} styles) ---")
            for i, (sn, folder, info) in enumerate(cat_styles):
                print(f"  [{i+1}/{len(cat_styles)}] {sn}")
                add_product_slide(prs, sn, folder, settings, brand, info=info)
    elif source_mode == 'fabric-images':
        fabric_layout = settings.get('imageLayout', 'fabric-single')
        if fabric_layout == 'fabric-pair':
            slide_count = 0
            for i in range(0, len(styles), 2):
                pair = styles[i:i + 2]
                slide_count += 1
                print(f"\n[{slide_count}/{(len(styles) + 1) // 2}] {', '.join(str(entry[0]) for entry in pair)}")
                for j, (sn, folder, info) in enumerate(pair):
                    if settings.get('generateDescription', False):
                        fabric_image_paths = {
                            'vision': info.get('visionImagePath') or info.get('fabricImagePath') or info.get('labelImagePath') or '',
                            'fabric': info.get('fabricImagePath') or info.get('labelImagePath') or '',
                        }
                        pair[j] = (sn, folder, ensure_fabric_mode_description(info, sn, fabric_image_paths))
                add_fabric_pair_slide(prs, pair, settings, brand)
        else:
            for i, (sn, folder, info) in enumerate(styles):
                print(f"\n[{i+1}/{len(styles)}] {sn}")
                if settings.get('generateDescription', False):
                    fabric_image_paths = {
                        'vision': info.get('visionImagePath') or info.get('fabricImagePath') or info.get('labelImagePath') or '',
                        'fabric': info.get('fabricImagePath') or info.get('labelImagePath') or '',
                    }
                    info = ensure_fabric_mode_description(info, sn, fabric_image_paths)
                add_fabric_single_slide(prs, sn, folder, settings, brand, info=info)
    else:
        for i, (sn, folder, info) in enumerate(styles):
            print(f"\n[{i+1}/{len(styles)}] {sn}")
            add_product_slide(prs, sn, folder, settings, brand, info=info)

    # 汇总页（需要有可统计的数据才生成）
    if enable_summary:
        has_price = any(extract_price_sort_value(info.get('price', '')) != float('inf') for _, _, info in styles)
        has_category = any(str(info.get('category', '') or info.get('productGroup', '') or '').strip() for _, _, info in styles)
        has_comp = any(str(info.get('composition', '') or '').strip() for _, _, info in styles)
        if has_price or has_category or has_comp:
            add_summary_slide(prs, styles, brand)
            print("Added summary slide")
        else:
            print("Skipped summary slide: no price/category/composition data found")

    # 保存
    print(f"\nSaving: {output}")
    prs.save(output)
    print("Done!")

    # PDF 导出
    pdf_path = None
    if settings.get('exportPdf', False):
        pdf_path = convert_to_pdf(output)

    slide_count = len(styles)
    if source_mode == 'fabric-images' and settings.get('imageLayout') == 'fabric-pair':
        slide_count = (len(styles) + 1) // 2

    result = {
        'success': True,
        'outputPath': output,
        'styleCount': slide_count
    }
    if pdf_path:
        result['pdfPath'] = pdf_path
    return result


if __name__ == '__main__':
    try:
        raw_config = sys.stdin.buffer.read().decode('utf-8')
        config = json.loads(raw_config)
        result = generate_ppt(config)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'success': False, 'error': str(e)}), file=sys.stderr)
        sys.exit(1)
