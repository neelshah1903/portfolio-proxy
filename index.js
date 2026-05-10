const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

const REVENUE_LABELS = [
  'sales', 'revenue from operations', 'revenue',
  'interest earned', 'total income', 'net interest income',
  'income from operations',
];

const PROFIT_LABELS = [
  'net profit', 'profit after tax', 'pat', 'net profit after tax',
  'profit for the period',
];

const EPS_LABELS = ['eps in rs', 'eps', 'basic eps', 'diluted eps'];

function matchRow(label, candidates) {
  const l = label.toLowerCase().trim();
  return candidates.some(c => l.includes(c));
}

async function scrapeScreener(ticker) {
  const url = `https://www.screener.in/company/${ticker}/consolidated/`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`Screener returned HTTP ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const companyName = $('h1').first().text().trim();

  // Find the Quarters section
  const section = $('section#quarters');
  if (!section.length) throw new Error('No quarterly section found on page');

  // Extract column headers (quarter labels)
  const headers = [];
  section.find('table thead th').each((i, el) => {
    if (i === 0) return; // skip row-label column
    headers.push($(el).text().trim());
  });

  if (!headers.length) throw new Error('No quarter headers found');

  // Extract all data rows
  const rows = {};
  section.find('table tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;
    const label = $(cells[0]).text().trim().replace(/\+$/, '').trim();
    const values = [];
    cells.each((i, td) => {
      if (i === 0) return;
      const raw = $(td).text().trim().replace(/,/g, '');
      const n = parseFloat(raw);
      values.push(isNaN(n) ? 0 : n);
    });
    rows[label] = values;
  });

  // Find the right rows
  let revenueKey = null, profitKey = null, epsKey = null;

  for (const key of Object.keys(rows)) {
    if (!revenueKey && matchRow(key, REVENUE_LABELS) && rows[key].some(v => v !== 0)) revenueKey = key;
    if (!profitKey  && matchRow(key, PROFIT_LABELS)  && rows[key].some(v => v !== 0)) profitKey = key;
    if (!epsKey     && matchRow(key, EPS_LABELS)      && rows[key].some(v => v !== 0)) epsKey = key;
  }

  const quarters = headers.map((label, i) => {
    const revenue   = revenueKey ? (rows[revenueKey][i] ?? 0) : 0;
    const netProfit = profitKey  ? (rows[profitKey][i]  ?? 0) : 0;
    const eps       = epsKey     ? (rows[epsKey][i]     ?? 0) : 0;
    const margin    = revenue > 0 ? parseFloat(((netProfit / revenue) * 100).toFixed(2)) : 0;
    return { label, revenue, netProfit, eps, margin };
  });

  return {
    ticker: ticker.toUpperCase(),
    companyName,
    revenueLabel: revenueKey || 'Revenue',
    profitLabel:  profitKey  || 'Net Profit',
    quarters,
  };
}

app.get('/stock', async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker query param is required' });

  try {
    const data = await scrapeScreener(ticker.toUpperCase());
    res.json(data);
  } catch (err) {
    console.error('[error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Portfolio proxy listening on port ${PORT}`));
