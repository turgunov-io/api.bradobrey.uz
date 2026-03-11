const express = require('express');
const bannerRouter = require('./banner');

const marketplaceRouter = express.Router();

marketplaceRouter.use('/banners', bannerRouter);

module.exports = marketplaceRouter;
