const express = require('express');
const bannerRouter = require('./banner');
const authRouter = require('./auth');
const profileRouter = require('./profile');
const barbershopsRouter = require('./barbershops');

const marketplaceRouter = express.Router();

marketplaceRouter.use('/auth', authRouter);
marketplaceRouter.use('/profile', profileRouter);
marketplaceRouter.use('/banners', bannerRouter);
marketplaceRouter.use('/barbershops', barbershopsRouter);

module.exports = marketplaceRouter;
