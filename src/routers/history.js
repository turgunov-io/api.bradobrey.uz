const express = require('express');
const history = require('../models/history');

const router = express.Router();

router.get('/', (req, res) => history.all(req, res));
router.get('/barber', (req, res) => history.barber(req, res));
router.get('/branch/', (req, res) => history.branch(req, res));

module.exports = router;
