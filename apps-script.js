/**
 * Google Apps Script — Teacher Availability Backend
 *
 * Setup:
 * 1. Create a Google Sheet with three tabs: "Submissions", "Current", "Teachers"
 * 2. "Submissions" tab headers (row 1):
 *    Timestamp | Teacher | Mon General | Tue General | Wed General | Thu General |
 *    Fri General | Sat General | Mon Gaps | Tue Gaps | Wed Gaps | Thu Gaps |
 *    Fri Gaps | Sat Gaps | Holidays
 * 3. "Current" tab — same headers as Submissions (one row per teacher, auto-managed)
 * 4. "Teachers" tab — column A = teacher names
 * 5. Open Extensions → Apps Script
 * 6. Paste this entire file into Code.gs (replace any existing code)
 * 7. Go to Project Settings → Script Properties → Add:
 *    - PIN = <your chosen PIN, e.g. "3456">
 * 8. Deploy → New deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 9. Copy the deployment URL and paste it into index.html (APPS_SCRIPT_URL)
 *
 * Endpoints:
 *   GET  ?action=teachers&pin=XXXX  → { teachers: [...] }
 *   POST { pin, teacher, general, urgent, holidays } → { status: "ok", row, timestamp }
 *
 * "Same as before" logic:
 *   When general or urgent is the string "no_change", the Current tab keeps
 *   the existing values for those columns. The Submissions tab logs
 *   "(no change)" so there's still an audit trail.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPin_() {
  return PropertiesService.getScriptProperties().getProperty("PIN") || "";
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSubmissionsSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Submissions");
}

function getCurrentSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Current");
  if (!sheet) {
    // Auto-create Current tab with same headers as Submissions
    var sub = getSubmissionsSheet_();
    if (sub) {
      sheet = ss.insertSheet("Current");
      var headers = sub.getRange(1, 1, 1, sub.getLastColumn()).getValues()[0];
      sheet.appendRow(headers);
    }
  }
  return sheet;
}

function getTeachersSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Teachers");
}

// ---------------------------------------------------------------------------
// GET — return teacher list
// ---------------------------------------------------------------------------

function doGet(e) {
  var params = e ? e.parameter : {};
  var action = params.action || "";
  var pin = params.pin || "";

  // PIN check
  if (pin !== getPin_()) {
    return jsonResponse_({ error: "Invalid PIN" });
  }

  if (action === "teachers") {
    var sheet = getTeachersSheet_();
    if (!sheet) {
      return jsonResponse_({ error: "Teachers tab not found" });
    }
    var data = sheet.getDataRange().getValues();
    // Skip header row, get column A (name)
    var teachers = [];
    for (var i = 1; i < data.length; i++) {
      var name = (data[i][0] || "").toString().trim();
      if (name) teachers.push(name);
    }
    teachers.sort();
    return jsonResponse_({ teachers: teachers });
  }

  return jsonResponse_({ error: "Unknown action" });
}

// ---------------------------------------------------------------------------
// POST — save availability
// ---------------------------------------------------------------------------

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ error: "Invalid JSON body" });
  }

  // PIN check
  if ((body.pin || "") !== getPin_()) {
    return jsonResponse_({ error: "Invalid PIN" });
  }

  var teacher = (body.teacher || "").trim();
  if (!teacher) {
    return jsonResponse_({ error: "Teacher name is required" });
  }

  var general = body.general;   // object with day keys, or "no_change"
  var urgent = body.urgent;     // array of slots, or "no_change"
  var holidays = body.holidays || [];

  var generalIsNoChange = (general === "no_change");
  var urgentIsNoChange = (urgent === "no_change");

  var now = new Date();
  var timestamp = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");

  var days = ["mon", "tue", "wed", "thu", "fri", "sat"];

  // --- Build general availability columns ---
  var generalCols;
  if (generalIsNoChange) {
    generalCols = days.map(function () { return "(no change)"; });
  } else {
    general = general || {};
    generalCols = days.map(function (day) {
      var slots = general[day] || [];
      return slots.join(" | ");
    });
  }

  // --- Build gaps columns ---
  var urgentCols;
  if (urgentIsNoChange) {
    urgentCols = days.map(function () { return "(no change)"; });
  } else {
    urgent = urgent || [];
    var urgentByDay = {};
    days.forEach(function (d) { urgentByDay[d] = []; });

    urgent.forEach(function (slot) {
      var d = (slot.day || "").toLowerCase();
      if (urgentByDay[d] !== undefined) {
        var range = slot.start + "-" + slot.end;
        if (slot.note) range += " (" + slot.note + ")";
        urgentByDay[d].push(range);
      }
    });

    urgentCols = days.map(function (day) {
      return urgentByDay[day].join(" | ");
    });
  }

  // --- Build holidays column ---
  var holidayParts = holidays.map(function (h) {
    var range = h.from;
    if (h.to && h.to !== h.from) range += " to " + h.to;
    if (h.note) range += " (" + h.note + ")";
    return range;
  });
  var holidaysCol = holidayParts.join(" | ");

  var submissionRow = [timestamp, teacher].concat(generalCols).concat(urgentCols).concat([holidaysCol]);

  // --- 1. Append to Submissions (audit log) ---
  var subSheet = getSubmissionsSheet_();
  if (!subSheet) {
    return jsonResponse_({ error: "Submissions tab not found" });
  }
  subSheet.appendRow(submissionRow);

  // --- 2. Upsert to Current (latest per teacher) ---
  var curSheet = getCurrentSheet_();
  if (curSheet) {
    var curData = curSheet.getDataRange().getValues();
    var teacherRow = -1;

    // Find existing row for this teacher (column B = index 1)
    for (var i = 1; i < curData.length; i++) {
      if ((curData[i][1] || "").toString().trim() === teacher) {
        teacherRow = i + 1; // 1-based row number
        break;
      }
    }

    if (teacherRow > 0) {
      // Update existing row — but preserve "no change" columns from previous data
      var existingRow = curData[teacherRow - 1];

      // Build the final current row, merging with existing where "no change"
      var currentRow = [timestamp, teacher];

      // General cols: positions 2–7
      for (var g = 0; g < 6; g++) {
        if (generalIsNoChange) {
          currentRow.push(existingRow[2 + g] || "");
        } else {
          currentRow.push(generalCols[g]);
        }
      }

      // Gaps cols: positions 8–13
      for (var u = 0; u < 6; u++) {
        if (urgentIsNoChange) {
          currentRow.push(existingRow[8 + u] || "");
        } else {
          currentRow.push(urgentCols[u]);
        }
      }

      // Holidays: position 14 (always updated)
      currentRow.push(holidaysCol);

      curSheet.getRange(teacherRow, 1, 1, currentRow.length).setValues([currentRow]);
    } else {
      // New teacher — if "no change" was checked but no prior data, write empty
      var newRow = [timestamp, teacher];

      for (var g2 = 0; g2 < 6; g2++) {
        newRow.push(generalIsNoChange ? "" : generalCols[g2]);
      }
      for (var u2 = 0; u2 < 6; u2++) {
        newRow.push(urgentIsNoChange ? "" : urgentCols[u2]);
      }
      newRow.push(holidaysCol);

      curSheet.appendRow(newRow);
    }
  }

  return jsonResponse_({
    status: "ok",
    row: subSheet.getLastRow(),
    timestamp: timestamp
  });
}
