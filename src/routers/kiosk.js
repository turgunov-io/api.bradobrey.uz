const express = require('express');
const kiosk = require('../models/kiosk');
const { staffAccess } = require('../middleware/staffAccess');
const { rateLimit } = require('../middleware/rateLimit');
const { kioskAuth } = require('../middleware/kioskAuth');
const { kioskEnrollment } = require('../models/kioskEnrollment');
const router = express.Router();

// Registration needs the company's own enrollment code (or staff of that
// company; see services/kioskRegistration.js) and cannot take over an
// existing kiosk; the limit only slows down spam rows and code guessing.
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, keyPrefix: 'kiosk-register', keyBy: 'ip' });
const deviceStaff = staffAccess.requireStaff({ anyOf: ['dashboard.access'] });
// Data routes: X-Kiosk-Token pins the branch; dashboard/barber callers use
// their employee JWT (branch-checked); marketplace client JWTs only reach the
// certificate check and source=site bookings (see middleware/kioskAuth.js).
const kioskData = kioskAuth({ allowBearer: true });
const kioskCertificate = kioskAuth({ allowBearer: true, allowMarketplace: () => true });
const kioskBook = kioskAuth({ allowBearer: true, allowMarketplace: (req) => req.body?.source === 'site' });
// /config is public (kiosks read it before registering). When a device token
// is sent it is verified so the response is limited to the kiosk's company;
// staff tokens are resolved by the global employeeAccess middleware.
const kioskTokenIfPresent = (req, res, next) => (
  String(req.headers?.['x-kiosk-token'] || '').trim() ? kioskData(req, res, next) : next()
);

router.get('/', async (req, res) => kiosk.health(req, res));
router.get('/config', kioskTokenIfPresent, async (req, res) => kiosk.config(req, res));
router.post('/register', registerLimiter, async (req, res) => kiosk.register(req, res));
router.post('/socket-ticket', async (req, res) => kiosk.socketTicket(req, res));
// Company network admins rotate their own company's enrollment code.
router.put('/enrollment-code', staffAccess.requireStaff(), async (req, res) => kioskEnrollment.rotate(req, res));
router.get('/devices', deviceStaff, async (req, res) => kiosk.listDevices(req, res));
router.delete('/devices/:id', deviceStaff, async (req, res) => kiosk.removeDevice(req, res));
router.get('/barbers/:branch_id', kioskData, async (req, res) => kiosk.barbers(req, res));
router.get('/services', kioskData, async (req, res) => kiosk.services(req, res));
router.post('/book', kioskBook, async (req, res) => kiosk.book(req, res));
router.get('/certificate/:id', kioskCertificate, async (req, res) => kiosk.certificate(req, res));

module.exports = router;
