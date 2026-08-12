const express = require("express");
const multer = require("multer");
const router = express.Router();

const barbers = require('../models/barbers')
const verifix = require('../models/verifix')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

router.get("/", (req, res) => barbers.list(req, res));
router.post('/register', upload.single('file'), (req, res) => barbers.register(req, res));
router.post('/login', (req, res) => barbers.login(req, res));
router.post('/admin/login', (req, res) => barbers.adminLogin(req, res));
router.post('/logout', (req, res) => barbers.logout(req, res));
router.get("/me", (req, res) => barbers.me(req, res));
router.patch("/me", upload.single('file'), (req, res) => barbers.updateProfile(req, res));
router.get("/queue", (req, res) => barbers.myQueue(req, res));
router.get("/queue/:id/reassign-options", (req, res) => barbers.queueReassignOptions(req, res));
router.patch("/queue/:id/reassign", (req, res) => barbers.reassignQueue(req, res));
router.get("/queue/:id", (req, res) => barbers.getQueueById(req, res));
router.patch("/queue/:id", (req, res) => barbers.updateQueue(req, res));

router.patch('/queue/:id/call', (req, res) => barbers.callNext(req, res));
router.patch("/queue/:id/start", (req, res) => barbers.startQueue(req, res));
router.patch("/queue/:id/complete", (req, res) => barbers.completeQueueEntry(req, res));
router.patch("/queue/:id/edit-before-complete", (req, res) => barbers.editBeforeComplete(req, res));
router.patch("/queue/:id/no-show", (req, res) => barbers.markNoShow(req, res));
router.patch("/queue/:id/not-in-time", (req, res) => barbers.markNotInTime(req, res));

router.post("/break", (req, res) => barbers.takeBreak(req, res));
router.post("/return", (req, res) => barbers.returnFromBreak(req, res));
router.post("/shift/start", (req, res) => verifix.startShift(req, res));
router.post("/shift/end", (req, res) => verifix.endShift(req, res));
router.patch("/:id/archive", (req, res) => barbers.archiveEmployee(req, res));
router.patch("/:id/restore", (req, res) => barbers.restoreEmployee(req, res));
router.patch("/:id", upload.single('file'), (req, res) => barbers.updateEmployee(req, res));
router.delete("/:id", (req, res) => barbers.removeEmployee(req, res));

module.exports = router;
