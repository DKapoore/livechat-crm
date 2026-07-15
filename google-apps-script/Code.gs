/**
 * Live Chat CRM — Google Sheets Sync Script
 * ------------------------------------------
 * Paste this entire file into Extensions → Apps Script on a Google Sheet, then deploy it
 * as a Web App (see the Hinglish setup guide in this same folder for exact steps).
 *
 * This script NEVER receives passwords, SMTP credentials, or bot tokens — the CRM server
 * deliberately excludes those from every payload it sends here, by design.
 */

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    if (payload.type === 'lead') {
      writeLeadRow(payload.row);
    } else if (payload.type === 'full_sync') {
      writeAgentsSheet(payload.agents || []);
      writeDepartmentsSheet(payload.departments || []);
      writeWidgetsSheet(payload.widgets || []);
      writeStatsSheet(payload.company, payload.stats);
    } else {
      return jsonResponse({ ok: false, error: 'Unknown payload type: ' + payload.type });
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// Simple health-check when opening the Web App URL directly in a browser
function doGet(e) {
  return jsonResponse({ ok: true, message: 'Live Chat CRM sync endpoint is up. POST data here from the admin panel.' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#16a34a').setFontColor('#ffffff');
  }
  return sheet;
}

// ---- Leads: append-only, one row per new visitor/lead captured ----
function writeLeadRow(row) {
  var headers = ['Timestamp', 'Name', 'Mobile', 'Email', 'Interested In', 'Consent', 'Widget', 'Page URL', 'Category', 'Chat Code'];
  var sheet = getOrCreateSheet('Leads', headers);
  sheet.appendRow([
    row.timestamp, row.name, row.mobile, row.email, row.interestedIn,
    row.consentGiven, row.widgetName, row.pageUrl, row.category, row.shortCode,
  ]);
}

// ---- Agents: full overwrite each sync (current snapshot, NEVER includes passwords) ----
function writeAgentsSheet(agents) {
  var headers = ['Name', 'Email', 'Role', 'Status', 'Active Chats', 'Max Chats', 'Telegram Linked'];
  var sheet = getOrCreateSheet('Agents', headers);
  clearDataRows(sheet);
  agents.forEach(function (a) {
    sheet.appendRow([a.name, a.email, a.role, a.status, a.active_chats, a.max_chats, a.telegram_linked]);
  });
}

function writeDepartmentsSheet(departments) {
  var headers = ['Name'];
  var sheet = getOrCreateSheet('Departments', headers);
  clearDataRows(sheet);
  departments.forEach(function (d) { sheet.appendRow([d.name]); });
}

function writeWidgetsSheet(widgets) {
  var headers = ['Name', 'Widget Key', 'Brand Color', 'Position', 'Icon Type', 'Lead Form Enabled'];
  var sheet = getOrCreateSheet('Widgets', headers);
  clearDataRows(sheet);
  widgets.forEach(function (w) {
    sheet.appendRow([w.name, w.widget_key, w.brand_color, w.widget_position, w.icon_type, w.lead_form_enabled ? 'Yes' : 'No']);
  });
}

function writeStatsSheet(company, stats) {
  var headers = ['Metric', 'Value'];
  var sheet = getOrCreateSheet('Stats', headers);
  clearDataRows(sheet);
  sheet.appendRow(['Company', company ? company.name : '']);
  sheet.appendRow(['Total Visitors', stats.totalVisitors]);
  sheet.appendRow(['Total Conversations', stats.totalConversations]);
  sheet.appendRow(['Closed Conversations', stats.closedConversations]);
  sheet.appendRow(['Last Synced', stats.syncedAt]);
}

function clearDataRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }
}
