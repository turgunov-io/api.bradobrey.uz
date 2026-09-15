const express = require('express');
const { notifications } = require('../models/notifications');
const router = express.Router();
router.get('/', (req, res) => notifications.list(req, res));
router.patch('/read-all', (req, res) => notifications.readAll(req, res));
router.patch('/:id/read', (req, res) => notifications.read(req, res));
module.exports = router;
