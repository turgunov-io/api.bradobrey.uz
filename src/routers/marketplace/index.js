const express = require('express');
const bannerRouter = require('./banner');
const authRouter = require('./auth');
const clientsRouter = require('./clients');
const profileRouter = require('./profile');
const barbershopsRouter = require('./barbershops');
const catalogRouter = require('./catalog');
const complianceRouter = require('./compliance');
const adminRouter = require('./admin');

const marketplaceRouter = express.Router();

marketplaceRouter.use('/catalog', catalogRouter);
marketplaceRouter.use('/auth', authRouter);
marketplaceRouter.use('/clients', clientsRouter);
marketplaceRouter.use('/profile', profileRouter);
marketplaceRouter.use('/banners', bannerRouter);
marketplaceRouter.use('/barbershops', barbershopsRouter);
marketplaceRouter.use('/compliance', complianceRouter);
marketplaceRouter.use('/admin', adminRouter);

module.exports = marketplaceRouter;
