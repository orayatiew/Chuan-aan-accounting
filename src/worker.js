// Cloudflare Worker (พร้อม static assets): POST /api/send-announcement  body: { "id": "<รหัสประกาศ>" }
// ส่งประกาศลง Discord ทันที (ปุ่ม "ส่งทันที" ในหน้าประกาศ) ส่วนหน้าเว็บ (โฟลเดอร์ public/) ถูกเสิร์ฟโดย assets ตามปกติ
// - ยืนยันตัวตนด้วย Firebase ID token ของผู้ใช้ แล้วอ่าน/แก้ Firestore ผ่าน REST "ในนามผู้ใช้" จึงผ่าน Security Rules ตามปกติ (ไม่ต้องใช้ service account)
// - ใช้ precondition (updateTime) จองสิทธิ์ส่ง กันส่งซ้ำกับรอบตรวจอัตโนมัติ
// ต้องตั้ง Secret ใน Cloudflare (Workers → Settings → Variables and Secrets): DISCORD_WEBHOOK_ANNOUNCE (Webhook ของห้องประกาศ)

const PROJECT = 'cuan-aan-accounting';
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const ADMIN_ONLY = true; // true = เฉพาะ Admin ส่งทันทีได้ (เปลี่ยนเป็น false เพื่อให้ Member ส่งได้ด้วย)
const COLOR = 0x472a99;

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));

function dec(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return decFields(v.mapValue.fields || {});
  return null;
}
const decFields = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, dec(v)]));

const fs = (path, token, init = {}) =>
  fetch(`${FS}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

function emailOf(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(atob(p)).email || '').toLowerCase();
  } catch { return ''; }
}

function buildPayload(a, org) {
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

async function postDiscord(hook, a, org) {
  const payload = buildPayload(a, org);
  let res;
  if (a.image && a.image.data) {
    const [head, b64] = a.image.data.split(',');
    const type = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify(payload));
    fd.append('files[0]', new Blob([bytes], { type }), 'announcement.jpg');
    res = await fetch(hook, { method: 'POST', body: fd });
  } else {
    res = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }
  if (!res.ok) throw new Error(`Discord ตอบกลับ ${res.status} ${cut(await res.text(), 150)}`);
}

const patch = (id, token, fields) =>
  fs(`announcements/${id}?${Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&')}`, token,
    { method: 'PATCH', body: JSON.stringify({ fields }) });

async function handleSend({ request, env }) {
  const hook = env.DISCORD_WEBHOOK_ANNOUNCE;
  if (!hook) return J({ ok: false, error: 'ยังไม่ได้ตั้งค่า DISCORD_WEBHOOK_ANNOUNCE ใน Cloudflare (Variables and Secrets)' }, 500);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!token) return J({ ok: false, error: 'ยังไม่ได้เข้าสู่ระบบ' }, 401);
  let id;
  try { ({ id } = await request.json()); } catch { /* ignore */ }
  if (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return J({ ok: false, error: 'รหัสประกาศไม่ถูกต้อง' }, 400);

  const r = await fs(`announcements/${id}`, token);
  if (r.status === 401 || r.status === 403) return J({ ok: false, error: 'ไม่มีสิทธิ์ (ต้องเข้าสู่ระบบและได้รับสิทธิ์ในระบบ)' }, 403);
  if (r.status === 404) return J({ ok: false, error: 'ไม่พบประกาศนี้' }, 404);
  if (!r.ok) return J({ ok: false, error: `อ่านประกาศไม่สำเร็จ (${r.status})` }, 502);
  const doc = await r.json();
  const a = decFields(doc.fields || {});

  if (ADMIN_ONLY) {
    const rr = await fs(`roles/${encodeURIComponent(emailOf(token))}`, token);
    const role = rr.ok ? decFields((await rr.json()).fields || {}).role : null;
    if (role !== 'admin') return J({ ok: false, error: 'เฉพาะ Admin เท่านั้นที่ส่งทันทีได้' }, 403);
  }
  if (!['draft', 'scheduled', 'failed'].includes(a.status)) return J({ ok: false, error: 'ประกาศนี้ส่งแล้วหรือกำลังส่งอยู่' }, 409);

  // จองสิทธิ์ส่ง: สำเร็จก็ต่อเมื่อเอกสารยังไม่ถูกแก้ไขตั้งแต่ตอนอ่าน
  const claim = await fs(`announcements/${id}?updateMask.fieldPaths=status&currentDocument.updateTime=${encodeURIComponent(doc.updateTime)}`, token,
    { method: 'PATCH', body: JSON.stringify({ fields: { status: { stringValue: 'sending' } } }) });
  if (!claim.ok) return J({ ok: false, error: 'ประกาศนี้ถูกแก้ไขหรือกำลังถูกส่งโดยรอบอื่น กรุณารีเฟรชแล้วลองใหม่' }, 409);

  let org = '';
  try { const o = await fs('meta/org', token); if (o.ok) org = decFields((await o.json()).fields || {}).name || ''; } catch { /* ใช้ค่าว่าง */ }

  try {
    await postDiscord(hook, a, org);
    await patch(id, token, { status: { stringValue: 'sent' }, sentAt: { integerValue: String(Date.now()) }, error: { nullValue: null } });
    return J({ ok: true });
  } catch (e) {
    await patch(id, token, { status: { stringValue: 'failed' }, error: { stringValue: cut(e.message, 300) } });
    return J({ ok: false, error: e.message }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/send-announcement') {
      if (request.method !== 'POST') return J({ ok: false, error: 'ใช้ได้เฉพาะ POST' }, 405);
      return handleSend({ request, env });
    }
    return env.ASSETS.fetch(request); // หน้าเว็บและไฟล์อื่นๆ
  },
};
