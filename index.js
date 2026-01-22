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

// env
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

let users = {}; // socket.id -> user

/* ===== 暗号化ユーティリティ ===== */
const ALGO = "aes-256-gcm";
const KEY = crypto.createHash("sha256").update(SECRET_KEY).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
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

/* ===== GitHub API ===== */
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "Content-Type": "application/json",
  "User-Agent": "chat-app"
};

function roomFilePath(room) {
  return `${ROOM_DIR}/${room}.env.json`;
}

function roomUrl(room) {
  const file = roomFilePath(room);
  return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(file)}?ref=${GITHUB_BRANCH}`;
}

async function ghGet(url) {
  return await fetch(url, { headers: GH_HEADERS });
}

async function ghPut(filePath, contentBase64, sha) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}`;
  const body = {
    message: "update room data",
    content: contentBase64,
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {})
  };
  return await fetch(url, {
    method: "PUT",
    headers: GH_HEADERS,
    body: JSON.stringify(body)
  });
}

function safeRoomName(name) {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(name);
}

function hashRoomPassword(roomPassword) {
  return crypto.createHash("sha256").update(String(roomPassword)).digest("hex");
}

async function loadRoomData(room) {
  const url = roomUrl(room);
  const res = await ghGet(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub load failed: ${res.status}`);

  const json = await res.json();
  const decrypted = decrypt(Buffer.from(json.content, "base64").toString());
  const data = JSON.parse(decrypted);
  return { data, sha: json.sha };
}

async function saveRoomData(room, data, sha) {
  const encrypted = encrypt(JSON.stringify(data));
  const content = Buffer.from(encrypted).toString("base64");
  const filePath = roomFilePath(room);
  const res = await ghPut(filePath, content, sha);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GitHub save failed: ${res.status} ${t}`);
  }
}

/* ===== 使い捨て入室トークン =====
   - /rooms/join 成功で token 発行
   - socket joinRoom 時に token 検証 + 1回使ったら失効
   => URL直打ち／共有をかなり抑止
*/
const USED_TOKENS = new Set();

function makeRoomToken(room, userId) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = JSON.stringify({ room, userId, ts, nonce });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET_KEY).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifyRoomToken(token, room, userId, maxAgeMs = 1000 * 60 * 10) {
  // 10分有効（短め：毎回パス必須運用に向く）
  if (!token || typeof token !== "string") return { ok: false, reason: "missing" };
  if (USED_TOKENS.has(token)) return { ok: false, reason: "used" };

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "format" };
  const [payloadB64, sig] = parts;

  const expected = crypto.createHmac("sha256", SECRET_KEY).update(payloadB64).digest("base64url");
  if (sig.length !== expected.length) return { ok: false, reason: "siglen" };
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false, reason: "sig" };

  const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: "json" };
  }

  if (payload.room !== room) return { ok: false, reason: "room" };
  if (payload.userId !== userId) return { ok: false, reason: "user" };
  if (typeof payload.ts !== "number") return { ok: false, reason: "ts" };
  if (Date.now() - payload.ts > maxAgeMs) return { ok: false, reason: "expired" };

  return { ok: true };
}

function consumeToken(token) {
  USED_TOKENS.add(token);
  // メモリ肥大防止：一応適当に掃除
  if (USED_TOKENS.size > 5000) {
    USED_TOKENS.clear();
  }
}

/* ===== 入室認証（共通） ===== */
app.post("/auth", (req, res) => {
  res.json({ ok: req.body.password === ENTRY_PASSWORD });
});

/* ===== ルーム一覧 ===== */
app.get("/rooms", async (req, res) => {
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${ROOM_DIR}?ref=${GITHUB_BRANCH}`;
    const r = await fetch(url, { headers: GH_HEADERS });

    if (r.status === 404) return res.json({ rooms: [] });
    if (!r.ok) return res.status(500).json({ error: "failed to list rooms" });

    const items = await r.json();
    const rooms = (Array.isArray(items) ? items : [])
      .filter(it => it.type === "file" && it.name.endsWith(".env.json"))
      .map(it => it.name.replace(/\.env\.json$/i, ""));
    res.json({ rooms });
  } catch (e) {
    console.error("GET /rooms error:", e);
    res.status(500).json({ error: "server error" });
  }
});

/* ===== ルーム作成 ===== */
app.post("/rooms/create", async (req, res) => {
  try {
    const { room, password } = req.body || {};
    if (!room || !password) return res.status(400).json({ ok: false, error: "missing" });
    if (!safeRoomName(room)) return res.status(400).json({ ok: false, error: "bad_room_name" });

    const existing = await loadRoomData(room);
    if (existing) return res.json({ ok: false, error: "exists" });

    const data = {
      room,
      passHash: hashRoomPassword(password),
      messages: []
    };

    await saveRoomData(room, data, undefined);
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /rooms/create error:", e);
    res.status(500).json({ ok: false, error: "server" });
  }
});

/* ===== ルーム参加（パス正しければ 使い捨てtoken発行） ===== */
app.post("/rooms/join", async (req, res) => {
  try {
    const { room, password, userId } = req.body || {};
    if (!room || !password || !userId) return res.status(400).json({ ok: false, error: "missing" });

    const loaded = await loadRoomData(room);
    if (!loaded) return res.json({ ok: false, error: "not_found" });

    const ok = loaded.data.passHash === hashRoomPassword(password);
    if (!ok) return res.json({ ok: false, error: "wrong_password" });

    const token = makeRoomToken(room, userId);
    res.json({ ok: true, token });
  } catch (e) {
    console.error("POST /rooms/join error:", e);
    res.status(500).json({ ok: false, error: "server" });
  }
});

/* ===== socket.io ===== */
io.on("connection", async (socket) => {
  console.log("connected:", socket.id);

  socket.on("userJoin", (user) => {
    users[socket.id] = user;
    io.emit("userList", Object.values(users));
  });

  socket.on("joinRoom", async ({ room, userId, token }) => {
    try {
      if (!room || !safeRoomName(room)) return;
      if (!userId || !token) {
        socket.emit("roomAuthFailed", "missing");
        return;
      }

      const v = verifyRoomToken(token, room, userId);
      if (!v.ok) {
        socket.emit("roomAuthFailed", v.reason);
        return;
      }

      // ★一回使ったら失効（毎回パス必須運用）
      consumeToken(token);

      socket.join(room);

      const loaded = await loadRoomData(room);
      if (!loaded) {
        socket.emit("roomNotFound", room);
        return;
      }

      socket.emit("history", { room, msgs: loaded.data.messages || [] });
    } catch (e) {
      console.error("joinRoom error:", e);
      socket.emit("roomError", "join failed");
    }
  });

  socket.on("chat message", async ({ room, msg, userId, token }) => {
    try {
      if (!room || !safeRoomName(room)) return;
      if (!msg || !msg.id || !msg.userId) return;
      if (!userId || !token) {
        socket.emit("roomAuthFailed", "missing");
        return;
      }

      // tokenは joinRoom で消費済みなので、送信ごとに token を要求しない運用も可能。
      // ただ「毎回パス必須」に寄せるなら、送信も token 必須にしている方が堅い。
      // ここでは token を毎回要求し、同じtokenは使えないので rooms経由が必要になる。
      const v = verifyRoomToken(token, room, userId);
      if (!v.ok) {
        socket.emit("roomAuthFailed", v.reason);
        return;
      }
      consumeToken(token);

      // userId一致チェック（なりすまし防止）
      if (msg.userId !== userId) {
        socket.emit("roomAuthFailed", "user_mismatch");
        return;
      }

      const loaded = await loadRoomData(room);
      if (!loaded) return;

      let messages = Array.isArray(loaded.data.messages) ? loaded.data.messages : [];
      messages.push(msg);
      if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);

      loaded.data.messages = messages;
      await saveRoomData(room, loaded.data, loaded.sha);

      io.to(room).emit("chat message", msg);
    } catch (e) {
      console.error("chat message error:", e);
    }
  });

  socket.on("requestDelete", async ({ room, id, userId, token }) => {
    try {
      if (!room || !safeRoomName(room)) return;
      if (!id || !userId || !token) return socket.emit("deleteFailed", { id, reason: "missing" });

      const v = verifyRoomToken(token, room, userId);
      if (!v.ok) return socket.emit("deleteFailed", { id, reason: "no_access" });
      consumeToken(token);

      const loaded = await loadRoomData(room);
      if (!loaded) return;

      const messages = Array.isArray(loaded.data.messages) ? loaded.data.messages : [];
      const target = messages.find(m => m.id === id);
      if (!target) return;

      if (target.userId !== userId) {
        socket.emit("deleteFailed", { id, reason: "not_owner" });
        return;
      }

      loaded.data.messages = messages.filter(m => m.id !== id);
      await saveRoomData(room, loaded.data, loaded.sha);

      io.to(room).emit("delete message", id);
    } catch (e) {
      console.error("requestDelete error:", e);
      socket.emit("deleteFailed", { id, reason: "server_error" });
    }
  });

  socket.on("adminClearAll", async ({ room, password, userId, token }) => {
    try {
      if (password !== ADMIN_PASSWORD) {
        socket.emit("adminClearFailed", "wrong password");
        return;
      }
      if (!room || !safeRoomName(room)) return;
      if (!userId || !token) return socket.emit("adminClearFailed", "missing");

      const v = verifyRoomToken(token, room, userId);
      if (!v.ok) return socket.emit("adminClearFailed", "no access");
      consumeToken(token);

      const loaded = await loadRoomData(room);
      if (!loaded) return;

      loaded.data.messages = [];
      await saveRoomData(room, loaded.data, loaded.sha);

      io.to(room).emit("clearAllMessages");
    } catch (e) {
      console.error("adminClearAll error:", e);
      socket.emit("adminClearFailed", "server error");
    }
  });

  socket.on("disconnect", () => {
    delete users[socket.id];
    io.emit("userList", Object.values(users));
  });
});

/* ===== 起動 ===== */
server.listen(PORT || 3000, () => {
  console.log("Server running");
});
