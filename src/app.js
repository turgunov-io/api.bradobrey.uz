require('dotenv').config();

const cors = require('cors');
const express = require('express');
const morgan = require('morgan');

const barbers = require('./routers/barbers');
const kiosk = require('./routers/kiosk');
const certificate = require('./routers/certificate');

const app = express();

const extraOrigins = ['https://gleaming-manatee-c42221.netlify.app'];

const envOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : '*';

const corsOrigin =
  envOrigins === '*'
    ? '*'
    : Array.from(new Set([...(envOrigins || []), ...extraOrigins]));

app.set('corsOrigin', corsOrigin);

app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(morgan('dev'));


app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/barbers', barbers);
app.use('/api/kiosk', kiosk);
app.use('/api/certificate', certificate);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
