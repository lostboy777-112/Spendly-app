/**
 * 家計簿アプリ（Spendly）から、このスプレッドシートへ記録を受け取り、
 * アプリへ全件を返します。このシートが正本です。
 *
 * 準備（詳しくは SETUP.md）:
 * 1. 拡張機能 → Apps Script に、このファイルの中身を貼る
 * 2. プロジェクトの設定 → スクリプト プロパティ
 *    名前は SYNC_TOKEN、値はアプリの「合言葉」と同じ文字列
 * 3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *    実行するユーザーは「自分」、アクセスできるユーザーは「全員」
 * 4. このファイルを直したあとは、デプロイを管理 → 編集 → 新バージョン
 *    （URL を変えないため）
 *
 * 合言葉の値、ウェブアプリの URL、支出の金額は、このファイルや Git に書かないでください。
 * 文字の列はプレーンテキストとして書き、= + - @ で始まる値には引用符を付けます。
 */

var RECORD_SHEET = "記録";
var RECORD_HEADERS = ["ID", "日付", "月", "種別", "カテゴリ", "金額", "内容", "メモ", "記録者", "更新日時", "削除"];
var MAX_EVENTS = 500;
var MAX_TEXT = 200;
var MAX_ID = 64;
var MAX_UPDATED = 80;

// GET: 合言葉が合えば全件を返す（削除済みも含む。アプリ側の照合用）
function doGet(e) {
  var token = e && e.parameter ? e.parameter.token : "";
  if (!authorized_(token)) {
    return json_({ ok: false, error: "unauthorized" });
  }
  var sh = sheet_(RECORD_SHEET, RECORD_HEADERS);
  var last = sh.getLastRow();
  var records = [];
  if (last >= 2) {
    var values = sh.getRange(2, 1, last - 1, RECORD_HEADERS.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      var id = storedText_(row[0]);
      if (!id) continue;
      records.push({
        id: id,
        date: storedText_(row[1]),
        month: storedText_(row[2]),
        type: storedText_(row[3]) === "収入" ? "in" : "out",
        category: storedText_(row[4]),
        amount: amount_(row[5]),
        title: storedText_(row[6]),
        memo: storedText_(row[7]),
        origin: storedText_(row[8]) === "ヴェーダ" ? "veda" : "local",
        updatedAt: storedText_(row[9]),
        deleted: row[10] === true || storedText_(row[10]) === "TRUE"
      });
    }
  }
  return json_({ ok: true, records: records });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    if (!authorized_(body && body.token)) {
      return json_({ ok: false, error: "unauthorized" });
    }
    var events = body && Array.isArray(body.events) ? body.events : [];
    if (events.length > MAX_EVENTS) {
      return json_({ ok: false, error: "too many events" });
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var sawPing = false;
      var skipped = 0;
      for (var i = 0; i < events.length; i++) {
        var ev = events[i] || {};
        if (ev.type === "ping") {
          sawPing = true;
        } else if (ev.type === "record_upsert") {
          if (!validRecordUpsert_(ev)) skipped++;
          else upsertRecord_(ev);
        } else if (ev.type === "record_delete") {
          if (!validRecordDelete_(ev)) skipped++;
          else markRecordDeleted_(ev);
        } else {
          skipped++;
        }
      }
      SpreadsheetApp.flush();
      var result = { ok: true, skipped: skipped };
      if (sawPing) result.pong = true;
      return json_(result);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function authorized_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty("SYNC_TOKEN");
  if (!expected || token === undefined || token === null || String(token) === "") return false;
  return String(token) === String(expected);
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  return JSON.parse(e.postData.contents);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function validId_(id) {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID && /^[A-Za-z0-9_-]+$/.test(id);
}

function validDate_(value) {
  var text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  var y = Number(text.slice(0, 4));
  var m = Number(text.slice(5, 7));
  var d = Number(text.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validMonth_(value) {
  var text = String(value || "");
  if (!/^\d{4}-\d{2}$/.test(text)) return false;
  var m = Number(text.slice(5, 7));
  return m >= 1 && m <= 12;
}

function textLenOk_(value) {
  return String(value == null ? "" : value).length <= MAX_TEXT;
}

function updatedOk_(value) {
  return String(value == null ? "" : value).length <= MAX_UPDATED;
}

function validRecordUpsert_(ev) {
  var date = String(ev.date || "");
  var month = String(ev.month || "");
  return validId_(ev.id) && validDate_(date) && validMonth_(month) && month === date.slice(0, 7)
    && (ev.kind === "out" || ev.kind === "in")
    && textLenOk_(ev.category) && textLenOk_(ev.title) && textLenOk_(ev.memo)
    && (ev.origin === "local" || ev.origin === "veda")
    && updatedOk_(ev.updatedAt);
}

function validRecordDelete_(ev) {
  return validId_(ev.id) && updatedOk_(ev.updatedAt);
}

function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("スプレッドシートに紐づいたスクリプトとして実行してください");
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function findRowBy_(sh, match) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var width = Math.max(sh.getLastColumn(), 1);
  var values = sh.getRange(2, 1, last - 1, width).getValues();
  for (var i = 0; i < values.length; i++) {
    if (match(values[i])) return i + 2;
  }
  return -1;
}

function isStale_(incoming, existing) {
  var inc = toMillis_(incoming);
  var cur = toMillis_(storedText_(existing));
  if (inc === null || cur === null) return false;
  return inc < cur;
}

function toMillis_(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && isFinite(value)) return value;
  var text = storedText_(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  var parsed = Date.parse(text);
  return isNaN(parsed) ? null : parsed;
}

function storedText_(value) {
  if (value instanceof Date) return value;
  var text = String(value == null ? "" : value);
  if (text.charAt(0) === "'") return text.slice(1);
  return text;
}

function plainText_(value) {
  var text = String(value == null ? "" : value);
  if (!text) return "";
  var first = text.charAt(0);
  if (first === "=" || first === "+" || first === "-" || first === "@" || first === "\t" || first === "\r") {
    return "'" + text;
  }
  return text;
}

function amount_(value) {
  var n = Number(value);
  if (!isFinite(n)) return 0;
  return n;
}

function markText_(sh, row, cols) {
  for (var i = 0; i < cols.length; i++) sh.getRange(row, cols[i]).setNumberFormat("@");
}

function upsertRecord_(ev) {
  var id = String(ev.id);
  var sh = sheet_(RECORD_SHEET, RECORD_HEADERS);
  var row = findRowBy_(sh, function (values) { return storedText_(values[0]) === id; });
  if (row > 1 && isStale_(ev.updatedAt, sh.getRange(row, 10).getValue())) return;
  var target = row > 1 ? row : sh.getLastRow() + 1;
  markText_(sh, target, [1, 2, 3, 4, 5, 7, 8, 9, 10]);
  sh.getRange(target, 6).setNumberFormat("0");
  var values = [[
    plainText_(id),
    plainText_(ev.date || ""),
    plainText_(ev.month || ""),
    plainText_(ev.kind === "in" ? "収入" : "支出"),
    plainText_(ev.category || ""),
    amount_(ev.amount),
    plainText_(ev.title || ""),
    plainText_(ev.memo || ""),
    plainText_(ev.origin === "veda" ? "ヴェーダ" : "自分"),
    plainText_(ev.updatedAt || ""),
    false
  ]];
  sh.getRange(target, 1, 1, 11).setValues(values);
}

function markRecordDeleted_(ev) {
  var id = String(ev.id);
  var sh = sheet_(RECORD_SHEET, RECORD_HEADERS);
  var row = findRowBy_(sh, function (values) { return storedText_(values[0]) === id; });
  if (row > 1) {
    if (isStale_(ev.updatedAt, sh.getRange(row, 10).getValue())) return;
    markText_(sh, row, [10]);
    sh.getRange(row, 10).setValue(plainText_(ev.updatedAt || ""));
    sh.getRange(row, 11).setValue(true);
    return;
  }
  var target = sh.getLastRow() + 1;
  markText_(sh, target, [1, 2, 3, 4, 5, 7, 8, 9, 10]);
  sh.getRange(target, 1, 1, 11).setValues([[
    plainText_(id), "", "", "", "", "", "", "", "", plainText_(ev.updatedAt || ""), true
  ]]);
}
