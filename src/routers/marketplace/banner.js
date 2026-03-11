const express = require('express');
const multer = require('multer');
const BannerMarketplace = require('../../models/marketplace/banner');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 * 1024 },
});

const BannerRouter = express.Router();

BannerRouter.get('/', (req, res) => BannerMarketplace.all(req, res));
BannerRouter.get('/:id', (req, res) => BannerMarketplace.getById(req, res));

BannerRouter.post('/', upload.single('file'), (req, res) => BannerMarketplace.create(req, res));

BannerRouter.put('/:id', upload.single('file'), (req, res) => BannerMarketplace.update(req, res));

BannerRouter.delete('/:id', (req, res) => BannerMarketplace.deactivate(req, res));

module.exports = BannerRouter;
