const express = require('express');
const catalog = require('../../modules/marketplace/catalog/controller');

const router = express.Router();

router.get('/barbershops', (req, res) => catalog.listBarbershops(req, res));
router.get('/barbershops/:id/payment-options', (req, res) => catalog.paymentOptions(req, res));
router.get('/barbershops/:id/branches', (req, res) => catalog.listBranches(req, res));
router.get('/barbershops/:id', (req, res) => catalog.getBarbershop(req, res));
router.get('/branches/:id/barbers', (req, res) => catalog.branchBarbers(req, res));
router.get('/branches/:id/services', (req, res) => catalog.branchServices(req, res));
router.get('/branches/:id', (req, res) => catalog.branchDetails(req, res));
router.get('/branches/:id/availability', (req, res) => catalog.availability(req, res));
router.post('/bookings/quote', (req, res) => catalog.quote(req, res));
router.post('/bookings', (req, res) => catalog.createBooking(req, res));

module.exports = router;
