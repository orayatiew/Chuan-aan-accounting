// สคริปต์เดียวทำ 2 งาน ส่งเข้า Discord
//  1) reminder  : แจ้งเตือนเรียกเก็บเงิน Support Project (อ่านข้อมูลอย่างเดียว)
//       - วันที่ 30 ของเดือน (เดือนสั้นกว่า 30 วันใช้วันสุดท้าย): แจ้งชำระ + รายชื่อคนที่ยังไม่จ่าย
//       - วันที่ 1 ของเดือน: แจ้งรายชื่อคนที่ยังไม่ได้จ่ายของ "เดือนที่แล้ว"
//  2) announce  : ส่งประกาศที่ตั้งเวลาไว้ในเว็บ ไปห้องประกาศ (แก้เฉพาะสถานะของประกาศที่ส่ง)
// Secrets ที่ใช้: FIREBASE_SERVICE_ACCOUNT, DISCORD_WEBHOOK_URL (ห้องบัญชี), DISCORD_WEBHOOK_ANNOUNCE (ห้องประกาศ)
import { pathToFileURL } from 'node:url';

// ---------- ตั้งค่า ----------
const DEFAULT_FEE = 500;          // ใช้เมื่อสมาชิกไม่ได้ตั้งยอดไว้
const MENTION_EVERYONE = true;    // แจ้งเตือนเรียกเก็บเงิน: แท็ก @everyone เมื่อมีคนค้างจ่าย
const EMBED_COLOR = 0x472a99;
const REMINDER_CRON = '0 2 * * *'; // ต้องตรงกับ cron ของงานแจ้งเตือนใน workflow
const SITE_URL = 'https://chuan-aan-accounting.dev-yo.workers.dev/'; // เว็บบัญชี (แสดงในข้อความแจ้งเตือน)

// ---------- ตัวช่วย ----------
const TH = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const pad = n => String(n).padStart(2, '0');
const label = (y, m) => `${TH[m - 1]} ${y + 543}`;
const baht = n => Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const feeOf = x => (+x.fee > 0 ? +x.fee : DEFAULT_FEE);
const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));

// ---------- 1) แจ้งเตือนเรียกเก็บเงิน ----------
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

// ยอดทบ: ถ้าเดือนก่อนหน้าถูกทำเครื่องหมาย "defer" (ทบไปเดือนหน้า) ยอดของเดือนนั้นจะถูกบวกเข้ามา (ทบต่อเนื่องได้หลายเดือน)
const prevMonth = k => { let [y, m] = k.split('-').map(Number); m--; if (m < 1) { m = 12; y--; } return `${y}-${pad(m)}`; };
export function carryOf(dues, feeById, key, id, depth = 0) {
  if (depth > 36) return 0;
  const p = prevMonth(key);
  if (((dues[p] || {})[id]) !== 'defer') return 0;
  return (feeById[id] || 0) + carryOf(dues, feeById, p, id, depth + 1);
}

export function buildMessage({ mode, y, m, org, members, paid, banks, carry = {} }) {
  const amt = x => feeOf(x) + (carry[x.id] || 0);
  const unpaid = members.filter(x => !paid[x.id]);                 // ยังไม่จ่าย (ไม่รวมที่ทบไปเดือนหน้า)
  const deferred = members.filter(x => paid[x.id] === 'defer');    // ทบไปเดือนหน้า ไม่ถือว่าค้าง
  const list = unpaid.map(x => `• ${x.name} — ${baht(amt(x))} บาท${carry[x.id] ? ` (รวมยอดทบ ${baht(carry[x.id])})` : ''}`).join('\n');
  const total = unpaid.reduce((s, x) => s + amt(x), 0);
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
  if (deferred.length) L.push('', `⏭️ ทบไปเดือนหน้า: ${deferred.map(x => `${x.name} (${baht(amt(x))})`).join(', ')}`);
  if (unpaid.length) {
    if (banks.length) L.push('', '💳 โอนเข้าบัญชี:', ...banks.map(b => `• ${b.bank} ${b.no} (${b.name})`));
    // ครอบลิงก์ด้วย <> เพื่อไม่ให้ Discord แสดงตัวอย่างลิงก์ขนาดใหญ่ (ยังกดได้ตามปกติ)
    L.push('', `📝 ชำระเงินแล้ว สามารถแนบสลิปแล้วทำเครื่องหมายว่าจ่ายแล้วได้ที่เว็บไซต์ <${SITE_URL}> ที่ Tab : Support Project`);
  }
  return L.join('\n').slice(0, 1900);
}

export async function runReminder({ db, hook, today, force }) {
  const d = decide(today, force || '');
  if (!d) { console.log(`[เรียกเก็บเงิน] วันนี้ (${today}) ไม่ใช่วันแจ้งเตือน`); return; }
  if (!hook) throw new Error('ยังไม่ได้ตั้งค่า secret DISCORD_WEBHOOK_URL (ห้องแจ้งเตือนบัญชี)');
  const key = `${d.y}-${pad(d.m)}`;
  const [mem, bk, dd, og] = await Promise.all([
    db.collection('members').get(), db.collection('banks').get(),
    db.collection('dues').get(), db.doc('meta/org').get(),
  ]);
  const members = mem.docs.map(x => x.data()).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'));
  if (!members.length) { console.log('[เรียกเก็บเงิน] ยังไม่มีสมาชิก'); return; }
  const dues = {}; dd.docs.forEach(x => { dues[x.id] = x.data(); });
  const feeById = Object.fromEntries(members.map(x => [x.id, feeOf(x)]));
  const carry = {};
  for (const x of members) { const c = carryOf(dues, feeById, key, x.id); if (c) carry[x.id] = c; }
  const content = buildMessage({
    mode: d.mode, y: d.y, m: d.m, org: (og.data() || {}).name || 'ทีมของเรา',
    members, paid: dues[key] || {}, banks: bk.docs.map(x => x.data()), carry,
  });
  const res = await fetch(hook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Support Project', content, allowed_mentions: { parse: MENTION_EVERYONE ? ['everyone'] : [] } }),
  });
  if (!res.ok) throw new Error(`Discord ตอบกลับ ${res.status}`);
  console.log(`[เรียกเก็บเงิน] ส่งแล้ว (${d.mode}, ${key})`);
}

// ---------- 2) ประกาศ ----------
export function buildAnnouncement(a, org) {
  const embed = {
    title: cut(a.subject, 256),
    description: cut(a.detail, 4000) || undefined,
    color: EMBED_COLOR,
    footer: { text: `${org || 'ประกาศ'} · โดย ${a.createdBy || '-'}` },
  };
  const ps = a.participants || [];
  if (ps.length) {
    let v = ps.map(p => `• ${p}`).join('\n');
    if (v.length > 1000) v = v.slice(0, 990).replace(/\n[^\n]*$/, '') + '\n…';
    embed.fields = [{ name: `👥 ผู้เข้าร่วม (${ps.length} คน)`, value: v }];
  }
  if (a.image && a.image.data) embed.image = { url: 'attachment://announcement.jpg' };
  return {
    username: org || 'ประกาศ',
    content: a.mention ? '@everyone' : undefined,
    embeds: [embed],
    allowed_mentions: { parse: a.mention ? ['everyone'] : [] },
  };
}

export async function postAnnouncement(hook, a, org) {
  const payload = buildAnnouncement(a, org);
  let res;
  if (a.image && a.image.data) {
    const [head, b64] = a.image.data.split(',');
    const type = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify(payload));
    fd.append('files[0]', new Blob([Buffer.from(b64, 'base64')], { type }), 'announcement.jpg');
    res = await fetch(hook, { method: 'POST', body: fd });
  } else {
    res = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }
  if (!res.ok) throw new Error(`Discord ตอบกลับ ${res.status} ${cut(await res.text(), 150)}`);
}

export async function runAnnounce({ db, hook, forceAll, now = Date.now() }) {
  const snap = await db.collection('announcements').where('status', '==', 'scheduled').get();
  const due = snap.docs.filter(d => forceAll || (Number(d.data().sendAtTs) || 0) <= now);
  console.log(`[ประกาศ] ตั้งเวลาไว้ ${snap.size} รายการ ถึงเวลาแล้ว ${due.length} รายการ`);
  if (!due.length) return;
  if (!hook) throw new Error('ยังไม่ได้ตั้งค่า secret DISCORD_WEBHOOK_ANNOUNCE (ห้องประกาศ)');
  const org = ((await db.doc('meta/org').get()).data() || {}).name;
  let failed = 0;
  for (const d of due) {
    // จองสิทธิ์ส่งก่อน กันส่งซ้ำถ้ามีสองรอบรันทับกัน
    const a = await db.runTransaction(async t => {
      const s = await t.get(d.ref);
      if (!s.exists || s.data().status !== 'scheduled') return null;
      t.update(d.ref, { status: 'sending' });
      return s.data();
    });
    if (!a) continue;
    try {
      await postAnnouncement(hook, a, org);
      await d.ref.update({ status: 'sent', sentAt: Date.now(), error: null });
      console.log(`[ประกาศ] ส่งแล้ว: ${a.subject}`);
    } catch (e) {
      failed++;
      await d.ref.update({ status: 'failed', error: cut(e.message, 300) });
      console.error(`[ประกาศ] ส่งไม่สำเร็จ: ${a.subject} — ${e.message}`);
    }
  }
  if (failed) throw new Error(`ส่งประกาศไม่สำเร็จ ${failed} รายการ`);
}

// ---------- ตัวรันหลัก ----------
async function main() {
  const env = process.env;
  // ตั้งเวลา: เลือกงานตาม cron ที่เรียกมา / รันมือ: เลือกจากช่อง task (ค่าเริ่มต้น both)
  let task = (env.TASK || '').trim();
  if (!task) task = env.SCHEDULE ? (env.SCHEDULE === REMINDER_CRON ? 'reminder' : 'announce') : 'both';
  const has = k => (env[k] ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้งค่า');
  console.log(`งานที่รัน: ${task}`);
  console.log(`Secrets — FIREBASE_SERVICE_ACCOUNT: ${has('FIREBASE_SERVICE_ACCOUNT')}, DISCORD_WEBHOOK_URL: ${has('DISCORD_WEBHOOK_URL')}, DISCORD_WEBHOOK_ANNOUNCE: ${has('DISCORD_WEBHOOK_ANNOUNCE')}`);
  if (!['reminder', 'announce', 'both', 'ping'].includes(task)) throw new Error(`task ไม่ถูกต้อง: ${task} (ใช้ reminder, announce, both หรือ ping)`);
  if (task === 'ping') {
    // ทดสอบว่า Webhook แต่ละตัวส่งเข้า Discord ได้จริง (ไม่ต้องใช้ข้อมูลหรือวันที่ใดๆ)
    let bad = false;
    for (const [name, url] of [['DISCORD_WEBHOOK_URL (ห้องแจ้งเตือนบัญชี)', env.DISCORD_WEBHOOK_URL], ['DISCORD_WEBHOOK_ANNOUNCE (ห้องประกาศ)', env.DISCORD_WEBHOOK_ANNOUNCE]]) {
      if (!url) { console.error(`✗ ${name}: ยังไม่ได้ตั้งค่า secret`); bad = true; continue; }
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `✅ ทดสอบการเชื่อมต่อ: ${name}` }) });
        if (!r.ok) throw new Error(`Discord ตอบกลับ ${r.status}`);
        console.log(`✓ ${name}: ส่งข้อความทดสอบแล้ว`);
      } catch (e) { console.error(`✗ ${name}: ${e.message}`); bad = true; }
    }
    if (bad) process.exitCode = 1;
    return;
  }
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('ยังไม่ได้ตั้งค่า secret FIREBASE_SERVICE_ACCOUNT');

  const { default: admin } = await import('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore();

  let failed = false;
  if (task === 'reminder' || task === 'both') {
    try { await runReminder({ db, hook: env.DISCORD_WEBHOOK_URL, today: bangkokToday(), force: (env.MODE || '').trim() }); }
    catch (e) { failed = true; console.error('[เรียกเก็บเงิน] ล้มเหลว:', e.message); }
  }
  if (task === 'announce' || task === 'both') {
    try { await runAnnounce({ db, hook: env.DISCORD_WEBHOOK_ANNOUNCE, forceAll: (env.FORCE_ALL || '').trim() === 'true' }); }
    catch (e) { failed = true; console.error('[ประกาศ] ล้มเหลว:', e.message); }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
