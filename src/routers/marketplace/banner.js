const express = require('express');
const multer = require('multer');
const BannerMarketplace = require('../../models/marketplace/banner');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 * 1024 },
});

const BannerRouter = express.Router();

BannerRouter.get('/', (req, res) => BannerMarketplace.all(req, res));
BannerRouter.post('/', upload.single('file'), (req, res) => BannerMarketplace.create(req, res));
BannerRouter.put('/:id', (_req, res) => res.status(501).json({ error: 'Not implemented' }));
BannerRouter.delete('/:id', (_req, res) => res.status(501).json({ error: 'Not implemented' }));

module.exports = BannerRouter;
