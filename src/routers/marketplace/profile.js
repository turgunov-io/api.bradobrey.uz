const express = require('express');
const multer = require('multer');

const MarketplaceProfile = require('../../models/marketplace/profile');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const router = express.Router();

router.get('/me', (req, res) => MarketplaceProfile.me(req, res));
router.patch('/me', upload.single('file'), (req, res) => MarketplaceProfile.updateMe(req, res));
router.get('/history', (req, res) => MarketplaceProfile.history(req, res));

module.exports = router;

