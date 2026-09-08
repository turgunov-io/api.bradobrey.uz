const express = require('express');
const expenses = require('../models/expenses');

const router = express.Router();

router.get('/', (req, res) => expenses.list(req, res));
router.post('/', (req, res) => expenses.create(req, res));
router.patch('/:id', (req, res) => expenses.update(req, res));
router.delete('/:id', (req, res) => expenses.remove(req, res));

module.exports = router;
