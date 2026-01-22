const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* =========================
   基本設定
========================= */
app.use(express.json());
app.use(express.static("public"));

/* =========================
   セッション設定（最重要）
========================= */
const sessionMiddleware = session({
  secret: "super-room-secret",
  resave: false,
  saveUninitialized: false
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

/* =========================
   util
========================= */
function roomFile(room) {
  return path.join(__dirname, `${room}.env.json`);
}

function roomExists(room) {
  return fs.existsSync(roomFile(room));
}

/* =========================
   部屋作成API
========================= */
app.post("/room-create", (req, res) => {
  const { room, password } = req.body;

  if (!room || !password) {
    return res.json({ ok: false, reason: "invalid" });
  }

  if (roomExists(room)) {
    return res.json({ ok: false, reason: "exists" });
  }

  const data = {
    password,
    messages: []
  };

  fs.writeFileSync(roomFile(room), JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

/* =========================
   部屋入室認証API
========================= */
app.post("/room-auth", (req, res) => {
  const { room, password } = req.body;

  if (!roomExists(room)) {
    return res.json({ ok: false, reason: "notfound" });
  }

  const data = JSON.parse(fs.readFileSync(roomFile(room), "utf8"));

  if (data.password !== password) {
    return res.json({ ok: false, reason: "wrong" });
  }

  // セッションに部屋認証を保存
  if (!req.session.rooms) req.session.rooms = {};
  req.session.rooms[room] = true;

  res.json({ ok: true });
});

/* =========================
   Socket.io
========================= */
io.on("connection", socket => {
  const session = socket.request.session;

  /* ----- 部屋参加 ----- */
  socket.on("joinRoom", room => {
    if (!session?.rooms?.[room]) {
      socket.emit("roomAuthRequired");
      return;
    }

    socket.join(room);
    socket.currentRoom = room;

    // 履歴送信
    const data = JSON.parse(fs.readFileSync(roomFile(room), "utf8"));
    socket.emit("history", data.messages);
  });

  /* ----- メッセージ受信 ----- */
  socket.on("chat message", msg => {
    const room = socket.currentRoom;

    if (!room || !session?.rooms?.[room]) {
      socket.emit("roomAuthRequired");
      return;
    }

    const file = roomFile(room);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));

    data.messages.push(msg);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));

    io.to(room).emit("chat message", msg);
  });

  /* ----- メッセージ削除（本人のみ） ----- */
  socket.on("requestDelete", id => {
    const room = socket.currentRoom;

    if (!room || !session?.rooms?.[room]) {
      socket.emit("deleteFailed", { id, reason: "auth" });
      return;
    }

    const file = roomFile(room);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));

    const before = data.messages.length;
    data.messages = data.messages.filter(m => m.id !== id);

    if (data.messages.length === before) {
      socket.emit("deleteFailed", { id, reason: "notfound" });
      return;
    }

    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    io.to(room).emit("delete message", id);
  });

  /* ----- 管理者：全削除 ----- */
  socket.on("adminClearAll", password => {
    const room = socket.currentRoom;

    if (!room || !session?.rooms?.[room]) {
      socket.emit("adminClearFailed", "auth");
      return;
    }

    const file = roomFile(room);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));

    if (data.password !== password) {
      socket.emit("adminClearFailed", "wrong password");
      return;
    }

    data.messages = [];
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    io.to(room).emit("clearAllMessages");
  });
});

/* =========================
   起動
========================= */
server.listen(3000, () => {
  console.log("Server running http://localhost:3000");
});
