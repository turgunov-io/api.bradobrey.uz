async function applyEmployeeLogoutTransaction(client, normalizedEmployeeId) {
  try {
    await client.query('begin');
    const barberResult = await client.query(
      `select id, name, photo_url, branch_id, is_authorized, is_on_shift,
              specialization, is_active
         from barbers
        where id = $1
        for update`,
      [normalizedEmployeeId],
    );
    const barber = barberResult.rows?.[0] || null;
    if (!barber) {
      await client.query('commit');
      return { barber: null, activeBranchId: null };
    }

    const relationResult = await client.query(
      "select to_regclass('public.employee_active_branches') as relation",
    );
    const hasActiveBranchTable = Boolean(relationResult.rows?.[0]?.relation);
    let activeBranchId = null;

    if (hasActiveBranchTable) {
      const activeResult = await client.query(
        `select branch_id
           from employee_active_branches
          where employee_id = $1
          for update`,
        [normalizedEmployeeId],
      );
      activeBranchId = activeResult.rows?.[0]?.branch_id || null;
      await client.query(
        `update employee_active_branches
            set is_on_shift = false,
                session_id = null,
                session_expires_at = null,
                updated_at = now()
          where employee_id = $1`,
        [normalizedEmployeeId],
      );
    }

    await client.query(
      'update barbers set is_on_shift = false where id = $1',
      [normalizedEmployeeId],
    );
    await client.query('commit');

    return {
      barber: { ...barber, is_on_shift: false },
      activeBranchId,
    };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

module.exports = { applyEmployeeLogoutTransaction };
