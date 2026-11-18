const express = require("express");
const multer = require("multer");
const branches = require("../models/branches");
const location = require('../services/barberLocation');
const { staffAccess } = require('../middleware/staffAccess');

const router = express.Router();

// Optional branch photo (multipart field "photo"); JSON requests pass through untouched.
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PHOTO_MAX_BYTES } }).single("photo");

// Reads: any signed-in account (dashboard branch selector, merchant pages).
// Writes: network administrators only; the guard runs before multer so
// anonymous callers cannot upload. Location routes authorize themselves.
const canRead = staffAccess.authenticated();
const canWrite = staffAccess.requireSuperuser();

router.get("/", canRead, (req, res) => branches.list(req, res));
router.get("/:id", canRead, (req, res) => branches.getById(req, res));
router.post("/", canWrite, photoUpload, (req, res) => branches.create(req, res));
router.patch("/:id", canWrite, photoUpload, (req, res) => branches.update(req, res));
router.delete("/:id", canWrite, (req, res) => branches.remove(req, res));
router.post("/:id/activate", canWrite, (req, res) => branches.setActive(req, res, true));
router.post("/:id/deactivate", canWrite, (req, res) => branches.setActive(req, res, false));
router.get('/:id/location', (req, res) => location.getBranchLocation(req, res));
router.put('/:id/location', (req, res) => location.saveBranchLocation(req, res));

module.exports = router;
