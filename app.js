(function () {
  "use strict";
  const S = window.SpendlySync;
  const DATA_KEY = "spendly-v1";
  const CATS_OUT = ["食費", "外食", "日用品", "お小遣い", "交通", "住居", "光熱費", "通信", "医療", "娯楽", "ふるさと納税", "保険", "その他"];
  const CATS_IN = ["給与", "その他収入"];
  const $ = function (id) { return document.getElementById(id); };
  const yen = function (n) { return "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP"); };
  const esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  // ===== データ（端末内キャッシュ。正本はシート） =====
  function emptyData() { return { records: [] }; }

  function loadData() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.records)) return { records: d.records };
      }
    } catch (e) { /* fallthrough */ }
    // 旧バージョン（spendly.local.v2 / v1）から移行
    for (const key of ["spendly.local.v2", "spendly.local.v1"]) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) continue;
        const used = new Set();
        const records = [];
        arr.forEach(function (it) {
          if (!it || it.deleted) return;
          const rec = S.sanitizeRecord({
            id: it.id, date: it.date, type: it.type, category: it.category,
            amount: it.amount, title: it.title, memo: it.memo, origin: it.origin,
            updatedAt: it.updated_at || it.updatedAt
          }, used);
          if (rec) records.push(rec);
        });
        const data = { records: records };
        saveData(data);
        return data;
      } catch (e) { /* 次のキーを試す */ }
    }
    return emptyData();
  }

  function saveData(data) {
    localStorage.setItem(DATA_KEY, JSON.stringify({ records: data.records }));
  }

  let data = loadData();
  let viewMonth = currentMonth();
  let editingId = null;
  let editingType = "out";

  function currentMonth() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  }
  function todayJST() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  }
  function shiftMonth(ym, delta) {
    const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + delta;
    const d = new Date(Date.UTC(y, m, 1));
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  }
  function monthRecords() {
    return data.records.filter(function (r) { return r.date && r.date.slice(0, 7) === viewMonth; });
  }

  // ===== 同期 =====
  function pendingIds() {
    if (!S) return new Set();
    const st = S.loadState(localStorage);
    const ids = new Set();
    st.queue.forEach(function (ev) {
      if ((ev.type === "record_upsert" || ev.type === "record_delete") && ev.id) ids.add(ev.id);
    });
    return ids;
  }

  function refreshSyncStatus() {
    const el = $("syncStatus");
    if (!el || !S) return;
    el.textContent = S.statusLine(S.loadState(localStorage));
  }

  function enqueueSync(events) {
    if (!events || !events.length || !S) return Promise.resolve();
    const st = S.loadState(localStorage);
    S.enqueue(st, events);
    S.saveState(localStorage, st);
    refreshSyncStatus();
    return S.flush(localStorage, window.fetch.bind(window)).then(refreshSyncStatus).catch(refreshSyncStatus);
  }

  function readSyncForm() {
    if (!S) return S ? S.loadState(localStorage) : null;
    const st = S.loadState(localStorage);
    st.url = $("syncUrl") ? $("syncUrl").value.trim() : st.url;
    st.token = $("syncToken") ? $("syncToken").value.trim() : st.token;
    S.saveState(localStorage, st);
    return st;
  }

  function fillSyncForm() {
    if (!S) return;
    const st = S.loadState(localStorage);
    if ($("syncUrl")) $("syncUrl").value = st.url || "";
    if ($("syncToken")) $("syncToken").value = st.token || "";
    refreshSyncStatus();
  }

  function pullFromSheet() {
    if (!S) return Promise.resolve(false);
    const st = readSyncForm();
    const url = S.safeUrl(st.url);
    const token = String(st.token || "").trim();
    if (!url || !token) return Promise.resolve(false);
    return S.pullRecords(window.fetch.bind(window), url, token).then(function (serverRecords) {
      const pending = pendingIds();
      const serverMap = new Map(serverRecords.map(function (r) { return [r.id, r]; }));
      const localMap = new Map(data.records.map(function (r) { return [r.id, r]; }));
      const next = [];
      serverRecords.forEach(function (sr) {
        if (pending.has(sr.id)) {
          const local = localMap.get(sr.id);
          if (local) next.push(local); // 未送信の編集を優先（削除待ちは local に無いのでそのまま消える）
          return;
        }
        if (!sr.deleted) next.push({
          id: sr.id, date: sr.date, type: sr.type, category: sr.category,
          amount: sr.amount, title: sr.title, memo: sr.memo, origin: sr.origin,
          updatedAt: sr.updatedAt
        });
      });
      data.records.forEach(function (lr) {
        if (!serverMap.has(lr.id) && pending.has(lr.id)) next.push(lr); // 未送信の新規
      });
      data.records = next;
      saveData(data);
      const cur = S.loadState(localStorage);
      cur.lastPullAt = new Date().toISOString();
      if (!cur.lastError) cur.lastError = "";
      S.saveState(localStorage, cur);
      render();
      refreshSyncStatus();
      return true;
    }).catch(function (err) {
      const cur = S.loadState(localStorage);
      cur.lastError = err && err.message ? String(err.message).slice(0, 80) : "取得できませんでした";
      S.saveState(localStorage, cur);
      refreshSyncStatus();
      return false;
    });
  }

  function syncNow() {
    if (!S) return Promise.resolve();
    return S.flush(localStorage, window.fetch.bind(window))
      .then(function () { return pullFromSheet(); })
      .then(refreshSyncStatus).catch(refreshSyncStatus);
  }

  // ===== 描画 =====
  function render() {
    const parts = viewMonth.split("-");
    $("monthLabel").textContent = Number(parts[0]) + "年" + Number(parts[1]) + "月";
    const rows = monthRecords().slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
    let sumIn = 0, sumOut = 0;
    const catTotals = new Map();
    rows.forEach(function (r) {
      if (r.type === "in") sumIn += r.amount;
      else { sumOut += r.amount; catTotals.set(r.category, (catTotals.get(r.category) || 0) + r.amount); }
    });
    $("sumIn").textContent = yen(sumIn);
    $("sumOut").textContent = yen(sumOut);
    const net = sumIn - sumOut;
    $("sumNet").textContent = (net < 0 ? "-¥" : "¥") + Math.abs(net).toLocaleString("ja-JP");

    const bars = $("catBars");
    if (!catTotals.size) {
      bars.innerHTML = '<div class="empty">この月の支出はまだありません</div>';
    } else {
      const entries = Array.from(catTotals.entries()).sort(function (a, b) { return b[1] - a[1]; });
      const max = entries[0][1] || 1;
      bars.innerHTML = entries.map(function (e) {
        const pct = Math.max(2, Math.round(e[1] / max * 100));
        return '<div class="cat-row"><div class="top"><span>' + esc(e[0]) + '</span><span class="amt">' + yen(e[1]) + '</span></div>'
          + '<div class="bar"><i style="width:' + pct + '%"></i></div></div>';
      }).join("");
    }

    const pending = pendingIds();
    const list = $("list");
    if (!rows.length) {
      list.innerHTML = '<div class="empty">この月の記録はありません</div>';
    } else {
      list.innerHTML = rows.map(function (r) {
        const badges = [];
        if (r.origin === "veda") badges.push('<span class="badge veda">ヴェーダ記録</span>');
        else badges.push('<span class="badge">自分</span>');
        if (pending.has(r.id)) badges.push('<span class="badge pending">未送信</span>');
        const sub = [r.date.slice(5).replace("-", "/"), r.category, r.memo || ""].filter(Boolean).join(" ・ ");
        return '<div class="item" data-id="' + esc(r.id) + '"><div class="main">'
          + '<div class="title">' + esc(r.title) + '</div>'
          + '<div class="sub">' + esc(sub) + '</div></div>'
          + badges.join("")
          + '<div class="amount ' + (r.type === "in" ? "in" : "out") + '">' + (r.type === "in" ? "+" : "−") + yen(r.amount) + '</div></div>';
      }).join("");
      list.querySelectorAll(".item").forEach(function (el) {
        el.addEventListener("click", function () { openEdit(el.getAttribute("data-id")); });
      });
    }
    refreshSyncStatus();
  }

  // ===== 編集ダイアログ =====
  function fillCategories() {
    const cats = editingType === "in" ? CATS_IN : CATS_OUT;
    $("fCategory").innerHTML = cats.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + "</option>";
    }).join("");
  }
  function setType(t) {
    editingType = t;
    $("segOut").classList.toggle("on", t === "out");
    $("segIn").classList.toggle("on", t === "in");
    fillCategories();
  }
  function openEdit(id) {
    editingId = id || null;
    const rec = id ? data.records.find(function (r) { return r.id === id; }) : null;
    $("dlgTitle").textContent = rec ? "記録を編集" : "記録を追加";
    setType(rec ? rec.type : "out");
    $("fDate").value = rec ? rec.date : todayJST();
    $("fTitle").value = rec ? rec.title : "";
    $("fAmount").value = rec ? String(rec.amount) : "";
    $("fMemo").value = rec ? (rec.memo || "") : "";
    if (rec) {
      if (!$("fCategory").querySelector('option[value="' + CSS.escape(rec.category) + '"]')) {
        const opt = document.createElement("option");
        opt.value = rec.category; opt.textContent = rec.category;
        $("fCategory").appendChild(opt);
      }
      $("fCategory").value = rec.category;
    }
    $("deleteBtn").hidden = !rec;
    $("editDlg").showModal();
  }

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(function () { el.classList.remove("show"); }, 2400);
  }

  // ===== 画面切り替え（ホーム／設定） =====
  let inSettings = false;
  function showSettings() {
    inSettings = true;
    $("homeMain").hidden = true;
    $("monthBar").hidden = true;
    $("settingsMain").hidden = false;
    $("settingsBtn").textContent = "‹ 戻る";
    fillSyncForm();
    window.scrollTo(0, 0);
  }
  function showHome() {
    readSyncForm();
    inSettings = false;
    $("settingsMain").hidden = true;
    $("homeMain").hidden = false;
    $("monthBar").hidden = false;
    $("settingsBtn").textContent = "⚙ 設定";
    render();
    syncNow();
    window.scrollTo(0, 0);
  }
  $("settingsBtn").addEventListener("click", function () {
    if (inSettings) showHome(); else showSettings();
  });

  // ===== イベント =====
  $("prevMonth").addEventListener("click", function () { viewMonth = shiftMonth(viewMonth, -1); render(); });
  $("nextMonth").addEventListener("click", function () { viewMonth = shiftMonth(viewMonth, 1); render(); });
  $("addBtn").addEventListener("click", function () { openEdit(null); });
  $("segOut").addEventListener("click", function () { setType("out"); });
  $("segIn").addEventListener("click", function () { setType("in"); });
  $("cancelBtn").addEventListener("click", function () { $("editDlg").close(); });

  $("editForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const amount = Math.round(Number(String($("fAmount").value).replace(/[^0-9]/g, "")) || 0);
    const title = $("fTitle").value.trim();
    const date = $("fDate").value;
    if (!title || !date || amount <= 0) { toast("日付・内容・金額を確認してください"); return; }
    const ts = new Date().toISOString();
    let rec;
    if (editingId) {
      rec = data.records.find(function (r) { return r.id === editingId; });
      if (!rec) { $("editDlg").close(); return; }
      rec.date = date; rec.type = editingType; rec.title = title; rec.amount = amount;
      rec.category = $("fCategory").value; rec.memo = $("fMemo").value.trim(); rec.updatedAt = ts;
    } else {
      const used = new Set(data.records.map(function (r) { return r.id; }));
      rec = {
        id: S.makeId(used), date: date, type: editingType, category: $("fCategory").value,
        amount: amount, title: title, memo: $("fMemo").value.trim(), origin: "local", updatedAt: ts
      };
      data.records.push(rec);
    }
    viewMonth = date.slice(0, 7);
    saveData(data);
    render();
    $("editDlg").close();
    enqueueSync([S.recordUpsert(rec, ts)]);
    toast("保存しました");
  });

  $("deleteBtn").addEventListener("click", function () {
    if (!editingId) return;
    if (!window.confirm("この記録を削除しますか？")) return;
    const id = editingId;
    const ts = new Date().toISOString();
    data.records = data.records.filter(function (r) { return r.id !== id; });
    saveData(data);
    render();
    $("editDlg").close();
    enqueueSync([S.recordDelete(id, ts)]);
    toast("削除しました");
  });

  // 連携フォーム
  ["syncUrl", "syncToken"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      readSyncForm();
      refreshSyncStatus();
      syncNow();
    });
  });
  $("syncTokenToggle").addEventListener("click", function () {
    const input = $("syncToken");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    this.textContent = show ? "隠す" : "表示";
    this.setAttribute("aria-label", show ? "合言葉を隠す" : "合言葉を表示");
  });

  $("syncTest").addEventListener("click", async function () {
    const st = readSyncForm();
    if (!String(st.token || "").trim() || !st.url.trim()) { toast("送信先URLと合言葉を入力してください"); return; }
    const url = S.safeUrl(st.url);
    if (!url) { toast(S.URL_ERROR); return; }
    try {
      const res = await S.postEvents(window.fetch.bind(window), url, String(st.token).trim(), [S.pingEvent()]);
      const cur = S.loadState(localStorage);
      if (res && res.ok === true && res.pong === true) {
        cur.lastError = "";
        S.saveState(localStorage, cur);
        toast("接続できました");
      } else {
        cur.lastError = S.errorText(res);
        S.saveState(localStorage, cur);
        toast("接続できませんでした: " + cur.lastError);
      }
    } catch (e) {
      const cur = S.loadState(localStorage);
      cur.lastError = "送信できませんでした";
      S.saveState(localStorage, cur);
      toast("接続できませんでした");
    }
    refreshSyncStatus();
  });

  $("syncPull").addEventListener("click", async function () {
    const ok = await pullFromSheet();
    toast(ok ? "シートの内容を反映しました" : "読み直せませんでした（設定と通信を確認）");
  });

  $("syncAll").addEventListener("click", function () {
    if (!data.records.length) { toast("送る記録がありません"); return; }
    const ts = new Date().toISOString();
    enqueueSync(S.snapshotEvents(data.records, ts));
    toast("全データを送信キューに入れました");
  });

  // データ管理
  $("exportBtn").addEventListener("click", function () {
    const payload = {
      app: "Spendly", version: 2, exported_at: new Date().toISOString(),
      items: data.records.map(function (r) {
        return { id: r.id, date: r.date, type: r.type, category: r.category, amount: r.amount, title: r.title, memo: r.memo, origin: r.origin, updated_at: r.updatedAt };
      })
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "spendly-" + todayJST() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  });
  $("importBtn").addEventListener("click", function () { $("importFile").click(); });
  $("importFile").addEventListener("change", function () {
    const file = this.files && this.files[0];
    this.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const imported = S.sanitizeImport(JSON.parse(String(reader.result)));
        if (!imported.length) { toast("取り込める記録がありませんでした"); return; }
        const ts = new Date().toISOString();
        const byId = new Map(data.records.map(function (r) { return [r.id, r]; }));
        imported.forEach(function (rec) {
          rec.updatedAt = ts;
          if (byId.has(rec.id)) Object.assign(byId.get(rec.id), rec);
          else { data.records.push(rec); byId.set(rec.id, rec); }
        });
        saveData(data);
        render();
        enqueueSync(S.snapshotEvents(imported, ts));
        toast(imported.length + "件を取り込みました");
      } catch (e) {
        toast("読み込めませんでした: " + (e && e.message ? e.message : "形式エラー"));
      }
    };
    reader.readAsText(file);
  });

  // 起動・復帰時の同期（budget-appと同じタイミング）
  fillSyncForm();
  render();
  syncNow();
  window.addEventListener("online", syncNow);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") syncNow();
  });
})();
