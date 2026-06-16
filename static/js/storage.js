const LocalStore = (() => {
  const DB_NAME = "kindergarten-docs";
  const DB_VERSION = 1;
  let dbPromise = null;

  const EVENT_COLORS = {
    holiday: "#e74c3c",
    activity: "#3498db",
    payment: "#f39c12",
    uniform: "#9b59b6",
    meeting: "#1abc9c",
    excursion: "#27ae60",
    other: "#95a5a6",
  };

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("documents")) {
            const docs = db.createObjectStore("documents", { keyPath: "id", autoIncrement: true });
            docs.createIndex("userId", "userId", { unique: false });
          }
          if (!db.objectStoreNames.contains("events")) {
            const events = db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
            events.createIndex("userId", "userId", { unique: false });
            events.createIndex("documentId", "documentId", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  function getAll(store, indexName, value) {
    return new Promise((resolve, reject) => {
      const request = indexName
        ? store.index(indexName).getAll(value)
        : store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveDocumentOnly(userId, file, analysis) {
    const blob = await file.arrayBuffer();
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction("documents", "readwrite");
      const docStore = tx.objectStore("documents");

      const docReq = docStore.add({
        userId,
        filename: file.name,
        fileType: analysis.file_type,
        summary: analysis.summary || "",
        uploadedAt: new Date().toISOString(),
        mimeType: file.type || "application/octet-stream",
        blob,
        serverEventIds: [],
      });

      docReq.onsuccess = () => {
        tx._result = { docId: docReq.result, eventCount: 0 };
      };

      docReq.onerror = () => reject(docReq.error);
      tx.oncomplete = () => resolve(tx._result);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function setDocumentServerEventIds(docId, serverEventIds) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("documents", "readwrite");
      const docStore = tx.objectStore("documents");
      const getReq = docStore.get(docId);

      getReq.onsuccess = () => {
        const doc = getReq.result;
        if (!doc) {
          tx.abort();
          tx._ok = false;
          return;
        }
        docStore.put({ ...doc, serverEventIds });
        tx._ok = true;
      };

      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve(tx._ok === true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => resolve(false);
    });
  }

  async function clearAllEvents(userId) {
    const db = await openDb();
    const events = await getEvents(userId);
    if (!events.length) return 0;

    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readwrite");
      const eventStore = tx.objectStore("events");
      for (const event of events) {
        eventStore.delete(event.id);
      }
      tx.oncomplete = () => resolve(events.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function saveDocumentWithEvents(userId, file, analysis) {
    const blob = await file.arrayBuffer();
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(["documents", "events"], "readwrite");
      const docStore = tx.objectStore("documents");
      const eventStore = tx.objectStore("events");

      const docReq = docStore.add({
        userId,
        filename: file.name,
        fileType: analysis.file_type,
        summary: analysis.summary || "",
        uploadedAt: new Date().toISOString(),
        mimeType: file.type || "application/octet-stream",
        blob,
      });

      docReq.onsuccess = () => {
        const docId = docReq.result;
        const events = analysis.events || [];
        let eventCount = 0;
        for (const event of events) {
          const dates = normalizeStoredDates(event.event_date, event.end_date, event.event_time);
          if (!dates.eventDate) continue;

          eventStore.add({
            userId,
            documentId: docId,
            title: event.title || "未命名活動",
            description: event.description || null,
            eventDate: dates.eventDate,
            endDate: dates.endDate,
            eventTime: dates.eventTime,
            location: event.location || null,
            category: event.category || "other",
            notes: event.notes || null,
            filename: file.name,
          });
          eventCount += 1;
        }
        tx._result = { docId, eventCount };
      };

      docReq.onerror = () => reject(docReq.error);
      tx.oncomplete = () => resolve(tx._result);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getDocuments(userId) {
    const db = await openDb();
    const tx = db.transaction(["documents", "events"], "readonly");
    const docs = await getAll(tx.objectStore("documents"), "userId", userId);
    const events = await getAll(tx.objectStore("events"), "userId", userId);

    return docs
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
      .map((doc) => ({
        id: doc.id,
        filename: doc.filename,
        file_type: doc.fileType,
        summary: doc.summary,
        uploaded_at: doc.uploadedAt,
        event_count: Array.isArray(doc.serverEventIds) && doc.serverEventIds.length
          ? doc.serverEventIds.length
          : events.filter((e) => e.documentId === doc.id).length,
      }));
  }

  async function getDocument(userId, docId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction("documents", "readonly").objectStore("documents").get(docId);
      req.onsuccess = () => {
        const doc = req.result;
        resolve(!doc || doc.userId !== userId ? null : doc);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function getEvents(userId) {
    const db = await openDb();
    const tx = db.transaction("events", "readonly");
    return getAll(tx.objectStore("events"), "userId", userId);
  }

  async function getEvent(userId, eventId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction("events", "readonly").objectStore("events").get(eventId);
      req.onsuccess = () => {
        const event = req.result;
        resolve(!event || event.userId !== userId ? null : event);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function addEvent(userId, data) {
    const dates = normalizeStoredDates(data.eventDate, data.endDate, data.eventTime);
    if (!dates.eventDate) {
      throw new Error("無效的日期");
    }

    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readwrite");
      const req = tx.objectStore("events").add({
        userId,
        documentId: data.documentId ?? null,
        title: data.title || "未命名活動",
        description: data.description || null,
        eventDate: dates.eventDate,
        endDate: dates.endDate,
        eventTime: dates.eventTime,
        location: data.location || null,
        category: data.category || "other",
        notes: data.notes || null,
        filename: data.filename || "手動新增",
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function updateEvent(userId, eventId, data) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readwrite");
      const eventStore = tx.objectStore("events");

      const getReq = eventStore.get(eventId);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing || existing.userId !== userId) {
          tx.abort();
          tx._ok = false;
          return;
        }
        const dates = normalizeStoredDates(
          data.eventDate ?? existing.eventDate,
          data.endDate !== undefined ? data.endDate : existing.endDate,
          data.eventTime !== undefined ? data.eventTime : existing.eventTime,
        );
        if (!dates.eventDate) {
          tx.abort();
          tx._ok = false;
          return;
        }

        eventStore.put({
          ...existing,
          title: data.title ?? existing.title,
          description: data.description !== undefined ? data.description : existing.description,
          eventDate: dates.eventDate,
          endDate: dates.endDate,
          eventTime: dates.eventTime,
          location: data.location !== undefined ? data.location : existing.location,
          category: data.category ?? existing.category,
          notes: data.notes !== undefined ? data.notes : existing.notes,
        });
        tx._ok = true;
      };

      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve(tx._ok === true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => resolve(false);
    });
  }

  function parseDateOnly(value) {
    if (!value || value === "null") return null;
    const str = String(value).trim();
    const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }

  function parseTimeOnly(value) {
    if (!value || value === "null") return null;
    const match = String(value).trim().match(/(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return `${match[1].padStart(2, "0")}:${match[2]}`;
  }

  function addDaysSafe(dateStr, days) {
    const [year, month, day] = dateStr.split("-").map(Number);
    const dt = new Date(year, month - 1, day + days);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function addDays(dateStr, days) {
    return addDaysSafe(dateStr, days);
  }

  function normalizeStoredDates(eventDate, endDate, eventTime) {
    const parsedDate = parseDateOnly(eventDate);
    const parsedEnd = parseDateOnly(endDate);
    const parsedTime = parseTimeOnly(eventTime);
    const rawTime = eventTime && eventTime !== "null" ? String(eventTime).trim() : null;
    return {
      eventDate: parsedDate,
      endDate: parsedEnd && parsedEnd !== parsedDate ? parsedEnd : null,
      eventTime: parsedTime || rawTime || null,
    };
  }

  function eventsToCalendar(events) {
    const results = [];

    for (const e of events) {
      const eventDate = parseDateOnly(e.eventDate);
      if (!eventDate) continue;

      const endDate = parseDateOnly(e.endDate) || eventDate;
      const parsedTime = parseTimeOnly(e.eventTime);
      const displayTime = e.eventTime && e.eventTime !== "null" ? e.eventTime : null;
      const color = EVENT_COLORS[e.category] || EVENT_COLORS.other;

      let start;
      let end;
      let allDay;

      if (parsedTime) {
        start = `${eventDate}T${parsedTime}:00`;
        const [hours, minutes] = parsedTime.split(":").map(Number);
        if (hours < 23) {
          end = `${eventDate}T${String(hours + 1).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
        } else {
          end = `${addDaysSafe(eventDate, 1)}T00:00:00`;
        }
        allDay = false;
      } else {
        start = eventDate;
        end = addDaysSafe(endDate, 1);
        allDay = true;
      }

      results.push({
        id: String(e.id),
        title: e.title,
        start,
        end,
        allDay,
        backgroundColor: color,
        borderColor: color,
        extendedProps: {
          description: e.description,
          time: displayTime,
          location: e.location,
          category: e.category,
          notes: e.notes,
          filename: e.filename,
        },
      });
    }

    return results;
  }

  async function deleteDocument(userId, docId) {
    const db = await openDb();

    const events = await new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readonly");
      const req = tx.objectStore("events").index("documentId").getAll(docId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    return new Promise((resolve, reject) => {
      const tx = db.transaction(["documents", "events"], "readwrite");
      const docStore = tx.objectStore("documents");
      const eventStore = tx.objectStore("events");

      const getReq = docStore.get(docId);
      getReq.onsuccess = () => {
        const doc = getReq.result;
        if (!doc || doc.userId !== userId) {
          tx.abort();
          tx._ok = false;
          return;
        }
        tx._serverEventIds = doc.serverEventIds || [];
        for (const event of events) {
          eventStore.delete(event.id);
        }
        docStore.delete(docId);
        tx._ok = true;
      };

      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve({ ok: tx._ok === true, serverEventIds: tx._serverEventIds || [] });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => resolve({ ok: false, serverEventIds: [] });
    });
  }

  async function deleteEvent(userId, eventId) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction("events", "readwrite");
      const eventStore = tx.objectStore("events");

      const getReq = eventStore.get(eventId);
      getReq.onsuccess = () => {
        const event = getReq.result;
        if (!event || event.userId !== userId) {
          tx.abort();
          tx._ok = false;
          return;
        }
        eventStore.delete(eventId);
        tx._ok = true;
      };

      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve(tx._ok === true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => resolve(false);
    });
  }

  function openBlob(doc, download = false) {
    const blob = new Blob([doc.blob], { type: doc.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    if (download) {
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  return {
    saveDocumentOnly,
    setDocumentServerEventIds,
    clearAllEvents,
    saveDocumentWithEvents,
    getDocuments,
    getDocument,
    getEvents,
    getEvent,
    addEvent,
    updateEvent,
    eventsToCalendar,
    deleteDocument,
    deleteEvent,
    openBlob,
    addDays,
    addDaysSafe,
    parseDateOnly,
    parseTimeOnly,
  };
})();