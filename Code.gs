/**
 * ===========================================================
 *  Backend: ระบบแจ้งเตือนวันหมดอายุและนัดหมาย
 *  Google Apps Script + Google Sheets เป็นฐานข้อมูล
 * ===========================================================
 *
 *  วิธีติดตั้ง (ทำครั้งเดียว):
 *  ------------------------------------------------------------
 *  1. สร้าง Google Sheet ใหม่ 1 ไฟล์
 *  2. ตั้งชื่อแท็บ (Sheet) ล่างซ้ายเป็น:  Data
 *  3. ใส่หัวคอลัมน์แถวแรก (Row 1) ให้ตรงเป๊ะตามนี้ (A1 ถึง F1):
 *
 *        A1: id
 *        B1: name
 *        C1: category
 *        D1: date
 *        E1: repeat
 *        F1: note
 *        G1: image
 *        H1: createdAt
 *
 *     หมายเหตุ:
 *       - date เก็บรูปแบบข้อความ YYYY-MM-DD (แนะนำให้ตั้ง format
 *         คอลัมน์ D เป็น "Plain text" กันไม่ให้ Sheets แปลงเป็น Date)
 *       - category ใช้ค่า: vehicle | document | service | appointment
 *       - repeat ใช้ค่า: none (ไม่ทำซ้ำ) | yearly (ทำซ้ำทุกปี)
 *       - note: ข้อความโน้ต (ไม่บังคับ)
 *       - image: รูปแบบ data URL (base64). หมายเหตุ: เซลล์ Google Sheets
 *         จำกัด ~50,000 ตัวอักษร ถ้ารูปใหญ่อาจเกิน — โหมด Firebase ไม่มีปัญหานี้
 *
 *  4. เมนู Extensions > Apps Script  แล้ววางโค้ดไฟล์นี้ทับ Code.gs
 *  5. กด Deploy > New deployment
 *        - Select type: Web app
 *        - Execute as: Me
 *        - Who has access: Anyone   (สำคัญ! ไม่งั้น fetch จากหน้าเว็บไม่ได้)
 *  6. คัดลอก Web app URL ที่ได้ ไปวางในตัวแปร GAS_URL ใน index.html
 *
 *  *** ทุกครั้งที่แก้โค้ดนี้ ต้อง Deploy > Manage deployments >
 *      edit (ดินสอ) > Version: New version > Deploy ***
 * ===========================================================
 */

var SHEET_NAME = 'Data';
var HEADERS = ['id', 'name', 'category', 'date', 'repeat', 'note', 'image', 'createdAt'];

/* -----------------------------------------------------------
 *  GET  -> ใช้สำหรับ "อ่านข้อมูลทั้งหมด"  (action=list)
 * --------------------------------------------------------- */
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'list';
    if (action === 'list') {
      return json({ ok: true, data: getAllItems() });
    }
    return json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* -----------------------------------------------------------
 *  POST -> ใช้สำหรับ add / update / delete
 *  ส่ง body เป็น JSON: { action, payload }
 *
 *  หมายเหตุ: เราใช้ POST แบบ text/plain เพื่อเลี่ยง CORS preflight
 *  (ฝั่ง frontend จะส่ง Content-Type: text/plain;charset=utf-8)
 * --------------------------------------------------------- */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var payload = body.payload || {};

    if (action === 'add')    return json({ ok: true, data: addItem(payload) });
    if (action === 'update') return json({ ok: true, data: updateItem(payload.id, payload) });
    if (action === 'delete') { deleteItem(payload.id); return json({ ok: true }); }

    return json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ===========================================================
 *  CRUD helpers
 * =========================================================== */

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    // สร้างแท็บให้อัตโนมัติถ้ายังไม่มี
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function getAllItems() {
  var sheet = getSheet();
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return []; // มีแต่หัวตาราง

  var rows = values.slice(1); // ตัดแถวหัวออก
  return rows
    .filter(function (r) { return r[0] !== '' && r[0] !== null; }) // ข้ามแถวว่าง
    .map(function (r) {
      return {
        id:        String(r[0]),
        name:      String(r[1]),
        category:  String(r[2]),
        date:      normalizeDate(r[3]),
        repeat:    r[4] ? String(r[4]) : 'none',
        note:      r[5] ? String(r[5]) : '',
        image:     r[6] ? String(r[6]) : '',
        createdAt: r[7] ? String(r[7]) : '',
      };
    });
}

function addItem(item) {
  var sheet = getSheet();
  var record = {
    id: Utilities.getUuid(),
    name: item.name || '',
    category: item.category || '',
    date: item.date || '',
    repeat: item.repeat || 'none',
    note: item.note || '',
    image: item.image || '',
    createdAt: new Date().toISOString(),
  };
  sheet.appendRow([record.id, record.name, record.category, record.date,
                   record.repeat, record.note, record.image, record.createdAt]);
  return record;
}

function updateItem(id, data) {
  var sheet = getSheet();
  var rowIndex = findRowById(sheet, id);
  if (rowIndex === -1) throw new Error('ไม่พบรายการ id: ' + id);

  // อัปเดต name, category, date, repeat, note, image (คอลัมน์ B–G)
  sheet.getRange(rowIndex, 2).setValue(data.name);
  sheet.getRange(rowIndex, 3).setValue(data.category);
  sheet.getRange(rowIndex, 4).setValue(data.date);
  sheet.getRange(rowIndex, 5).setValue(data.repeat || 'none');
  sheet.getRange(rowIndex, 6).setValue(data.note || '');
  sheet.getRange(rowIndex, 7).setValue(data.image || '');

  var row = sheet.getRange(rowIndex, 1, 1, HEADERS.length).getValues()[0];
  return {
    id: String(row[0]), name: String(row[1]), category: String(row[2]),
    date: normalizeDate(row[3]), repeat: String(row[4]),
    note: String(row[5]), image: String(row[6]), createdAt: String(row[7]),
  };
}

function deleteItem(id) {
  var sheet = getSheet();
  var rowIndex = findRowById(sheet, id);
  if (rowIndex !== -1) sheet.deleteRow(rowIndex);
}

/* ===========================================================
 *  Utilities
 * =========================================================== */

// คืนเลขแถวจริงใน Sheet (1-based) ของ id ที่ตรงกัน, ไม่เจอคืน -1
function findRowById(sheet, id) {
  var ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  for (var i = 1; i < ids.length; i++) { // เริ่ม 1 เพื่อข้ามหัวตาราง
    if (String(ids[i][0]) === String(id)) return i + 1; // +1 เพราะ getRange เป็น 1-based
  }
  return -1;
}

// ถ้า Sheets เผลอแปลง date เป็น Date object ให้แปลงกลับเป็น YYYY-MM-DD
function normalizeDate(val) {
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = String(val.getMonth() + 1).padStart(2, '0');
    var d = String(val.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  return String(val);
}

// helper สร้าง JSON response
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
