# -*- coding: utf-8 -*-
"""Debug: show get_text('text') lines and the color_changes the script would build."""
import sys
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PYTHON_VENDOR = os.path.join(SCRIPT_DIR, 'python_vendor')
sys.path.insert(0, PYTHON_VENDOR)
os.environ.setdefault('PYMUPDF_WARNINGS', '0')


def _clear_optional_fitz_modules():
    for module_name in list(sys.modules):
        if (module_name == 'fitz' or module_name.startswith('fitz.')
                or module_name == 'pymupdf' or module_name.startswith('pymupdf.')):
            sys.modules.pop(module_name, None)


def _import_optional_fitz():
    try:
        import fitz as fitz_module
        return fitz_module, 'vendor', None
    except Exception as vendor_error:
        _clear_optional_fitz_modules()
        original_sys_path = list(sys.path)
        try:
            vendor_root = os.path.normpath(PYTHON_VENDOR)
            sys.path = [e for e in original_sys_path if os.path.normpath(e) != vendor_root]
        except Exception:
            pass
        try:
            import fitz as fitz_module
            return fitz_module, 'system', vendor_error
        except Exception as system_error:
            _clear_optional_fitz_modules()
            return None, '', system_error
        finally:
            sys.path = original_sys_path


fitz, FITZ_SOURCE, FITZ_IMPORT_ERROR = _import_optional_fitz()
if fitz is None:
    raise FITZ_IMPORT_ERROR

pdf_path = sys.argv[1]
page_no = int(sys.argv[2])  # 0-based
doc = fitz.open(pdf_path)
page = doc[page_no]
text_lines = page.get_text('text').split('\n')
words = page.get_text('words') or []

print(f'=== page {page_no + 1} text lines containing COLOR / DESTINATION / ASSORTMENT ===')
for line in text_lines:
    s = line.strip()
    if not s:
        continue
    up = s.upper()
    if 'COLOR' in up or 'DESTINATION' in up or 'ASSORTMENT' in up:
        print(f'  {s!r}')

print('=== color_changes the current code would build ===')
current_color = None
current_color_code = None
color_changes = []
for line in text_lines:
    stripped = line.strip()
    upper = stripped.upper()
    if 'COLOR NO:' in upper:
        idx = upper.find('COLOR NO:') + len('COLOR NO:')
        rest = stripped[idx:].strip()
        if rest:
            code = rest.split()[0]
            current_color_code = code
    elif upper.startswith('COLOR:'):
        rest = stripped[len('COLOR:'):].strip().replace('\xa0', ' ')
        if rest:
            current_color = rest
            color_y = None
            for w in words:
                if str(w[4]).strip().upper() == 'COLOR:':
                    color_y = w[1]
                    break
            color_changes.append((color_y if color_y else 0, rest, current_color_code))
print(f'  color_changes = {color_changes}')
print(f'  final current_color = {current_color!r}, current_color_code = {current_color_code!r}')
doc.close()
