const express = require('express');
const services = require('../models/services');
const router = express.Router();

router.get('/', async (req, res) => services.getAll(req, res));

module.exports = router;
