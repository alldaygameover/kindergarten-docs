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

  function tx(storeNames, mode = "readonly") {
    return openDb().then((db) => {
      const transaction = db.transaction(storeNames, mode);
      return { transaction, stores: storeNames.map((n) => transaction.objectStore(n)) };
    });
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getAll(store, indexName, value) {
    if (indexName) {
      return reqToPromise(store.index(indexName).getAll(value));
    }
    return reqToPromise(store.getAll());
  }

  async function saveDocumentWithEvents(userId, file, analysis) {
    const { transaction, stores } = await tx(["documents", "events"], "readwrite");
    const [docStore, eventStore] = stores;

    const docRecord = {
      userId,
      filename: file.name,
      fileType: analysis.file_type,
      summary: analysis.summary || "",
      uploadedAt: new Date().toISOString(),
      mimeType: file.type || "application/octet-stream",
      blob: await file.arrayBuffer(),
    };

    const docId = await reqToPromise(docStore.add(docRecord));
    let eventCount = 0;

    for (const event of analysis.events || []) {
      await reqToPromise(eventStore.add({
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
      }));
      eventCount += 1;
    }

    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });

    return { docId, eventCount };
  }

  async function getDocuments(userId) {
    const { stores } = await tx(["documents"]);
    const docs = await getAll(stores[0], "userId", userId);
    const { stores: eventStores } = await tx(["events"]);
    const events = await getAll(eventStores[0], "userId", userId);

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
    const { stores } = await tx(["documents"]);
    const doc = await reqToPromise(stores[0].get(docId));
    if (!doc || doc.userId !== userId) return null;
    return doc;
  }

  async function getEvents(userId) {
    const { stores } = await tx(["events"]);
    return getAll(stores[0], "userId", userId);
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
    const { transaction, stores } = await tx(["documents", "events"], "readwrite");
    const [docStore, eventStore] = stores;

    const doc = await reqToPromise(docStore.get(docId));
    if (!doc || doc.userId !== userId) return false;

    const events = await getAll(eventStore, "documentId", docId);
    for (const event of events) {
      await reqToPromise(eventStore.delete(event.id));
    }
    await reqToPromise(docStore.delete(docId));

    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    return true;
  }

  async function deleteEvent(userId, eventId) {
    const { stores } = await tx(["events"], "readwrite");
    const event = await reqToPromise(stores[0].get(eventId));
    if (!event || event.userId !== userId) return false;
    await reqToPromise(stores[0].delete(eventId));
    return true;
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