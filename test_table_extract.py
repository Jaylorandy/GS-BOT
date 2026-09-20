import fitz
import json
import sys
from collections import defaultdict
from pathlib import Path

def extract_po_tables(pdf_path):
    """Extract all PO size tables from PDF using coordinate-based analysis."""
    doc = fitz.open(pdf_path)
    all_tables = []
    size_labels_expected = {'30', '31', '32', '33', '34', '36', '38'}

    for page_idx in range(doc.page_count):
        page = doc[page_idx]
        words = page.get_text('words')
        if not words:
            continue

        # Find all groups of size labels
        size_words = [w for w in words if w[4].strip() in size_labels_expected]
        if len(size_words) < 3:
            continue

        # Group by y-coordinate
        y_groups = defaultdict(list)
        for w in size_words:
            y_key = round(w[1], -1)  # group by 10-pixel bands
            y_groups[y_key].append(w)

        # Find groups with at least 3 size labels
        for header_y, header_group in y_groups.items():
            if len(header_group) < 3:
                continue

            header_sorted = sorted(header_group, key=lambda w: w[0])
            size_labels_with_x = [(w[4].strip(), (w[0] + w[2]) / 2) for w in header_sorted]

            # Find x-ranges for each size column
            col_x_ranges = []
            for i, (label, center_x) in enumerate(size_labels_with_x):
                if i == 0:
                    left_x = center_x - (size_labels_with_x[i+1][1] - center_x) / 2 if i+1 < len(size_labels_with_x) else center_x - 20
                else:
                    left_x = (size_labels_with_x[i-1][1] + center_x) / 2
                if i == len(size_labels_with_x) - 1:
                    right_x = center_x + (center_x - size_labels_with_x[i-1][1]) / 2 if i > 0 else center_x + 20
                else:
                    right_x = (center_x + size_labels_with_x[i+1][1]) / 2
                col_x_ranges.append((label, left_x, right_x))

            # Extract context info above header (color, destination, etc.)
            context = extract_page_context(page, header_y)

            # Find data rows below header
            # Group words by y-coordinate bands
            row_groups = defaultdict(list)
            header_bottom = max(w[3] for w in header_group)
            for w in words:
                if w[1] > header_bottom + 5:
                    y_key = round(w[1], -1)
                    row_groups[y_key].append(w)

            data_rows = []
            for y_key in sorted(row_groups.keys()):
                row_words = sorted(row_groups[y_key], key=lambda w: w[0])
                if not row_words:
                    continue

                # First token should be INSEAM (numeric)
                first_text = row_words[0][4].strip()
                if not first_text.isdigit():
                    # Check if it's a TOTAL row
                    if 'total' in first_text.lower():
                        continue
                    continue

                inseam_val = first_text
                sizes_dict = {}
                total_val = None

                for w in row_words[1:]:
                    text = w[4].strip()
                    if not text.isdigit():
                        continue
                    center_x = (w[0] + w[2]) / 2
                    num_val = int(text)

                    # Check if it matches a size column
                    matched = False
                    for label, left_x, right_x in col_x_ranges:
                        if left_x <= center_x <= right_x:
                            sizes_dict[label] = num_val
                            matched = True
                            break

                    # If not matched and it's the rightmost value, it's probably TOTAL
                    if not matched:
                        if total_val is None:
                            total_val = num_val

                if sizes_dict:
                    data_rows.append({
                        'inseam': inseam_val,
                        'sizes': sizes_dict,
                        'total': total_val,
                    })

            if data_rows:
                table_info = {
                    'page': page_idx + 1,
                    'headerY': header_y,
                    'sizeLabels': [s[0] for s in size_labels_with_x],
                    'dataRows': data_rows,
                }
                table_info.update(context)
                all_tables.append(table_info)

    doc.close()
    return all_tables


def extract_page_context(page, header_y):
    """Extract color, destination etc. from above the table header."""
    context = {'color': None, 'colorCode': None, 'destinationCode': None, 'assortmentCode': None}
    words = page.get_text('words')

    for w in words:
        if w[1] >= header_y - 5:
            continue
        text = w[4].strip().upper()

        # Color detection
        if text == 'COLOR:' or text == 'COLOR':
            # Next word might be the color
            pass

    # Use text blocks for better context extraction
    blocks = page.get_text('blocks') or []
    for block in blocks:
        if len(block) < 5:
            continue
        x0, y0, x1, y1, block_text = block[:5]
        if y1 > header_y:
            continue
        lines = [l.strip() for l in block_text.split('\n') if l.strip()]
        for line in lines:
            upper = line.upper()
            if 'COLOR NO:' in upper or 'COLOR NO:' in line:
                idx = upper.find('COLOR NO:')
                rest = line[idx + len('COLOR NO:'):].strip()
                context['colorCode'] = rest.split()[0] if rest.split() else None
            elif upper.startswith('COLOR:') or line.startswith('COLOR:'):
                rest = line[len('COLOR:'):].strip()
                context['color'] = rest.split()[0] if rest.split() else None
            elif 'DESTINATION CODE:' in upper:
                idx = upper.find('DESTINATION CODE:')
                rest = line[idx + len('DESTINATION CODE:'):].strip()
                context['destinationCode'] = rest.split()[0] if rest.split() else None
            elif 'ASSORTMENT CODE:' in upper:
                idx = upper.find('ASSORTMENT CODE:')
                rest = line[idx + len('ASSORTMENT CODE:'):].strip()
                context['assortmentCode'] = rest.split()[0] if rest.split() else None

    return context


if __name__ == '__main__':
    pdf_path = sys.argv[1] if len(sys.argv) > 1 else '/Users/jaylorandy/Desktop/PO/SS27_PO10153623_1049750_CL1049750_Q1.V1_BEIGE_GTIG.pdf'
    tables = extract_po_tables(pdf_path)
    print(f'Found {len(tables)} tables')
    for i, t in enumerate(tables):
        print(f'\nTable {i} (page {t["page"]}):')
        print(f'  color={t.get("color")}, colorCode={t.get("colorCode")}')
        print(f'  destinationCode={t.get("destinationCode")}, assortmentCode={t.get("assortmentCode")}')
        print(f'  sizeLabels={t["sizeLabels"]}')
        print(f'  {len(t["dataRows"])} data rows:')
        for r in t['dataRows']:
            print(f'    inseam={r["inseam"]}, sizes={r["sizes"]}, total={r["total"]}')
            # Verify total
            calc_total = sum(r['sizes'].values())
            if r['total'] and calc_total != r['total']:
                print(f'      ⚠️  CALCULATED TOTAL={calc_total} vs REPORTED={r["total"]}')
