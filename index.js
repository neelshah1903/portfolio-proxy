const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// ── NSE helpers ────────────────────────────────────────────
const NSE_REVENUE = ['sales','revenue from operations','revenue','interest earned','total income','net interest income','income from operations'];
const NSE_PROFIT  = ['net profit','profit after tax','pat','net profit after tax','profit for the period'];
const NSE_EPS     = ['eps in rs','eps','basic eps','diluted eps'];

function matchRow(label, candidates) {
  const l = label.toLowerCase().trim();
  return candidates.some(c => l.includes(c));
}

async function fetchHTML(url, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer ? { 'Referer': referer } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// ── NSE scraper (Screener.in) ─────────────────────────────
async function scrapeNSE(ticker) {
  let html = await fetchHTML(`https://www.screener.in/company/${ticker}/consolidated/`);
  let $    = cheerio.load(html);

  const hasData = $('section#quarters table tbody tr td:not(.text)').first().text().trim().length > 0;
  if (!hasData) {
    html = await fetchHTML(`https://www.screener.in/company/${ticker}/`);
    $    = cheerio.load(html);
  }

  const companyName = $('h1').first().text().trim();
  const section     = $('section#quarters');
  if (!section.length) throw new Error('No quarterly section on Screener');

  const headers = [];
  section.find('table thead th').each((i, el) => { if (i > 0) headers.push($(el).text().trim()); });
  if (!headers.length) throw new Error('No quarter headers found');

  const rows = {};
  section.find('table tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;
    const label = $(cells[0]).text().replace(/\s+/g, ' ').trim().replace(/\s*\+\s*$/, '').trim();
    const vals  = [];
    cells.each((i, td) => {
      if (i === 0) return;
      const n = parseFloat($(td).text().replace(/\s+/g, '').replace(/,/g, ''));
      vals.push(isNaN(n) ? 0 : n);
    });
    rows[label] = vals;
  });

  let revKey = null, patKey = null, epsKey = null;
  for (const key of Object.keys(rows)) {
    if (!revKey && matchRow(key, NSE_REVENUE) && rows[key].some(v => v !== 0)) revKey = key;
    if (!patKey && matchRow(key, NSE_PROFIT)  && rows[key].some(v => v !== 0)) patKey = key;
    if (!epsKey && matchRow(key, NSE_EPS)     && rows[key].some(v => v !== 0)) epsKey = key;
  }

  const quarters = headers.map((label, i) => {
    const revenue   = revKey ? (rows[revKey][i] ?? 0) : 0;
    const netProfit = patKey ? (rows[patKey][i] ?? 0) : 0;
    const eps       = epsKey ? (rows[epsKey][i] ?? 0) : 0;
    const margin    = revenue > 0 ? parseFloat(((netProfit / revenue) * 100).toFixed(2)) : 0;
    return { label, revenue, netProfit, eps, margin };
  });

  return { ticker, companyName, currency: 'INR', unit: '₹ Cr', revenueLabel: revKey || 'Revenue', profitLabel: patKey || 'Net Profit', quarters };
}

// ── US scraper (Barchart.com) ─────────────────────────────
const MONTH_LABEL = { '01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun','07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec' };

function parseBarchartDate(str) {
  // "09-2025" → "Sep 2025"
  const [m, y] = str.trim().split('-');
  return MONTH_LABEL[m] ? `${MONTH_LABEL[m]} ${y}` : str.trim();
}

const US_REVENUE = ['net revenue','total revenue','revenue'];
const US_PROFIT  = ['net income continuous','net income'];
const US_EPS     = ['eps diluted total ops','eps diluted continuous ops','eps diluted'];

async function scrapeUS(ticker) {
  const url  = `https://www.barchart.com/stocks/quotes/${ticker}/income-statement/quarterly`;
  const html = await fetchHTML(url, 'https://www.barchart.com');
  const $    = cheerio.load(html);

  // Company name
  const companyName = $('h1').first().text().replace(/\s+/g, ' ').trim() || ticker;

  // Find the financial report table
  const table = $('table').filter((_, el) => $(el).text().includes('Net Income')).first();
  if (!table.length) throw new Error('Could not find income statement table on Barchart');

  // Parse all rows: { label → [val, val, ...] }
  const rows   = {};
  let headers  = [];

  table.find('tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;

    const label = $(cells[0]).text().replace(/\s+/g, ' ').trim();
    const vals  = [];
    cells.each((i, td) => {
      if (i === 0) return;
      vals.push($(td).text().replace(/\s+/g, '').trim());
    });

    // Detect header row: values look like "MM-YYYY"
    if (vals.some(v => /^\d{2}-\d{4}$/.test(v))) {
      headers = vals.filter(v => /^\d{2}-\d{4}$/.test(v)).map(parseBarchartDate);
      return;
    }

    if (label) rows[label] = vals;
  });

  if (!headers.length) throw new Error('No quarter headers found on Barchart');

  // Match rows
  let revKey = null, patKey = null, epsKey = null;
  for (const key of Object.keys(rows)) {
    const l = key.toLowerCase();
    if (!revKey && US_REVENUE.some(c => l === c) && rows[key].some(v => v && v !== '--')) revKey = key;
    if (!patKey && US_PROFIT.some(c => l === c)  && rows[key].some(v => v && v !== '--')) patKey = key;
    if (!epsKey && US_EPS.some(c => l === c)     && rows[key].some(v => v && v !== '--')) epsKey = key;
  }

  // Barchart values are in thousands → convert to millions
  function toMillion(str) {
    const n = parseFloat((str || '').replace(/[$,]/g, ''));
    return isNaN(n) ? 0 : parseFloat((n / 1000).toFixed(2));
  }

  // Only keep columns that correspond to our parsed headers
  // The header row told us which indices have dates; re-parse to get correct column mapping
  let dateColIndices = [];
  table.find('tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;
    const vals = [];
    cells.each((i, td) => { if (i > 0) vals.push($(td).text().replace(/\s+/g, '').trim()); });
    if (vals.some(v => /^\d{2}-\d{4}$/.test(v)) && !dateColIndices.length) {
      vals.forEach((v, i) => { if (/^\d{2}-\d{4}$/.test(v)) dateColIndices.push(i); });
    }
  });

  const quarters = headers.map((label, hi) => {
    const ci        = dateColIndices[hi];
    const revVals   = revKey ? rows[revKey] : [];
    const patVals   = patKey ? rows[patKey] : [];
    const epsVals   = epsKey ? rows[epsKey] : [];
    const revenue   = toMillion(revVals[ci]);
    const netProfit = toMillion(patVals[ci]);
    const eps       = parseFloat((epsVals[ci] || '').replace(/[$,]/g, '')) || 0;
    const margin    = revenue > 0 ? parseFloat(((netProfit / revenue) * 100).toFixed(2)) : 0;
    return { label, revenue, netProfit, eps, margin };
  }).filter(q => q.revenue !== 0 || q.netProfit !== 0);

  if (!quarters.length) throw new Error('No quarterly data extracted from Barchart');

  return { ticker, companyName, currency: 'USD', unit: '$ M', revenueLabel: revKey || 'Revenue', profitLabel: patKey || 'Net Income', quarters };
}

// ── Routes ────────────────────────────────────────────────
app.get('/stock', async (req, res) => {
  const { ticker, market = 'NSE' } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker is required' });

  try {
    const data = market.toUpperCase() === 'US'
      ? await scrapeUS(ticker.toUpperCase())
      : await scrapeNSE(ticker.toUpperCase());
    res.json({ ...data, market: market.toUpperCase() });
  } catch (err) {
    console.error('[error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Portfolio proxy listening on port ${PORT}`));
