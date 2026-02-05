const express = require('express');
const kiosk = require('../models/kiosk');
const router = express.Router();

router.get('/', async (req, res) => kiosk.health(req, res));
router.get('/config', async (req, res) => kiosk.config(req, res));
router.post('/register', async (req, res) => kiosk.register(req, res));
router.get('/barbers/:branch_id', async (req, res) => kiosk.barbers(req, res));
router.get('/services', async (req, res) => kiosk.services(req, res));
router.post('/book', async (req, res) => kiosk.book(req, res));
router.get('/certificate/:id', async (req, res) => kiosk.certificate(req, res));

module.exports = router;
