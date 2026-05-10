const express = require('express');
const verifix = require('../models/verifix');

const router = express.Router();

router.get('/events', (req, res) => verifix.listEvents(req, res));
router.post('/events', (req, res) => verifix.recordEvent(req, res));

router.get('/schedules', (req, res) => verifix.listSchedules(req, res));
router.post('/schedules', (req, res) => verifix.createSchedule(req, res));
router.patch('/schedules/:id', (req, res) => verifix.updateSchedule(req, res));
router.delete('/schedules/:id', (req, res) => verifix.deleteSchedule(req, res));

module.exports = router;
