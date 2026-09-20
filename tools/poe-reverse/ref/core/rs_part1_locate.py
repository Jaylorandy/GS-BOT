"""core/recipe_synth.py (PART 1) - locate & role-assign, internal reference
implementation, reverse-restored from the PyInstaller bytecode.

Original module docstring (core/recipe_synth.py) summary:
    Turn AI-read ORDER DATA into a VERIFIED, cacheable PoRecipe.  The AI only
    READS the PO (ExtractedData); this code SYNTHESIZES the extraction rule from
    the AI's verbatim sample rows, REPLAYS it offline and hard-compares against
    the AI's data.  Only a rule that reproduces the AI's reading exactly is
    allowed into the fingerprint cache.

This part covers: module exceptions/constants, numeric/date utilities, sample
location (locate_samples/_locate_one) and role assignment (assign_roles & co).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple

# from core.ai.data_extract import ExtractedData, ExtractedLine, extract_po_data
# from core.models import LayoutType, PoRecipe, PurchaseOrder
# from core.numutil import thousands_match as _thousands_match
# from core.parsers import registry
# from core.parsers.base import doc_text, merge_wrapped_rows

Logger = Optional[Callable[[str], None]]


class SynthesisError(RuntimeError):
    """No verified recipe could be produced. ``str(e)`` is user-facing.

    ``ai_hint`` (when set) is fed back to the model on the next attempt so it can
    self-correct instead of repeating the same mistake.
    """

    def __init__(self, message: str, ai_hint: str = "") -> None:
        super().__init__(message)
        self.ai_hint = ai_hint


class UnsupportedLayout(SynthesisError):
    """This layout cannot be handled by rule synthesis (matrix grids).

    The caller should fall back to the legacy ``core.ai.recipe_infer`` path.
    ``data`` carries the AI's already-read :class:`ExtractedData` so the caller
    can hand the known ``layout_type`` to the legacy path and skip a re-read.
    """

    def __init__(self, message: str, data=None, ai_hint: str = "") -> None:
        super().__init__(message, ai_hint=ai_hint)
        self.data = data


_NUMERIC_TOKEN = re.compile(r"^[\d.,]+$")
_HAS_DIGIT = re.compile(r"\d")
_APOSTROPHES = "'‘’‛`´ʼˮ"
_RATIO_BLOCK = re.compile(r"\b([A-Za-z]{1,4}:\d+)(?:\s*,\s*[A-Za-z]{1,4}:\d+)+")


def _is_numeric_token(tok: str) -> bool:
    return bool(_NUMERIC_TOKEN.match(tok or ""))


def _num(tok: str) -> Optional[float]:
    """Parse a printed number: 1,234 / 10,20 / 7,588.80 / 1.068 all handled."""
    s = re.sub(r"[^\d.,\-]", "", tok or "").strip()
    if not s or not _HAS_DIGIT.search(s):
        return None
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        tail = s.rsplit(",", 1)[1]
        s = s.replace(",", "." if len(tail) == 2 else "")
    try:
        return float(s)
    except ValueError:
        return None


def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _doc_lines(text: str) -> List[str]:
    out = []
    for ln in text.splitlines():
        ln = ln.strip()
        if ln:
            out.append(ln)
    return out


def _date_variants(iso: str) -> List[str]:
    """Renderings of a YYYY-MM-DD date that might appear in the document."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})$", (iso or "").strip())
    if not m:
        return [iso] if iso else []
    y, mo, d = m.group(1), m.group(2), m.group(3)
    return [
        f"{y}-{mo}-{d}",
        f"{d}.{mo}.{y}",
        f"{d}/{mo}/{y}",
        f"{d}-{mo}-{y}",
        f"{mo}/{d}/{y}",
        f"{y}/{mo}/{d}",
        f"{y}.{mo}.{d}",
        f"{int(d)}.{int(mo)}.{y}",
    ]


@dataclass
class Sample:
    """An AI-read order line paired with the REAL document line it came from."""
    el: "ExtractedLine"
    line: str
    tokens: List[str] = field(default_factory=list)


def locate_samples(lines: Sequence[str], data: "ExtractedData") -> Tuple[List[Sample], List["ExtractedLine"]]:
    """Pair every ``ExtractedLine`` with its real document line.

    The regex must be grown from the DOCUMENT's own text, never from the model's
    rendition of it - the model may drop a backtick or collapse a space. Returns
    ``(samples, unlocated)``.
    """
    norm_index: Dict[str, str] = {}
    for ln in lines:
        norm_index.setdefault(_norm_ws(ln), ln)

    samples: List[Sample] = []
    missing: List["ExtractedLine"] = []
    for el in data.all_lines():
        hit = _locate_one(lines, norm_index, el)
        if hit is None:
            missing.append(el)
            continue
        samples.append(Sample(el=el, line=hit, tokens=hit.split()))
    return samples, missing


def _locate_one(lines: Sequence[str], norm_index: Dict[str, str], el: "ExtractedLine") -> Optional[str]:
    raw = _norm_ws(el.raw_line or "")
    if raw and raw in norm_index:
        return norm_index[raw]

    loc = el.locator
    qty = int(el.qty or 0)
    best: Optional[str] = None
    best_score = -1
    want = set(raw.split()) if raw else set()
    for ln in lines:
        toks = ln.split()
        if loc and loc in toks:
            continue
        if not any(_is_numeric_token(t) and _num(t) == qty for t in toks):
            continue
        if el.unit and not any(t.upper() == el.unit.upper() for t in toks):
            continue
        if el.unit_price is not None and not any(
            _is_numeric_token(t) and _num(t) is not None and abs(_num(t) - el.unit_price) < 0.005
            for t in toks
        ):
            continue
        score = len(want & set(toks)) if want else len(toks)
        if score > best_score:
            best, best_score = ln, score
    if best is not None:
        return best

    # second pass: same search without the unit/unit_price corroborations
    best_score = -1
    best = None
    for ln in lines:
        toks = ln.split()
        if loc and loc in toks:
            continue
        if not any(_is_numeric_token(t) and _num(t) == qty for t in toks):
            continue
        score = len(want & set(toks)) if want else len(toks)
        if score > best_score:
            best, best_score = ln, score
    return best


_REQUIRED_ROLES = ("style", "unit", "qty", "unit_price")
_OPTIONAL_ROLES = ("color_code", "size")


def _role_hits(tokens: Sequence[str], el: "ExtractedLine", role: str) -> List[int]:
    out: List[int] = []
    for i, t in enumerate(tokens):
        if role == "style":
            if t == el.locator or (el.style and t == el.style):
                out.append(i)
        elif role == "unit":
            if el.unit and t.upper() == el.unit.upper():
                out.append(i)
        elif role == "qty":
            if _is_numeric_token(t) and _num(t) == float(el.qty):
                out.append(i)
        elif role == "unit_price":
            if (
                el.unit_price is not None
                and _is_numeric_token(t)
                and _num(t) is not None
                and abs(_num(t) - el.unit_price) < 0.005
            ):
                out.append(i)
        elif role == "color_code":
            if el.color_code and t == el.color_code:
                out.append(i)
        elif role == "size":
            if el.size and t == el.size:
                out.append(i)
    return out


def _all_assignments(cands: Dict[str, List[int]], roles: Sequence[str], cap: int = 400) -> List[Dict[str, int]]:
    """Every distinct-index role->position assignment (bounded)."""
    out = [{}]
    for r in roles:
        nxt = []
        for base in out:
            used = set(base.values())
            for i in cands[r]:
                if i in used:
                    continue
                d = dict(base)
                d[r] = i
                nxt.append(d)
                if len(nxt) >= cap:
                    break
            if len(nxt) >= cap:
                break
        if not nxt:
            return []
        out = nxt
    return out


def _order_sig(assign: Dict[str, int]) -> Tuple[str, ...]:
    return tuple(r for r, _ in sorted(assign.items(), key=lambda kv: kv[1]))


def assign_roles(samples: Sequence[Sample]) -> Tuple[List[Dict[str, int]], List[str]]:
    """Decide, consistently across all sample rows, which column is which field.

    A field is only used when it can be pinned down on EVERY row and the columns
    appear in the same left-to-right order everywhere - otherwise the synthesized
    pattern would be a coincidence rather than a rule.
    """
    if not samples:
        raise SynthesisError("没有可用的样例行，无法合成解析规则。")

    roles = list(_REQUIRED_ROLES)
    per_sample_c: List[Dict[str, List[int]]] = []
    for s in samples:
        per_sample_c.append({r: _role_hits(s.tokens, s.el, r) for r in _REQUIRED_ROLES + _OPTIONAL_ROLES})

    roles = [r for r in roles if all(c[r] for c in per_sample_c)]
    if "qty" not in roles:
        raise SynthesisError(
            "在文档原文里找不到 AI 报告的数量列——AI 读到的数字与 PDF 上的不一致。",
            ai_hint=(
                "For at least one line the quantity you reported does not appear as its own column on "
                "that row. Copy 'raw_line' verbatim and report 'qty' exactly as printed."
            ),
        )
    if "style" not in roles:
        raise SynthesisError(
            "在文档原文里找不到 AI 报告的款号/Index No. 列。",
            ai_hint=(
                "For at least one line the 'index_no'/'style' you reported does not appear as a token "
                "on that row. Copy it exactly as printed."
            ),
        )

    for r in _OPTIONAL_ROLES:
        if all(len(c[r]) == 1 for c in per_sample_c):
            roles.append(r)

    per_sample_a = [_all_assignments(c, roles) for c in per_sample_c]
    if any(not a for a in per_sample_a):
        raise SynthesisError("同一行里多个字段落在同一列上，无法区分。")

    common: Optional[Set[Tuple[str, ...]]] = None
    for alist in per_sample_a:
        sigs = {_order_sig(a) for a in alist}
        common = sigs if common is None else common & sigs
    if not common:
        raise SynthesisError(
            "各订单行的字段列顺序不一致，无法归纳出统一的行规则。",
            ai_hint=(
                "The rows you reported do not share one consistent column order. Re-read the table and "
                "report only rows that belong to the same order table."
            ),
        )

    def _cost(sig: Tuple[str, ...]) -> Tuple[int, Tuple[str, ...]]:
        total = 0
        for alist in per_sample_a:
            picks = [a for a in alist if _order_sig(a) == sig]
            total += min(sum(p.values()) for p in picks)
        return total, sig

    best_sig = min(common, key=_cost)

    chosen: List[Dict[str, int]] = []
    for alist in per_sample_a:
        picks = [a for a in alist if _order_sig(a) == best_sig]
        chosen.append(min(picks, key=lambda a: sum(a.values())))
    return chosen, roles
