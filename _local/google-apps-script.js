/**
 * MOOD TRACKER — Google Sheets Sync v3
 *
 * Mood Log matches the original Excel tracker format:
 *   Date | Day | Lamotrigine | Quetiapine | Lithium | Levothyroxine | Naltrexone | Notes | Sleep | Irritability | Anxiety | SevElev | ModElev | MildElev | Normal | MildDep | ModDep | SevDep | Weight
 *   Mood severity marked with "X" in the corresponding column.
 *
 * POST types:
 *   {type:"mood", date, entry:{mood,mood2,sleep,...,meds:{key:{ct,off,note}}}, meds_ref:[{key,name,dose}]}
 *   {type:"srm",  date, items:[{id,time,am,...}]}
 *   {type:"delete_mood", date}
 *   {type:"delete_srm",  date}
 *
 * GET ?action=sync → {status:"ok", mood:{...}, srm:{...}}
 */

var MED_COLS = [
  {key:"lamotrigine",  header:"Lamotrigine\n(200mg/pill)"},
  {key:"quetiapine",   header:"Quetiapine\n(100mg/pill)"},
  {key:"lithium",      header:"Lithium Carbonate\n(300mg/pill)"},
  {key:"levothyroxine",header:"Levothyroxine\n(50mcg/pill)"},
  {key:"naltrexone",   header:"Naltrexone\n(50mg/pill)"}
];

var MOOD_COLS = [
  {key:"sev_elev",  header:"Severe\nElevated"},
  {key:"mod_elev",  header:"Moderate\nElevated"},
  {key:"mild_elev", header:"Mild\nElevated"},
  {key:"normal",    header:"Normal"},
  {key:"mild_dep",  header:"Mild\nDepressed"},
  {key:"mod_dep",   header:"Moderate\nDepressed"},
  {key:"sev_dep",   header:"Severe\nDepressed"}
];

var MOOD_BG = {
  "sev_elev":"#FDF0EC","mod_elev":"#FDF5EE","mild_elev":"#FAF6ED",
  "normal":"#EFF6F1","mild_dep":"#EEF3F8","mod_dep":"#EDF0F6","sev_dep":"#EDEEF4"
};

var DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];


function doPost(e) {
  var d = null;
  try {
    var raw = (e && e.postData && e.postData.contents) || "{}";
    d = JSON.parse(raw);
    var secret = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
    if (secret && d._secret !== secret) {
      Logger.log("doPost rejected missing/invalid secret type=%s date=%s", d && d.type, d && d.date);
      return out_({status:"error", message:"forbidden"});
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var actor = sanitizeActor_(d.actor);
    Logger.log("doPost type=%s date=%s actor=%s", d.type, d.date, actor);
    switch (d.type) {
      case "mood":
        upsertMoodRow_(ss, d.date, d.entry || {}, d.meds_ref || []);
        recordLogActivity_(ss, d.date, actor, "mood");
        if (!d._fromWorker) forwardToD1_(ss, "mood", d.date, d.entry || {}, d.meds_ref || []);
        break;
      case "srm":
        upsertSrmRows_(ss, d.date, d.items || []);
        recordLogActivity_(ss, d.date, actor, "srm");
        if (!d._fromWorker) forwardToD1_(ss, "srm", d.date, null, null, d.items || []);
        break;
      case "delete_mood":
        deleteMoodRows_(ss, d.date);
        recordLogActivity_(ss, d.date, actor, "delete_mood");
        if (!d._fromWorker) forwardToD1_(ss, "delete_mood", d.date);
        break;
      case "delete_srm":
        deleteSrmRows_(ss, d.date);
        recordLogActivity_(ss, d.date, actor, "delete_srm");
        if (!d._fromWorker) forwardToD1_(ss, "delete_srm", d.date);
        break;
      case "settings":
        upsertSettings_(ss, d.settings || {}, d.meds || []);
        if (!d._fromWorker) forwardToD1_(ss, "settings", null, null, null, null, d.settings || {}, d.meds || []);
        break;
      case "push_subscribe":    upsertPushSubscription_(ss, d.subscription || {}, sanitizeRole_(d.role), actor, d.tz || ""); break;
      case "push_unsubscribe":  deletePushSubscription_(ss, d.endpoint || ""); break;
      case "update_push_role":  updatePushSubscriptionRole_(ss, d.endpoint || "", sanitizeRole_(d.role), actor, d.tz || ""); break;
      case "update_push_tz":    updatePushSubscriptionTz_(ss, d.endpoint || "", d.tz || "", actor); break;
    }
    return out_({status:"ok"});
  } catch (err) {
    Logger.log("doPost FAILED type=%s date=%s err=%s\nstack: %s",
      d && d.type, d && d.date, String(err), (err && err.stack) || "(no stack)");
    return out_({status:"error", message:String(err)});
  }
}

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || "";
    var cb = (e && e.parameter && e.parameter.callback) || "";
    if (action === "sync") {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var settingsData = readSettings_(ss);
      var payload = {status:"ok", mood:readMood_(ss), srm:readSrm_(ss), settings:settingsData.settings, meds:settingsData.meds};
      return cb ? outP_(cb, payload) : out_(payload);
    }
    if (action === "test_push") {
      var ep = (e && e.parameter && e.parameter.endpoint) || "";
      return out_(debugFirePush_(ep));
    }
    if (action === "force_smart_reminder") {
      var slot = (e && e.parameter && e.parameter.slot) || "midnight";
      var force = !!(e && e.parameter && e.parameter.force && e.parameter.force !== "0");
      return out_(debugForceSmartReminder_(slot, force));
    }
    if (action === "log_stats") {
      return out_(debugLogStats_());
    }
    if (action === "consolidate_meds") {
      var ssc = SpreadsheetApp.getActiveSpreadsheet();
      var sc = ssc.getSheetByName("Mood Log");
      if (!sc) return out_({status:"error", message:"no Mood Log sheet"});
      var sd = readSettings_(ssc);
      var lc = getMoodLayout_(sc, sd.meds || []);
      if (!lc) return out_({status:"error", message:"invalid layout"});
      var dropped = consolidateDuplicateMedCols_(sc, lc, sd.meds || []);
      return out_({status:"ok", droppedColumns: dropped});
    }
    if (action === "debug_layout") {
      var ssd = SpreadsheetApp.getActiveSpreadsheet();
      var s = ssd.getSheetByName("Mood Log");
      if (!s) return out_({error: "no Mood Log sheet"});
      var lastCol = s.getLastColumn();
      var hRange = s.getRange(2, 1, 1, lastCol);
      var settingsData = readSettings_(ssd);
      var layout = null, layoutErr = null;
      try { layout = getMoodLayout_(s, settingsData.meds || []); }
      catch (e2) { layoutErr = String(e2); }
      return out_({
        lastCol: lastCol,
        row1: s.getRange(1, 1, 1, lastCol).getValues()[0],
        row2_headers: hRange.getValues()[0],
        row2_notes: hRange.getNotes()[0],
        settings_meds: settingsData.meds,
        layout: layout,
        layoutErr: layoutErr
      });
    }
    var msg = {status:"ok", message:"Mood Tracker API ready."};
    return cb ? outP_(cb, msg) : out_(msg);
  } catch (err) {
    var o = {status:"error", message:String(err)};
    var c2 = (e && e.parameter && e.parameter.callback) || "";
    return c2 ? outP_(c2, o) : out_(o);
  }
}


/* ═══════════════════ MOOD LOG ═══════════════════
   Layout is dynamic. Column positions for Notes/Sleep/Irritability/Anxiety/
   Weight and each mood column are located by row-2 header text on every
   read/write. Med columns sit between Day (col 2) and Notes. When the app
   sends a med that has no column yet, ensureMedColumns_ inserts one just
   before Notes. Each med header cell stores its stable key in a cell note
   ("key:<id>") so renames don't orphan the column. Data starts row 3.
*/

function formatMedHeader_(m) {
  var name = (m && m.name) ? String(m.name) : (m && m.key ? String(m.key) : "");
  var dose = (m && m.dose) ? String(m.dose) : "";
  return dose ? (name + "\n(" + dose + "/pill)") : name;
}

function seedMedsFromColsConst_() {
  return MED_COLS.map(function(mc){
    var name = mc.header.split("\n")[0].trim();
    var dm = mc.header.match(/\(([^)]+?)\/pill\)/);
    return { key: mc.key, name: name, dose: dm ? dm[1] : "" };
  });
}

function buildNameKeyMap_(medsRef) {
  var map = {};
  seedMedsFromColsConst_().forEach(function(m){
    if (m.name) map[m.name.toLowerCase()] = m.key;
  });
  (medsRef || []).forEach(function(m){
    if (m && m.name && m.key) map[String(m.name).toLowerCase()] = m.key;
  });
  return map;
}

function normHeader_(s) {
  // Case-insensitive, whitespace-collapsed comparison — survives manual edits
  // like extra spaces or capitalization changes on header cells.
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
}

// Mood column headers vary widely between sheet versions:
//   "Severe\nElevated" (current init), "Sev Elev" (legacy), "Severely Elevated", etc.
// Match each MOOD_COLS key by requiring at least one substring from each group.
var MOOD_PATTERNS = {
  "sev_elev":  [["sev","severe"], ["elev","elevated"]],
  "mod_elev":  [["mod","moderate"], ["elev","elevated"]],
  "mild_elev": [["mild"],          ["elev","elevated"]],
  "normal":    [["normal"]],
  "mild_dep":  [["mild"],          ["dep","depressed"]],
  "mod_dep":   [["mod","moderate"], ["dep","depressed"]],
  "sev_dep":   [["sev","severe"], ["dep","depressed"]]
};

function findMoodColByKey_(headers, key) {
  var patterns = MOOD_PATTERNS[key];
  if (!patterns) return -1;
  for (var i = 0; i < headers.length; i++) {
    var nh = normHeader_(headers[i]);
    if (!nh) continue;
    var allGroups = true;
    for (var p = 0; p < patterns.length; p++) {
      var group = patterns[p], found = false;
      for (var w = 0; w < group.length; w++) {
        if (nh.indexOf(group[w]) >= 0) { found = true; break; }
      }
      if (!found) { allGroups = false; break; }
    }
    if (allGroups) return i + 1;
  }
  return -1;
}

// Detect whether headers are in row 1 (legacy/manual sheets) or row 2
// (sheets created by initMoodSheet_, which uses a row-1 section group +
// row-2 column header layout).
function detectMoodHeaderRow_(s) {
  var lastCol = s.getLastColumn();
  if (lastCol < 2) return { headerRow: 2, dataStartRow: 3 };
  var top = s.getRange(1, 1, 2, Math.min(2, lastCol)).getValues();
  var r2c2 = normHeader_(top[1][1]);
  if (r2c2 === "day") return { headerRow: 2, dataStartRow: 3 };
  var r2c1raw = top[1][0];
  if (Object.prototype.toString.call(r2c1raw) === "[object Date]") return { headerRow: 1, dataStartRow: 2 };
  if (/^\d{4}-\d{2}-\d{2}/.test(String(r2c1raw).trim())) return { headerRow: 1, dataStartRow: 2 };
  return { headerRow: 2, dataStartRow: 3 };
}

function findColByHeader_(headers, text) {
  var target = normHeader_(text);
  for (var i = 0; i < headers.length; i++) {
    if (normHeader_(headers[i]) === target) return i + 1;
  }
  return -1;
}

function findColByHeaderPrefix_(headers, prefix) {
  var target = normHeader_(prefix);
  for (var i = 0; i < headers.length; i++) {
    if (normHeader_(headers[i]).indexOf(target) === 0) return i + 1;
  }
  return -1;
}

function getMoodLayout_(s, medsRef) {
  var lastCol = s.getLastColumn();
  if (lastCol < 4) return null;

  var det = detectMoodHeaderRow_(s);
  var headerRow = det.headerRow;
  var dataStartRow = det.dataStartRow;

  var hRange = s.getRange(headerRow, 1, 1, lastCol);
  var headers = hRange.getValues()[0];
  var noteRow = hRange.getNotes()[0];

  var notesCol  = findColByHeader_(headers, "Daily Notes");
  if (notesCol < 0) notesCol = findColByHeader_(headers, "Notes");
  var sleepCol  = findColByHeader_(headers, "Hours Slept");
  if (sleepCol < 0) sleepCol = findColByHeader_(headers, "Sleep");
  var irrCol    = findColByHeaderPrefix_(headers, "Irritability");
  var anxCol    = findColByHeaderPrefix_(headers, "Anxiety");
  var weightCol = findColByHeader_(headers, "lbs");
  if (weightCol < 0) weightCol = findColByHeaderPrefix_(headers, "Weight");
  if (notesCol < 0 || sleepCol < 0 || weightCol < 0) return null;

  var nameKey = buildNameKeyMap_(medsRef);
  var meds = [];
  // Med columns are everything between col 2 (Day) and Notes
  for (var i = 2; i < notesCol - 1; i++) {
    var hdr = String(headers[i] || "").trim();
    if (!hdr) continue;
    // Name = the segment before the first "(", "[", or newline
    var name = hdr.split(/[\n([]/)[0].trim();
    var doseMatch = hdr.match(/\(([^)]+?)\)/);
    var dose = doseMatch ? doseMatch[1].replace(/\/pill$/, "").trim() : "";
    var key = null;
    var n = String(noteRow[i] || "");
    var km = n.match(/key:([^\s]+)/);
    if (km) key = km[1];
    if (!key) {
      // Some sheets stamp the key in the header text as "[<key>]"
      var bk = hdr.match(/\[([^\]]+)\]/);
      if (bk) key = bk[1];
    }
    if (!key) key = nameKey[name.toLowerCase()];
    if (!key) key = name.toLowerCase().replace(/\s+/g, "_");
    meds.push({ key: key, name: name, dose: dose, col: i + 1 });
  }

  var moods = MOOD_COLS.map(function(mc){
    var c = findColByHeader_(headers, mc.header);
    if (c < 0) c = findMoodColByKey_(headers, mc.key);
    return { key: mc.key, col: c };
  });

  return {
    headerRow: headerRow, dataStartRow: dataStartRow,
    notesCol: notesCol, sleepCol: sleepCol, irrCol: irrCol, anxCol: anxCol,
    weightCol: weightCol, meds: meds, moods: moods
  };
}

// Auto-cleanup of duplicate med columns: when a stale column (its key isn't
// in the app's current meds list) shares a first-word with a current column
// AND has no data in any row, drop it. Catches the "removed & re-added a med"
// case where the recreated med gets a new timestamped key and would otherwise
// orphan an empty column under the same display name.
function consolidateDuplicateMedCols_(s, layout, medsRef) {
  if (!layout || !layout.meds.length) return 0;

  var currentKeys = {};
  (medsRef || []).forEach(function(m){ if (m && m.key) currentKeys[m.key] = true; });

  function firstWord_(name){
    return String(name || "").trim().toLowerCase().split(/[\s/(\[]/)[0];
  }

  var lr = s.getLastRow();
  var emptiness = {};
  if (lr >= layout.dataStartRow) {
    var minCol = layout.meds[0].col;
    var maxCol = layout.meds[layout.meds.length - 1].col;
    var vals = s.getRange(layout.dataStartRow, minCol, lr - layout.dataStartRow + 1, maxCol - minCol + 1).getValues();
    layout.meds.forEach(function(m){
      var idx = m.col - minCol;
      var hasData = false;
      for (var i = 0; i < vals.length; i++) {
        if (vals[i][idx] !== "" && vals[i][idx] != null) { hasData = true; break; }
      }
      emptiness[m.col] = !hasData;
    });
  } else {
    layout.meds.forEach(function(m){ emptiness[m.col] = true; });
  }

  var groups = {};
  layout.meds.forEach(function(m){
    var w = firstWord_(m.name);
    if (!w) return;
    if (!groups[w]) groups[w] = [];
    groups[w].push(m);
  });

  var deleteCols = [];
  Object.keys(groups).forEach(function(w){
    var group = groups[w];
    if (group.length < 2) return;
    var hasCurrent = false;
    for (var i = 0; i < group.length; i++) if (currentKeys[group[i].key]) { hasCurrent = true; break; }
    if (!hasCurrent) return;
    group.forEach(function(m){
      if (!currentKeys[m.key] && emptiness[m.col]) deleteCols.push(m.col);
    });
  });

  deleteCols.sort(function(a,b){ return b - a; }).forEach(function(c){
    s.deleteColumn(c);
  });

  return deleteCols.length;
}

function ensureMedColumns_(s, medsRef) {
  if (!medsRef || !medsRef.length) return;
  var layout = getMoodLayout_(s, medsRef);
  if (!layout) return;

  // Backfill key-notes on any legacy columns missing them
  layout.meds.forEach(function(m){
    var cell = s.getRange(layout.headerRow, m.col);
    if (!cell.getNote() && m.key) cell.setNote("key:" + m.key);
  });

  // Drop empty stale duplicates before deciding what to add.
  var dropped = consolidateDuplicateMedCols_(s, layout, medsRef);
  if (dropped) {
    layout = getMoodLayout_(s, medsRef);
    if (!layout) return;
  }

  var have = {};
  layout.meds.forEach(function(m){ if (m.key) have[m.key] = true; });
  var toAdd = medsRef.filter(function(m){ return m && m.key && !have[m.key]; });
  if (!toAdd.length) return;

  var notesCol = layout.notesCol;
  toAdd.forEach(function(m){
    s.insertColumnBefore(notesCol);
    var col = notesCol;
    s.getRange(layout.headerRow, col)
      .setValue(formatMedHeader_(m))
      .setNote("key:" + m.key)
      .setFontWeight("bold")
      .setHorizontalAlignment("center")
      .setVerticalAlignment("middle")
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP)
      .setFontFamily("Arial")
      .setFontSize(9)
      .setBackground("#FAF8F5");
    s.setColumnWidth(col, 50);
    notesCol++;
  });

  // Re-merge the TREATMENT section header only for sheets that have one
  // (2-row header layout created by initMoodSheet_). Legacy 1-row layouts
  // have no merged section row above the column headers.
  if (layout.headerRow === 2) {
    var firstMedCol = 3;
    var lastMedCol = notesCol - 1;
    if (lastMedCol >= firstMedCol) {
      try { s.getRange(1, firstMedCol, 1, lastMedCol - firstMedCol + 1).breakApart(); } catch (e) {}
      s.getRange(1, firstMedCol).setValue("TREATMENT — taken yesterday");
      if (lastMedCol > firstMedCol) {
        s.getRange(1, firstMedCol, 1, lastMedCol - firstMedCol + 1).merge();
      }
    }
  }
}

function initMoodSheet_(s, meds) {
  if (!meds || !meds.length) meds = seedMedsFromColsConst_();
  var nMeds = meds.length;
  var notesCol     = 3 + nMeds;
  var sleepCol     = notesCol + 1;
  var irrCol       = sleepCol + 1;
  var anxCol       = irrCol + 1;
  var moodStartCol = anxCol + 1;
  var weightCol    = moodStartCol + 7;

  // Row 1: section headers
  s.getRange(1, 1).setValue("DATE");
  s.getRange(1, 3).setValue("TREATMENT — taken yesterday");
  s.getRange(1, notesCol).setValue("NOTES");
  s.getRange(1, sleepCol).setValue("SLEEP");
  s.getRange(1, irrCol).setValue("MOOD OF THE DAY BEFORE");
  s.getRange(1, weightCol).setValue("WEIGHT");
  if (nMeds > 1) s.getRange(1, 3, 1, nMeds).merge();
  s.getRange(1, irrCol, 1, 9).merge();

  // Row 2: column headers
  var h = ["Date", "Day"];
  meds.forEach(function(m){ h.push(formatMedHeader_(m)); });
  h.push("Daily Notes", "Hours Slept", "Irritability\n(0-3)", "Anxiety\n(0-3)");
  MOOD_COLS.forEach(function(m){ h.push(m.header); });
  h.push("lbs");
  s.getRange(2, 1, 1, h.length).setValues([h]);
  meds.forEach(function(m, idx){
    if (m.key) s.getRange(2, 3 + idx).setNote("key:" + m.key);
  });

  // Formatting
  s.getRange("1:2").setFontWeight("bold").setHorizontalAlignment("center")
    .setVerticalAlignment("middle").setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP)
    .setFontFamily("Arial").setFontSize(9);
  s.getRange("1:1").setBackground("#E8E4DE").setFontSize(9);
  s.getRange("2:2").setBackground("#FAF8F5");
  s.setFrozenRows(2);
  s.setRowHeight(1, 28);
  s.setRowHeight(2, 68);

  // Force Date column to text so "yyyy-MM-dd" strings aren't coerced to Date objects.
  s.getRange("A:A").setNumberFormat("@");

  s.setColumnWidth(1, 85);
  s.setColumnWidth(2, 36);
  for (var i = 3; i < notesCol; i++) s.setColumnWidth(i, 50);
  s.setColumnWidth(notesCol, 220);
  s.setColumnWidth(sleepCol, 50);
  s.setColumnWidth(irrCol, 62);
  s.setColumnWidth(anxCol, 50);
  for (var j = moodStartCol; j < weightCol; j++) s.setColumnWidth(j, 68);
  s.setColumnWidth(weightCol, 48);

  for (var k = 0; k < 7; k++) {
    s.getRange(2, moodStartCol + k).setBackground(MOOD_BG[MOOD_COLS[k].key]);
  }

  s.getRange(1, 1, 2, weightCol)
    .setBorder(true, true, true, true, true, true, "#D5D0C8", SpreadsheetApp.BorderStyle.SOLID);
}

function getMoodSheet_(ss) {
  var s = ss.getSheetByName("Mood Log");
  if (!s) {
    s = ss.insertSheet("Mood Log");
    initMoodSheet_(s, seedMedsFromColsConst_());
  } else {
    // Idempotent guard for older sheets: ensure Date column is text-formatted.
    s.getRange("A:A").setNumberFormat("@");
  }
  return s;
}

function upsertMoodRow_(ss, date, entry, medsRef) {
  var s = getMoodSheet_(ss);
  ensureMedColumns_(s, medsRef);
  var layout = getMoodLayout_(s, medsRef);
  if (!layout) throw new Error("Mood Log layout invalid");

  var dt = new Date(date + "T12:00:00");
  var dayStr = DAYS[dt.getDay()] || "";

  // Dose lookup from meds_ref for "N x dose" formatting
  var refMap = {};
  (medsRef || []).forEach(function(mr){ if (mr && mr.key) refMap[mr.key] = mr.dose || ""; });

  var totalCols = layout.weightCol;
  var row = [];
  for (var c = 0; c < totalCols; c++) row.push("");
  row[0] = date;
  row[1] = dayStr;

  layout.meds.forEach(function(mc){
    var m = entry.meds && entry.meds[mc.key];
    var dose = refMap[mc.key] || mc.dose;
    row[mc.col - 1] = formatDailyMedCell_(m, dose);
  });

  row[layout.notesCol - 1] = entry.notes || "";
  row[layout.sleepCol - 1] = entry.sleep        != null ? entry.sleep        : "";
  row[layout.irrCol   - 1] = entry.irritability != null ? entry.irritability : "";
  row[layout.anxCol   - 1] = entry.anxiety      != null ? entry.anxiety      : "";

  var moods = [];
  if (Array.isArray(entry.moods) && entry.moods.length) moods = entry.moods;
  else { if (entry.mood) moods.push(entry.mood); if (entry.mood2) moods.push(entry.mood2); }
  layout.moods.forEach(function(mc){
    if (mc.col > 0) row[mc.col - 1] = moods.indexOf(mc.key) >= 0 ? "X" : "";
  });

  row[layout.weightCol - 1] = entry.weight != null ? entry.weight : "";

  // Migrate any legacy Date-object cells in the Date column to "yyyy-MM-dd" text,
  // so findDateRow_ can match them and sort doesn't mix types.
  normalizeDateColumn_(s, layout.dataStartRow);

  var ri = findDateRow_(s, date, layout.dataStartRow);
  if (ri > 0) {
    s.getRange(ri, 1).setNumberFormat("@");
    s.getRange(ri, 1, 1, row.length).setValues([row]);
    s.getRange(ri, 1).setValue(date);
    styleMoodRow_(s, ri, moods, layout);
  } else {
    // Avoid appendRow — it auto-coerces "yyyy-MM-dd" strings into Date objects.
    var newRow = Math.max(layout.dataStartRow, s.getLastRow() + 1);
    s.getRange(newRow, 1).setNumberFormat("@");
    s.getRange(newRow, 1, 1, row.length).setValues([row]);
    s.getRange(newRow, 1).setValue(date);
    styleMoodRow_(s, newRow, moods, layout);
    if (newRow > layout.dataStartRow) {
      s.getRange(layout.dataStartRow, 1, newRow - layout.dataStartRow + 1, row.length)
        .sort({column:1, ascending:true});
    }
  }
}

function styleMoodRow_(sheet, row, moods, layout) {
  var totalCols = layout.weightCol;
  sheet.getRange(row, 1, 1, totalCols).setFontFamily("Arial").setFontSize(10).setVerticalAlignment("middle");
  sheet.getRange(row, 2).setHorizontalAlignment("center");
  if (layout.meds.length) {
    sheet.getRange(row, 3, 1, layout.meds.length).setHorizontalAlignment("center");
  }
  sheet.getRange(row, layout.sleepCol, 1, 3).setHorizontalAlignment("center");
  sheet.getRange(row, layout.weightCol).setHorizontalAlignment("center");

  layout.moods.forEach(function(mc){
    if (mc.col < 0) return;
    var cell = sheet.getRange(row, mc.col);
    cell.setHorizontalAlignment("center");
    if (moods.indexOf(mc.key) >= 0) {
      cell.setBackground(MOOD_BG[mc.key]).setFontWeight("bold");
    } else {
      cell.setBackground("#FFFFFF").setFontWeight("normal");
    }
  });

  sheet.getRange(row, 1, 1, totalCols)
    .setBorder(null, null, true, null, null, null, "#E8E4DE", SpreadsheetApp.BorderStyle.SOLID);
}

function deleteMoodRows_(ss, date) {
  var s = ss.getSheetByName("Mood Log");
  if(!s) return;
  deleteRowsByDate_(s, date, 3);
}

function readMood_(ss) {
  var s = ss.getSheetByName("Mood Log");
  if (!s) return {};
  var settingsData = readSettings_(ss);
  var layout = getMoodLayout_(s, settingsData.meds || []);
  if (!layout) return {};
  if (s.getLastRow() < layout.dataStartRow) return {};

  var totalCols = layout.weightCol;
  var numRows = s.getLastRow() - layout.dataStartRow + 1;
  if (numRows <= 0) return {};
  var vals = s.getRange(layout.dataStartRow, 1, numRows, totalCols).getValues();
  var result = {};
  vals.forEach(function(r){
    var dt = normalizeDateKey_(r[0]);
    if (!dt) return;
    var meds = {};
    layout.meds.forEach(function(mc){
      var raw = r[mc.col - 1];
      if (raw === "" || raw == null) return;
      var parsedMed = parseDailyMedCell_(raw);
      if (parsedMed) meds[mc.key] = parsedMed;
    });
    var mood = null, mood2 = null;
    layout.moods.forEach(function(mc){
      if (mc.col > 0 && String(r[mc.col - 1]).trim().toUpperCase() === "X") {
        if (!mood) mood = mc.key;
        else if (!mood2) mood2 = mc.key;
      }
    });
    var sleepV  = r[layout.sleepCol  - 1];
    var irrV    = r[layout.irrCol    - 1];
    var anxV    = r[layout.anxCol    - 1];
    var weightV = r[layout.weightCol - 1];
    result[dt] = {
      mood: mood, mood2: mood2,
      sleep:        sleepV  !== "" && sleepV  != null ? Number(sleepV)  : null,
      irritability: irrV    !== "" && irrV    != null ? Number(irrV)    : null,
      anxiety:      anxV    !== "" && anxV    != null ? Number(anxV)    : null,
      weight:       weightV !== "" && weightV != null ? Number(weightV) : null,
      notes: r[layout.notesCol - 1] || "",
      meds: meds
    };
  });
  return result;
}

function cleanDailyMedNote_(note) {
  return String(note || "").replace(/[\r\n]+/g, " ").trim();
}

function formatDailyMedCell_(m, dose) {
  if (!m) return "";
  var ct = Number(m.ct || 0);
  if (!isFinite(ct) || ct < 0) ct = 0;
  var off = !!m.off && ct > 0;
  var note = cleanDailyMedNote_(m.note);
  if (off) {
    var base = dose ? (ct + " x " + dose) : String(ct);
    return base + (note ? " (off schedule: " + note + ")" : " (off schedule)");
  }
  if (ct <= 0) return note ? ("0 (" + note + ")") : "0";
  return dose ? (ct + " x " + dose) : ct;
}

function parseDailyMedCell_(raw) {
  var text = String(raw || "").trim();
  if (!text) return null;
  var lower = text.toLowerCase();
  var off = lower.indexOf("off schedule") >= 0;
  var note = "";
  var paren = text.match(/\(([^)]*)\)\s*$/);
  if (paren) {
    note = paren[1].replace(/^off schedule\s*:?\s*/i, "").trim();
  }
  if (lower.indexOf("not taken") === 0) {
    var missed = { ct: 0, off: false };
    if (note) missed.note = note;
    return missed;
  }
  var ct = Number(text);
  if (isNaN(ct)) {
    var match = text.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*/i);
    ct = match ? Number(match[1]) : 0;
  }
  if (ct <= 0 && !off && !note && text !== "0") return null;
  var med = { ct: Math.max(0, ct), off: off && ct > 0 };
  if (note) med.note = note;
  return med;
}


/* ═══════════════════ RHYTHM LOG ═══════════════════ */

function getSrmSheet_(ss) {
  var s = ss.getSheetByName("Rhythm Log");
  if(!s){
    s = ss.insertSheet("Rhythm Log");
    s.appendRow(["Date","Activity","Time","AM/PM","Skipped","With Others","Who","Name","Engagement"]);
    s.getRange("1:1").setFontWeight("bold").setBackground("#F5F0E8").setFontFamily("Arial").setFontSize(9);
    s.setFrozenRows(1);
    s.setColumnWidth(1,90); s.setColumnWidth(2,130); s.setColumnWidth(9,140);
    s.getRange("A:A").setNumberFormat("@");
  } else {
    s.getRange("A:A").setNumberFormat("@");
  }
  return s;
}

function upsertSrmRows_(ss, date, items) {
  var s = getSrmSheet_(ss);
  // Migrate legacy Date-object cells in col A so deleteRowsByDate_ can match.
  normalizeDateColumnSrm_(s);
  deleteRowsByDate_(s, date, 2);
  var eng={1:"Just present",2:"Actively involved",3:"Very stimulating"};
  // Avoid appendRow (auto-coerces "yyyy-MM-dd" to Date). Write as a block.
  if(items.length){
    var startRow = Math.max(2, s.getLastRow() + 1);
    var rows = items.map(function(it){
      return [
        date, it.id||"", it.time||"", it.am?"AM":"PM",
        it.didNot?"Yes":"No", it.withOthers?"Yes":"No",
        (it.who||[]).join(", "), it.whoText||"",
        it.engagement?(eng[it.engagement]||String(it.engagement)):""
      ];
    });
    s.getRange(startRow, 1, rows.length, 1).setNumberFormat("@");
    s.getRange(startRow, 1, rows.length, 9).setValues(rows);
    // Re-assert date col as text on the newly written cells.
    for(var i=0;i<rows.length;i++) s.getRange(startRow+i, 1).setValue(date);
  }
  var lr=s.getLastRow();
  if(lr>2) s.getRange(2,1,lr-1,9).sort({column:1,ascending:true});
}

function normalizeDateColumnSrm_(s) {
  var lr = s.getLastRow();
  if (lr < 2) return;
  var range = s.getRange(2, 1, lr - 1, 1);
  var vals = range.getValues();
  var changed = false;
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i][0];
    if (Object.prototype.toString.call(v) === "[object Date]") {
      vals[i][0] = normalizeDateKey_(v);
      changed = true;
    }
  }
  if (changed) {
    range.setNumberFormat("@");
    range.setValues(vals);
  }
}

function deleteSrmRows_(ss, date) {
  var s=ss.getSheetByName("Rhythm Log");
  if(!s)return;
  deleteRowsByDate_(s,date,2);
}

function readSrm_(ss) {
  var s=ss.getSheetByName("Rhythm Log");
  if(!s||s.getLastRow()<2) return {};
  var vals=s.getRange(2,1,s.getLastRow()-1,9).getValues();
  var out={};
  var engMap={"Just present":1,"Actively involved":2,"Very stimulating":3};
  vals.forEach(function(r){
    var dt=normalizeDateKey_(r[0]);
    if(!dt)return;
    if(!out[dt])out[dt]={items:[]};
    out[dt].items.push({
      id:r[1]||"",time:r[2]||"",am:r[3]==="AM",
      didNot:r[4]==="Yes",withOthers:r[5]==="Yes",
      who:r[6]?String(r[6]).split(", ").filter(Boolean):[],
      whoText:r[7]||"",engagement:engMap[r[8]]||0
    });
  });
  return out;
}


/* ═══════════════════ SETTINGS ═══════════════════ */

function getSettingsSheet_(ss) {
  var s = ss.getSheetByName("Settings");
  if (!s) {
    s = ss.insertSheet("Settings");
    s.appendRow(["Key", "Value"]);
    s.getRange("1:1").setFontWeight("bold").setBackground("#F5F0E8").setFontFamily("Arial").setFontSize(9);
    s.setFrozenRows(1);
    s.setColumnWidth(1, 120);
    s.setColumnWidth(2, 600);
  }
  return s;
}

function upsertSettings_(ss, settings, meds) {
  var s = getSettingsSheet_(ss);
  upsertKV_(s, "settings", JSON.stringify(settings));
  upsertKV_(s, "meds", JSON.stringify(meds));
}

function readSettings_(ss) {
  var s = ss.getSheetByName("Settings");
  if (!s || s.getLastRow() < 2) return {settings: null, meds: null};
  var vals = s.getRange(2, 1, s.getLastRow() - 1, 2).getValues();
  var out = {settings: null, meds: null};
  vals.forEach(function(r) {
    var key = String(r[0]).trim();
    var val = String(r[1]).trim();
    if (!key || !val) return;
    try {
      if (key === "settings") out.settings = JSON.parse(val);
      if (key === "meds") out.meds = JSON.parse(val);
    } catch(e) {}
  });
  return out;
}

function upsertKV_(sheet, key, value) {
  var lr = sheet.getLastRow();
  for (var i = 2; i <= lr; i++) {
    if (String(sheet.getRange(i, 1).getValue()).trim() === key) {
      sheet.getRange(i, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}


/* ═══════════════════ PUSH NOTIFICATIONS — smart, reactive ═══════════════════
   Two scheduled nudge slots per Wei-day (6 AM cutoff):
     • Noon (12:00 local)  — "morning-notes" framing
     • Midnight (00:00)    — "end-of-day mend" framing

   Adaptive backoff based on days since last log activity:
     0-2 days   → both slots fire
     3-6 days   → midnight slot only
     7+ days    → midnight slot every 3rd Wei-day

   Per-day entry state determines which gentle phrase the SW shows
   (in Phase 2, when payloads are encrypted). For now the SW always
   shows a generic gentle phrase but the audience routing is correct.

   Audience routing:
     "primary" subscriptions (Wei's devices)   → soft personal nudge
     "caretaker" subscriptions (Cuixi etc.)    → "Wei hasn't logged today" prompt

   Subscription rows (Push Subscriptions sheet):
     A: Endpoint   B: p256dh   C: auth   D: Created   E: LastSent
     F: Role ("primary"|"caretaker")     G: Actor (free-text label)

   Log Activity sheet:
     A: Timestamp (server time)   B: EntryDate (yyyy-MM-dd)
     C: Actor (Wei|Cuixi|Other)   D: Type (mood|srm|delete_mood|delete_srm)

   Script Properties required:
     WORKER_URL     https://mootracker-push.<handle>.workers.dev/send
     SHARED_SECRET  matches Worker's SHARED_SECRET
*/

var WEI_DAY_OFFSET_HOURS = 6; // Wei's day starts at 6 AM local (so 1 AM is "yesterday")
var DEFAULT_ROLE = "primary";

function sanitizeRole_(v) {
  var s = String(v || "").trim().toLowerCase();
  return (s === "caretaker") ? "caretaker" : "primary";
}

function sanitizeActor_(v) {
  var s = String(v == null ? "" : v).trim();
  return s ? s.slice(0, 60) : "Wei";
}
function sanitizeTz_(v) {
  return String(v || "").trim().slice(0, 60);
}

// Wei-day-of-week date string for any Date (or now). Shifts by -6h before
// formatting so 2 AM local maps to yesterday's date.
function weiDateKey_(d, tz) {
  var when = d || new Date();
  var shifted = new Date(when.getTime() - WEI_DAY_OFFSET_HOURS * 3600 * 1000);
  return Utilities.formatDate(shifted, tz, "yyyy-MM-dd");
}
function nowHmInTz_(tz, fallbackTz) {
  try {
    var now = new Date();
    var hh = parseInt(Utilities.formatDate(now, tz, "H"), 10);
    var mm = parseInt(Utilities.formatDate(now, tz, "m"), 10);
    if (isNaN(hh) || isNaN(mm)) throw new Error("bad tz");
    return { hh: hh, mm: mm };
  } catch (_) {
    var n = new Date();
    return {
      hh: parseInt(Utilities.formatDate(n, fallbackTz, "H"), 10),
      mm: parseInt(Utilities.formatDate(n, fallbackTz, "m"), 10)
    };
  }
}

/* ─── Push Subscriptions sheet ─── */

function getPushSheet_(ss) {
  var s = ss.getSheetByName("Push Subscriptions");
  if (!s) {
    s = ss.insertSheet("Push Subscriptions");
    s.appendRow(["Endpoint", "p256dh", "auth", "Created", "LastSent", "Role", "Actor", "Tz"]);
    s.getRange("1:1").setFontWeight("bold").setBackground("#F5F0E8").setFontFamily("Arial").setFontSize(9);
    s.setFrozenRows(1);
    s.setColumnWidth(1, 320); s.setColumnWidth(2, 220); s.setColumnWidth(3, 160);
    s.setColumnWidth(6, 90);  s.setColumnWidth(7, 110); s.setColumnWidth(8, 120);
  } else {
    // Backfill missing Role / Actor / Tz columns on legacy sheets so callers can rely on the layout.
    var lastCol = s.getLastColumn();
    var headers = lastCol > 0 ? s.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    var roleIdx = headers.indexOf("Role");
    var actorIdx = headers.indexOf("Actor");
    var tzIdx = headers.indexOf("Tz");
    if (roleIdx < 0) { s.getRange(1, lastCol + 1).setValue("Role").setFontWeight("bold").setBackground("#F5F0E8"); s.setColumnWidth(lastCol + 1, 90); lastCol++; }
    if (actorIdx < 0) { s.getRange(1, lastCol + 1).setValue("Actor").setFontWeight("bold").setBackground("#F5F0E8"); s.setColumnWidth(lastCol + 1, 110); lastCol++; }
    if (tzIdx < 0) { s.getRange(1, lastCol + 1).setValue("Tz").setFontWeight("bold").setBackground("#F5F0E8"); s.setColumnWidth(lastCol + 1, 120); }
  }
  return s;
}

function _pushSheetColIndexes_(s) {
  var headers = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  return {
    endpoint: headers.indexOf("Endpoint") + 1,
    p256dh:   headers.indexOf("p256dh") + 1,
    auth:     headers.indexOf("auth") + 1,
    created:  headers.indexOf("Created") + 1,
    lastSent: headers.indexOf("LastSent") + 1,
    role:     headers.indexOf("Role") + 1,
    actor:    headers.indexOf("Actor") + 1,
    tz:       headers.indexOf("Tz") + 1,
  };
}

function upsertPushSubscription_(ss, sub, role, actor, tz) {
  if (!sub || !sub.endpoint) return;
  var s = getPushSheet_(ss);
  var cols = _pushSheetColIndexes_(s);
  var p256dh = (sub.keys && sub.keys.p256dh) || "";
  var auth = (sub.keys && sub.keys.auth) || "";
  var roleClean = sanitizeRole_(role);
  var actorClean = sanitizeActor_(actor);
  var tzClean = sanitizeTz_(tz);

  var lr = s.getLastRow();
  if (lr >= 2 && cols.endpoint > 0) {
    var endpoints = s.getRange(2, cols.endpoint, lr - 1, 1).getValues();
    for (var i = 0; i < endpoints.length; i++) {
      if (String(endpoints[i][0]).trim() === sub.endpoint) {
        var row = i + 2;
        if (cols.p256dh) s.getRange(row, cols.p256dh).setValue(p256dh);
        if (cols.auth) s.getRange(row, cols.auth).setValue(auth);
        if (cols.role) s.getRange(row, cols.role).setValue(roleClean);
        if (cols.actor) s.getRange(row, cols.actor).setValue(actorClean);
        if (cols.tz) s.getRange(row, cols.tz).setValue(tzClean);
        return;
      }
    }
  }
  // Append in the column order from the header row to survive any reordering.
  var n = s.getLastColumn();
  var newRow = new Array(n).fill("");
  if (cols.endpoint) newRow[cols.endpoint - 1] = sub.endpoint;
  if (cols.p256dh)   newRow[cols.p256dh   - 1] = p256dh;
  if (cols.auth)     newRow[cols.auth     - 1] = auth;
  if (cols.created)  newRow[cols.created  - 1] = new Date();
  if (cols.role)     newRow[cols.role     - 1] = roleClean;
  if (cols.actor)    newRow[cols.actor    - 1] = actorClean;
  if (cols.tz)       newRow[cols.tz       - 1] = tzClean;
  s.appendRow(newRow);
}

function updatePushSubscriptionRole_(ss, endpoint, role, actor, tz) {
  if (!endpoint) return;
  var s = ss.getSheetByName("Push Subscriptions");
  if (!s) return;
  s = getPushSheet_(ss); // ensures Role/Actor columns exist
  var cols = _pushSheetColIndexes_(s);
  var lr = s.getLastRow();
  if (lr < 2 || !cols.endpoint) return;
  var endpoints = s.getRange(2, cols.endpoint, lr - 1, 1).getValues();
  var roleClean = sanitizeRole_(role);
  var actorClean = sanitizeActor_(actor);
  var tzClean = sanitizeTz_(tz);
  for (var i = 0; i < endpoints.length; i++) {
    if (String(endpoints[i][0]).trim() === endpoint) {
      var row = i + 2;
      if (cols.role) s.getRange(row, cols.role).setValue(roleClean);
      if (cols.actor && actor) s.getRange(row, cols.actor).setValue(actorClean);
      if (cols.tz && tzClean) s.getRange(row, cols.tz).setValue(tzClean);
      return;
    }
  }
}

function updatePushSubscriptionTz_(ss, endpoint, tz, actor) {
  if (!endpoint) return;
  var s = ss.getSheetByName("Push Subscriptions");
  if (!s) return;
  s = getPushSheet_(ss);
  var cols = _pushSheetColIndexes_(s);
  var lr = s.getLastRow();
  if (lr < 2 || !cols.endpoint || !cols.tz) return;
  var endpoints = s.getRange(2, cols.endpoint, lr - 1, 1).getValues();
  var tzClean = sanitizeTz_(tz);
  var actorClean = sanitizeActor_(actor);
  for (var i = 0; i < endpoints.length; i++) {
    if (String(endpoints[i][0]).trim() === endpoint) {
      var row = i + 2;
      s.getRange(row, cols.tz).setValue(tzClean);
      if (cols.actor && actor) s.getRange(row, cols.actor).setValue(actorClean);
      return;
    }
  }
}

function deletePushSubscription_(ss, endpoint) {
  if (!endpoint) return;
  var s = ss.getSheetByName("Push Subscriptions");
  if (!s) return;
  var lr = s.getLastRow();
  if (lr < 2) return;
  var endpoints = s.getRange(2, 1, lr - 1, 1).getValues();
  for (var i = endpoints.length - 1; i >= 0; i--) {
    if (String(endpoints[i][0]).trim() === endpoint) s.deleteRow(i + 2);
  }
}

function listPushSubscriptions_(ss) {
  var s = ss.getSheetByName("Push Subscriptions");
  if (!s || s.getLastRow() < 2) return [];
  var fallbackTz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  // Make sure newer columns exist for legacy sheets without breaking anything.
  s = getPushSheet_(ss);
  var cols = _pushSheetColIndexes_(s);
  if (!cols.endpoint) return [];
  var lr = s.getLastRow();
  var n = s.getLastColumn();
  var vals = s.getRange(2, 1, lr - 1, n).getValues();
  return vals.map(function(r){
    var endpoint = String(r[cols.endpoint - 1] || "").trim();
    if (!endpoint) return null;
    var p = cols.p256dh ? String(r[cols.p256dh - 1] || "").trim() : "";
    var a = cols.auth ? String(r[cols.auth - 1] || "").trim() : "";
    var role = cols.role ? sanitizeRole_(r[cols.role - 1]) : DEFAULT_ROLE;
    var actor = cols.actor ? sanitizeActor_(r[cols.actor - 1]) : "Wei";
    var subTz = cols.tz ? sanitizeTz_(r[cols.tz - 1]) : "";
    if (!subTz) subTz = fallbackTz;
    return { endpoint: endpoint, keys: { p256dh: p, auth: a }, role: role, actor: actor, tz: subTz };
  }).filter(Boolean);
}

/* ─── Log Activity sheet ─── */

function getLogActivitySheet_(ss) {
  var s = ss.getSheetByName("Log Activity");
  if (!s) {
    s = ss.insertSheet("Log Activity");
    s.appendRow(["Timestamp", "EntryDate", "Actor", "Type"]);
    s.getRange("1:1").setFontWeight("bold").setBackground("#F5F0E8").setFontFamily("Arial").setFontSize(9);
    s.setFrozenRows(1);
    s.setColumnWidth(1, 160); s.setColumnWidth(2, 100); s.setColumnWidth(3, 100); s.setColumnWidth(4, 100);
  }
  return s;
}

function recordLogActivity_(ss, entryDate, actor, type) {
  var s = getLogActivitySheet_(ss);
  s.appendRow([new Date(), entryDate || "", sanitizeActor_(actor), type || ""]);
}

// Returns an array of {ts:Date, entryDate:string, actor:string, type:string} for the last N rows.
function readRecentLogActivity_(ss, limit) {
  var s = ss.getSheetByName("Log Activity");
  if (!s || s.getLastRow() < 2) return [];
  var lr = s.getLastRow();
  var start = Math.max(2, lr - (limit || 200) + 1);
  var vals = s.getRange(start, 1, lr - start + 1, 4).getValues();
  return vals.map(function(r){
    var ts = (Object.prototype.toString.call(r[0]) === "[object Date]") ? r[0] : null;
    return { ts: ts, entryDate: String(r[1] || "").trim(), actor: String(r[2] || "").trim(), type: String(r[3] || "").trim() };
  });
}

/* ─── State machine for a given Wei-day ─── */

// Reads the Mood Log row for `weiToday` and classifies it: empty | partial | complete.
// "Partial" = there is data (sleep, anxiety, irritability, notes, or meds count > 0)
// but no mood. "Complete" = any mood value present.
function weiDayEntryState_(ss, weiToday) {
  var s = ss.getSheetByName("Mood Log");
  if (!s) return "empty";
  var settingsData = readSettings_(ss);
  var layout = getMoodLayout_(s, settingsData.meds || []);
  if (!layout) return "empty";
  var lr = s.getLastRow();
  if (lr < layout.dataStartRow) return "empty";

  var row = findDateRow_(s, weiToday, layout.dataStartRow);
  if (row < 0) return "empty";

  var vals = s.getRange(row, 1, 1, layout.weightCol).getValues()[0];

  // Mood = any of the 7 mood columns has "X".
  var hasMood = false;
  layout.moods.forEach(function(mc){
    if (mc.col > 0 && String(vals[mc.col - 1]).trim().toUpperCase() === "X") hasMood = true;
  });
  if (hasMood) return "complete";

  var hasNotes = String(vals[layout.notesCol - 1] || "").trim() !== "";
  var hasSleep = vals[layout.sleepCol - 1] !== "" && vals[layout.sleepCol - 1] != null;
  var hasIrr   = vals[layout.irrCol   - 1] !== "" && vals[layout.irrCol   - 1] != null;
  var hasAnx   = vals[layout.anxCol   - 1] !== "" && vals[layout.anxCol   - 1] != null;
  var hasMeds = false;
  layout.meds.forEach(function(mc){
    var raw = vals[mc.col - 1];
    if (raw === "" || raw == null) return;
    if (Number(raw) > 0) hasMeds = true;
    else if (/^\d+\s*[x×]/i.test(String(raw))) hasMeds = true;
  });
  if (hasNotes || hasSleep || hasIrr || hasAnx || hasMeds) return "partial";
  return "empty";
}

// Was there a save-then-delete for weiToday?
function weiDayWasDeleted_(activity, weiToday) {
  var saved = false, deleted = false;
  activity.forEach(function(a){
    if (a.entryDate !== weiToday) return;
    if (a.type === "mood" || a.type === "srm") saved = true;
    else if (a.type === "delete_mood" || a.type === "delete_srm") deleted = true;
  });
  return saved && deleted;
}

// Counts distinct Wei-days with at least one mood/srm save BY WEI in the rolling
// 7-Wei-day window ending at weiTodayStr (inclusive). Uses the save event's
// timestamp shifted into Wei-day, so a backfill of an old date today still
// counts as today's engagement. Actor-filtered to Wei so the caretaker line
// "Wei's week: N of 7 days noted" reflects Wei's own logging, not Cuixi's edits.
function countDistinctWeiDaysInWeek_(activity, tz, weiTodayStr) {
  var todayMs = Date.parse(weiTodayStr + "T12:00:00Z");
  var weekStartMs = todayMs - 6 * 86400000;
  var days = {};
  activity.forEach(function(a){
    if (a.type !== "mood" && a.type !== "srm") return;
    if (a.actor !== "Wei") return;
    if (!a.ts) return;
    var wd = weiDateKey_(a.ts, tz);
    var wdMs = Date.parse(wd + "T12:00:00Z");
    if (wdMs >= weekStartMs && wdMs <= todayMs) days[wd] = true;
  });
  return Object.keys(days).length;
}

// True if the given yyyy-MM-dd is a Sunday in calendar terms. Wei-day spans
// 6 AM → 6 AM in local time but is keyed by the calendar date of its start.
function weiDateIsSunday_(weiDateStr) {
  var parts = weiDateStr.split("-").map(Number);
  // new Date(y, m, d) in script runtime; Sunday = 0
  return new Date(parts[0], parts[1] - 1, parts[2]).getDay() === 0;
}

// Days (in Wei-days) since the last save event landed on the server,
// regardless of which date the entry was FOR. Backfilling old entries still
// counts as recent engagement — the goal is "has anyone been touching the
// system?" not "are recent dates filled in."
function daysSinceLastLog_(activity, tz, weiTodayStr) {
  var latestTs = null;
  for (var i = activity.length - 1; i >= 0; i--) {
    if ((activity[i].type === "mood" || activity[i].type === "srm") && activity[i].ts) {
      latestTs = activity[i].ts;
      break;
    }
  }
  if (!latestTs) return Infinity;
  var lastWeiDay = weiDateKey_(latestTs, tz);
  function parse(d) { var p = d.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]).getTime(); }
  var a = parse(lastWeiDay);
  var b = parse(weiTodayStr);
  if (isNaN(a) || isNaN(b)) return Infinity;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/* ─── Smart reminder trigger ─── */

// 1-minute trigger entry point. Function name kept (sendDueReminders) so the
// existing trigger doesn't need re-binding.
function sendDueReminders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var subs = listPushSubscriptions_(ss);
  if (!subs.length) return;

  var buckets = { noon: [], midnight: [], "noon:1": [], "noon:2": [], "noon:3": [], "midnight:1": [], "midnight:2": [], "midnight:3": [] };
  var anySlot = false;
  subs.forEach(function(sub){
    var t = nowHmInTz_(sub.tz, tz);
    var slot = slotForLocalTime_(t.hh, t.mm);
    if (slot) { buckets[slot].push(sub); anySlot = true; }
  });

  // Hoist expensive spreadsheet reads once per invocation so that multiple
  // fire*Slot_ calls (common when subscribers span timezones) reuse them
  // instead of each reading the sheet independently.
  // Only read when at least one slot matched or wildcards might fire.
  var shared = {};
  if (anySlot) {
    shared.weiToday  = weiDateKey_(new Date(), tz);
    shared.state     = weiDayEntryState_(ss, shared.weiToday);
    shared.activity  = readRecentLogActivity_(ss, 200);
  }

  if (buckets.noon.length) fireSmartSlot_(ss, "noon", tz, { subs: buckets.noon, weiToday: shared.weiToday, state: shared.state, activity: shared.activity });
  if (buckets.midnight.length) fireSmartSlot_(ss, "midnight", tz, { subs: buckets.midnight, weiToday: shared.weiToday, state: shared.state, activity: shared.activity });
  ["noon:1","noon:2","noon:3","midnight:1","midnight:2","midnight:3"].forEach(function(k){
    if (buckets[k].length) {
      var parts = k.split(":");
      fireResurfaceSlot_(ss, parts[0], tz, parseInt(parts[1], 10), { subs: buckets[k], weiToday: shared.weiToday, state: shared.state, activity: shared.activity });
    }
  });

  // eslint-disable-next-line no-undef
  var props = PropertiesService.getScriptProperties();
  var now = new Date();
  subs.forEach(function(sub){
    if (sub.role === "caretaker") return;
    var subTz = sub.tz || tz;
    var nextKey = "wildcard:nextFireAt:" + sub.endpoint.slice(0, 80);
    var nextFireAt = props.getProperty(nextKey);
    var planned = nextFireAt ? new Date(nextFireAt) : null;
    if (!planned || isNaN(planned.getTime())) {
      props.setProperty(nextKey, computeNextWildcardFire_(sub, subTz, now).toISOString());
      return;
    }
    if (now.getTime() < planned.getTime()) return;
    // Reuse shared reads if available (weiToday is in spreadsheet tz, same
    // for wildcard regardless of subscriber tz).
    fireWildcardSlot_(ss, subTz, { subs: [sub], weiToday: shared.weiToday, state: shared.state, activity: shared.activity });
    props.setProperty(nextKey, computeNextWildcardFire_(sub, subTz, now).toISOString());
  });
}

function slotForLocalTime_(hh, mm) {
  // Widen each window to 5 minutes so Apps Script trigger drift does not
  // silently miss a slot. Per-sub dedup prevents repeated fires that day.
  if (hh === 12 && mm < 5) return "noon";
  if (hh === 0 && mm < 5) return "midnight";
  if (hh === 12 && mm >= 15 && mm < 20) return "noon:1";
  if (hh === 12 && mm >= 45 && mm < 50) return "noon:2";
  if (hh === 13 && mm >= 30 && mm < 35) return "noon:3";
  if (hh === 0 && mm >= 15 && mm < 20) return "midnight:1";
  if (hh === 0 && mm >= 45 && mm < 50) return "midnight:2";
  if (hh === 1 && mm >= 30 && mm < 35) return "midnight:3";
  return null;
}

function fireSmartSlot_(ss, slot, tz, opts) {
  opts = opts || {};
  var weiToday = opts.weiToday || weiDateKey_(new Date(), tz);
  var state = (opts.state !== undefined) ? opts.state : weiDayEntryState_(ss, weiToday);
  if (state === "complete" && !opts.force) {
    Logger.log("Smart reminder %s: weiToday=%s is complete, skipping all", slot, weiToday);
    return { skipped: "complete" };
  }

  var activity = opts.activity || readRecentLogActivity_(ss, 200);
  var daysSince = daysSinceLastLog_(activity, tz, weiToday);
  var wasDeleted = weiDayWasDeleted_(activity, weiToday);

  // Adaptive backoff. The noon slot is skipped when Wei has been silent
  // for 3+ days; midnight always runs (subject to the 7+ day every-third rule).
  if (!opts.force) {
    if (slot === "noon" && daysSince >= 3) {
      Logger.log("Smart reminder noon: daysSince=%s, suppressing noon slot", daysSince);
      return { skipped: "backoff_noon" };
    }
    if (slot === "midnight" && daysSince >= 7) {
      // Only fire every 3rd Wei-day. Use the day-number modulo 3.
      var dayNum = Math.floor(new Date(weiToday).getTime() / 86400000);
      if (dayNum % 3 !== 0) {
        Logger.log("Smart reminder midnight: daysSince=%s, skipping (every-3rd)", daysSince);
        return { skipped: "backoff_long" };
      }
    }
  }

  var subs = opts.subs || listPushSubscriptions_(ss);
  if (!subs.length) return { skipped: "no_subs" };

  // Weekly count: distinct Wei-days with any save event in the rolling
  // 7-Wei-day window ending today. Reuses the same activity rows already
  // fetched for daysSince and wasDeleted (just a different aggregation).
  var weeklyCount = countDistinctWeiDaysInWeek_(activity, tz, weiToday);
  // Sunday-end-of-week flag: only the midnight slot of Wei's Sunday gets the
  // reflective framing.
  var isWeiSunday = weiDateIsSunday_(weiToday);

  var stateForPhrase = (state === "partial") ? "partial" : (wasDeleted ? "deleted" : "empty");
  var primaryBody = pickPrimaryPhrase_(slot, stateForPhrase, weeklyCount, isWeiSunday);
  var caretakerBody = pickCaretakerPhrase_(slot, weeklyCount, isWeiSunday);

  var props = PropertiesService.getScriptProperties();
  var tag = resurfaceTag_(slot, weiToday);
  var results = { primary: 0, caretaker: 0, skipped: 0, slot: slot, state: stateForPhrase, weiToday: weiToday, daysSince: daysSince, weeklyCount: weeklyCount, isWeiSunday: isWeiSunday, forced: !!opts.force };

  subs.forEach(function(sub){
    var dedupeKey = "nudged:" + slot + ":" + sub.role + ":" + sub.endpoint.slice(0, 80);
    if (!opts.force && props.getProperty(dedupeKey) === weiToday) { results.skipped++; return; }
    var body = (sub.role === "caretaker") ? caretakerBody : primaryBody;
    var res = sendPushViaWorker_(sub, { title: "MooTracker", body: body, url: "/#log/today" }, tag);
    if (res && res.ok) {
      props.setProperty(dedupeKey, weiToday);
      if (sub.role === "caretaker") results.caretaker++; else results.primary++;
    }
  });

  Logger.log("Smart reminder %s fired: %s", slot, JSON.stringify(results));
  return results;
}

function fireResurfaceSlot_(ss, slot, tz, step, opts) {
  opts = opts || {};
  var weiToday = opts.weiToday || weiDateKey_(new Date(), tz);
  var state = (opts.state !== undefined) ? opts.state : weiDayEntryState_(ss, weiToday);
  if (state === "complete") {
    Logger.log("Smart reminder resurface %s step %s: weiToday=%s is complete, skipping all", slot, step, weiToday);
    return { skipped: "complete" };
  }

  var subs = opts.subs || listPushSubscriptions_(ss);
  if (!subs.length) return { skipped: "no_subs" };

  var activity = opts.activity || readRecentLogActivity_(ss, 200);
  var wasDeleted = weiDayWasDeleted_(activity, weiToday);
  var weeklyCount = countDistinctWeiDaysInWeek_(activity, tz, weiToday);
  var isWeiSunday = weiDateIsSunday_(weiToday);
  var stateForPhrase = (state === "partial") ? "partial" : (wasDeleted ? "deleted" : "empty");
  var primaryBody = pickPrimaryPhrase_(slot, stateForPhrase, weeklyCount, isWeiSunday);
  var caretakerBody = pickCaretakerPhrase_(slot, weeklyCount, isWeiSunday);
  var tag = resurfaceTag_(slot, weiToday);
  var props = PropertiesService.getScriptProperties();
  var results = { primary: 0, caretaker: 0, skipped: 0, slot: slot, step: step, state: stateForPhrase, weiToday: weiToday, weeklyCount: weeklyCount, isWeiSunday: isWeiSunday };

  subs.forEach(function(sub){
    var originalKey = "nudged:" + slot + ":" + sub.role + ":" + sub.endpoint.slice(0, 80);
    if (props.getProperty(originalKey) !== weiToday) { results.skipped++; return; }
    var resurfaceKey = originalKey + ":resurface" + step;
    if (props.getProperty(resurfaceKey) === weiToday) { results.skipped++; return; }
    var body = (sub.role === "caretaker") ? caretakerBody : primaryBody;
    var res = sendPushViaWorker_(sub, { title: "MooTracker", body: body, url: "/#log/today" }, tag);
    if (res && res.ok) {
      props.setProperty(resurfaceKey, weiToday);
      if (sub.role === "caretaker") results.caretaker++; else results.primary++;
    }
  });

  Logger.log("Smart reminder resurface %s step %s fired: %s", slot, step, JSON.stringify(results));
  return results;
}

function resurfaceTag_(slot, weiDateKey) {
  return "mootracker:" + slot + ":" + weiDateKey;
}

function fireWildcardSlot_(ss, tz, opts) {
  opts = opts || {};
  var weiToday = opts.weiToday || weiDateKey_(new Date(), tz);
  var state = (opts.state !== undefined) ? opts.state : weiDayEntryState_(ss, weiToday);
  if (state === "complete") {
    // eslint-disable-next-line no-undef
    Logger.log("Smart reminder wildcard: weiToday=%s is complete, skipping all", weiToday);
    return { skipped: "complete" };
  }

  var subs = (opts.subs || listPushSubscriptions_(ss)).filter(function(sub){
    return sub.role !== "caretaker";
  });
  if (!subs.length) return { skipped: "no_subs" };

  var activity = opts.activity || readRecentLogActivity_(ss, 200);
  var weeklyCount = countDistinctWeiDaysInWeek_(activity, tz, weiToday);
  var toneBranch = wildcardToneBranch_(weeklyCount);
  var body = pickWildcardPhrase_(weeklyCount);
  var tag = resurfaceTag_("wildcard", weiToday);
  // eslint-disable-next-line no-undef
  var props = PropertiesService.getScriptProperties();
  var results = { primary: 0, skipped: 0, slot: "wildcard", weiToday: weiToday, weeklyCount: weeklyCount, toneBranch: toneBranch };

  subs.forEach(function(sub){
    var dedupeKey = "nudged:wildcard:" + sub.endpoint.slice(0, 80) + ":" + weiToday;
    if (props.getProperty(dedupeKey) === weiToday) { results.skipped++; return; }
    var res = sendPushViaWorker_(sub, { title: "MooTracker", body: body, url: "/#log/today" }, tag);
    if (res && res.ok) {
      props.setProperty(dedupeKey, weiToday);
      results.primary++;
      // eslint-disable-next-line no-undef
      Logger.log(JSON.stringify({ slot: "wildcard", weiToday: weiToday, weeklyCount: weeklyCount, toneBranch: toneBranch, endpoint: sub.endpoint.slice(0, 40) }));
    }
  });

  // eslint-disable-next-line no-undef
  Logger.log("Smart reminder wildcard fired: %s", JSON.stringify(results));
  return results;
}

function computeNextWildcardFire_(sub, tz, now) {
  // Instead of storing a full weekly schedule, each successful or initialized
  // wildcard schedules the next one 3-7 days out. That keeps cadence at roughly
  // 1-2 fires per rolling week while preserving randomness per device.
  var firesPerWeek = Math.floor(Math.random() * 2) + 1;
  var minMs = (firesPerWeek === 2 ? 3 : 5) * 86400000;
  var maxMs = (firesPerWeek === 2 ? 4 : 7) * 86400000;
  var start = now || new Date();
  var targetMs = start.getTime() + minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  // eslint-disable-next-line no-undef
  var localTarget = Utilities.formatDate(new Date(targetMs), tz, "yyyy-MM-dd");
  var p = localTarget.split("-").map(Number);
  var afternoon = Math.random() < 0.5;
  var hour = afternoon ? (15 + Math.floor(Math.random() * 3)) : (20 + Math.floor(Math.random() * 2));
  var minute = Math.floor(Math.random() * 60);
  var localFire = dateFromLocalParts_(p[0], p[1], p[2], hour, minute, tz);
  if (localFire.getTime() < start.getTime() + minMs) {
    localFire = dateFromLocalParts_(p[0], p[1], p[2] + 1, hour, minute, tz);
  }
  if (localFire.getTime() > start.getTime() + maxMs) {
    localFire = dateFromLocalParts_(p[0], p[1], p[2] - 1, hour, minute, tz);
  }
  var localParts = localPartsInTz_(localFire, tz);
  if (slotForLocalTime_(localParts.hh, localParts.mm)) {
    localFire = dateFromLocalParts_(localParts.y, localParts.m, localParts.d, localParts.hh, localParts.mm + 10, tz);
  }
  return localFire;
}

function localPartsInTz_(date, tz) {
  return {
    // eslint-disable-next-line no-undef
    y: parseInt(Utilities.formatDate(date, tz, "yyyy"), 10),
    // eslint-disable-next-line no-undef
    m: parseInt(Utilities.formatDate(date, tz, "M"), 10),
    // eslint-disable-next-line no-undef
    d: parseInt(Utilities.formatDate(date, tz, "d"), 10),
    // eslint-disable-next-line no-undef
    hh: parseInt(Utilities.formatDate(date, tz, "H"), 10),
    // eslint-disable-next-line no-undef
    mm: parseInt(Utilities.formatDate(date, tz, "m"), 10)
  };
}

function dateFromLocalParts_(y, m, d, hh, mm, tz) {
  var guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  // eslint-disable-next-line no-undef
  var rendered = Utilities.formatDate(guess, tz, "yyyy-MM-dd'T'HH:mm:ss");
  var renderedAsUtc = new Date(rendered + "Z");
  return new Date(guess.getTime() - (renderedAsUtc.getTime() - guess.getTime()));
}

/* ─── Phrase pools (Phase 1: empty-payload, so SW shows whatever we send here) ─── */

// Caretaker-only suffix. Returns " · N this week" when weeklyCount >= 1 and
// "" when 0. Wei-facing pushes avoid routine status counts except the Sunday
// midnight reflection.
function weeklyCountSuffix_(weeklyCount) {
  var n = Number(weeklyCount) || 0;
  if (n < 1) return "";
  return " · " + n + " this week";
}

function pickPrimaryPhrase_(slot, state, weeklyCount, isWeiSunday) {
  var noonEmpty = [
    "How was this morning?",
    "Anything from today so far?",
    "Just a soft check-in.",
    "What's on your mind?",
    "MooTracker is here when you want.",
  ];
  var noonPartial = [
    "You started a note — anything to add?",
    "Want to fill in the rest when ready?",
  ];
  var noonDeleted = [
    "Still here when you want to revisit today.",
  ];
  var midEmpty = [
    "How's the day landing?",
    "Anything to note before sleep?",
    "Soft check-in — only if you want.",
    "One word counts.",
  ];
  var midPartial = [
    "Anything else from today?",
    "Want to round out today's note?",
  ];
  var midDeleted = [
    "Today's still open if you want to come back.",
  ];

  // End-of-week framing: only on Wei's Sunday midnight slot, mix in
  // weekly-reflection phrasing. Active only when there's a count to lean on.
  var sundayMid = [
    "How did the week feel?",
    "End of week — anything to capture?",
    "Anything to note before tomorrow?",
  ];

  var pool;
  if (slot === "noon") {
    pool = (state === "partial") ? noonPartial : (state === "deleted") ? noonDeleted : noonEmpty;
  } else {
    var base = (state === "partial") ? midPartial : (state === "deleted") ? midDeleted : midEmpty;
    pool = (isWeiSunday && Number(weeklyCount) >= 1 && state !== "partial" && state !== "deleted")
      ? base.concat(sundayMid)
      : base;
  }
  var body = pool[Math.floor(Math.random() * pool.length)];
  // Sunday midnight with stat: use the "X days logged this week" phrasing instead of the
  // generic suffix for a more reflective tone.
  if (slot === "midnight" && isWeiSunday && Number(weeklyCount) >= 1 && sundayMid.indexOf(body) >= 0) {
    var n = Number(weeklyCount);
    return body + " · " + n + " day" + (n === 1 ? "" : "s") + " logged this week";
  }
  return body;
}

function wildcardToneBranch_(weeklyCount) {
  var n = Number(weeklyCount) || 0;
  if (n >= 5) return "high";
  if (n >= 2) return "mid";
  return "low";
}

function pickWildcardPhrase_(weeklyCount) {
  var n = Number(weeklyCount) || 0;
  var high = [
    "{n} days logged this week. Moo.",
    "You've been checking in. Nice.",
    "That's a steady week of check-ins.",
    "{n} days captured this week.",
  ];
  var mid = [
    "Mid-week check-in — anything on your mind?",
    "How's the week feeling so far?",
    "Anything worth catching while it's fresh?",
    "A quiet check-in, only if useful.",
  ];
  var low = [
    "Thinking of you. No pressure to log.",
    "Here if you want to drop a word.",
    "No agenda — just saying hi.",
    "Only if it helps, MooTracker is open.",
  ];
  var pool = wildcardToneBranch_(n) === "high" ? high : wildcardToneBranch_(n) === "mid" ? mid : low;
  var body = pool[Math.floor(Math.random() * pool.length)];
  return body.replace("{n}", String(n));
}

function pickCaretakerPhrase_(slot, weeklyCount, isWeiSunday) {
  var n = Number(weeklyCount) || 0;
  if (isWeiSunday && slot === "midnight" && n >= 1) {
    return "Wei's week: " + n + " of 7 day" + (n === 1 ? "" : "s") + " noted.";
  }
  var noon = [
    "Wei hasn't logged today yet.",
    "Gentle FYI: no log for today yet.",
  ];
  var mid = [
    "Wei's day is wrapping — no log yet.",
    "Wei hasn't logged today. No urgency.",
  ];
  var pool = (slot === "noon") ? noon : mid;
  var body = pool[Math.floor(Math.random() * pool.length)];
  return n >= 1 ? body + weeklyCountSuffix_(n) : body;
}

/* ─── Push transport (Cloudflare Worker) ─── */

function sendPushViaWorker_(subscription, payload, tag) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("WORKER_URL");
  var secret = props.getProperty("SHARED_SECRET");
  if (!url || !secret) {
    return { ok: false, status: 0, body: "WORKER_URL or SHARED_SECRET missing in script properties" };
  }
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { "X-Auth": secret },
      payload: JSON.stringify({ subscription: { endpoint: subscription.endpoint, keys: subscription.keys }, payload: payload || null, tag: tag || undefined, ttl: 60 }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText().slice(0, 500);
    if (code >= 200 && code < 300) return { ok: true, status: code, body: body };
    Logger.log("Push failed %s: %s", code, body);
    if (code === 404 || code === 410) {
      deletePushSubscription_(SpreadsheetApp.getActiveSpreadsheet(), subscription.endpoint);
    }
    return { ok: false, status: code, body: body };
  } catch (err) {
    Logger.log("Push exception: %s", err);
    return { ok: false, status: 0, body: "exception: " + String(err) };
  }
}

function forwardToD1_(ss, type, date, entry, medsRef, items, settings, meds) {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty("WORKER_URL");
  var secret = props.getProperty("SHARED_SECRET");
  if (!workerUrl || !secret) return;

  var baseUrl = workerUrl.replace(/\/send\/?$/, "");

  if (type === "delete_mood" || type === "delete_srm") {
    try {
      UrlFetchApp.fetch(baseUrl + "/delete", {
        method: "post",
        contentType: "application/json",
        headers: { "X-Auth": secret },
        payload: JSON.stringify({ type: type === "delete_mood" ? "mood" : "srm", date: date }),
        muteHttpExceptions: true
      });
    } catch (e) {
      Logger.log("D1 delete forward failed (non-blocking): %s", String(e));
    }
    return;
  }

  var payload = {};
  if (type === "mood" && date && entry) {
    payload.mood = {};
    payload.mood[date] = entry;
    if (medsRef) payload.meds = medsRef;
  } else if (type === "srm" && date && items) {
    payload.srm = {};
    payload.srm[date] = { items: items };
  } else if (type === "settings" && settings != null) {
    payload.settings = settings;
    if (meds) payload.meds = meds;
  } else {
    return;
  }

  try {
    UrlFetchApp.fetch(baseUrl + "/ingest", {
      method: "post",
      contentType: "application/json",
      headers: { "X-Auth": secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log("D1 forward failed (non-blocking): %s", String(e));
  }
}

/* ─── Debug endpoints ─── */

function debugFirePush_(endpointFilter) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var subs = listPushSubscriptions_(ss);
  var target = String(endpointFilter || "").trim();
  if (target) subs = subs.filter(function(s){ return s.endpoint === target; });
  var results = subs.map(function(sub){
    var r = sendPushViaWorker_(sub, { title: "MooTracker", body: "Test push 🎉" });
    return { endpoint: sub.endpoint.slice(0, 80) + "...", role: sub.role, actor: sub.actor, ok: r.ok, status: r.status, body: r.body };
  });
  return { count: subs.length, scoped: !!target, results: results };
}

function debugForceSmartReminder_(slot, force) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var s = (slot === "noon" || slot === "midnight") ? slot : "midnight";
  return fireSmartSlot_(ss, s, tz, { force: !!force });
}

function debugLogStats_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var weiToday = weiDateKey_(new Date(), tz);
  var s = ss.getSheetByName("Log Activity");

  // Aggregates
  var byActor = {}, total = 0, lastSave = null, lastSaveActor = "";
  // Weekly: count *distinct Wei-days* logged in the rolling 7-day window
  // ending today. "Logged" means at least one mood or srm save attributed
  // to that Wei-day, by anyone. Per-actor counts also count distinct days.
  var weekDays = {}; // {wei-day-key -> Set of actors who logged that day}
  var todayMs = Date.parse(weiToday + "T12:00:00Z");
  var weekStartMs = todayMs - 6 * 86400000;

  if (s && s.getLastRow() >= 2) {
    var vals = s.getRange(2, 1, s.getLastRow() - 1, 4).getValues();
    vals.forEach(function(r){
      var type = String(r[3] || "");
      if (type !== "mood" && type !== "srm") return;
      var actor = String(r[2] || "").trim() || "Wei";
      total++;
      byActor[actor] = (byActor[actor] || 0) + 1;
      if (Object.prototype.toString.call(r[0]) !== "[object Date]") return;
      var ts = r[0];
      if (!lastSave || ts > lastSave) { lastSave = ts; lastSaveActor = actor; }
      var wdKey = weiDateKey_(ts, tz);
      var wdMs = Date.parse(wdKey + "T12:00:00Z");
      if (wdMs >= weekStartMs && wdMs <= todayMs) {
        if (!weekDays[wdKey]) weekDays[wdKey] = {};
        weekDays[wdKey][actor] = true;
      }
    });
  }

  // Convert weekDays to distinct-day counts.
  var weekTotal = Object.keys(weekDays).length;
  var weekByActor = {};
  Object.keys(weekDays).forEach(function(d){
    Object.keys(weekDays[d]).forEach(function(a){
      weekByActor[a] = (weekByActor[a] || 0) + 1;
    });
  });

  return {
    weiToday: weiToday,
    weiDayState: weiDayEntryState_(ss, weiToday),
    totalLogs: total,
    byActor: byActor,
    thisWeek: { distinctDays: weekTotal, byActor: weekByActor },
    lastLog: lastSave ? Utilities.formatDate(lastSave, tz, "yyyy-MM-dd HH:mm") : null,
    lastLogActor: lastSaveActor,
  };
}


/* ═══════════════════ HELPERS ═══════════════════ */

function normalizeDateKey_(v) {
  if (v == null || v === "") return "";
  if (Object.prototype.toString.call(v) === "[object Date]") {
    var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
    return Utilities.formatDate(v, tz, "yyyy-MM-dd");
  }
  return String(v).trim();
}

function normalizeDateColumn_(s, dataStartRow) {
  var start = dataStartRow || 3;
  var lr = s.getLastRow();
  if (lr < start) return;
  var range = s.getRange(start, 1, lr - start + 1, 1);
  var vals = range.getValues();
  var changed = false;
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i][0];
    if (Object.prototype.toString.call(v) === "[object Date]") {
      vals[i][0] = normalizeDateKey_(v);
      changed = true;
    }
  }
  if (changed) {
    range.setNumberFormat("@");
    range.setValues(vals);
  }
}

function findDateRow_(sheet, date, startRow) {
  var lr = sheet.getLastRow();
  if (lr < startRow) return -1;
  var dates = sheet.getRange(startRow, 1, lr - startRow + 1, 1).getValues();
  var target = normalizeDateKey_(date);
  for (var i = 0; i < dates.length; i++) {
    if (normalizeDateKey_(dates[i][0]) === target) return i + startRow;
  }
  return -1;
}

function deleteRowsByDate_(sheet, date, startRow) {
  var lr=sheet.getLastRow();
  if(lr<startRow) return;
  var dates=sheet.getRange(startRow,1,lr-startRow+1,1).getValues();
  var target=normalizeDateKey_(date);
  for(var i=dates.length-1;i>=0;i--){
    if(normalizeDateKey_(dates[i][0])===target) sheet.deleteRow(i+startRow);
  }
}

function out_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function outP_(cb, obj){
  cb=String(cb).replace(/[^\w.$]/g,"");
  return ContentService.createTextOutput(cb+"("+JSON.stringify(obj)+");").setMimeType(ContentService.MimeType.JAVASCRIPT);
}
