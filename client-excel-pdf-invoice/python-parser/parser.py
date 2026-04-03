"""
InvoiceVault PDF Parser Microservice
Parses Greenbank Wholesale invoices using coordinate-based column detection
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import pdfplumber
import re
import io
import os

app = Flask(__name__)
CORS(app)

PORT = int(os.environ.get('PORT', 5001))


def clean_amount(s):
    """Strip $, spaces, commas and return float"""
    if not s: 
        return 0.0
    cleaned = re.sub(r'[$\s,]', '', str(s))
    try:
        return float(cleaned)
    except:
        return 0.0


def parse_gb_date(raw):
    """Parse DD/MM/YYYY or D/M/YYYY → YYYY-MM-DD"""
    if not raw:
        return None
    m = re.match(r'^(\d{1,2})[/\-\.](\d{1,2})[/\-\.](\d{4})$', raw.strip())
    if m:
        day, mo, yr = m.group(1).zfill(2), m.group(2).zfill(2), m.group(3)
        return f"{yr}-{mo}-{day}"
    return None


def get_sheet_name(year, month):
    """Return correct Excel sheet name"""
    y = int(year) if year else 2025
    m = int(month) if month else 1
    if y <= 2024:
        return str(y)
    half = 'JAN-JUN' if m <= 6 else 'JUL-DEC'
    return f"{y} ( {half} )"


def categorize(desc):
    if not desc:
        return 'General'
    d = desc.upper()
    if 'DEF' in d or 'DIESEL EXHAUST' in d:
        return 'DEF'
    if 'WASHER FLUID' in d or 'WASHER FLD' in d:
        return 'Washer Fluid'
    if 'ANTIFREEZE' in d:
        return 'Antifreeze'
    if any(x in d for x in ['MOBIL', 'CASTROL', 'EAGLE', 'HAVOLINE', 'PANTHER']):
        return 'Motor Oil'
    if 'OIL' in d and 'MOTOR' not in d and 'DIESEL' not in d:
        return 'Motor Oil'
    if any(x in d for x in ['GAS CAN', 'DIESEL CAN', 'SCEPTER', 'JERRY CAN']):
        return 'Gas Cans'
    if any(x in d for x in ['SALT', 'DE-IC', 'MELT', 'ROAD SALT']):
        return 'De-Icing'
    if any(x in d for x in ['WATER', 'SPRING', 'ICE RIVER', 'NAYA', 'ESKA']):
        return 'Water'
    if any(x in d for x in ['STP', 'BRAKE', 'CLEANER', 'ATF', 'PSF', 'SEAFOAM']):
        return 'Additives'
    return 'General'


def extract_bill_to(text):
    """
    Extract SOLD TO field from GB Wholesale invoice.
    Format: STORE NAME, STREET ADDRESS, CITY, ON POSTAL_CODE
    Examples from reference:
      - ULTRAMAR, CAVAN
      - ESSO, GOODWOOD
      - TRI-FALCON ENT. LTD, ESSO, 6968 HWY 9, SCHOMBERG, ON L0G 1T0
      - 7802307 CANADA CORP., 28332 HIGHWAY 48, GEROGINA ON L0E 1N0
    """
    lines = text.split('\n')

    # These lines signal we've gone past the Bill To section
    hard_stops = [
        'QUANTITY', 'UNIT PRICE', 'AMOUNT', 'SUBTOTAL',
        'HST NO', 'www.', 'E-Transfer', 'Cheques made',
        'E-Transfers', 'THANK YOU', 'DELIVERY FEE'
    ]

    for i, line in enumerate(lines):
        if not re.search(r'bill\s+to\s*:', line, re.I):
            continue

        # Get everything after "Bill To :"
        after = re.sub(r'bill\s+to\s*:', '', line, flags=re.I).strip()

        # Strip right-column data (INVOICE # date etc that appears on same line)
        # These are separated by 4+ spaces
        after = re.split(r'\s{4,}', after)[0].strip()

        parts = [after] if after and len(after) > 1 else []

        # Collect address continuation lines
        for j in range(i + 1, min(i + 5, len(lines))):
            raw = lines[j]
            l = raw.strip()

            if not l:
                break

            # Hard stop — we hit the item table or footer
            if any(sw.upper() in l.upper() for sw in hard_stops):
                break

            # Stop if this looks like a line item row
            # (starts with number, then many spaces, then description)
            if re.match(r'^\d+\s{3,}\S', l):
                break

            # Stop if this is just a standalone date
            if re.match(r'^\d{1,2}[/\-]\d{1,2}[/\-]\d{4}\s*$', l):
                break

            # Strip right-column data (invoice #, dates etc on same line as address)
            left = re.split(r'\s{4,}', l)[0].strip()

            # Skip if it looks like header/footer content
            if re.search(r'invoice\s*#|hst\s*no|647-|416-|www\.|\.ca|\.com', left, re.I):
                continue

            if left and len(left) > 1:
                parts.append(left)

        if not parts:
            continue

        # Smart join: combine parts with comma separator
        # but don't double-up commas
        result = parts[0]
        for p in parts[1:]:
            prev = result.rstrip()
            if prev.endswith(','):
                result = prev + ' ' + p
            else:
                result = prev + ', ' + p

        # Final cleanup
        result = re.sub(r',\s*,+', ',', result)   # collapse double commas
        result = re.sub(r'\s+', ' ', result)        # collapse spaces
        result = result.strip().rstrip(',').strip()

        return result if len(result) > 2 else None

    return None


def extract_line_items_coordinate(page):
    """
    Core parser: uses word X/Y coordinates to detect columns.
    Finds QUANTITY|DESCRIPTION|UNIT PRICE|AMOUNT header,
    measures column boundaries, assigns each word to correct column.
    """
    words = page.extract_words(x_tolerance=3, y_tolerance=3)
    if not words:
        return []

    # Group words into rows by Y coordinate (3pt tolerance)
    rows = {}
    for w in words:
        y = round(w['top'])
        key = None
        for existing_y in rows:
            if abs(existing_y - y) <= 3:
                key = existing_y
                break
        if key is None:
            key = y
            rows[key] = []
        rows[key].append(w)

    # Sort rows top to bottom
    sorted_ys = sorted(rows.keys())

    # Find header row
    header_y = None
    col_bounds = None

    for y in sorted_ys:
        row_text = ' '.join(w['text'].upper() for w in rows[y])
        if 'QUANTITY' in row_text and 'AMOUNT' in row_text:
            header_y = y
            row = rows[y]

            qty_word   = next((w for w in row if 'QUANTITY' in w['text'].upper()), None)
            price_word = next((w for w in row if 'PRICE' in w['text'].upper()), None)
            amt_word   = next((w for w in row if w['text'].upper() == 'AMOUNT'
                               or ('AMOUNT' in w['text'].upper() and 'UNIT' not in w['text'].upper())), None)

            if qty_word and amt_word:
                col_bounds = {
                    'qty_max':   qty_word['x1'] + 30,
                    'desc_min':  qty_word['x1'] + 5,
                    'price_min': price_word['x0'] - 10 if price_word else amt_word['x0'] - 90,
                    'amt_min':   amt_word['x0'] - 10
                }
            break

    if header_y is None or col_bounds is None:
        return []

    items = []
    stop_words = ['SUBTOTAL', 'PAID BY', 'THANK YOU', 'SALES TAX',
                  'TAX RATE', 'DELIVERY FEE', 'TOTAL', 'CASH']

    for y in sorted_ys:
        if y <= header_y:
            continue

        row = rows[y]
        row_text = ' '.join(w['text'].upper() for w in row)

        if any(sw in row_text for sw in stop_words):
            break

        # Classify words into columns
        qty_words, desc_words, price_words, amt_words = [], [], [], []

        for w in sorted(row, key=lambda x: x['x0']):
            txt = w['text'].strip()
            if not txt:
                continue
            x = w['x0']

            if x < col_bounds['qty_max'] and x < col_bounds['desc_min'] + 20:
                qty_words.append(txt)
            elif x >= col_bounds['amt_min']:
                amt_words.append(txt)
            elif x >= col_bounds['price_min']:
                price_words.append(txt)
            else:
                desc_words.append(txt)

        qty_str   = ''.join(qty_words).replace(',', '').strip()
        price_str = ''.join(price_words).replace('$', '').replace(',', '').replace(' ', '').strip()
        amt_str   = ''.join(amt_words).replace('$', '').replace(',', '').replace(' ', '').strip()
        # Strip any trailing $ from description (happens when $ sign falls in desc column)
        desc      = ' '.join(desc_words).strip().rstrip('$').strip()

        try:
            qty = float(qty_str) if qty_str else 0
        except:
            qty = 0
        try:
            price = float(price_str) if price_str else 0
        except:
            price = 0
        try:
            amt = float(amt_str) if amt_str else 0
        except:
            amt = 0

        if qty > 0 and desc and len(desc) > 1 and amt > 0:
            items.append({
                'description': desc,
                'quantity': qty,
                'unitPrice': price,
                'ourPrice': 0,
                'amount': amt
            })

    return items


def parse_invoice(pdf_bytes, filename):
    """Full invoice parser - returns structured invoice dict"""
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            if not pdf.pages:
                raise ValueError("Empty PDF")

            page = pdf.pages[0]
            text = page.extract_text() or ''

            # ── Invoice number
            inv_match = re.search(r'invoice\s*#\s*(\d+)', text, re.I) or \
                        re.search(r'#\s*(\d{4,6})', text)
            invoice_number = inv_match.group(1).strip() if inv_match else None

            # ── Date
            date_match = re.search(r'date\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})', text, re.I)
            date_raw = date_match.group(1) if date_match else None
            date_iso = parse_gb_date(date_raw)

            year, month = None, None
            if date_iso:
                parts = date_iso.split('-')
                year  = int(parts[0])
                month = int(parts[1])
            else:
                from datetime import datetime
                now = datetime.now()
                year, month = now.year, now.month

            month_names = ['January','February','March','April','May','June',
                           'July','August','September','October','November','December']
            month_name = month_names[month - 1]
            quarter = f'Q{((month - 1) // 3) + 1}'

            # ── Bill To
            client_name = extract_bill_to(text)

            # ── Amounts
            def grab(patterns):
                for p in patterns:
                    m = re.search(p, text)
                    if m:
                        val = clean_amount(m.group(1))
                        if val > 0:
                            return val
                return 0

            total    = grab([r'\bTOTAL\b[\s\$]*([\d,\s]+\.\d{2})', r'total\s+due[^\d]*([\d,\s]+\.\d{2})'])
            tax      = grab([r'SALES\s+TAX[\s\$]*([\d,\s]+\.\d{2})', r'HST[\s\$]*([\d,\s]+\.\d{2})'])
            subtotal = grab([r'SUBTOTAL[\s\$]*([\d,\s]+\.\d{2})']) or (round(total - tax, 2) if total and tax else 0)

            # ── Payment method & HST
            pm_match  = re.search(r'paid\s+by\s*[:\-]?\s*([A-Za-z\- ]+?)(?:\n|$)', text, re.I)
            hst_match = re.search(r'hst\s+no\.?\s*[:\-]?\s*([\dA-Z ]+?)(?:\n|$)', text, re.I)

            # ── Line items via coordinate parsing
            line_items = extract_line_items_coordinate(page)

            # ── Category
            category = categorize(line_items[0]['description']) if line_items else 'General'

            # ── Sheet name
            sheet_name = get_sheet_name(year, month)

            return {
                'invoiceNumber': invoice_number,
                'clientName':    client_name,
                'date':          date_iso,
                'year':          year,
                'month':         month,
                'monthName':     month_name,
                'quarter':       quarter,
                'subtotal':      subtotal,
                'tax':           tax,
                'total':         total,
                'currency':      'CAD',
                'category':      category,
                'paymentMethod': pm_match.group(1).strip() if pm_match else None,
                'hstNumber':     hst_match.group(1).strip() if hst_match else None,
                'lineItems':     line_items,
                'sheetName':     sheet_name,
                'fileName':      filename,
                'rawTextPreview': text[:500]
            }

    except Exception as e:
        raise ValueError(f"Parse error: {str(e)}")


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'service': 'InvoiceVault PDF Parser'})


@app.route('/parse', methods=['POST'])
def parse():
    if 'pdf' not in request.files:
        return jsonify({'error': 'No PDF file provided'}), 400

    file = request.files['pdf']
    if not file.filename.lower().endswith('.pdf'):
        return jsonify({'error': 'File must be a PDF'}), 400

    try:
        pdf_bytes = file.read()
        result = parse_invoice(pdf_bytes, file.filename)
        return jsonify({'ok': True, 'data': result})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 422


@app.route('/parse-multiple', methods=['POST'])
def parse_multiple():
    """Parse multiple PDFs at once"""
    files = request.files.getlist('pdfs')
    if not files:
        return jsonify({'error': 'No files provided'}), 400

    results = []
    for file in files:
        try:
            pdf_bytes = file.read()
            data = parse_invoice(pdf_bytes, file.filename)
            results.append({'ok': True, 'fileName': file.filename, 'data': data})
        except Exception as e:
            results.append({'ok': False, 'fileName': file.filename, 'error': str(e)})

    return jsonify({'results': results})


if __name__ == '__main__':
    print(f"PDF Parser running on port {PORT}")
    app.run(host='0.0.0.0', port=PORT, debug=False)
