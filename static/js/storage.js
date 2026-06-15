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
        for (const event of events) {
          eventStore.add({
            userId,
            documentId: docId,
            title: event.title || "未命名活動",
            description: event.description || null,
            eventDate: event.event_date,
            endDate: event.end_date || null,
            eventTime: event.event_time || null,
            location: event.location || null,
            category: event.category || "other",
            notes: event.notes || null,
            filename: file.name,
          });
        }
        tx._result = { docId, eventCount: events.length };
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
        event_count: events.filter((e) => e.documentId === doc.id).length,
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

  function eventsToCalendar(events) {
    return events.map((e) => {
      const color = EVENT_COLORS[e.category] || EVENT_COLORS.other;
      const end = e.endDate || e.eventDate;
      return {
        id: String(e.id),
        title: e.title,
        start: e.eventDate,
        end,
        allDay: !e.eventTime,
        backgroundColor: color,
        borderColor: color,
        extendedProps: {
          description: e.description,
          time: e.eventTime,
          location: e.location,
          category: e.category,
          notes: e.notes,
          filename: e.filename,
        },
      };
    });
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
        for (const event of events) {
          eventStore.delete(event.id);
        }
        docStore.delete(docId);
        tx._ok = true;
      };

      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve(tx._ok === true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => resolve(false);
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
    saveDocumentWithEvents,
    getDocuments,
    getDocument,
    getEvents,
    eventsToCalendar,
    deleteDocument,
    deleteEvent,
    openBlob,
  };
})();