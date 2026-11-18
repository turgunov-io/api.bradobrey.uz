const { db, pool } = require("../config/postgres");
const { toAbsolutePublicUrl } = require("../config/uploads");
const { uploadBufferImageWithFolder } = require("../composable/uploadImage");
const { companyIdOfBranch, requireTenantCompany, sameId } = require("../utils/companyScope");

const DEFAULT_CATEGORY_LABEL = "Uncategorized";

const normalizeCategory = (category) => {
    if (category === undefined || category === null) return null;
    const trimmed = String(category).trim();
    return trimmed.length ? trimmed : null;
};

const normalizeText = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = String(value).trim();
    return trimmed.length ? trimmed : null;
};

const normalizeImageUrl = (req, value) => {
    const normalized = normalizeText(value);
    return normalized ? toAbsolutePublicUrl(normalized, req) : normalized;
};

const serviceItem = (req, service) => {
    if (!service) return service;
    return {
        ...service,
        image: service.image ? toAbsolutePublicUrl(service.image, req) : null,
    };
};

const serviceItems = (req, services = []) => (services || []).map((service) => serviceItem(req, service));

const parseBoolean = (value, fallback = undefined) => {
    if (value === undefined) return fallback;
    if (value === null) return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;

    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    return fallback;
};

const uploadServiceImage = async (req) => {
    if (!req.file) return undefined;

    const { data, error } = await uploadBufferImageWithFolder(
        req.file.buffer,
        req.file.mimetype || "image/png",
        "services",
        "service"
    );

    if (error) throw new Error(error.message || "Failed to upload service image");
    return data?.publicUrl || null;
};

const groupServicesByCategory = (services = []) => {
    const groups = new Map();

    for (const service of services) {
        const key = service && service.category
            ? String(service.category).trim()
            : "";
        const category = key || DEFAULT_CATEGORY_LABEL;

        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(service);
    }

    return Array.from(groups.entries()).map(([category, services]) => ({
        category,
        services,
    }));
};

// Company scope (MULTI_TENANCY Phase 1 B2a): every read and write is limited
// to services.company_id = the tenant company (req.tenant, never the body).
// A service with branch_id NULL is shared by all branches of ITS company.
// Branch scope (MULTI_TENANCY 0.4) on top: network roles (company-wide scope)
// manage every service of the company; other roles read services of their
// allowed branches plus the company's shared services, and may only modify
// services of their allowed branches.
// scope: null = unrestricted (internal), otherwise an array of branch ids.
const inScope = (scope, branchId) => (
    branchId !== null && branchId !== undefined && scope.includes(String(branchId))
);
const canReadService = (scope, branchId) => (
    scope === null || branchId === null || branchId === undefined || inScope(scope, branchId)
);
// Network roles hold a company-wide scope (utils/adminAuth isCompanyWideScope)
// and edit company-level services (branch_id NULL) — of their company only,
// because every query below is filtered by company_id.
const canModifyService = (scope, branchId) => scope === null
    || inScope(scope, branchId)
    || (scope?.companyWide === true && (branchId === null || branchId === undefined));

// routers/services.js resolves req.branchScope (from the DB-loaded actor)
// after the staffAccess guard. A request that went through the guard but has
// no resolved scope fails closed; direct internal calls stay unrestricted.
const resolveScope = async (req) => {
    if (req?.branchScope !== undefined) return req.branchScope;
    return req?.staffAccess ? [] : null;
};

const SCOPE_FORBIDDEN = { error: "Service is outside your branch scope" };
const COMPANY_FORBIDDEN = { code: "BRANCH_COMPANY_MISMATCH", error: "Branch belongs to another company" };

// A target branch must belong to the tenant company (the DB guard trigger
// rejects it too; this gives a clean 403 instead of a 500).
const branchInCompany = async (branchId, companyId) => {
    if (branchId === null || branchId === undefined) return true;
    return sameId(await companyIdOfBranch(branchId), companyId);
};

// marketplace_barbershops.company_id is 1:1 with the company (D1).
const barbershopInCompany = async (barbershopId, companyId) => {
    if (!barbershopId) return true;
    const { data, error } = await db.from("marketplace_barbershops").select("id, company_id").eq("id", barbershopId).maybeSingle();
    if (error) throw new Error(error.message);
    return sameId(data?.company_id, companyId);
};

const loadServiceBranch = async (id, companyId) => {
    const { data, error } = await db.from("services").select("id, branch_id").eq("id", id).eq("company_id", companyId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
};

class Services {
    async reorder(req, res) {
        const items = req.body?.items;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!Array.isArray(items) || !items.length || items.some(item =>
            !item || typeof item.id !== 'string' || !uuid.test(item.id) ||
            !Number.isInteger(item.sort_order) || item.sort_order < 0 || item.sort_order > 2147483647 ||
            (item.category !== undefined && item.category !== null && typeof item.category !== 'string')
        ) || new Set(items.map(item => item.id.toLowerCase())).size !== items.length) {
            return res.status(400).json({ error: 'items must contain unique service ids, categories and non-negative integer sort_order values' });
        }
        const normalizedItems = items.map(item => ({
            id: item.id,
            category: normalizeCategory(item.category),
            sort_order: item.sort_order,
        }));
        const companyId = requireTenantCompany(req, res);
        if (!companyId) return undefined;
        try {
            const scope = await resolveScope(req);
            if (scope !== null) {
                const existing = await pool.query(
                    'SELECT id, branch_id FROM services WHERE id = ANY($1::uuid[]) AND company_id = $2',
                    [normalizedItems.map(item => item.id), companyId]
                );
                if (existing.rows.some(row => !canModifyService(scope, row.branch_id))) {
                    return res.status(403).json(SCOPE_FORBIDDEN);
                }
            }
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const result = await client.query(`
                UPDATE services AS s SET sort_order = i.sort_order, category = i.category, updated_at = now()
                FROM jsonb_to_recordset($1::jsonb) AS i(id uuid, category text, sort_order integer)
                WHERE s.id = i.id AND s.company_id = $2 RETURNING s.id
            `, [JSON.stringify(normalizedItems), companyId]);
            if (result.rowCount !== normalizedItems.length) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Service list changed. Refresh and try again.' });
            }
            await client.query('COMMIT');
            return res.json({ updated: result.rowCount });
        } catch (error) {
            if (client) await client.query('ROLLBACK');
            return res.status(500).json({ error: error.message });
        } finally {
            client?.release();
        }
    }

    async list(req, res) {
        const { active, grouped, include_inactive } = req.query || {};
        const companyId = requireTenantCompany(req, res);
        if (!companyId) return undefined;

        let query = db.from("services").select("*").eq("company_id", companyId);

        if (active !== undefined) {
            const activeFlag = String(active).toLowerCase() === "true" || active === "1";
            query = query.eq("is_active", activeFlag);
        } else if (!parseBoolean(include_inactive, false)) {
            query = query.eq("is_active", true);
        }

        const { data, error } = await query
            .order("category", { ascending: true, nullsFirst: false })
            .order("sort_order", { ascending: true, nullsFirst: false })
            .order("base_price", { ascending: true })
            .order("name", { ascending: true });

        if (error) return res.status(500).json({ error: error.message });

        let scope;
        try {
            scope = await resolveScope(req);
        } catch (scopeError) {
            return res.status(500).json({ error: scopeError.message });
        }
        const visible = (data || []).filter((service) => canReadService(scope, service.branch_id));
        const items = serviceItems(req, visible);
        const categories = groupServicesByCategory(items);

        if (grouped === "true" || grouped === "1") {
            return res.json({ categories });
        }

        return res.json({ data: items, services: items, categories });
    }

    async getById(req, res) {
        const { id } = req.params || {};
        if (!id) return res.status(400).json({ error: "Service id is required" });
        const companyId = requireTenantCompany(req, res);
        if (!companyId) return undefined;

        const { data, error } = await db
            .from("services")
            .select("*")
            .eq("id", id)
            .eq("company_id", companyId)
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: "Service not found" });

        try {
            if (!canReadService(await resolveScope(req), data.branch_id)) {
                return res.status(404).json({ error: "Service not found" });
            }
        } catch (scopeError) {
            return res.status(500).json({ error: scopeError.message });
        }

        return res.json({ entry: serviceItem(req, data) });
    }

    async create(req, res) {
        const {
            base_price,
            branch_id,
            category,
            category_name,
            duration,
            duration_minutes,
            image,
            is_active = true,
            marketplace_barbershop_id,
            name,
            price,
        } = req.body || {};

        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: "name is required" });
        }
        const durationValue = Number(duration_minutes ?? duration);
        if (!Number.isInteger(durationValue) || durationValue <= 0) {
            return res.status(400).json({ error: "duration_minutes must be a positive integer" });
        }
        const priceInput = req.body?.base_price ?? price;
        const priceValue = priceInput === null || priceInput === undefined || priceInput === ""
            ? null
            : Number(priceInput);
        if (priceValue !== null && (!Number.isFinite(priceValue) || priceValue < 0)) {
            return res.status(400).json({ error: "base_price must be a non-negative number" });
        }

        const companyId = requireTenantCompany(req, res);
        if (!companyId) return undefined;

        let targetBranchId = normalizeText(branch_id);
        // Only network roles (company-wide scope) may link a marketplace
        // merchant, and only their own company's barbershop.
        let marketplaceBarbershopId = null;
        try {
            const scope = await resolveScope(req);
            const companyWide = scope === null || scope?.companyWide === true;
            if (companyWide) marketplaceBarbershopId = normalizeText(marketplace_barbershop_id);
            if (!companyWide) {
                // Branch-level staff cannot create company-wide (NULL branch)
                // services; default to their home branch when none is given.
                targetBranchId = targetBranchId || normalizeText(req.staffAccess?.actor?.branch_id);
                if (!targetBranchId) return res.status(422).json({ error: "branch_id is required" });
            }
            if (scope !== null && !canModifyService(scope, targetBranchId)) return res.status(403).json(SCOPE_FORBIDDEN);
            if (!(await branchInCompany(targetBranchId, companyId))) return res.status(403).json(COMPANY_FORBIDDEN);
            if (!(await barbershopInCompany(marketplaceBarbershopId, companyId))) return res.status(403).json(COMPANY_FORBIDDEN);
        } catch (scopeError) {
            return res.status(500).json({ error: scopeError.message });
        }

        let uploadedImageUrl;
        try {
            uploadedImageUrl = await uploadServiceImage(req);
        } catch (uploadError) {
            return res.status(500).json({ error: uploadError.message });
        }

        const normalizedCategory = normalizeCategory(category ?? category_name);

        const { data, error } = await db
            .from("services")
            .insert({
                base_price: priceValue,
                branch_id: targetBranchId,
                company_id: companyId,
                category: normalizedCategory,
                duration_minutes: durationValue,
                image: uploadedImageUrl !== undefined
                    ? normalizeImageUrl(req, uploadedImageUrl)
                    : normalizeImageUrl(req, image),
                is_active: parseBoolean(is_active, true),
                marketplace_barbershop_id: marketplaceBarbershopId,
                name: String(name).trim(),
            })
            .select("*")
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(serviceItem(req, data));
    }

    async update(req, res) {
        const { id } = req.params || {};
        if (!id) return res.status(400).json({ error: "Service id is required" });

        const {
            base_price,
            branch_id,
            category,
            category_name,
            duration,
            duration_minutes,
            image,
            is_active,
            marketplace_barbershop_id,
            name,
            price,
        } = req.body || {};
        const update = {};

        if (name !== undefined) {
            if (!String(name).trim()) return res.status(400).json({ error: "name cannot be empty" });
            update.name = String(name).trim();
        }
        if (duration_minutes !== undefined || duration !== undefined) {
            const durationValue = Number(duration_minutes ?? duration);
            if (!Number.isInteger(durationValue) || durationValue <= 0) {
                return res.status(400).json({ error: "duration_minutes must be a positive integer" });
            }
            update.duration_minutes = durationValue;
        }
        if (base_price !== undefined || price !== undefined) {
            const priceInput = base_price ?? price;
            const priceValue = priceInput === null || priceInput === "" ? null : Number(priceInput);
            if (priceValue !== null && (!Number.isFinite(priceValue) || priceValue < 0)) {
                return res.status(400).json({ error: "base_price must be a non-negative number or null" });
            }
            update.base_price = priceValue;
        }

        if (is_active !== undefined) {
            const activeFlag = parseBoolean(is_active, null);
            if (activeFlag === null) return res.status(400).json({ error: "is_active must be a boolean" });
            update.is_active = activeFlag;
        }

        // marketplace_barbershop_id links a service to a marketplace merchant;
        // only network roles (scope null) may set it, others are ignored.
        const companyId = requireTenantCompany(req, res);
        if (!companyId) return undefined;
        let canSetMarketplace = false;
        try {
            const scope = await resolveScope(req);
            canSetMarketplace = scope === null || scope?.companyWide === true;
            const existing = await loadServiceBranch(id, companyId);
            if (!existing) return res.status(404).json({ error: "Service not found" });
            if (scope !== null) {
                if (!canModifyService(scope, existing.branch_id)) return res.status(403).json(SCOPE_FORBIDDEN);
                if (branch_id !== undefined && !canModifyService(scope, normalizeText(branch_id))) {
                    return res.status(403).json(SCOPE_FORBIDDEN);
                }
            }
            if (branch_id !== undefined && !(await branchInCompany(normalizeText(branch_id), companyId))) {
                return res.status(403).json(COMPANY_FORBIDDEN);
            }
            if (canSetMarketplace && marketplace_barbershop_id !== undefined
                && !(await barbershopInCompany(normalizeText(marketplace_barbershop_id), companyId))) {
                return res.status(403).json(COMPANY_FORBIDDEN);
            }
        } catch (scopeError) {
            return res.status(500).json({ error: scopeError.message });
        }

        let uploadedImageUrl;
        try {
            uploadedImageUrl = await uploadServiceImage(req);
        } catch (uploadError) {
            return res.status(500).json({ error: uploadError.message });
        }

        if (uploadedImageUrl !== undefined) {
            update.image = normalizeImageUrl(req, uploadedImageUrl);
        } else if (image !== undefined) {
            update.image = normalizeImageUrl(req, image);
        }

        if (category !== undefined || category_name !== undefined) {
            update.category = normalizeCategory(category ?? category_name);
        }

        if (branch_id !== undefined) {
            update.branch_id = normalizeText(branch_id);
        }

        if (canSetMarketplace && marketplace_barbershop_id !== undefined) {
            update.marketplace_barbershop_id = normalizeText(marketplace_barbershop_id);
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        update.updated_at = new Date().toISOString();

        const { data, error } = await db
            .from("services")
            .update(update)
            .eq("id", id)
            .eq("company_id", companyId)
            .select("*")
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: "Service not found" });

        return res.json(serviceItem(req, data));
    }

    async remove(req, res) {
        const id = normalizeText(
            req.params?.id ?? req.body?.id ?? req.body?.service_id ?? req.query?.id ?? req.query?.service_id
        );
        if (!id) return res.status(400).json({ error: "Service id is required" });
        const companyId = requireTenantCompany(req, res);
        if (!companyId) return undefined;

        try {
            const scope = await resolveScope(req);
            const existing = await loadServiceBranch(id, companyId);
            if (!existing) return res.status(404).json({ error: "Service not found" });
            if (scope !== null && !canModifyService(scope, existing.branch_id)) return res.status(403).json(SCOPE_FORBIDDEN);
        } catch (scopeError) {
            return res.status(500).json({ error: scopeError.message });
        }

        const { data, error } = await db
            .from("services")
            .delete()
            .eq("id", id)
            .eq("company_id", companyId)
            .select("id")
            .maybeSingle();

        if (error) {
            if (String(error.code) === "23503") {
                const { data: softDeleted, error: softDeleteError } = await db
                    .from("services")
                    .update({ is_active: false, updated_at: new Date().toISOString() })
                    .eq("id", id)
                    .eq("company_id", companyId)
                    .select("id")
                    .maybeSingle();

                if (softDeleteError) return res.status(500).json({ error: softDeleteError.message });
                if (!softDeleted) return res.status(404).json({ error: "Service not found" });

                return res.json({ deleted: true, id: softDeleted.id, soft_deleted: true });
            }

            return res.status(500).json({ error: error.message });
        }
        if (!data) return res.status(404).json({ error: "Service not found" });

        return res.json({ deleted: true, id: data.id });
    }

    // backwards compatibility
    async getAll(req, res) {
        return this.list(req, res);
    }
}

module.exports = new Services();
module.exports.canReadService = canReadService;
module.exports.canModifyService = canModifyService;
