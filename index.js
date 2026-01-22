// index.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* ===== 設定 ===== */
const MAX_MESSAGES = 100;
const ROOM_DIR = "rooms";

const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  SECRET_KEY,
  ADMIN_PASSWORD,
  ENTRY_PASSWORD,
  PORT
} = process.env;

app.use(express.static("public"));
app.use(express.json());

let users = {};

/* ===== 暗号化 ===== */
const ALGO = "aes-256-gcm";
const KEY = crypto.createHash("sha256").update(SECRET_KEY).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(enc) {
  const buf = Buffer.from(enc, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/* ===== GitHub ===== */
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "Content-Type": "application/json",
  "User-Agent": "chat-app"
};

const roomFilePath = r => `${ROOM_DIR}/${r}.env.json`;
const roomUrl = r =>
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(roomFilePath(r))}?ref=${GITHUB_BRANCH}`;

async function loadRoomData(room) {
  const res = await fetch(roomUrl(room), { headers: GH_HEADERS });
  if (res.status === 404) return null;
  const json = await res.json();
  const decrypted = decrypt(Buffer.from(json.content, "base64").toString());
  return { data: JSON.parse(decrypted), sha: json.sha };
}

async function saveRoomData(room, data, sha) {
  const encrypted = encrypt(JSON.stringify(data));
  const content = Buffer.from(encrypted).toString("base64");
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(roomFilePath(room))}`;
  await fetch(url, {
    method: "PUT",
    headers: GH_HEADERS,
    body: JSON.stringify({
      message: "update room",
      content,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {})
    })
  });
}

const safeRoomName = n => /^[a-zA-Z0-9_-]{1,40}$/.test(n);
const hashRoomPassword = p => crypto.createHash("sha256").update(String(p)).digest("hex");

/* ===== トークン（join 専用） ===== */
const USED_TOKENS = new Set();

function makeRoomToken(room, userId) {
  const payload = Buffer.from(JSON.stringify({ room, userId, ts: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET_KEY).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyRoomToken(token, room, userId) {
  if (USED_TOKENS.has(token)) return false;
  const [p, s] = token.split(".");
  const exp = crypto.createHmac("sha256", SECRET_KEY).update(p).digest("base64url");
  if (s !== exp) return false;
  const data = JSON.parse(Buffer.from(p, "base64url").toString());
  return data.room === room && data.userId === userId;
}

/* ===== HTTP ===== */
app.post("/auth", (req, res) => {
  res.json({ ok: req.body.password === ENTRY_PASSWORD });
});

app.post("/rooms/join", async (req, res) => {
  const { room, password, userId } = req.body;
  const loaded = await loadRoomData(room);
  if (!loaded) return res.json({ ok: false });

  if (loaded.data.passHash !== hashRoomPassword(password))
    return res.json({ ok: false });

  res.json({ ok: true, token: makeRoomToken(room, userId) });
});

/* ===== socket.io ===== */
io.on("connection", socket => {
  socket.on("joinRoom", async ({ room, userId, token }) => {
    if (!verifyRoomToken(token, room, userId)) {
      socket.emit("roomAuthFailed");
      return;
    }

    USED_TOKENS.add(token); // ★ join時のみ消費
    socket.join(room);
    socket.data.room = room;
    socket.data.userId = userId;

    const loaded = await loadRoomData(room);
    socket.emit("history", { room, msgs: loaded?.data.messages || [] });
  });

  socket.on("chat message", async ({ room, msg }) => {
    if (socket.data.room !== room) {
      socket.emit("roomAuthFailed");
      return;
    }

    const loaded = await loadRoomData(room);
    loaded.data.messages.push(msg);
    loaded.data.messages = loaded.data.messages.slice(-MAX_MESSAGES);

    await saveRoomData(room, loaded.data, loaded.sha);
    io.to(room).emit("chat message", msg);
  });

  socket.on("requestDelete", async ({ room, id }) => {
    if (socket.data.room !== room) return;

    const loaded = await loadRoomData(room);
    const msg = loaded.data.messages.find(m => m.id === id);
    if (!msg || msg.userId !== socket.data.userId) return;

    loaded.data.messages = loaded.data.messages.filter(m => m.id !== id);
    await saveRoomData(room, loaded.data, loaded.sha);
    io.to(room).emit("delete message", id);
  });
});

/* ===== 起動 ===== */
server.listen(PORT || 3000, () => {
  console.log("Server running");
});
