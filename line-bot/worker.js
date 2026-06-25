/**
 * ===========================================================
 *  LINE → To-Do bot (Cloudflare Worker)
 * ===========================================================
 *  พิมพ์ข้อความใน LINE แล้วบอทเพิ่มงานลง Firestore ให้อัตโนมัติ
 *  - รับ webhook จาก LINE Messaging API
 *  - ตรวจลายเซ็น (X-Line-Signature) ด้วย Channel secret
 *  - แยก "วันที่" + "ความสำคัญ" จากข้อความภาษาไทย
 *  - เขียนลง users/{OWNER_UID}/todos ผ่าน Firestore REST (service account)
 *  - ตอบกลับยืนยันในแชต
 *
 *  ต้องตั้งค่า Secret/Var ของ Worker (ดู README.md):
 *    LINE_CHANNEL_ACCESS_TOKEN  (จำเป็น)
 *    LINE_CHANNEL_SECRET        (จำเป็น — ใช้ตรวจลายเซ็น)
 *    FIREBASE_SERVICE_ACCOUNT   (JSON service account — จำเป็น)
 *    OWNER_UID                  (UID เจ้าของข้อมูลใน Firestore — จำเป็น)
 *    OWNER_LINE_USER_ID         (ไม่บังคับ — ถ้าใส่ จะรับเฉพาะข้อความจากคนนี้)
 * ===========================================================
 */

const enc = new TextEncoder();

// ---------- ค่าคงที่ ----------
const THAI_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const THAI_DOW = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
const PRI_EMOJI = { 1:'🔴', 2:'🟡', 3:'🔵', 4:'⚪' };

// ===========================================================
//  ENTRYPOINT
// ===========================================================
export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return new Response('LINE To-Do bot is running ✅', { status: 200 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = await request.text();

    // 1) ตรวจลายเซ็นจาก LINE
    const signature = request.headers.get('x-line-signature') || '';
    const valid = await verifySignature(body, signature, env.LINE_CHANNEL_SECRET);
    if (!valid) return new Response('Bad signature', { status: 401 });

    let payload;
    try { payload = JSON.parse(body); } catch { return new Response('Bad JSON', { status: 400 }); }

    // 2) ประมวลผลทุก event (ตอบ LINE ให้เร็ว — ใช้ waitUntil ก็ได้ แต่ที่นี่รอเลยเพื่อความง่าย)
    const events = payload.events || [];
    for (const ev of events) {
      try { await handleEvent(ev, env); }
      catch (err) { console.error('handleEvent error:', err); }
    }
    return new Response('OK', { status: 200 });
  },
};

// ===========================================================
//  จัดการ event เดียว
// ===========================================================
async function handleEvent(ev, env) {
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  const lineUserId = ev.source && ev.source.userId;
  const text = (ev.message.text || '').trim();
  if (!text) return;

  const token = await getAccessToken(env);

  // ---- คำสั่งเชื่อมบัญชี: "เชื่อม 12345" ----
  const linkM = text.match(/^เชื่อม\s*(\d{4,8})$/);
  if (linkM) {
    await reply(ev.replyToken, await handleLink(env, token, lineUserId, linkM[1]), env);
    return;
  }

  // ---- ช่วยเหลือ (ใช้ได้แม้ยังไม่เชื่อม) ----
  if (/^(ช่วย|help|วิธีใช้|\?)$/i.test(text)) {
    await reply(ev.replyToken, helpText(), env);
    return;
  }

  // ---- ต้องเชื่อมบัญชีก่อนถึงจะใช้ได้ ----
  const uid = await resolveUid(env, token, lineUserId);
  if (!uid) {
    await reply(ev.replyToken, linkPrompt(), env);
    return;
  }

  // ---- ดูงานวันนี้ ----
  if (/^(งาน|รายการ|วันนี้|งานวันนี้|todo)$/i.test(text)) {
    await reply(ev.replyToken, await listTodos(env, token, uid), env);
    return;
  }

  // ---- เพิ่มงานใหม่ ----
  const today = todayBangkok();
  const { date, priority, name } = parseTask(text, today);
  if (!name) {
    await reply(ev.replyToken, '❓ ไม่เข้าใจ พิมพ์ "ช่วย" เพื่อดูวิธีใช้', env);
    return;
  }

  await addTodo(env, token, uid, { text: name, date, priority });

  const lines = [
    '✅ เพิ่มงานแล้ว',
    `${PRI_EMOJI[priority]} ${name}`,
  ];
  if (date) lines.push(`📅 ${formatThai(date)} (${dayPhrase(date, today)})`);
  else lines.push('📌 ไม่มีกำหนด');
  await reply(ev.replyToken, lines.join('\n'), env);
}

// ===========================================================
//  เชื่อมบัญชี: resolve uid จาก lineUserId / ผูกด้วยโค้ด
// ===========================================================
function fsBase(env) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  return `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
}
async function fsGet(env, token, path) {
  const res = await fetch(`${fsBase(env)}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fsGet ${path} (${res.status})`);
  return (await res.json()).fields || {};
}
async function fsPatch(env, token, path, fields, maskFields) {
  let url = `${fsBase(env)}/${path}`;
  if (maskFields) url += '?' + maskFields.map(f => `updateMask.fieldPaths=${f}`).join('&');
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`fsPatch ${path} (${res.status}): ${await res.text()}`);
}
async function fsDelete(env, token, path) {
  await fetch(`${fsBase(env)}/${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
}

async function resolveUid(env, token, lineUserId) {
  if (!lineUserId) return null;
  const f = await fsGet(env, token, `lineLinks/${lineUserId}`);
  return f && f.uid ? f.uid.stringValue : null;
}

async function handleLink(env, token, lineUserId, code) {
  if (!lineUserId) return '⛔ อ่านบัญชี LINE ของคุณไม่ได้';
  const f = await fsGet(env, token, `linkCodes/${code}`);
  if (!f || !f.uid) return '❌ โค้ดไม่ถูกต้อง\nเปิดแอป > รูปโปรไฟล์ > เชื่อม LINE เพื่อรับโค้ดใหม่';
  const exp = f.exp ? Number(f.exp.integerValue || f.exp.doubleValue || 0) : 0;
  if (exp && Date.now() > exp) {
    await fsDelete(env, token, `linkCodes/${code}`);
    return '⌛ โค้ดหมดอายุแล้ว\nสร้างโค้ดใหม่ในแอปแล้วลองอีกครั้ง';
  }
  const uid = f.uid.stringValue;
  await fsPatch(env, token, `lineLinks/${lineUserId}`, {
    uid: { stringValue: uid }, linkedAt: { stringValue: new Date().toISOString() },
  });
  await fsPatch(env, token, `users/${uid}/meta/app`,
    { lineLinked: { booleanValue: true }, lineUserId: { stringValue: lineUserId } },
    ['lineLinked', 'lineUserId']);
  await fsDelete(env, token, `linkCodes/${code}`);
  return '✅ เชื่อมบัญชีสำเร็จ!\nพิมพ์งานได้เลย เช่น "ซื้อนม พรุ่งนี้"\nหรือพิมพ์ "ช่วย" ดูวิธีใช้';
}

function linkPrompt() {
  return [
    '🔗 ยังไม่ได้เชื่อมบัญชี',
    '',
    'วิธีเชื่อม:',
    '1. เปิดแอป "จดจ่อ"',
    '2. แตะรูปโปรไฟล์ (มุมขวาบน) → เชื่อม LINE',
    '3. กดสร้างโค้ด แล้วพิมพ์ในแชตนี้',
    '   เช่น  เชื่อม 12345',
  ].join('\n');
}

// ===========================================================
//  แยกข้อความ -> { date, priority, name }
// ===========================================================
function parseTask(raw, today) {
  let text = raw;
  let priority = 4;

  // ความสำคัญจากคำว่า ด่วน / สำคัญ
  if (/ด่วน\s*มาก|สำคัญ\s*และ\s*ด่วน/.test(text)) priority = 1;
  else if (/ด่วน/.test(text)) priority = 1;
  else if (/สำคัญ/.test(text)) priority = 2;
  text = text.replace(/ด่วนมาก|สำคัญและด่วน|ด่วน|สำคัญ/g, ' ');

  // วันที่
  let date = '';

  // 1) คำบอกวันแบบสัมพัทธ์
  const rel = [
    [/วันนี้/, 0],
    [/พรุ่ง\s*นี้|พรุ้งนี้/, 1],
    [/มะรืน\s*นี้|มะรืน/, 2],
  ];
  for (const [re, n] of rel) {
    if (re.test(text)) { date = addDays(today, n); text = text.replace(re, ' '); break; }
  }

  // 2) ชื่อวัน (วันจันทร์ ... อาทิตย์) -> วันถัดไปที่ใกล้สุด (รวมวันนี้)
  if (!date) {
    for (let i = 0; i < THAI_DOW.length; i++) {
      const re = new RegExp('(วัน)?' + THAI_DOW[i]);
      if (re.test(text)) {
        const todayDow = new Date(today + 'T00:00:00Z').getUTCDay();
        const diff = (i - todayDow + 7) % 7;
        date = addDays(today, diff);
        text = text.replace(re, ' ');
        break;
      }
    }
  }

  // 3) วันที่ชัดเจน DD/MM หรือ DD-MM
  if (!date) {
    const m = text.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (m) {
      const d = +m[1], mo = +m[2];
      let y = m[3] ? +m[3] : +today.slice(0, 4);
      if (y > 2400) y -= 543;            // เผื่อกรอกปี พ.ศ.
      if (y < 100) y += 2000;
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
        let cand = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        if (!m[3] && cand < today) cand = `${y+1}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        date = cand;
        text = text.replace(m[0], ' ');
      }
    }
  }

  const name = text.replace(/\s+/g, ' ').trim();
  return { date, priority, name };
}

// ===========================================================
//  Firestore: เพิ่ม todo / อ่าน todo
// ===========================================================
async function addTodo(env, token, uid, { text, date, priority }) {
  const url = `${fsBase(env)}/users/${uid}/todos`;
  const fields = {
    text:      { stringValue: text },
    date:      { stringValue: date || '' },
    priority:  { integerValue: String(priority || 4) },
    done:      { booleanValue: false },
    archived:  { booleanValue: false },
    createdAt: { stringValue: new Date().toISOString() },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Firestore add failed (${res.status}): ${await res.text()}`);
}

async function listTodos(env, token, uid) {
  const url = `${fsBase(env)}/users/${uid}/todos?pageSize=300`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Firestore list failed (${res.status})`);
  const data = await res.json();
  const today = todayBangkok();
  const todos = (data.documents || []).map(doc => {
    const f = doc.fields || {};
    return {
      text: f.text?.stringValue || '(ไม่มีชื่อ)',
      date: f.date?.stringValue || '',
      priority: f.priority?.integerValue ? +f.priority.integerValue : 4,
      done: f.done?.booleanValue === true,
      archived: f.archived?.booleanValue === true,
    };
  });
  // ครบกำหนดวันนี้/พรุ่งนี้/เลยกำหนด ที่ยังไม่เสร็จ (ไม่รวมที่เก็บเข้าประวัติ)
  const due = todos
    .filter(t => !t.done && !t.archived && t.date && t.date <= addDays(today, 1))
    .sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority);
  if (!due.length) return '🎉 วันนี้ไม่มีงานค้าง';
  const lines = ['📝 งานวันนี้ + พรุ่งนี้'];
  for (const t of due) {
    lines.push(`${PRI_EMOJI[t.priority]} ${t.text} — ${dayPhrase(t.date, today)}`);
  }
  return lines.join('\n');
}

// ===========================================================
//  Google OAuth: เซ็น JWT จาก service account -> access token
//  (cache ไว้ในหน่วยความจำของ isolate จนกว่าจะหมดอายุ)
// ===========================================================
let _tokenCache = { token: '', exp: 0 };

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache.token && _tokenCache.exp > now + 60) return _tokenCache.token;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(sa.private_key);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
  const jwt = `${unsigned}.${b64urlBytes(new Uint8Array(sigBuf))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  const out = await res.json();
  _tokenCache = { token: out.access_token, exp: now + (out.expires_in || 3600) };
  return _tokenCache.token;
}

async function importPrivateKey(pem) {
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----/, '')
                   .replace(/-----END PRIVATE KEY-----/, '')
                   .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// ===========================================================
//  LINE: ตรวจลายเซ็น + ตอบกลับ
// ===========================================================
async function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return b64bytes(new Uint8Array(mac)) === signature;
}

async function reply(replyToken, text, env) {
  if (!replyToken) return;
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) console.error('LINE reply failed:', res.status, await res.text());
}

// ===========================================================
//  helper: วันที่
// ===========================================================
function todayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function formatThai(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
}
function dayPhrase(ymd, today) {
  const diff = Math.round((Date.UTC(...ymd.split('-').map((v,i)=>i===1?+v-1:+v)) -
                           Date.UTC(...today.split('-').map((v,i)=>i===1?+v-1:+v))) / 86400000);
  if (diff < 0) return `เลยกำหนด ${Math.abs(diff)} วัน`;
  if (diff === 0) return 'วันนี้';
  if (diff === 1) return 'พรุ่งนี้';
  return `อีก ${diff} วัน`;
}

// ===========================================================
//  helper: base64 / base64url
// ===========================================================
function b64bytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64urlBytes(bytes) {
  return b64bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ===========================================================
//  ข้อความช่วยเหลือ
// ===========================================================
function helpText() {
  return [
    '🤖 วิธีใช้บอทเพิ่มงาน',
    '',
    'พิมพ์ชื่องานได้เลย เช่น',
    '• ซื้อนม',
    '• ส่งรายงาน พรุ่งนี้',
    '• ประชุม วันศุกร์',
    '• จ่ายบิล 30/6',
    '• ด่วน โทรหาลูกค้า วันนี้',
    '',
    'คำบอกวัน: วันนี้ / พรุ่งนี้ / มะรืน / วันจันทร์–อาทิตย์ / 30/6',
    'ความสำคัญ: ใส่ "ด่วน" = 🔴 , "สำคัญ" = 🟡',
    '',
    'พิมพ์ "งาน" = ดูงานวันนี้+พรุ่งนี้',
    '',
    '🔗 ยังไม่ได้เชื่อมบัญชี? เปิดแอป > รูปโปรไฟล์ > เชื่อม LINE แล้วพิมพ์ "เชื่อม " ตามด้วยโค้ด',
  ].join('\n');
}
