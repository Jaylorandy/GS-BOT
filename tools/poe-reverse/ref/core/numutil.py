"""core/numutil.py - shared numeric tolerance helpers.

Centralised so the synthesis gate (``recipe_synth``) and the breakdown validator
(``validate``) agree on exactly the same European-thousands ambiguity rule and
never drift apart.
"""

from __future__ import annotations


def thousands_match(a: int, b: int) -> bool:
    """True when ``a`` and ``b`` agree, allowing the European-thousands ambiguity.

    The printed TOTAL row "26.000" is 26000 pieces (dot = thousands separator),
    but the model or a stray read sometimes reports 26. The parser always reads
    26000 via its int coercion. When the two disagree by exactly 1000x we trust
    the DOCUMENT (the parser's figure) - a known, one-directional misread, not a
    real discrepancy.
    """
    if a == b:
        return True
    if not b:
        return False
    return a == b * 1000 or b == a * 1000
