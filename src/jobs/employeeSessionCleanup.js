async function cleanupExpiredEmployeeSessions({ database, io }) {
  const result = await database.query(`
    with expired as (
      select active.employee_id, active.branch_id,
             case
               when active.session_expires_at is null or active.session_expires_at <= now() then 'expired'
               when barber.is_archived is true then 'account_archived'
               else 'branch_access_revoked'
             end as reason
        from employee_active_branches active
        left join barbers barber on barber.id = active.employee_id
        join branches branch on branch.id = active.branch_id
       where active.session_id is not null
         and (
           active.session_expires_at <= now()
           or active.session_expires_at is null
           or barber.is_archived is true
           or branch.is_active is not true
           or exists (
             select 1 from employee_branch_access access
              where access.employee_id = active.employee_id
                and access.branch_id = active.branch_id
                and access.is_active = false
           )
         )
       for update of active
    ), ended as (
      update employee_active_branches active
         set is_on_shift = false,
             session_id = null,
             session_expires_at = null,
             updated_at = now()
        from expired
       where active.employee_id = expired.employee_id
       returning active.employee_id, active.branch_id
    ), legacy as (
      update barbers barber
         set is_on_shift = false
        from ended
       where barber.id = ended.employee_id
       returning barber.id
    )
    select ended.employee_id, ended.branch_id, expired.reason
      from ended
      join expired on expired.employee_id = ended.employee_id
  `);

  for (const session of result.rows || []) {
    io?.to(`branch:${session.branch_id}`).emit('queue:update', {
      type: 'barber_status',
      barberId: session.employee_id,
      branchId: session.branch_id,
      is_on_shift: false,
      ...(session.reason === 'expired'
        ? { session_expired: true }
        : { session_ended: true }),
      reason: session.reason,
    });
  }
  return result.rows || [];
}

function startEmployeeSessionCleanup({ io, database, intervalMs = 60000 }) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const resolvedDatabase = database || require('../config/postgres').pool;
      await cleanupExpiredEmployeeSessions({ database: resolvedDatabase, io });
    } catch (error) {
      console.error('[employee-session-cleanup] failed:', error.message);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, Math.max(Number(intervalMs) || 60000, 10000));
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { cleanupExpiredEmployeeSessions, startEmployeeSessionCleanup };
