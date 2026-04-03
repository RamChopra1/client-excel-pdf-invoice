const router = require('express').Router();
const multer = require('multer');
const fetch  = require('node-fetch');
const FormData = require('form-data');
const ExcelJS  = require('exceljs');
const { Invoice } = require('../models');
const { authenticate, adminOnly } = require('../middleware/auth');

const PARSER_URL = process.env.PYTHON_PARSER_URL || 'http://localhost:5001';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// All invoice routes require auth
router.use(authenticate);

// ── GET invoices ──────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const query = req.user.role === 'admin' && req.query.all === 'true'
      ? {}
      : { userId: req.user._id };

    const invoices = await Invoice.find(query)
      .populate('userId', 'username companyName')
      .sort({ date: -1 });
    res.json(invoices);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UPLOAD PDF → parse → save ─────────────────────────────────────────────────
router.post('/upload', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  if (!req.file.originalname.toLowerCase().endsWith('.pdf'))
    return res.status(400).json({ error: 'Must be a PDF' });

  try {
    // Send to Python parser
    const form = new FormData();
    form.append('pdf', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });

    const parserRes = await fetch(`${PARSER_URL}/parse`, { method: 'POST', body: form });
    const parsed = await parserRes.json();

    if (!parsed.ok) return res.status(422).json({ error: parsed.error || 'Parse failed' });

    const data = parsed.data;
    const id = `inv_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Check for duplicate — must match BOTH invoice number AND date
    if (data.invoiceNumber && data.date) {
      const exists = await Invoice.findOne({
        userId: req.user._id,
        invoiceNumber: data.invoiceNumber,
        date: data.date
      });
      if (exists) return res.json({ ok: true, exists: true, invoice: exists });
    } else if (data.invoiceNumber) {
      // If no date extracted, fall back to invoice number only
      const exists = await Invoice.findOne({
        userId: req.user._id,
        invoiceNumber: data.invoiceNumber
      });
      if (exists) return res.json({ ok: true, exists: true, invoice: exists });
    }

    const invoice = await Invoice.create({ ...data, id, userId: req.user._id });
    res.json({ ok: true, invoice });
  } catch (e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── UPLOAD MULTIPLE ───────────────────────────────────────────────────────────
router.post('/upload-multiple', upload.array('pdfs', 50), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

  const results = [];

  for (const file of req.files) {
    try {
      const form = new FormData();
      form.append('pdf', file.buffer, { filename: file.originalname, contentType: 'application/pdf' });

      const parserRes = await fetch(`${PARSER_URL}/parse`, { method: 'POST', body: form });
      const parsed = await parserRes.json();

      if (!parsed.ok) {
        results.push({ fileName: file.originalname, ok: false, error: parsed.error });
        continue;
      }

      const data = parsed.data;
      const id = `inv_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      if (data.invoiceNumber) {
        const exists = await Invoice.findOne({ userId: req.user._id, invoiceNumber: data.invoiceNumber });
        if (exists) { results.push({ fileName: file.originalname, ok: true, exists: true }); continue; }
      }

      const invoice = await Invoice.create({ ...data, id, userId: req.user._id });
      results.push({ fileName: file.originalname, ok: true, invoice });
    } catch (e) {
      results.push({ fileName: file.originalname, ok: false, error: e.message });
    }
  }

  res.json({ results });
});

// ── EXPORT to Excel ───────────────────────────────────────────────────────────
const HEADERS = ['S. NO.','INV. NO.','INV. DATE','SOLD TO','QUANTITY','PER PC.',
                 'PRODUCT','AMOUNT','TAX','TOTAL','AMT. RCD','OUR PRICE','PROFIT','ASIS CUT'];
const COL_WIDTHS = [8, 10, 14, 38, 12, 10, 38, 13, 12, 14, 14, 14, 13, 13];

// Sheet name: one tab per month — matches reference exactly
function getSheetName(year, month) {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const y = Number(year) || new Date().getFullYear();
  const m = Number(month) || 1;
  return `${MONTHS[m - 1]} ${y}`;
}

function setupSheet(sheet) {
  // Row 1 — merged title
  sheet.mergeCells('A1:N1');
  const t = sheet.getCell('A1');
  t.value = 'ORDERS OF GREENBANK WHOLESALE';
  t.font = { name: 'Arial', bold: true, size: 20 };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 30;

  // Row 2 — red header
  const hRow = sheet.getRow(2);
  hRow.values = HEADERS;
  hRow.eachCell(cell => {
    cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC00000' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} };
  });
  hRow.height = 18;

  // Rows 3-8 — blank with height 15
  for (let r = 3; r <= 8; r++) sheet.getRow(r).height = 15;

  // Column widths — match reference exactly
  COL_WIDTHS.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

  return 9; // data starts at row 9
}

router.get('/export/excel', async (req, res) => {
  try {
    const query = req.user.role === 'admin' && req.query.all === 'true'
      ? {}
      : { userId: req.user._id };
    if (req.query.userId && req.user.role === 'admin') query.userId = req.query.userId;

    const invoices = await Invoice.find(query).sort({ year: 1, month: 1, invoiceNumber: 1 });
    const workbook = new ExcelJS.Workbook();

    // Group by month sheet — same as reference (JAN 2025, FEB 2025, etc.)
    const sheetsMap = {};
    for (const inv of invoices) {
      const name = getSheetName(inv.year, inv.month);
      if (!sheetsMap[name]) sheetsMap[name] = [];
      sheetsMap[name].push(inv);
    }

    // Sort sheets chronologically
    const sheetOrder = Object.keys(sheetsMap).sort((a, b) => {
      const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
      const [ma, ya] = a.split(' ');
      const [mb, yb] = b.split(' ');
      if (ya !== yb) return Number(ya) - Number(yb);
      return MONTHS.indexOf(ma) - MONTHS.indexOf(mb);
    });

    const thin = { style: 'thin' };
    const bdr  = { top: thin, left: thin, bottom: thin, right: thin };

    for (const sheetName of sheetOrder) {
      const list = sheetsMap[sheetName];
      if (!list?.length) continue;

      const sheet = workbook.addWorksheet(sheetName);
      let rowNum = setupSheet(sheet);
      let sNo = 1;

      for (const inv of list) {
        const items = inv.lineItems || [];

        // Format date YYYY-MM-DD → DD-MM-YYYY
        let dateStr = inv.date || '';
        const dp = dateStr.split('-');
        if (dp.length === 3 && dp[0].length === 4) {
          dateStr = `${dp[2]}-${dp[1]}-${dp[0]}`;
        }

        const writeRow = (vals, rn) => {
          const r = sheet.getRow(rn);
          r.values = vals;
          r.font = { name: 'Arial', size: 11 };
          r.getCell('D').alignment = { wrapText: true };
          r.getCell('G').alignment = { wrapText: true };
          r.eachCell({ includeEmpty: true }, cell => { cell.border = bdr; });
        };

        if (!items.length) {
          // No line items — write single row, formulas still apply
          const r = sheet.getRow(rowNum);
          r.getCell('A').value = sNo;
          r.getCell('B').value = inv.invoiceNumber || '';
          r.getCell('C').value = dateStr;
          r.getCell('D').value = inv.clientName || '';
          r.getCell('E').value = '';
          r.getCell('F').value = '';
          r.getCell('G').value = '(no items)';
          r.getCell('H').value = '';
          r.getCell('I').value = inv.tax || 0;
          r.getCell('J').value = inv.total || 0;
          r.getCell('K').value = inv.total || 0;
          r.getCell('L').value = 0;
          r.getCell('M').value = { formula: `H${rowNum}-E${rowNum}*L${rowNum}` };
          r.getCell('N').value = { formula: `M${rowNum}/2` };
          r.font = { name: 'Arial', size: 11 };
          r.getCell('D').alignment = { wrapText: true };
          r.eachCell({ includeEmpty: true }, cell => { cell.border = bdr; });
          rowNum++;
        } else {
          items.forEach((item, idx) => {
            const first = idx === 0;
            const qty   = item.quantity || 0;
            const price = item.unitPrice || 0;
            const amt   = item.amount || +(qty * price).toFixed(2);
            const ourP  = item.ourPrice || 0;

            const r = sheet.getRow(rowNum);
            r.getCell('A').value = first ? sNo : '';
            r.getCell('B').value = first ? (inv.invoiceNumber || '') : '';
            r.getCell('C').value = first ? dateStr : '';
            r.getCell('D').value = first ? (inv.clientName || '') : '';
            r.getCell('E').value = qty;
            r.getCell('F').value = price;
            r.getCell('G').value = item.description || '';
            r.getCell('H').value = amt;
            r.getCell('I').value = first ? (inv.tax || 0) : '';
            r.getCell('J').value = first ? (inv.total || 0) : '';
            r.getCell('K').value = first ? (inv.total || 0) : '';
            r.getCell('L').value = ourP;
            // PROFIT formula: H - E*L  (AMOUNT - QUANTITY * OUR PRICE)
            r.getCell('M').value = { formula: `H${rowNum}-E${rowNum}*L${rowNum}` };
            // ASIS CUT formula: PROFIT / 2
            r.getCell('N').value = { formula: `M${rowNum}/2` };

            r.font = { name: 'Arial', size: 11 };
            r.getCell('D').alignment = { wrapText: true };
            r.getCell('G').alignment = { wrapText: true };
            r.eachCell({ includeEmpty: true }, cell => { cell.border = bdr; });
            rowNum++;
          });
        }
        sNo++;
      }
    }

    const filename = req.query.all === 'true' ? 'all_invoices.xlsx' : `invoices_${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET single invoice ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const query = { id: req.params.id };
    if (req.user.role !== 'admin') query.userId = req.user._id;
    const invoice = await Invoice.findOne(query);
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json(invoice);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UPDATE invoice ────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const query = { id: req.params.id };
    if (req.user.role !== 'admin') query.userId = req.user._id;
    const updated = await Invoice.findOneAndUpdate(query, { $set: req.body }, { new: true });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE invoice ────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const query = { id: req.params.id };
    if (req.user.role !== 'admin') query.userId = req.user._id;
    await Invoice.findOneAndDelete(query);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
