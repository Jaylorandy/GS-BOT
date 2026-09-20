import glob
import hashlib
import json
import os
import re
import tempfile


IMAGE_EXTENSIONS = ('jpg', 'jpeg', 'png', 'webp')
FOLDER_IMAGE_LIST_CACHE = {}
ORDERED_IMAGE_CACHE = {}
RESOLVED_DISPLAY_CACHE = {}


def natural_sort_key(value):
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r'(\d+)', os.path.basename(str(value)))
    ]


def get_image_suffix(path, style_number=''):
    base = os.path.splitext(os.path.basename(path))[0]
    style = str(style_number or '').strip()
    if style and base.lower().startswith(style.lower()):
        remainder = base[len(style):].lstrip('_- ')
        return remainder.upper()
    if '_' in base:
        return base.rsplit('_', 1)[-1].upper()
    if '-' in base:
        return base.rsplit('-', 1)[-1].upper()
    return ''


def normalize_suffixes(types):
    seen = set()
    suffixes = []
    for item in types or []:
        suffix = str(item or '').strip().lstrip('_-').upper()
        if suffix and suffix not in seen:
            seen.add(suffix)
            suffixes.append(suffix)
    return suffixes


def normalize_style_match_key(value=''):
    return re.sub(r'[\s_-]+', '', str(value or '').lower())


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path


def get_scan_cache_root():
    candidates = [
        os.path.join(os.path.expanduser('~'), '.gsbot', 'ppt-scan-cache'),
        os.path.join(tempfile.gettempdir(), 'gsbot-ppt-scan-cache'),
    ]
    for candidate in candidates:
        try:
            ensure_dir(candidate)
            probe = os.path.join(candidate, f'.probe-{os.getpid()}')
            with open(probe, 'w', encoding='utf-8') as handle:
                handle.write('ok')
            os.remove(probe)
            return candidate
        except Exception:
            continue
    return ensure_dir(os.path.join(tempfile.gettempdir(), 'gsbot-ppt-scan-cache'))


def build_folder_signature(folder):
    resolved = os.path.abspath(folder)
    entries = []
    if not os.path.isdir(resolved):
        return {'folder': resolved, 'entries': entries}
    for name in sorted(os.listdir(resolved), key=natural_sort_key):
        if name.startswith('.'):
            continue
        full_path = os.path.join(resolved, name)
        if not os.path.isfile(full_path):
            continue
        if os.path.splitext(name)[1].lower().lstrip('.') not in IMAGE_EXTENSIONS:
            continue
        stats = os.stat(full_path)
        entries.append({
            'name': name,
            'size': int(stats.st_size or 0),
            'mtimeMs': int(round(stats.st_mtime * 1000)),
        })
    return {'folder': resolved, 'entries': entries}


def build_cache_key(payload):
    raw = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()


def get_cache_path(namespace, cache_key):
    return os.path.join(get_scan_cache_root(), f'{namespace}-{cache_key}.json')


def read_disk_cache(namespace, cache_key, signature):
    try:
      cache_path = get_cache_path(namespace, cache_key)
      if not os.path.exists(cache_path):
          return None
      with open(cache_path, 'r', encoding='utf-8') as handle:
          payload = json.load(handle)
      if payload.get('signature') != signature:
          return None
      return payload.get('value')
    except Exception:
      return None


def write_disk_cache(namespace, cache_key, signature, value):
    try:
        cache_path = get_cache_path(namespace, cache_key)
        with open(cache_path, 'w', encoding='utf-8') as handle:
            json.dump({
                'signature': signature,
                'value': value,
            }, handle, ensure_ascii=False, indent=2)
    except Exception:
        return None


def find_image(folder, style_number, types):
    """查找图片文件，支持 _ 和 - 两种分隔符，只按真实文件后缀匹配"""
    suffixes = normalize_suffixes(types)
    for t in suffixes:
        for ext in IMAGE_EXTENSIONS:
            for separator in ('_', '-'):
                p = os.path.join(folder, f"{style_number}{separator}{t}.{ext}")
                if os.path.exists(p):
                    return p

    all_imgs = list_folder_images(folder)
    for t in suffixes:
        for p in all_imgs:
            if get_image_suffix(p, style_number) == t:
                return p
    return None


def find_any_image(folder):
    """查找文件夹中任何一张图片"""
    images = list_folder_images(folder)
    return images[0] if images else None


def list_folder_images(folder):
    signature = build_folder_signature(folder)
    cache_key = build_cache_key(signature)
    if cache_key in FOLDER_IMAGE_LIST_CACHE:
        return list(FOLDER_IMAGE_LIST_CACHE[cache_key])

    cached = read_disk_cache('folder-images', cache_key, signature)
    if cached is not None:
        FOLDER_IMAGE_LIST_CACHE[cache_key] = cached
        return list(cached)

    images = []
    for ext in IMAGE_EXTENSIONS:
        images.extend(glob.glob(os.path.join(folder, f"*.{ext}")))
    images = sorted(images, key=natural_sort_key)
    FOLDER_IMAGE_LIST_CACHE[cache_key] = images
    write_disk_cache('folder-images', cache_key, signature, images)
    return list(images)


def existing_path(path):
    return path if path and os.path.exists(path) else None


def order_images_by_suffix(images, style_number, preferred_suffixes=None):
    signature = {
        'styleNumber': str(style_number or ''),
        'preferredSuffixes': normalize_suffixes(preferred_suffixes),
        'images': [
            os.path.abspath(path) for path in (images or [])
            if path and os.path.exists(path)
        ],
    }
    cache_key = build_cache_key(signature)
    if cache_key in ORDERED_IMAGE_CACHE:
        return list(ORDERED_IMAGE_CACHE[cache_key])

    cached = read_disk_cache('ordered-images', cache_key, signature)
    if cached is not None:
        ORDERED_IMAGE_CACHE[cache_key] = cached
        return list(cached)

    suffix_rank = {}
    preferred = normalize_suffixes(preferred_suffixes)
    defaults = [
        '01', '1', 'X01', 'F', 'B',
        *[f'{index:02d}' for index in range(2, 31)],
        *[f'X{index:02d}' for index in range(2, 31)],
        'S', 'D', 'E', 'P',
        *[f'A{index}' for index in range(1, 16)],
        *[f'D{index}' for index in range(1, 16)],
    ]
    for suffix in [*preferred, *defaults]:
        normalized = str(suffix or '').upper()
        if normalized and normalized not in suffix_rank:
            suffix_rank[normalized] = len(suffix_rank)

    def sort_key(path):
        suffix = get_image_suffix(path, style_number)
        return (suffix_rank.get(suffix, 999), natural_sort_key(path))

    ordered = []
    for path in sorted(images or [], key=sort_key):
        if path and os.path.exists(path) and path not in ordered:
            ordered.append(path)
    ORDERED_IMAGE_CACHE[cache_key] = ordered
    write_disk_cache('ordered-images', cache_key, signature, ordered)
    return ordered


def build_style_suffixes(settings=None):
    settings = settings or {}
    configured = normalize_suffixes(settings.get('imageSuffixes') or [])
    fallback = [
        'F', 'S', 'B',
        *[f'{index:02d}' for index in range(1, 31)],
        *[f'X{index:02d}' for index in range(1, 31)],
        'FRONT', 'BACK', 'D', 'E',
    ]
    return normalize_suffixes([*configured, *fallback])


def split_style_image_name(path, suffixes):
    base = os.path.splitext(os.path.basename(path))[0]
    upper_base = base.upper()
    for suffix in sorted(normalize_suffixes(suffixes), key=len, reverse=True):
        for separator in ('_', '-'):
            token = f'{separator}{suffix}'
            if upper_base.endswith(token):
                style_key = base[:len(base) - len(token)].strip()
                if style_key:
                    return style_key, suffix
    return None, None


def group_top_level_style_images(source, settings=None):
    suffixes = build_style_suffixes(settings)
    groups = {}
    canonical_keys = {}
    for image_path in list_folder_images(source):
        style_key, suffix = split_style_image_name(image_path, suffixes)
        if not style_key:
            continue
        normalized_key = normalize_style_match_key(style_key)
        canonical_key = canonical_keys.get(normalized_key) or style_key
        canonical_keys[normalized_key] = canonical_key
        groups.setdefault(canonical_key, []).append(image_path)

    entries = []
    for style_key in sorted(groups.keys(), key=natural_sort_key):
        ordered = order_images_by_suffix(groups[style_key], style_key, suffixes)
        entries.append((style_key, ordered))
    return entries


def resolve_display_images(folder, style_number, info, source_mode='document-images', settings=None):
    settings = settings or {}
    preset = info.get('resolvedDisplayImages') or {}
    if isinstance(preset, dict) and any(preset.get(key) for key in ('model', 'front', 'back', 'ordered', 'grid', 'vision')):
        return {
            'model': existing_path(preset.get('model')) or existing_path(info.get('visionImagePath')) or existing_path(info.get('frontImagePath')),
            'front': existing_path(preset.get('front')) or existing_path(info.get('frontImagePath')),
            'back': existing_path(preset.get('back')) or existing_path(info.get('backImagePath')),
            'ordered': [img for img in (preset.get('ordered') or []) if existing_path(img)],
            'vision': existing_path(preset.get('vision')) or existing_path(info.get('visionImagePath')) or existing_path(info.get('frontImagePath')),
            'grid': [img for img in (preset.get('grid') or []) if existing_path(img)],
        }

    signature = {
        'folder': build_folder_signature(folder),
        'styleNumber': str(style_number or ''),
        'sourceMode': str(source_mode or ''),
        'imageSuffixes': normalize_suffixes(settings.get('imageSuffixes') or []),
        'info': {
            'frontImagePath': info.get('frontImagePath') or '',
            'backImagePath': info.get('backImagePath') or '',
            'labelImagePath': info.get('labelImagePath') or '',
            'visionImagePath': info.get('visionImagePath') or '',
            'galleryImagePaths': [img for img in (info.get('galleryImagePaths') or []) if img],
        },
    }
    cache_key = build_cache_key(signature)
    if cache_key in RESOLVED_DISPLAY_CACHE:
        return dict(RESOLVED_DISPLAY_CACHE[cache_key])

    cached = read_disk_cache('resolved-display', cache_key, signature)
    if cached is not None:
        RESOLVED_DISPLAY_CACHE[cache_key] = cached
        return dict(cached)

    preferred_suffixes = settings.get('imageSuffixes') or []
    front_img = existing_path(info.get('frontImagePath')) or find_image(folder, style_number, ['F'])
    back_img = existing_path(info.get('backImagePath')) or find_image(folder, style_number, ['B'])
    label_img = info.get('labelImagePath')
    vision_img = info.get('visionImagePath')
    ordered_imgs = [img for img in (info.get('galleryImagePaths') or []) if existing_path(img)]

    all_imgs = list_folder_images(folder)
    excluded = {img for img in [label_img] if img}
    display_candidates = [img for img in all_imgs if img not in excluded]
    ordered_candidates = order_images_by_suffix(display_candidates, style_number, preferred_suffixes)

    if source_mode == 'style-images-only' and not ordered_imgs:
        ordered_imgs = ordered_candidates

    if source_mode == 'style-images-only' and ordered_imgs:
        model_img = ordered_imgs[0]
    elif source_mode == 'label-images':
        model_img = None
        for img in ordered_candidates:
            if img not in {front_img, back_img}:
                model_img = img
                break
        if not model_img:
            model_img = front_img or back_img
    else:
        model_img = find_image(folder, style_number, ['1', '01', '2', '02', 'X01', 'X02'])
        if not model_img:
            for img in ordered_candidates:
                if img not in {front_img, back_img}:
                    model_img = img
                    break
        if not model_img:
            model_img = front_img or find_any_image(folder)

    grid_imgs = []
    for img in [model_img, front_img, back_img]:
        if img and img not in grid_imgs and os.path.exists(img):
            grid_imgs.append(img)
    for img in ordered_candidates:
        if img not in grid_imgs and os.path.exists(img):
            grid_imgs.append(img)

    result = {
        'model': model_img,
        'front': front_img,
        'back': back_img,
        'ordered': ordered_imgs,
        'vision': vision_img or front_img or model_img or back_img,
        'grid': grid_imgs,
    }
    RESOLVED_DISPLAY_CACHE[cache_key] = result
    write_disk_cache('resolved-display', cache_key, signature, result)
    return dict(result)


def scan_style_entries(source, settings=None, precomputed_info=None, load_info=None, organize_metadata_dir='_organize_meta'):
    settings = settings or {}
    precomputed_info = precomputed_info or {}
    source_mode = settings.get('sourceMode', 'document-images')
    source_organization = settings.get('sourceOrganization', 'auto')

    if source_mode in ('label-images', 'fabric-images', 'style-images-only'):
        precomputed_entries = precomputed_info.get('__styleEntries') or []
        if precomputed_entries and callable(load_info):
            styles = []
            for entry in precomputed_entries:
                style_key = entry.get('styleKey')
                folder_path = entry.get('folderPath') or source
                if not style_key:
                    continue
                info = load_info(folder_path, style_key, settings)
                styles.append((style_key, folder_path, info))
            return styles

        if source_mode == 'style-images-only' and source_organization in ('single-folder', 'auto', 'style-folders') and callable(load_info):
            top_level_entries = group_top_level_style_images(source, settings)
            if top_level_entries and (source_organization != 'style-folders' or not any(
                os.path.isdir(os.path.join(source, item)) and not item.startswith('.') and item != organize_metadata_dir
                for item in os.listdir(source)
            )):
                styles = []
                for style_key, ordered_images in top_level_entries:
                    info = load_info(source, style_key, settings)
                    if not info.get('galleryImagePaths'):
                        info['galleryImagePaths'] = ordered_images
                    if not info.get('frontImagePath'):
                        info['frontImagePath'] = find_image(source, style_key, ['F', 'FRONT']) or (ordered_images[0] if ordered_images else '')
                    if not info.get('backImagePath'):
                        info['backImagePath'] = find_image(source, style_key, ['S', 'B', 'BACK']) or (ordered_images[1] if len(ordered_images) > 1 else '')
                    if not info.get('styleNumber'):
                        info['styleNumber'] = style_key
                    # name 不再兜底为款号：空名称时不渲染，避免 STYLE NUMBER 下方重复显示款号
                    styles.append((style_key, source, info))
                return styles

    styles = []
    if not callable(load_info):
        return styles

    for item in sorted(os.listdir(source)):
        p = os.path.join(source, item)
        if os.path.isdir(p) and not item.startswith('.') and item != organize_metadata_dir:
            info = load_info(p, item, settings)
            styles.append((item, p, info))
    return styles


def ensure_unique_output_path(output_path):
    candidate = os.path.normpath(output_path)
    if not os.path.exists(candidate):
        return candidate

    base, ext = os.path.splitext(candidate)
    index = 1
    while True:
        next_candidate = f"{base}({index}){ext}"
        if not os.path.exists(next_candidate):
            return next_candidate
        index += 1
