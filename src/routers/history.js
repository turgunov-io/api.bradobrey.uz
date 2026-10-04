const express = require('express');
const history = require('../models/history');
const { authenticateHistory } = require('../utils/employeeQualityAccess');

const router = express.Router();

const protectHistory = async (req, res, next) => {
    try {
        const access = await authenticateHistory(req, res);
        if (!access) return;
        req.historyAccess = access;
        next();
    } catch (error) {
        console.error('History authorization failed:', error.message);
        res.status(500).json({ error: 'Failed to authorize history request' });
    }
};

router.get('/', protectHistory, (req, res) => history.all(req, res));
router.get('/barber', protectHistory, (req, res) => history.barber(req, res));
router.get('/branch/', protectHistory, (req, res) => history.branch(req, res));

module.exports = router;
