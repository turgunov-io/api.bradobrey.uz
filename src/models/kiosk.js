const { supabase } = require("../config/supabase");
const jwt = require("jsonwebtoken");

const {
    applyPromoDiscount,
    getWalletBalance,
    spendCashback,
    refundCashbackSpend,
    roundMoney,
} = require("../composable/cashback");

const STALE_QUEUE_HOURS = 9;
const DEFAULT_SERVICE_CATEGORY = "Uncategorized";
const OPERATIONAL_BARBER_ROLES = ['barber', 'super-barber'];

const normalizePhone = (phoneInput) => {
    const raw = String(phoneInput || '').trim();
    if (!raw) return null;

    const cleaned = raw.replace(/[\s()-]/g, '');

    if (cleaned.startsWith('+')) return cleaned;
    if (/^\d+$/.test(cleaned)) {
        if (cleaned.startsWith('998') && cleaned.length === 12) return `+${cleaned}`;
        if (cleaned.length === 9) return `+998${cleaned}`;
        if (cleaned.startsWith('0') && cleaned.length === 10) return `+998${cleaned.slice(1)}`;
    }

    return cleaned;
};

const isValidE164 = (phone) => /^\+\d{7,15}$/.test(phone || '');

const MARKETPLACE_ROLE = 'marketplace';

const getBearerToken = (req) => {
    const authHeader = req.headers.authorization || '';
    return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
};

const verifyJwt = (token) => {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET is not configured');
    return jwt.verify(token, jwtSecret);
};

const groupServicesByCategory = (services = []) => {
    const categories = new Map();

    for (const service of services) {
        const category = service && service.category
            ? String(service.category).trim()
            : "";
        const key = category || DEFAULT_SERVICE_CATEGORY;

        if (!categories.has(key)) categories.set(key, []);
        categories.get(key).push(service);
    }

    return Array.from(categories.entries()).map(([category, services]) => ({
        category,
        services,
    }));
};

const cleanupStaleQueuesForBranch = async (branchId) => {
    if (!branchId) return null;
    const cutoffIso = new Date(Date.now() - STALE_QUEUE_HOURS * 60 * 60 * 1000).toISOString();
    return supabase
        .from('queue_entries')
        .update({ status: 'no_show', finished_at: new Date().toISOString() })
        .eq('branch_id', branchId)
        .lte('created_at', cutoffIso)
        .in('status', ['waiting', 'called', 'swapped'])
        .select('id');
};

class Kiosk {
    health(_req, res) {
        return res.json({ status: "ok" });
    }

    async config(_req, res) {
        const { data, error } = await supabase
            .from("branches")
            .select("id, name, address");

        if (error || !data) {
            return res.status(500).json({ error: error?.message || "Failed to load branches" });
        }

        return res.status(200).json({ entry: data });
    }

    async register(req, res) {
        const { branch_id, device_name } = req.body || {};

        if (!branch_id || !device_name) {
            return res.status(400).json({ error: "branch_id and device_name are required" });
        }

        const { data: branch, error: branchError } = await supabase
            .from("branches")
            .select("id")
            .eq("id", branch_id)
            .maybeSingle();

        if (branchError) {
            return res.status(500).json({ error: branchError.message });
        }
        if (!branch) {
            return res.status(404).json({ error: "Branch not found" });
        }

        const { error: deleteError } = await supabase
            .from("kiosks")
            .delete()
            .eq("branch_id", branch_id);

        if (deleteError) {
            return res.status(500).json({ error: deleteError.message });
        }

        const { data: inserted, error: insertError } = await supabase
            .from("kiosks")
            .insert({
                branch_id,
                device_name,
            })
            .select("id, branch_id, device_name")
            .maybeSingle();

        if (insertError) {
            return res.status(500).json({ error: insertError.message });
        }

        return res.status(201).json({ branch_id: inserted.branch_id });
    }

    async barbers(req, res) {
        const { branch_id } = req.params || {};

        if (!branch_id) {
            return res.status(400).json({ error: "branch_id is required" });
        }

        const cutoffDate = new Date(Date.now() - STALE_QUEUE_HOURS * 60 * 60 * 1000);

        try {
            await cleanupStaleQueuesForBranch(branch_id);
        } catch (e) {
            console.error('stale queue cleanup failed:', e.message);
        }

        const { data: barbers, error: barbersError } = await supabase
            .from("barbers")
            .select("id, name, branch_id, photo_url, is_on_shift, is_active")
            .eq("branch_id", branch_id);

        if (barbersError) {
            return res.status(500).json({ error: barbersError.message });
        }

        const barberIds = (barbers || []).map((barber) => barber.id).filter(Boolean);
        let allowedBarberIds = new Set(barberIds);

        if (barberIds.length) {
            const { data: users, error: usersError } = await supabase
                .from('users')
                .select('id, role')
                .in('id', barberIds)
                .in('role', OPERATIONAL_BARBER_ROLES);

            if (usersError) {
                return res.status(500).json({ error: usersError.message });
            }

            allowedBarberIds = new Set((users || []).map((user) => user.id));
        }

        const visibleBarbers = (barbers || []).filter((barber) => allowedBarberIds.has(barber.id));

        const { data: rawQueues, error: queuesError } = await supabase
            .from("queue_entries")
            .select("id, barber_id, client_id, status, created_at, service_ids") // 🔥 ADDED service_ids
            .eq("branch_id", branch_id);

        if (queuesError) {
            return res.status(500).json({ error: queuesError.message });
        }

        const queues = (rawQueues || []).filter((entry) => {
            if (['completed', 'no_show', 'not_in_time'].includes(entry.status)) {
                return false;
            }
            if (!entry?.created_at) return true;
            if (['waiting', 'called', 'swapped'].includes(entry.status)) {
                return new Date(entry.created_at) >= cutoffDate;
            }
            return true;
        });

        const allServiceIds = Array.from(
            new Set(
                (queues || [])
                    .flatMap(q => q.service_ids || [])
                    .filter(Boolean)
            )
        );

        let servicesById = {};
        if (allServiceIds.length) {
            const { data: services, error: servicesError } = await supabase
                .from("services")
                .select("id, duration_minutes, name")
                .in("id", allServiceIds);

            if (servicesError) {
                return res.status(500).json({ error: servicesError.message });
            }

            servicesById = (services || []).reduce((acc, service) => {
                acc[service.id] = service.duration_minutes || 0;
                return acc;
            }, {});
        }

        const clientIds = Array.from(
            new Set((queues || []).map((q) => q.client_id).filter(Boolean))
        );

        let clientsById = {};
        if (clientIds.length) {
            const { data: clients, error: clientsError } = await supabase
                .from("clients")
                .select("id, name")
                .in("id", clientIds);

            if (clientsError) {
                return res.status(500).json({ error: clientsError.message });
            }

            clientsById = (clients || []).reduce((acc, client) => {
                acc[client.id] = client.name;
                return acc;
            }, {});
        }

        const queuesByBarber = {};
        const waitingTimeByBarber = {};

        for (const entry of queues || []) {
            const key = entry.barber_id;
            if (!key) continue;
            if (!allowedBarberIds.has(key)) continue;

            if (entry.status === 'completed' || entry.status === 'no_show' || entry.status === 'not_in_time') {
                continue;
            }

            if (!queuesByBarber[key]) queuesByBarber[key] = [];
            if (!waitingTimeByBarber[key]) waitingTimeByBarber[key] = 0;

            const serviceDuration = (entry.service_ids || []).reduce((sum, serviceId) => {
                return sum + (servicesById[serviceId] || 0);
            }, 0);

            waitingTimeByBarber[key] += serviceDuration;

            queuesByBarber[key].push({
                id: entry.id,
                name: clientsById[entry.client_id] || null,
                status: entry.status,
                created_at: entry.created_at,
                estimated_time: serviceDuration
            });
        }

        const overallEstimatedWaitingTime = Object.values(waitingTimeByBarber)
            .reduce((sum, val) => sum + val, 0);

        const response = visibleBarbers.map((barber) => ({
            id: barber.id,
            name: barber.name,
            photo: barber.photo_url || null,
            branch_id: barber.branch_id,
            is_active: barber.is_active ?? null,
            is_on_shift: barber.is_on_shift ?? null,
            clients: queuesByBarber[barber.id] || [],
            estimated_waiting_time: waitingTimeByBarber[barber.id] || 0
        }));

        return res.status(200).json({
            barbers: response,
            overall_estimated_waiting_time: overallEstimatedWaitingTime
        });
    }

    async services(req, res) {
        const { active, grouped } = req.query || {};

        let query = supabase.from("services").select("*");

        if (active !== undefined) {
            const activeFlag = String(active).toLowerCase() === "true" || active === "1";
            query = query.eq("is_active", activeFlag);
        }

        const { data, error } = await query
            .order("category", { ascending: true, nullsFirst: false })
            .order("base_price", { ascending: true })
            .order("name", { ascending: true });

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const services = data || [];
        const categories = groupServicesByCategory(services);

        if (grouped === "true" || grouped === "1") {
            return res.status(200).json({ categories });
        }

        return res.status(200).json({ services, categories });
    }

    async book(req, res) {
        const {
            branch_id,
            barber_id,
            service_id,
            service_ids,
            customer_name,
            phone_number,
            source = 'point',
            payment_method = null,
            certificate_code = null,
            promo_code = null,
            use_cashback = false,
        } = req.body || {};

        if (!branch_id || !barber_id || (!service_id && !Array.isArray(service_ids)) || !customer_name || !phone_number) {
            return res.status(400).json({ error: "branch_id, barber_id, service_id/service_ids, customer_name, and phone_number are required" });
        }

        const normalizedPhone = normalizePhone(phone_number);
        if (!normalizedPhone || !isValidE164(normalizedPhone)) {
            return res.status(400).json({ error: "phone_number must be in E.164 format, e.g. +998991234567" });
        }

        const serviceIds = Array.isArray(service_ids) && service_ids.length
            ? service_ids
            : service_id
                ? [service_id]
                : [];

        const allowedSources = ['point', 'site', 'admin'];
        const normalizedSource = allowedSources.includes(source) ? source : 'point';

        const useCashback =
            use_cashback === true ||
            use_cashback === 1 ||
            use_cashback === '1' ||
            String(use_cashback || '').toLowerCase() === 'true';

        let marketplaceClient = null;
        if (useCashback) {
            if (normalizedSource !== 'site') {
                return res.status(400).json({ error: 'Cashback can only be used for marketplace orders (source=site)' });
            }

            if (payment_method === 'certificate' || certificate_code) {
                return res.status(400).json({ error: 'Cashback cannot be used with certificate payment' });
            }

            const token = getBearerToken(req);
            if (!token) {
                return res.status(401).json({ error: 'Authorization token is required to use cashback' });
            }

            let payload;
            try {
                payload = verifyJwt(token);
            } catch (_err) {
                return res.status(401).json({ error: 'Invalid or expired token' });
            }

            if (payload?.role !== MARKETPLACE_ROLE) {
                return res.status(403).json({ error: 'Only marketplace users can use cashback' });
            }

            const marketplaceClientId = payload.sub || payload.id;
            if (!marketplaceClientId) {
                return res.status(401).json({ error: 'Invalid token payload' });
            }

            const { data: mpClient, error: mpError } = await supabase
                .from('marketplace_clients')
                .select('id, phone, is_active')
                .eq('id', marketplaceClientId)
                .maybeSingle();

            if (mpError) {
                return res.status(500).json({ error: mpError.message });
            }

            if (!mpClient) {
                return res.status(404).json({ error: 'Marketplace client not found' });
            }

            if (mpClient.is_active === false) {
                return res.status(403).json({ error: 'Account is disabled' });
            }

            if (!mpClient.phone) {
                return res.status(428).json({
                    error: 'Phone number is required to use cashback',
                    code: 'PHONE_REQUIRED',
                });
            }

            if (String(mpClient.phone) !== String(normalizedPhone)) {
                return res.status(403).json({ error: 'Phone mismatch: cashback can only be used for your own phone number' });
            }

            marketplaceClient = mpClient;
        }

        const { data: branch, error: branchError } = await supabase
            .from('branches')
            .select('id')
            .eq('id', branch_id)
            .maybeSingle();
        if (branchError) return res.status(500).json({ error: branchError.message });
        if (!branch) return res.status(404).json({ error: 'Branch not found' });

        const { data: barber, error: barberError } = await supabase
            .from('barbers')
            .select('id, branch_id, is_on_shift, is_authorized')
            .eq('id', barber_id)
            .maybeSingle();
        if (barberError) return res.status(500).json({ error: barberError.message });
        if (!barber) return res.status(404).json({ error: 'Barber not found' });
        if (barber.branch_id !== branch_id) {
            return res.status(400).json({ error: 'Barber does not belong to this branch' });
        }

        const { data: barberUser, error: barberUserError } = await supabase
            .from('users')
            .select('id, role')
            .eq('id', barber_id)
            .in('role', OPERATIONAL_BARBER_ROLES)
            .maybeSingle();
        if (barberUserError) return res.status(500).json({ error: barberUserError.message });
        if (!barberUser) {
            return res.status(400).json({ error: 'Selected employee is not available as a barber' });
        }

        const { data: services, error: servicesError } = await supabase
            .from('services')
            .select('id, is_active, base_price')
            .in('id', serviceIds);
        if (servicesError) return res.status(500).json({ error: servicesError.message });
        if (!services || services.length !== serviceIds.length) {
            return res.status(400).json({ error: 'One or more service_ids are invalid' });
        }
        const inactive = services.find((s) => s.is_active === false);
        if (inactive) {
            return res.status(400).json({ error: `Service ${inactive.id} is not active` });
        }

        const priceById = new Map(
            (services || [])
                .filter((row) => row?.id)
                .map((row) => [String(row.id), Number(row.base_price)])
        );

        const normalizedPromoCode = promo_code ? String(promo_code).trim().toUpperCase() : null;

        if (payment_method === 'certificate' && normalizedPromoCode) {
            return res.status(400).json({ error: 'Promo code cannot be used with certificate payment_method' });
        }

        let promo = null;
        if (normalizedPromoCode) {
            const { data: promoData, error: promoError } = await supabase
                .from('promo_codes')
                .select('*')
                .eq('code', normalizedPromoCode)
                .maybeSingle();

            if (promoError) {
                return res.status(500).json({ error: promoError.message });
            }

            if (!promoData) {
                return res.status(404).json({ error: 'Promo code not found' });
            }

            if (promoData.status !== 'active') {
                return res.status(400).json({ error: 'Promo code inactive' });
            }

            if (!promoData.is_unlimited) {
                const used = Number(promoData.used_count || 0);
                const limit = Number(promoData.usage_limit || 0);
                if (used >= limit) {
                    return res.status(400).json({ error: 'Promo code expired or limit reached' });
                }
            }

            promo = promoData;
        }

        let certificate = null;
        if (payment_method === 'certificate') {
            if (!certificate_code) {
                return res.status(400).json({ error: 'certificate_code is required when payment_method is certificate' });
            }
            const { data: cert, error: certError } = await supabase
                .from('certificates')
                .select('id, code, expires_at, is_used, metadata, service_ids')
                .eq('code', certificate_code)
                .maybeSingle();
            if (certError) return res.status(500).json({ error: certError.message });
            if (!cert) return res.status(404).json({ error: 'Certificate not found' });
            if (cert.is_used) return res.status(400).json({ error: 'Certificate is already used' });
            if (cert.expires_at && new Date(cert.expires_at) < new Date()) {
                return res.status(400).json({ error: 'Your certificate is expired' });
            }

            // If certificate has service limits, keep only allowed services
            if (Array.isArray(cert.service_ids) && cert.service_ids.length) {
                const allowedSet = new Set(cert.service_ids);
                const filtered = serviceIds.filter((id) => allowedSet.has(id));
                if (!filtered.length) {
                    return res.status(400).json({ error: 'Selected services are not covered by this certificate' });
                }
                serviceIds.splice(0, serviceIds.length, ...filtered);
            }

            certificate = cert;
        }

        const finalOrderTotal = roundMoney(
            (serviceIds || []).reduce((sum, id) => {
                const price = priceById.get(String(id));
                return sum + (Number.isFinite(price) ? price : 0);
            }, 0)
        );

        const discountedTotal = applyPromoDiscount(finalOrderTotal, promo);

        let clientId;
        const { data: existingClient, error: clientLookupError } = await supabase
            .from('clients')
            .select('id, name')
            .eq('phone', normalizedPhone)
            .maybeSingle();
        if (clientLookupError) return res.status(500).json({ error: clientLookupError.message });

        if (existingClient) {
            clientId = existingClient.id;
            if (!existingClient.name) {
                await supabase.from('clients').update({ name: customer_name }).eq('id', clientId);
            }
        } else {
            const { data: newClient, error: clientCreateError } = await supabase
                .from('clients')
                .insert({ name: customer_name, phone: normalizedPhone })
                .select('id')
                .maybeSingle();
            if (clientCreateError) return res.status(500).json({ error: clientCreateError.message });
            clientId = newClient.id;
        }

        const insertPayload = {
            client_id: clientId,
            branch_id,
            barber_id,
            service_id: serviceIds[0],
            service_ids: serviceIds,
            source: normalizedSource,
            status: 'waiting',
            payment_method,
            certificate_id: certificate ? certificate.id : null,
        };

        const { data: entry, error: insertError } = await supabase
            .from('queue_entries')
            .insert(insertPayload)
            .select('id, status, branch_id, barber_id, service_id, service_ids, client_id, created_at, certificate_id')
            .maybeSingle();

        if (insertError) {
            return res.status(500).json({ error: insertError.message });
        }

        if (certificate) {
            const { data: usedCert, error: useError } = await supabase
                .from('certificates')
                .update({ is_used: true })
                .eq('id', certificate.id)
                .eq('is_used', false)
                .select('id')
                .maybeSingle();

            if (useError) {
                return res.status(500).json({ error: useError.message });
            }
            if (!usedCert) {
                await supabase.from('queue_entries').delete().eq('id', entry.id);
                return res.status(400).json({ error: 'Certificate already used' });
            }
        }

        let cashback = null;
        let payableTotal = discountedTotal;
        if (useCashback) {
            const walletBalance = await getWalletBalance(clientId);
            const maxSpend = roundMoney(Math.min(walletBalance, discountedTotal));
            payableTotal = roundMoney(Math.max(0, discountedTotal - maxSpend));

            if (maxSpend > 0) {
                const spendRes = await spendCashback({
                    clientId,
                    queueEntryId: entry.id,
                    amount: maxSpend,
                    meta: {
                        total: finalOrderTotal,
                        discounted_total: discountedTotal,
                        promo_code: promo?.code || null,
                        marketplace_client_id: marketplaceClient?.id || null,
                    },
                });

                if (!spendRes?.spent) {
                    await supabase.from('queue_entries').delete().eq('id', entry.id);
                    const status = spendRes?.reason === 'insufficient_balance' ? 409 : 500;
                    return res.status(status).json({
                        error:
                            spendRes?.reason === 'insufficient_balance'
                                ? 'Insufficient cashback balance'
                                : 'Failed to spend cashback',
                        reason: spendRes?.reason || null,
                        balance: spendRes?.balance ?? walletBalance,
                    });
                }

                cashback = {
                    used: true,
                    spent_amount: spendRes.amount,
                    balance: spendRes.balance,
                    transaction_id: spendRes.transaction?.id || null,
                };
            } else {
                cashback = {
                    used: false,
                    spent_amount: 0,
                    balance: walletBalance,
                    transaction_id: null,
                };
            }
        }

        let promo_usage = null;
        if (promo) {
            const { data: insertedUsage, error: usageError } = await supabase
                .from('promo_code_usage')
                .insert({
                    promo_code_id: promo.id,
                    user_id: null,
                    user_name: customer_name,
                    phone: normalizedPhone,
                    order_id: entry.id,
                })
                .select('id, promo_code_id, order_id, used_at')
                .maybeSingle();

            if (usageError || !insertedUsage) {
                if (cashback?.spent_amount) {
                    await refundCashbackSpend({
                        clientId,
                        queueEntryId: entry.id,
                        amount: cashback.spent_amount,
                        transactionId: cashback.transaction_id,
                    });
                }
                await supabase.from('queue_entries').delete().eq('id', entry.id);
                return res.status(500).json({ error: usageError?.message || 'Failed to record promo code usage' });
            }

            promo_usage = insertedUsage;

            if (!promo.is_unlimited) {
                let currentCount = Number(promo.used_count || 0);
                let updated = false;

                for (let attempt = 0; attempt < 3; attempt++) {
                    const limit = Number(promo.usage_limit || 0);
                    const nextCount = currentCount + 1;

                    if (nextCount > limit) {
                        await supabase.from('promo_code_usage').delete().eq('id', insertedUsage.id);
                        if (cashback?.spent_amount) {
                            await refundCashbackSpend({
                                clientId,
                                queueEntryId: entry.id,
                                amount: cashback.spent_amount,
                                transactionId: cashback.transaction_id,
                            });
                        }
                        await supabase.from('queue_entries').delete().eq('id', entry.id);
                        return res.status(409).json({ error: 'Promo code limit reached' });
                    }

                    const { data: updatedPromo, error: updateError } = await supabase
                        .from('promo_codes')
                        .update({ used_count: nextCount })
                        .eq('id', promo.id)
                        .eq('used_count', currentCount)
                        .select('id, used_count, usage_limit, status, is_unlimited')
                        .maybeSingle();

                    if (updateError) {
                        await supabase.from('promo_code_usage').delete().eq('id', insertedUsage.id);
                        if (cashback?.spent_amount) {
                            await refundCashbackSpend({
                                clientId,
                                queueEntryId: entry.id,
                                amount: cashback.spent_amount,
                                transactionId: cashback.transaction_id,
                            });
                        }
                        await supabase.from('queue_entries').delete().eq('id', entry.id);
                        return res.status(500).json({ error: updateError.message });
                    }

                    if (updatedPromo?.id) {
                        promo.used_count = updatedPromo.used_count;
                        promo.usage_limit = updatedPromo.usage_limit;
                        promo.status = updatedPromo.status;
                        promo.is_unlimited = updatedPromo.is_unlimited;
                        updated = true;
                        break;
                    }

                    const { data: freshPromo, error: freshError } = await supabase
                        .from('promo_codes')
                        .select('used_count, usage_limit, status, is_unlimited')
                        .eq('id', promo.id)
                        .maybeSingle();

                    if (freshError || !freshPromo) {
                        await supabase.from('promo_code_usage').delete().eq('id', insertedUsage.id);
                        if (cashback?.spent_amount) {
                            await refundCashbackSpend({
                                clientId,
                                queueEntryId: entry.id,
                                amount: cashback.spent_amount,
                                transactionId: cashback.transaction_id,
                            });
                        }
                        await supabase.from('queue_entries').delete().eq('id', entry.id);
                        return res.status(409).json({ error: freshError?.message || 'Promo code update conflict' });
                    }

                    if (freshPromo.status !== 'active') {
                        await supabase.from('promo_code_usage').delete().eq('id', insertedUsage.id);
                        if (cashback?.spent_amount) {
                            await refundCashbackSpend({
                                clientId,
                                queueEntryId: entry.id,
                                amount: cashback.spent_amount,
                                transactionId: cashback.transaction_id,
                            });
                        }
                        await supabase.from('queue_entries').delete().eq('id', entry.id);
                        return res.status(409).json({ error: 'Promo code inactive' });
                    }

                    promo.used_count = freshPromo.used_count;
                    promo.usage_limit = freshPromo.usage_limit;
                    promo.is_unlimited = freshPromo.is_unlimited;
                    currentCount = Number(freshPromo.used_count || 0);
                }

                if (!updated) {
                    await supabase.from('promo_code_usage').delete().eq('id', insertedUsage.id);
                    if (cashback?.spent_amount) {
                        await refundCashbackSpend({
                            clientId,
                            queueEntryId: entry.id,
                            amount: cashback.spent_amount,
                            transactionId: cashback.transaction_id,
                        });
                    }
                    await supabase.from('queue_entries').delete().eq('id', entry.id);
                    return res.status(409).json({ error: 'Promo code update conflict' });
                }
            }
        }

        const promoSummary = promo
            ? {
                code: promo.code,
                discount_type: promo.discount_type,
                discount_value: Number(promo.discount_value),
            }
            : null;

        return res.status(201).json({
            entry,
            certificate,
            promo: promoSummary,
            promo_usage,
            totals: {
                total: finalOrderTotal,
                discounted_total: discountedTotal,
                payable_total: payableTotal,
            },
            cashback,
        });
    }

    async certificate(req, res) {
        const { id } = req.params || {};
        if (!id) {
            return res.status(400).json({ error: 'certificate id is required' });
        }

        const { data: cert, error } = await supabase
            .from('certificates')
            .select('id, code, expires_at, is_used, metadata, service_ids')
            .eq('code', id)
            .maybeSingle();

        if (error) {
            return res.status(500).json({ error: error.message });
        }
        if (!cert) {
            return res.status(404).json({ error: 'Certificate not found' });
        }

        const expired = cert.expires_at && new Date(cert.expires_at) < new Date();

        return res.json({ certificate: { ...cert, expired } });
    }
}

module.exports = new Kiosk();
