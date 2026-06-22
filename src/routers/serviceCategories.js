const express = require('express');
const serviceCategories = require('../models/serviceCategories');

const router = express.Router();

router.get('/', (req, res) => serviceCategories.list(req, res));
router.post('/', (req, res) => serviceCategories.create(req, res));
router.patch('/:id', (req, res) => serviceCategories.update(req, res));
router.delete('/:id', (req, res) => serviceCategories.remove(req, res));

module.exports = router;

