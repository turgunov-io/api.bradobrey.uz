const http = require('http');
const { Server } = require('socket.io');

require('dotenv').config();
const app = require('./app');
const { startQueueAutoCloseScheduler, stopQueueAutoCloseScheduler } = require('./jobs/autoCloseQueue');
const server = http.createServer(app);

const corsOrigin = app.get('corsOrigin') || '*';

const io = new Server(server, {
  cors: { origin: corsOrigin },
});

const isSafeBranchId = (value) => /^[0-9a-f-]{20,64}$/i.test(String(value || ''));

app.set('io', io);
startQueueAutoCloseScheduler({ io });

io.on('connection', (socket) => {
  const branchId = String(socket.handshake.query.branchId || '');
  if (isSafeBranchId(branchId)) {
    socket.join(`branch:${branchId}`);
  }

  const joinBranch = (id) => {
    const nextBranchId = String(id?.branchId || id || '');
    if (isSafeBranchId(nextBranchId)) socket.join(`branch:${nextBranchId}`);
  };

  const leaveBranch = (id) => {
    const nextBranchId = String(id?.branchId || id || '');
    if (isSafeBranchId(nextBranchId)) socket.leave(`branch:${nextBranchId}`);
  };

  // Keep the protocol used by the kiosk and marketplace clients identical.
  socket.on('join', joinBranch);
  socket.on('join_branch', joinBranch);
  socket.on('leave', leaveBranch);
  socket.on('leave_branch', leaveBranch);
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});

process.on('SIGTERM', stopQueueAutoCloseScheduler);
process.on('SIGINT', stopQueueAutoCloseScheduler);
