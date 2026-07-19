const express = require('express');
const warehouse = require('../models/warehouse');

const router = express.Router();

router.get('/summary', (req, res) => warehouse.summary(req, res));

router.get('/categories', (req, res) => warehouse.listCategories(req, res));
router.post('/categories', (req, res) => warehouse.createCategory(req, res));
router.patch('/categories/:id', (req, res) => warehouse.updateCategory(req, res));
router.delete('/categories', (req, res) => warehouse.deleteCategory(req, res));
router.delete('/categories/:id', (req, res) => warehouse.deleteCategory(req, res));

router.get('/positions', (req, res) => warehouse.listPositions(req, res));
router.post('/positions', (req, res) => warehouse.createPosition(req, res));
router.patch('/positions/:id', (req, res) => warehouse.updatePosition(req, res));
router.delete('/positions', (req, res) => warehouse.deletePosition(req, res));
router.delete('/positions/:id', (req, res) => warehouse.deletePosition(req, res));

router.get('/templates', (req, res) => warehouse.listTemplates(req, res));
router.get('/templates/:id', (req, res) => warehouse.getTemplate(req, res));
router.post('/templates', (req, res) => warehouse.createTemplate(req, res));
router.patch('/templates/:id', (req, res) => warehouse.updateTemplate(req, res));
router.delete('/templates', (req, res) => warehouse.deleteTemplate(req, res));
router.delete('/templates/:id', (req, res) => warehouse.deleteTemplate(req, res));

router.get('/stocks', (req, res) => warehouse.listStocks(req, res));
router.get('/stock', (req, res) => warehouse.listStocks(req, res));
router.post('/stocks', (req, res) => warehouse.setStock(req, res));
router.put('/stocks', (req, res) => warehouse.setStock(req, res));

router.get('/purchases', (req, res) => warehouse.listPurchases(req, res));
router.get('/purchases/:id', (req, res) => warehouse.getPurchase(req, res));
router.post('/purchases', (req, res) => warehouse.createPurchase(req, res));
router.patch('/purchases/:id', (req, res) => warehouse.updatePurchase(req, res));
router.delete('/purchases', (req, res) => warehouse.deletePurchase(req, res));
router.delete('/purchases/:id', (req, res) => warehouse.deletePurchase(req, res));

module.exports = router;
