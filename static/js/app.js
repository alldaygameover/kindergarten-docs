const CATEGORY_LABELS = {
  holiday: "假期",
  activity: "活動",
  payment: "繳費",
  uniform: "校服",
  meeting: "會議",
  excursion: "外出",
  other: "其他",
};

const CATEGORY_COLORS = {
  holiday: "#e74c3c",
  activity: "#3498db",
  payment: "#f39c12",
  uniform: "#9b59b6",
  meeting: "#1abc9c",
  excursion: "#27ae60",
  other: "#95a5a6",
};

const FILE_TYPE_ICONS = {
  pdf: "📕",
  doc: "📘",
  image: "🖼️",
};

const FETCH_OPTS = { credentials: "include" };

let calendar = null;
let currentEventId = null;
let modalMode = "view";
let currentUser = null;
let storageMode = "google_drive";
let eventsStorage = "google_drive";
let useLocalFiles = true;
let useServerEvents = true;
let reviewSession = null;
let reviewEditMode = false;
let reviewSaving = false;
let uploadQueue = null;

document.addEventListener("DOMContentLoaded", async () => {
  initModal();
  initTabs();
  initLegendToggle();
  await checkHealth();
  const user = await checkAuth();
  if (!user) return;

  try {
    await migrateLocalEventsToServer();
  } catch {
    // Migration can retry on next login
  }

  initCalendar();
  initUpload();
  initAddEvent();
  loadDocuments();
  loadEventsList();
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
      if (tab === "events") {
        loadEventsList();
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
  if (tab === "events") {
    loadEventsList();
  }
}

function refreshEventsUI() {
  if (calendar) calendar.refetchEvents();
  loadEventsList();
}

async function fetchRawEvents() {
  if (!useServerEvents) {
    const events = await LocalStore.getEvents(currentUser.id);
    return events.map(normalizeLocalEvent);
  }

  const res = await fetch("/api/events/list", FETCH_OPTS);
  if (res.status === 401) {
    showLoginScreen();
    return [];
  }
  const events = await res.json();
  return events.map(normalizeServerEvent);
}

function normalizeServerEvent(event) {
  const eventDate = LocalStore.parseDateOnly(event.event_date);
  const endDate = LocalStore.parseDateOnly(event.end_date);
  const parsedTime = LocalStore.parseTimeOnly(event.event_time);
  const rawTime = event.event_time && event.event_time !== "null" ? String(event.event_time).trim() : null;

  return {
    id: event.id,
    title: event.title,
    eventDate,
    endDate: endDate && endDate !== eventDate ? endDate : null,
    eventTime: parsedTime || rawTime || null,
    category: event.category || "other",
    location: event.location || null,
    description: event.description || null,
    notes: event.notes || null,
    filename: event.filename || null,
  };
}

async function postEventsBulk(events, sourceFilename) {
  const res = await fetch("/api/events/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_filename: sourceFilename, events }),
    credentials: "include",
  });
  if (res.status === 401) {
    showLoginScreen();
    return null;
  }
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "活動同步失敗");
  }
  return res.json();
}

async function deleteServerEventsBulk(ids) {
  if (!ids.length) return;
  const res = await fetch("/api/events/bulk", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
    credentials: "include",
  });
  if (res.status === 401) {
    showLoginScreen();
    return;
  }
  if (!res.ok) {
    throw new Error("刪除活動失敗");
  }
}

async function migrateLocalEventsToServer() {
  if (!useServerEvents || !currentUser) return;
  if (localStorage.getItem("eventsMigratedToDrive") === "true") return;

  const events = await LocalStore.getEvents(currentUser.id);
  if (!events.length) {
    localStorage.setItem("eventsMigratedToDrive", "true");
    return;
  }

  const payload = events
    .map((event) => {
      const normalized = normalizeLocalEvent(event);
      if (!normalized.eventDate) return null;
      return {
        title: normalized.title,
        event_date: normalized.eventDate,
        end_date: normalized.endDate,
        event_time: normalized.eventTime,
        location: normalized.location,
        description: normalized.description,
        category: normalized.category,
        notes: normalized.notes,
        source_filename: normalized.filename || "手動新增",
      };
    })
    .filter(Boolean);

  if (payload.length) {
    await postEventsBulk(payload, "手機匯入");
  }

  localStorage.setItem("eventsMigratedToDrive", "true");
}

function normalizeLocalEvent(event) {
  const eventDate = LocalStore.parseDateOnly(event.eventDate);
  const endDate = LocalStore.parseDateOnly(event.endDate);
  const parsedTime = LocalStore.parseTimeOnly(event.eventTime);
  const rawTime = event.eventTime && event.eventTime !== "null" ? String(event.eventTime).trim() : null;

  return {
    id: event.id,
    title: event.title,
    eventDate,
    endDate: endDate && endDate !== eventDate ? endDate : null,
    eventTime: parsedTime || rawTime || null,
    category: event.category || "other",
    location: event.location || null,
    description: event.description || null,
    notes: event.notes || null,
    filename: event.filename || null,
  };
}

function calendarEventToRaw(fc) {
  const props = fc.extendedProps || {};
  const start = toDateString(fc.start);
  let endDate = null;

  if (fc.end) {
    const endStr = toDateString(fc.end);
    endDate = fc.allDay ? subtractDays(endStr, 1) : endStr;
    if (endDate === start) endDate = null;
  }

  return {
    id: fc.id,
    title: fc.title,
    eventDate: start,
    endDate,
    eventTime: props.time || null,
    category: props.category || "other",
    location: props.location || null,
    description: props.description || null,
    notes: props.notes || null,
    filename: props.filename || null,
  };
}

function toDateString(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function subtractDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function getEventLastDay(event) {
  const eventDate = event.eventDate || event.event_date;
  if (!eventDate || eventDate === "null") return null;
  const endDate = event.endDate || event.end_date;
  if (endDate && endDate !== "null") return endDate;
  return eventDate;
}

function splitEventsByStatus(events) {
  const today = new Date().toISOString().slice(0, 10);
  const valid = events.filter((e) => getEventLastDay(e));

  const upcoming = valid
    .filter((e) => getEventLastDay(e) >= today)
    .sort((a, b) => (a.eventDate || a.event_date).localeCompare(b.eventDate || b.event_date));

  const past = valid
    .filter((e) => getEventLastDay(e) < today)
    .sort((a, b) => (b.eventDate || b.event_date).localeCompare(a.eventDate || a.event_date));

  return { upcoming, past };
}

function formatListDate(event) {
  const eventDate = event.eventDate || event.event_date;
  const endDate = event.endDate || event.end_date;
  const eventTime = event.eventTime || event.event_time;
  const opts = { month: "short", day: "numeric", year: "numeric" };
  const startLabel = new Date(`${eventDate}T12:00:00`).toLocaleDateString("zh-HK", opts);

  if (endDate && endDate !== eventDate) {
    const endLabel = new Date(`${endDate}T12:00:00`).toLocaleDateString("zh-HK", opts);
    return `${startLabel} — ${endLabel}`;
  }
  if (eventTime) return `${startLabel} ${eventTime}`;
  return startLabel;
}

function renderEventCard(event, past = false) {
  const category = event.category || "other";
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
  const label = CATEGORY_LABELS[category] || category;
  const meta = [
    event.location ? `📍 ${event.location}` : "",
    event.filename ? `📄 ${event.filename}` : "",
  ].filter(Boolean);

  return `
    <button type="button" class="event-card${past ? " past" : ""}" data-id="${event.id}">
      <span class="event-card-badge" style="background:${color}">${label}</span>
      <div class="event-card-body">
        <div class="event-card-title">${escapeHtml(event.title)}</div>
        <div class="event-card-date">${escapeHtml(formatListDate(event))}</div>
        ${meta.length ? `<div class="event-card-meta">${meta.map((m) => escapeHtml(m)).join("")}</div>` : ""}
      </div>
    </button>
  `;
}

function renderEventsSublist(events, past = false) {
  if (!events.length) {
    return `<p class="empty-state">${past ? "暫無已結束的活動" : "暫無即將舉行的活動"}</p>`;
  }
  return events.map((e) => renderEventCard(e, past)).join("");
}

async function loadEventsList() {
  const upcomingList = document.getElementById("upcoming-list");
  const pastList = document.getElementById("past-list");
  const countEl = document.getElementById("events-count");
  const upcomingCount = document.getElementById("upcoming-count");
  const pastCount = document.getElementById("past-count");

  if (!upcomingList || !pastList) return;

  try {
    const events = await fetchRawEvents();
    const { upcoming, past } = splitEventsByStatus(events);

    countEl.textContent = `${events.length} 個`;
    upcomingCount.textContent = upcoming.length ? `(${upcoming.length})` : "";
    pastCount.textContent = past.length ? `(${past.length})` : "";

    upcomingList.innerHTML = renderEventsSublist(upcoming, false);
    pastList.innerHTML = renderEventsSublist(past, true);

    upcomingList.querySelectorAll(".event-card").forEach((card) => {
      card.addEventListener("click", () => openEventFromList(card.dataset.id));
    });
    pastList.querySelectorAll(".event-card").forEach((card) => {
      card.addEventListener("click", () => openEventFromList(card.dataset.id));
    });
  } catch {
    upcomingList.innerHTML = '<p class="empty-state">無法載入活動列表</p>';
    pastList.innerHTML = "";
    countEl.textContent = "0 個";
  }
}

async function openEventFromList(eventId) {
  const data = await loadEventData(eventId);
  if (!data) {
    alert("找不到活動");
    return;
  }
  currentEventId = String(data.id);
  setModalView("view");
  document.getElementById("modal-title").textContent = data.title || "未命名活動";
  document.getElementById("modal-body").innerHTML = renderEventViewFields(data);
  document.getElementById("event-modal").classList.remove("hidden");
}

function renderEventViewFields(data) {
  const fields = [
    ["類別", CATEGORY_LABELS[data.category] || data.category],
    ["日期", formatRawEventDate(data)],
    ["時間", data.eventTime || data.event_time],
    ["地點", data.location],
    ["說明", data.description],
    ["注意事項", data.notes],
    ["來源文件", data.filename],
  ];

  return fields
    .filter(([, v]) => v)
    .map(([label, value]) => `
      <div class="field">
        <div class="label">${label}</div>
        <div>${escapeHtml(String(value))}</div>
      </div>
    `).join("");
}

function formatRawEventDate(data) {
  const eventDate = data.eventDate || data.event_date;
  const endDate = data.endDate || data.end_date || eventDate;
  const eventTime = data.eventTime || data.event_time;
  const start = new Date(`${eventDate}T12:00:00`);

  if (!eventTime) {
    const end = new Date(`${endDate}T12:00:00`);
    end.setDate(end.getDate() + 1);
    return formatEventDate(start, end, true);
  }

  const startTimed = new Date(`${eventDate}T${eventTime}`);
  return startTimed.toLocaleDateString("zh-HK") + " " + startTimed.toLocaleTimeString("zh-HK", {
    hour: "2-digit",
    minute: "2-digit",
  });
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
  if (!useServerEvents) {
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
    initialView: "dayGridMonth",
    locale: "zh-tw",
    headerToolbar: mobile
      ? { left: "prev,next", center: "title", right: "today" }
      : { left: "prev,next today", center: "title", right: "dayGridMonth,listYear" },
    height: "auto",
    dayMaxEvents: mobile ? 5 : true,
    moreLinkClick: mobile ? "popover" : "week",
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
    dateClick(info) {
      showEventForm("create", { eventDate: info.dateStr });
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

function initAddEvent() {
  const btn = document.getElementById("add-event-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const today = new Date().toISOString().slice(0, 10);
    showEventForm("create", { eventDate: today });
  });
}

function initUpload() {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const selectBtn = document.getElementById("select-btn");

  selectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!reviewSession) fileInput.click();
  });

  dropZone.addEventListener("click", () => {
    if (!reviewSession) fileInput.click();
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!reviewSession) dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (!reviewSession) uploadFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener("change", () => {
    if (!reviewSession) uploadFiles(fileInput.files);
    fileInput.value = "";
  });

  document.getElementById("review-edit-btn")?.addEventListener("click", toggleReviewEdit);
  document.getElementById("review-confirm-btn")?.addEventListener("click", confirmReviewEvent);
  document.getElementById("review-skip-btn")?.addEventListener("click", skipReviewEvent);
  document.getElementById("review-cancel-btn")?.addEventListener("click", cancelReviewSession);
}

async function uploadFiles(files) {
  if (!files.length || reviewSession) return;

  const progress = document.getElementById("upload-progress");
  const results = document.getElementById("upload-results");
  progress.classList.remove("hidden");
  results.innerHTML = "";

  try {
    uploadQueue = { files: Array.from(files), resultsEl: results, index: 0, anyConfirmed: false };
    await processNextUploadFile();
  } catch (err) {
    results.innerHTML = `<div class="result-item error">上傳失敗: ${escapeHtml(err.message)}</div>`;
    document.getElementById("upload-progress").classList.add("hidden");
  }
}

async function processNextUploadFile() {
  if (!uploadQueue) return;

  const progress = document.getElementById("upload-progress");
  if (uploadQueue.index >= uploadQueue.files.length) {
    progress.classList.add("hidden");
    if (uploadQueue.anyConfirmed && isMobile()) {
      switchTab("calendar");
    }
    uploadQueue = null;
    return;
  }

  const file = uploadQueue.files[uploadQueue.index];
  uploadQueue.index += 1;
  progress.classList.remove("hidden");

  try {
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch("/api/analyze", {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const data = await res.json();

    if (res.status === 401) {
      showLoginScreen();
      progress.classList.add("hidden");
      uploadQueue = null;
      return;
    }
    if (!res.ok) {
      uploadQueue.resultsEl.innerHTML += `<div class="result-item error">✗ ${escapeHtml(file.name)} — ${escapeHtml(data.detail || "分析失敗")}</div>`;
      await processNextUploadFile();
      return;
    }

    progress.classList.add("hidden");
    const events = normalizeAnalysisEvents(data.events);
    if (!events.length) {
      uploadQueue.resultsEl.innerHTML += `<div class="result-item info">✓ ${escapeHtml(file.name)} — 未找到活動，文件未儲存。${escapeHtml(data.summary || "")}</div>`;
      await processNextUploadFile();
      return;
    }

    startReviewSession(file, data, events);
  } catch (err) {
    uploadQueue.resultsEl.innerHTML += `<div class="result-item error">✗ ${escapeHtml(file.name)} — ${escapeHtml(err.message)}</div>`;
    await processNextUploadFile();
  }
}

function normalizeAnalysisEvents(events) {
  return (events || [])
    .map((event) => ({
      title: event.title || "",
      category: event.category || "other",
      eventDate: event.event_date,
      endDate: event.end_date && event.end_date !== "null" ? event.end_date : null,
      eventTime: event.event_time && event.event_time !== "null" ? event.event_time : null,
      location: event.location && event.location !== "null" ? event.location : null,
      description: event.description && event.description !== "null" ? event.description : null,
      notes: event.notes && event.notes !== "null" ? event.notes : null,
    }))
    .filter((event) => event.title && event.eventDate);
}

function startReviewSession(file, analysis, events) {
  reviewSession = {
    file,
    analysis,
    events,
    index: 0,
    docId: null,
    confirmedIds: [],
    confirmedCount: 0,
    skippedCount: 0,
    firstConfirmedDate: null,
  };
  reviewEditMode = false;
  switchTab("upload");
  showReviewPanel();
  renderReviewEvent();
}

function showReviewPanel() {
  const section = document.querySelector(".upload-section");
  const panel = document.getElementById("review-panel");
  section?.classList.add("review-active");
  panel?.classList.remove("hidden");

  document.getElementById("review-filename").textContent = reviewSession.file.name;
  const summary = reviewSession.analysis.summary || "";
  const total = reviewSession.events.length;
  document.getElementById("review-summary").textContent = summary
    ? `${summary}（請審核每個活動，共 ${total} 個）`
    : `請審核每個活動，共 ${total} 個`;
  updateReviewCancelVisibility();
  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideReviewPanel() {
  const section = document.querySelector(".upload-section");
  const panel = document.getElementById("review-panel");
  section?.classList.remove("review-active");
  panel?.classList.add("hidden");
  reviewEditMode = false;
}

function updateReviewCancelVisibility() {
  const btn = document.getElementById("review-cancel-btn");
  if (!btn || !reviewSession) return;
  btn.classList.toggle("hidden", reviewSession.confirmedCount > 0);
}

function setReviewButtonsDisabled(disabled) {
  ["review-edit-btn", "review-confirm-btn", "review-skip-btn", "review-cancel-btn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  });
}

function setReviewEditMode(editing) {
  reviewEditMode = editing;
  document.getElementById("review-view").classList.toggle("hidden", editing);
  document.getElementById("review-form").classList.toggle("hidden", !editing);
  document.getElementById("review-edit-btn").textContent = editing ? "完成編輯" : "編輯";
}

function renderReviewEvent() {
  const event = reviewSession.events[reviewSession.index];
  const total = reviewSession.events.length;
  const current = reviewSession.index + 1;

  document.getElementById("review-progress").textContent = `活動 ${current} / ${total}`;

  const category = event.category || "other";
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
  const label = CATEGORY_LABELS[category] || category;

  document.getElementById("review-event-title").innerHTML = `
    <h4>${escapeHtml(event.title)}</h4>
    <span class="review-event-badge" style="background:${color}">${escapeHtml(label)}</span>
  `;
  document.getElementById("review-event-body").innerHTML = renderEventViewFields({
    category: event.category,
    eventDate: event.eventDate,
    endDate: event.endDate,
    eventTime: event.eventTime,
    location: event.location,
    description: event.description,
    notes: event.notes,
  });

  fillEventForm("review", event);
  setReviewEditMode(false);
}

function toggleReviewEdit() {
  if (!reviewSession || reviewSaving) return;
  if (reviewEditMode) {
    const data = readEventFormFrom("review");
    if (!data) return;
    reviewSession.events[reviewSession.index] = { ...reviewSession.events[reviewSession.index], ...data };
    renderReviewEvent();
  } else {
    fillEventForm("review", reviewSession.events[reviewSession.index]);
    setReviewEditMode(true);
  }
}

function getCurrentReviewEventData() {
  if (reviewEditMode) {
    return readEventFormFrom("review");
  }
  return { ...reviewSession.events[reviewSession.index] };
}

async function confirmReviewEvent() {
  if (!reviewSession || reviewSaving) return;

  const session = reviewSession;
  const data = getCurrentReviewEventData();
  if (!data) return;

  session.events[session.index] = { ...session.events[session.index], ...data };

  reviewSaving = true;
  setReviewButtonsDisabled(true);
  try {
    await saveConfirmedReviewEvent(session, data);
    if (!reviewSession || reviewSession !== session) return;
    session.confirmedCount += 1;
    if (!session.firstConfirmedDate) {
      session.firstConfirmedDate = data.eventDate;
    }
    updateReviewCancelVisibility();
    advanceReviewEvent();
  } catch (err) {
    alert(err.message || "儲存失敗");
  } finally {
    reviewSaving = false;
    if (reviewSession) setReviewButtonsDisabled(false);
  }
}

function skipReviewEvent() {
  if (!reviewSession || reviewSaving) return;
  reviewSession.skippedCount += 1;
  advanceReviewEvent();
}

function advanceReviewEvent() {
  if (!reviewSession) return;
  reviewSession.index += 1;
  if (reviewSession.index >= reviewSession.events.length) {
    finishReviewSession();
  } else {
    renderReviewEvent();
  }
}

async function saveDocumentToServer(file, analysis) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("summary", analysis.summary || "");
  formData.append("file_type", analysis.file_type || "");

  const res = await fetch("/api/documents", {
    method: "POST",
    body: formData,
    credentials: "include",
  });

  if (res.status === 401) {
    showLoginScreen();
    throw new Error("請重新登入");
  }
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "文件儲存失敗");
  }

  const data = await res.json();
  return data.id;
}

async function saveConfirmedReviewEvent(session, eventData) {
  if (!session) return;

  if (session.docId === null) {
    if (useLocalFiles) {
      const { docId } = await LocalStore.saveDocumentOnly(
        currentUser.id,
        session.file,
        session.analysis,
      );
      session.docId = docId;
    } else {
      session.docId = await saveDocumentToServer(session.file, session.analysis);
    }
  }

  if (!useServerEvents) {
    await LocalStore.addEvent(currentUser.id, {
      ...eventData,
      documentId: session.docId,
      filename: session.file.name,
    });
    return;
  }

  const payload = {
    ...toServerPayload(eventData),
    source_filename: session.file.name,
  };
  if (!useLocalFiles && session.docId) {
    payload.document_id = session.docId;
  }

  const res = await fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "include",
  });

  if (res.status === 401) {
    showLoginScreen();
    throw new Error("請重新登入");
  }
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "活動同步失敗");
  }

  const { id } = await res.json();
  if (useLocalFiles) {
    session.confirmedIds.push(id);
    await LocalStore.setDocumentServerEventIds(session.docId, session.confirmedIds);
    try {
      await LocalStore.addEvent(currentUser.id, {
        ...eventData,
        documentId: session.docId,
        filename: session.file.name,
      });
    } catch {
      // Local backup is optional
    }
  }
}

async function finishReviewSession() {
  const session = reviewSession;
  if (!session) return;

  const resultsEl = uploadQueue?.resultsEl;
  const filename = session.file.name;
  const { confirmedCount, skippedCount, firstConfirmedDate } = session;

  hideReviewPanel();
  reviewSession = null;
  reviewSaving = false;

  if (confirmedCount > 0) {
    const storageNote = eventsStorage === "google_drive"
      ? "文件已儲存至此手機，活動已存入 Google 帳戶。"
      : useLocalFiles
        ? (useServerEvents ? "文件已儲存至此手機，活動已同步。" : "已儲存至此手機。")
        : "文件及活動已儲存。";
    resultsEl.innerHTML += `<div class="result-item success">✓ ${escapeHtml(filename)} — 已加入 ${confirmedCount} 個活動${skippedCount ? `，略過 ${skippedCount} 個` : ""}。${storageNote}</div>`;
    refreshEventsUI();
    loadDocuments();
    if (uploadQueue) uploadQueue.anyConfirmed = true;
    if (firstConfirmedDate && calendar) {
      calendar.gotoDate(firstConfirmedDate);
    }
  } else {
    resultsEl.innerHTML += `<div class="result-item info">✓ ${escapeHtml(filename)} — 已略過全部 ${skippedCount} 個活動，文件未儲存。</div>`;
  }

  await processNextUploadFile();
}

function cancelReviewSession() {
  if (!reviewSession || reviewSession.confirmedCount > 0) return;
  if (!confirm("確定要取消審核？文件和活動都不會儲存。")) return;

  const filename = reviewSession.file.name;
  const resultsEl = uploadQueue?.resultsEl;
  hideReviewPanel();
  reviewSession = null;
  resultsEl.innerHTML += `<div class="result-item info">✓ ${escapeHtml(filename)} — 已取消審核，文件未儲存。</div>`;
  processNextUploadFile();
}

async function loadDocuments() {
  const list = document.getElementById("docs-list");
  const countEl = document.getElementById("docs-count");

  try {
    const docs = useLocalFiles
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
            ${useLocalFiles ? "<span>📱 此手機</span>" : ""}
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
  if (useLocalFiles) {
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
  if (useLocalFiles) {
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
    if (useLocalFiles) {
      const result = await LocalStore.deleteDocument(currentUser.id, docId);
      if (!result.ok) {
        alert("刪除失敗");
        return;
      }
      if (useServerEvents && result.serverEventIds?.length) {
        await deleteServerEventsBulk(result.serverEventIds);
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
    refreshEventsUI();
    loadDocuments();
  } catch {
    alert("刪除失敗");
  }
}

async function checkHealth() {
  const badge = document.getElementById("status-badge");

  try {
    const res = await fetch("/api/health");
    const data = await res.json();

    storageMode = data.storage_mode || "google_drive";
    eventsStorage = data.events_storage || storageMode;
    useLocalFiles = data.files_storage ? data.files_storage === "local" : storageMode !== "server";
    useServerEvents = data.events_storage
      ? data.events_storage === "server" || data.events_storage === "google_drive"
      : storageMode !== "local";

    if (!data.google_oauth_set) {
      badge.textContent = "請設定 Google OAuth";
      badge.className = "status-badge warn";
    } else if (data.api_key_set) {
      if (data.events_storage === "google_drive") {
        badge.textContent = "Google 帳戶";
      } else if (storageMode === "hybrid") {
        badge.textContent = "活動同步";
      } else if (useLocalFiles) {
        badge.textContent = "本機儲存";
      } else {
        badge.textContent = "AI 已就緒";
      }
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
  document.getElementById("modal-edit").addEventListener("click", () => {
    if (currentEventId) showEventForm("edit", { eventId: currentEventId });
  });
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  document.getElementById("modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveEventForm();
  });
}

function setModalView(mode) {
  modalMode = mode;
  const isForm = mode === "create" || mode === "edit";
  document.getElementById("modal-view").classList.toggle("hidden", isForm);
  document.getElementById("modal-form").classList.toggle("hidden", !isForm);
}

async function showEventModal(event) {
  currentEventId = event.id;
  setModalView("view");
  const props = event.extendedProps;

  document.getElementById("modal-title").textContent = event.title;
  document.getElementById("modal-body").innerHTML = renderEventViewFields({
    category: props.category,
    eventDate: toDateString(event.start),
    endDate: event.allDay && event.end ? subtractDays(toDateString(event.end), 1) : toDateString(event.end),
    eventTime: props.time,
    location: props.location,
    description: props.description,
    notes: props.notes,
    filename: props.filename,
  });

  document.getElementById("event-modal").classList.remove("hidden");
}

async function showEventForm(mode, opts = {}) {
  setModalView(mode);
  currentEventId = mode === "edit" ? opts.eventId : null;
  document.getElementById("modal-title").textContent = mode === "create" ? "新增活動" : "編輯活動";

  const form = document.getElementById("modal-form");
  form.reset();

  if (mode === "create") {
    fillEventForm("form", { eventDate: opts.eventDate || "", category: "activity" });
  } else {
    const data = await loadEventData(opts.eventId);
    if (!data) {
      alert("找不到活動");
      closeModal();
      return;
    }
    fillEventForm("form", data);
  }

  document.getElementById("event-modal").classList.remove("hidden");
}

async function loadEventData(eventId) {
  if (!useServerEvents) {
    return LocalStore.getEvent(currentUser.id, Number(eventId));
  }
  const res = await fetch(`/api/events/${eventId}`, FETCH_OPTS);
  if (res.status === 401) {
    showLoginScreen();
    return null;
  }
  if (!res.ok) return null;
  return res.json();
}

function fillEventForm(prefix, data) {
  const timeValue = data.eventTime || data.event_time || "";
  const parsedTime = LocalStore.parseTimeOnly(timeValue) || timeValue;

  document.getElementById(`${prefix}-title`).value = data.title || "";
  document.getElementById(`${prefix}-category`).value = data.category || "other";
  document.getElementById(`${prefix}-date`).value = data.eventDate || data.event_date || "";
  document.getElementById(`${prefix}-end-date`).value = data.endDate || data.end_date || "";
  document.getElementById(`${prefix}-time`).value = parsedTime;
  document.getElementById(`${prefix}-location`).value = data.location || "";
  document.getElementById(`${prefix}-description`).value = data.description || "";
  document.getElementById(`${prefix}-notes`).value = data.notes || "";
}

function readEventFormFrom(prefix) {
  const title = document.getElementById(`${prefix}-title`).value.trim();
  const eventDate = document.getElementById(`${prefix}-date`).value;
  const endDate = document.getElementById(`${prefix}-end-date`).value;
  const eventTime = document.getElementById(`${prefix}-time`).value;

  if (!title) {
    alert("請輸入標題");
    return null;
  }
  if (!eventDate) {
    alert("請選擇日期");
    return null;
  }
  if (endDate && endDate < eventDate) {
    alert("結束日期不能早於開始日期");
    return null;
  }

  return {
    title,
    category: document.getElementById(`${prefix}-category`).value,
    eventDate,
    endDate: endDate || null,
    eventTime: eventTime || null,
    location: document.getElementById(`${prefix}-location`).value.trim() || null,
    description: document.getElementById(`${prefix}-description`).value.trim() || null,
    notes: document.getElementById(`${prefix}-notes`).value.trim() || null,
  };
}

function readEventForm() {
  return readEventFormFrom("form");
}

function toServerPayload(data) {
  return {
    title: data.title,
    category: data.category,
    event_date: data.eventDate,
    end_date: data.endDate,
    event_time: data.eventTime,
    location: data.location,
    description: data.description,
    notes: data.notes,
  };
}

async function saveEventForm() {
  const data = readEventForm();
  if (!data) return;

  try {
    if (modalMode === "create") {
      if (!useServerEvents) {
        await LocalStore.addEvent(currentUser.id, data);
      } else {
        const res = await fetch("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toServerPayload(data)),
          credentials: "include",
        });
        if (res.status === 401) {
          showLoginScreen();
          return;
        }
        if (!res.ok) {
          const err = await res.json();
          alert(err.detail || "儲存失敗");
          return;
        }
      }
    } else if (modalMode === "edit" && currentEventId) {
      if (!useServerEvents) {
        const ok = await LocalStore.updateEvent(currentUser.id, Number(currentEventId), data);
        if (!ok) {
          alert("儲存失敗");
          return;
        }
      } else {
        const res = await fetch(`/api/events/${currentEventId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toServerPayload(data)),
          credentials: "include",
        });
        if (res.status === 401) {
          showLoginScreen();
          return;
        }
        if (!res.ok) {
          const err = await res.json();
          alert(err.detail || "儲存失敗");
          return;
        }
      }
    }

    closeModal();
    refreshEventsUI();
    if (data.eventDate) {
      calendar.gotoDate(data.eventDate);
    }
  } catch {
    alert("儲存失敗");
  }
}

function closeModal() {
  document.getElementById("event-modal").classList.add("hidden");
  currentEventId = null;
  modalMode = "view";
  setModalView("view");
}

async function deleteCurrentEvent() {
  if (!currentEventId || !confirm("確定要刪除此活動？")) return;

  try {
    if (!useServerEvents) {
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
    refreshEventsUI();
  } catch {
    alert("刪除失敗");
  }
}

function formatEventDate(start, end, allDay = true) {
  const s = start.toLocaleDateString("zh-HK");
  if (!end) return s;

  if (allDay) {
    const endInclusive = new Date(end);
    endInclusive.setDate(endInclusive.getDate() - 1);
    if (start.toDateString() === endInclusive.toDateString()) return s;
    return `${s} — ${endInclusive.toLocaleDateString("zh-HK")}`;
  }

  if (start.toDateString() === end.toDateString()) {
    return `${s} ${start.toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit" })}`;
  }
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