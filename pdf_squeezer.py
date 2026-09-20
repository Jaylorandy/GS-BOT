import json
import shutil
import sys
import time
import traceback
from io import BytesIO
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_VENDOR = SCRIPT_DIR / 'python_vendor'
if PYTHON_VENDOR.exists():
    sys.path.insert(0, str(PYTHON_VENDOR))

from PIL import Image  # type: ignore
from pypdf import PdfReader, PdfWriter  # type: ignore
from pypdf.generic._image_xobject import _xobj_to_image  # type: ignore


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

Image.MAX_IMAGE_PIXELS = None

PRESETS = {
    'light': {
        'label': 'High quality',
        'quality': 82,
        'max_long_edge': 2200,
        'grayscale': False,
        'min_source_bytes': 260_000,
        'min_pixels': 600_000,
        'jpeg_skip_bytes_per_pixel': 0.09,
        'min_savings_ratio': 0.05,
        'min_savings_bytes': 24_000,
        'fitz_quality': 78,
        'fitz_dpi_target': 180,
        'fitz_dpi_threshold': 210,
    },
    'balanced': {
        'label': 'Balanced',
        'quality': 58,
        'max_long_edge': 1600,
        'grayscale': False,
        'min_source_bytes': 220_000,
        'min_pixels': 500_000,
        'jpeg_skip_bytes_per_pixel': 0.085,
        'min_savings_ratio': 0.06,
        'min_savings_bytes': 32_000,
        'fitz_quality': 58,
        'fitz_dpi_target': 144,
        'fitz_dpi_threshold': 170,
    },
    'strong': {
        'label': 'Small file',
        'quality': 42,
        'max_long_edge': 1200,
        'grayscale': False,
        'min_source_bytes': 120_000,
        'min_pixels': 280_000,
        'jpeg_skip_bytes_per_pixel': 0.06,
        'min_savings_ratio': 0.03,
        'min_savings_bytes': 12_000,
        'fitz_quality': 40,
        'fitz_dpi_target': 108,
        'fitz_dpi_threshold': 126,
        'target_max_bytes': 10 * 1024 * 1024,
        'raster_retry_steps': [
            {'dpi': 110, 'quality': 44, 'grayscale': False},
            {'dpi': 96, 'quality': 36, 'grayscale': False},
            {'dpi': 84, 'quality': 31, 'grayscale': False},
            {'dpi': 72, 'quality': 27, 'grayscale': True},
            {'dpi': 64, 'quality': 24, 'grayscale': True},
        ],
    },
}

MIN_EFFECTIVE_PDF_SAVINGS_BYTES = 48_000
MIN_EFFECTIVE_PDF_SAVINGS_RATIO = 0.005


def emit_progress(value):
    print(f'__PROGRESS__:{int(max(0, min(100, value)))}', flush=True)


def emit_log(message):
    print(str(message), flush=True)


def emit_file_result(payload):
    print(f'__FILE_RESULT__:{json.dumps(payload, ensure_ascii=False)}', flush=True)


def ensure_unique_output_path(target_path):
    candidate = Path(target_path)
    if not candidate.exists():
      return str(candidate)

    stem = candidate.stem
    suffix = candidate.suffix
    counter = 1
    while True:
      next_candidate = candidate.with_name(f'{stem}({counter}){suffix}')
      if not next_candidate.exists():
        return str(next_candidate)
      counter += 1


def choose_preset(config):
    preset_name = str(config.get('preset') or 'balanced').strip().lower()
    return PRESETS.get(preset_name, PRESETS['balanced'])


def get_image_data_size(image_file):
    try:
        return len(image_file.data or b'')
    except Exception:
        return 0


def get_image_filter_name(image_file):
    if not image_file.indirect_reference:
        return ''

    try:
        filter_value = image_file.indirect_reference.get('/Filter')
    except Exception:
        return ''

    if isinstance(filter_value, list):
        filter_value = filter_value[0] if filter_value else ''

    return str(filter_value or '')


def has_transparency(image):
    return image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info)


def normalize_image(image, preset):
    working = image.copy()

    if preset.get('grayscale'):
        if has_transparency(working):
            working = working.convert('LA')
        else:
            working = working.convert('L')
    elif working.mode == 'CMYK':
        working = working.convert('RGB')
    elif working.mode == 'P':
        working = working.convert('RGBA' if has_transparency(working) else 'RGB')
    elif working.mode not in ('1', 'L', 'RGB', 'RGBA', 'LA'):
        working = working.convert('RGBA' if has_transparency(working) else 'RGB')

    max_long_edge = int(preset.get('max_long_edge') or 0)
    if max_long_edge > 0:
        longest = max(working.width, working.height)
        if longest > max_long_edge:
            scale = max_long_edge / float(longest)
            next_size = (
                max(1, int(round(working.width * scale))),
                max(1, int(round(working.height * scale))),
            )
            working = working.resize(next_size, Image.Resampling.LANCZOS)

    return working


def build_replace_kwargs(new_image, preset):
    if has_transparency(new_image):
        return {
            'compress_level': 9,
        }

    return {
        'optimize': True,
        'quality': int(preset.get('quality') or 65),
    }


def should_skip_image(image_file, preset):
    original_size = get_image_data_size(image_file)
    width, height = image_file.image.size
    pixels = max(1, width * height)
    filter_name = get_image_filter_name(image_file)
    max_long_edge = max(width, height)

    if original_size <= 0:
        return 'missing-source-bytes'

    if original_size < int(preset.get('min_source_bytes') or 0):
        return 'already-small'

    if pixels < int(preset.get('min_pixels') or 0):
        return 'low-resolution'

    if (
        filter_name == '/DCTDecode'
        and max_long_edge <= int(preset.get('max_long_edge') or 0)
        and (original_size / float(pixels)) <= float(preset.get('jpeg_skip_bytes_per_pixel') or 0.0)
    ):
        return 'already-efficient-jpeg'

    return None


def encode_candidate_image(new_image, replace_kwargs):
    buffer = BytesIO()
    new_image.save(buffer, 'PDF', **replace_kwargs)
    buffer.seek(0)
    reader = PdfReader(buffer)
    page_image = reader.pages[0].images[0]
    return page_image, get_image_data_size(page_image)


def apply_candidate_image(image_file, candidate_image, replace_kwargs):
    if image_file.indirect_reference is None:
        raise TypeError('Inline images are not supported for replacement.')

    if candidate_image.indirect_reference is None:
        raise TypeError('Candidate image is not replaceable.')

    image_file.indirect_reference.pdf._objects[image_file.indirect_reference.idnum - 1] = (
        candidate_image.indirect_reference.get_object()
    )
    image_file.indirect_reference.get_object().indirect_reference = image_file.indirect_reference

    extension, byte_stream, normalized_image = _xobj_to_image(
        image_file.indirect_reference.get_object(),
        pillow_parameters=replace_kwargs,
    )
    extension = extension or '.png'
    if '.' in image_file.name:
        image_file.name = f'{image_file.name[:image_file.name.rfind(".")]}{extension}'
    else:
        image_file.name = f'{image_file.name}{extension}'
    image_file.data = byte_stream
    image_file.image = normalized_image


def maybe_replace_image(image_file, preset):
    if image_file.indirect_reference is None:
        raise TypeError('Inline images are not supported for replacement.')

    skip_reason = should_skip_image(image_file, preset)
    if skip_reason:
        return {
            'action': 'skipped',
            'reason': skip_reason,
        }

    original_size = get_image_data_size(image_file)
    new_image = normalize_image(image_file.image, preset)
    replace_kwargs = build_replace_kwargs(new_image, preset)
    candidate_image, candidate_size = encode_candidate_image(new_image, replace_kwargs)

    min_savings_bytes = max(
        int(preset.get('min_savings_bytes') or 0),
        int(round(original_size * float(preset.get('min_savings_ratio') or 0.0))),
    )
    if candidate_size >= max(1, original_size - min_savings_bytes):
        return {
            'action': 'skipped',
            'reason': 'insufficient-gain',
        }

    apply_candidate_image(image_file, candidate_image, replace_kwargs)
    return {
        'action': 'replaced',
        'originalSize': original_size,
        'candidateSize': candidate_size,
    }


def build_output_path(source_path, output_folder, suffix):
    source = Path(source_path)
    folder = Path(output_folder) if output_folder else source.parent
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f'{source.stem}{suffix}.pdf'
    return ensure_unique_output_path(target)


def format_size(value):
    size = float(value or 0)
    units = ['B', 'KB', 'MB', 'GB']
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f'{size:.1f}{unit}'
        size /= 1024.0
    return f'{value}B'


def build_target_focused_raster_steps(current_bytes, preset):
    steps = [dict(step) for step in list(preset.get('raster_retry_steps') or [])]
    if not steps:
        return []

    target_max_bytes = int(preset.get('target_max_bytes') or 0)
    if target_max_bytes <= 0 or current_bytes <= 0:
        return steps

    target_ratio = target_max_bytes / float(current_bytes)
    if target_ratio >= 0.82:
        start_index = 0
    elif target_ratio >= 0.62:
        start_index = min(1, len(steps) - 1)
    elif target_ratio >= 0.45:
        start_index = min(2, len(steps) - 1)
    else:
        start_index = max(len(steps) - 2, 0)

    return steps[start_index:]


def squeeze_pdf_with_pypdf(source_path, output_path, preset, progress_callback=None, log_callback=None):
    started_at = time.perf_counter()
    source = Path(source_path)
    reader = PdfReader(str(source))
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)

    if reader.metadata:
        try:
            writer.add_metadata(dict(reader.metadata))
        except Exception:
            pass

    seen_refs = set()
    images_seen = 0
    images_replaced = 0
    images_skipped = 0
    image_errors = []
    skip_reasons = {}
    page_count = max(1, len(writer.pages))

    if log_callback:
        log_callback(f'Using legacy PDF compression engine for {source.name}...')
        log_callback(f'Inspecting {page_count} page(s) in {source.name}...')
    if progress_callback:
        progress_callback(0.05)

    for page_index, page in enumerate(writer.pages):
        if progress_callback:
            progress_callback(min(0.12 + ((page_index / float(page_count)) * 0.68), 0.8))

        for image in page.images:
            ref = getattr(image.indirect_reference, 'idnum', None) if image.indirect_reference else f'inline:{page_index}:{image.name}'
            if ref in seen_refs:
                continue
            seen_refs.add(ref)
            images_seen += 1
            try:
                result = maybe_replace_image(image, preset)
                if result.get('action') == 'replaced':
                    images_replaced += 1
                else:
                    images_skipped += 1
                    skip_reason = str(result.get('reason') or 'unknown')
                    skip_reasons[skip_reason] = int(skip_reasons.get(skip_reason) or 0) + 1
            except Exception as error:
                image_errors.append(f'{source.name} · {image.name}: {error}')

        if progress_callback:
            progress_callback(min(0.16 + (((page_index + 1) / float(page_count)) * 0.72), 0.9))

    try:
        writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    except Exception:
        pass

    if progress_callback:
        progress_callback(0.94)

    with open(output_path, 'wb') as handle:
        writer.write(handle)

    original_bytes = source.stat().st_size
    compressed_bytes = Path(output_path).stat().st_size
    kept_original = False
    bytes_saved = max(0, original_bytes - compressed_bytes)
    saved_ratio = (bytes_saved / float(original_bytes)) if original_bytes > 0 else 0.0

    if compressed_bytes >= original_bytes or (
        bytes_saved < MIN_EFFECTIVE_PDF_SAVINGS_BYTES and saved_ratio < MIN_EFFECTIVE_PDF_SAVINGS_RATIO
    ):
        shutil.copyfile(source, output_path)
        compressed_bytes = Path(output_path).stat().st_size
        kept_original = True
        bytes_saved = 0

    return {
        'sourcePath': str(source),
        'outputPath': str(output_path),
        'engine': 'pypdf',
        'originalBytes': original_bytes,
        'compressedBytes': compressed_bytes,
        'bytesSaved': bytes_saved,
        'imagesSeen': images_seen,
        'imagesReplaced': images_replaced,
        'imagesSkipped': images_skipped,
        'skipReasons': skip_reasons,
        'imageErrors': image_errors,
        'keptOriginal': kept_original,
        'elapsedSeconds': round(time.perf_counter() - started_at, 2),
    }


def collect_fitz_image_xrefs(document):
    image_xrefs = set()

    for page in document:
        try:
            for image_info in page.get_images(full=True):
                if image_info and int(image_info[0]) > 0:
                    image_xrefs.add(int(image_info[0]))
        except Exception:
            continue

    return image_xrefs


def squeeze_pdf_with_fitz(source_path, output_path, preset, progress_callback=None, log_callback=None):
    if fitz is None:
        raise RuntimeError(
            f'PyMuPDF is unavailable: {FITZ_IMPORT_ERROR or "unknown import failure"}'
        )

    started_at = time.perf_counter()
    source = Path(source_path)
    document = fitz.open(str(source))

    try:
        page_count = max(1, document.page_count)
        image_xrefs = collect_fitz_image_xrefs(document)
        images_seen = len(image_xrefs)

        if log_callback:
            fitz_label = 'bundled' if FITZ_SOURCE == 'vendor' else 'system'
            log_callback(
                f'Using PyMuPDF fast compression engine ({fitz_label}) for {source.name}...'
            )
            log_callback(f'Inspecting {page_count} page(s) in {source.name}...')

        if progress_callback:
            progress_callback(0.08)

        document.rewrite_images(
            dpi_threshold=int(preset.get('fitz_dpi_threshold') or 0) or None,
            dpi_target=int(preset.get('fitz_dpi_target') or 0),
            quality=int(preset.get('fitz_quality') or preset.get('quality') or 60),
            lossy=True,
            lossless=True,
            bitonal=True,
            color=True,
            gray=True,
            set_to_gray=bool(preset.get('grayscale')),
        )

        if progress_callback:
            progress_callback(0.72)

        document.save(
            str(output_path),
            garbage=3,
            clean=0,
            deflate=1,
            deflate_images=1,
            deflate_fonts=1,
            use_objstms=1,
            compression_effort=0,
            preserve_metadata=1,
        )

        if progress_callback:
            progress_callback(0.94)
    finally:
        document.close()

    original_bytes = source.stat().st_size
    compressed_bytes = Path(output_path).stat().st_size
    kept_original = False
    bytes_saved = max(0, original_bytes - compressed_bytes)
    saved_ratio = (bytes_saved / float(original_bytes)) if original_bytes > 0 else 0.0

    if compressed_bytes >= original_bytes or (
        bytes_saved < MIN_EFFECTIVE_PDF_SAVINGS_BYTES and saved_ratio < MIN_EFFECTIVE_PDF_SAVINGS_RATIO
    ):
        shutil.copyfile(source, output_path)
        compressed_bytes = Path(output_path).stat().st_size
        kept_original = True
        bytes_saved = 0

    return {
        'sourcePath': str(source),
        'outputPath': str(output_path),
        'engine': 'fitz',
        'originalBytes': original_bytes,
        'compressedBytes': compressed_bytes,
        'bytesSaved': bytes_saved,
        'imagesSeen': images_seen,
        'imagesReplaced': 0 if kept_original else images_seen,
        'imagesSkipped': 0 if not kept_original else images_seen,
        'skipReasons': {},
        'imageErrors': [],
        'keptOriginal': kept_original,
        'elapsedSeconds': round(time.perf_counter() - started_at, 2),
    }


def render_page_to_jpeg_stream(page, dpi, quality, grayscale=False):
    scale = max(0.5, float(dpi) / 72.0)
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    try:
        mode = 'RGB'
        image = Image.frombytes(mode, [pixmap.width, pixmap.height], pixmap.samples)
        if grayscale:
            image = image.convert('L')

        buffer = BytesIO()
        image.save(
            buffer,
            format='JPEG',
            quality=max(20, min(95, int(quality or 40))),
            optimize=True,
            progressive=True,
        )
        return buffer.getvalue()
    finally:
        pixmap = None


def squeeze_pdf_by_rasterizing_pages(source_path, output_path, step_config, progress_callback=None, log_callback=None):
    if fitz is None:
        raise RuntimeError(
            f'PyMuPDF is unavailable: {FITZ_IMPORT_ERROR or "unknown import failure"}'
        )

    source = Path(source_path)
    document = fitz.open(str(source))
    output_document = fitz.open()
    page_count = max(1, document.page_count)

    try:
        dpi = int(step_config.get('dpi') or 96)
        quality = int(step_config.get('quality') or 38)
        grayscale = bool(step_config.get('grayscale'))

        if log_callback:
          log_callback(
              f'Applying page raster compression at {dpi} DPI / JPEG {quality}{" / grayscale" if grayscale else ""} for {source.name}...'
          )

        for page_index, page in enumerate(document):
            page_rect = page.rect
            jpeg_bytes = render_page_to_jpeg_stream(page, dpi=dpi, quality=quality, grayscale=grayscale)
            next_page = output_document.new_page(width=page_rect.width, height=page_rect.height)
            next_page.insert_image(page_rect, stream=jpeg_bytes)
            if progress_callback:
                progress_callback(min(0.25 + (((page_index + 1) / float(page_count)) * 0.6), 0.94))

        output_document.save(
            str(output_path),
            garbage=3,
            clean=0,
            deflate=1,
            deflate_images=1,
            deflate_fonts=1,
            use_objstms=1,
            compression_effort=0,
        )
    finally:
        output_document.close()
        document.close()


def attempt_target_focused_raster_compression(
    source_path,
    output_path,
    preset,
    current_bytes,
    progress_callback=None,
    log_callback=None,
    started_at=None,
):
    target_max_bytes = int(preset.get('target_max_bytes') or 0)
    raster_steps = build_target_focused_raster_steps(current_bytes, preset)
    if target_max_bytes <= 0 or not raster_steps:
        return None

    source = Path(source_path)
    best_result = None
    attempted_steps = 0

    if log_callback:
        log_callback(
            f'Switching to target-focused page compression for {source.name} '
            f'to try to reach {format_size(target_max_bytes)}...'
        )

    for step_index, step_config in enumerate(raster_steps, start=1):
        attempted_steps += 1
        raster_output_path = str(Path(output_path).with_name(
            f'{Path(output_path).stem}__raster_{step_index}{Path(output_path).suffix}'
        ))
        if progress_callback:
            progress_callback(0.18)

        squeeze_pdf_by_rasterizing_pages(
            source_path,
            raster_output_path,
            step_config,
            progress_callback=progress_callback,
            log_callback=log_callback,
        )

        compressed_bytes = Path(raster_output_path).stat().st_size
        bytes_saved = max(0, source.stat().st_size - compressed_bytes)
        candidate = {
            'sourcePath': str(source),
            'outputPath': str(output_path),
            'engine': 'fitz-raster',
            'originalBytes': source.stat().st_size,
            'compressedBytes': compressed_bytes,
            'bytesSaved': bytes_saved,
            'imagesSeen': 0,
            'imagesReplaced': 0,
            'imagesSkipped': 0,
            'skipReasons': {},
            'imageErrors': [],
            'keptOriginal': False,
            'rasterStep': dict(step_config),
        }

        if best_result is None or compressed_bytes < int(best_result.get('compressedBytes') or source.stat().st_size):
            Path(raster_output_path).replace(output_path)
            best_result = candidate
        else:
            Path(raster_output_path).unlink(missing_ok=True)

        if compressed_bytes <= target_max_bytes:
            break

    if best_result is None:
        return None

    best_result['elapsedSeconds'] = round((time.perf_counter() - started_at) if started_at is not None else 0.0, 2)
    best_result['targetMaxBytes'] = target_max_bytes
    best_result['targetMet'] = int(best_result.get('compressedBytes') or 0) <= target_max_bytes
    best_result['rasterAttempts'] = attempted_steps
    return best_result


def squeeze_pdf(source_path, output_path, preset, progress_callback=None, log_callback=None):
    started_at = time.perf_counter()
    fitz_error = None
    if fitz is not None:
        try:
            base_result = squeeze_pdf_with_fitz(
                source_path,
                output_path,
                preset,
                progress_callback=progress_callback,
                log_callback=log_callback,
            )

            target_max_bytes = int(preset.get('target_max_bytes') or 0)
            if (
                target_max_bytes > 0
                and int(base_result.get('compressedBytes') or 0) > target_max_bytes
            ):
                raster_result = attempt_target_focused_raster_compression(
                    source_path,
                    output_path,
                    preset,
                    int(base_result.get('compressedBytes') or 0),
                    progress_callback=progress_callback,
                    log_callback=log_callback,
                    started_at=started_at,
                )
                if raster_result is not None and int(raster_result.get('compressedBytes') or 0) < int(base_result.get('compressedBytes') or 0):
                    return raster_result

            if target_max_bytes > 0:
                base_result['targetMaxBytes'] = target_max_bytes
                base_result['targetMet'] = int(base_result.get('compressedBytes') or 0) <= target_max_bytes
            base_result['elapsedSeconds'] = round(time.perf_counter() - started_at, 2)
            return base_result
        except Exception as current_error:
            fitz_error = current_error
            if log_callback:
                log_callback(
                    f'PyMuPDF fast compression failed for {Path(source_path).name}. '
                    f'Trying raster compression instead: {current_error}'
                )

            raster_result = attempt_target_focused_raster_compression(
                source_path,
                output_path,
                preset,
                Path(source_path).stat().st_size,
                progress_callback=progress_callback,
                log_callback=log_callback,
                started_at=started_at,
            )
            if raster_result is not None:
                raster_result['fitzError'] = str(current_error)
                return raster_result

    legacy_result = squeeze_pdf_with_pypdf(
        source_path,
        output_path,
        preset,
        progress_callback=progress_callback,
        log_callback=log_callback,
    )
    if fitz_error is not None:
        legacy_result['fitzError'] = str(fitz_error)
    target_max_bytes = int(preset.get('target_max_bytes') or 0)
    if target_max_bytes > 0:
        legacy_result['targetMaxBytes'] = target_max_bytes
        legacy_result['targetMet'] = int(legacy_result.get('compressedBytes') or 0) <= target_max_bytes
    legacy_result['elapsedSeconds'] = round(time.perf_counter() - started_at, 2)
    return legacy_result


def run(config):
    source_files = [str(item) for item in (config.get('sourceFiles') or []) if str(item or '').strip()]
    output_folder = str(config.get('outputFolder') or '').strip()
    options = config.get('config') or {}
    preset = choose_preset(options)
    suffix = str(options.get('suffix') or '_squeezed').strip() or '_squeezed'

    if not source_files:
        return {
            'success': False,
            'error': 'No PDF files were selected.',
        }

    results = []
    failed = []
    unchanged = []
    total = len(source_files)

    emit_log(f'Preparing PDF Squeezer for {total} file(s)...')
    emit_log(f'Preset: {preset["label"]}')
    emit_progress(6)

    for index, source_file in enumerate(source_files):
        source_path = Path(source_file)
        progress_start = 8 + int((index / max(1, total)) * 84)
        emit_progress(progress_start)

        if not source_path.exists() or source_path.suffix.lower() != '.pdf':
            failed.append(source_path.name)
            emit_log(f'Skipped: {source_path.name} is not a readable PDF file.')
            continue

        target_path = build_output_path(source_path, output_folder or str(source_path.parent), suffix)
        emit_log(f'[{index + 1}/{total}] Compressing {source_path.name}')

        try:
            file_progress_start = index / float(max(1, total))
            file_progress_end = (index + 1) / float(max(1, total))

            def emit_file_progress(local_fraction):
                bounded_fraction = max(0.0, min(1.0, float(local_fraction or 0.0)))
                overall_fraction = file_progress_start + ((file_progress_end - file_progress_start) * bounded_fraction)
                emit_progress(8 + int(round(overall_fraction * 84)))

            result = squeeze_pdf(
                source_path,
                target_path,
                preset,
                progress_callback=emit_file_progress,
                log_callback=emit_log,
            )
            results.append(result)
            saved_ratio = 0.0
            if result['originalBytes'] > 0:
                saved_ratio = (result['bytesSaved'] / result['originalBytes']) * 100
            if result.get('keptOriginal'):
                unchanged.append(source_path.name)
                emit_log(
                    f'No smaller output found for {source_path.name}. '
                    f'Kept an unchanged copy as {Path(target_path).name} '
                    f'after {result["elapsedSeconds"]:.1f}s.',
                )
            else:
                emit_log(
                    f'Compressed: {source_path.name} -> {Path(target_path).name} | '
                    f'{format_size(result["originalBytes"])} -> {format_size(result["compressedBytes"])} '
                    f'({saved_ratio:.1f}% smaller, {result["elapsedSeconds"]:.1f}s)',
                )
                if result.get('targetMaxBytes') and not result.get('targetMet', True):
                    emit_log(
                        f'{source_path.name} is still above the email-friendly target of '
                        f'{format_size(result["targetMaxBytes"])} after strong compression.',
                    )
            if result.get('imagesSkipped'):
                emit_log(
                    f'Skipped {result["imagesSkipped"]} already-efficient or low-gain image(s) in {source_path.name}.',
                )
            for image_error in result['imageErrors']:
                emit_log(f'Image warning: {image_error}')
            emit_file_result(result)
        except Exception as error:
            failed.append(source_path.name)
            emit_log(f'Failed: {source_path.name} ({error})')

        emit_progress(8 + int(((index + 1) / max(1, total)) * 84))

    total_original = sum(item['originalBytes'] for item in results)
    total_compressed = sum(item['compressedBytes'] for item in results)
    total_saved = sum(item['bytesSaved'] for item in results)
    output_paths = [item['outputPath'] for item in results]
    output_root = output_folder or (str(Path(source_files[0]).parent) if source_files else '')
    target_exceeded_files = [
        Path(item['sourcePath']).name
        for item in results
        if item.get('targetMaxBytes') and not item.get('targetMet', True)
    ]

    emit_progress(100)

    if not results:
        return {
            'success': False,
            'error': 'No PDF files could be compressed.',
            'outputFolder': output_root,
            'outputPaths': [],
            'fileCount': 0,
            'failedCount': len(failed),
            'issues': {
                'skippedFiles': failed,
                'unchangedFiles': unchanged,
                'targetExceededFiles': target_exceeded_files,
            },
        }

    return {
        'success': True,
        'outputFolder': output_root,
        'outputPaths': output_paths,
        'fileCount': len(results),
        'failedCount': len(failed),
        'failedFiles': failed,
        'totalOriginalBytes': total_original,
        'totalCompressedBytes': total_compressed,
        'totalBytesSaved': total_saved,
        'unchangedCount': len(unchanged),
        'issues': {
            'skippedFiles': failed,
            'unchangedFiles': unchanged,
            'targetExceededFiles': target_exceeded_files,
        },
    }


if __name__ == '__main__':
    try:
        payload = json.loads(sys.stdin.buffer.read().decode('utf-8') or '{}')
        result = run(payload)
        print(json.dumps(result))
    except Exception as error:
        traceback.print_exc()
        print(json.dumps({'success': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
