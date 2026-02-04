const broadcastQueueUpdate = (app, payload) => {
  const io = app.get('io');
  if (!io) return;

  const room = payload.branchId ? `branch:${payload.branchId}` : null;

  if (room) {
    io.to(room).emit('queue:update', payload);
  }

  io.emit('queue:update', payload);
};

module.exports = { broadcastQueueUpdate };
