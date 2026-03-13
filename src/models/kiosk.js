const { supabase } = require("../config/supabase");

const STALE_QUEUE_HOURS = 9;
const DEFAULT_SERVICE_CATEGORY = "Uncategorized";

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

        const response = (barbers || []).map((barber) => ({
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
        } = req.body || {};

        if (!branch_id || !barber_id || (!service_id && !Array.isArray(service_ids)) || !customer_name || !phone_number) {
            return res.status(400).json({ error: "branch_id, barber_id, service_id/service_ids, customer_name, and phone_number are required" });
        }

        const serviceIds = Array.isArray(service_ids) && service_ids.length
            ? service_ids
            : service_id
                ? [service_id]
                : [];

        const allowedSources = ['point', 'site', 'admin'];
        const normalizedSource = allowedSources.includes(source) ? source : 'point';

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

        const { data: services, error: servicesError } = await supabase
            .from('services')
            .select('id, is_active')
            .in('id', serviceIds);
        if (servicesError) return res.status(500).json({ error: servicesError.message });
        if (!services || services.length !== serviceIds.length) {
            return res.status(400).json({ error: 'One or more service_ids are invalid' });
        }
        const inactive = services.find((s) => s.is_active === false);
        if (inactive) {
            return res.status(400).json({ error: `Service ${inactive.id} is not active` });
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

        let clientId;
        const { data: existingClient, error: clientLookupError } = await supabase
            .from('clients')
            .select('id, name')
            .eq('phone', phone_number)
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
                .insert({ name: customer_name, phone: phone_number })
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

        return res.status(201).json({ entry, certificate });
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
