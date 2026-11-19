// THE MALL - ระบบจองที่จอดรถ
// ข้อมูลเก็บในหน่วยความจำ (เร็ว) และบันทึกลงไฟล์ data/bookings.json ทุกครั้งที่เปลี่ยน
// Node เป็น single-thread จึงไม่มีปัญหาสองคนจองช่องเดียวกันพร้อมกัน
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FLOORS = 5, SLOTS = 20;
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'bookings.json');

let bookings = {}; // "ชั้น-ช่อง" -> { floor, slot, name, ownerHash, at }
try { bookings = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(bookings));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}
const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const keyOf = (f, s) => `${f}-${s}`;

function check(floor, slot) {
  const f = Number(floor), s = Number(slot);
  if (!Number.isInteger(f) || f < 1 || f > FLOORS) return { error: `ชั้นไม่ถูกต้อง (1-${FLOORS})` };
  if (!Number.isInteger(s) || s < 1 || s > SLOTS) return { error: `เลขช่องไม่ถูกต้อง (1-${SLOTS})` };
  return { f, s };
}
function availableOf(f) {
  const a = [];
  for (let s = 1; s <= SLOTS; s++) if (!bookings[keyOf(f, s)]) a.push(s);
  return a;
}

// ---------- realtime (Server-Sent Events) ----------
const clients = new Set();
function broadcast() { for (const res of clients) res.write('event: update\ndata: {}\n\n'); }
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

const app = express();
app.use(express.json());
app.use('/api', (req, res, next) => { // เปิด CORS ให้ระบบอื่น (เช่น Botnoi) เรียกได้
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Client-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// สถานะทั้งหมดสำหรับหน้าเว็บ (mine = ช่องที่เครื่องนี้เป็นคนจอง)
app.get('/api/slots', (req, res) => {
  const token = req.get('x-client-token');
  const me = token ? hash(token) : null;
  const slots = {};
  for (const [k, b] of Object.entries(bookings)) {
    slots[k] = { floor: b.floor, slot: b.slot, name: b.name, mine: !!(me && b.ownerHash === me) };
  }
  res.json({ success: true, slots });
});

// API 1: ดูช่องว่าง  GET /api/slots/available?floor=2
app.get('/api/slots/available', (req, res) => {
  const { floor } = req.query;
  if (floor !== undefined && floor !== '') {
    const f = Number(floor);
    if (!Number.isInteger(f) || f < 1 || f > FLOORS)
      return res.status(400).json({ success: false, message: `ชั้นไม่ถูกต้อง (1-${FLOORS})` });
    const a = availableOf(f);
    return res.json({ success: true, floor: f, count: a.length, available: a });
  }
  const floors = [];
  let total = 0;
  for (let f = 1; f <= FLOORS; f++) {
    const a = availableOf(f);
    total += a.length;
    floors.push({ floor: f, count: a.length, available: a });
  }
  res.json({ success: true, totalAvailable: total, floors });
});

// API 2: จอง  POST /api/reserve  { nickname, floor, slot }
app.post('/api/reserve', (req, res) => {
  const b = req.body || {};
  const nick = String(b.nickname || '').trim().slice(0, 20);
  if (!nick) return res.status(400).json({ success: false, message: 'ต้องระบุชื่อเล่น' });
  const c = check(b.floor, b.slot);
  if (c.error) return res.status(400).json({ success: false, message: c.error });
  const k = keyOf(c.f, c.s);
  if (bookings[k]) return res.json({ success: false, message: 'ช่องไม่ว่าง' });
  const token = req.get('x-client-token');
  bookings[k] = { floor: c.f, slot: c.s, name: nick, ownerHash: token ? hash(token) : null, at: Date.now() };
  save(); broadcast();
  res.json({ success: true, message: 'จองสำเร็จ', nickname: nick, floor: c.f, slot: c.s });
});

// API 3: คืนที่จอด  POST /api/release  { nickname, floor, slot }
// - เรียกจากระบบอื่น: ต้องตรงทั้ง ชื่อเล่น + ชั้น + ช่อง
// - เรียกจากหน้าเว็บ (มี X-Client-Token): ต้องเป็นเครื่องที่จองไว้เท่านั้น
app.post('/api/release', (req, res) => {
  const b = req.body || {};
  const nick = String(b.nickname || '').trim();
  if (!nick) return res.status(400).json({ success: false, message: 'ต้องระบุชื่อเล่น' });
  const c = check(b.floor, b.slot);
  if (c.error) return res.status(400).json({ success: false, message: c.error });
  const k = keyOf(c.f, c.s);
  const d = bookings[k];
  if (!d) return res.json({ success: false, message: 'คืนไม่ได้: ช่องนี้ไม่มีการจอง' });
  const token = req.get('x-client-token');
  if (token) {
    if (!d.ownerHash || d.ownerHash !== hash(token))
      return res.json({ success: false, message: 'คืนไม่ได้: คุณไม่ใช่ผู้จอง' });
  } else if (d.name !== nick) {
    return res.json({ success: false, message: 'คืนไม่ได้: ข้อมูลไม่ตรงกับผู้จอง' });
  }
  delete bookings[k];
  save(); broadcast();
  res.json({ success: true, message: 'คืนที่จอดสำเร็จ', nickname: nick, floor: c.f, slot: c.s });
});

app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`THE MALL parking running at http://localhost:${PORT}`));
