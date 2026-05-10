const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
];

async function scrapeScreener(ticker) {
  const url = `https://www.screener.in/company/${ticker}/consolidated/`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: PUPPETEER_ARGS,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    if (!response.ok()) throw new Error(`HTTP ${response.status()} for ${url}`);

    // Wait for quarterly results section
    await page.waitForSelector('section#quarters table.data-table', { timeout: 30000 });

    const result = await page.evaluate(() => {
      const section = document.querySelector('section#quarters');
      if (!section) return null;

      const table = section.querySelector('table.data-table');
      if (!table) return null;

      // Extract company name
      const companyName = (document.querySelector('h1.margin-0') || document.querySelector('h1'))
        ?.textContent?.trim() || '';

      // Quarter headers (skip first "TTM" column if present, keep last N quarters)
      const allHeaders = Array.from(table.querySelectorAll('thead th'))
        .map(th => th.textContent.trim())
        .slice(1); // drop the empty row-label column

      // Row data keyed by label
      const rows = {};
      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td'));
        if (!cells.length) return;
        const label = cells[0].textContent.trim().replace(/\+$/, '').trim();
        const values = cells.slice(1).map(td => {
          const raw = td.textContent.trim().replace(/,/g, '');
          const n = parseFloat(raw);
          return isNaN(n) ? 0 : n;
        });
        rows[label] = values;
      });

      return { companyName, headers: allHeaders, rows };
    });

    return result;
  } finally {
    await browser.close();
  }
}

// Revenue row finder — banks use different labels
function findRow(rows, candidates) {
  for (const key of candidates) {
    if (rows[key] && rows[key].some(v => v !== 0)) return { key, values: rows[key] };
  }
  // Partial / case-insensitive fallback
  const patterns = candidates.map(c => new RegExp(c.replace(/\s+/g, '\\s*'), 'i'));
  for (const rowName of Object.keys(rows)) {
    if (patterns.some(p => p.test(rowName)) && rows[rowName].some(v => v !== 0)) {
      return { key: rowName, values: rows[rowName] };
    }
  }
  return null;
}

const REVENUE_CANDIDATES = [
  'Sales',
  'Revenue from Operations',
  'Revenue',
  'Interest Earned',
  'Total Income',
  'Net Interest Income',
];

const PROFIT_CANDIDATES = [
  'Net Profit',
  'Profit after tax',
  'PAT',
  'Net Profit after Tax',
  'Profit After Tax',
];

const EPS_CANDIDATES = ['EPS in Rs', 'EPS', 'Basic EPS', 'Diluted EPS'];

app.get('/stock', async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker query param is required' });

  try {
    const data = await scrapeScreener(ticker.toUpperCase());
    if (!data) return res.status(404).json({ error: 'Could not find quarterly data on Screener' });

    const { companyName, headers, rows } = data;

    const revenueRow = findRow(rows, REVENUE_CANDIDATES);
    const profitRow  = findRow(rows, PROFIT_CANDIDATES);
    const epsRow     = findRow(rows, EPS_CANDIDATES);

    const quarters = headers.map((label, i) => {
      const revenue   = revenueRow ? (revenueRow.values[i] ?? 0) : 0;
      const netProfit = profitRow  ? (profitRow.values[i]  ?? 0) : 0;
      const eps       = epsRow     ? (epsRow.values[i]     ?? 0) : 0;
      const margin    = revenue > 0 ? parseFloat(((netProfit / revenue) * 100).toFixed(2)) : 0;
      return { label, revenue, netProfit, eps, margin };
    });

    res.json({
      ticker: ticker.toUpperCase(),
      companyName,
      revenueLabel: revenueRow?.key || 'Revenue',
      profitLabel:  profitRow?.key  || 'Net Profit',
      quarters,
    });
  } catch (err) {
    console.error('[scrape error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Portfolio proxy listening on port ${PORT}`));
