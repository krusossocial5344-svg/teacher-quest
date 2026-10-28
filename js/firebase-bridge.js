/* สะพานเชื่อมสมุดภารกิจครูซอสกับ Firebase
   ทำให้โค้ดหน้าเว็บเดิม (ที่เรียก claude.use('db' | 'assets' | 'downloads')) ทำงานบน Firestore / Storage ได้ */
(function(){
  const cfg = window.FIREBASE_CONFIG;
  firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const fs = firebase.firestore();
  try { fs.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (_) {}
  fs.enablePersistence({ synchronizeTabs: true }).catch(() => {});
  let storage = null; try { storage = firebase.storage(); } catch (_) {}
  const INLINE_MAX = 700 * 1024;               /* ไฟล์เล็กกว่านี้เก็บใน Firestore ได้ (ไม่ต้องใช้ Storage) */
  const PH = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  /* ---------- หน้าล็อกอิน ---------- */
  const gate = document.createElement('div');
  gate.id = 'fbGate';
  gate.innerHTML = `<div class="fb-card"><img src="img/logo.webp" alt="" class="fb-logo">
    <h2>สมุดภารกิจครูซอส</h2><p>เข้าสู่ระบบด้วยบัญชี Google ของคุณเพื่อเปิดสมุด</p>
    <button type="button" id="fbLogin" class="fb-btn">เข้าสู่ระบบด้วย Google</button>
    <p class="fb-msg" id="fbMsg"></p><p class="fb-foot">พัฒนาโดย ครูซอสสอนสังคม</p></div>`;
  const st = document.createElement('style');
  st.textContent = `#fbGate{position:fixed;inset:0;z-index:100;display:none;place-items:center;padding:20px;background:#081526 radial-gradient(800px 500px at 80% 10%,rgba(47,180,255,.18),transparent 60%);font-family:'IBM Plex Sans Thai',system-ui,sans-serif;color:#eef4ff}
  #fbGate.on{display:grid}.fb-card{width:min(100%,420px);background:#13223a;border:1px solid #2a3f5f;border-radius:6px;padding:32px 26px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center}
  .fb-logo{width:96px;height:96px;object-fit:contain}.fb-card h2{margin:0;font-size:26px;font-style:italic}.fb-card p{margin:0;color:#8ea3c0}
  .fb-btn{margin-top:8px;border:0;background:#c6f432;color:#0b1524;font:inherit;font-weight:700;font-size:17px;padding:13px 26px;border-radius:3px;cursor:pointer;transform:skewX(-10deg)}
  .fb-msg{color:#ff7a8a!important;min-height:1.4em;font-size:14px}.fb-foot{font-size:12.5px;margin-top:6px!important}`;
  document.head.appendChild(st);
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(gate));
  const msg = t => { const m = document.getElementById('fbMsg'); if (m) m.textContent = t || ''; };
  document.addEventListener('click', async e => {
    if (!e.target.closest('#fbLogin')) return;
    msg('');
    const p = new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
    try { await auth.signInWithPopup(p); }
    catch (err) {
      if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment')) { try { await auth.signInWithRedirect(p); return; } catch (_) {} }
      if (err && err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') msg('เข้าสู่ระบบไม่สำเร็จ: ' + (err.code || 'ลองใหม่อีกครั้ง'));
    }
  });
  window.__fbSignOut = () => auth.signOut().then(() => location.reload());

  /* ---------- รอจนล็อกอิน ---------- */
  let uid = null, resolveReady;
  const ready = new Promise(r => resolveReady = r);
  auth.onAuthStateChanged(u => {
    if (!u) { uid = null; gate.classList.add('on'); return; }
    const allow = (window.ALLOWED_EMAIL || '').trim().toLowerCase();
    if (allow && (u.email || '').toLowerCase() !== allow) { msg('บัญชีนี้ไม่มีสิทธิ์ใช้สมุดเล่มนี้'); auth.signOut(); return; }
    uid = u.uid; gate.classList.remove('on'); window.__fbUser = { email: u.email, name: u.displayName }; resolveReady();
  });

  /* ---------- ฐานข้อมูล (รูปแบบเดียวกับ claude db) ---------- */
  const root = () => fs.collection('users').doc(uid);
  const ref = path => { const s = path.split('/'); let r = root(); for (let i = 0; i < s.length; i += 2) { r = r.collection(s[i]); if (s[i + 1] !== undefined) r = r.doc(s[i + 1]); } return r; };
  const wrapDoc = d => ({ id: d.id, exists: d.exists, data: () => d.data(), metadata: d.metadata });
  const docApi = path => { const r = ref(path); return {
    id: r.id, path,
    get: () => r.get().then(wrapDoc),
    set: data => r.set(data),
    update: data => r.update(data),
    delete: () => r.delete(),
    onSnapshot: (next, err) => r.onSnapshot(d => next(wrapDoc(d)), e => err && err({ code: 'unavailable', message: e.message }))
  }; };
  const colApi = path => { const r = ref(path); return {
    path,
    doc: id => docApi(path + '/' + (id || r.doc().id)),
    get: () => r.get().then(q => ({ docs: q.docs.map(wrapDoc), size: q.size, empty: q.empty })),
    onSnapshot: (next, err) => r.onSnapshot(q => next({ docs: q.docs.map(wrapDoc), size: q.size, empty: q.empty, docChanges: () => [] }), e => err && err({ code: 'unavailable', message: e.message }))
  }; };
  const db = { doc: docApi, collection: colApi };

  /* ---------- ไฟล์ ---------- */
  const cache = {};
  const toDataURL = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  async function resolveURL(id) {
    if (cache[id]) return cache[id];
    await ready;
    try { const d = await fs.collection('users').doc(uid).collection('blobs').doc(id).get(); if (d.exists) { cache[id] = d.data().data; return cache[id]; } } catch (_) {}
    if (storage) { try { cache[id] = await storage.ref(`users/${uid}/files/${id}`).getDownloadURL(); return cache[id]; } catch (_) {} }
    throw { code: 'not_found' };
  }
  window.blobURL = resolveURL;
  window.blobSrc = id => {
    if (cache[id]) return cache[id];
    resolveURL(id).then(u => document.querySelectorAll(`img[src="${PH}#${id}"]`).forEach(i => i.src = u)).catch(() => {});
    return PH + '#' + id;
  };
  const assets = {
    async upload(blob, opts = {}) {
      await ready;
      const id = rid(), type = opts.type || blob.type || 'application/octet-stream';
      if (blob.size <= INLINE_MAX) {
        const data = await toDataURL(new Blob([blob], { type }));
        await fs.collection('users').doc(uid).collection('blobs').doc(id).set({ data, type, size: blob.size, createdAt: Date.now() });
        cache[id] = data; return { id, url: data, sizeBytes: blob.size, contentType: type };
      }
      if (!storage) throw { code: 'needs_storage' };
      try {
        const r = storage.ref(`users/${uid}/files/${id}`);
        await r.put(blob, { contentType: type });
        cache[id] = await r.getDownloadURL();
        return { id, url: cache[id], sizeBytes: blob.size, contentType: type };
      } catch (e) { throw { code: 'needs_storage', message: e && e.message }; }
    },
    async delete(id) {
      await ready;
      try { await fs.collection('users').doc(uid).collection('blobs').doc(id).delete(); } catch (_) {}
      if (storage) { try { await storage.ref(`users/${uid}/files/${id}`).delete(); } catch (_) {} }
      delete cache[id]; return { deleted: true };
    },
    async list() { return { assets: [], usage: {} }; }
  };

  /* ---------- ดาวน์โหลดไฟล์ ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const isTouchApple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isTouchApple && navigator.canShare) {
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        if (navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: filename }); return { status: 'saved' }; }
          catch (e) { if (e && e.name === 'AbortError') throw { code: 'declined' }; }
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { status: 'saved' };
    }
  };

  window.claude = { use: async name => { await ready; return name === 'db' ? db : name === 'assets' ? assets : name === 'downloads' ? downloads : null; } };
})();
