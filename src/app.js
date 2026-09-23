require('dotenv').config();

const cors = require('cors');
const express = require('express');
const { uploadRoot } = require('./config/uploads');

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
const expenses = require('./routers/expenses');
const penalties = require('./routers/penalties');
const notifications = require('./routers/notifications');
const cashbackSettlements = require('./routers/cashbackSettlements');
const { ensureNotificationsTable } = require('./models/notifications');
const { enforceEmployeeAccess } = require('./middleware/employeeAccess');
const { securityHeaders } = require('./middleware/securityHeaders');

const app = express();

// Only trust forwarded client IP headers when the deployment explicitly sits
// behind a known reverse proxy. This keeps OTP/fraud/rate-limit identity data
// from being spoofed by arbitrary clients in direct deployments.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', true);
app.use(securityHeaders);

// Keep the notification module self-initializing on deployments where SQL files
// are not applied automatically. This is idempotent and does not affect orders.
ensureNotificationsTable().catch((error) => {
  console.error('Failed to initialize notifications table:', error.message);
});

const envOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

if (process.env.NODE_ENV === 'production' && envOrigins.length === 0) {
  throw new Error('CORS_ORIGIN must be configured explicitly in production');
}

const corsOrigin =
  envOrigins.length === 0
    ? '*'
    : Array.from(new Set(envOrigins));

app.set('corsOrigin', corsOrigin);

app.use(cors({ origin: corsOrigin }));
// Barber/banner creation can send base64 images in the JSON body, so raise the
// default 100kb limit. Keep nginx client_max_body_size in sync (>= this value).
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use('/uploads', express.static(uploadRoot));
app.use(enforceEmployeeAccess);


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
app.use('/api/expenses', expenses);
app.use('/api/penalties', penalties);
app.use('/api/notifications', notifications);
app.use('/api/finance/cashback-settlements', cashbackSettlements);
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
