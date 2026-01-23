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
const ROOM_DIR = "rooms";      // GitHub上の保存先フォルダ（contents API で扱える）
const UPLOAD_DIR = "uploads";  // 画像保存先
const IMAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

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
// 画像送信があるのでサイズ上限を増やす
app.use(express.json({ limit: "8mb" }));

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

/* ===== 30日超の画像だけ履歴から削除 ===== */
function pruneOldImages(messages) {
  const now = Date.now();
  const arr = Array.isArray(messages) ? messages : [];
  return arr.filter(m => {
    if (m && m.type === "image") {
      const ts = Number(m.ts || 0);
      // 互換性：tsが無い古い画像は残す（必要なら false にして一括削除も可能）
      if (!ts) return true;
      return (now - ts) <= IMAGE_TTL_MS;
    }
    return true;
  });
}

/* ===== 入室認証（共通） ===== */
app.post("/auth", (req, res) => {
  res.json({ ok: req.body.password === ENTRY_PASSWORD });
});

/* ===== ルーム一覧取得 ===== */
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

/* ===== ルーム参加チェック ===== */
app.post("/rooms/join", async (req, res) => {
  try {
    const { room, password } = req.body || {};
    if (!room || !password) return res.status(400).json({ ok: false, error: "missing" });

    const loaded = await loadRoomData(room);
    if (!loaded) return res.json({ ok: false, error: "not_found" });

    const ok = loaded.data.passHash === hashRoomPassword(password);
    res.json({ ok });
  } catch (e) {
    console.error("POST /rooms/join error:", e);
    res.status(500).json({ ok: false, error: "server" });
  }
});

/* ===== 画像アップロード（private repoに保存） ===== */
function uploadFilePath(room, filename) {
  return `${UPLOAD_DIR}/${room}/${filename}`;
}

function safeUploadFilename(name) {
  return /^[a-zA-Z0-9_-]{1,80}\.(jpg|jpeg)$/i.test(name);
}

app.post("/upload", async (req, res) => {
  try {
    const { room, filename, dataBase64 } = req.body || {};
    if (!room || !safeRoomName(room)) return res.status(400).json({ ok: false, error: "bad_room" });
    if (!filename || !safeUploadFilename(filename)) return res.status(400).json({ ok: false, error: "bad_filename" });
    if (!dataBase64 || typeof dataBase64 !== "string") return res.status(400).json({ ok: false, error: "missing" });

    const filePath = uploadFilePath(room, filename);

    // sha取得（既存なら上書き。uuid運用なら基本不要）
    let sha;
    const checkUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}?ref=${GITHUB_BRANCH}`;
    const check = await ghGet(checkUrl);
    if (check.ok) {
      const j = await check.json();
      sha = j.sha;
    }

    const putRes = await ghPut(filePath, dataBase64, sha);
    if (!putRes.ok) {
      const t = await putRes.text().catch(() => "");
      console.error("upload ghPut failed:", putRes.status, t);
      return res.status(500).json({ ok: false, error: "github" });
    }

    // privateなのでpathを返す
    res.json({ ok: true, path: filePath });
  } catch (e) {
    console.error("POST /upload error:", e);
    res.status(500).json({ ok: false, error: "server" });
  }
});

/* ===== private repo画像取得（サーバ経由で返す） ===== */
app.get("/image", async (req, res) => {
  try {
    const filePath = String(req.query.path || "");
    if (!filePath) return res.sendStatus(400);
    if (!filePath.startsWith(`${UPLOAD_DIR}/`)) return res.sendStatus(403);

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}?ref=${GITHUB_BRANCH}`;
    const ghRes = await ghGet(url);
    if (!ghRes.ok) return res.sendStatus(404);

    const json = await ghRes.json();
    const buffer = Buffer.from(json.content, "base64");

    // jpg想定（resizeでjpg固定）
    res.type("jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (e) {
    console.error("GET /image error:", e);
    res.sendStatus(500);
  }
});

/* ===== socket.io ===== */
io.on("connection", async (socket) => {
  console.log("connected:", socket.id);

  socket.on("userJoin", (user) => {
    users[socket.id] = user;
    io.emit("userList", Object.values(users));
  });

  // ルーム入室（履歴送る）＋画像掃除
  socket.on("joinRoom", async ({ room }) => {
    try {
      if (!room || !safeRoomName(room)) return;

      socket.join(room);

      const loaded = await loadRoomData(room);
      if (!loaded) {
        socket.emit("roomNotFound", room);
        return;
      }

      const before = Array.isArray(loaded.data.messages) ? loaded.data.messages : [];
      const pruned = pruneOldImages(before);

      // 変化があれば保存し直す（全員に効く）
      if (pruned.length !== before.length) {
        loaded.data.messages = pruned;
        await saveRoomData(room, loaded.data, loaded.sha);
      }

      socket.emit("history", { room, msgs: pruned });
    } catch (e) {
      console.error("joinRoom error:", e);
      socket.emit("roomError", "join failed");
    }
  });

  socket.on("chat message", async ({ room, msg }) => {
    try {
      if (!room || !safeRoomName(room)) return;
      if (!msg || !msg.id) return;

      const loaded = await loadRoomData(room);
      if (!loaded) return;

      let messages = Array.isArray(loaded.data.messages) ? loaded.data.messages : [];
      messages.push(msg);

      // 画像だけ30日超を掃除
      messages = pruneOldImages(messages);

      if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);

      loaded.data.messages = messages;
      await saveRoomData(room, loaded.data, loaded.sha);

      io.to(room).emit("chat message", msg);
    } catch (e) {
      console.error("chat message error:", e);
    }
  });

  // 削除（サーバーで所有者確認）
  socket.on("requestDelete", async ({ room, id, userId }) => {
    try {
      if (!room || !safeRoomName(room)) return;
      if (!id || !userId) return;

      const loaded = await loadRoomData(room);
      if (!loaded) return;

      const messages = Array.isArray(loaded.data.messages) ? loaded.data.messages : [];
      const target = messages.find(m => m.id === id);
      if (!target) return;

      if (target.userId !== userId) {
        socket.emit("deleteFailed", { id, reason: "not_owner" });
        return;
      }

      const next = messages.filter(m => m.id !== id);
      loaded.data.messages = next;
      await saveRoomData(room, loaded.data, loaded.sha);

      io.to(room).emit("delete message", id);
    } catch (e) {
      console.error("requestDelete error:", e);
      socket.emit("deleteFailed", { id, reason: "server_error" });
    }
  });

  // 管理者：全削除（部屋単位）
  socket.on("adminClearAll", async ({ room, password }) => {
    try {
      if (password !== ADMIN_PASSWORD) {
        socket.emit("adminClearFailed", "wrong password");
        return;
      }
      if (!room || !safeRoomName(room)) return;

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
