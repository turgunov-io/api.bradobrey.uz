const express = require("express");
const branches = require("../models/branches");
const location = require('../services/barberLocation');

const router = express.Router();

router.get("/", (req, res) => branches.list(req, res));
router.get("/:id", (req, res) => branches.getById(req, res));
router.post("/", (req, res) => branches.create(req, res));
router.patch("/:id", (req, res) => branches.update(req, res));
router.delete("/:id", (req, res) => branches.remove(req, res));
router.post("/:id/activate", (req, res) => branches.setActive(req, res, true));
router.post("/:id/deactivate", (req, res) => branches.setActive(req, res, false));
router.get('/:id/location', (req, res) => location.getBranchLocation(req, res));
router.put('/:id/location', (req, res) => location.saveBranchLocation(req, res));

module.exports = router;
