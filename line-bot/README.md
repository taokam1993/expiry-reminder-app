# LINE → To-Do bot (Cloudflare Worker)

พิมพ์ข้อความใน LINE แล้วบอทเพิ่มงานลง **📝 งานที่ต้องทำ** ในแอปให้อัตโนมัติ

ตัวอย่างที่พิมพ์ได้:
- `ซื้อนม` → งานไม่มีกำหนด
- `ส่งรายงาน พรุ่งนี้` → งานพรุ่งนี้
- `ประชุม วันศุกร์` → งานวันศุกร์ที่ใกล้สุด
- `จ่ายบิล 30/6` → งานวันที่ 30 มิ.ย.
- `ด่วน โทรหาลูกค้า วันนี้` → งานวันนี้ ความสำคัญ 🔴
- พิมพ์ `งาน` → ดูงานวันนี้+พรุ่งนี้ ที่ค้างอยู่
- พิมพ์ `ช่วย` → ดูวิธีใช้

---

## ขั้นตอน Deploy (ทำครั้งเดียว)

### 1. ติดตั้ง Wrangler (เครื่องมือ Cloudflare)
```bash
npm install -g wrangler
wrangler login          # เปิดเบราว์เซอร์ให้ล็อกอิน Cloudflare (สมัครฟรี ไม่ต้องใส่บัตร)
```

### 2. ตั้งค่า Secret (อยู่ในโฟลเดอร์ line-bot/)
```bash
cd line-bot

wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
# วาง Channel access token (อันเดียวกับที่ใช้ใน GitHub Actions)

wrangler secret put LINE_CHANNEL_SECRET
# หาได้จาก LINE Developers Console > ช่อง Messaging API ของคุณ
#   > แท็บ "Basic settings" > Channel secret

wrangler secret put FIREBASE_SERVICE_ACCOUNT
# วาง JSON ของ service account ทั้งก้อน (อันเดียวกับ GitHub Secret)

wrangler secret put OWNER_UID
# UID เจ้าของข้อมูล (เหมือนใน GitHub Actions)

wrangler secret put OWNER_LINE_USER_ID
# (ไม่บังคับ) userId LINE ของคุณ — ใส่เพื่อกันคนอื่นมาสั่งบอท
```

### 3. Deploy
```bash
wrangler deploy
```
จะได้ URL แบบ `https://line-todo-bot.<ชื่อ>.workers.dev`

### 4. ตั้ง Webhook ใน LINE
ไปที่ **LINE Developers Console > ช่อง Messaging API > แท็บ Messaging API**:
1. **Webhook URL** = ใส่ URL ของ Worker ที่ได้จากข้อ 3
2. กด **Verify** ให้ขึ้น Success
3. เปิด **Use webhook** = ✅
4. ปิด **Auto-reply messages** และ **Greeting messages** (ไม่งั้นจะตอบซ้ำ)

เสร็จแล้ว! ลองพิมพ์ `ซื้อนม พรุ่งนี้` ในแชต OA ดู

---

## หา OWNER_LINE_USER_ID ของตัวเอง
ถ้ายังไม่รู้ userId ของตัวเอง: ลอง deploy โดยยังไม่ตั้ง `OWNER_LINE_USER_ID`,
แล้วทักหาบอท 1 ครั้ง — ดู log ด้วย `wrangler tail` จะเห็น `source.userId`
จากนั้นค่อยตั้ง secret แล้ว deploy ใหม่

## แก้ไข/อัปเดตบอท
แก้ `worker.js` แล้วสั่ง `wrangler deploy` อีกครั้ง

## ดู log สด
```bash
wrangler tail
```
