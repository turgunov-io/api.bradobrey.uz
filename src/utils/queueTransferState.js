function matchingTerminalDecision(status, decision) {
  return (decision === 'accept' && status === 'accepted') || (decision === 'reject' && status === 'rejected');
}

function canInitiateTransfer(entry, barberId, targetBarberId) {
  return Boolean(entry)
    && String(entry.barber_id) === String(barberId)
    && ['waiting', 'called', 'swapped'].includes(entry.status)
    && String(entry.barber_id) !== String(targetBarberId);
}

function resolveTransferOutcome(decision, transfer) {
  if (decision === 'accept') {
    return { transferStatus: 'accepted', barberId: transfer.to_barber_id, orderStatus: 'waiting' };
  }
  if (decision === 'expired') {
    return { transferStatus: 'expired', barberId: transfer.from_barber_id, orderStatus: transfer.original_status };
  }
  return { transferStatus: 'rejected', barberId: transfer.from_barber_id, orderStatus: transfer.original_status };
}

module.exports = { canInitiateTransfer, matchingTerminalDecision, resolveTransferOutcome };
