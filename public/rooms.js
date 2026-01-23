const roomsListEl = document.getElementById("roomsList");
const joinBox = document.getElementById("joinBox");
const selectedRoomEl = document.getElementById("selectedRoom");
const joinRoomPass = document.getElementById("joinRoomPass");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const joinMsg = document.getElementById("joinMsg");

const createRoomName = document.getElementById("createRoomName");
const createRoomPass = document.getElementById("createRoomPass");
const createRoomBtn = document.getElementById("createRoomBtn");
const createMsg = document.getElementById("createMsg");

const recentRoomsEl = document.getElementById("recentRooms");
const logoutBtn = document.getElementById("logoutBtn");

const KEY_RECENT = "chat_recent_rooms";

let selectedRoom = null;

/* ===== utils ===== */
function safeRoomName(name) {
  return /^[a-zA-Z0-9_-]{1,40}$/.test(name);
}

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem(KEY_RECENT) || "[]");
  } catch {
    return [];
  }
}

function setRecent(list) {
  localStorage.setItem(KEY_RECENT, JSON.stringify(list.slice(0, 20)));
}

function addRecent(room, existingRooms) {
  // 存在しない部屋は絶対に追加しない
  if (!existingRooms.has(room)) return;

  const list = getRecent().filter(r => r !== room);
  list.unshift(room);
  setRecent(list);
  renderRecent(existingRooms);
}

/* ===== recent render ===== */
function renderRecent(existingRooms) {
  const list = getRecent().filter(r => existingRooms.has(r));

  if (!list.length) {
    recentRoomsEl.textContent = "なし";
    return;
  }

  recentRoomsEl.innerHTML = "";
  list.forEach(r => {
    const btn = document.createElement("button");
    btn.className = "room-btn";
    btn.textContent = r;
    btn.onclick = () => openJoin(r);
    recentRoomsEl.appendChild(btn);
  });

  // ゴミ掃除（存在しない部屋をlocalStorageから削除）
  setRecent(list);
}

/* ===== load rooms ===== */
let cachedRooms = new Set();

async function loadRooms() {
  roomsListEl.textContent = "読み込み中…";

  const res = await fetch("/rooms");
  const data = await res.json();
  const rooms = (data.rooms || []).sort((a, b) => a.localeCompare(b, "ja"));

  cachedRooms = new Set(rooms);

  roomsListEl.innerHTML = "";
  if (!rooms.length) {
    roomsListEl.textContent = "部屋がありません（作成してください）";
  } else {
    rooms.forEach(r => {
      const btn = document.createElement("button");
      btn.className = "room-btn";
      btn.textContent = r;
      btn.onclick = () => openJoin(r);
      roomsListEl.appendChild(btn);
    });
  }

  // recent を rooms に合わせて掃除
  renderRecent(cachedRooms);
}

/* ===== join UI ===== */
function openJoin(room) {
  selectedRoom = room;
  joinBox.style.display = "block";
  selectedRoomEl.textContent = `選択中: ${room}`;
  joinRoomPass.value = "";
  joinMsg.textContent = "";
}

/* ===== join ===== */
joinRoomBtn.addEventListener("click", async () => {
  if (!selectedRoom) return;

  const pass = joinRoomPass.value;
  if (!pass) {
    joinMsg.textContent = "パスワードを入力してください";
    return;
  }

  const res = await fetch("/rooms/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: selectedRoom, password: pass })
  });

  const data = await res.json();

  if (data.ok) {
    addRecent(selectedRoom, cachedRooms);
    location.href = `/index.html?room=${encodeURIComponent(selectedRoom)}`;
  } else {
    joinMsg.textContent = "パスワードが違うか、部屋がありません";
  }
});

/* ===== create ===== */
createRoomBtn.addEventListener("click", async () => {
  const room = (createRoomName.value || "").trim();
  const pass = createRoomPass.value;

  if (!room) {
    createMsg.textContent = "部屋名を入力してください";
    return;
  }
  if (!safeRoomName(room)) {
    createMsg.textContent = "部屋名は英数と - _ のみ（最大40）";
    return;
  }
  if (!pass) {
    createMsg.textContent = "部屋パスワードを入力してください";
    return;
  }

  createMsg.textContent = "作成中…";

  const res = await fetch("/rooms/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, password: pass })
  });

  const data = await res.json();

  if (data.ok) {
    createMsg.textContent = "作成しました。入室できます。";
    await loadRooms();
    openJoin(room);
    joinRoomPass.value = pass;
  } else if (data.error === "exists") {
    createMsg.textContent = "同じ部屋名が既にあります";
  } else if (data.error === "bad_room_name") {
    createMsg.textContent = "部屋名が不正です";
  } else {
    createMsg.textContent = "作成に失敗しました";
  }
});

/* ===== logout ===== */
logoutBtn.addEventListener("click", () => {
  localStorage.removeItem("auth");
  location.replace("/password.html");
});

/* ===== init ===== */
loadRooms();
