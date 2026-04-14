const express = require('express');
const bannerRouter = require('./banner');
const authRouter = require('./auth');
const profileRouter = require('./profile');

const marketplaceRouter = express.Router();

marketplaceRouter.use('/auth', authRouter);
marketplaceRouter.use('/profile', profileRouter);
marketplaceRouter.use('/banners', bannerRouter);

module.exports = marketplaceRouter;
