const socket = io();

// room (from query)
const params = new URLSearchParams(location.search);
const room = params.get("room");

// room必須：無ければ部屋一覧へ
if (!room) {
  location.replace("/rooms.html");
}

// ===== URL直打ち対策（password突破済みの人のみ） =====
if (localStorage.getItem("auth") === "ok") {
  const KEY_SITE_LAST = "chat_site_last_access";
  const last = Number(localStorage.getItem(KEY_SITE_LAST) || "0");
  const TEN_MIN = 10 * 60 * 1000;

  if (!last || (Date.now() - last) > TEN_MIN) {
    location.replace("/rooms.html");
  }
}

// DOM
const setupPanel = document.getElementById("setupPanel");
const usernameInput = document.getElementById("usernameInput");
const colorInput = document.getElementById("colorInput");
const avatarInput = document.getElementById("avatarInput");
const saveSettingsBtn = document.getElementById("saveSettings");
const cancelSetupBtn = document.getElementById("cancelSetup");
const openSettingsBtn = document.getElementById("openSettings");
const backToRoomsBtn = document.getElementById("backToRooms");
const roomTitle = document.getElementById("roomTitle");

const messagesEl = document.getElementById("messages");
const userListEl = document.getElementById("userList");
const onlineCountEl = document.getElementById("onlineCount");
const inputEl = document.getElementById("m");
const sendBtn = document.getElementById("send");

// ★画像送信UI（index.htmlに追加済み前提）
const imageInput = document.getElementById("imageInput");
const imageBtn = document.getElementById("imageBtn");

// localStorage keys
const KEY_NAME = "chat_username";
const KEY_COLOR = "chat_color";
const KEY_AVATAR = "chat_avatar";
const KEY_UID = "chat_user_id";

// 永続 userId（これが“削除権限”の本体）
let userId = localStorage.getItem(KEY_UID);
if (!userId) {
  userId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
  localStorage.setItem(KEY_UID, userId);
}

let username = localStorage.getItem(KEY_NAME) || "";
let color = localStorage.getItem(KEY_COLOR) || "#00b900";
let avatar = localStorage.getItem(KEY_AVATAR) || null;

// UI: room name
if (roomTitle) roomTitle.textContent = `Room: ${room}`;

if (backToRoomsBtn) {
  backToRoomsBtn.addEventListener("click", () => {
    location.href = "/rooms.html";
  });
}

// 初回表示
function showSetupIfNeeded() {
  if (username && color) {
    setupPanel.style.display = "none";
    socket.emit("userJoin", { userId, name: username, color, avatar });
  } else {
    setupPanel.style.display = "flex";
    if (username) usernameInput.value = username;
    colorInput.value = color;
  }
}
showSetupIfNeeded();

// avatar ファイルを base64
avatarInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { avatar = reader.result; };
  reader.readAsDataURL(file);
});

// 保存
saveSettingsBtn.addEventListener("click", () => {
  const name = usernameInput.value.trim();
  const col = colorInput.value;

  if (!name) return alert("名前を入力してください");

  username = name;
  color = col;

  if (avatar) {
    try { localStorage.setItem(KEY_AVATAR, avatar); } catch(e){}
  } else {
    const stored = localStorage.getItem(KEY_AVATAR);
    if (stored) avatar = stored;
  }

  localStorage.setItem(KEY_NAME, username);
  localStorage.setItem(KEY_COLOR, color);

  socket.emit("userJoin", { userId, name: username, color, avatar });
  setupPanel.style.display = "none";
});

// キャンセル
cancelSetupBtn.addEventListener("click", () => {
  if (username && color) setupPanel.style.display = "none";
  else alert("名前を入力してから開始してください");
});

// 設定を開く
openSettingsBtn.addEventListener("click", () => {
  usernameInput.value = username || "";
  colorInput.value = color || "#00b900";
  avatarInput.value = "";
  setupPanel.style.display = "flex";
});

// HTML エスケープ
function escapeHtml(s) {
  if (!s && s !== 0) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// 日付+時刻フォーマット
// 今日：HH:MM / それ以外：YYYY/MM/DD HH:MM
function formatTime(ts) {
  const n = Number(ts || 0);
  if (!n) return "";

  const d = new Date(n);
  const now = new Date();

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");

  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  return isToday ? `${hh}:${mi}` : `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}

/* ===== 画像：自動リサイズ（最大1280px、JPEG圧縮） ===== */
function resizeImageToJpegBlob(file, maxSize = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onload = () => {
      img.onload = () => {
        let { width, height } = img;

        if (width > maxSize || height > maxSize) {
          const scale = Math.min(maxSize / width, maxSize / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error("toBlob failed"));
            resolve(blob);
          },
          "image/jpeg",
          quality
        );
      };
      img.onerror = reject;
      img.src = reader.result;
    };

    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result || "");
      const base64 = dataUrl.split(",")[1] || "";
      resolve(base64);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// メッセージ要素
function makeMessageEl(msg) {
  // msg: { id, userId, name, color, text, avatar, type, path, ts }
  const isOwner = (msg.userId === userId);
  const isSelf = isOwner;

  const li = document.createElement("li");
  li.className = "message " + (isSelf ? "right" : "left");
  li.dataset.id = msg.id;

  let iconHtml = "";
  if (msg.avatar) {
    iconHtml = `<img class="icon" src="${msg.avatar}" alt="avatar">`;
  } else {
    const initials = (msg.name || "?").split(" ").map(s=>s[0]).join("").slice(0,2).toUpperCase();
    iconHtml = `<div class="icon" style="background:${msg.color};">${initials}</div>`;
  }

  let toolsHtml = "";
  if (isOwner) {
    toolsHtml = `
      <div class="msg-tools">
        <button class="msg-button open-menu">…</button>
        <button class="msg-button delete" title="削除">🗑</button>
      </div>
    `;
  }

  // テキスト/画像の分岐
  let bubbleHtml = "";
  if (msg && msg.type === "image" && msg.path) {
    const src = `/image?path=${encodeURIComponent(msg.path)}`;
    bubbleHtml = `
      <div class="bubble image">
        <img class="chat-image" src="${src}" alt="image">
      </div>
    `;
  } else {
    bubbleHtml = `<div class="bubble">${escapeHtml(msg.text)}</div>`;
  }

  const timeStr = formatTime(msg.ts);

  li.innerHTML = `
    ${iconHtml}
    <div class="meta">
      <div class="msg-name" style="color:${msg.color}">
        <span>${escapeHtml(msg.name)}</span>
        <span style="margin-left:8px; font-size:11px; color:#777; white-space:nowrap;">
          ${escapeHtml(timeStr)}
        </span>
      </div>
      ${bubbleHtml}
    </div>
    ${toolsHtml}
  `;

  if (isOwner) {
    const delBtn = li.querySelector(".delete");
    const openBtn = li.querySelector(".open-menu");
    if (delBtn) {
      delBtn.addEventListener("click", () => {
        socket.emit("requestDelete", { room, id: msg.id, userId });
      });
      delBtn.style.display = "none";
    }
    if (openBtn) {
      openBtn.addEventListener("click", () => {
        if (delBtn) {
          delBtn.style.display = (delBtn.style.display === "inline-block") ? "none" : "inline-block";
        }
      });
    }
  }

  return li;
}

// ルーム参加して履歴要求
socket.emit("joinRoom", { room });

// 履歴受信（room付き）
socket.on("history", ({ room: r, msgs }) => {
  if (r !== room) return;
  messagesEl.innerHTML = "";
  (msgs || []).forEach(m => {
    const el = makeMessageEl(m);
    messagesEl.appendChild(el);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

socket.on("roomNotFound", () => {
  alert("部屋が存在しません");
  location.replace("/rooms.html");
});

// 新着
socket.on("chat message", (m) => {
  const el = makeMessageEl(m);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

// ユーザー一覧
socket.on("userList", (list) => {
  userListEl.innerHTML = "";
  onlineCountEl.textContent = `オンライン: ${list.length}`;
  list.forEach(u => {
    const div = document.createElement("div");
    div.className = "user-item";
    let imgHtml = "";
    if (u.avatar) {
      imgHtml = `<img class="uimg" src="${u.avatar}" alt="u">`;
    } else {
      const initials = (u.name||"?").split(" ").map(s=>s[0]).join("").slice(0,2).toUpperCase();
      imgHtml = `<div class="uimg" style="background:${u.color}; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700">${initials}</div>`;
    }
    div.innerHTML = `${imgHtml}<div class="uname" style="color:${u.color}">${escapeHtml(u.name)}</div>`;
    userListEl.appendChild(div);
  });
});

// 削除反映
socket.on("delete message", (id) => {
  const el = messagesEl.querySelector(`[data-id="${id}"]`);
  if (el) el.remove();
});

socket.on("deleteFailed", ({ reason }) => {
  if (reason === "not_owner") alert("他人のメッセージは削除できません");
  else alert("削除に失敗しました");
});

// 送信（テキスト）
sendBtn.addEventListener("click", sendMessage);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  if (!username) {
    alert("先に設定してください（⚙を押してください）");
    setupPanel.style.display = "flex";
    return;
  }

  const msg = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2),
    userId,                 // ★これが所有者キー
    name: username,
    color: color,
    avatar: avatar || null,
    type: "text",
    text,
    ts: Date.now()
  };

  socket.emit("chat message", { room, msg });
  inputEl.value = "";
}

/* ===== 画像送信 ===== */
if (imageBtn && imageInput) {
  imageBtn.addEventListener("click", () => {
    imageInput.click();
  });

  imageInput.addEventListener("change", async () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;

    try {
      if (!username) {
        alert("先に設定してください（⚙を押してください）");
        setupPanel.style.display = "flex";
        return;
      }

      if (file.size > 15 * 1024 * 1024) {
        alert("画像が大きすぎます（15MBまで）");
        return;
      }

      const blob = await resizeImageToJpegBlob(file, 1280, 0.85);
      const base64 = await blobToBase64(blob);

      const filename =
        (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2))
        + ".jpg";

      const upRes = await fetch("/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room,
          filename,
          dataBase64: base64
        })
      });

      const up = await upRes.json().catch(() => ({}));
      if (!up.ok || !up.path) {
        alert("画像アップロードに失敗しました");
        return;
      }

      const msg = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2),
        userId,
        name: username,
        color: color,
        avatar: avatar || null,
        type: "image",
        path: up.path,
        ts: Date.now()
      };

      socket.emit("chat message", { room, msg });
    } catch (e) {
      console.error("image send error:", e);
      alert("画像送信に失敗しました");
    } finally {
      imageInput.value = "";
    }
  });
}

// 念のためjoin送る
if (username) {
  if (!avatar) avatar = localStorage.getItem(KEY_AVATAR) || null;
  socket.emit("userJoin", { userId, name: username, color, avatar });
}

/* 管理者：全削除（部屋単位） */
const adminClearBtn = document.getElementById("adminClearBtn");
if (adminClearBtn) {
  adminClearBtn.addEventListener("click", () => {
    const password = prompt("管理者パスワードを入力してください");
    if (!password) return;
    socket.emit("adminClearAll", { room, password });
  });
}

socket.on("clearAllMessages", () => {
  messagesEl.innerHTML = "";
  alert("全メッセージを削除しました");
});

socket.on("adminClearFailed", (msg) => {
  alert("管理者操作失敗: " + msg);
});
