import json
import sys
import os
import tempfile
import traceback
import warnings
from collections import defaultdict
from pathlib import Path

# ── Suppress warnings from reaching stdout ──────────────────────────
# PyMuPDF (fitz) and other C libraries may print warnings to stdout,
# which corrupts the JSON protocol between Python and Node.js.
warnings.filterwarnings('ignore')
os.environ.setdefault('PYMUPDF_WARNINGS', '0')

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_VENDOR = SCRIPT_DIR / 'python_vendor'
if PYTHON_VENDOR.exists():
    sys.path.insert(0, str(PYTHON_VENDOR))


def _suppress_fitz_warnings():
    """After fitz is imported, suppress its warning output to stdout."""
    try:
        import fitz
        if hasattr(fitz, 'TOOLS'):
            # PyMuPDF >= 1.18: silence MuPDF warnings
            fitz.TOOLS.mupdf_warnings(silent=True)
    except Exception:
        pass


def _clear_optional_fitz_modules():
    for module_name in list(sys.modules):
        if (
            module_name == 'fitz'
            or module_name.startswith('fitz.')
            or module_name == 'pymupdf'
            or module_name.startswith('pymupdf.')
        ):
            sys.modules.pop(module_name, None)


def _import_optional_fitz():
    try:
        import fitz as fitz_module  # type: ignore
        return fitz_module, 'vendor', None
    except Exception as vendor_error:
        _clear_optional_fitz_modules()
        original_sys_path = list(sys.path)
        try:
            vendor_root = str(PYTHON_VENDOR.resolve())
            sys.path = [
                entry for entry in original_sys_path
                if str(Path(entry).resolve()) != vendor_root
            ]
        except Exception:
            sys.path = [entry for entry in original_sys_path if entry != str(PYTHON_VENDOR)]

        try:
            import fitz as fitz_module  # type: ignore
            return fitz_module, 'system', vendor_error
        except Exception as system_error:
            _clear_optional_fitz_modules()
            return None, '', system_error
        finally:
            sys.path = original_sys_path


fitz, FITZ_SOURCE, FITZ_IMPORT_ERROR = _import_optional_fitz()
if fitz is None:
    raise FITZ_IMPORT_ERROR  # type: ignore[misc]

# Suppress MuPDF warnings that may corrupt stdout JSON protocol
_suppress_fitz_warnings()

IMAGE_EXTENSION_MAP = {
    'jpg': '.jpg',
    'jpeg': '.jpg',
    'jpe': '.jpg',
    'png': '.png',
    'webp': '.webp',
    'bmp': '.bmp',
    'gif': '.gif',
    'tif': '.tif',
    'tiff': '.tif',
}


def ensure_dir(dir_path):
    Path(dir_path).mkdir(parents=True, exist_ok=True)


def sanitize_segment(value, fallback='item'):
    cleaned = ''.join(
        char if char.isalnum() or char in ('-', '_', '.') else '_'
        for char in str(value or fallback)
    )
    cleaned = '_'.join(part for part in cleaned.split('_') if part).strip('._')
    return (cleaned or fallback)[:96]


def normalize_text(text=''):
    return '\n'.join(
        line.rstrip()
        for line in str(text or '').replace('\r\n', '\n').split('\n')
    ).strip()


def rect_to_dict(rect):
    if isinstance(rect, (tuple, list)) and len(rect) >= 4:
        x0, y0, x1, y1 = rect[:4]
        return {
            'x0': float(x0),
            'y0': float(y0),
            'x1': float(x1),
            'y1': float(y1),
            'width': float(x1 - x0),
            'height': float(y1 - y0),
        }
    return {
        'x0': float(rect.x0),
        'y0': float(rect.y0),
        'x1': float(rect.x1),
        'y1': float(rect.y1),
        'width': float(rect.width),
        'height': float(rect.height),
    }


def extract_text_blocks(page):
    blocks = []
    raw_blocks = page.get_text('blocks') or []
    for block_index, block in enumerate(raw_blocks):
        if len(block) < 5:
            continue
        x0, y0, x1, y1, text = block[:5]
        normalized = normalize_text(text)
        if not normalized:
            continue
        blocks.append({
            'index': block_index,
            'text': normalized,
            'lines': [line.strip() for line in normalized.split('\n') if line.strip()],
            'bbox': {
                'x0': float(x0),
                'y0': float(y0),
                'x1': float(x1),
                'y1': float(y1),
                'width': float(x1 - x0),
                'height': float(y1 - y0),
            },
        })
    return blocks


def build_image_rect_lookup(page):
    lookup = {}
    for image_info in page.get_image_info(xrefs=True) or []:
        xref = int(image_info.get('xref') or 0)
        bbox = image_info.get('bbox')
        if xref <= 0 or bbox is None:
            continue
        lookup.setdefault(xref, []).append(rect_to_dict(bbox))
    return lookup


def persist_extracted_image(document, xref, page_number, image_index, image_dir):
    extracted = document.extract_image(xref)
    image_bytes = extracted.get('image') if isinstance(extracted, dict) else None
    ext = str(extracted.get('ext') or '').lower() if isinstance(extracted, dict) else ''
    suffix = IMAGE_EXTENSION_MAP.get(ext)

    image_dir = Path(image_dir)
    ensure_dir(image_dir)

    if image_bytes and suffix:
        file_path = image_dir / f'page-{page_number:03d}-image-{image_index:03d}{suffix}'
        if not file_path.exists():
            file_path.write_bytes(image_bytes)
        return file_path

    pixmap = fitz.Pixmap(document, xref)
    try:
        if pixmap.alpha or pixmap.colorspace is None or pixmap.n not in (1, 3):
            pixmap = fitz.Pixmap(fitz.csRGB, pixmap)

        file_path = image_dir / f'page-{page_number:03d}-image-{image_index:03d}.png'
        if not file_path.exists():
            pixmap.save(str(file_path))
        return file_path
    finally:
        pixmap = None


def render_page_image(page, page_number, render_dir, scale=2.0):
    render_dir = Path(render_dir)
    ensure_dir(render_dir)
    file_path = render_dir / f'page-{page_number:03d}.png'
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    try:
      pixmap.save(str(file_path))
    finally:
      pixmap = None
    return file_path


def extract_pdf_visuals(file_path, options=None):
    options = options or {}
    source = Path(file_path)
    output_root = Path(options.get('outputRoot') or (Path(tempfile.gettempdir()) / 'gsbot-product-analysis' / 'fitz'))
    include_images = bool(options.get('includeImages', False))
    render_page_numbers = {
        int(value)
        for value in (options.get('renderPageNumbers') or [])
        if str(value).strip().isdigit() and int(value) > 0
    }
    image_page_numbers = {
        int(value)
        for value in (options.get('pageNumbers') or [])
        if str(value).strip().isdigit() and int(value) > 0
    }
    render_scale = float(options.get('renderScale') or 2.0)
    max_images = max(0, int(options.get('maxImages') or 120))
    max_images_per_page = max(0, int(options.get('maxImagesPerPage') or 4))

    image_dir = output_root / 'images'
    render_dir = output_root / 'pages'
    ensure_dir(output_root)

    document = fitz.open(str(source))
    try:
        pages = []
        rendered_pages = []
        images = []
        seen_xrefs = set()
        image_counter = 0

        for page_index in range(document.page_count):
            page_number = page_index + 1
            page = document[page_index]
            text = normalize_text(page.get_text('text'))
            lines = [line.strip() for line in text.split('\n') if line.strip()]
            page_images = page.get_images(full=True)
            text_blocks = extract_text_blocks(page)
            image_rect_lookup = build_image_rect_lookup(page)
            pages.append({
                'number': page_number,
                'text': text,
                'lines': lines,
                'imageCount': len(page_images),
                'textBlocks': text_blocks,
            })

            if page_number in render_page_numbers:
                rendered_path = render_page_image(page, page_number, render_dir, render_scale)
                rendered_pages.append({
                    'number': page_number,
                    'path': str(rendered_path),
                    'name': rendered_path.name,
                })

            if include_images and image_counter < max_images and (not image_page_numbers or page_number in image_page_numbers):
                page_image_counter = 0
                for image_index, image_info in enumerate(page_images, start=1):
                    if max_images_per_page > 0 and page_image_counter >= max_images_per_page:
                        break
                    xref = int(image_info[0] or 0)
                    if xref <= 0 or xref in seen_xrefs:
                        continue
                    seen_xrefs.add(xref)
                    try:
                        persisted = persist_extracted_image(document, xref, page_number, image_index, image_dir)
                        images.append({
                            'xref': xref,
                            'pageNumber': page_number,
                            'path': str(persisted),
                            'name': persisted.name,
                            'bboxes': image_rect_lookup.get(xref, []),
                        })
                        image_counter += 1
                        page_image_counter += 1
                    except Exception:
                        continue
                    if image_counter >= max_images:
                        break

        return {
            'success': True,
            'sourcePath': str(source),
            'pageCount': document.page_count,
            'pages': pages,
            'images': images,
            'renderedPages': rendered_pages,
            'outputRoot': str(output_root),
        }
    finally:
        document.close()


def extract_po_tables(file_path):
    """Extract PO size tables from PDF using coordinate-based analysis.
    Returns deduplicated tables with exact size column assignments."""
    document = fitz.open(str(file_path))
    try:
        all_tables = []
        size_labels_expected = {'30', '31', '32', '33', '34', '36', '38', 'XS', 'S', 'M', 'L', 'XL', 'XXL'}
        seen_table_signatures = set()

        for page_index in range(document.page_count):
            page = document[page_index]
            words = page.get_text('words') or []
            if not words:
                continue

            # Find all groups of size labels
            size_words = [w for w in words if str(w[4]).strip() in size_labels_expected]
            if len(size_words) < 3:
                continue

            # Group size words by y-coordinate bands (20px tolerance)
            y_groups = defaultdict(list)
            for w in size_words:
                y_key = round(w[1], -1)  # 10px bands
                y_groups[y_key].append(w)

            for header_y, header_group in y_groups.items():
                if len(header_group) < 3:
                    continue

                header_sorted = sorted(header_group, key=lambda w: w[0])
                size_labels_with_x = [(str(w[4]).strip(), (w[0] + w[2]) / 2.0) for w in header_sorted]

                # Deduplicate repeated labels by x-center distance (NOT by label
                # alone): two occurrences of the same label >15pt apart are
                # separate columns (e.g. repeated size blocks in a wide table),
                # while x-overlapping duplicates are merged to avoid misassigning
                # data to the wrong column.
                label_last_x = {}
                deduped = []
                for label, cx in size_labels_with_x:
                    last_x = label_last_x.get(label)
                    if last_x is None or abs(cx - last_x) > 15.0:
                        label_last_x[label] = cx
                        deduped.append((label, cx))
                    else:
                        sys.stderr.write(
                            '[debug] merged duplicate size label "%s" at x=%.1f '
                            '(x-overlap with previous x=%.1f)\n' % (label, cx, last_x)
                        )
                if len(deduped) < 3:
                    continue
                size_labels_with_x = deduped

                # Build column x-ranges
                col_x_ranges = []
                for i, (label, center_x) in enumerate(size_labels_with_x):
                    if i == 0:
                        if i + 1 < len(size_labels_with_x):
                            left_x = center_x - (size_labels_with_x[i + 1][1] - center_x) / 2.0
                        else:
                            left_x = center_x - 20.0
                    else:
                        left_x = (size_labels_with_x[i - 1][1] + center_x) / 2.0
                    if i == len(size_labels_with_x) - 1:
                        if i > 0:
                            right_x = center_x + (center_x - size_labels_with_x[i - 1][1]) / 2.0
                        else:
                            right_x = center_x + 20.0
                    else:
                        right_x = (center_x + size_labels_with_x[i + 1][1]) / 2.0
                    col_x_ranges.append((label, left_x, right_x))

                # Signature for dedup: (page, header_y, sorted_labels)
                labels_tuple = tuple(s[0] for s in size_labels_with_x)
                sig = (page_index, int(header_y), labels_tuple)
                if sig in seen_table_signatures:
                    continue
                seen_table_signatures.add(sig)

                # Extract context
                context = _extract_page_context(page, header_y)

                # Find data rows
                row_groups = defaultdict(list)
                header_bottom = max(w[3] for w in header_group)
                for w in words:
                    if w[1] >= header_bottom:
                        y_key = round(w[1], -1)
                        row_groups[y_key].append(w)

                data_rows = []
                for y_key in sorted(row_groups.keys()):
                    row_words = sorted(row_groups[y_key], key=lambda w: w[0])
                    if not row_words:
                        continue

                    first_text = str(row_words[0][4]).strip()
                    if not first_text.isdigit():
                        continue

                    inseam_val = first_text
                    sizes_dict = {}
                    total_val = None

                    for w in row_words[1:]:
                        text = str(w[4]).strip()
                        if not text.isdigit():
                            continue
                        center_x = (w[0] + w[2]) / 2.0
                        num_val = int(text)

                        matched = False
                        for label, left_x, right_x in col_x_ranges:
                            if left_x <= center_x <= right_x:
                                sizes_dict[label] = num_val
                                matched = True
                                break
                        if not matched and total_val is None:
                            total_val = num_val

                    if sizes_dict:
                        data_rows.append({
                            'inseam': inseam_val,
                            'sizes': sizes_dict,
                            'total': total_val,
                        })

                if data_rows:
                    all_tables.append({
                        'page': page_index + 1,
                        'sizeLabels': [s[0] for s in size_labels_with_x],
                        'dataRows': data_rows,
                        **context,
                    })

        return {'success': True, 'tables': all_tables}
    finally:
        document.close()


def _extract_page_context(page, header_y):
    """Extract color, destination etc. from above the table header."""
    context = {'color': None, 'colorCode': None, 'destinationCode': None, 'assortmentCode': None}
    blocks = page.get_text('blocks') or []
    for block in blocks:
        if len(block) < 5:
            continue
        x0, y0, x1, y1, block_text = block[:5]
        if y1 > header_y:
            continue
        lines = [l.strip() for l in str(block_text).split('\n') if l.strip()]
        for line in lines:
            upper = line.upper()
            if 'COLOR NO:' in upper:
                rest = line[upper.find('COLOR NO:') + len('COLOR NO:'):].strip()
                if rest.split():
                    context['colorCode'] = rest.split()[0]
            elif line.upper().startswith('COLOR:'):
                rest = line[len('COLOR:'):].strip()
                if rest.split():
                    context['color'] = rest.split()[0]
            elif 'DESTINATION CODE:' in upper:
                rest = line[upper.find('DESTINATION CODE:') + len('DESTINATION CODE:'):].strip()
                if rest.split():
                    context['destinationCode'] = rest.split()[0]
            elif 'ASSORTMENT CODE:' in upper:
                rest = line[upper.find('ASSORTMENT CODE:') + len('ASSORTMENT CODE:'):].strip()
                if rest.split():
                    context['assortmentCode'] = rest.split()[0]
    return context


def extract_po_destination_tables(file_path):
    """Extract PO destination detail tables with full context (color, destination, assortment, inseam, sizes).
    This targets the 'DESTINATION DETAILS' section which has the correct per-destination breakdown."""
    document = fitz.open(str(file_path))
    try:
        all_sku_rows = []
        size_labels_expected = {'30', '31', '32', '33', '34', '36', '38', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXS', 'XXXL'}

        current_color = None
        current_color_code = None

        for page_index in range(document.page_count):
            page = document[page_index]
            words = page.get_text('words') or []
            if not words:
                continue

            # --- Page-level filtering: skip PACKAGING DETAILS, COLOR DETAILS summary, and SUMMARY TOTAL pages ---
            page_text_norm = page.get_text('text').replace('\xa0', ' ').upper()
            # Skip if this is a PACKAGING DETAILS page (has package type, not real order qty)
            is_packaging_page = ('PACKAGING DETAILS' in page_text_norm or
                                 'PACKAGE TYPE' in page_text_norm or
                                 'TOTAL LOTS ORDERED' in page_text_norm)
            # Skip if this is a COLOR DETAILS summary page (grand totals, no destination breakdown)
            is_color_summary_page = ('COLOR DETAILS' in page_text_norm and
                                     'DESTINATION CODE' not in page_text_norm and
                                     'DESTINATION DESCRIPTION' not in page_text_norm)
            # Skip SUMMARY TOTAL pages — but only if the ENTIRE page is summary data.
            # Some pages have real destination data above + SUMMARY TOTAL at the bottom,
            # so we need a y-position cutoff to only skip the summary section.
            is_summary_total_page = 'SUMMARY TOTAL' in page_text_norm
            summary_total_y = None
            if is_summary_total_page:
                # Find the y-position of "SUMMARY TOTAL" text
                for w in words:
                    if str(w[4]).strip().upper() == 'SUMMARY':
                        summary_total_y = w[1]
                        break
            # If the page has SUMMARY TOTAL but also has DESTINATION CODE text above it,
            # don't skip the page — just use summary_total_y as a cutoff
            has_dest_above_summary = (is_summary_total_page and summary_total_y is not None and
                                     any(str(w[4]).strip().upper() == 'DESTINATION' and w[1] < summary_total_y
                                         for w in words))
            if is_packaging_page or is_color_summary_page:
                continue
            if is_summary_total_page and not has_dest_above_summary:
                continue

            page_context = {
                'color': current_color,
                'colorCode': current_color_code,
            }

            # Track color changes with y-coordinates so each header block gets
            # the correct color even when a new color starts mid-page.
            # Format: list of (y_position, color_name, color_code)
            #
            # IMPORTANT: build the list from get_text('dict') LINES so each
            # "COLOR:" / "COLOR NO:" label carries its OWN y. The previous
            # implementation scanned plain text_lines and looked up the page's
            # FIRST "COLOR:" word for every color line, which assigned the SAME
            # y to every color label on a multi-color page (e.g. a BEIGE block
            # followed by a BLACK block). With equal y values the last color
            # always won the `cc_y <= header_y + 20` match, so every header
            # block on the page was labeled with the final color — BEIGE data
            # was reported as BLACK and the real BLACK rows were later dropped
            # as "duplicates" of the (color, dest, inseam) key.
            #
            # Also normalize \xa0 (non-breaking space) to a plain space before
            # matching: these PDFs render "COLOR\xa0NO: BEI", which never
            # matched the literal 'COLOR NO:' substring and left colorCode=None.
            color_changes = []
            color_marks = []  # (y, kind, value) — kind: 'code' | 'name'
            try:
                dict_blocks = page.get_text('dict')['blocks']
            except Exception:
                dict_blocks = []
            for block in dict_blocks:
                for line in block.get('lines', []):
                    line_text = ''.join(span.get('text', '') for span in line.get('spans', [])).strip()
                    if not line_text:
                        continue
                    upper = line_text.upper().replace('\xa0', ' ')
                    if 'COLOR NO:' in upper:
                        idx = upper.find('COLOR NO:') + len('COLOR NO:')
                        rest = line_text[idx:].strip().replace('\xa0', ' ')
                        if rest:
                            color_marks.append((line['bbox'][1], 'code', rest.split()[0]))
                    elif upper.startswith('COLOR:'):
                        rest = line_text[len('COLOR:'):].strip().replace('\xa0', ' ')
                        if rest:
                            color_marks.append((line['bbox'][1], 'name', rest))
            color_marks.sort(key=lambda m: m[0])
            for mark_y, kind, value in color_marks:
                if kind == 'code':
                    current_color_code = value
                else:
                    current_color = value
                    color_changes.append((mark_y, current_color, current_color_code))
            # Also add the initial color (from previous page) at y=0
            if not color_changes or color_changes[0][0] > 0:
                color_changes.insert(0, (0, page_context['color'], page_context['colorCode']))

            size_words = [w for w in words if str(w[4]).strip() in size_labels_expected]
            if len(size_words) < 3:
                continue

            y_groups = defaultdict(list)
            for w in size_words:
                y_key = round(w[1], -1)
                y_groups[y_key].append(w)

            valid_headers = []
            for header_y, header_group in y_groups.items():
                # Skip header blocks at or below the SUMMARY TOTAL section
                if summary_total_y is not None and header_y >= summary_total_y - 10:
                    continue
                if len(header_group) < 3:
                    continue
                header_sorted = sorted(header_group, key=lambda w: w[0])

                # ── Size-header candidate filtering (conservative, generic) ──
                # All candidates were already filtered to exact size labels
                # (size_words), so the old heuristics (hardcoded x>400 cutoff,
                # big-gap truncation) were too aggressive and silently dropped
                # real columns (e.g. 30/31/33 in wide tables). Keep them only
                # as guards against clearly spurious words.

                # 1) Gap truncation — cut the tail across a >100pt gap ONLY when
                #    the right segment is NOT a plausible header continuation.
                #    A real continuation has >=3 labels with compact internal
                #    spacing (e.g. a second size block in a two-assortment
                #    header). Spurious fragments (a stray left label + a couple
                #    of size words from data rows, separated by a huge gap) are
                #    cut and then dropped by the len<3 check below.
                if len(header_sorted) >= 2:
                    gaps = []
                    for i in range(1, len(header_sorted)):
                        gap = header_sorted[i][0] - header_sorted[i-1][2]
                        gaps.append((i, gap))
                    gaps.sort(key=lambda x: -x[1])
                    if gaps and gaps[0][1] > 100.0:
                        cutoff_idx = gaps[0][0]
                        left_segment = header_sorted[:cutoff_idx]
                        right_segment = header_sorted[cutoff_idx:]
                        right_gaps = [
                            right_segment[i + 1][0] - right_segment[i][2]
                            for i in range(len(right_segment) - 1)
                        ]
                        right_is_header = (
                            len(right_segment) >= 3
                            and (not right_gaps or max(right_gaps) < gaps[0][1] / 2.0)
                        )
                        if not right_is_header:
                            dropped = [(str(w[4]).strip(), round(w[0], 1)) for w in right_segment]
                            sys.stderr.write(
                                '[debug] gap-truncated tail %s across gap=%.1f '
                                '(not a header continuation)\n' % (dropped, gaps[0][1])
                            )
                            header_sorted = left_segment
                        else:
                            sys.stderr.write(
                                '[debug] kept right segment across gap=%.1f '
                                '(plausible header continuation)\n' % gaps[0][1]
                            )

                # 2) Relative right-boundary rule (replaces hardcoded x > 400):
                #    drop a candidate only when it lies beyond the table's data
                #    area, i.e. to the right of the max quantity word x below
                #    the header (+ tolerance). No hardcoded page coordinate.
                header_bottom = max(w[3] for w in header_group)
                numeric_words = [w for w in words
                                 if w[1] >= header_bottom and str(w[4]).strip().isdigit()]
                data_right = max((w[2] for w in numeric_words), default=None)
                if data_right is not None:
                    tol = 15.0
                    kept = [w for w in header_sorted if w[0] <= data_right + tol]
                    dropped = [(str(w[4]).strip(), round(w[0], 1))
                               for w in header_sorted if w[0] > data_right + tol]
                    if dropped:
                        sys.stderr.write(
                            '[debug] dropped header candidates beyond data right '
                            'edge x=%.1f: %s\n' % (data_right, dropped)
                        )
                    header_sorted = kept

                if len(header_sorted) < 3:
                    continue

                size_labels_with_x = [(str(w[4]).strip(), (w[0] + w[2]) / 2.0) for w in header_sorted]

                # 3) Deduplicate repeated labels by x-center distance: >15pt apart
                #    = separate columns; x-overlapping duplicates are merged.
                label_last_x = {}
                deduped = []
                for label, cx in size_labels_with_x:
                    last_x = label_last_x.get(label)
                    if last_x is None or abs(cx - last_x) > 15.0:
                        label_last_x[label] = cx
                        deduped.append((label, cx))
                    else:
                        sys.stderr.write(
                            '[debug] merged duplicate size label "%s" at x=%.1f '
                            '(x-overlap with previous x=%.1f)\n' % (label, cx, last_x)
                        )
                if len(deduped) < 3:
                    continue
                valid_headers.append((header_y, header_sorted, deduped))

            valid_headers.sort(key=lambda x: x[0])

            for hi, (header_y, header_group, size_labels_with_x) in enumerate(valid_headers):
                next_header_y = valid_headers[hi + 1][0] if hi + 1 < len(valid_headers) else 999999

                # Determine the correct color for this header block based on y-position.
                # Find the last color change at or above header_y.
                local_color = page_context['color']
                local_color_code = page_context['colorCode']
                for cc_y, cc_name, cc_code in color_changes:
                    if cc_y is not None and cc_y <= header_y + 20:  # small tolerance
                        local_color = cc_name
                        local_color_code = cc_code

                local_context = {
                    'color': local_color,
                    'colorCode': local_color_code,
                }
                dest_candidates = []
                assort_candidates = []
                words_by_y = defaultdict(list)
                for w in words:
                    if w[1] < header_y:
                        words_by_y[round(w[1], -1)].append(w)
                for w in words:
                    wtext = str(w[4]).strip()
                    wupper = wtext.upper()
                    wy = w[1]
                    if wy >= header_y:
                        continue
                    if wupper == 'DESTINATION':
                            y_band = round(wy, -1)
                            nearby = sorted(words_by_y.get(y_band, []), key=lambda x: x[0])
                            idx = None
                            for i, nw in enumerate(nearby):
                                if str(nw[4]).strip().upper() == 'CODE':
                                    idx = i
                                    break
                            if idx is not None and idx + 2 < len(nearby):
                                val_w = nearby[idx + 2]
                                val_text = str(val_w[4]).strip()
                                if val_text and val_text != ':':
                                    dest_candidates.append((wy, val_text))
                                elif idx + 3 < len(nearby):
                                    val_w = nearby[idx + 3]
                                    val_text = str(val_w[4]).strip()
                                    if val_text:
                                        dest_candidates.append((wy, val_text))
                    elif wupper == 'ASSORTMENT':
                        y_band = round(wy, -1)
                        nearby = sorted(words_by_y.get(y_band, []), key=lambda x: x[0])
                        idx = None
                        for i, nw in enumerate(nearby):
                            if str(nw[4]).strip().upper() == 'CODE':
                                idx = i
                                break
                        if idx is not None and idx + 2 < len(nearby):
                            val_w = nearby[idx + 2]
                            val_text = str(val_w[4]).strip()
                            if val_text and val_text != ':':
                                assort_candidates.append((wy, val_text))
                            elif idx + 3 < len(nearby):
                                val_w = nearby[idx + 3]
                                val_text = str(val_w[4]).strip()
                                if val_text:
                                    assort_candidates.append((wy, val_text))
                if dest_candidates:
                    dest_candidates.sort(key=lambda x: x[0], reverse=True)
                    local_context['destinationCode'] = dest_candidates[0][1]
                if assort_candidates:
                    assort_candidates.sort(key=lambda x: x[0], reverse=True)
                    local_context['assortmentCode'] = assort_candidates[0][1]

                col_x_ranges = []
                for i, (label, center_x) in enumerate(size_labels_with_x):
                    if i == 0:
                        if i + 1 < len(size_labels_with_x):
                            left_x = center_x - (size_labels_with_x[i + 1][1] - center_x) / 2.0
                        else:
                            left_x = center_x - 20.0
                    else:
                        left_x = (size_labels_with_x[i - 1][1] + center_x) / 2.0
                    if i == len(size_labels_with_x) - 1:
                        if i > 0:
                            right_x = center_x + (center_x - size_labels_with_x[i - 1][1]) / 2.0
                        else:
                            right_x = center_x + 20.0
                    else:
                        right_x = (center_x + size_labels_with_x[i + 1][1]) / 2.0
                    col_x_ranges.append((label, left_x, right_x))

                row_groups = defaultdict(list)
                header_bottom = max(w[3] for w in header_group)
                row_y_upper_limit = next_header_y - 20.0
                for w in words:
                    wy = w[1]
                    if wy >= header_bottom and wy < row_y_upper_limit:
                        y_key = round(wy, -1)
                        row_groups[y_key].append(w)

                # Build column ranges based on header label x-positions.
                # DO NOT use data-driven ranges — they incorrectly assign values to
                # the LEFTMOST N size labels. For example, inseam 30 row has 4 values
                # that actually belong to waist columns 31/32/33/34, not 30/31/32/33.
                # The header column mid-points are positioned accurately in the PDF — trust them.
                processed_rows = []
                prepack_ratio = None

                for y_key in sorted(row_groups.keys()):
                    row_words = sorted(row_groups[y_key], key=lambda w: w[0])
                    if not row_words:
                        continue

                    # Detect PREPACK RATIO from "TOTAL:XX" summary rows.
                    # These rows appear at the bottom of each destination block.
                    # Format: "TOTAL:21" (single word) → prepack_ratio = "21"
                    #         "TOTAL:" (no number) → no prepack ratio (NA assortment)
                    #         "TOTAL" (standalone) → skip (grand total or column total row)
                    # Only set prepack_ratio for non-NA assortment codes.
                    first_text = str(row_words[0][4]).strip()
                    first_upper = first_text.upper()
                    if first_upper.startswith('TOTAL:') and local_context.get('assortmentCode') != 'NA':
                        ratio_part = first_text.split(':', 1)[1].strip()
                        if ratio_part.isdigit():
                            prepack_ratio = ratio_part
                        # Skip this summary row from data processing
                        continue
                    if first_upper.startswith('TOTAL'):
                        continue

                    # Identify row mode:
                    # Mode A (inseam): first word is a small digit (inseam, 2-3 digits), followed by size digits
                    # Mode B (color row): first words are COLOR NO/COLOR NAME (alphanumeric), followed by size digits
                    # Find the first digit word - all subsequent digits are sizes + total
                    first_digit_idx = None
                    for wi, w in enumerate(row_words):
                        t = str(w[4]).strip()
                        if t.isdigit():
                            first_digit_idx = wi
                            break

                    if first_digit_idx is None:
                        continue

                    # Collect size and total values (all digit words from first_digit_idx onwards)
                    digit_words = row_words[first_digit_idx:]

                    # Determine if Mode A (inseam row): first digit is INSEAM value
                    inseam_val = None
                    # Mode A heuristic: if we have at least 2 digit values before any color-related words
                    # AND first digit is 28-40 range (typical inseam), treat first as inseam
                    # For now: check if the row has COLOR NO / COLOR NAME before digits
                    has_color_info_before = False
                    for wi in range(first_digit_idx):
                        wt = str(row_words[wi][4]).strip().upper()
                        if wt and not wt.isdigit() and wt != ':':
                            has_color_info_before = True
                            break

                    if not has_color_info_before and len(digit_words) >= 3:
                        # Mode A: first digit = inseam
                        inseam_val = str(digit_words[0][4]).strip()
                        sizes_digit_words = digit_words[1:]
                    else:
                        # Mode B: no inseam, color info before digits
                        # Extract color/code from words before first_digit_idx
                        color_words = []
                        code_words = []
                        for wi in range(first_digit_idx):
                            wt = str(row_words[wi][4]).strip()
                            if not wt or wt == ':':
                                continue
                            if wt.upper() in ('COLOR', 'NO'):
                                continue
                            # Heuristic: first token = color code (DN45492), rest = color name
                            if not code_words:
                                code_words.append(wt)
                            else:
                                color_words.append(wt)
                        if code_words:
                            local_context['colorCode'] = ' '.join(code_words)
                        if color_words:
                            local_context['color'] = ' '.join(color_words)
                        sizes_digit_words = digit_words

                    sizes_dict = {}
                    total_val = None

                    # Always use label-based column ranges derived from the header row.
                    # The header x-coordinates in the PDF are authoritative — data values
                    # correctly fall into the proper waist-size columns even when some
                    # columns are blank (e.g. inseam 30 rows have blanks for 30/36/38).
                    active_ranges = col_x_ranges
                    # The rightmost size column (38) sits at x ~ 265-301. TOTAL values
                    # are at x > ~400 (well separated). Anything not matching a size col
                    # but still within the "size area" (< rightmost_size_right + buffer)
                    # is a misaligned size value (use nearest-neighbor), not a total.
                    rightmost_size_right = max((r[2] for r in active_ranges), default=0.0)
                    size_area_x_limit = rightmost_size_right + 80.0  # generous gap between sizes and TOTAL

                    for w in sizes_digit_words:
                        text = str(w[4]).strip()
                        if not text.isdigit():
                            continue
                        center_x = (w[0] + w[2]) / 2.0
                        try:
                            num_val = int(text)
                        except ValueError:
                            continue

                        matched = False
                        # 1) Strict range match first
                        for label, left_x, right_x in active_ranges:
                            if left_x <= center_x <= right_x:
                                sizes_dict[label] = num_val
                                matched = True
                                break
                        # 2) If no strict match but value is still in the size area,
                        #    use nearest-neighbor match (handles floating-point boundary errors
                        #    and slightly misaligned text in NA assortment tables)
                        if not matched and center_x <= size_area_x_limit:
                            nearest_label = None
                            nearest_dist = float('inf')
                            for label, left_x, right_x in active_ranges:
                                col_center = (left_x + right_x) / 2.0
                                dist = abs(center_x - col_center)
                                if dist < nearest_dist:
                                    nearest_dist = dist
                                    nearest_label = label
                            if nearest_label is not None and nearest_dist < 40.0:  # within ~half a col width
                                sizes_dict[nearest_label] = num_val
                                matched = True
                        # 3) Otherwise treat as TOTAL (must be past the size area)
                        if not matched and center_x > size_area_x_limit and total_val is None:
                            total_val = num_val

                    # If we still don't have a total but have size values, compute it as
                    # a last resort. Never trust a "total" that looks like a misclassified
                    # size (size area, we already assigned above).
                    if total_val is None and sizes_dict:
                        computed = sum(sizes_dict.values())
                        # Only use computed if it's > 0; otherwise leave None for filtering
                        if computed > 0:
                            total_val = computed

                    if sizes_dict:
                        row_entry = {
                            'page': page_index + 1,
                            'color': local_context.get('color'),
                            'colorCode': local_context.get('colorCode'),
                            'destinationCode': local_context.get('destinationCode'),
                            'assortmentCode': local_context.get('assortmentCode'),
                            'sizes': sizes_dict,
                            'total': total_val,
                        }
                        if inseam_val:
                            row_entry['inseam'] = inseam_val
                        if prepack_ratio is not None:
                            row_entry['prepackRatio'] = prepack_ratio
                        processed_rows.append(row_entry)

                # Apply prepack_ratio to all rows in this header block
                # (the TOTAL:XX row appears after data rows, so prepack_ratio
                # was captured during the loop but rows were already appended)
                if prepack_ratio is not None:
                    for row in processed_rows:
                        if not row.get('prepackRatio'):
                            row['prepackRatio'] = prepack_ratio

                all_sku_rows.extend(processed_rows)

        # --- Final filtering: remove summary and packaging rows ---
        filtered_rows = []
        PACKAGING_KEYWORDS = {'ASSORTED', 'SIZE', 'NON', 'LOTS', 'PACKAGE', 'PACKING', 'PCS'}
        for row in all_sku_rows:
            color = (row.get('color') or '').upper().replace('\xa0', ' ')
            code = (row.get('colorCode') or '').upper().replace('\xa0', ' ')
            combined = f'{color} {code}'

            # Skip TOTAL summary rows
            if color == 'TOTAL' or color.startswith('TOTAL '):
                continue
            if code == 'TOTAL' or (code.startswith('TOTAL') and len(code) <= 10):
                continue

            # Skip rows without a destinationCode - they are grand totals not per-destination data
            if not row.get('destinationCode'):
                continue

            # Skip packaging rows (contain keywords like ASSORTED / SIZE / NON / LOTS etc.)
            has_pkg_keyword = any(kw in combined for kw in PACKAGING_KEYWORDS)
            if has_pkg_keyword:
                continue

            # Skip rows that have sizes in XXS/XXXL (edge case: packaging table) AND
            # simultaneously don't have a valid numeric-looking color code (DN12345 pattern)
            sizes_keys = set((row.get('sizes') or {}).keys())
            has_pkg_sizes = bool(sizes_keys & {'XXS', 'XXXL', 'XXL'})
            code_looks_valid = any(c.isdigit() for c in code) and len(code) >= 5
            if has_pkg_sizes and not code_looks_valid:
                continue

            filtered_rows.append(row)

        # --- Deduplicate: remove summary/total rows that duplicate (color, dest, inseam) ---
        # Summary sections at the end of the PO may repeat rows with grand totals.
        # Keep only the first occurrence (which has the correct per-destination data).
        seen_keys = set()
        deduped_rows = []
        for row in filtered_rows:
            key = (row.get('color'), row.get('destinationCode'), row.get('inseam'))
            if key in seen_keys:
                continue
            seen_keys.add(key)
            deduped_rows.append(row)
        filtered_rows = deduped_rows

        # --- Post-process: fill missing prepackRatio from same-group rows ---
        # When "TOTAL:XX" row is on the next page, prepackRatio may be missing
        # for some rows. Fill from same (color, destinationCode, assortmentCode) group.
        group_ratio = {}
        for row in filtered_rows:
            assort = (row.get('assortmentCode') or '').upper()
            if assort == 'NA':
                continue
            if row.get('prepackRatio'):
                key = (row.get('color'), row.get('destinationCode'), assort)
                group_ratio[key] = row['prepackRatio']

        for row in filtered_rows:
            assort = (row.get('assortmentCode') or '').upper()
            if assort == 'NA':
                continue
            if not row.get('prepackRatio'):
                key = (row.get('color'), row.get('destinationCode'), assort)
                if key in group_ratio:
                    row['prepackRatio'] = group_ratio[key]
                else:
                    # Derive from size values: if all sizes have the same quantity,
                    # that quantity is the prepack ratio
                    sizes = row.get('sizes') or {}
                    vals = list(sizes.values())
                    if vals and len(set(vals)) == 1 and vals[0] > 0:
                        row['prepackRatio'] = str(vals[0])

        return {'success': True, 'skuRows': filtered_rows}
    finally:
        document.close()


if __name__ == '__main__':
    try:
        payload = json.loads(sys.stdin.buffer.read().decode('utf-8') or '{}')
        action = payload.get('action') or 'extract'
        if action == 'extractPoTables':
            result = extract_po_tables(payload.get('filePath') or '')
        elif action == 'extractPoDestinationTables':
            result = extract_po_destination_tables(payload.get('filePath') or '')
        else:
            result = extract_pdf_visuals(payload.get('filePath') or '', payload.get('options') or {})
        # Write JSON to stdout with explicit flush; suppress any trailing warnings
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
        sys.stdout.buffer.write(b'\n')
        sys.stdout.buffer.flush()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.write(json.dumps({'success': False, 'error': str(error)}) + '\n')
        sys.exit(1)
