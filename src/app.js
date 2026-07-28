require('dotenv').config();

const cors = require('cors');
const express = require('express');
const morgan = require('morgan');
const { uploadRoot } = require('./config/uploads');
const requestLogger = require('./middleware/requestLogger');

const kiosk = require('./routers/kiosk');
const monitor = require('./routers/monitor');
const certificate = require('./routers/certificate');
const finance = require('./routers/finance');
const services = require('./routers/services');
const serviceCategories = require('./routers/serviceCategories');
const history = require('./routers/history');
const barbers = require('./routers/barbers');
const branches = require('./routers/branches');
const merchant = require('./routers/merchant');
const marketplace = require('./routers/marketplace');
const statistics = require('./routers/statistics');
const promoCode = require('./routers/promocode');
const loyalty = require('./routers/loyalty');
const kioskAds = require('./routers/kioskAds');
const verifix = require('./routers/verifix');
const warehouse = require('./routers/warehouse');

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
// Barber/banner creation can send base64 images in the JSON body, so raise the
// default 100kb limit. Keep nginx client_max_body_size in sync (>= this value).
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(morgan('dev'));
app.use(requestLogger);
app.use('/uploads', express.static(uploadRoot));


app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/barbers', barbers);
app.use('/api/branches', branches);
app.use('/api/kiosk', kiosk);
app.use('/api/monitor', monitor);
app.use('/api/certificate', certificate);
app.use('/api/finance', finance);
app.use('/api/services', services);
app.use('/api/service-categories', serviceCategories);
app.use('/api/history', history);
app.use('/api/statistics', statistics);
app.use('/api/promo-code', promoCode);
app.use('/api/loyalty', loyalty);
app.use('/api/kiosk-ads', kioskAds);
app.use('/api/verifix', verifix);
app.use('/api/warehouse', warehouse);
app.use('/api/merchant', merchant);

app.get('/today/date/', (req, res) => {
  const date = new Date()

  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = String(date.getFullYear()).slice(-2)

  res.json({
    date: `${day}:${month}:${year}`
  })
})

// Marketplace App
app.use('/api/marketplace', marketplace);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
