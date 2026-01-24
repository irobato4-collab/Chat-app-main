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
const ROOM_DIR = "rooms";       // 暗号化roomデータ保存先
const UPLOAD_DIR = "uploads";   // 画像保存先（同じrepo）
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
app.use(express.json({ limit: "10mb" }));

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
/* ===== バイナリ用 暗号化（画像） ===== */
function encryptBinary(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptBinary(encBase64) {
  const buf = Buffer.from(encBase64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
/* ===== GitHub API ===== */
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "Content-Type": "application/json",
  "User-Agent": "chat-app"
};

function ghContentUrl(filePath) {
  return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}?ref=${GITHUB_BRANCH}`;
}

async function ghGetJson(url) {
  const res = await fetch(url, { headers: GH_HEADERS });
  if (!res.ok) return { ok: false, status: res.status, json: null, text: await res.text().catch(() => "") };
  const json = await res.json();
  return { ok: true, status: res.status, json };
}

async function ghPut(filePath, contentBase64, sha, message = "update data") {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}`;
  const body = {
    message,
    content: contentBase64,
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {})
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: GH_HEADERS,
    body: JSON.stringify(body)
  });
  return res;
}

async function ghDelete(filePath, sha, message = "delete file") {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}`;
  const body = { message, sha, branch: GITHUB_BRANCH };
  const res = await fetch(url, {
    method: "DELETE",
    headers: GH_HEADERS,
    body: JSON.stringify(body)
  });
  return res;
}

function safeRoomName(name) {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(name);
}

function safeUploadFilename(name) {
  // リサイズ後はjpg固定にする想定
  return /^[a-zA-Z0-9_-]{1,80}\.jpg$/i.test(name);
}

function roomFilePath(room) {
  return `${ROOM_DIR}/${room}.env.json`;
}

function hashRoomPassword(roomPassword) {
  return crypto.createHash("sha256").update(String(roomPassword)).digest("hex");
}

/* ===== ルームデータ読み書き（暗号化） ===== */
async function loadRoomData(room) {
  const filePath = roomFilePath(room);
  const url = ghContentUrl(filePath);
  const r = await fetch(url, { headers: GH_HEADERS });

  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub load failed: ${r.status}`);

  const json = await r.json();
  const decrypted = decrypt(Buffer.from(json.content, "base64").toString());
  const data = JSON.parse(decrypted);
  return { data, sha: json.sha };
}

async function saveRoomData(room, data, sha) {
  const encrypted = encrypt(JSON.stringify(data));
  const content = Buffer.from(encrypted).toString("base64");
  const filePath = roomFilePath(room);
  const res = await ghPut(filePath, content, sha, "update room data");
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GitHub save failed: ${res.status} ${t}`);
  }
}

/* ===== 30日超の画像を履歴から削除（画像ファイルも消す用の抽出） ===== */
function splitOldImages(messages) {
  const now = Date.now();
  const keep = [];
  const remove = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (m && m.type === "image") {
      const ts = Number(m.ts || 0);
      if (ts && (now - ts) > IMAGE_TTL_MS) {
        remove.push(m);
        continue;
      }
    }
    keep.push(m);
  }
  return { keep, remove };
}

/* ===== 画像ファイルパス ===== */
function uploadFilePath(room, filename) {
  return `${UPLOAD_DIR}/${room}/${filename}`;
}

/* ===== 画像の削除（GitHub上のファイルをDELETE） ===== */
async function deleteImageFileIfPossible(imagePath) {
  try {
    if (!imagePath || typeof imagePath !== "string") return;
    if (!imagePath.startsWith(`${UPLOAD_DIR}/`)) return;

    // sha を取得
    const url = ghContentUrl(imagePath);
    const r = await fetch(url, { headers: GH_HEADERS });
    if (r.status === 404) return; // もう無い
    if (!r.ok) return;

    const json = await r.json();
    const sha = json.sha;
    if (!sha) return;

    await ghDelete(imagePath, sha, "delete image file");
  } catch (e) {
    console.error("deleteImageFileIfPossible error:", e);
  }
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

    const data = { room, passHash: hashRoomPassword(password), messages: [] };
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

/* ===== 画像アップロード（base64→GitHub PUT） ===== */
app.post("/upload", async (req, res) => {
  try {
    const { room, filename, dataBase64 } = req.body || {};
    if (!room || !safeRoomName(room)) return res.status(400).json({ ok: false, error: "bad_room" });
    if (!filename || !safeUploadFilename(filename)) return res.status(400).json({ ok: false, error: "bad_filename" });
    if (!dataBase64 || typeof dataBase64 !== "string") return res.status(400).json({ ok: false, error: "missing" });

    const filePath = uploadFilePath(room, filename);

    // 既存sha（通常uuidなので無いが安全のため）
    let sha;
    const meta = await ghGetJson(ghContentUrl(filePath));
    if (meta.ok && meta.json && meta.json.sha) sha = meta.json.sha;

    const rawBuffer = Buffer.from(dataBase64, "base64");
const encryptedBase64 = encryptBinary(rawBuffer);

const putRes = await ghPut(
  filePath,
  Buffer.from(encryptedBase64).toString("base64"),
  sha,
  "upload encrypted image"
);
    if (!putRes.ok) {
      const t = await putRes.text().catch(() => "");
      console.error("upload failed:", putRes.status, t);
      return res.status(500).json({ ok: false, error: "github" });
    }

    res.json({ ok: true, path: filePath });
  } catch (e) {
    console.error("POST /upload error:", e);
    res.status(500).json({ ok: false, error: "server" });
  }
});

/* ===== private repo画像取得（GitHubから取ってそのまま返す） ===== */
app.get("/image", async (req, res) => {
  try {
    const filePath = String(req.query.path || "");
    if (!filePath) return res.sendStatus(400);
    if (!filePath.startsWith(`${UPLOAD_DIR}/`)) return res.sendStatus(403);

    const meta = await ghGetJson(ghContentUrl(filePath));
    if (!meta.ok || !meta.json) return res.sendStatus(404);

    const encryptedBase64 = Buffer.from(meta.json.content, "base64").toString();
const imageBuffer = decryptBinary(encryptedBase64);

res.type("jpeg");
res.setHeader("Cache-Control", "public, max-age=86400");
res.send(imageBuffer);
    
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

  // ルーム入室（履歴送る）＋30日超画像を掃除（履歴＆ファイル）
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
      const { keep, remove } = splitOldImages(before);

      // 古い画像があれば、履歴更新＋画像ファイル削除
      if (remove.length) {
        loaded.data.messages = keep;
        await saveRoomData(room, loaded.data, loaded.sha);

        // 画像ファイルも削除（失敗しても致命ではない）
        for (const m of remove) {
          if (m && m.path) await deleteImageFileIfPossible(m.path);
        }
      }

      socket.emit("history", { room, msgs: keep });
    } catch (e) {
      console.error("joinRoom error:", e);
      socket.emit("roomError", "join failed");
    }
  });

  // 送信（保存前に30日超画像を掃除）
  socket.on("chat message", async ({ room, msg }) => {
    try {
      if (!room || !safeRoomName(room)) return;
      if (!msg || !msg.id) return;

      const loaded = await loadRoomData(room);
      if (!loaded) return;

      let messages = Array.isArray(loaded.data.messages) ? loaded.data.messages : [];

      // tsが無い古い互換を避けるため、無ければサーバで付与
      if (!msg.ts) msg.ts = Date.now();

      messages.push(msg);

      const { keep, remove } = splitOldImages(messages);
      messages = keep;

      if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);

      loaded.data.messages = messages;
      await saveRoomData(room, loaded.data, loaded.sha);

      // 古い画像が出たらファイルも掃除
      for (const m of remove) {
        if (m && m.path) await deleteImageFileIfPossible(m.path);
      }

      io.to(room).emit("chat message", msg);
    } catch (e) {
      console.error("chat message error:", e);
    }
  });

  // 削除（画像ならファイルも消す）
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

      // 画像ならファイルも削除（非同期でもOKだが、ここはawait）
      if (target.type === "image" && target.path) {
        await deleteImageFileIfPossible(target.path);
      }

      io.to(room).emit("delete message", id);
    } catch (e) {
      console.error("requestDelete error:", e);
      socket.emit("deleteFailed", { id, reason: "server_error" });
    }
  });

  // 管理者：全削除（部屋単位）＋画像ファイルも削除
  socket.on("adminClearAll", async ({ room, password }) => {
    try {
      if (password !== ADMIN_PASSWORD) {
        socket.emit("adminClearFailed", "wrong password");
        return;
      }
      if (!room || !safeRoomName(room)) return;

      const loaded = await loadRoomData(room);
      if (!loaded) return;

      const messages = Array.isArray(loaded.data.messages) ? loaded.data.messages : [];

      loaded.data.messages = [];
      await saveRoomData(room, loaded.data, loaded.sha);

      // 画像ファイルも削除
      for (const m of messages) {
        if (m && m.type === "image" && m.path) {
          await deleteImageFileIfPossible(m.path);
        }
      }

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
