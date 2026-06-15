const CATEGORY_LABELS = {
  holiday: "假期",
  activity: "活動",
  payment: "繳費",
  uniform: "校服",
  meeting: "會議",
  excursion: "外出",
  other: "其他",
};

const FILE_TYPE_ICONS = {
  pdf: "📕",
  doc: "📘",
  image: "🖼️",
};

const FETCH_OPTS = { credentials: "include" };

let calendar = null;
let currentEventId = null;
let currentUser = null;
let useLocalStorage = true;

document.addEventListener("DOMContentLoaded", async () => {
  initModal();
  initTabs();
  initLegendToggle();
  await checkHealth();
  const user = await checkAuth();
  if (!user) return;

  initCalendar();
  initUpload();
  loadDocuments();
});

function isMobile() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function initTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      buttons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
      panels.forEach((p) => p.classList.toggle("active", p.dataset.panel === tab));
      if (tab === "calendar" && calendar) {
        calendar.updateSize();
      }
    });
  });
}

function initLegendToggle() {
  const toggle = document.getElementById("legend-toggle");
  const legend = document.getElementById("legend");
  if (!toggle || !legend) return;

  toggle.addEventListener("click", () => {
    const collapsed = legend.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  });
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.dataset.panel === tab);
  });
  if (tab === "calendar" && calendar) {
    calendar.updateSize();
  }
}

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

async function fetchCalendarEvents() {
  if (useLocalStorage) {
    const events = await LocalStore.getEvents(currentUser.id);
    return LocalStore.eventsToCalendar(events);
  }

  const res = await fetch("/api/events", FETCH_OPTS);
  if (res.status === 401) {
    showLoginScreen();
    return [];
  }
  return res.json();
}

function initCalendar() {
  const el = document.getElementById("calendar");
  const mobile = isMobile();

  calendar = new FullCalendar.Calendar(el, {
    initialView: mobile ? "listYear" : "dayGridMonth",
    locale: "zh-tw",
    headerToolbar: mobile
      ? { left: "prev,next", center: "title", right: "today" }
      : { left: "prev,next today", center: "title", right: "dayGridMonth,listYear" },
    height: "auto",
    events: async (info, success, failure) => {
      try {
        success(await fetchCalendarEvents());
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

  window.addEventListener("resize", () => {
    calendar.updateSize();
  });
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

  try {
    if (useLocalStorage) {
      await uploadFilesLocal(files, results);
    } else {
      await uploadFilesServer(files, results);
    }

    calendar.refetchEvents();
    loadDocuments();
    if (isMobile()) {
      switchTab("calendar");
    }
  } catch (err) {
    results.innerHTML = `<div class="result-item error">上傳失敗: ${err.message}</div>`;
  } finally {
    progress.classList.add("hidden");
  }
}

async function uploadFilesLocal(files, results) {
  for (const file of files) {
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = await res.json();

      if (res.status === 401) {
        showLoginScreen();
        return;
      }
      if (!res.ok) {
        results.innerHTML += `<div class="result-item error">✗ ${escapeHtml(file.name)} — ${escapeHtml(data.detail || "分析失敗")}</div>`;
        continue;
      }

      const { eventCount } = await LocalStore.saveDocumentWithEvents(currentUser.id, file, data);
      results.innerHTML += `<div class="result-item success">✓ ${escapeHtml(file.name)} — 找到 ${eventCount} 個活動，已儲存至此手機。${escapeHtml(data.summary || "")}</div>`;

      if (eventCount > 0 && data.events?.length) {
        const firstDate = data.events
          .map((e) => e.event_date)
          .filter(Boolean)
          .sort()[0];
        if (firstDate && calendar) {
          calendar.gotoDate(firstDate);
        }
      }
    } catch (err) {
      results.innerHTML += `<div class="result-item error">✗ ${escapeHtml(file.name)} — ${escapeHtml(err.message)}</div>`;
    }
  }
}

async function uploadFilesServer(files, results) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

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
}

async function loadDocuments() {
  const list = document.getElementById("docs-list");
  const countEl = document.getElementById("docs-count");

  try {
    const docs = useLocalStorage
      ? await LocalStore.getDocuments(currentUser.id)
      : await fetchServerDocuments();

    countEl.textContent = `${docs.length} 份`;

    if (!docs.length) {
      list.innerHTML = '<p class="empty-state">尚未上傳任何文件</p>';
      return;
    }

    list.innerHTML = docs.map((d) => `
      <article class="doc-card" data-id="${d.id}">
        <div class="doc-card-icon">${FILE_TYPE_ICONS[d.file_type] || "📎"}</div>
        <div class="doc-card-body">
          <div class="doc-card-title">${escapeHtml(d.filename)}</div>
          <div class="doc-card-summary">${escapeHtml(d.summary || "（無摘要）")}</div>
          <div class="doc-card-meta">
            <span>${formatDate(d.uploaded_at)}</span>
            <span>${d.event_count || 0} 個活動</span>
            ${useLocalStorage ? "<span>📱 此手機</span>" : ""}
          </div>
        </div>
        <div class="doc-card-actions">
          ${canViewFile(d.file_type) ? `<button type="button" class="btn btn-primary btn-sm doc-view-btn" data-id="${d.id}">查看</button>` : ""}
          <button type="button" class="btn btn-secondary btn-sm doc-download-btn" data-id="${d.id}">下載</button>
          <button type="button" class="btn btn-outline btn-sm doc-delete-btn" data-id="${d.id}" data-filename="${escapeAttr(d.filename)}">刪除</button>
        </div>
      </article>
    `).join("");

    list.querySelectorAll(".doc-view-btn").forEach((btn) => {
      btn.addEventListener("click", () => viewDocument(Number(btn.dataset.id)));
    });
    list.querySelectorAll(".doc-download-btn").forEach((btn) => {
      btn.addEventListener("click", () => downloadDocument(Number(btn.dataset.id)));
    });
    list.querySelectorAll(".doc-delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        deleteDocument(Number(btn.dataset.id), btn.dataset.filename);
      });
    });
  } catch {
    list.innerHTML = '<p class="empty-state">無法載入文件列表</p>';
    countEl.textContent = "0 份";
  }
}

async function fetchServerDocuments() {
  const res = await fetch("/api/documents", FETCH_OPTS);
  if (res.status === 401) {
    showLoginScreen();
    return [];
  }
  return res.json();
}

function canViewFile(fileType) {
  return fileType === "pdf" || fileType === "image";
}

async function viewDocument(docId) {
  if (useLocalStorage) {
    const doc = await LocalStore.getDocument(currentUser.id, docId);
    if (!doc) {
      alert("找不到文件");
      return;
    }
    LocalStore.openBlob(doc, false);
    return;
  }
  window.open(`/api/documents/${docId}/file`, "_blank", "noopener");
}

async function downloadDocument(docId) {
  if (useLocalStorage) {
    const doc = await LocalStore.getDocument(currentUser.id, docId);
    if (!doc) {
      alert("找不到文件");
      return;
    }
    LocalStore.openBlob(doc, true);
    return;
  }
  window.location.href = `/api/documents/${docId}/file?download=1`;
}

async function deleteDocument(docId, filename) {
  const msg = `確定要刪除「${filename}」？\n\n相關月曆活動也會一併刪除。`;
  if (!confirm(msg)) return;

  try {
    if (useLocalStorage) {
      const ok = await LocalStore.deleteDocument(currentUser.id, docId);
      if (!ok) {
        alert("刪除失敗");
        return;
      }
    } else {
      const res = await fetch(`/api/documents/${docId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.status === 401) {
        showLoginScreen();
        return;
      }
      if (!res.ok) {
        alert("刪除失敗");
        return;
      }
    }
    calendar.refetchEvents();
    loadDocuments();
  } catch {
    alert("刪除失敗");
  }
}

async function checkHealth() {
  const badge = document.getElementById("status-badge");
  const privacyNote = document.getElementById("privacy-note");

  try {
    const res = await fetch("/api/health");
    const data = await res.json();

    useLocalStorage = data.storage_mode !== "server";

    if (privacyNote) {
      privacyNote.classList.toggle("hidden", !useLocalStorage);
    }

    if (data.redirect_uri) {
      document.getElementById("redirect-uri-display").textContent = data.redirect_uri;
      document.getElementById("oauth-setup-hint").classList.remove("hidden");
    }
    if (!data.google_oauth_set) {
      badge.textContent = "請設定 Google OAuth";
      badge.className = "status-badge warn";
    } else if (data.api_key_set) {
      badge.textContent = useLocalStorage ? "本機儲存" : "AI 已就緒";
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
    if (useLocalStorage) {
      const ok = await LocalStore.deleteEvent(currentUser.id, Number(currentEventId));
      if (!ok) {
        alert("刪除失敗");
        return;
      }
    } else {
      const res = await fetch(`/api/events/${currentEventId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.status === 401) {
        showLoginScreen();
        return;
      }
      if (!res.ok) {
        alert("刪除失敗");
        return;
      }
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
  return new Date(iso).toLocaleString("zh-HK", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}