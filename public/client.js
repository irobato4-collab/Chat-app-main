const socket = io();

// room (from query)
const params = new URLSearchParams(location.search);
const room = params.get("room");

// room必須：無ければ部屋一覧へ
if (!room) {
  location.replace("/rooms.html");
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
avatarInput.addEventListener("change", async (e) => {
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
function escapeHtml(s){
  if (!s && s !== 0) return "";
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// メッセージ要素
function makeMessageEl(msg) {
  // msg: { id, userId, name, color, text, avatar }
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

  li.innerHTML = `
    ${iconHtml}
    <div class="meta">
      <div class="msg-name" style="color:${msg.color}">${escapeHtml(msg.name)}</div>
      <div class="bubble">${escapeHtml(msg.text)}</div>
    </div>
    ${toolsHtml}
  `;

  if (isOwner) {
    const delBtn = li.querySelector(".delete");
    if (delBtn) {
      delBtn.addEventListener("click", () => {
        socket.emit("requestDelete", { room, id: msg.id, userId });
      });
    }
    const openBtn = li.querySelector(".open-menu");
    if (openBtn) {
      openBtn.addEventListener("click", () => {
        const del = li.querySelector(".delete");
        if (del) del.style.display = (del.style.display === "inline-block") ? "none" : "inline-block";
      });
      const del = li.querySelector(".delete");
      if (del) del.style.display = "none";
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

// 送信
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
    text
  };

  socket.emit("chat message", { room, msg });
  inputEl.value = "";
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
