"""core/recipe_synth.py PART 2 (模式合成) - 参考实现还原。

还原自 PyInstaller 反汇编产物；对应原模块 core/recipe_synth.py 的
_shape_of / _role_pattern / _looks_like_data / _other_pattern /
synthesize_line_pattern / _generalize_prefix / synthesize_entity_anchor /
_is_data_token / _label_tokens / _trim_to_keyword / synthesize_field_anchor /
apply_header_anchors。

跨部分依赖（悬空引用，见文件底部同名符号的运行时定义说明）：
# from core.recipe_synth import (
#     SynthesisError, assign_roles, _is_numeric_token, _date_variants, Sample,
#     PoRecipe, ExtractedData, Logger,
# )
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Sequence, Set, Tuple, Callable

# ---------------------------------------------------------------------------
# 模块级常量（原模块第 88-97 / 574 / 697-719 行定义，此处原样复制）
# ---------------------------------------------------------------------------
_NUMERIC_TOKEN = re.compile(r'^[\d.,]+$')
_HAS_DIGIT = re.compile(r'\d')
_APOSTROPHES = "'‘’‛`´ʼˮ"
_RATIO_BLOCK = re.compile(r'\b([A-Za-z]{1,4}:\d+)(?:\s*,\s*[A-Za-z]{1,4}:\d+)+')
MAX_PREFIX_TOKENS = 6

_FIELD_LABEL_HINTS: Dict[str, Sequence[str]] = {
    'season': ('Season', 'Saison'),
    'currency': ('Currency', 'Währung'),
    'price_term': ('Incoterm', 'Trade term', 'Price term', 'Lieferbedingung'),
    'port_discharge': ('Port of discharge', 'Discharge', 'Hafen'),
    'port_loading': ('Port of loading', 'Loading', 'Ladeport'),
    'ship_mode': ('Transport', 'Ship mode', 'Mode', 'Versand'),
    'vendor_name': ('Supplier', 'Vendor', 'Manufacturer', 'Lieferant'),
    'agent_name': ('Agent', 'Representative', 'Vertreter'),
    'product_desc': ('VPN', 'Product', 'Description', 'Artikel'),
    'style_no': ('Style', 'Modell'),
    'delivery_date': ('Shipment', 'Delivery', 'Lieferdatum'),
    'import_po_no': ('Import PO', 'Import Purchase Order'),
    'reference_no': ('Reference',),
    'cir_no': ('CIR',),
    'freight_terms': ('Freight', 'Freight Terms', 'Shipping Terms'),
    'country_of_origin': ('Country of Origin', 'Origin Country', 'Exiting Country'),
    'dc_address': ('DC Address', 'Distribution Center', 'Deliver to'),
}

_HEADER_ANCHORS = (
    ('season', 'season_anchor'),
    ('currency', 'currency_anchor'),
    ('price_term', 'price_term_anchor'),
    ('payment_terms', 'payment_terms_anchor'),
    ('port_discharge', 'port_discharge_anchor'),
    ('port_loading', 'port_loading_anchor'),
    ('ship_mode', 'ship_mode_anchor'),
    ('vendor_name', 'vendor_anchor'),
    ('agent_name', 'agent_anchor'),
    ('product_desc', 'style_anchor'),
    ('import_po_no', 'import_po_no_anchor'),
    ('reference_no', 'reference_no_anchor'),
    ('cir_no', 'cir_no_anchor'),
    ('freight_terms', 'freight_terms_anchor'),
    ('country_of_origin', 'country_of_origin_anchor'),
    ('dc_address', 'dc_address_anchor'),
)


# ---------------------------------------------------------------------------
# 行模式合成
# ---------------------------------------------------------------------------

def _shape_of(tokens: Sequence[str], assign: Dict[str, int]) -> Tuple[Tuple[str, ...], List[List[str]]]:
    """Collapse a row into (shape, runs).

    shape is e.g. ``("style", "*", "unit", "qty", "unit_price", "*")`` where
    ``*`` is a run of unclassified tokens; runs holds the tokens of each segment.
    """
    idx2role = {i: r for r, i in assign.items()}
    shape: List[str] = []
    runs: List[List[str]] = []
    cur: List[str] = []
    for i, t in enumerate(tokens):
        r = idx2role.get(i)
        if r is None:
            cur.append(t)
            continue
        if cur:
            shape.append('*')
            runs.append(cur)
            cur = []
        shape.append(r)
        runs.append([t])
    if cur:
        shape.append('*')
        runs.append(cur)
    return tuple(shape), runs


def _role_pattern(role: str, vals: Sequence[str]) -> str:
    if role == 'style':
        dashes = min(v.count('-') for v in vals)
        core = '\\S+-\\S+-\\S+' if dashes >= 2 else ('\\S+-\\S+' if dashes == 1 else '\\S+')
        return f'(?P<style>{core})'
    if role == 'unit':
        if len(set(vals)) == 1:
            return f'(?P<unit>{re.escape(vals[0])})'
        return '(?P<unit>[A-Za-z]+)'
    if role in ('qty', 'unit_price'):
        return f'(?P<{role}>[\\d.,]+)'
    return f'(?P<{role}>\\S+)'


def _looks_like_data(tokens: Sequence[str]) -> bool:
    """True when a run of unclassified tokens is product/colour DATA, not a
    structural label. A data word is one with an apostrophe (MEN'S / LADIES'),
    a non-ASCII token (Turkish/Cyrillic names), or a long alphabetic word
    (product nouns like TROUSERS / JACKET / BEIGE). Freezing these into a
    line_pattern literal is what makes a cached recipe die on the next PO that
    shares the layout fingerprint but carries a different product.
    """
    for t in tokens:
        if any(ch in _APOSTROPHES for ch in t):
            return True
        if any(ord(c) > 127 for c in t):
            return True
        if len(t) >= 5 and t.isalpha() and t.isascii():
            return True
    return False


def _other_pattern(runs: Sequence[Sequence[str]], is_first: bool, is_last: bool,
                   want_middle: bool) -> Tuple[str, bool]:
    """Pattern for a run of unclassified tokens. Returns (pattern, is_variable).

    A run is kept as a LITERAL only when it is identical on every sample row AND
    carries no digits - digits are data, and freezing data into the rule is what
    makes a cached recipe die on the next PO. Product/colour words are data too,
    so a constant run of them becomes a wildcard, not a literal. Anything else
    becomes a group.
    """
    texts = [' '.join(r) for r in runs]
    constant = len(set(texts)) == 1 and len(runs) >= 2
    has_digit = any(_HAS_DIGIT.search(t) for t in texts)
    if constant and not has_digit:
        if _looks_like_data(runs[0]):
            return ('.*?', True)
        return ('\\s+'.join(re.escape(t) for t in runs[0]), False)
    if is_last:
        if all(_NUMERIC_TOKEN.match(t) for t in texts):
            return ('[\\d.,]+', True)
        if all(len(r) == 1 for r in runs):
            return ('\\S+', True)
        return ('', True)
    if is_first:
        return ('.*?', True)
    return ('(?P<middle>.*?)' if want_middle else '.*?', True)


def synthesize_line_pattern(samples: Sequence[Sample]) -> Tuple[str, str, int]:
    """Grow a ``line_pattern`` from the real rows. Returns (pattern, unit, used)."""
    assigns, _roles = assign_roles(samples)
    shaped = [_shape_of(s.tokens, a) for s, a in zip(samples, assigns)]
    tally: Dict[Tuple[str, ...], int] = {}
    for shape, _ in shaped:
        tally[shape] = tally.get(shape, 0) + 1
    best_shape = max(tally.items(), key=lambda kv: (kv[1], -len(kv[0])))[0]
    kept = [runs for shape, runs in shaped if shape == best_shape]
    if not kept:
        raise SynthesisError('无法从订单行归纳出统一结构。')
    parts: List[str] = []
    want_middle = True
    for k, seg in enumerate(best_shape):
        if seg == '*':
            pat, variable = _other_pattern(
                [runs[k] for runs in kept],
                is_first=k == 0,
                is_last=k == len(best_shape) - 1,
                want_middle=want_middle,
            )
            if not pat:
                continue
            if variable and '(?P<middle>' in pat:
                want_middle = False
            parts.append(pat)
        else:
            parts.append(_role_pattern(seg, [runs[k][0] for runs in kept]))
    pattern = '\\s+'.join(parts)

    if any(_RATIO_BLOCK.search(s.line) for s in samples):
        pattern = pattern + '(?=.*' + _RATIO_BLOCK.pattern + ')'

    try:
        re.compile(pattern)
    except re.error as e:
        raise SynthesisError(f'合成的行正则非法：{e}\n{pattern}') from e

    units = [runs[i][0] for runs in kept for i, seg in enumerate(best_shape) if seg == 'unit']
    unit = units[0] if units and len(set(units)) == 1 else ''
    return pattern, unit, len(kept)


# ---------------------------------------------------------------------------
# 锚点合成
# ---------------------------------------------------------------------------

def _generalize_prefix(tokens: Sequence[str], soft: Set[str]) -> Tuple[List[str], bool]:
    """Escape prefix tokens, but replace data-looking ones with a wildcard.

    ``soft`` holds values that belong to OTHER extracted fields - freezing those
    into a label would make the anchor collapse the moment the next PO carries a
    different value (e.g. ``Incoterms: FOB x`` vs ``Incoterms: CIF x``).
    """
    out: List[str] = []
    literal = False
    for t in tokens:
        if t in soft:
            out.append('\\S+')
        elif _is_numeric_token(t):
            out.append('\\d+')
        else:
            out.append(re.escape(t))
            literal = True
    return out, literal


def synthesize_entity_anchor(lines: Sequence[str], po_nos: Sequence[str],
                             doc: str) -> Tuple[str, str]:
    """Build (entity_anchor, po_no_anchor) from where the PO numbers actually sit."""
    wanted = [p for p in po_nos if p]
    if not wanted:
        return ('', '')
    rows: List[Tuple[List[str], int]] = []
    for po in wanted:
        found = None
        for ln in lines:
            toks = ln.split()
            if po in toks:
                found = (toks, toks.index(po))
                break
        if found is None:
            return ('', '')
        rows.append(found)
    idx = rows[0][1]
    if idx == 0 or any(r[1] != idx for r in rows):
        return ('', '')
    prefix_cols: List[List[str]] = [[] for _ in range(idx)]
    for toks, _ in rows:
        for i in range(idx):
            prefix_cols[i].append(toks[i])
    parts: List[str] = []
    literal = False
    for col in prefix_cols:
        if len(set(col)) == 1 and not _is_numeric_token(col[0]):
            parts.append(re.escape(col[0]))
            literal = True
        elif all(_is_numeric_token(c) for c in col):
            parts.append('\\d+')
        else:
            parts.append('\\S+')
    if not literal:
        return ('', '')
    head = '\\s+'.join(parts)
    po_no_anchor = head + '\\s+(?P<po_no>\\S+)'
    entity_anchor = po_no_anchor + '(?:[ \\t]+\\S+)*'
    got = [m.group('po_no') for m in re.finditer(entity_anchor, doc)]
    if sorted(got) != sorted(wanted):
        return ('', '')
    return entity_anchor, po_no_anchor


def _is_data_token(tok: str, soft: Set[str]) -> bool:
    """A token that carries a VALUE rather than naming one."""
    return bool(_HAS_DIGIT.search(tok)) or tok in soft


def _label_tokens(prefix: Sequence[str], soft: Set[str]) -> List[str]:
    """The label sitting in front of a value, read right-to-left.

    Two phases, because a value is not always glued to its label:

        Supplier: 10098881 Gs Global Sourcing Co.,Ltd
        ^label^   ^phase 1^ ^value

    phase 1 swallows the data tokens wedged between the label and the value (they
    become wildcards, so a different supplier code still matches); phase 2 takes
    the label proper - its ``:`` terminator plus the words in front of it - and
    stops at the next ``:`` or the next data token, so a neighbouring field never
    leaks into the label.
    """
    taken: List[str] = []
    i = len(prefix) - 1
    while i >= 0 and len(taken) < MAX_PREFIX_TOKENS and _is_data_token(prefix[i], soft):
        taken.append(prefix[i])
        i -= 1
    saw_colon = False
    while i >= 0 and len(taken) < MAX_PREFIX_TOKENS:
        t = prefix[i]
        if _is_data_token(t, soft):
            break
        if t.endswith(':'):
            if saw_colon:
                break
            saw_colon = True
        taken.append(t)
        i -= 1
    taken.reverse()
    return taken


def _trim_to_keyword(tokens: Sequence[str], prefer: Sequence[str]) -> List[str]:
    """Drop leading tokens that sit in front of the expected field keyword.

    ``LPP SA Supplier: 10098881`` -> ``Supplier: 10098881``: the brand tag ``LPP SA``
    is a *different* field riding the same line, so we keep only from the field
    keyword onward. Tokens are compared after stripping a trailing ``:``.
    """
    norm = [t.rstrip(':').lower() for t in tokens]
    for p in prefer:
        pw = p.lower().split()
        for i in range(len(norm) - len(pw) + 1):
            if norm[i:i + len(pw)] == pw:
                return list(tokens[i:])
    return list(tokens)


def synthesize_field_anchor(lines: Sequence[str], doc: str, value: str,
                            soft: Set[str], prefer: Sequence[str] = ()) -> str:
    """``Label: value`` -> a regex whose group(1) captures exactly ``value``.

    A value usually appears several times in a PO (multi-entity documents repeat
    the header block). We keep the LONGEST label that round-trips (most specific,
    least likely to grab the wrong field), but the *field* is chosen by the prefer
    hint: LPP prints the vendor both as ``Supplier:`` and ``Agent:`` with the same
    value - without the hint we would lock onto the shorter ``Agent:`` label and
    capture the wrong party next time. A foreign brand tag in front of the field
    keyword (``LPP SA`` before ``Supplier:``) is trimmed away.
    """
    value = (value or '').strip()
    if not value:
        return ''
    pat_val = re.compile('(?<!\\S)' + re.escape(value) + '(?!\\S)')
    soft = soft - {value}
    nwords = len(value.split())

    combos: List[Tuple[int, int, int, str]] = []
    for oi, ln in enumerate(lines):
        m = pat_val.search(ln)
        if not m:
            continue
        prefix = ln[:m.start()].split()
        if not prefix:
            continue
        ptoks = _label_tokens(prefix, soft)
        if not ptoks:
            continue
        if nwords == 1:
            grp = '(\\S+)'
        elif m.end() >= len(ln.rstrip()):
            grp = '(.+)'
        else:
            grp = '(\\S+(?:\\s+\\S+){%d})' % (nwords - 1)
        for take in range(len(ptoks), 0, -1):
            ttk = ptoks[-take:]
            parts, has_literal = _generalize_prefix(ttk, soft)
            if not has_literal:
                continue
            take_lab = ' '.join(ttk)
            pref_rank = 0 if any(p.lower() in take_lab.lower() for p in prefer) else 1
            if pref_rank == 0 and prefer:
                ttk = _trim_to_keyword(ttk, prefer)
                parts, _ = _generalize_prefix(ttk, soft)
            anchor = '\\s+'.join(parts) + '\\s*' + grp
            try:
                mm = re.search(anchor, doc)
            except re.error:
                continue
            if mm and (mm.group(1) or '').strip() == value:
                combos.append((pref_rank, -take, oi, anchor))
                break
    if not combos:
        return ''
    combos.sort(key=lambda c: (c[0], c[1], c[2]))
    return combos[0][3]


def apply_header_anchors(recipe: PoRecipe, lines: Sequence[str], doc: str,
                         data: ExtractedData, log: Logger = None) -> List[str]:
    """Synthesize every header anchor we can; leave the rest at their defaults."""
    hdr = data.header or {}
    soft = {v.strip() for v in hdr.values() if v and v.strip()}
    soft |= {p for p in data.po_nos if p}
    soft |= {l.style for l in data.all_lines() if l.style}

    done: List[str] = []
    for key, attr in _HEADER_ANCHORS:
        val = (hdr.get(key) or '').strip()
        if not val and key == 'product_desc':
            val = (hdr.get('style_no') or '').strip()
        if not val:
            continue
        anchor = synthesize_field_anchor(
            lines,
            doc,
            val,
            soft,
            prefer=_FIELD_LABEL_HINTS.get(key, ()),
        )
        if anchor:
            setattr(recipe, attr, anchor)
            done.append(f'{key}={val!r}')
        elif log:
            log(f'    · 表头 {key}={val!r} 未能定位到标签，沿用默认锚点')

    for o in data.orders:
        for cand in _date_variants(o.delivery_date):
            anchor = synthesize_field_anchor(
                lines,
                doc,
                cand,
                soft,
                prefer=_FIELD_LABEL_HINTS.get('delivery_date', ()),
            )
            if anchor:
                recipe.delivery_anchor = anchor
                done.append(f'delivery={cand!r}')
                break
        if any(d.startswith('delivery=') for d in done):
            break

    pack = (hdr.get('packing_method') or '').strip()
    if pack:
        if pack.upper() == 'MULTIPACK':
            recipe.packing_anchor = 'MULTIPACK'
            recipe.packing_method = ''
        else:
            recipe.packing_method = pack
        done.append(f'packing={pack!r}')

    chans = [(o.channel or '').strip() for o in data.orders]
    nonblank = [c for c in chans if c]
    if nonblank and len(set(nonblank)) == 1:
        if len(nonblank) == len(chans):
            recipe.channel_value = nonblank[0]
            recipe.channel_anchor = ''
        else:
            recipe.channel_anchor = re.escape(nonblank[0])
            recipe.channel_value = ''
        done.append(f'channel={nonblank[0]!r}')

    return done


# ---------------------------------------------------------------------------
# 跨部分悬空符号（来自 PART 1 / models 等，仅供本文件独立可运行时占位；
# 正式整合时应改回 `from core.recipe_synth import ...` 并删除本节）。
# ---------------------------------------------------------------------------
# from core.recipe_synth import (           # noqa: E402  (悬空引用)
#     SynthesisError,                        # class SynthesisError(RuntimeError)
#     Sample,                                 # dataclass(el, line, tokens)
#     assign_roles,                           # (samples) -> (assigns, roles)
#     _is_numeric_token,                      # (tok) -> bool  即 _NUMERIC_TOKEN.match
#     _date_variants,                         # (iso) -> List[str]
# )
# from models import PoRecipe, LayoutType, PurchaseOrder
# from ai.data_extract import ExtractedData, ExtractedLine

Logger = Optional[Callable[[str], None]]


class SynthesisError(RuntimeError):
    """占位：原模块第 60 行定义（详见 PART 1）。"""


class Sample:  # 占位：原模块 @dataclass，字段 el / line / tokens
    el = None
    line: str = ''
    tokens: List[str] = []


def assign_roles(samples):  # 占位：PART 1 还原
    raise NotImplementedError('see rs_part1: assign_roles')


def _is_numeric_token(tok: str) -> bool:  # 占位：PART 1 还原
    return _NUMERIC_TOKEN.match(tok) is not None


def _date_variants(iso: str) -> List[str]:  # 占位：PART 1 还原
    raise NotImplementedError('see rs_part1: _date_variants')


class _ExtractedDataPlaceholder:  # 占位：ai.data_extract.ExtractedData
    header: Dict[str, str] = {}
    po_nos: Sequence[str] = ()
    orders: Sequence = ()
    all_lines = None


ExtractedData = _ExtractedDataPlaceholder
PoRecipe = object
