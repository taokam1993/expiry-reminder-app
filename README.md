# ระบบแจ้งเตือนวันหมดอายุและนัดหมาย (PWA)

แอปจัดการและแจ้งเตือนวันหมดอายุ — ติดตั้งลงโฮมสกรีนได้ทั้งมือถือและคอมพิวเตอร์ เปิดเต็มจอเหมือนแอปจริง และเปิดใช้งานได้แม้ออฟไลน์

## โครงสร้างไฟล์

```
expiry-reminder-app/
├── index.html              หน้าแอปหลัก (Frontend)
├── manifest.webmanifest    ข้อมูลแอปสำหรับติดตั้ง (ชื่อ, ไอคอน, สีธีม)
├── sw.js                   Service Worker (ทำงานออฟไลน์)
├── icons/                  ไอคอนแอปขนาดต่างๆ
├── Code.gs                 Backend ทางเลือก (Google Apps Script)
├── notify/notify.js        สคริปต์แจ้งเตือน LINE (อ่าน Firestore -> ส่ง LINE)
└── .github/workflows/      GitHub Actions: รัน notify.js ทุกเช้า 08:00 น.
```

## แจ้งเตือนอัตโนมัติเข้า LINE (Messaging API)

GitHub Actions จะรัน `notify/notify.js` ทุกเช้า 08:00 (เวลาไทย) อ่านรายการจาก Firestore
แล้วส่งข้อความ LINE เฉพาะรายการที่ใกล้ครบกำหนด (ภายใน 7 วัน) หรือเลยกำหนดแล้ว

**ตั้งค่า GitHub Secret ที่ต้องมี:**
- `LINE_CHANNEL_ACCESS_TOKEN` — Channel access token จาก LINE Developers Console (จำเป็น)
- `LINE_TARGET_USER_ID` — (ไม่ใส่ก็ได้) ถ้าใส่ = ส่งแบบ push หา userId นั้น, ถ้าไม่ใส่ = broadcast หาเพื่อนทุกคนของ OA

**ทดสอบ/สั่งรันเอง:** แท็บ Actions บน GitHub > เลือก workflow "แจ้งเตือน LINE (รายวัน)" > Run workflow
หรือใช้ `gh workflow run notify.yml`

> หมายเหตุ: สคริปต์อ่าน Firestore ผ่าน REST + anonymous auth (ใช้ Web API key ที่เป็น public)
> จึงไม่ต้องใช้ service account — ต้องเปิด Anonymous sign-in และ rules อนุญาต `read: if request.auth != null`

## ⚠️ สำคัญ: PWA ต้องเปิดผ่าน "เซิร์ฟเวอร์"

การดับเบิลคลิก `index.html` (เปิดแบบ `file://`) **จะติดตั้งเป็นแอปไม่ได้** และ Service Worker จะไม่ทำงาน
ต้องเปิดผ่าน `http://localhost` หรือโฮสต์บนเว็บจริง โดยเลือกวิธีใดวิธีหนึ่ง:

### วิธีที่ 1 — Python (ถ้ามีติดตั้งอยู่แล้ว)
```bash
cd expiry-reminder-app
python -m http.server 8000
```
แล้วเปิดเบราว์เซอร์ไปที่ `http://localhost:8000`

### วิธีที่ 2 — Node.js
```bash
cd expiry-reminder-app
npx serve
```

### วิธีที่ 3 — VS Code
ติดตั้งส่วนเสริม **Live Server** แล้วคลิกขวาที่ `index.html` > *Open with Live Server*

## วิธีติดตั้งเป็นแอป

- **คอมพิวเตอร์ (Chrome/Edge):** เปิดเว็บแล้วกดไอคอน "ติดตั้ง" (⊕) ที่แถบ URL
- **Android (Chrome):** เมนู ⋮ > *เพิ่มลงในหน้าจอหลัก / ติดตั้งแอป*
- **iPhone (Safari):** ปุ่มแชร์ ⬆️ > *เพิ่มไปยังหน้าจอโฮม*

## โหมดข้อมูล

- **ค่าเริ่มต้น:** เก็บข้อมูลใน `localStorage` ของเครื่อง (ใช้งานได้ทันที ไม่ต้องตั้งค่า)
- **ข้ามอุปกรณ์:** ตั้งค่า `GAS_URL` ใน `index.html` ให้ชี้ไปที่ Google Apps Script Web App
  (วิธี Deploy อยู่ในหัวไฟล์ `Code.gs`) ข้อมูลจะ sync ผ่าน Google Sheet

## หมายเหตุการใช้งานออฟไลน์

- ตัวแอป (หน้าจอ + โค้ด) ถูก cache ไว้ เปิดได้แม้ไม่มีเน็ต
- หากใช้โหมด `localStorage` ข้อมูลอยู่ในเครื่อง ใช้งานออฟไลน์ได้เต็มที่
- หากใช้โหมด Google Apps Script การเพิ่ม/แก้/ลบ ต้องต่อเน็ต (แต่ยังเปิดแอปดูได้)
- เมื่อแก้ไฟล์แล้วต้องการให้แอปอัปเดต ให้เปลี่ยนเลข `CACHE_VERSION` ใน `sw.js`
