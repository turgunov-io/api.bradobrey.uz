const kiosk = require('../../../models/kiosk');
const { normalizeId, parseBoolean } = require('./helpers');
const service = require('./service');

const handleError = (res, error) => {
  const status = error?.statusCode || error?.status || 500;
  return res.status(status).json({ error: error?.message || 'Internal server error' });
};

class MarketplaceCatalogController {
  async listBarbershops(req, res) {
    try {
      const active = parseBoolean(req.query?.active, true);
      const city = req.query?.city ?? null;
      const result = await service.listCatalogBarbershops({ active, city });
      return res.json(result);
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }

  async getBarbershop(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const item = await service.getCatalogBarbershop(id);
      return res.json({ item });
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }

  async listBranches(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const active = parseBoolean(req.query?.active, true);
      const result = await service.listCatalogBranches({ barbershopId: id, active });
      return res.json(result);
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }

  async branchDetails(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const result = await service.getBranchDetails(id);
      return res.json(result);
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }

  async branchBarbers(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const result = await service.listBranchBarbers(id);
      return res.json(result);
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }

  async branchServices(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const result = await service.listBranchServices(id);
      return res.json(result);
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }

  async paymentOptions(req, res) {
    try {
      const id = normalizeId(req.params?.id);
      if (!id) return res.status(400).json({ error: 'id is required' });
      const result = await service.getPaymentOptions(id);
      return res.json(result);
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }

  async quote(req, res) {
    try {
      const result = await service.quoteBooking(req.body || {});
      return res.json(result);
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }

  async availability(req, res) {
    try {
      const branchId = normalizeId(req.params?.id);
      if (!branchId) return res.status(400).json({ error: 'id is required' });

      const barberId = normalizeId(req.query?.barber_id);
      if (!barberId) return res.status(400).json({ error: 'barber_id is required' });

      const serviceIds = Array.isArray(req.query?.service_ids)
        ? req.query.service_ids.map(normalizeId).filter(Boolean)
        : typeof req.query?.service_ids === 'string'
          ? String(req.query.service_ids)
            .split(',')
            .map(normalizeId)
            .filter(Boolean)
          : [];

      const date = req.query?.date;

      const result = await service.listAvailability({
        branchId,
        barberId,
        serviceIds,
        date,
      });

      return res.json(result);
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }

  async createBooking(req, res) {
    try {
      const body = { ...(req.body || {}) };

      const idempotencyKey = req.get('Idempotency-Key');
      if (idempotencyKey && !body.idempotency_key) body.idempotency_key = idempotencyKey;

      // Backward compatible:
      // - allow `starts_at`/`ends_at` (new) while keeping legacy request body valid
      // - kiosk.book ignores unknown fields, but it can persist these after DB migration + kiosk update
      if (body.starts_at && !body.scheduled_start_at) body.scheduled_start_at = body.starts_at;
      if (body.ends_at && !body.scheduled_end_at) body.scheduled_end_at = body.ends_at;

      if (body.certificate_code && !body.payment_method) {
        body.payment_method = 'certificate';
      }

      req.body = {
        ...body,
        source: 'site',
      };

      // Same-day enforcement (only when client provided a concrete slot)
      if (req.body.scheduled_start_at) {
        const quote = await service.quoteBooking(req.body);
        const startsAt = new Date(req.body.scheduled_start_at);
        service.ensureSameDay({ startsAt, branchTimezone: quote?.branch?.timezone });
      }

      return kiosk.book(req, res);
    } catch (error) {
      console.error(error);
      return handleError(res, error);
    }
  }
}

module.exports = new MarketplaceCatalogController();
