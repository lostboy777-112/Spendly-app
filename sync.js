(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SpendlySync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SYNC_KEY = "spendly-sync-v1";

  function emptyState() {
    return { url: "", token: "", queue: [], lastSyncAt: null, lastPullAt: null, lastError: "" };
  }

  function loadState(storage) {
    try {
      const raw = storage.getItem(SYNC_KEY);
      if (!raw) return emptyState();
      const data = JSON.parse(raw);
      return {
        url: typeof data.url === "string" ? data.url : "",
        token: typeof data.token === "string" ? data.token : "",
        queue: Array.isArray(data.queue) ? data.queue : [],
        lastSyncAt: data.lastSyncAt || null,
        lastPullAt: data.lastPullAt || null,
        lastError: typeof data.lastError === "string" ? data.lastError : ""
      };
    } catch (e) {
      return emptyState();
    }
  }

  function saveState(storage, state) {
    storage.setItem(SYNC_KEY, JSON.stringify({
      url: state.url || "",
      token: state.token || "",
      queue: Array.isArray(state.queue) ? state.queue : [],
      lastSyncAt: state.lastSyncAt || null,
      lastPullAt: state.lastPullAt || null,
      lastError: state.lastError || ""
    }));
  }

  function qid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function stamp(event) {
    const copy = Object.assign({}, event);
    if (!copy.qid) copy.qid = qid();
    return copy;
  }

  function enqueue(state, events) {
    const list = Array.isArray(events) ? events : [events];
    state.queue = state.queue.concat(list.filter(Boolean).map(stamp));
    return state;
  }

  function toWire(event) {
    const copy = Object.assign({}, event);
    delete copy.qid;
    return copy;
  }

  const URL_ERROR = "送信先URLは https://script.google.com/macros/s/…/exec だけ使えます";

  function safeUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:") return "";
      if (url.username || url.password || url.port || url.search || url.hash) return "";
      if (url.hostname !== "script.google.com") return "";
      const match = url.pathname.match(/^\/macros\/s\/([A-Za-z0-9_-]+)\/exec$/);
      if (!match) return "";
      return "https://script.google.com/macros/s/" + match[1] + "/exec";
    } catch (e) {
      return "";
    }
  }

  function configured(state) {
    return Boolean(safeUrl(state.url) && String(state.token || "").trim());
  }

  // 記録の種別はイベントの type と衝突しないよう kind で送る
  function recordUpsert(record, updatedAt) {
    const date = record && record.date ? String(record.date) : "";
    return {
      type: "record_upsert",
      id: record.id,
      date: date,
      month: date.slice(0, 7),
      kind: record && record.type === "in" ? "in" : "out",
      category: record && record.category ? String(record.category) : "その他",
      amount: Math.round(Number(record && record.amount) || 0),
      title: record && record.title ? String(record.title) : "",
      memo: record && record.memo ? String(record.memo) : "",
      origin: record && record.origin === "veda" ? "veda" : "local",
      updatedAt: updatedAt
    };
  }

  function recordDelete(id, updatedAt) {
    return { type: "record_delete", id: id, updatedAt: updatedAt };
  }

  function pingEvent() {
    return { type: "ping" };
  }

  function snapshotEvents(records, updatedAt) {
    return (records || []).map(function (r) { return recordUpsert(r, updatedAt); });
  }

  function errorText(data) {
    if (data && data.error === "unauthorized") return "合言葉が一致しません";
    const msg = data && data.error ? String(data.error) : "送信に失敗しました";
    return msg.slice(0, 80);
  }

  function formatWhen_(value) {
    if (!value) return "まだありません";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(date);
  }

  function statusLine(state) {
    const err = state.lastError ? state.lastError : "なし";
    return "最終送信: " + formatWhen_(state.lastSyncAt)
      + " / 最終取得: " + formatWhen_(state.lastPullAt)
      + " / 保留 " + state.queue.length + "件 / エラー: " + err;
  }

  const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

  function validRecordId(id) {
    return typeof id === "string" && RECORD_ID.test(id);
  }

  function makeId(used) {
    let id = "";
    do {
      id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    } while (used.has(id) || !validRecordId(id));
    used.add(id);
    return id;
  }

  function validCalendarDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(5, 7));
    const d = Number(value.slice(8, 10));
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function sanitizeRecord(raw, used) {
    if (!raw || typeof raw !== "object") return null;
    if (!validCalendarDate(raw.date)) return null;
    const amountNum = Number(raw.amount);
    if (!Number.isFinite(amountNum) || Math.round(amountNum) <= 0) return null;
    let id;
    const rawId = typeof raw.id === "string" ? raw.id : "";
    if (validRecordId(rawId) && !used.has(rawId)) { id = rawId; used.add(id); }
    else { id = makeId(used); }
    let title = typeof raw.title === "string" ? raw.title : "";
    if (title.length > 200) title = title.slice(0, 200);
    if (!title) return null;
    let memo = typeof raw.memo === "string" ? raw.memo : (raw.memo == null ? "" : String(raw.memo));
    if (memo.length > 200) memo = memo.slice(0, 200);
    let category = typeof raw.category === "string" && raw.category ? raw.category : "その他";
    if (category.length > 200) category = category.slice(0, 200);
    const updated = typeof raw.updatedAt === "string" ? raw.updatedAt
      : (typeof raw.updated_at === "string" ? raw.updated_at : "");
    return {
      id: id,
      date: raw.date,
      type: raw.type === "in" ? "in" : "out",
      category: category,
      amount: Math.round(amountNum),
      title: title,
      memo: memo,
      origin: raw.origin === "veda" ? "veda" : "local",
      updatedAt: updated || new Date().toISOString(),
      deleted: !!raw.deleted
    };
  }

  function sanitizeImport(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
    if (!list) throw new Error("形式が違います");
    const used = new Set();
    const records = [];
    list.forEach(function (raw) {
      const rec = sanitizeRecord(raw, used);
      if (rec && !rec.deleted) records.push(rec);
    });
    return records;
  }

  function postEvents(fetchImpl, url, token, events) {
    return fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: token, events: events.map(toWire) })
    }).then(function (res) { return res.json(); });
  }

  function pullRecords(fetchImpl, url, token) {
    const u = url + "?token=" + encodeURIComponent(token);
    return fetchImpl(u).then(function (res) { return res.json(); }).then(function (data) {
      if (!data || data.ok !== true) {
        const err = new Error(errorText(data));
        err.data = data;
        throw err;
      }
      const used = new Set();
      const records = [];
      (Array.isArray(data.records) ? data.records : []).forEach(function (raw) {
        const rec = sanitizeRecord({
          id: raw.id, date: raw.date, type: raw.type, category: raw.category,
          amount: raw.amount, title: raw.title, memo: raw.memo, origin: raw.origin,
          updatedAt: raw.updatedAt
        }, used);
        if (rec) { rec.deleted = !!raw.deleted; records.push(rec); }
      });
      return records;
    });
  }

  let running = false;
  let rerun = false;
  let chain = Promise.resolve();

  function flushOnce(storage, fetchImpl) {
    const state = loadState(storage);
    if (!state.queue.length) return Promise.resolve(state);
    const token = String(state.token || "").trim();
    const url = safeUrl(state.url);
    if (!token || !url) {
      if (state.url.trim() && !url) {
        state.lastError = URL_ERROR;
        saveState(storage, state);
      }
      return Promise.resolve(state);
    }
    const batch = state.queue.slice(0, 500);
    return postEvents(fetchImpl, url, token, batch).then(function (data) {
      const current = loadState(storage);
      if (data && data.ok === true) {
        const sent = new Set(batch.map(function (ev) { return ev.qid; }));
        current.queue = current.queue.filter(function (ev) { return !sent.has(ev.qid); });
        current.lastSyncAt = new Date().toISOString();
        current.lastError = "";
        saveState(storage, current);
        return current;
      }
      current.lastError = errorText(data);
      saveState(storage, current);
      return current;
    }).catch(function () {
      const current = loadState(storage);
      current.lastError = "送信できませんでした";
      saveState(storage, current);
      return current;
    });
  }

  function flush(storage, fetchImpl) {
    if (running) {
      rerun = true;
      return chain;
    }
    running = true;
    chain = (async function () {
      try {
        do {
          rerun = false;
          const before = loadState(storage).queue.length;
          await flushOnce(storage, fetchImpl);
          const afterState = loadState(storage);
          if (!rerun && afterState.queue.length > 0 && afterState.queue.length < before && !afterState.lastError) {
            rerun = true;
          }
        } while (rerun);
      } finally {
        running = false;
      }
      return loadState(storage);
    })();
    return chain;
  }

  return {
    SYNC_KEY: SYNC_KEY,
    loadState: loadState,
    saveState: saveState,
    enqueue: enqueue,
    URL_ERROR: URL_ERROR,
    configured: configured,
    safeUrl: safeUrl,
    sanitizeImport: sanitizeImport,
    sanitizeRecord: sanitizeRecord,
    recordUpsert: recordUpsert,
    recordDelete: recordDelete,
    pingEvent: pingEvent,
    snapshotEvents: snapshotEvents,
    errorText: errorText,
    statusLine: statusLine,
    postEvents: postEvents,
    pullRecords: pullRecords,
    validRecordId: validRecordId,
    makeId: makeId,
    flush: flush
  };
});
