const express = require('express');
const bannerRouter = require('./banner');
const authRouter = require('./auth');

const marketplaceRouter = express.Router();

marketplaceRouter.use('/auth', authRouter);
marketplaceRouter.use('/banners', bannerRouter);

module.exports = marketplaceRouter;
