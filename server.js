import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
console.log("Serving static from:", process.cwd() + "\\public");

let waitingSocketId = null;

// session-only block list (MVP). In production use accounts/device fingerprinting/IP, etc.
const blocked = new Map(); // socketId -> Set(blockedSocketId)

function isBlocked(a, b) {
  const setA = blocked.get(a);
  const setB = blocked.get(b);
  return (setA && setA.has(b)) || (setB && setB.has(a));
}

function safeJoinQueue(socket) {
  if (waitingSocketId === socket.id) return;

  if (!waitingSocketId) {
    waitingSocketId = socket.id;
    socket.emit("queue:status", { status: "waiting" });
    return;
  }

  if (isBlocked(socket.id, waitingSocketId)) {
    const prev = io.sockets.sockets.get(waitingSocketId);
    if (prev) prev.emit("queue:status", { status: "waiting" });
    waitingSocketId = socket.id;
    socket.emit("queue:status", { status: "waiting" });
    return;
  }

  const a = waitingSocketId;
  const b = socket.id;
  waitingSocketId = null;

  const roomId = `room_${a}_${b}_${Date.now()}`;
  const sa = io.sockets.sockets.get(a);
  const sb = io.sockets.sockets.get(b);
  if (!sa || !sb) return;

  sa.join(roomId);
  sb.join(roomId);

  sa.emit("match:found", { roomId, role: "caller" });
  sb.emit("match:found", { roomId, role: "callee" });
}

io.on("connection", (socket) => {
  socket.on("queue:join", () => safeJoinQueue(socket));

  socket.on("queue:leave", () => {
    if (waitingSocketId === socket.id) waitingSocketId = null;
    socket.emit("queue:status", { status: "idle" });
  });

  socket.on("room:signal", ({ roomId, data }) => {
    socket.to(roomId).emit("room:signal", { data });
  });

  socket.on("room:next", ({ roomId }) => {
    socket.leave(roomId);
    socket.to(roomId).emit("room:ended", { reason: "partner_next" });
    safeJoinQueue(socket);
  });

  socket.on("room:report", ({ roomId, reason }) => {
    console.log(`[REPORT] from=${socket.id} room=${roomId} reason=${reason}`);
    socket.emit("report:ok");
  });

  socket.on("user:block", ({ targetSocketId }) => {
    const set = blocked.get(socket.id) ?? new Set();
    set.add(targetSocketId);
    blocked.set(socket.id, set);
    socket.emit("block:ok");
  });

  socket.on("disconnect", () => {
    if (waitingSocketId === socket.id) waitingSocketId = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
