/**
 * ===========================================================
 *  แจ้งเตือน LINE — รันโดย GitHub Actions ทุกเช้า
 * ===========================================================
 *  อ่านรายการส่วนตัวจาก Cloud Firestore (users/{OWNER_UID}/items)
 *  ผ่าน Firebase Admin SDK (service account — ข้าม security rules ได้)
 *  หา "รายการที่ใกล้ครบกำหนด/เลยกำหนด" แล้วส่งข้อความเข้า LINE
 *
 *  ต้องตั้ง GitHub Secret:
 *    - FIREBASE_SERVICE_ACCOUNT   (JSON ของ service account — จำเป็น)
 *    - OWNER_UID                  (UID ของเจ้าของข้อมูล — จำเป็น)
 *    - LINE_CHANNEL_ACCESS_TOKEN  (จำเป็น)
 *    - LINE_TARGET_USER_ID        (ไม่ใส่ก็ได้ -> ใช้ broadcast แทน push)
 *  ปรับได้ผ่าน env:
 *    - NOTIFY_THRESHOLD_DAYS      (ค่าเริ่มต้น 7 = เตือนล่วงหน้าถ้ารายการไม่ได้ตั้ง leadDays)
 * ===========================================================
 */

const admin = require('firebase-admin');

const OWNER_UID = process.env.OWNER_UID;
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

// ---------- เริ่ม Firebase Admin จาก service account ----------
function initAdmin() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('ยังไม่ได้ตั้งค่า FIREBASE_SERVICE_ACCOUNT');
  if (!OWNER_UID) throw new Error('ยังไม่ได้ตั้งค่า OWNER_UID');
  const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(cred) });
  return admin.firestore();
}

// ---------- อ่านรายการแจ้งเตือนของผู้ใช้ users/{uid}/items ----------
async function fetchItems(db, uid) {
  const snap = await db.collection('users').doc(uid).collection('items').get();
  return snap.docs.map(doc => {
    const d = doc.data() || {};
    return {
      name: d.name || '(ไม่มีชื่อ)',
      date: d.date || '',
      category: d.category || '',
      repeat: d.repeat || 'none',
      leadDays: typeof d.leadDays === 'number' ? d.leadDays : undefined,
      done: d.done === true,
    };
  });
}

// ---------- อ่านงานที่ต้องทำ users/{uid}/todos ----------
async function fetchTodos(db, uid) {
  const snap = await db.collection('users').doc(uid).collection('todos').get();
  return snap.docs.map(doc => {
    const d = doc.data() || {};
    return {
      text: d.text || '(ไม่มีชื่อ)',
      date: d.date || '',
      priority: typeof d.priority === 'number' ? d.priority : 4,
      done: d.done === true,
      archived: d.archived === true,
    };
  });
}

// ---------- อ่านรายชื่อผู้ใช้ที่เชื่อม LINE ไว้ (collection lineLinks) ----------
async function fetchLineTargets(db) {
  const snap = await db.collection('lineLinks').get();
  return snap.docs.map(doc => ({ lineUserId: doc.id, uid: (doc.data() || {}).uid }))
    .filter(t => t.uid);
}

// ---------- 3) ส่งข้อความ push หา userId เจาะจง ----------
async function pushLine(toUserId, message) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: toUserId, messages: [message] }),
  });
  if (!res.ok) throw new Error(`ส่ง LINE ไม่สำเร็จ (${res.status}): ${await res.text()}`);
}

// ไอคอนหมวดหมู่ (ให้ตรงกับในแอป)
const CAT_ICON = { vehicle:'🚗', document:'📄', service:'📱', device:'🔧', appointment:'📅' };
// สี + อิโมจิตามลำดับความสำคัญ (Eisenhower) ให้ตรงกับแอป
const PRI_EMOJI = { 1:'🔴', 2:'🟡', 3:'🔵', 4:'⚪' };
const PRI_COLOR = { 1:'#DC2626', 2:'#F59E0B', 3:'#3B82F6', 4:'#9CA3AF' };

// แถวรายการแจ้งเตือน (reminder)
function reminderRow(i, idx) {
  const color = i.d <= 3 ? '#DC2626' : '#F59E0B';              // แดง=ด่วน, เหลือง=ใกล้
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', margin: idx === 0 ? 'none' : 'md',
    contents: [
      { type: 'box', layout: 'vertical', width: '6px', cornerRadius: '3px',
        backgroundColor: color, contents: [{ type: 'filler' }] },
      { type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', contents: [
          { type: 'text', text: `${CAT_ICON[i.category] || '🔖'} ${i.name}`,
            weight: 'bold', size: 'sm', color: '#1F2937', wrap: true },
          { type: 'text', text: `ครบกำหนด ${formatThai(i.date)}`, size: 'xs', color: '#9CA3AF' },
      ]},
      { type: 'text', text: leftText(i.d), size: 'xs', weight: 'bold',
        color: color, align: 'end', gravity: 'center', flex: 0 },
    ],
  };
}

// แถวงานที่ต้องทำ (todo)
function todoRow(t, idx) {
  const color = PRI_COLOR[t.priority] || PRI_COLOR[4];
  const status = t.d < 0 ? `เลยกำหนด ${Math.abs(t.d)} วัน`
    : (t.d === 0 ? 'วันนี้' : (t.d === 1 ? 'พรุ่งนี้' : ''));
  const sub = [];
  if (t.date) sub.push({ type: 'text', text: `📅 ${formatThai(t.date)}`, size: 'xs', color: '#9CA3AF', flex: 1, gravity: 'center' });
  if (status) sub.push({ type: 'text', text: status, size: 'xs', weight: 'bold', color: color, align: 'end', gravity: 'center', flex: 0 });
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', margin: idx === 0 ? 'none' : 'md',
    contents: [
      { type: 'box', layout: 'vertical', width: '6px', cornerRadius: '3px',
        backgroundColor: color, contents: [{ type: 'filler' }] },
      { type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', contents: [
          { type: 'text', text: `${PRI_EMOJI[t.priority] || '⚪'} ${t.text}`,
            weight: 'bold', size: 'sm', color: '#1F2937', wrap: true },
          ...(sub.length ? [{ type: 'box', layout: 'horizontal', contents: sub }] : []),
      ]},
    ],
  };
}

// หัวข้อ section ในเนื้อข้อความ
function sectionTitle(text, margin) {
  return { type: 'text', text, weight: 'bold', size: 'sm', color: '#6B7280', margin: margin || 'none' };
}

// สร้าง Flex Message การ์ดสวยๆ (รวมแจ้งเตือน + งานที่ต้องทำวันนี้)
function buildFlex(due, todos, today) {
  const hasCritical = due.some(i => i.d <= 3) || todos.some(t => t.d <= 0 && t.priority <= 1);
  const headerColor = hasCritical ? '#DC2626' : '#2563EB';
  const subColor    = hasCritical ? '#FECACA' : '#DBEAFE';

  const body = [];

  if (todos.length) {
    body.push(sectionTitle(`📝 งานวันนี้ + พรุ่งนี้ (${todos.length})`));
    todos.forEach((t, idx) => {
      if (idx > 0) body.push({ type: 'separator', margin: 'md', color: '#F3F4F6' });
      body.push(todoRow(t, idx));
    });
  }

  if (due.length) {
    if (todos.length) body.push({ type: 'separator', margin: 'lg', color: '#E5E7EB' });
    body.push(sectionTitle(`🔔 ใกล้ครบกำหนด (${due.length})`, todos.length ? 'lg' : 'none'));
    due.forEach((i, idx) => {
      if (idx > 0) body.push({ type: 'separator', margin: 'md', color: '#F3F4F6' });
      body.push(reminderRow(i, idx));
    });
  }

  // ข้อความสรุปบนหัว
  const parts = [];
  if (todos.length) parts.push(`${todos.length} งาน`);
  if (due.length) parts.push(`${due.length} แจ้งเตือน`);
  const summary = parts.join(' · ');

  return {
    type: 'flex',
    altText: `🌤️ สรุปวันนี้: ${summary}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: headerColor, paddingAll: '16px', spacing: 'xs',
        contents: [
          { type: 'text', text: '🌤️ สรุปสิ่งที่ต้องทำวันนี้', color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: `${formatThai(today)} · ${summary}`, color: subColor, size: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'none', contents: body,
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: 'none',
        contents: [
          { type: 'button', style: 'primary', color: headerColor, height: 'sm',
            action: { type: 'uri', label: '📱 เปิดแอป', uri: 'https://taokam1993.github.io/expiry-reminder-app/' } },
        ],
      },
    },
  };
}

// สร้าง+ส่งแจ้งเตือนของผู้ใช้ 1 คน — คืน true ถ้าส่งจริง
async function notifyOne(db, today, uid, lineUserId) {
  const [items, todosRaw] = await Promise.all([fetchItems(db, uid), fetchTodos(db, uid)]);

  const due = items
    .filter(i => i.date && !i.done)
    .map(i => ({ ...i, d: daysLeft(i.date, today), lead: i.leadDays || THRESHOLD_DAYS }))
    .filter(i => i.d <= i.lead)
    .sort((a, b) => a.d - b.d);

  const todos = todosRaw
    .filter(t => t.date && !t.done && !t.archived)
    .map(t => ({ ...t, d: daysLeft(t.date, today) }))
    .filter(t => t.d <= 1)
    .sort((a, b) => a.d - b.d || a.priority - b.priority);

  if (due.length === 0 && todos.length === 0) return false;
  await pushLine(lineUserId, buildFlex(due, todos, today));
  console.log(`  → ${lineUserId.slice(0, 8)}… : ${todos.length} งาน, ${due.length} แจ้งเตือน`);
  return true;
}

// ---------- main ----------
(async function main() {
  if (!LINE_TOKEN) throw new Error('ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN');

  const today = todayBangkok();
  const db = initAdmin();

  // รวมเป้าหมาย: เจ้าของ (จาก env) + ทุกคนที่เชื่อม LINE ไว้ (lineLinks) — ไม่ส่งซ้ำ
  const targets = [];
  if (OWNER_UID && LINE_USER_ID) targets.push({ uid: OWNER_UID, lineUserId: LINE_USER_ID });
  for (const t of await fetchLineTargets(db)) {
    if (!targets.some(x => x.lineUserId === t.lineUserId)) targets.push(t);
  }

  if (targets.length === 0) {
    console.log('ยังไม่มีผู้ใช้ที่เชื่อม LINE');
    return;
  }

  let sent = 0;
  for (const t of targets) {
    try { if (await notifyOne(db, today, t.uid, t.lineUserId)) sent++; }
    catch (err) { console.error(`  ✗ ${t.lineUserId.slice(0, 8)}… : ${err.message}`); }
  }
  console.log(`เสร็จ: ส่ง ${sent}/${targets.length} คน (${today})`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
