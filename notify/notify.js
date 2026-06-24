/**
 * ===========================================================
 *  แจ้งเตือน LINE — รันโดย GitHub Actions ทุกเช้า
 * ===========================================================
 *  อ่านรายการจาก Cloud Firestore (ผ่าน REST + anonymous auth)
 *  หา "รายการที่ใกล้ครบกำหนด/เลยกำหนด" แล้วส่งข้อความเข้า LINE
 *
 *  ไม่ต้องใช้ service account — ใช้ Web API key (public) ขอ idToken
 *  แบบ anonymous แล้วอ่าน Firestore (security rules อนุญาต auth != null)
 *
 *  ต้องตั้ง GitHub Secret:
 *    - LINE_CHANNEL_ACCESS_TOKEN  (จำเป็น)
 *    - LINE_TARGET_USER_ID        (ไม่ใส่ก็ได้ -> ใช้ broadcast แทน push)
 *  ปรับได้ผ่าน env:
 *    - NOTIFY_THRESHOLD_DAYS      (ค่าเริ่มต้น 7 = เตือนล่วงหน้า 7 วัน)
 * ===========================================================
 */

// ---- ค่าคงที่ของโปรเจกต์ (เป็นข้อมูล public ของ Firebase web app) ----
const FIREBASE_API_KEY = 'AIzaSyB3dVyD8dQ5sdJ4XvmpNcXIrCPnRNk5FOU';
const FIREBASE_PROJECT_ID = 'reminder-app-5e30a';

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_TARGET_USER_ID || '';
const THRESHOLD_DAYS = parseInt(process.env.NOTIFY_THRESHOLD_DAYS || '7', 10);

const THAI_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

// ---------- helper: วันที่ ----------
function todayBangkok() {
  // en-CA ให้รูปแบบ YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}
function daysLeft(dateStr, today) {
  const a = Date.UTC(...dateStr.split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v));
  const b = Date.UTC(...today.split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v));
  return Math.round((a - b) / 86400000);
}
function formatThai(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
}
function leftText(d) {
  if (d < 0) return `เลยกำหนด ${Math.abs(d)} วัน`;
  if (d === 0) return 'ครบกำหนดวันนี้';
  return `เหลือ ${d} วัน`;
}

// ---------- 1) ขอ idToken แบบ anonymous ----------
async function getIdToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }) }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error('ขอ idToken ไม่สำเร็จ: ' + JSON.stringify(data));
  return data.idToken;
}

// ---------- 2) อ่าน collection "items" ผ่าน Firestore REST ----------
async function fetchItems(idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/items?pageSize=300`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  const data = await res.json();
  if (data.error) throw new Error('อ่าน Firestore ไม่สำเร็จ: ' + JSON.stringify(data.error));
  const docs = data.documents || [];
  return docs.map(doc => {
    const f = doc.fields || {};
    const get = (k) => {
      const v = f[k];
      if (!v) return undefined;
      if ('stringValue' in v) return v.stringValue;
      if ('booleanValue' in v) return v.booleanValue;
      if ('integerValue' in v) return Number(v.integerValue);
      return undefined;
    };
    return {
      name: get('name') || '(ไม่มีชื่อ)',
      date: get('date') || '',
      repeat: get('repeat') || 'none',
      done: get('done') === true,
    };
  });
}

// ---------- 3) ส่งข้อความเข้า LINE ----------
async function sendLine(text) {
  const endpoint = LINE_USER_ID
    ? 'https://api.line.me/v2/bot/message/push'
    : 'https://api.line.me/v2/bot/message/broadcast';
  const body = LINE_USER_ID
    ? { to: LINE_USER_ID, messages: [{ type: 'text', text }] }
    : { messages: [{ type: 'text', text }] };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ส่ง LINE ไม่สำเร็จ (${res.status}): ${await res.text()}`);
}

// ---------- main ----------
(async function main() {
  if (!LINE_TOKEN) throw new Error('ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN');

  const today = todayBangkok();
  const idToken = await getIdToken();
  const items = await fetchItems(idToken);

  // หาเฉพาะที่ยังไม่ทำเสร็จ และใกล้ครบกำหนด/เลยกำหนด
  const due = items
    .filter(i => i.date && !i.done && daysLeft(i.date, today) <= THRESHOLD_DAYS)
    .map(i => ({ ...i, d: daysLeft(i.date, today) }))
    .sort((a, b) => a.d - b.d);

  if (due.length === 0) {
    console.log('ไม่มีรายการที่ต้องแจ้งเตือนวันนี้ (' + today + ')');
    return;
  }

  const lines = due.map(i => {
    const emoji = i.d <= 3 ? '🔴' : '🟡';
    return `${emoji} ${i.name} — ${leftText(i.d)} (${formatThai(i.date)})`;
  });
  const text = `🔔 แจ้งเตือนรายการใกล้ครบกำหนด\n\n${lines.join('\n')}\n\n📱 ดูทั้งหมด: https://taokam1993.github.io/expiry-reminder-app/`;

  await sendLine(text);
  console.log(`ส่งแจ้งเตือน ${due.length} รายการเรียบร้อย (${today})`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
