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
const KEY_UID = "chat_user_id";

let selectedRoom = null;
let roomsCache = [];

let userId = localStorage.getItem(KEY_UID);
if (!userId) {
  userId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
  localStorage.setItem(KEY_UID, userId);
}

function safeRoomName(name){
  return /^[a-zA-Z0-9_-]{1,40}$/.test(name);
}

function getRecent(){
  try { return JSON.parse(localStorage.getItem(KEY_RECENT) || "[]"); }
  catch { return []; }
}

function setRecent(list){
  localStorage.setItem(KEY_RECENT, JSON.stringify(list.slice(0, 20)));
}

function addRecent(room){
  const list = getRecent().filter(r => r !== room);
  list.unshift(room);
  setRecent(list);
}

function roomExists(room){
  return roomsCache.includes(room);
}

function renderRecent(){
  const list = getRecent();
  const filtered = list.filter(r => roomExists(r));

  if (!filtered.length) {
    recentRoomsEl.textContent = "なし";
  } else {
    recentRoomsEl.innerHTML = "";
    filtered.forEach(r => {
      const btn = document.createElement("button");
      btn.className = "room-btn";
      btn.textContent = r;
      btn.onclick = () => openJoin(r);
      recentRoomsEl.appendChild(btn);
    });
  }

  // 消えた部屋は永続リストから掃除
  if (filtered.length !== list.length) setRecent(filtered);
}

async function loadRooms(){
  roomsListEl.textContent = "読み込み中…";
  const res = await fetch("/rooms");
  const data = await res.json();
  roomsCache = (data.rooms || []).slice();

  const rooms = roomsCache.slice().sort((a,b)=>a.localeCompare(b, "ja"));
  roomsListEl.innerHTML = "";

  if (!rooms.length){
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

  renderRecent(); // ★一覧取得後にrecent描画
}

function openJoin(room){
  selectedRoom = room;
  joinBox.style.display = "block";
  selectedRoomEl.textContent = `選択中: ${room}`;
  joinRoomPass.value = "";
  joinMsg.textContent = "";
}

joinRoomBtn.addEventListener("click", async () => {
  if (!selectedRoom) return;
  const pass = joinRoomPass.value;
  if (!pass) { joinMsg.textContent = "パスワードを入力してください"; return; }

  const res = await fetch("/rooms/join", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ room: selectedRoom, password: pass, userId })
  });

  const data = await res.json();

  if (data.ok){
    // ★存在する部屋だけrecentへ
    if (roomExists(selectedRoom)) addRecent(selectedRoom);

    // ★tokenは保存しない（毎回パス必須運用）
    // URLに付けて index へ
    location.href = `/index.html?room=${encodeURIComponent(selectedRoom)}&t=${encodeURIComponent(data.token)}`;
  } else if (data.error === "wrong_password") {
    joinMsg.textContent = "パスワードが違います";
  } else {
    joinMsg.textContent = "部屋がありません";
  }
});

createRoomBtn.addEventListener("click", async () => {
  const room = (createRoomName.value || "").trim();
  const pass = createRoomPass.value;

  if (!room) { createMsg.textContent = "部屋名を入力してください"; return; }
  if (!safeRoomName(room)) { createMsg.textContent = "部屋名は英数と - _ のみ（最大40）"; return; }
  if (!pass) { createMsg.textContent = "部屋パスワードを入力してください"; return; }

  createMsg.textContent = "作成中…";

  const res = await fetch("/rooms/create", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ room, password: pass })
  });
  const data = await res.json();

  if (data.ok){
    createMsg.textContent = "作成しました。参加してください。";
    await loadRooms();
    openJoin(room);
  } else if (data.error === "exists"){
    createMsg.textContent = "同じ部屋名が既にあります";
  } else if (data.error === "bad_room_name"){
    createMsg.textContent = "部屋名が不正です（英数と - _ のみ）";
  } else {
    createMsg.textContent = "作成に失敗しました";
  }
});

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem("auth");
  location.replace("/password.html");
});

loadRooms();
