# -*- coding: utf-8 -*-
"""Dump JSON metadata for the PART3 functions of recipe_synth."""
import json
import sys

with open("consts/core/recipe_synth.json", encoding="utf-8") as f:
    j = json.load(f)

want = [
    "synthesize_recipe", "is_control_sheet", "synthesize_control_sheet",
    "is_matrix_percarton", "synthesize_matrix_percarton", "is_line_items_eu",
    "is_costco_ecom", "is_costco_hybrid", "is_celio",
    "_synthesize_structural_recipe", "synthesize_line_items_eu",
    "synthesize_costco_hybrid", "synthesize_costco_ecom", "synthesize_celio",
    "is_frankie_ecom", "synthesize_frankie_ecom", "is_bass_pro_ack",
    "synthesize_bass_pro_ack", "is_import_po", "synthesize_import_po",
    "is_anf_commitment", "synthesize_anf_commitment", "is_anf_po",
    "synthesize_anf_po", "VerifyReport", "VerifyReport.text",
    "VerifyReport.ai_hint", "_amount_misread_rows", "_explains_amount_misread",
    "verify_recipe", "_rows_only_the_rule_found", "_short_json_err",
    "detect_structural_layout", "acquire_recipe", "acquire_recipe._log",
    "_make_page",
]

keys = sorted(j.keys())
for k in keys:
    if k == "<module>":
        continue
    if not any(w in k for w in want):
        continue
    print("=" * 24, k)
    e = j[k]
    print("names:", e.get("names"))
    print("varnames:", e.get("varnames"))
    for i, x in enumerate(e.get("consts", [])):
        s = repr(x)
        if len(s) > 220:
            s = s[:220] + "..."
        print("  [%d] %s" % (i, s))
    print("n_instr:", e.get("n_instructions"))
