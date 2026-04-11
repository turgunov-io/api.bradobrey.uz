import * as express from 'express';

import {
  registerMarketplaceClient,
  verifyMarketplaceClient,
} from '../../controllers/marketplace/auth.controller';

const router = express.Router();

router.post('/register', registerMarketplaceClient);
router.post('/verify', verifyMarketplaceClient);

export default router;

