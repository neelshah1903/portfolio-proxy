const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

app.get('/stock', async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  try {
    const url = `https://www.screener.in/company/${ticker}/consolidated/`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    const html = await response.text();

    // Extract company name
    const nameMatch = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/);
    const companyName = nameMatch ? nameMatch[1].trim() : ticker;

    // Extract quarterly table
    const sectionMatch = html.match(/Quarterly Results[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
    if (!sectionMatch) return res.status(404).json({ error: `No quarterly data found for ${ticker}` });

    const tbody = sectionMatch[1];

    // Extract headers (quarter labels)
    const headerMatch = html.match(/Quarterly Results[\s\S]*?<thead>([\s\S]*?)<\/thead>/);
    const headers = [];
    if (headerMatch) {
      const thMatches = headerMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g);
      for (const m of thMatches) {
        headers.push(m[1].replace(/<[^>]+>/g, '').trim());
      }
    }

    // Extract rows
    const rows = {};
    const rowMatches = tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g);
    for (const row of rowMatches) {
      const cells = [];
      const tdMatches = row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g);
      for (const td of tdMatches) {
        cells.push(td[1].replace(/<[^>]+>/g, '').replace(/,/g, '').trim());
      }
      if (cells.length > 1) {
        rows[cells[0]] = cells.slice(1);
      }
    }

    // Build quarters array
    const quarters = [];
    const quarterHeaders = headers.slice(1);
    for (let i = 0; i < quarterHeaders.length; i++) {
      const revenue = parseFloat(rows['Sales']?.[i] || rows['Revenue']?.[i] || 0);
      const profit = parseFloat(rows['Net Profit']?.[i] || 0);
      const eps = parseFloat(rows['EPS in Rs']?.[i] || 0);
      quarters.push({
        label: quarterHeaders[i],
        revenue,
        netProfit: profit,
        eps
      });
    }

    res.json({ ticker, companyName, quarters });
  } catch(e) {
    res.status(500).json({ error: 'Fetch failed: ' + e.message });
  }
});

app.listen(process.env.PORT || 3000);
