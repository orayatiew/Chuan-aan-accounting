// แจ้งเตือน Support Project เข้า Discord (อ่านข้อมูลจาก Firestore อย่างเดียว ไม่แก้ไขข้อมูลใดๆ)
// - วันที่ 30 ของเดือน (เดือนที่สั้นกว่า 30 วันใช้วันสุดท้ายของเดือน): แจ้งให้ชำระ พร้อมรายชื่อที่ยังไม่จ่าย
// - วันที่ 1 ของเดือน: แจ้งรายชื่อคนที่ยังไม่ได้จ่ายของ "เดือนที่แล้ว"
import { pathToFileURL } from 'node:url';

const DEFAULT_FEE = 500; // ใช้เมื่อสมาชิกไม่ได้ตั้งยอดไว้
const MENTION_EVERYONE = true; // true = แท็ก @everyone เมื่อมีคนค้างจ่าย (ตั้งเป็น false เพื่อปิด)
const TH = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const pad = n => String(n).padStart(2, '0');
const label = (y, m) => `${TH[m - 1]} ${y + 543}`;
const baht = n => Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const feeOf = x => (+x.fee > 0 ? +x.fee : DEFAULT_FEE);

export const bangkokToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export function decide(todayStr, force) {
  const [Y, Mo, D] = todayStr.split('-').map(Number);
  const prev = Mo === 1 ? { y: Y - 1, m: 12 } : { y: Y, m: Mo - 1 };
  if (force === 'pay') return { mode: 'pay', y: Y, m: Mo };
  if (force === 'unpaid') return { mode: 'unpaid', ...prev };
  const payDay = Math.min(30, new Date(Y, Mo, 0).getDate());
  if (D === payDay) return { mode: 'pay', y: Y, m: Mo };
  if (D === 1) return { mode: 'unpaid', ...prev };
  return null;
}

export function buildMessage({ mode, y, m, org, members, paid, banks }) {
  const unpaid = members.filter(x => !paid[x.id]);
  const list = unpaid.map(x => `• ${x.name} — ${baht(feeOf(x))} บาท`).join('\n');
  const total = unpaid.reduce((s, x) => s + feeOf(x), 0);
  const L = [];
  if (MENTION_EVERYONE && unpaid.length) L.push('@everyone');
  if (mode === 'pay') {
    L.push(`📣 **${org}** — ถึงกำหนดชำระ Support Project ประจำเดือน${label(y, m)}`);
    if (unpaid.length) L.push(`ยังไม่ได้ชำระ ${unpaid.length} คน (รวม ${baht(total)} บาท):`, list);
    else L.push('ทุกคนชำระครบแล้ว ✅ ขอบคุณทุกคนครับ');
  } else {
    L.push(`⏰ **${org}** — แจ้งเตือนผู้ที่ยังไม่ได้ชำระ Support Project ประจำเดือน${label(y, m)}`);
    if (unpaid.length) L.push(`ยังค้างชำระ ${unpaid.length} คน (รวม ${baht(total)} บาท):`, list);
    else L.push('ทุกคนชำระครบแล้ว ✅');
  }
  if (unpaid.length && banks.length) {
    L.push('', '💳 โอนเข้าบัญชี:', ...banks.map(b => `• ${b.bank} ${b.no} (${b.name})`), 'โอนแล้วแนบสลิปในเว็บบัญชีได้เลย');
  }
  return L.join('\n').slice(0, 1900);
}

async function main() {
  const { default: admin } = await import('firebase-admin');
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook || !process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('ยังไม่ได้ตั้งค่า secrets (FIREBASE_SERVICE_ACCOUNT, DISCORD_WEBHOOK_URL)');
  const today = bangkokToday();
  const d = decide(today, (process.env.FORCE_MODE || '').trim());
  if (!d) { console.log(`วันนี้ (${today}) ไม่ใช่วันแจ้งเตือน`); return; }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore();
  const key = `${d.y}-${pad(d.m)}`;
  const [mem, bk, du, og] = await Promise.all([
    db.collection('members').get(), db.collection('banks').get(),
    db.doc(`dues/${key}`).get(), db.doc('meta/org').get(),
  ]);
  const members = mem.docs.map(x => x.data()).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'));
  if (!members.length) { console.log('ยังไม่มีสมาชิก'); return; }
  const content = buildMessage({
    mode: d.mode, y: d.y, m: d.m, org: (og.data() || {}).name || 'ทีมของเรา',
    members, paid: du.data() || {}, banks: bk.docs.map(x => x.data()),
  });
  const res = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Support Project', content, allowed_mentions: { parse: MENTION_EVERYONE ? ['everyone'] : [] } }) });
  if (!res.ok) throw new Error(`Discord ตอบกลับ ${res.status}`);
  console.log(`ส่งแจ้งเตือนแล้ว (${d.mode}, ${key})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
