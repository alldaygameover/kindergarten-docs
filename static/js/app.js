const CATEGORY_LABELS = {
  holiday: "假期",
  activity: "活動",
  payment: "繳費",
  uniform: "校服",
  meeting: "會議",
  excursion: "外出",
  other: "其他",
};

const FETCH_OPTS = { credentials: "include" };

let calendar = null;
let currentEventId = null;
let currentUser = null;

document.addEventListener("DOMContentLoaded", async () => {
  initModal();
  const user = await checkAuth();
  if (!user) return;

  initCalendar();
  initUpload();
  checkHealth();
  loadDocuments();
});

async function checkAuth() {
  try {
    const res = await fetch("/api/me", FETCH_OPTS);
    const data = await res.json();

    if (!data.authenticated) {
      showLoginScreen();
      return null;
    }

    currentUser = data;
    showApp(data);
    return data;
  } catch {
    showLoginScreen("無法連接伺服器");
    return null;
  }
}

function showLoginScreen(error) {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app-main").classList.add("hidden");
  document.getElementById("user-menu").classList.add("hidden");

  const errEl = document.getElementById("login-error");
  if (error) {
    errEl.textContent = error;
    errEl.classList.remove("hidden");
  } else {
    errEl.classList.add("hidden");
  }
}

function showApp(user) {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-main").classList.remove("hidden");

  const menu = document.getElementById("user-menu");
  menu.classList.remove("hidden");
  document.getElementById("user-name").textContent = user.name || user.email;
  const avatar = document.getElementById("user-avatar");
  if (user.picture) {
    avatar.src = user.picture;
    avatar.classList.remove("hidden");
  } else {
    avatar.classList.add("hidden");
  }
}

function initCalendar() {
  const el = document.getElementById("calendar");
  calendar = new FullCalendar.Calendar(el, {
    initialView: "dayGridMonth",
    locale: "zh-tw",
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,listMonth",
    },
    height: "auto",
    events: async (info, success, failure) => {
      try {
        const res = await fetch("/api/events", FETCH_OPTS);
        if (res.status === 401) {
          showLoginScreen();
          success([]);
          return;
        }
        success(await res.json());
      } catch (err) {
        failure(err);
      }
    },
    eventClick(info) {
      showEventModal(info.event);
    },
    eventDidMount(info) {
      info.el.title = info.event.title;
    },
  });
  calendar.render();
}

function initUpload() {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const selectBtn = document.getElementById("select-btn");

  selectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    uploadFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener("change", () => {
    uploadFiles(fileInput.files);
    fileInput.value = "";
  });
}

async function uploadFiles(files) {
  if (!files.length) return;

  const progress = document.getElementById("upload-progress");
  const results = document.getElementById("upload-results");
  progress.classList.remove("hidden");
  results.innerHTML = "";

  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

  try {
    const res = await fetch("/api/upload", { method: "POST", body: formData, credentials: "include" });
    const data = await res.json();

    if (res.status === 401) {
      showLoginScreen();
      return;
    }
    if (!res.ok) {
      results.innerHTML = `<div class="result-item error">${data.detail || "上傳失敗"}</div>`;
      return;
    }

    for (const r of data.results) {
      const cls = r.success ? "success" : "error";
      const msg = r.success
        ? `✓ ${r.filename} — 找到 ${r.events_found} 個活動。${r.summary || ""}`
        : `✗ ${r.filename} — ${r.error}`;
      results.innerHTML += `<div class="result-item ${cls}">${msg}</div>`;
    }

    calendar.refetchEvents();
    loadDocuments();
  } catch (err) {
    results.innerHTML = `<div class="result-item error">上傳失敗: ${err.message}</div>`;
  } finally {
    progress.classList.add("hidden");
  }
}

async function loadDocuments() {
  const list = document.getElementById("docs-list");
  try {
    const res = await fetch("/api/documents", FETCH_OPTS);
    if (res.status === 401) {
      showLoginScreen();
      return;
    }
    const docs = await res.json();

    if (!docs.length) {
      list.innerHTML = '<p class="empty-state">尚未上傳任何文件</p>';
      return;
    }

    list.innerHTML = docs.map((d) => `
      <div class="doc-card">
        <h4>📎 ${escapeHtml(d.filename)}</h4>
        <p>${escapeHtml(d.summary || "（無摘要）")}</p>
        <p style="margin-top:0.25rem;font-size:0.8rem;">上傳時間: ${formatDate(d.uploaded_at)}</p>
      </div>
    `).join("");
  } catch {
    list.innerHTML = '<p class="empty-state">無法載入文件列表</p>';
  }
}

async function checkHealth() {
  const badge = document.getElementById("status-badge");
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.redirect_uri) {
      document.getElementById("redirect-uri-display").textContent = data.redirect_uri;
      document.getElementById("oauth-setup-hint").classList.remove("hidden");
    }
    if (!data.google_oauth_set) {
      badge.textContent = "請設定 Google OAuth";
      badge.className = "status-badge warn";
    } else if (data.api_key_set) {
      badge.textContent = "AI 已就緒";
      badge.className = "status-badge ok";
    } else {
      badge.textContent = "請設定 API Key";
      badge.className = "status-badge warn";
    }
  } catch {
    badge.textContent = "服務未連接";
    badge.className = "status-badge warn";
  }
}

function initModal() {
  const modal = document.getElementById("event-modal");
  modal.querySelector(".modal-backdrop").addEventListener("click", closeModal);
  modal.querySelector(".modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-delete").addEventListener("click", deleteCurrentEvent);
}

function showEventModal(event) {
  currentEventId = event.id;
  const props = event.extendedProps;

  document.getElementById("modal-title").textContent = event.title;

  const fields = [
    ["類別", CATEGORY_LABELS[props.category] || props.category],
    ["日期", formatEventDate(event.start, event.end)],
    ["時間", props.time],
    ["地點", props.location],
    ["說明", props.description],
    ["注意事項", props.notes],
    ["來源文件", props.filename],
  ];

  document.getElementById("modal-body").innerHTML = fields
    .filter(([, v]) => v)
    .map(([label, value]) => `
      <div class="field">
        <div class="label">${label}</div>
        <div>${escapeHtml(String(value))}</div>
      </div>
    `).join("");

  document.getElementById("event-modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("event-modal").classList.add("hidden");
  currentEventId = null;
}

async function deleteCurrentEvent() {
  if (!currentEventId || !confirm("確定要刪除此活動？")) return;

  try {
    const res = await fetch(`/api/events/${currentEventId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.status === 401) {
      showLoginScreen();
      return;
    }
    closeModal();
    calendar.refetchEvents();
  } catch {
    alert("刪除失敗");
  }
}

function formatEventDate(start, end) {
  const s = start.toLocaleDateString("zh-HK");
  if (!end || start.toDateString() === end.toDateString()) return s;
  return `${s} — ${end.toLocaleDateString("zh-HK")}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString("zh-HK");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}