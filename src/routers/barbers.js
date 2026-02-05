const express = require("express");
const multer = require("multer");
const router = express.Router();

const barbers = require('../models/barbers')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

router.post('/login', (req, res) => barbers.login(req, res));
router.get("/me", (req, res) => barbers.me(req, res));
router.patch("/me", upload.single('file'), (req, res) => barbers.updateProfile(req, res));
router.get("/queue", (req, res) => barbers.myQueue(req, res));
router.get("/queue/:id", (req, res) => barbers.getQueueById(req, res));
router.patch("/queue/:id", (req, res) => barbers.updateQueue(req, res));

router.patch('/queue/:id/call', (req, res) => barbers.callNext(req, res));
router.patch("/queue/:id/start", (req, res) => barbers.startQueue(req, res));
router.patch("/queue/:id/complete", (req, res) => barbers.completeQueueEntry(req, res));
router.patch("/queue/:id/edit-before-complete", (req, res) => barbers.editBeforeComplete(req, res));

module.exports = router;
