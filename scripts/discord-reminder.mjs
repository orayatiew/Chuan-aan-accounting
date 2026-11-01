// ส่งประกาศที่ตั้งเวลาไว้ในเว็บ เข้า Discord อีกห้องหนึ่ง (แยกจากห้องบัญชี)
// อ่านคอลเลกชัน announcements แล้วส่งเฉพาะที่ status = scheduled และถึงเวลาแล้ว
// สคริปต์นี้แก้ข้อมูลเฉพาะสถานะของประกาศที่ส่ง (sending → sent / failed) ไม่แตะข้อมูลบัญชี
import { pathToFileURL } from 'node:url';

const COLOR = 0x472a99;
const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));

export function buildAnnouncement(a, org) {
  const embed = {
    title: cut(a.subject, 256),
    description: cut(a.detail, 4000) || undefined,
    color: COLOR,
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

export async function postToDiscord(hook, a, org) {
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

async function main() {
  const { default: admin } = await import('firebase-admin');
  const hook = process.env.DISCORD_WEBHOOK_ANNOUNCE;
  if (!hook || !process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('ยังไม่ได้ตั้งค่า secrets (FIREBASE_SERVICE_ACCOUNT, DISCORD_WEBHOOK_ANNOUNCE)');
  const forceAll = (process.env.FORCE_ALL || '').trim() === 'true';
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore();
  const snap = await db.collection('announcements').where('status', '==', 'scheduled').get();
  const now = Date.now();
  const due = snap.docs.filter(d => forceAll || (Number(d.data().sendAtTs) || 0) <= now);
  console.log(`ประกาศที่ตั้งเวลาไว้ ${snap.size} รายการ ถึงเวลาแล้ว ${due.length} รายการ`);
  if (!due.length) return;
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
      await postToDiscord(hook, a, org);
      await d.ref.update({ status: 'sent', sentAt: Date.now(), error: null });
      console.log(`ส่งแล้ว: ${a.subject}`);
    } catch (e) {
      failed++;
      await d.ref.update({ status: 'failed', error: cut(e.message, 300) });
      console.error(`ส่งไม่สำเร็จ: ${a.subject} — ${e.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
