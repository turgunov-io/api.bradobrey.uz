const { pool } = require('../../config/postgres');
const { sendTestNotificationToClient } = require('../../services/marketplacePush');
const { createAdminAuth } = require('../../utils/adminAuth');
const { NETWORK_ROLES } = require('../../utils/employeeQualityAccess');
const { companyMarketplaceClientIdsSql, requireAdminCompany } = require('../../utils/marketplaceCompanyScope');

// Network-wide marketplace data (every client's phone, all reviews, push to
// any client): network roles only (admin_network, admin, super-manager). The
// role is loaded from the database by authorizeAdmin, never trusted from the
// JWT. admin_branch / merchant have no scoped use for these endpoints (dash
// merchant pages do not call them), so they are denied rather than scoped.
// MULTI_TENANCY B2: "network" = the admin's company. Clients are limited to
// those with a footprint in the company (utils/marketplaceCompanyScope.js),
// reviews to marketplace_reviews.company_id.
const authorizeNetworkAdmin = createAdminAuth({ roles: NETWORK_ROLES });

function pagination(req) {
  return {
    limit: Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 50, 1), 200),
    offset: Math.max(Number.parseInt(req.query?.offset, 10) || 0, 0),
  };
}

async function listMobileUsers(req, res) {
  const administrator = await authorizeNetworkAdmin(req, res);
  if (!administrator) return;
  const companyId = requireAdminCompany(administrator, res);
  if (!companyId) return;
  const { limit, offset } = pagination(req);
  const search = String(req.query?.q || '').trim();
  const active = String(req.query?.active || '').trim().toLowerCase();
  const params = [search ? `%${search}%` : null, active === 'true' ? true : active === 'false' ? false : null, limit, offset, companyId];

  try {
    const result = await pool.query(
      `select id, display_name, phone, language, is_active, created_at, last_login_at,
              count(*) over()::int as total_count
         from marketplace_clients
        where ($1::text is null or coalesce(display_name, '') ilike $1 or coalesce(phone, '') ilike $1)
          and ($2::boolean is null or is_active = $2)
          and id in (${companyMarketplaceClientIdsSql('$5')})
        order by created_at desc nulls last
        limit $3 offset $4`,
      params,
    );
    const count = result.rows[0]?.total_count || 0;
    return res.json({ items: result.rows.map(({ total_count, ...item }) => item), count, limit, offset });
  } catch (error) {
    console.error('[marketplace-admin] mobile users list failed', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

async function listReviews(req, res) {
  const administrator = await authorizeNetworkAdmin(req, res);
  if (!administrator) return;
  const companyId = requireAdminCompany(administrator, res);
  if (!companyId) return;
  const { limit, offset } = pagination(req);
  const search = String(req.query?.q || '').trim();
  const barberId = String(req.query?.barber_id || '').trim();
  const ratingValue = Number.parseInt(req.query?.rating, 10);
  const rating = Number.isInteger(ratingValue) && ratingValue >= 1 && ratingValue <= 5 ? ratingValue : null;
  const params = [search ? `%${search}%` : null, barberId || null, rating, limit, offset, companyId];

  try {
    const result = await pool.query(
      `select r.id, r.rating, r.comment, r.shop_response, r.shop_responded_at,
              r.created_at, r.updated_at,
              mc.id as client_id, coalesce(mc.display_name, mc.phone, 'Пользователь') as client_name,
              mc.phone as client_phone,
              r.barber_id, coalesce(br.name, 'Барбер не указан') as barber_name,
              r.barbershop_id, coalesce(mbs.name, 'Барбершоп не указан') as barbershop_name,
              count(*) over()::int as total_count
         from marketplace_reviews r
         left join marketplace_clients mc on mc.id = r.marketplace_client_id
         left join barbers br on br.id = r.barber_id
         left join marketplace_barbershops mbs on mbs.id = r.barbershop_id
        where ($1::text is null or coalesce(mc.display_name, '') ilike $1
               or coalesce(mc.phone, '') ilike $1 or coalesce(r.comment, '') ilike $1
               or coalesce(br.name, '') ilike $1)
          and ($2::uuid is null or r.barber_id = $2::uuid)
          and ($3::int is null or r.rating = $3::int)
          and r.company_id = $6::uuid
        order by r.created_at desc
        limit $4 offset $5`,
      params,
    );
    const count = result.rows[0]?.total_count || 0;
    return res.json({ items: result.rows.map(({ total_count, ...item }) => item), count, limit, offset });
  } catch (error) {
    console.error('[marketplace-admin] reviews list failed', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

async function sendTestNotification(req, res) {
  const administrator = await authorizeNetworkAdmin(req, res);
  if (!administrator) return;
  const companyId = requireAdminCompany(administrator, res);
  if (!companyId) return;

  const clientId = String(req.params?.id || '').trim();
  const title = String(req.body?.title || 'Тестовое уведомление').trim();
  const body = String(req.body?.body || 'Push-уведомления работают.').trim();
  if (!clientId || !title || !body || title.length > 120 || body.length > 500) {
    return res.status(400).json({ error: 'Valid title and body are required' });
  }

  const clientResult = await pool.query(
    `select id from marketplace_clients
      where id = $1 and id in (${companyMarketplaceClientIdsSql('$2')})
      limit 1`,
    [clientId, companyId],
  );
  if (!clientResult.rows[0]) return res.status(404).json({ error: 'Marketplace client not found' });

  try {
    const result = await sendTestNotificationToClient({ clientId, title, body });
    if (result.reason === 'provider_not_configured') {
      return res.status(503).json({ error: 'Push provider is not configured' });
    }
    if (result.reason === 'no_tokens') {
      return res.status(409).json({ error: 'This user has no registered mobile device' });
    }
    if (!result.sent) return res.status(502).json({ error: 'Push delivery failed' });
    return res.json({ sent: true, delivered: result.delivered, tokens: result.tokens });
  } catch (error) {
    console.error('[marketplace-admin] test notification failed', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

module.exports = { listMobileUsers, listReviews, sendTestNotification };
