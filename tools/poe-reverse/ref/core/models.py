"""core/models.py - Unified data contract for Purchase Order Extractor V2.

Design rule (hard requirement): NO customer name is ever hardcoded in code.
All sources (PDF / image, any customer or layout) are parsed into the same
``PurchaseOrder`` contract. Customer-specific differences live entirely in
``PoRecipe`` (JSON, cached per layout fingerprint) - never in an ``if customer``.

Data hierarchy
--------------
    PurchaseOrder                # one source document
      └─ OrderEntity[]           # one delivery entity inside a PO (a PO may have several)
           └─ OrderLine[]        # one color/style line, with a size breakdown
                └─ SizeQty[]     # a single size label + ordered quantity

Template B is a LONG table (28 columns A..AB, labels 照搬 V1.6.4): every
``SizeQty`` becomes its own row. The 7-segment ``_Row Key``
(Customer|PO|Style|ColorCode|Size|Inseam|Destination) is computed as a plain
string so openpyxl (which does not evaluate formulas) can dedupe idempotently.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field, asdict, fields
from enum import Enum
from typing import Dict, List, Optional

from core.winpath import excel_hyperlink_formula


class LayoutType(str, Enum):
    """The PO layouts the recipe engine supports."""
    MATRIX_2AXIS = 'matrix_2axis'
    MATRIX_1AXIS = 'matrix_1axis'
    LINE_ITEMS = 'line_items'
    CONTROL_SHEET = 'control_sheet'
    MATRIX_PERCARTON = 'matrix_percarton'
    LINE_ITEMS_EU = 'line_items_eu'
    COSTCO_HYBRID = 'costco_hybrid'
    COSTCO_ECOM = 'costco_ecom'
    CELIO = 'celio'
    FRANKIE_ECOM = 'frankie_ecom'
    BASS_PRO_ACK = 'bass_pro_ack'
    IMPORT_PO = 'import_po'
    ANF_PO = 'anf_po'
    ANF_COMMITMENT = 'anf_commitment'


@dataclass
class SizeQty:
    """A single size label and its ordered quantity."""
    size: str = ''
    qty: int = 0

    @property
    def qty_safe(self) -> int:
        try:
            return int(self.qty)
        except (TypeError, ValueError):
            return 0


@dataclass
class OrderLine:
    """One color (and style) line within an entity, with a size breakdown."""
    style_no: str = ''
    color_code: str = ''
    color_desc: str = ''
    inseam: str = ''
    sizes: List[SizeQty] = field(default_factory=list)
    unit_price: Optional[float] = None
    su: str = ''
    printed_row_total: Optional[int] = None
    net_amount: Optional[float] = None
    extra: Dict[str, str] = field(default_factory=dict)

    @property
    def total_qty(self) -> int:
        return sum(s.qty_safe for s in self.sizes)

    def size_labels(self) -> List[str]:
        return [s.size for s in self.sizes]


@dataclass
class OrderEntity:
    """One delivery entity inside a PO. A single PO may contain several entities
    (each with its own price / delivery date / destination / channel)."""
    entity_index: int = 0
    style_no: str = ''
    po_no: str = ''
    channel: str = ''
    delivery_date: str = ''
    destination_code: str = ''
    packing_method: str = ''
    wash_method: str = ''
    washing_color: str = ''
    payment_terms: str = ''
    price_term: str = ''
    currency: str = ''
    size_scale: str = ''
    product_group: str = ''
    age_sex_desc: str = ''
    product_desc: str = ''
    season: str = ''
    port_loading: str = ''
    port_discharge: str = ''
    ship_mode: str = ''
    vendor_name: str = ''
    agent_name: str = ''
    import_po_no: str = ''
    reference_no: str = ''
    cir_no: str = ''
    freight_terms: str = ''
    country_of_origin: str = ''
    dc_address: str = ''
    lines: List[OrderLine] = field(default_factory=list)
    printed_size_totals: Dict[str, int] = field(default_factory=dict)
    printed_total_qty: Optional[int] = None
    printed_total_amount: Optional[float] = None
    extra: Dict[str, str] = field(default_factory=dict)

    @property
    def total_qty(self) -> int:
        return sum(ln.total_qty for ln in self.lines)


@dataclass
class PurchaseOrder:
    """Top-level document result. Source-agnostic; all 4 PDF types map here."""
    customer: str = ''
    source_file: str = ''
    source_file_path: str = ''
    order_date: str = ''
    per_destination: bool = False
    entities: List[OrderEntity] = field(default_factory=list)
    validation_warnings: List[dict] = field(default_factory=list)
    fingerprint: str = ''

    def template_b_rows(self, po_version: int = 1, is_current: str = 'Y', import_batch: str = '') -> List[Dict[str, object]]:
        """Flatten into the 27-column Template B schema (columns A..AA).

        V2.0.5 起对齐 V1.6.4 的栏位规范（栏位 label 全部照搬 1.6.4）：相对旧的
        35 列（A..AI）硬删除了 7 列 —— Channel / Size Scale / Age-Sex Desc /
        Product Desc / Wash Method / Washing Color / Packing Method —— V2.0.19.x
        再删 5 列 —— Product Group / Vendor Name / Agent Name / Freight Terms /
        DC Address —— 余 21 列内容 + 6 列 meta = 27 列（A..AA）。V2.0.19.12 起追
        加 AA(_Fingerprint) 元数据列供 OSR 回灌学习精确 join。

        Returns dicts keyed by column LETTER (A..AA). Column L (Net Amt) is
        left as None - the writer fills the live formula ``=I*K``.
        """
        out = []
        for ent in self.entities:
            for ln in ent.lines:
                for sq in ln.sizes:
                    rk = build_row_key(customer=self.customer, po_no=ent.po_no, style=ln.style_no, color_code=ln.color_code, size=sq.size, inseam=ln.inseam, destination=ent.destination_code)
                    out.append({
                        'A': self.customer,
                        'B': ln.style_no,
                        'C': ent.po_no,
                        'D': ent.season,
                        'E': ln.color_code,
                        'F': ln.color_desc,
                        'G': sq.size,
                        'H': ln.inseam,
                        'I': sq.qty_safe,
                        'J': ln.su,
                        'K': ln.unit_price if ln.unit_price is not None else '',
                        'L': None,
                        'M': ent.price_term,
                        'N': ent.currency,
                        'O': ent.delivery_date,
                        'P': ent.port_loading,
                        'Q': ent.port_discharge,
                        **{
                            'R': ent.ship_mode,
                            'S': ent.destination_code,
                            'T': ent.payment_terms,
                            'U': ent.country_of_origin,
                            'V': rk,
                            'W': po_version,
                            'X': is_current,
                            'Y': excel_hyperlink_formula(
                                self.source_file_path or self.source_file,
                                os.path.basename(self.source_file) if self.source_file else os.path.basename(self.source_file_path),
                            ) if self.source_file_path or self.source_file else '',
                            'Z': import_batch,
                            'AA': self.fingerprint or '',
                        },
                    })
        return out

    @property
    def total_qty(self) -> int:
        return sum(ent.total_qty for ent in self.entities)

    def size_totals(self) -> Dict[str, int]:
        out = {}
        for ent in self.entities:
            for ln in ent.lines:
                for sq in ln.sizes:
                    out[sq.size] = out.get(sq.size, 0) + sq.qty_safe
        return out

    def color_totals(self) -> Dict[str, int]:
        out = {}
        for ent in self.entities:
            for ln in ent.lines:
                out[ln.color_code] = out.get(ln.color_code, 0) + ln.total_qty
        return out

    def apply_recipe_overrides(self, overrides: Dict[str, str]) -> None:
        """Apply user-confirmed field overrides from the recipe confirm dialog.

        Header-level overrides (po_no, season, ...) are applied to every entity;
        line-level overrides (style_no, unit_price, su) are applied to every line.
        The ``su`` default (e.g. "PCS") persisted from the confirm dialog is
        propagated to every OrderLine so empty units do not keep reappearing.
        This guarantees that what the user typed in the confirm box is exactly
        what appears in the exported Excel, even when the synthesized anchor
        would otherwise capture the whole surrounding line.
        """
        if not overrides:
            return None
        color_edits = overrides.get('color_edits')
        if isinstance(color_edits, str) and color_edits:
            try:
                color_map = json.loads(color_edits)
            except Exception:
                color_map = None
        if isinstance(color_map, dict):
            for ent in self.entities:
                for ln in ent.lines:
                    combined = self._color_combined(ln.color_code, ln.color_desc)
                    new = color_map.get(combined)
                    if new:
                        if ' / ' in new:
                            c, dd = new.split(' / ', 1)
                            ln.color_code, ln.color_desc = c.strip(), dd.strip()
                        else:
                            ln.color_desc = new.strip()
                            ln.color_code = ''
        entity_fields = {
            'channel', 'cir_no', 'price_term', 'vendor_name', 'port_discharge',
            'currency', 'size_scale', 'product_group', 'season',
            'country_of_origin', 'reference_no', 'import_po_no', 'age_sex_desc',
            'port_loading', 'packing_method', 'agent_name', 'payment_terms',
            'freight_terms', 'style_no', 'destination_code', 'delivery_date',
            'ship_mode', 'dc_address', 'wash_method', 'washing_color',
            'product_desc', 'po_no',
        }
        ent_overrides = overrides.get('__ent_overrides__') or {}
        line_overrides = overrides.get('__line_overrides__') or {}
        for ent in self.entities:
            for k, v in overrides.items():
                if k.startswith('__'):
                    continue
                if k == 'customer':
                    self.customer = v
                    continue
                if k in entity_fields:
                    setattr(ent, k, v)
                    if k == 'style_no':
                        _style_no_reach_needle = 'style_no_default_reaches_every_OrderLine'
                        for ln in ent.lines:
                            ln.style_no = v
                    continue
                if k == 'unit_price':
                    price = None
                    try:
                        price = float(v.replace(',', ''))
                    except (TypeError, ValueError):
                        pass
                    for ln in ent.lines:
                        ln.unit_price = price
                    continue
                if k == 'su':
                    for ln in ent.lines:
                        ln.su = v
                    continue
        if ent_overrides:
            for idx_str, fields in ent_overrides.items():
                try:
                    idx = int(idx_str)
                except (TypeError, ValueError):
                    continue
                if 0 <= idx < len(self.entities):
                    e = self.entities[idx]
                    for fk, fv in (fields or {}).items():
                        if fk in entity_fields or fk == 'po_no':
                            old = getattr(e, fk, '')
                            setattr(e, fk, fv)
                            if fk == 'style_no' and old != fv:
                                print(f'[override] entity {idx} style_no: {old!r} -> {fv!r}')
                            if fk == 'style_no':
                                for ln in e.lines:
                                    ln.style_no = fv
        if line_overrides:
            for ent in self.entities:
                for ln in ent.lines:
                    key = self._color_combined(ln.color_code, ln.color_desc)
                    ins = (ln.inseam or '').strip()
                    cands = [key, ln.color_code]
                    if ins:
                        cands.append(f'{key}␟{ins}')
                    ov = None
                    for c in cands:
                        ov = line_overrides.get(c)
                        if isinstance(ov, dict):
                            break
                    if not isinstance(ov, dict):
                        continue
                    price = ov.get('unit_price')
                    if price in (None, ''):
                        try:
                            ln.unit_price = float(str(price).replace(',', ''))
                        except (TypeError, ValueError):
                            pass
                    if ov.get('inseam') is not None:
                        ln.inseam = ov['inseam']
                    if ov.get('su') is not None:
                        ln.su = ov['su']
                    sizes = ov.get('sizes')
                    if isinstance(sizes, dict):
                        for sq in ln.sizes:
                            if sq.size in sizes:
                                try:
                                    sq.qty = max(0, int(float(str(sizes[sq.size]).replace(',', ''))))
                                except (TypeError, ValueError):
                                    pass
                    if ov.get('style_no') in (None, ''):
                        ln.style_no = ov['style_no']

    def apply_field_defaults(self, recipe: 'PoRecipe') -> list:
        """Apply persisted, layout-scoped field defaults (cross-PO propagation).

        Unlike :meth:`apply_recipe_overrides` (which is current-file-only and is
        stripped before caching), these defaults live on the recipe and are
        applied to EVERY extraction of this fingerprint, so a correction made in
        the confirm dialog reaches all sister POs — not just the one edited. Uses
        the same field mapping as ``apply_recipe_overrides``.

        Returns a list of human-readable change strings (e.g.
        ``"H1·destination_code: '' → 'EG.CL.R' (默认)"``) for logging; empty list
        means nothing was altered.
        """
        if not recipe:
            return []
        before = self._cleanable_pairs()
        defaults = getattr(recipe, 'field_defaults', None) or {}
        if defaults:
            self.apply_recipe_overrides(defaults)
        after = self._cleanable_pairs()
        bmap = dict(before)
        changes = []
        for label, new in after.items():
            old = bmap.get(label, '')
            if old != new:
                o = old if len(old) <= 28 else old[:25] + '…'
                n = new if len(new) <= 28 else new[:25] + '…'
                changes.append(f'{label}: {o!r} → {n!r} (默认)')
        return changes

    def apply_value_clean(self, recipe: 'PoRecipe') -> list:
        """Apply user-confirmed cleanup rules from the recipe.

        Called by ``parse_doc`` for EVERY extraction (cached or not), so a
        correction made in the confirm dialog propagates to all later POs of the
        same layout. ``recipe.cleans`` is a dict of field-name -> list of
        {"pat", "repl"} rules; the key ``"color"`` targets the combined
        "CODE / DESC" string of every line. Rules CHAIN in order (idempotent),
        so multiple corrections accumulate instead of overwriting (whack-a-mole).

        Returns a list of human-readable change strings (e.g.
        ``"L1-1·款式: '014KK-08X-XS' → '014KK'"``) for logging/observability;
        empty list means nothing was altered.
        """
        if not recipe:
            return []
        before = self._cleanable_pairs()
        cleans = getattr(recipe, 'cleans', None) or {}
        for field_name, rules in cleans.items():
            if not isinstance(rules, list):
                continue
            for spec in rules:
                if not isinstance(spec, dict):
                    continue
                pat = spec.get('pat') or ''
                repl = spec.get('repl', '')
                if not pat:
                    continue
                if field_name == 'color':
                    self._clean_color(pat, repl)
                else:
                    self._clean_field(field_name, pat, repl)
        after = self._cleanable_pairs()
        bmap = dict(before)
        changes = []
        for label, new in after.items():
            old = bmap.get(label, '')
            if old != new:
                o = old if len(old) <= 28 else old[:25] + '…'
                n = new if len(new) <= 28 else new[:25] + '…'
                changes.append(f'{label}: {o!r} → {n!r}')
        return changes

    def _cleanable_pairs(self) -> list:
        """Snapshot of all (label, value) strings affected by value/color_clean.

        Used by :meth:`apply_value_clean` to compute a readable diff of what was
        changed so the log can show the user that a correction took effect.
        """
        pairs = []
        for ei, ent in enumerate(self.entities):
            for k in ('po_no', 'season', 'currency', 'price_term', 'payment_terms', 'port_loading', 'port_discharge', 'ship_mode', 'vendor_name', 'agent_name', 'channel', 'size_scale', 'product_group', 'age_sex_desc', 'product_desc', 'destination_code', 'wash_method', 'washing_color', 'packing_method', 'delivery_date', 'import_po_no', 'reference_no', 'cir_no', 'freight_terms', 'country_of_origin', 'dc_address'):
                pairs.append((f'H{ei+1}·{k}', getattr(ent, k) or ''))
            pairs.append((f'H{ei+1}·customer', self.customer or ''))
            for li, ln in enumerate(ent.lines):
                pairs.append((f'L{ei+1}-{li+1}·款式', ln.style_no or ''))
                pairs.append((f'L{ei+1}-{li+1}·颜色', self._color_combined(ln.color_code, ln.color_desc)))
        return pairs

    @staticmethod
    def _color_combined(code: str, desc: str) -> str:
        return ' / '.join(filter(None, [code or '', desc or '']))

    def _clean_field(self, field_name: str, pat: str, repl: str) -> None:
        try:
            rx = re.compile(pat)
        except re.error:
            return None
        entity_fields = {
            'channel', 'cir_no', 'price_term', 'vendor_name', 'port_discharge',
            'currency', 'size_scale', 'product_group', 'season',
            'country_of_origin', 'reference_no', 'import_po_no', 'age_sex_desc',
            'port_loading', 'packing_method', 'agent_name', 'payment_terms',
            'freight_terms', 'style_no', 'destination_code', 'delivery_date',
            'ship_mode', 'dc_address', 'wash_method', 'washing_color',
            'product_desc', 'po_no',
        }
        for ent in self.entities:
            if field_name == 'customer':
                self.customer = rx.sub(repl, self.customer or '')
            elif field_name in entity_fields:
                setattr(ent, field_name, rx.sub(repl, getattr(ent, field_name) or ''))
            elif field_name == 'style_no':
                for ln in ent.lines:
                    ln.style_no = rx.sub(repl, ln.style_no or '')

    def _clean_color(self, pat: str, repl: str) -> None:
        try:
            rx = re.compile(pat)
        except re.error:
            return None
        for ent in self.entities:
            for ln in ent.lines:
                combined = self._color_combined(ln.color_code, ln.color_desc)
                new = rx.sub(repl, combined)
                if ' / ' in new:
                    c, d = new.split(' / ', 1)
                    ln.color_code, ln.color_desc = c.strip(), d.strip()
                elif (ln.color_desc or '').strip():
                    ln.color_desc = new.strip()
                    ln.color_code = ''
                else:
                    ln.color_code = new.strip()
                    ln.color_desc = ''


def build_row_key(customer: str, po_no: str, style: str, color_code: str, size: str, inseam: str, destination: str) -> str:
    """7-segment Template B dedup key (column AA, _Row Key):

        Customer | PO | Style | ColorCode | Size | Inseam | Destination

    V2.0.5：随 28 列改造去掉了第 8 段 PackingMethod —— Packing Method 栏位已从
    表中删除，若仍保留在行键里，两行在表面上完全相同却因不可见字段不同而生成
    不同的键，会被去重逻辑当成两条新行重复追加。行键只应由表内可见的定位列组成。
    """
    return '|'.join([customer or '', po_no or '', style or '', color_code or '', size or '', inseam or '', destination or ''])


@dataclass
class PoRecipe:
    """The extraction recipe. Every customer- or layout-specific difference lives
    here as data, never as ``if COLIN'S:`` in code. JSON-serializable; cached per
    layout fingerprint so the FIRST PO of a customer uses AI + manual confirm, and
    every later PO of the same layout is extracted zero-AI.

    layout_type drives which parser consumes the recipe:
        matrix_2axis / matrix_1axis -> grid parsers
        line_items                  -> row parser
    """
    fingerprint: str = ''
    customer: str = ''
    layout_type: str = LayoutType.MATRIX_2AXIS.value
    version: str = '1'
    note: str = ''
    po_no_anchor: str = 'ORDER NO[.\\s:]+(\\S+)'
    customer_anchor: str = '^(.*?)\\s+Purchase Order'
    season_anchor: str = 'Season:\\s*(\\S+)'
    delivery_anchor: str = 'Shipment date:\\s*(\\S+)'
    currency_anchor: str = 'Currency:\\s*(\\S+)'
    price_term_anchor: str = 'Terms of payment:\\s*(.+)'
    style_anchor: str = '(?:Model\\s+No\\.|STYLE\\s+NO)[\\s.]*[:.]?\\s*(\\S+)'
    price_anchor: str = 'UNIT PR[İI]CE\\S*:\\s*([\\d.,]+)'
    packing_anchor: str = 'MULTIPACK'
    packing_method: str = ''
    port_discharge_anchor: str = 'Port of discharge:\\s*(\\S+)'
    port_loading_anchor: str = '(?:Port of loading|Loading port|Place of receipt)[.\\s:]+(\\S+(?:\\s+\\S+)?)'
    ship_mode_anchor: str = 'Transport Type:\\s*(\\S+)'
    agent_anchor: str = 'Agent:\\s*(.+)'
    vendor_anchor: str = 'Supplier:\\s*(.+)'
    payment_terms_anchor: str = ''
    import_po_no_anchor: str = 'Import\\s*PO\\s*(?:#|No|Number)?[.\\s:]+(\\S+)'
    reference_no_anchor: str = 'Reference\\s*(?:#|No)?[.\\s:]+(\\S+)'
    cir_no_anchor: str = 'CIR\\s*(?:#|No)?[.\\s:]+(\\S+)'
    freight_terms_anchor: str = 'Freight\\s*Terms?[.\\s:]+(\\S+(?:\\s+\\S+)?)'
    country_of_origin_anchor: str = '(?:Country\\s*of\\s*Origin|Origin\\s*Country|Exiting\\s*Country)[.\\s:]+(\\S+)'
    dc_address_anchor: str = '(?:DC\\s*Address|Distribution\\s*Center|Deliver\\s*to)[.\\s:]+(\\S.+)'
    channel_anchor: str = 'E-COMM'
    channel_value: str = ''
    entity_anchor: str = 'Entity\\s+\\d+\\s+Order No:\\s*(\\S+)(?:\\s+(E-COMM))?'
    destination_anchor: str = 'Destination Code:(\\S+)'
    section_anchor: str = ''
    section_delim_pattern: str = '^(DESTINATION|PACKAGING|COLOR) DETAILS$'
    line_pattern: str = ''
    order_unit: str = 'PCS'
    color_anchor: str = 'COLOR NO\\s*:\\s*(\\S+)\\s+(.+)'
    has_inseam: bool = False
    size_header_token: str = 'COLOR NO'
    total_token: str = 'TOTAL'
    grid_orientation: str = 'rows'
    size_header_anchor: str = ''
    color_code_pattern: str = ''
    require_row_total: bool = False
    breakdown_anchor: str = ''
    summary_anchor: str = ''
    line_field_map: Dict[str, str] = field(default_factory=dict)
    field_map: Dict[str, str] = field(default_factory=dict)
    has_color_total: bool = False
    has_size_total: bool = False
    size_encoding: str = ''
    dedup_style_size: bool = False
    field_overrides: Dict[str, str] = field(default_factory=dict)
    field_defaults: Dict[str, str] = field(default_factory=dict)
    cleans: Dict[str, List[Dict[str, str]]] = field(default_factory=dict)
    color_vocab: Dict[str, str] = field(default_factory=dict)
    validators: Dict[str, List[Dict[str, str]]] = field(default_factory=dict)
    date_format: str = ''
    date_dayfirst: bool = False

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)

    @classmethod
    def from_json(cls, s: str) -> 'PoRecipe':
        d = json.loads(s)
        known = {f.name for f in fields(cls)}
        cleans = dict(d.get('cleans') or {})
        vc = d.get('value_clean')
        if isinstance(vc, dict):
            for f_name, spec in vc.items():
                if isinstance(spec, dict) and spec.get('pat'):
                    cleans.setdefault(f_name, []).append({
                        'pat': spec.get('pat', ''),
                        'repl': spec.get('repl', ''),
                    })
        cc = d.get('color_clean')
        if isinstance(cc, dict) and cc.get('pat'):
            cleans.setdefault('color', []).append({
                'pat': cc.get('pat', ''),
                'repl': cc.get('repl', ''),
            })
        kwargs = {k: v for k, v in d.items() if k in known}
        kwargs['cleans'] = cleans
        if 'field_defaults' in kwargs:
            kwargs['field_defaults'] = {}
        return cls(**kwargs)


if __name__ == '__main__':
    po = PurchaseOrder(
        customer='LPP SA',
        source_file='PO_637JO_2627182_2026-01-15.pdf',
        entities=[
            OrderEntity(
                entity_index=0,
                po_no='11321589',
                channel='STANDARD',
                season='SS26',
                delivery_date='2026-03-02',
                destination_code='',
                packing_method='MULTIPACK',
                price_term='FOB',
                currency='USD',
                size_scale='ALPHA',
                product_group='C_trousers',
                age_sex_desc='MENS',
                product_desc="MEN'S TROUSERS",
                port_loading='Sihanoukville',
                port_discharge='Gdynia',
                ship_mode='Sea',
                vendor_name='Gs Global Sourcing Co.,Ltd',
                payment_terms='TT HSBC 180 Days',
                lines=[
                    OrderLine(
                        style_no='637JO',
                        color_code='80X',
                        color_desc='BEIGE',
                        inseam='',
                        su='PCS',
                        unit_price=10.2,
                        sizes=[SizeQty('S', 744)],
                    ),
                ],
            ),
        ],
    )
    rows = po.template_b_rows()
    assert len(rows) == 1, rows
    r = rows[0]
    assert r['A'] == 'LPP SA'
    assert r['E'] == '80X'
    assert r['C'] == '11321589'
    expected_key = 'LPP SA|11321589|637JO|80X|S||'
    assert r['AA'] == expected_key, r['AA']
    print('OK rows:', len(rows))
    print('Row Key:', r['AA'])
    print('Color Code:', r['E'], '| Price Term:', r['M'], '| Net Amt formula at L (writer fills =I*K):', r['L'])

    rec = PoRecipe(customer='LPP SA', layout_type=LayoutType.MATRIX_2AXIS.value, fingerprint='deadbeef', channel_value='STANDARD')
    rec2 = PoRecipe.from_json(rec.to_json())
    assert rec2.customer == rec.customer and rec2.layout_type == rec.layout_type
    print('Recipe round-trip OK ->', rec2.to_json().splitlines()[0])
