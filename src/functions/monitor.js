const { supabase } = require('../config/supabaseClient');
const httpError = require('../utils/httpError');

const pickBarberWithShortestQueue = async (branchId) => {
  const { data: barbers, error: barbersError } = await supabase
    .from('barbers')
    .select('id, name, branch_id, is_on_shift, is_authorized, specialization')
    .eq('branch_id', branchId);

  if (barbersError) {
    throw httpError(500, barbersError.message);
  }

  const available = (barbers || []).filter(
    (b) => b.is_on_shift && b.is_authorized
  );

  if (!available.length) {
    return null;
  }

  const { data: queueData, error: queueError } = await supabase
    .from('queue_entries')
    .select('barber_id')
    .eq('branch_id', branchId)
    .in('status', ['waiting', 'called', 'in_progress']);

  if (queueError) {
    throw httpError(500, queueError.message);
  }

  const counts = new Map();
  (queueData || []).forEach((q) => {
    counts.set(q.barber_id, (counts.get(q.barber_id) || 0) + 1);
  });

  let selected = available[0];
  let selectedCount = counts.get(selected.id) || 0;

  available.slice(1).forEach((barber) => {
    const count = counts.get(barber.id) || 0;
    if (count < selectedCount) {
      selected = barber;
      selectedCount = count;
    }
  });

  return selected;
};

module.exports = { pickBarberWithShortestQueue };
