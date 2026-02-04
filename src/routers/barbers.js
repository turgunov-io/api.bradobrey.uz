const express = require("express");
const router = express.Router();

const barbers = require('../models/barbers')

router.post('/login', (req, res) => barbers.login(req, res));
router.get("/me", (req, res) => barbers.me(req, res));
router.get("/queue", (req, res) => barbers.myQueue(req, res));
router.get("/queue/:id", (req, res) => barbers.getQueueById(req, res));
router.patch("/queue/:id", (req, res) => barbers.updateQueue(req, res));
router.get("/")

module.exports = router;
