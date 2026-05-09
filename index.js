const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

const API_KEY = 'sObjIgW0wJN3h5wc9Qcg6vE6UKoJa9GH';

app.get('/stock', async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  try {
    const url = `https://financialmodelingprep.com/stable/income-statement?symbol=${ticker}&period=quarterly&limit=8&apikey=${API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

app.listen(process.env.PORT || 3000);
