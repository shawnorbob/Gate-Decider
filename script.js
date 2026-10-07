/*
=====================================================================
   Staff Attendance Terminal --- script.js
   Handles: Login, automated real-world date/time, check-in/out capture,
   late/early flagging, the Dashboard log view, removing a logged entry,
   and syncing every record to a Google Sheet.
   This one file is shared by every page (Index.html, Dash.html,
   Administrativestaff.html, Accademicstaff.html, Ancillarystaff.html).
   Each section below only runs if the elements it needs are present on
   the current page, so it is safe to load on all five pages.
=====================================================================
*/

/*
--------------------------------------------------------------------
   1. CONFIG
--------------------------------------------------------------------
*/
const PROTECTED_PAGES = ["dash.html", "administrativestaff.html", "accademicstaff.html", "ancillarystaff.html"];
const currentPage = location.pathname.split("/").pop().toLowerCase();
if (PROTECTED_PAGES.includes(currentPage) && !sessionStorage.getItem("auth")) {
  location.replace("index.html");
}

// For now, the login password is hard-coded. This is fine for a class
// project / prototype, but a real deployment should check the password
// on a server, never in client-side JS.
const LOGIN_PASSWORD = "MBHS6247";

// Expected work hours, used only to flag "Late" / "Early" --- adjust to
// match the school's actual schedule.
const WORK_START_MINUTES = 8 * 60;      // 8:00 AM
const GRACE_PERIOD_MINUTES = 10;        // check-in up to 8:10 AM still counts as on time
const WORK_END_MINUTES = 16 * 60;       // 4:00 PM

// Paste the URL you get from deploying the Google Apps Script Web App
// (see the setup notes at the bottom of this file) between the quotes
// below. Until it is filled in, records are still saved and kept in the
// browser's localStorage, they just won't be pushed to Google Sheets.
const SHEET_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyKDrRXN-bybuLra7hdepxVQd66Ei5EU-t3nKaCawnHWAVa4Fw7nFzU8KQsLbh0HlQZ/exec";

// Maps each table's class name (already used in the HTML) to the
// department label stored with every record.
const DEPARTMENT_BY_CLASS = {
  admin: "Administrative Staff",
  accademic: "Academic Staff",
  Ancillary: "Ancillary Staff",
};

/*
--------------------------------------------------------------------
   2. DATE / TIME HELPERS --- always pulled from the real system clock
--------------------------------------------------------------------
*/

function getNow() {
  return new Date();
}

// Storage key for "today", e.g. 2026-08-28. Logs are grouped under this
// key, so once midnight passes a fresh key is used automatically and
// every previous day's entries stay exactly as they were.
function todayKey(date = getNow()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function displayDate(date = getNow()) {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function displayTime(date = getNow()) {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function minutesSinceMidnight(date = getNow()) {
  return date.getHours() * 60 + date.getMinutes();
}

// Drops a small "live date" badge next to a heading without touching
// any of the page's existing text, then keeps it correct even if the
// terminal is left open across midnight.
function mountLiveDate(headingSelector) {
  const heading = document.querySelector(headingSelector);
  if (!heading) return;
  const badge = document.createElement("span");
  badge.id = "liveDate";
  badge.className = "live-date";
  heading.appendChild(badge);
  const update = () => {
    badge.textContent = displayDate();
  };
  update();
  setInterval(update, 60 * 1000);
}

/*
--------------------------------------------------------------------
   3. LOCAL STORAGE --- the day-by-day log book (old + new logs)
--------------------------------------------------------------------
*/

const STORAGE_KEY = "attendanceLogs"; // { "2026-08-28": { "Tyrone White": {...} }, ... }

function loadAllLogs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (err) {
    console.error("Could not read attendance logs from storage:", err);
    return {};
  }
}

function saveAllLogs(logs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
}

function getLogsForDate(dateKey) {
  const logs = loadAllLogs();
  return logs[dateKey] || {};
}

// Adds or updates one person's record for today, keeping whichever
// check-in/out value was already recorded earlier in the day.
function upsertLog({ dateKey, name, position, department, field, time, status }) {
  const logs = loadAllLogs();
  if (!logs[dateKey]) logs[dateKey] = {};
  const existing = logs[dateKey][name] || {
    name,
    position,
    department,
    checkIn: "",
    checkInStatus: "",
    checkOut: "",
    checkOutStatus: "",
  };
  if (field === "in") {
    existing.checkIn = time;
    existing.checkInStatus = status;
  } else {
    existing.checkOut = time;
    existing.checkOutStatus = status;
  }
  existing.position = position;
  existing.department = department;
  logs[dateKey][name] = existing;
  saveAllLogs(logs);
  return existing;
}

// Clears one field (check-in or check-out) for one person on one date.
// If both fields end up empty, the whole entry for that day is dropped
// so the dashboard falls back to showing "---" for them again.
function removeLogEntry(dateKey, name, field) {
  const logs = loadAllLogs();
  const dayLogs = logs[dateKey];
  if (!dayLogs || !dayLogs[name]) return false;
  if (field === "in") {
    dayLogs[name].checkIn = "";
    dayLogs[name].checkInStatus = "";
  } else {
    dayLogs[name].checkOut = "";
    dayLogs[name].checkOutStatus = "";
  }
  if (!dayLogs[name].checkIn && !dayLogs[name].checkOut) {
    delete dayLogs[name];
  }
  saveAllLogs(logs);
  return true;
}

/*
--------------------------------------------------------------------
   4. GOOGLE SHEETS SYNC
--------------------------------------------------------------------
*/

function pushToGoogleSheet(data) {
  if (!SHEET_WEBAPP_URL) return false;
  fetch(SHEET_WEBAPP_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(data),
  }).catch((err) => console.error("Could not sync to Google Sheets:", err));
  return true;
}
// Pulls records from the Sheet into localStorage so every device sees the same data.
// Pass a dateKey for one day, or nothing for every day.
async function pullFromSheet(dateKey) {
  if (!SHEET_WEBAPP_URL) return false;
  try {
    const url = SHEET_WEBAPP_URL + (dateKey ? `?date=${encodeURIComponent(dateKey)}` : "");
    const rows = await (await fetch(url)).json();
    const logs = loadAllLogs();
    if (dateKey) logs[dateKey] = {};
    else Object.keys(logs).forEach((k) => delete logs[k]);
    rows.forEach((r) => {
      if (!r.checkIn && !r.checkOut) return; // skip blank "absent" rows
      (logs[r.date] = logs[r.date] || {})[r.name] = {
        name: r.name, position: r.position, department: r.department,
        checkIn: r.checkIn, checkInStatus: r.checkInStatus,
        checkOut: r.checkOut, checkOutStatus: r.checkOutStatus,
      };
    });
    saveAllLogs(logs);
    return true;
  } catch (err) {
    console.error("Could not read from Google Sheets:", err);
    return false; // local data is left untouched
  }
}

/*
--------------------------------------------------------------------
   5. TOAST --- small confirmation after a check-in / check-out submit
--------------------------------------------------------------------
*/

function showToast(message) {
  let toast = document.getElementById("terminalToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "terminalToast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove("show"), 3500);
}

/*
--------------------------------------------------------------------
   6. LOGIN PAGE (Index.html)
--------------------------------------------------------------------
*/

function initLogin() {
  const loginBtn = document.getElementById("login");
  const passwordField = document.getElementById("password");
  if (!loginBtn || !passwordField) return;
  const fieldset = loginBtn.closest("fieldset") || loginBtn.closest("Fieldset") || loginBtn.parentElement;
  const errorMsg = document.createElement("p");
  errorMsg.className = "login-error";
  fieldset.appendChild(errorMsg);
  const attemptLogin = () => {
    if (passwordField.value === LOGIN_PASSWORD) {
      sessionStorage.setItem("auth", "1");
      window.location.href = "Dash.html";
    } else {
      errorMsg.textContent = "Incorrect password. Please try again.";
      passwordField.value = "";
      passwordField.focus();
    }
  };
  loginBtn.addEventListener("click", attemptLogin);
  passwordField.addEventListener("keyup", (e) => {
    if (e.key === "Enter") attemptLogin();
  });
}

/*
--------------------------------------------------------------------
   7. STAFF TERMINAL PAGES (Administrativestaff / Accademicstaff / Ancillarystaff)
--------------------------------------------------------------------
*/

async function initStaffPage() {
  const submitButtons = document.querySelectorAll(
    'input[type="button"].submit-btn, input[type="button"][id^="submit"]'
  );
  if (!submitButtons.length) return;
  submitButtons.forEach((btn) => {
    btn.addEventListener("click", () => handleSubmit(btn));
  });
  lockLoggedRadios();
  if (await pullFromSheet(todayKey())) lockLoggedRadios();
}
// Goes through every staff row on the page and, for anyone who already
// has a Check In or Check Out logged today, checks + disables that radio
// so it can't be selected and re-submitted. Called on page load and again
// right after a successful submit. Removing the entry on the Dashboard is
// the only thing that clears it, and that only takes effect the next time
// this page is loaded (there's nothing to "un-disable" live across pages).
function lockLoggedRadios() {
  const rows = document.querySelectorAll("table.admin tr, table.accademic tr, table.Ancillary tr");
  if (!rows.length) return;
  const dayLogs = getLogsForDate(todayKey());
  rows.forEach((row) => {
    if (row.querySelector("th") || row.cells.length < 5) return;
    const name = row.cells[0]?.textContent.trim();
    const entry = dayLogs[name];
    if (!entry) return;
    const checkinRadio  = row.querySelector('input.checkin, input[id="checkin"]');
    const checkoutRadio = row.querySelector('input.checkout, input[id="checkout"]');
    if (entry.checkIn && checkinRadio) {
      checkinRadio.checked = true;
      checkinRadio.disabled = true;
    }
    if (entry.checkOut && checkoutRadio) {
      checkoutRadio.checked = true;
      checkoutRadio.disabled = true;
    }
  });
}

function handleSubmit(btn) {
  const row = btn.closest("tr");
  const table = btn.closest("table");
  if (!row || !table) return;
  const checked = row.querySelector('input[type="radio"]:checked');
  if (!checked) {
    showToast("Select Check In or Check Out before submitting.");
    return;
  }
  if (checked.disabled) return; // safety net --- the radio should already be locked, but just in case
  const name = row.cells[0]?.textContent.trim();
  const position = row.cells[1]?.textContent.trim();
  const department = DEPARTMENT_BY_CLASS[table.classList[0]] || table.classList[0];
  const now = getNow();
  const time = displayTime(now);
  const dateKey = todayKey(now);
  const minutes = minutesSinceMidnight(now);
  // id is "checkin" or "checkout" --- duplicated across rows in the HTML,
  // but the lookup above is scoped to this row only, so it is reliable.
  const isOut = checked.classList.contains("checkout") || checked.id === "checkout" || checked.value === "out";
  const field = isOut ? "out" : "in";
  if (field === "out" && !getLogsForDate(dateKey)[name]?.checkIn) {
  showToast(`${name} hasn't checked in yet.`);
  return;
  }
  let status;
  if (field === "in") {
    status = minutes > WORK_START_MINUTES + GRACE_PERIOD_MINUTES ? "Late" : "On Time";
  } else {
    status = minutes < WORK_END_MINUTES ? "Early" : "On Time";
  }
  const record = upsertLog({ dateKey, name, position, department, field, time, status });
  pushToGoogleSheet({ date: dateKey, ...record });
  showToast(
    `${name} --- checked ${field === "in" ? "IN" : "OUT"} at ${time} (${status})`
  );
  lockLoggedRadios(); // lock this Check In / Check Out now that it's saved
}

/*
--------------------------------------------------------------------
   8. DASHBOARD (Dash.html) --- daily log of every staff member
--------------------------------------------------------------------
*/

async function initDashboard() {
  const heading = document.querySelector("h4.Dat");
  if (!heading) return;
  mountLiveDate("h4.Dat");
  await pullFromSheet();            // load every day from the Sheet
  buildDateSelector();
  renderDashboard(todayKey());
  initDashboardRemoval();
  initDashboardDownload();
  // refresh every minute (skips if you're in the middle of selecting an entry to remove)
  setInterval(async () => {
    if (selectedRemoval) return;
    const sel = document.getElementById("dashDateSelect");
    if (await pullFromSheet()) renderDashboard(sel ? sel.value : todayKey());
  }, 60 * 1000);
}

function buildDateSelector() {
  const heading = document.querySelector("h4.Dat");
  const logs = loadAllLogs();
  const dates = Object.keys(logs).sort().reverse();
  if (!dates.includes(todayKey())) dates.unshift(todayKey());
  const controls = document.createElement("div");
  controls.className = "dash-controls";
  const label = document.createElement("label");
  label.setAttribute("for", "dashDateSelect");
  label.textContent = "Viewing log for:";
  const select = document.createElement("select");
  select.id = "dashDateSelect";
  dates.forEach((dateKey) => {
    const opt = document.createElement("option");
    opt.value = dateKey;
    opt.textContent = dateKey === todayKey() ? `${dateKey} (Today)` : dateKey;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => {
    clearRemovalSelection(); // a selection made on one date shouldn't carry over
    renderDashboard(select.value);
  });
  controls.appendChild(label);
  controls.appendChild(select);
  heading.insertAdjacentElement("afterend", controls);
}

function renderDashboard(dateKey) {
  const dayLogs = getLogsForDate(dateKey);
  document.querySelectorAll("table.admin, table.accademic, table.Ancillary").forEach((table) => {
    Array.from(table.rows).forEach((row) => {
      // skip header rows (they contain <th>, or the "Male/Female Staff" divider rows)
      if (row.querySelector("th") || row.querySelector("thead")) return;
      if (row.cells.length < 5) return;
      const name = row.cells[1]?.textContent.trim();
      const entry = dayLogs[name];
      row.cells[0].textContent = dateKey;
      row.cells[3].innerHTML = entry?.checkIn
        ? `<span class="status-time">${entry.checkIn}</span>` + statusTag(entry.checkInStatus)
        : "---";
      row.cells[4].innerHTML = entry?.checkOut
        ? `<span class="status-time">${entry.checkOut}</span>` + statusTag(entry.checkOutStatus)
        : "---";
    });
  });
}

function statusTag(status) {
  if (!status) return "";
  const cls = status === "On Time" ? "on-time" : status === "Early" ? "early" : "late";
  return ` <span class="status-tag ${cls}">${status}</span>`;
}

/*
--------------------------------------------------------------------
   8b. DASHBOARD --- remove a logged check-in / check-out entry
   Click a filled-in "Check in" or "check out" cell to select it (it
   gets a gold outline), then press that table's Remove button. Only
   one entry can be selected at a time, and a Remove button only acts
   on a selection made in its own table.

   This is also the only way to free up a locked radio on the matching
   staff terminal page --- once removed here, the next time that staff
   page loads, lockLoggedRadios() no longer finds an entry for that
   person and the radio is selectable again.
--------------------------------------------------------------------
*/

let selectedRemoval = null; // { table, cell, name, field }

function clearRemovalSelection() {
  if (selectedRemoval) {
    selectedRemoval.cell.style.outline = "";
    selectedRemoval.cell.style.cursor = "";
  }
  selectedRemoval = null;
}

function initDashboardRemoval() {
  const tables = document.querySelectorAll("table.admin, table.accademic, table.Ancillary");
  tables.forEach((table) => {
    table.addEventListener("click", (e) => {
      const cell = e.target.closest("td");
      if (!cell || !table.contains(cell)) return;
      const row = cell.closest("tr");
      if (!row || row.querySelector("th") || row.cells.length < 5) return;
      const cellIndex = Array.from(row.cells).indexOf(cell);
      if (cellIndex !== 3 && cellIndex !== 4) return; // only "Check in" / "check out" columns
      if (!cell.textContent.trim() || cell.textContent.trim() === "---") {
        showToast("There's nothing logged there to remove yet.");
        return;
      }
      const name = row.cells[1]?.textContent.trim();
      if (!name) return;
      const field = cellIndex === 3 ? "in" : "out";
      // Clicking the same cell again just deselects it.
      if (selectedRemoval && selectedRemoval.cell === cell) {
        clearRemovalSelection();
        return;
      }
      clearRemovalSelection(); // only one selection at a time across the dashboard
      cell.style.outline = "2px solid #c9a441";
      cell.style.cursor = "pointer";
      selectedRemoval = { table, cell, name, field };
    });
  });

  document.querySelectorAll("button.nbut").forEach((btn) => {
    btn.addEventListener("click", () => {
      // The Remove button belongs to whichever table sits directly
      // above it on the page.
      let table = btn.previousElementSibling;
      while (table && table.tagName !== "TABLE") table = table.previousElementSibling;
      if (!selectedRemoval || selectedRemoval.table !== table) {
        showToast("Choose a check in or check out above to remove first.");
        return;
      }
      const dateSelect = document.getElementById("dashDateSelect");
      const dateKey = dateSelect ? dateSelect.value : todayKey();
      const { name, field } = selectedRemoval;
      removeLogEntry(dateKey, name, field);
      const left = getLogsForDate(dateKey)[name];
      if (left) pushToGoogleSheet({ date: dateKey, ...left });
      else pushToGoogleSheet({ action: "delete", date: dateKey, name });
      clearRemovalSelection();
      renderDashboard(dateKey);
      showToast(`Removed ${field === "in" ? "check-in" : "check-out"} for ${name}.`);
    });
  });
}

/*
--------------------------------------------------------------------
   8c. DASHBOARD --- download one table's staff log as CSV
   Each Download button belongs to whichever table sits directly above
   it, same lookup pattern as the Remove button.
--------------------------------------------------------------------
*/

function findTableFor(btn) {
  let t = btn.previousElementSibling;
  while (t && t.tagName !== "TABLE") t = t.previousElementSibling;
  return t;
}

function initDashboardDownload() {
  document.querySelectorAll('input[type="button"][value="Download"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const table = findTableFor(btn);
      if (table) exportTables([table], table.dataset.title || "Staff");
    });
  });
  const all = document.getElementById("save-all");
  if (all) {
    all.addEventListener("click", () => {
      const tables = Array.from(document.querySelectorAll("table.admin, table.accademic, table.Ancillary"));
      exportTables(tables, "All_Staff");
    });
  }
}

function getDepartment(table) {
  return DEPARTMENT_BY_CLASS[table.classList[0]] || table.classList[0];
}

function collectTableRecords(table, dateKey) {
  const dayLogs = getLogsForDate(dateKey);
  const department = getDepartment(table);
  return Array.from(table.rows)
    .filter((row) => !row.querySelector("th") && row.cells.length >= 5)
    .map((row) => {
      const name = row.cells[1].textContent.trim();
      const position = row.cells[2].textContent.trim();
      const e = dayLogs[name] || {};
      return {
        date: dateKey, name, position, department,
        checkIn: e.checkIn || "", checkInStatus: e.checkInStatus || "",
        checkOut: e.checkOut || "", checkOutStatus: e.checkOutStatus || "",
      };
    });
  // To skip staff who haven't checked in/out, add:
  // .filter(r => r.checkIn || r.checkOut)
}

function exportTables(tables, label) {
  const dateSelect = document.getElementById("dashDateSelect");
  const dateKey = dateSelect ? dateSelect.value : todayKey();
  const records = tables.flatMap((t) => collectTableRecords(t, dateKey));
  if (!records.length) return;

  const sent = pushToGoogleSheet(records);   // -> spreadsheet

  const header = ["Date","Name","Position","Department","Check In","Check In Status","Check Out","Check Out Status"];
  const lines = [header.join(",")].concat(
    records.map((r) =>
      [r.date, r.name, r.position, r.department, r.checkIn, r.checkInStatus, r.checkOut, r.checkOutStatus]
        .map(csvSafe).join(",")
    )
  );
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${label.replace(/\s+/g, "_")}_${dateKey}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast(sent
    ? `Downloaded and sent ${label} (${dateKey}) to Google Sheets.`
    : `Downloaded ${label} (${dateKey}). Google Sheet not connected yet.`);
}

// The old version missed commas, which would break columns in the CSV.
function csvSafe(value) {
  if (value == null) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/*
--------------------------------------------------------------------
   9. BOOTSTRAP
--------------------------------------------------------------------
*/

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll('a[href="index.html"]').forEach((a) =>
  a.addEventListener("click", () => sessionStorage.removeItem("auth"))
  );
  initLogin();
  initStaffPage();
  initDashboard();
  // Live date badges on the individual staff terminal pages too.
  mountLiveDate("h4.ast");
  mountLiveDate("h4.ancst");
});

/*
=====================================================================
   GOOGLE SHEETS SETUP --- do this once
   1. Create a Google Sheet. Add a header row on Sheet1:
      Date | Name | Position | Department | Check In | Check In Status | Check Out | Check Out Status
   2. In the Sheet, open Extensions > Apps Script and replace the code
      with:
        function doPost(e) {
          const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Sheet1");
          const data = JSON.parse(e.postData.contents);
          sheet.appendRow([
            data.date, data.name, data.position, data.department,
            data.checkIn, data.checkInStatus, data.checkOut, data.checkOutStatus
          ]);
          return ContentService.createTextOutput("OK");
        }
   3. Click Deploy > New deployment > select type "Web app".
      - Execute as: Me
      - Who has access: Anyone
      Deploy, then copy the Web App URL Google gives you.
   4. Paste that URL into SHEET_WEBAPP_URL near the top of this file.
   Every check-in/out submitted on the staff pages will now be appended
   to the Sheet as a new row, in addition to being kept in the browser's
   localStorage so the Dashboard still works instantly offline.
=====================================================================
*/