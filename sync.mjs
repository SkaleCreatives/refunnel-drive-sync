#!/usr/bin/env node
// refunnel-drive-sync: a Refunnel export (CSV) -> Google Drive (one folder per month) + a Google Sheet with a clickable
// Drive link per file. No dependencies (Node 20+). Run by .github/workflows/sync.yml; see README.md.
//
// Environment
//   GOOGLE_SERVICE_ACCOUNT  service account key (JSON, or the JSON base64-encoded)
//   GOOGLE_SUBJECT          optional: Google Workspace user the service account acts as (domain-wide delegation)
//   FOLDER                  Drive folder (URL or ID): files go into <FOLDER>/<YYYY-MM>/, exports are read from <FOLDER>/_exports
//   SHEET                   optional: existing Google Sheet to extend (URL or ID); default: "Refunnel Content" in FOLDER
//
// Commands
//   resolve              prints FOLDER_ID, DRIVE_ID, SHEET_ID, EXPORT (KEY=value); creates the sheet if there is none and
//                        downloads the newest CSV in <FOLDER>/_exports to export.csv
//   import <csv>         known files (by Media URL) get fresh values, new files become rows; Launch Status, Drive Link
//                        and any column of your own stay; rows sorted newest first
//   pending [limit]      rows without Drive Link -> stdout "month<TAB>file name<TAB>url"
//   links <files.json>   `rclone lsjson -R` of the folder -> fills Drive Link
//   rclone-env           writes the key to $RUNNER_TEMP and prints the rclone remote "drive" (RCLONE_CONFIG_DRIVE_*)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const GAPI = "https://www.googleapis.com";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const TITLE = "Refunnel Content";

// The sheet: our label, the Refunnel export column it comes from, width, visible. Order = order in a new sheet.
// Columns are found by label or by the Refunnel name, so an existing sheet may use either and any order.
const COLUMNS = [
  ["Launch Status", null, 130, true], ["Month", null, 72, true], ["Created At", "created_at", 120, true],
  ["Creator", "username", 150, true], ["Drive Link", null, 80, true], ["Type", "viewable_media_type", 70, true],
  ["Products", "products", 220, true], ["Rights Status", "rights_status", 110, true], ["GMV", "gmv", 80, true],
  ["Impressions", "impressions", 95, true], ["Likes", "likes", 70, true], ["Comments", "comments", 82, true],
  ["Shares", "shares", 70, true], ["Caption", "caption", 360, true], ["ID", "id", 180, true],
  ["Updated At", "updated_at", 120, true], ["File Name", null, 300, false], ["Media URL", "media_url", 300, false],
  ["Post Link", "permalink", 200, false], ["Platform", "platform", 90, false], ["Post Type", "post_type", 90, false],
  ["Media Type", "media_type", 90, false], ["Followers", "followers", 90, false], ["Relation Type", "relation_type", 120, false],
  ["Rights Granted Until", "rights_granted_until_date", 120, false], ["Hashtags", "hashtags", 200, false],
  ["Tags", "tags", 120, false], ["Mentions", "mentions", 120, false], ["Collections", "collections", 120, false],
  ["Status", "status", 80, false], ["Spark Code", "spark_code", 120, false], ["EMV", "emv", 80, false],
  ["HLS URL", "media_hls", 200, false],
].map(([label, from, width, visible]) => ({ label, from, width, visible }));
const NUMBERS = new Set(["followers", "emv", "gmv", "likes", "comments", "impressions", "shares"]);
const LISTS = new Set(["relation_type", "hashtags", "tags", "mentions", "collections", "products"]);
const DATES = new Set(["created_at", "updated_at"]);
const STATUSES = ["Not launched", "Planned", "Staged", "Launched", "Paused"];

const id = (v) => String(v || "").match(/[-\w]{25,}/)?.[0] || "";
const letter = (i) => (i >= 26 ? letter(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));
const rgb = (h) => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });
const q = (s) => `'${String(s).replace(/'/g, "\\'")}'`;

// ---------- Google access ----------
function key() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT || "").trim();
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT is not set");
  return JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
}

let cached;
async function token() {
  if (cached && cached.until > Date.now()) return cached.token;
  const sa = key();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: sa.client_email, scope: `${GAPI}/auth/drive`, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  if (process.env.GOOGLE_SUBJECT) claim.sub = process.env.GOOGLE_SUBJECT;
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claim)}`;
  const jwt = `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  if (!res.ok) throw new Error(`Google login failed: ${res.status} ${await res.text()}`);
  cached = { token: (await res.json()).access_token, until: Date.now() + 50 * 60 * 1000 };
  return cached.token;
}

async function api(url, init = {}, raw = false) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json", ...init.headers } });
    if (res.ok) return raw ? res : res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    throw new Error(`${init.method || "GET"} ${url.split("?")[0]}: ${res.status} ${text}`);
  }
}
const drive = (p, query = {}, init) => api(`${GAPI}/drive/v3/${p}?${new URLSearchParams({ supportsAllDrives: "true", ...query })}`, init);
const batch = (sheetId, requests) => api(`${SHEETS}/${sheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
const values = (sheetId, range, query = "") => `${SHEETS}/${sheetId}/values/${encodeURIComponent(range)}${query}`;

async function children(folder, extra) {
  const r = await drive("files", { q: `${q(folder)} in parents and trashed = false${extra ? ` and ${extra}` : ""}`,
    includeItemsFromAllDrives: "true", corpora: "allDrives", fields: "files(id,name,mimeType,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "100" });
  return r.files;
}

// ---------- the sheet ----------
async function readSheet(sheetId) {
  const meta = await api(`${SHEETS}/${sheetId}?fields=sheets.properties`);
  const tab = (meta.sheets.find((s) => s.properties.title === TITLE) || meta.sheets[0]).properties;
  const { values: rows = [] } = await api(values(sheetId, q(tab.title), "?valueRenderOption=FORMULA"));
  const head = (rows.shift() || []).map(String);
  const norm = (s) => s.trim().toLowerCase().replace(/[\s_]+/g, " ");
  const find = (c) => head.findIndex((h) => norm(h) === norm(c.label) || (c.from && norm(h) === norm(c.from)));
  return { tab, head, rows, col: Object.fromEntries(COLUMNS.map((c) => [c.label, find(c)])) };
}

async function createSheet(folderId) {
  const file = await drive("files", { fields: "id" }, { method: "POST",
    body: JSON.stringify({ name: TITLE, mimeType: "application/vnd.google-apps.spreadsheet", parents: [folderId] }) });
  const meta = await api(`${SHEETS}/${file.id}?fields=sheets.properties`);
  const sid = meta.sheets[0].properties.sheetId;
  await batch(file.id, [
    { updateSpreadsheetProperties: { properties: { locale: "en_US" }, fields: "locale" } },
    { updateSheetProperties: { properties: { sheetId: sid, title: TITLE, gridProperties: { rowCount: 1000, columnCount: COLUMNS.length } },
      fields: "title,gridProperties.rowCount,gridProperties.columnCount" } },
  ]);
  await api(values(file.id, `${q(TITLE)}!A1`, "?valueInputOption=RAW"), { method: "PUT", body: JSON.stringify({ values: [COLUMNS.map((c) => c.label)] }) });
  await batch(file.id, layout(sid, COLUMNS.map((c) => c.label)));
  await info(file.id, folderId);
  return file.id;
}

// Look of the main tab: dark header, banding, number and date formats, Launch Status dropdown, Rights colours,
// white-to-green scale on the metrics, widths, hidden extras, frozen header. Ranges are open-ended, so they cover new rows.
function layout(sid, head) {
  const col = (label) => head.indexOf(label);
  const R = [];
  const range = (c0, c1 = c0 + 1, r0 = 1) => ({ sheetId: sid, startRowIndex: r0, startColumnIndex: c0, endColumnIndex: c1 });
  const fmt = (rng, f, fields) => R.push({ repeatCell: { range: rng, cell: { userEnteredFormat: f }, fields } });
  const ink = rgb("#14161F");
  fmt(range(0, head.length, 0), { textFormat: { fontFamily: "Archivo", fontSize: 10, foregroundColor: ink }, wrapStrategy: "CLIP", verticalAlignment: "MIDDLE" },
    "userEnteredFormat(textFormat,wrapStrategy,verticalAlignment)");
  fmt({ ...range(0, head.length, 0), endRowIndex: 1 }, { backgroundColor: ink, textFormat: { fontFamily: "Archivo", fontSize: 10, bold: true, foregroundColor: rgb("#FFFFFF") } },
    "userEnteredFormat(backgroundColor,textFormat)");
  R.push({ addBanding: { bandedRange: { range: range(0, head.length, 0), rowProperties: { headerColor: ink, firstBandColor: rgb("#FFFFFF"), secondBandColor: rgb("#FBFAF7") } } } });
  const number = (label, pattern) => col(label) >= 0 && fmt(range(col(label)), { numberFormat: { type: "NUMBER", pattern }, horizontalAlignment: "RIGHT" },
    "userEnteredFormat(numberFormat,horizontalAlignment)");
  number("GMV", "$#,##0"); for (const l of ["Impressions", "Likes", "Comments", "Shares", "Followers", "EMV"]) number(l, "#,##0");
  for (const l of ["Launch Status", "Month", "Type", "Rights Status"]) if (col(l) >= 0) fmt(range(col(l)), { horizontalAlignment: "CENTER" }, "userEnteredFormat.horizontalAlignment");
  R.push(...dateAndDropdown(sid, head));
  let k = 0;
  const when = (label, text, bg, fg) => col(label) >= 0 && R.push({ addConditionalFormatRule: { index: k++, rule: { ranges: [range(col(label))],
    booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: text }] }, format: { backgroundColor: rgb(bg), textFormat: { foregroundColor: rgb(fg), bold: true } } } } } });
  when("Launch Status", "Launched", "#E7F4EC", "#1E7A43"); when("Launch Status", "Staged", "#EAEFFA", "#3B5BA9");
  when("Launch Status", "Planned", "#FDF1EA", "#B0441A"); when("Launch Status", "Paused", "#F1EDE6", "#646672");
  when("Rights Status", "NONE", "#FBE9E7", "#A3291F"); when("Rights Status", "REQUESTED", "#FDF4E1", "#8A5A00");
  when("Rights Status", "GRANTED", "#E7F4EC", "#1E7A43"); when("Rights Status", "APPROVED", "#E7F4EC", "#1E7A43");
  // metrics are heavily skewed (a few posts have 1000x the median), so the scale runs on percentiles: 0 white, top 1 % green
  for (const l of ["GMV", "Impressions", "Likes", "Comments", "Shares"]) if (col(l) >= 0) R.push({ addConditionalFormatRule: { index: k++, rule: { ranges: [range(col(l))], gradientRule: {
    minpoint: { type: "NUMBER", value: "0", color: rgb("#FFFFFF") }, midpoint: { type: "PERCENTILE", value: "75", color: rgb("#D4EDDC") },
    maxpoint: { type: "PERCENTILE", value: "99", color: rgb("#57B97A") } } } } });
  for (const c of COLUMNS) if (col(c.label) >= 0) R.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: "COLUMNS", startIndex: col(c.label), endIndex: col(c.label) + 1 },
    properties: { pixelSize: c.width, hiddenByUser: !c.visible }, fields: "pixelSize,hiddenByUser" } });
  R.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: "ROWS", startIndex: 1 }, properties: { pixelSize: 26 }, fields: "pixelSize" } });
  R.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 34 }, fields: "pixelSize" } });
  R.push({ updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 1, frozenColumnCount: Math.max(col("Drive Link") + 1, 0), hideGridlines: true } },
    fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.hideGridlines" } });
  R.push({ setBasicFilter: { filter: { range: range(0, head.length, 0) } } });
  return R;
}

// Also applied to an existing sheet on every import: dates show as dates, Launch Status is a dropdown.
function dateAndDropdown(sid, head) {
  const R = [];
  for (const l of ["Created At", "Updated At"]) if (head.indexOf(l) >= 0 || head.indexOf(COLUMNS.find((c) => c.label === l).from) >= 0) {
    const i = head.indexOf(l) >= 0 ? head.indexOf(l) : head.indexOf(COLUMNS.find((c) => c.label === l).from);
    R.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm" } } }, fields: "userEnteredFormat.numberFormat" } });
  }
  const s = head.indexOf("Launch Status");
  if (s >= 0) R.push({ setDataValidation: { range: { sheetId: sid, startRowIndex: 1, startColumnIndex: s, endColumnIndex: s + 1 },
    rule: { condition: { type: "ONE_OF_LIST", values: STATUSES.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: true } } });
  return R;
}

// Second tab: where things are and live counts (formulas on the main tab, so they stay current).
async function info(sheetId, folderId) {
  const add = await batch(sheetId, [{ addSheet: { properties: { title: "Info", index: 1, gridProperties: { rowCount: 40, columnCount: 3, hideGridlines: true } } } }]);
  const sid = add.replies[0].addSheet.properties.sheetId;
  const T = `${q(TITLE)}!`;
  const at = (label) => letter(COLUMNS.findIndex((c) => c.label === label));
  const count = (label, v) => `=COUNTIF(${T}${at(label)}2:${at(label)},"${v}")`;
  const rows = [
    ["T", TITLE, ""], ["", "", ""],
    ["H", "Links", ""],
    ["", "Drive folder", `=HYPERLINK("https://drive.google.com/drive/folders/${folderId}","Open the folder")`],
    ["", "Refunnel", `=HYPERLINK("https://app.refunnel.com","app.refunnel.com")`],
    ["", "", ""], ["H", "What is in here", ""],
    ["", "Post dates", `=IFERROR(TEXT(MIN(${T}${at("Created At")}2:${at("Created At")}),"d mmm yyyy")&" - "&TEXT(MAX(${T}${at("Created At")}2:${at("Created At")}),"d mmm yyyy"),"")`],
    ["", "Last Refunnel sync", `=IFERROR(TEXT(MAX(${T}${at("Updated At")}2:${at("Updated At")}),"d mmm yyyy"),"")`],
    ["", "Files", `=COUNTA(${T}${at("Media URL")}2:${at("Media URL")})`],
    ["", "Files with Drive link", count("Drive Link", "Open")],
    ["", "Videos · images", `=${count("Type", "VIDEO").slice(1)}&" videos · "&${count("Type", "IMAGE").slice(1)}&" images"`],
    ["", "TikTok · Instagram", `=${count("Platform", "TIKTOK").slice(1)}&" · "&${count("Platform", "INSTAGRAM").slice(1)}`],
    ["", "Creators", `=COUNTUNIQUE(${T}${at("Creator")}2:${at("Creator")})`],
    ["", "", ""], ["H", "Rights", ""],
    ["W", "Before you launch", "Use a file in ads only with usage rights or a Spark Code from the creator."],
    ["", "NONE", count("Rights Status", "NONE")], ["", "REQUESTED", count("Rights Status", "REQUESTED")], ["", "GRANTED", count("Rights Status", "GRANTED")],
    ["", "", ""], ["H", "Launch Status", ""],
    ...STATUSES.slice(1).map((s) => ["", s, count("Launch Status", s)]),
    ["", "", ""], ["H", "How to use", ""],
    ["", "Launch Status", "Not launched · Planned · Staged (uploaded to the ad account, no spend yet) · Launched (spend > 0) · Paused"],
    ["", "Colour scale", "GMV, Impressions, Likes, Comments, Shares: white = 0, green = top performers (75th to 99th percentile)"],
    ["", "Hidden columns", "Platform, Post Link, Followers, Hashtags and more: right-click a column header › Show columns"],
    ["", "Drive folders", "One folder per month of the post date. File name: date_platform_creator_id"],
    ["", "New content", "Put a new Refunnel export (CSV) into the folder _exports and run the sync again"],
  ];
  await api(values(sheetId, "Info!A1", "?valueInputOption=USER_ENTERED"), { method: "PUT", body: JSON.stringify({ values: rows.map(([, a, b]) => ["", a, b]) }) });
  const r = (a, b, c0 = 0, c1 = 3) => ({ sheetId: sid, startRowIndex: a, endRowIndex: b, startColumnIndex: c0, endColumnIndex: c1 });
  const fmt = (rng, f, fields) => ({ repeatCell: { range: rng, cell: { userEnteredFormat: f }, fields } });
  const R = [
    fmt(r(0, 40), { textFormat: { fontFamily: "Archivo", fontSize: 10, foregroundColor: rgb("#14161F") }, verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" },
      "userEnteredFormat(textFormat,verticalAlignment,wrapStrategy)"),
    fmt(r(0, 40, 1, 2), { textFormat: { foregroundColor: rgb("#646672") } }, "userEnteredFormat.textFormat.foregroundColor"),
    fmt(r(0, 1), { textFormat: { fontSize: 16, bold: true, foregroundColor: rgb("#14161F") } }, "userEnteredFormat.textFormat"),
    { updateDimensionProperties: { range: { sheetId: sid, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 48 }, fields: "pixelSize" } },
    ...[24, 200, 620].map((px, i) => ({ updateDimensionProperties: { range: { sheetId: sid, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } })),
  ];
  rows.forEach(([kind], i) => {
    if (kind === "H") R.push(fmt(r(i, i + 1), { textFormat: { fontSize: 11, bold: true, foregroundColor: rgb("#B0441A") } }, "userEnteredFormat.textFormat"),
      { updateBorders: { range: r(i, i + 1, 1, 3), bottom: { style: "SOLID", colorStyle: { rgbColor: rgb("#E6E1D8") } } } });
    if (kind === "W") R.push(fmt(r(i, i + 1, 1, 3), { backgroundColor: rgb("#FBE9E7"), textFormat: { bold: true, foregroundColor: rgb("#A3291F") } }, "userEnteredFormat(backgroundColor,textFormat)"));
  });
  await batch(sheetId, R);
}

// ---------- the Refunnel export ----------
// RFC 4180: quoted fields with commas, quotes ("") and line breaks
function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c; }
    else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function value(k, v) {
  if (NUMBERS.has(k)) return v === "" ? "" : Number(v);
  if (DATES.has(k)) return v ? Date.parse(v.trim().replace(" ", "T").replace(/(\d)$/, "$1Z")) / 86400000 + 25569 : "";   // sheet date serial, UTC
  if (LISTS.has(k)) {
    if (!v) return "";
    try { return JSON.parse(v).map((x) => x?.name ?? x).join(", "); }   // current exports: JSON
    catch {   // older exports: Python lists
      const names = [...v.matchAll(/'name':\s*["']([^"']*)["']/g)].map((m) => m[1]);
      return (names.length ? names : [...v.matchAll(/'([^']*)'/g)].map((m) => m[1])).join(", ");
    }
  }
  return /^[=+-]/.test(v) ? ` ${v}` : v;   // never a formula
}

function fileName(rec) {
  const [, stem, ext] = rec.media_url.match(/\/([^/?]+)\.(\w+)(?:\?.*)?$/) || [, rec.id, "mp4"];
  const user = (rec.username || "").replace(/[^A-Za-z0-9._-]/g, "") || "unknown";
  return `${rec.created_at.slice(0, 10)}_${(rec.platform || "").toLowerCase()}_${user}_${stem}.${ext}`;
}

async function importCsv(sheetId, file) {
  const [cols, ...data] = parseCsv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  if (!cols?.includes("media_url")) throw new Error(`${file} is not a Refunnel export (no column media_url)`);
  const recs = data.filter((r) => r.length === cols.length).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  let { tab, head, rows, col } = await readSheet(sheetId);
  const missing = COLUMNS.filter((c) => col[c.label] < 0);
  if (missing.length) {   // an existing sheet: add our columns at the end, leave everything else as it is
    const need = head.length + missing.length - tab.gridProperties.columnCount;
    if (need > 0) await batch(sheetId, [{ appendDimension: { sheetId: tab.sheetId, dimension: "COLUMNS", length: need } }]);
    await api(values(sheetId, `${q(tab.title)}!${letter(head.length)}1`, "?valueInputOption=RAW"), { method: "PUT", body: JSON.stringify({ values: [missing.map((c) => c.label)] }) });
    ({ tab, head, rows, col } = await readSheet(sheetId));
  }
  const M = col["Media URL"], F = col["File Name"], L = col["Drive Link"], C = col["Created At"];
  const byUrl = new Map(rows.filter((r) => r[M]).map((r) => [r[M], r]));
  let added = 0;
  for (const rec of recs) {
    let row = byUrl.get(rec.media_url);
    if (!row) { added++; row = []; byUrl.set(rec.media_url, row); }
    for (const c of COLUMNS) if (c.from && c.from in rec) row[col[c.label]] = value(c.from, rec[c.from]);
    if (!row[F]) row[F] = fileName(rec);
    row[col.Month] = String(row[F]).slice(0, 7);
  }
  const all = [...rows.filter((r) => !r[M]), ...byUrl.values()].map((r) => head.map((_, i) => r[i] ?? ""))
    .sort((a, b) => (Number(b[C]) || 0) - (Number(a[C]) || 0));
  // more rows: insert them inside the used area, so banding, colours, dropdown and filter grow with it
  const extra = all.length + 1 - tab.gridProperties.rowCount;
  if (extra > 0) await batch(sheetId, [{ insertDimension: { range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: 2, endIndex: 2 + extra }, inheritFromBefore: true } }]);
  const end = letter(head.length - 1);
  for (let i = 0; i < all.length; i += 1000) {
    const part = all.slice(i, i + 1000), a = i + 2, b = i + 1 + part.length;
    await api(values(sheetId, `${q(tab.title)}!A${a}:${end}${b}`, "?valueInputOption=RAW"), { method: "PUT", body: JSON.stringify({ values: part }) });
    await api(values(sheetId, `${q(tab.title)}!${letter(L)}${a}:${letter(L)}${b}`, "?valueInputOption=USER_ENTERED"),   // links stay formulas
      { method: "PUT", body: JSON.stringify({ values: part.map((r) => [r[L]]) }) });
  }
  await batch(sheetId, dateAndDropdown(tab.sheetId, head));
  return `${recs.length} files in the export: ${recs.length - added} updated, ${added} new, ${all.length} rows in the sheet`;
}

// ---------- commands ----------
const out = (k, v) => console.log(`${k}=${v}`);
const [cmd, arg] = process.argv.slice(2);
const href = (v) => String(v || "").match(/https:\/\/drive\.google\.com\/[^"\s]+/)?.[0] || "";

if (cmd === "rclone-env") {
  const file = path.join(process.env.RUNNER_TEMP || ".", "google-key.json");
  fs.writeFileSync(file, JSON.stringify(key()), { mode: 0o600 });
  out("RCLONE_CONFIG_DRIVE_TYPE", "drive"); out("RCLONE_CONFIG_DRIVE_SCOPE", "drive");
  out("RCLONE_CONFIG_DRIVE_SERVICE_ACCOUNT_FILE", file);
  out("RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID", process.env.FOLDER_ID);
  if (process.env.DRIVE_ID) out("RCLONE_CONFIG_DRIVE_TEAM_DRIVE", process.env.DRIVE_ID);
  if (process.env.GOOGLE_SUBJECT) out("RCLONE_CONFIG_DRIVE_IMPERSONATE", process.env.GOOGLE_SUBJECT);
} else if (cmd === "resolve") {
  const folderId = id(process.env.FOLDER);
  if (!folderId) throw new Error("FOLDER is not set (Drive folder URL or ID)");
  const folder = await drive(`files/${folderId}`, { fields: "id,name,driveId,mimeType,capabilities(canAddChildren)" });
  if (folder.mimeType !== "application/vnd.google-apps.folder") throw new Error(`${folder.name} is not a folder`);
  if (!folder.capabilities.canAddChildren) throw new Error(`no write access to the folder "${folder.name}" - share it with the service account (Contributor or Editor)`);
  let sheetId = id(process.env.SHEET);
  if (!sheetId) sheetId = (await children(folderId, `name = ${q(TITLE)} and mimeType = 'application/vnd.google-apps.spreadsheet'`))[0]?.id;
  if (!sheetId) { sheetId = await createSheet(folderId); console.error(`created the sheet "${TITLE}"`); }
  const exports = (await children(folderId, `name = '_exports' and mimeType = 'application/vnd.google-apps.folder'`))[0];
  const csv = exports && (await children(exports.id, "mimeType != 'application/vnd.google-apps.folder'")).find((f) => /\.csv$/i.test(f.name));
  if (csv) {
    const res = await api(`${GAPI}/drive/v3/files/${csv.id}?alt=media&supportsAllDrives=true`, {}, true);
    fs.writeFileSync("export.csv", Buffer.from(await res.arrayBuffer()));
  }
  out("FOLDER_ID", folderId); out("DRIVE_ID", folder.driveId || ""); out("SHEET_ID", sheetId); out("EXPORT", csv?.name || "");
} else if (cmd === "import") {
  console.log(await importCsv(id(process.env.SHEET_ID), arg));
} else if (cmd === "pending" || cmd === "links") {
  const sheetId = id(process.env.SHEET_ID);
  const { tab, rows, col } = await readSheet(sheetId);
  if (col["Drive Link"] < 0 || col["File Name"] < 0) throw new Error("the sheet has no Drive Link / File Name column - run an import first");
  const L = col["Drive Link"], F = col["File Name"], U = col["Media URL"];
  if (cmd === "pending") {
    const todo = rows.filter((r) => !href(r[L]) && r[F] && r[U]);
    for (const r of arg ? todo.slice(0, Number(arg)) : todo) console.log(`${String(r[F]).slice(0, 7)}\t${r[F]}\t${r[U]}`);
    console.error(`${rows.length} rows, ${todo.length} without Drive Link`);
  } else {
    const ids = new Map(JSON.parse(fs.readFileSync(arg, "utf8")).map((f) => [f.Path.split("/").pop(), f.ID]));
    const link = (r) => href(r[L]) || (ids.has(r[F]) ? `https://drive.google.com/file/d/${ids.get(r[F])}/view` : "");
    const colValues = rows.map((r) => [link(r) ? `=HYPERLINK("${link(r)}","Open")` : ""]);
    await api(values(sheetId, `${q(tab.title)}!${letter(L)}2:${letter(L)}${rows.length + 1}`, "?valueInputOption=USER_ENTERED"),
      { method: "PUT", body: JSON.stringify({ values: colValues }) });
    console.log(`${rows.length} rows, ${colValues.filter((c) => c[0]).length} with Drive link, ${colValues.filter((c) => !c[0]).length} without`);
  }
} else {
  console.error("usage: node sync.mjs resolve | import <csv> | pending [limit] | links <files.json> | rclone-env");
  process.exit(1);
}
