const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const FRED_API_KEY = process.env.FRED_API_KEY || '';

// ── FRED macro cache (refresh every 4 hours) ──────────────
let macroCache = null, macroCacheTime = 0;

async function fetchFRED(series, limit = 2) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${FRED_API_KEY}&sort_order=desc&limit=${limit}&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${series}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.observations || []).filter(o => o.value !== '.');
}

function fredVal(obs, idx = 0) {
  return obs[idx] ? parseFloat(obs[idx].value) : null;
}

// ── NSE helpers ────────────────────────────────────────────
const NSE_REVENUE = ['sales','revenue from operations','revenue','interest earned','total income','net interest income','income from operations'];
const NSE_PROFIT  = ['net profit','profit after tax','pat','net profit after tax','profit for the period'];
const NSE_EPS     = ['eps in rs','eps','basic eps','diluted eps'];
const NSE_OPM     = ['opm %','opm%','operating profit margin','opm'];

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

  let revKey = null, patKey = null, epsKey = null, opmKey = null;
  for (const key of Object.keys(rows)) {
    if (!revKey && matchRow(key, NSE_REVENUE) && rows[key].some(v => v !== 0)) revKey = key;
    if (!patKey && matchRow(key, NSE_PROFIT)  && rows[key].some(v => v !== 0)) patKey = key;
    if (!epsKey && matchRow(key, NSE_EPS)     && rows[key].some(v => v !== 0)) epsKey = key;
    if (!opmKey && matchRow(key, NSE_OPM)     && rows[key].some(v => v !== 0)) opmKey = key;
  }

  const quarters = headers.map((label, i) => {
    const revenue   = revKey ? (rows[revKey][i] ?? 0) : 0;
    const netProfit = patKey ? (rows[patKey][i] ?? 0) : 0;
    const eps       = epsKey ? (rows[epsKey][i] ?? 0) : 0;
    const margin    = revenue > 0 ? parseFloat(((netProfit / revenue) * 100).toFixed(2)) : 0;
    const opMargin  = opmKey ? (rows[opmKey][i] ?? null) : null; // already a % from Screener
    return { label, revenue, netProfit, eps, margin, opMargin };
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

const US_REVENUE = ['net revenue','total revenue','revenue','net sales','sales'];
const US_PROFIT  = ['net income continuous','net income'];
const US_EPS     = ['eps diluted total ops','eps diluted continuous ops','eps diluted'];
const US_OPM     = ['operating income','ebit'];

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
  let revKey = null, patKey = null, epsKey = null, opmKey = null;
  for (const key of Object.keys(rows)) {
    const l = key.toLowerCase();
    if (!revKey && US_REVENUE.some(c => l.includes(c)) && rows[key].some(v => v && v !== '--')) revKey = key;
    if (!patKey && US_PROFIT.some(c => l.includes(c))  && rows[key].some(v => v && v !== '--')) patKey = key;
    if (!epsKey && US_EPS.some(c => l.includes(c))     && rows[key].some(v => v && v !== '--')) epsKey = key;
    if (!opmKey && US_OPM.some(c => l.includes(c))     && rows[key].some(v => v && v !== '--')) opmKey = key;
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
    const opmVals   = opmKey ? rows[opmKey] : [];
    const revenue   = toMillion(revVals[ci]);
    const netProfit = toMillion(patVals[ci]);
    const opIncome  = toMillion(opmVals[ci]);
    const eps       = parseFloat((epsVals[ci] || '').replace(/[$,]/g, '')) || 0;
    const margin    = revenue > 0 ? parseFloat(((netProfit / revenue) * 100).toFixed(2)) : 0;
    const opMargin  = revenue > 0 && opIncome ? parseFloat(((opIncome / revenue) * 100).toFixed(2)) : null;
    return { label, revenue, netProfit, eps, margin, opMargin };
  }).filter(q => q.revenue !== 0 || q.netProfit !== 0);

  if (!quarters.length) throw new Error('No quarterly data extracted from Barchart');

  // Barchart returns newest-first — reverse to oldest-first for consistency with NSE
  return { ticker, companyName, currency: 'USD', unit: '$ M', revenueLabel: revKey || 'Revenue', profitLabel: patKey || 'Net Income', quarters: quarters.reverse() };
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

// ── AI Chat ───────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { question, portfolio } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  if (!GROQ_API_KEY) return res.status(503).json({ error: 'AI not configured on server' });

  // Build portfolio context string
  const ctx = portfolio && Object.keys(portfolio).length
    ? Object.entries(portfolio).map(([, d]) => {
        const qs = d.quarters;
        const ttmRev = qs.slice(-4).reduce((s, q) => s + q.revenue, 0);
        const ttmPat = qs.slice(-4).reduce((s, q) => s + q.netProfit, 0);
        const latest = qs[qs.length - 1];
        const yoyRev = qs.length >= 5 ? ((qs[qs.length-1].revenue - qs[qs.length-5].revenue) / Math.abs(qs[qs.length-5].revenue) * 100).toFixed(1) : 'N/A';
        const yoyPat = qs.length >= 5 ? ((qs[qs.length-1].netProfit - qs[qs.length-5].netProfit) / Math.abs(qs[qs.length-5].netProfit) * 100).toFixed(1) : 'N/A';
        return `${d.ticker} (${d.market}, ${d.unit}): TTM Revenue=${ttmRev.toFixed(0)}, TTM Profit=${ttmPat.toFixed(0)}, Latest Q=${latest?.label}, Latest Revenue=${latest?.revenue}, Latest PAT=${latest?.netProfit}, Latest Margin=${latest?.margin}%, Rev YoY=${yoyRev}%, PAT YoY=${yoyPat}%`;
      }).join('\n')
    : 'No portfolio data available.';

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: `You are a sharp financial analyst assistant embedded in a portfolio tracker dashboard. The user's current portfolio:\n${ctx}\n\nAnswer concisely (2-4 sentences max). Use the actual numbers from the portfolio. If something isn't in the data, say so.` },
          { role: 'user', content: question }
        ],
        max_tokens: 300,
        temperature: 0.5
      })
    });
    if (r.status === 429) return res.status(429).json({ error: 'Daily AI limit reached — resets at midnight. Your portfolio data is still fully available.' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || r.statusText); }
    const data = await r.json();
    res.json({ answer: data.choices[0].message.content.trim() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Macro chart history (FRED) ────────────────────────────
let macroChartCache = null, macroChartCacheTime = 0; // reset forces fresh fetch on next request

async function fetchFREDHistory(series, limit) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${FRED_API_KEY}&sort_order=desc&limit=${limit}&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${series}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.observations || []).filter(o => o.value !== '.').map(o => ({ d: o.date, v: parseFloat(o.value) })).reverse();
}

app.get('/macro-chart', async (req, res) => {
  if (!FRED_API_KEY) return res.status(503).json({ error: 'FRED API key not configured' });
  const force = req.query.force === '1';
  if (!force && macroChartCache && Date.now() - macroChartCacheTime < 4 * 60 * 60 * 1000) return res.json(macroChartCache);

  try {
    const [sp500, nasdaq, djia, nikkei, dgs10, dgs2, vix, wti, brent, fedfunds, cpi, corePce, unrate] = await Promise.all([
      fetchFREDHistory('SP500', 504),
      fetchFREDHistory('NASDAQCOM', 504),
      fetchFREDHistory('DJIA', 504),
      fetchFREDHistory('NIKKEI225', 504),
      fetchFREDHistory('DGS10', 504),
      fetchFREDHistory('DGS2', 504),
      fetchFREDHistory('VIXCLS', 504),
      fetchFREDHistory('DCOILWTICO', 504),
      fetchFREDHistory('DCOILBRENTEU', 504),
      fetchFREDHistory('FEDFUNDS', 72),
      fetchFREDHistory('CPIAUCSL', 72),
      fetchFREDHistory('PCEPILFE', 72),
      fetchFREDHistory('UNRATE', 72),
    ]);

    // Yield spread aligned by date
    const t10Map = Object.fromEntries(dgs10.map(d => [d.d, d.v]));
    const t2Map  = Object.fromEntries(dgs2.map(d => [d.d, d.v]));
    const spread = dgs10.filter(d => t2Map[d.d] != null)
      .map(d => ({ d: d.d, v: parseFloat((t10Map[d.d] - t2Map[d.d]).toFixed(3)) }));

    // CPI/PCE YoY from monthly levels
    function yoyArr(arr) {
      return arr.slice(12).map((d, i) => ({
        d: d.d, v: parseFloat(((d.v - arr[i].v) / arr[i].v * 100).toFixed(2))
      }));
    }

    macroChartCache = { sp500, nasdaq, djia, nikkei, dgs10, dgs2, spread, vix, wti, brent, fedfunds, cpi: yoyArr(cpi), corePce: yoyArr(corePce), unrate };
    macroChartCacheTime = Date.now();
    res.json(macroChartCache);
  } catch(err) {
    console.error('[macro-chart error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Macro indicators (FRED) ───────────────────────────────
app.get('/macro', async (req, res) => {
  if (!FRED_API_KEY) return res.status(503).json({ error: 'FRED API key not configured' });
  const force = req.query.force === '1';
  if (!force && macroCache && Date.now() - macroCacheTime < 4 * 60 * 60 * 1000) return res.json(macroCache);

  try {
    const [dgs10, dgs2, vix, cpi, corePce, fedfunds, wti, brent, unrate, sp500, nasdaq, djia, nikkei] = await Promise.all([
      fetchFRED('DGS10', 2),
      fetchFRED('DGS2', 2),
      fetchFRED('VIXCLS', 2),
      fetchFRED('CPIAUCSL', 13),
      fetchFRED('PCEPILFE', 13),   // Core PCE — Fed's preferred inflation measure
      fetchFRED('FEDFUNDS', 2),
      fetchFRED('DCOILWTICO', 2),
      fetchFRED('DCOILBRENTEU', 2),
      fetchFRED('UNRATE', 2),      // Unemployment rate
      fetchFRED('SP500', 2),
      fetchFRED('NASDAQCOM', 2),
      fetchFRED('DJIA', 2),
      fetchFRED('NIKKEI225', 2),
    ]);

    const t10 = fredVal(dgs10), t2 = fredVal(dgs2);

    function yoyPct(obs) {
      const latest = fredVal(obs, 0), year = fredVal(obs, 12);
      return latest && year ? parseFloat(((latest - year) / year * 100).toFixed(2)) : null;
    }

    function idxChange(obs) {
      const latest = fredVal(obs, 0), prev = fredVal(obs, 1);
      return latest && prev ? parseFloat(((latest - prev) / prev * 100).toFixed(2)) : null;
    }

    macroCache = {
      // Indices
      sp500:    { value: fredVal(sp500),    prev: fredVal(sp500, 1),    chg: idxChange(sp500) },
      nasdaq:   { value: fredVal(nasdaq),   prev: fredVal(nasdaq, 1),   chg: idxChange(nasdaq) },
      djia:     { value: fredVal(djia),     prev: fredVal(djia, 1),     chg: idxChange(djia) },
      nikkei:   { value: fredVal(nikkei),   prev: fredVal(nikkei, 1),   chg: idxChange(nikkei) },
      // Rates & yields
      dgs10:    { value: t10,               prev: fredVal(dgs10, 1) },
      dgs2:     { value: t2,                prev: fredVal(dgs2, 1) },
      spread:   { value: t10 && t2 ? parseFloat((t10 - t2).toFixed(2)) : null },
      fedfunds: { value: fredVal(fedfunds), prev: fredVal(fedfunds, 1) },
      // Volatility & macro
      vix:      { value: fredVal(vix),      prev: fredVal(vix, 1) },
      cpi:      { value: yoyPct(cpi) },
      corePce:  { value: yoyPct(corePce) },
      unrate:   { value: fredVal(unrate),   prev: fredVal(unrate, 1) },
      // Commodities
      wti:      { value: fredVal(wti),      prev: fredVal(wti, 1) },
      brent:    { value: fredVal(brent),    prev: fredVal(brent, 1) },
    };
    macroCacheTime = Date.now();
    res.json(macroCache);
  } catch(err) {
    console.error('[macro error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Portfolio proxy listening on port ${PORT}`));
