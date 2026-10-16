function buildAuthenticatedBarberRoster({
  branchId,
  branchBarbers = [],
  assignedBarbers = [],
  activeSessions = [],
  deniedEmployeeIds = [],
  now = Date.now(),
}) {
  const targetBranchId = String(branchId || '');
  const denied = new Set(deniedEmployeeIds.map(String));
  const sessionsByEmployee = new Map();

  for (const session of activeSessions) {
    const employeeId = String(session?.employee_id || '');
    const expiresAt = Date.parse(session?.session_expires_at || '');
    if (
      !employeeId || !session.session_id ||
      String(session.branch_id || '') !== targetBranchId ||
      denied.has(employeeId) || !Number.isFinite(expiresAt) || expiresAt <= now
    ) continue;
    sessionsByEmployee.set(employeeId, session);
  }

  const barbersById = new Map();
  for (const barber of [...branchBarbers, ...assignedBarbers]) {
    if (barber?.id) barbersById.set(String(barber.id), barber);
  }

  return [...barbersById.values()]
    .filter((barber) => {
      const session = sessionsByEmployee.get(String(barber.id));
      return barber.is_archived !== true && session && (
        String(barber.branch_id || '') === targetBranchId ||
        String(session.branch_id) === targetBranchId
      );
    })
    .map((barber) => {
      const session = sessionsByEmployee.get(String(barber.id));
      return {
        ...barber,
        branch_id: targetBranchId,
        // Login state controls card visibility; shift state controls availability.
        is_on_shift: session.is_on_shift === true,
      };
    });
}

module.exports = { buildAuthenticatedBarberRoster };
