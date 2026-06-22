const express = require('express');
const merchant = require('../models/merchant');

const router = express.Router();

router.get('/me', (req, res) => merchant.me(req, res));
router.get('/dashboard', (req, res) => merchant.dashboard(req, res));
router.get('/history', (req, res) => merchant.history(req, res));
router.get('/orders/active', (req, res) => merchant.activeOrders(req, res));

router.get('/branches', (req, res) => merchant.listBranches(req, res));
router.post('/branches', (req, res) => merchant.createBranch(req, res));
router.patch('/branches/:id', (req, res) => merchant.updateBranch(req, res));
router.delete('/branches/:id', (req, res) => merchant.deleteBranch(req, res));

router.get('/barbers', (req, res) => merchant.listBarbers(req, res));
router.post('/barbers', (req, res) => merchant.createBarber(req, res));
router.patch('/barbers/:id', (req, res) => merchant.updateBarber(req, res));
router.delete('/barbers/:id', (req, res) => merchant.deleteBarber(req, res));

router.get('/categories', (req, res) => merchant.listCategories(req, res));
router.post('/categories', (req, res) => merchant.createCategory(req, res));
router.patch('/categories/:id', (req, res) => merchant.updateCategory(req, res));
router.delete('/categories/:id', (req, res) => merchant.deleteCategory(req, res));

router.get('/services', (req, res) => merchant.listServices(req, res));
router.post('/services', (req, res) => merchant.createService(req, res));
router.patch('/services/:id', (req, res) => merchant.updateService(req, res));
router.delete('/services/:id', (req, res) => merchant.deleteService(req, res));

module.exports = router;

