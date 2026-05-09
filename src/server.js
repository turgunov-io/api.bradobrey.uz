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

app.set('io', io);
startQueueAutoCloseScheduler({ io });

io.on('connection', (socket) => {
  const branchId = socket.handshake.query.branchId;
  if (branchId) {
    socket.join(`branch:${branchId}`);
  }

  socket.on('join_branch', (id) => {
    if (id) socket.join(`branch:${id}`);
  });

  socket.on('leave_branch', (id) => {
    if (id) socket.leave(`branch:${id}`);
  });
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});

process.on('SIGTERM', stopQueueAutoCloseScheduler);
process.on('SIGINT', stopQueueAutoCloseScheduler);
