const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

app.get('/stock', async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=incomeStatementHistoryQuarterly,defaultKeyStatistics`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com'
      }
    });
    const data = await response.json();
    if (!data?.quoteSummary?.result) {
      return res.status(404).json({ error: `No data found for ${ticker}` });
    }
    res.json(data.quoteSummary.result[0]);
  } catch(e) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

app.listen(process.env.PORT || 3000);
