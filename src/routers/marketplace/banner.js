const express = require('express');
const multer = require('multer');
const BannerMarketplace = require('../../models/marketplace/banner');
const { staffAccess } = require('../../middleware/staffAccess');
const { detectMediaType } = require('../../utils/mediaSignature');

// Banners may be short videos; nginx caps request bodies at 50 MB anyway.
const BANNER_MAX_BYTES = 20 * 1024 * 1024;

const parseUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: BANNER_MAX_BYTES, files: 1 },
}).single('file');

// Parses the optional "file" field, then trusts only the detected file type,
// never the client-supplied Content-Type (it decides the stored extension).
function bannerUpload(req, res, next) {
    parseUpload(req, res, (error) => {
        if (error) {
            const tooLarge = error.code === 'LIMIT_FILE_SIZE';
            return res.status(tooLarge ? 413 : 400).json({
                error: tooLarge ? 'File is too large (max 20 MB)' : 'Invalid file upload',
            });
        }
        if (!req.file) return next();

        const detected = detectMediaType(req.file.buffer);
        if (!detected) return res.status(400).json({ error: 'Only JPEG, PNG, WebP, GIF, MP4, MOV or WebM files are allowed' });
        req.file.mimetype = detected;
        return next();
    });
}

const BannerRouter = express.Router();

// Reads are public (customer app). Changes: network administrators only (audit C3),
// checked before the upload is buffered.
const canManage = staffAccess.requireSuperuser();

BannerRouter.get('/', (req, res) => BannerMarketplace.all(req, res));
BannerRouter.get('/:id', (req, res) => BannerMarketplace.getById(req, res));

BannerRouter.post('/', canManage, bannerUpload, (req, res) => BannerMarketplace.create(req, res));

BannerRouter.put('/:id', canManage, bannerUpload, (req, res) => BannerMarketplace.update(req, res));
BannerRouter.patch('/:id', canManage, bannerUpload, (req, res) => BannerMarketplace.update(req, res));

BannerRouter.delete('/:id', canManage, (req, res) => BannerMarketplace.deactivate(req, res));

module.exports = BannerRouter;
