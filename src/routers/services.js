const express = require('express');
const multer = require('multer');
const services = require('../models/services');
const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get('/', (req, res) => services.list(req, res));
router.patch('/reorder', (req, res) => services.reorder(req, res));
router.get('/:id', (req, res) => services.getById(req, res));
router.post('/', upload.single('file'), (req, res) => services.create(req, res));
router.patch('/:id', upload.single('file'), (req, res) => services.update(req, res));
router.delete('/', (req, res) => services.remove(req, res));
router.delete('/:id', (req, res) => services.remove(req, res));

module.exports = router;
