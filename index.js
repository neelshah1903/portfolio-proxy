const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

const AV_KEY = 'D5K3X50EYLQUZAC3';

app.get('/stock', async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  try {
    const url = `https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=${ticker}&apikey=${AV_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data['Note'] || data['Information']) {
      return res.status(429).json({ error: 'Rate limit hit. Wait 1 minute.' });
    }
    if (!data.quarterlyReports || !data.quarterlyReports.length) {
      return res.status(404).json({ error: `No data found for ${ticker}` });
    }
    res.json(data.quarterlyReports);
  } catch(e) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

app.listen(process.env.PORT || 3000);
