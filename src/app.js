require('dotenv').config();

const cors = require('cors');
const express = require('express');
const morgan = require('morgan');

const barbers = require('./routers/barbers');

const app = express();

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : '*';

app.set('corsOrigin', corsOrigin);

app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(morgan('dev'));


app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/barbers', barbers);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
