/* FileBeam-JS (KV edition) — Cloudflare Workers + Workers KV
   Single-file, no accounts, no database, no card.
   Files self-destruct in ~60 minutes via native KV TTL.

   Free tier: 100k reads/day · 1k writes/day · 1 GB storage · 25 MB max per value */

const EXPIRE_MS = 60 * 60 * 1000;
const TTL_S = 3700;                       /* KV ttl slightly above 60 min */
const MAX_SINGLE = 24 * 1024 * 1024;      /* stay under the 25 MB value cap */
const CHUNK_BYTES = 20 * 1024 * 1024;     /* big-lane chunk size */
const MAX_BEAM = 150 * 1024 * 1024;       /* hosted ceiling via chunked KV */
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  let out = "";
  for (const x of b) out += ALPHA[x % ALPHA.length];
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function safeName(name) {
  return String(name || "file").replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "file";
}

async function getManifest(env, code) {
  const raw = await env.BEAM.get("m:" + code);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return m && m.exp > Date.now() ? m : null;
  } catch { return null; }
}

function streamParts(env, code, parts) {
  let i = 0;
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          if (i >= parts) { controller.close(); return; }
          const b = await env.BEAM.get(`c:${code}:${i}`, { type: "arrayBuffer" });
          i++;
          if (!b || !b.byteLength) { controller.error(new Error("part missing")); return; }
          controller.enqueue(b);
        } catch (e) { controller.error(e); }
      },
    },
    { highWaterMark: 1 }
  );
}

/* ================= UI ================= */

const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{--base:#e6e9f8;--dark:rgba(133,142,205,.45);--lite:rgba(255,255,255,.95);--ink:#3b3f58;--muted:#8a90b8}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--base);color:var(--ink);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:22px;overflow-x:hidden}
.card{position:relative;width:100%;max-width:600px;background:var(--base);border:none;border-radius:36px;padding:36px;box-shadow:20px 20px 46px var(--dark),-16px -16px 38px var(--lite)}
.logo{display:flex;align-items:center;gap:13px;margin-bottom:26px}
.logo svg{width:38px;height:38px;filter:drop-shadow(5px 5px 10px var(--dark))}
.logo h1{font-size:23px;font-weight:800;letter-spacing:-.5px;color:var(--ink)}
.logo h1 span{background:linear-gradient(90deg,#6d7cff,#d946ef,#22d3ee);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.tabs{display:flex;gap:8px;background:var(--base);border-radius:20px;padding:6px;margin-bottom:28px;box-shadow:inset 7px 7px 14px var(--dark),inset -7px -7px 14px var(--lite)}
.tab{flex:1;padding:12px;border:none;border-radius:15px;background:transparent;color:var(--muted);font-size:14px;font-weight:700;cursor:pointer;transition:all .22s}
.tab:hover{color:var(--ink)}
.tab.active{color:#6d5bd0;box-shadow:5px 5px 12px var(--dark),-5px -5px 12px var(--lite)}
.drop{border:none;border-radius:26px;padding:40px 20px;text-align:center;cursor:pointer;transition:all .22s;margin-bottom:18px;background:var(--base);box-shadow:inset 8px 8px 18px var(--dark),inset -8px -8px 18px var(--lite)}
.drop:hover,.drop.over{box-shadow:inset 8px 8px 18px var(--dark),inset -8px -8px 18px var(--lite),0 0 0 2.5px rgba(168,85,247,.35)}
.drop p{color:var(--muted);font-size:14px;margin-top:10px}
.drop p a{color:#6d5bd0;text-decoration:none;font-weight:800}
.drop svg{width:44px;height:44px;stroke:#a855f7;filter:drop-shadow(4px 4px 8px var(--dark));fill:none;stroke-width:1.6}
.files{display:flex;flex-direction:column;gap:10px;margin-bottom:16px;max-height:210px;overflow-y:auto}
.chip{display:flex;align-items:center;gap:11px;background:var(--base);border-radius:16px;padding:11px 13px;font-size:13px;box-shadow:6px 6px 13px var(--dark),-6px -6px 13px var(--lite)}
.chip .ext{min-width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;box-shadow:inset 2px 2px 5px rgba(0,0,0,.18)}
.chip .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip .sz{color:var(--muted);font-size:12px;white-space:nowrap}
.chip button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:2px 6px}
.chip button:hover{color:#d6336c}
.btn{width:100%;padding:16px;border:none;border-radius:20px;background:linear-gradient(135deg,#6d7cff 0%,#a855f7 55%,#ec4899 100%);color:#fff;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:.2px;box-shadow:9px 9px 20px rgba(140,110,220,.5),-7px -7px 16px var(--lite),inset 0 1px 0 rgba(255,255,255,.45);transition:all .2s}
.btn:hover{filter:brightness(1.08)}
.btn:active{transform:scale(.985);box-shadow:4px 4px 10px rgba(140,110,220,.5),-3px -3px 8px var(--lite),inset 0 1px 0 rgba(255,255,255,.45)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn.ghost{background:var(--base);color:#6d5bd0;box-shadow:7px 7px 16px var(--dark),-7px -7px 16px var(--lite);margin-top:12px}
.btn.ghost:active{box-shadow:inset 5px 5px 10px var(--dark),inset -5px -5px 10px var(--lite)}
.pbar{height:12px;background:var(--base);border-radius:99px;margin:20px 0 8px;overflow:hidden;display:none;box-shadow:inset 6px 6px 12px var(--dark),inset -6px -6px 12px var(--lite)}
.pbar div{height:100%;width:0;background:linear-gradient(90deg,#6d7cff,#d946ef,#22d3ee);background-size:200% 100%;border-radius:99px;transition:width .2s;animation:shimmer 2s linear infinite}
@keyframes shimmer{to{background-position:200% 0}}
.result{display:none;text-align:center}
.result .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:2.5px;margin-bottom:12px;font-weight:800}
.code{font-family:'Cascadia Code',Consolas,monospace;font-size:47px;font-weight:800;letter-spacing:10px;background:linear-gradient(90deg,#6d7cff,#d946ef,#22d3ee);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px;user-select:all}
.url{font-family:Consolas,monospace;font-size:13px;color:var(--muted);word-break:break-all;margin-bottom:20px;user-select:all}
.copyrow{display:flex;gap:11px;justify-content:center;margin-bottom:22px;flex-wrap:wrap}
.mini{padding:11px 21px;border-radius:999px;border:none;background:var(--base);color:var(--ink);font-size:13px;font-weight:700;cursor:pointer;transition:all .2s;box-shadow:6px 6px 13px var(--dark),-6px -6px 13px var(--lite)}
.mini:hover{color:#6d5bd0}
.mini:active{box-shadow:inset 4px 4px 9px var(--dark),inset -4px -4px 9px var(--lite)}
#qr{width:160px;height:160px;border-radius:22px;background:#fff;padding:10px;margin:0 auto 18px;display:block;box-shadow:12px 12px 26px var(--dark),-10px -10px 22px var(--lite)}
.note{font-size:12px;color:var(--muted)}
.inrow{display:flex;gap:11px;margin-bottom:22px}
.inrow input{flex:1;background:var(--base);border:none;border-radius:20px;padding:16px;color:var(--ink);font-family:'Cascadia Code',Consolas,monospace;font-size:23px;letter-spacing:9px;text-align:center;text-transform:uppercase;outline:none;transition:box-shadow .22s;box-shadow:inset 8px 8px 16px var(--dark),inset -8px -8px 16px var(--lite)}
.inrow input:focus{box-shadow:inset 8px 8px 16px var(--dark),inset -8px -8px 16px var(--lite),0 0 0 2.5px rgba(168,85,247,.35)}
.flist{display:flex;flex-direction:column;gap:11px;margin-bottom:16px}
.frow{display:flex;align-items:center;gap:13px;background:var(--base);border-radius:19px;padding:14px 16px;box-shadow:7px 7px 15px var(--dark),-7px -7px 15px var(--lite);transition:all .2s}
.frow:hover{transform:translateY(-1px)}
.frow .ext{min-width:41px;height:41px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;box-shadow:inset 2px 2px 5px rgba(0,0,0,.18)}
.frow .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.frow .sz{color:var(--muted);font-size:12px}
.dl{padding:10px 19px;border-radius:13px;border:none;background:linear-gradient(135deg,#6d7cff,#d946ef);color:#fff;font-size:12px;font-weight:800;cursor:pointer;text-decoration:none;box-shadow:4px 4px 10px rgba(140,110,220,.45),-3px -3px 8px var(--lite)}
.dl:active{box-shadow:inset 3px 3px 6px rgba(80,50,140,.4)}
.hidden{display:none!important}
.err{color:#d6336c;font-size:13px;text-align:center;margin-bottom:14px;display:none}
footer{font-size:12px;color:var(--muted);text-align:center;margin-top:26px}
footer a{color:#6d5bd0;text-decoration:none;font-weight:700}
@media(max-width:520px){.card{padding:26px}.code{font-size:33px;letter-spacing:6px}}
`;

const SHELL = (title) => `<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<link rel=icon href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📦</text></svg>'>
<title>${title}</title>
<style>${BASE_CSS}</style></head><body>`;

const FOOTER = `<footer>No accounts · No tracking · Files auto-delete in 60 min · Free forever · <a href=https://github.com/Kawshikmr/filebeam>open source</a></footer></body></html>`;

function gonePage(msg) {
  return `${SHELL("FileBeam")}
<div class=card style=text-align:center>
<div class=logo><svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4.5 13.5H11L9.5 22L19.5 9.5H12.5L13 2Z" fill="url(#g)"/><defs><linearGradient id="g" x1="4" y1="2" x2="20" y2="22"><stop stop-color="#6d7cff"/><stop offset="1" stop-color="#b06bff"/></linearGradient></defs></svg><h1>File<span>Beam</span></h1></div>
<h2 style=margin-bottom:12px>⏱️ Beam expired</h2>
<p class=note style=margin-bottom:24px>${msg}</p>
<a class=btn href="/">Beam something new</a></div>${FOOTER}`;
}

const CLIENT_JS = `
let FILE=null,UPL=null;
const $=id=>document.getElementById(id);
function show(t){$('cS').classList.toggle('hidden',t!=='s');$('cR').classList.toggle('hidden',t!=='r');
$('tS').classList.toggle('active',t==='s');$('tR').classList.toggle('active',t==='r')}
const f=$('f'),drop=$('drop');
f.onchange=e=>pick(e.target.files[0]);
['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',e=>pick(e.dataTransfer.files[0]));
const extColors={pdf:'#ef4444',jpg:'#f59e0b',jpeg:'#f59e0b',png:'#10b981',gif:'#10b981',zip:'#8b5cf6',rar:'#8b5cf6',mp4:'#ec4899',mkv:'#ec4899',mp3:'#06b6d4',wav:'#06b6d4',doc:'#3b82f6',docx:'#3b82f6',xls:'#22c55e',xlsx:'#22c55e',exe:'#64748b',py:'#3b82f6',js:'#eab308',html:'#fb923c'};
function extColor(e){return extColors[e]||'#6d7cff'}
function ext(n){return (String(n).split('.').pop()||'bin').toLowerCase().slice(0,4)}
function fmt(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,n>>10)+' KB'}
function pick(file){
 if(!file)return;
 if(file.size>MAXBEAM*1048576)return alert('Max '+MAXBEAM+' MB on this demo');
 FILE=file;
 $('chips').innerHTML='<div class=chip><div class=ext style="background:'+extColor(ext(file.name))+'">'+ext(file.name).toUpperCase()+'</div><div class=nm>'+esc(file.name)+'</div><div class=sz>'+fmt(file.size)+'</div><button onclick=clearPick()>&#10005;</button></div>';
 $('chips').classList.remove('hidden');
 $('result').style.display='none';$('go').disabled=false;$('go').style.display='';
}
function clearPick(){FILE=null;$('chips').innerHTML='';$('chips').classList.add('hidden');$('go').disabled=true}
function cp(w,btn){const v=w==='code'?UPL.code:UPL.url;navigator.clipboard.writeText(v);
btn.textContent='✓ Copied';setTimeout(()=>{btn.textContent=w==='code'?'Copy Code':'Copy Link'},1400)}
function shareWA(){window.open('https://wa.me/?text='+encodeURIComponent(UPL.msg),'_blank')}
function shareTG(){window.open('https://t.me/share/url?url='+encodeURIComponent(UPL.url)+'&text='+encodeURIComponent('Tap the link to get the file'),'_blank')}
function nativeShare(btn){if(navigator.share){navigator.share({title:'FileBeam',text:UPL.msg}).catch(()=>{})}else{cp('link',btn)}}
function reset(){clearPick();$('bar').style.display='none';$('barf').style.width='0%';
$('result').style.display='none';$('drop').style.display='';$('go').style.display=''}
function setPct(p){$('barf').style.width=Math.max(0,Math.min(100,p))+'%'}
async function startBig(){
 const CH=20*1048576;
 let r=await fetch('/api/beam/init?name='+encodeURIComponent(FILE.name)+'&type='+encodeURIComponent(FILE.type||'application/octet-stream')+'&size='+FILE.size,{method:'POST'});
 let j=await r.json();if(j.err)throw new Error(j.err);
 const code=j.code;
 for(let i=0;i<j.parts;i++){
  await new Promise((res,rej)=>{
   const x=new XMLHttpRequest();
   x.open('POST','/api/beam/chunk?code='+code+'&n='+i);
   x.upload.onprogress=e=>{if(e.lengthComputable)setPct((i+e.loaded/e.total)/j.parts*100)};
   x.onload=()=>x.status<300?res():rej(new Error('chunk '+i+' failed'));
   x.onerror=()=>rej(new Error('network'));
   x.send(FILE.slice(i*CH,(i+1)*CH));
  });
 }
 r=await fetch('/api/beam/finish?code='+code,{method:'POST'});
 j=await r.json();if(j.err)throw new Error(j.err);
 return j;
}
function showDone(done){
 UPL=done;setPct(100);
 $('drop').style.display='none';$('chips').classList.add('hidden');
 $('go').style.display='none';
 $('dCode').textContent=done.code;$('dLink').textContent=done.url;
 $('result').style.display='block';
 const qr=qrcode(0,'M');qr.addData(done.url);qr.make();
 $('qr').src=qr.createDataURL(4,8);
}
function start(){
 if(!FILE)return;$('go').disabled=true;$('bar').style.display='block';
 if(FILE.size>20*1048576){startBig().then(showDone).catch(e=>{alert('Beam failed: '+e.message);reset()});return}
 const xhr=new XMLHttpRequest();
 xhr.open('POST','/api/beam?name='+encodeURIComponent(FILE.name)+'&type='+encodeURIComponent(FILE.type||'application/octet-stream'));
 xhr.upload.onprogress=e=>{if(e.lengthComputable)setPct(Math.min(99,e.loaded/e.total*100))};
 xhr.onload=()=>{
  try{
   const done=JSON.parse(xhr.responseText);
   if(done.err)throw new Error(done.err);
   showDone(done);
  }catch(e){alert('Beam failed: '+e.message);reset()}
 };
 xhr.onerror=()=>{alert('Network error');reset()};
 xhr.send(FILE);
}
async function lookup(){
 const c=$('code').value.trim().toUpperCase();
 $('rerr').style.display='none';$('rlist').innerHTML='';
 if(!/^[A-Z0-9]{6}$/.test(c)){$('rerr').textContent='Enter the 6-character code.';$('rerr').style.display='block';return}
 let j;
 try{j=await(await fetch('/api/meta/'+c)).json()}catch(e){j={err:'network'}}
 if(j.err){$('rerr').textContent='This code expired or is wrong.';$('rerr').style.display='block';return}
 $('rlist').innerHTML='<div class=frow><div class=ext style="background:'+extColor(ext(j.name))+'">'+ext(j.name).toUpperCase()+'</div><div class=nm>'+esc(j.name)+'</div><div class=sz>'+fmt(j.size)+'</div><a class=dl href=/d/'+c+'/raw download="'+esc(j.name)+'">Download</a></div>';
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function togglePhone(){
 const b=$('phoneBox');
 if(b.classList.contains('hidden')){
  const qr=qrcode(0,'M');qr.addData(location.href);qr.make();
  $('pqr').src=qr.createDataURL(4,6);
  $('purl').textContent=location.href;
 }
 b.classList.toggle('hidden');
}
`;

function homePage(maxMb) {
  return `${SHELL("FileBeam")}<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
<div class=card>
<div class=logo><svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4.5 13.5H11L9.5 22L19.5 9.5H12.5L13 2Z" fill="url(#g)"/><defs><linearGradient id="g" x1="4" y1="2" x2="20" y2="22"><stop stop-color="#6d7cff"/><stop offset="1" stop-color="#b06bff"/></linearGradient></defs></svg><h1>File<span>Beam</span></h1></div>
<div class=tabs>
<button class="tab active" id=tS onclick=show('s')>Send</button>
<button class="tab" id=tR onclick=show('r')>Receive</button>
</div>

<div id=cS>
<div class=drop id=drop onclick=f.click()><svg viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-.5 7H7z"/><path d="M12 12v6m0-6l-2.5 2.5M12 12l2.5 2.5"/></svg><p>Tap to pick a file or drop it here · up to ${maxMb} MB</p><input type=file id=f hidden></div>
<div class="files hidden" id=chips></div>
<div class=pbar id=bar><div id=barf></div></div>
<button class=btn id=go disabled onclick=start()>⚡ Beam It</button>
<div class=result id=result>
<div class=lbl>Your Code</div>
<div class=code id=dCode></div>
<div class=url id=dLink></div>
<div class=copyrow>
<button class=mini id=bCode onclick=cp('code',this)>Copy Code</button>
<button class=mini id=bLink onclick=cp('link',this)>Copy Link</button>
</div>
<div class=lbl style=margin-bottom:10px>Share Via</div>
<div class=copyrow>
<button class=mini onclick=nativeShare(this)>Share</button>
<button class=mini style="color:#25d366" onclick=shareWA()>WhatsApp</button>
<button class=mini style="color:#229ed9" onclick=shareTG()>Telegram</button>
</div>
<img id=qr alt="QR code">
<div class=note style=margin-top:14px>Valid 60 minutes · share the code or the link.</div>
<button class="btn ghost" onclick=reset()>Beam Another File</button>
</div>
</div>

<div id=cR class=hidden>
<div class=inrow><input id=code maxlength=6 placeholder=CODE autocomplete=off spellcheck=false></div>
<button class=btn onclick=lookup()>Fetch Files</button>
<div class="err" id=rerr></div>
<div class=flist id=rlist></div>
</div>
</div>
<p class=note style=text-align:center;margin-top:18px>Demo lane (150 MB) · For 10 GB beams run filebeam.py from <a href=https://github.com/Kawshikmr/filebeam>Kawshikmr/filebeam</a></p>
<button class=mini id=phoneBtn onclick=togglePhone() style="position:fixed;right:16px;bottom:16px;border-radius:99px;z-index:9">Receive on phone?</button>
<div id=phoneBox class=hidden style="position:fixed;right:16px;bottom:64px;background:rgba(17,20,29,.96);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px;text-align:center;z-index:9">
<img id=pqr alt="" style="width:150px;background:#fff;border-radius:10px;padding:6px;display:block">
<div class=note id=purl style="margin-top:8px;max-width:180px;word-break:break-all;color:#c7cbe8"></div>
</div>
${FOOTER}
<script>
const MAXBEAM=${maxMb};
${CLIENT_JS}
</script></body></html>`;
}

/* ================= worker ================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });

      /* ---- big-lane: init (chunked upload, up to MAX_BEAM) ---- */
      if (path === "/api/beam/init" && request.method === "POST") {
        const name = safeName(url.searchParams.get("name"));
        const type = (url.searchParams.get("type") || "application/octet-stream").slice(0, 100);
        const size = Number(url.searchParams.get("size") || 0);
        if (!size) return json({ err: "empty upload" }, 400);
        if (size > MAX_BEAM) return json({ err: `too large for this demo (max ${Math.floor(MAX_BEAM / 1048576)} MB)` }, 413);
        const parts = Math.ceil(size / CHUNK_BYTES);
        const code = newCode();
        const manifest = { name, type, size, parts, done: false, exp: Date.now() + EXPIRE_MS };
        await env.BEAM.put("m:" + code, JSON.stringify(manifest), { expirationTtl: TTL_S });
        return json({ ok: true, code, parts });
      }

      /* ---- big-lane: one chunk ---- */
      if (path === "/api/beam/chunk" && request.method === "POST") {
        const code = url.searchParams.get("code") || "";
        const n = Number(url.searchParams.get("n"));
        if (!/^[A-Z0-9]{6}$/.test(code) || !Number.isInteger(n)) return json({ err: "bad chunk call" }, 400);
        const m = await getManifest(env, code);
        if (!m) return json({ err: "unknown or expired beam" }, 404);
        if (m.done) return json({ err: "already sealed" }, 409);
        if (n < 0 || n >= m.parts) return json({ err: "chunk index out of range" }, 400);
        const buf = await request.arrayBuffer();
        if (!buf || !buf.byteLength) return json({ err: "empty chunk" }, 400);
        if (buf.byteLength > CHUNK_BYTES + 1048576) return json({ err: "chunk exceeds size limit" }, 413);
        await env.BEAM.put(`c:${code}:${n}`, buf, { expirationTtl: TTL_S });
        return json({ ok: true, n });
      }

      /* ---- big-lane: seal beam ---- */
      if (path === "/api/beam/finish" && request.method === "POST") {
        const code = url.searchParams.get("code") || "";
        if (!/^[A-Z0-9]{6}$/.test(code)) return json({ err: "bad code" }, 400);
        const m = await getManifest(env, code);
        if (!m) return json({ err: "unknown or expired beam" }, 404);
        if (!m.done) {
          m.done = true;
          m.exp = Date.now() + EXPIRE_MS;
          await env.BEAM.put("m:" + code, JSON.stringify(m), { expirationTtl: TTL_S });
        }
        return json({
          ok: true,
          code,
          url: `${url.origin}/d/${code}`,
          msg: `📦 FileBeam: "${m.name}" — get it before it self-destructs (60 min): ${url.origin}/d/${code}`,
        });
      }

      /* ---- single-shot upload ---- */
      if (path === "/api/beam" && request.method === "POST") {
        const len = Number(request.headers.get("content-length") || 0);
        if (!len) return json({ err: "empty upload" }, 400);
        if (len > MAX_SINGLE) return json({ err: `too large for this demo (max ${Math.floor(MAX_BEAM / 1048576)} MB)` }, 413);

        let buf, name, type;
        const ct = (request.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("multipart/form-data")) {
          const form = await request.formData();
          const f = form.get("f");
          if (!f || typeof f === "string") return json({ err: "missing file field 'f'" }, 400);
          buf = await f.arrayBuffer();
          name = safeName(f.name || "");
          type = (f.type || "application/octet-stream").slice(0, 100);
        } else {
          buf = await request.arrayBuffer();
          if (!buf || !buf.byteLength) return json({ err: "empty upload" }, 400);
          if (buf.byteLength > MAX_SINGLE) return json({ err: `too large for this demo (max ${Math.floor(MAX_BEAM / 1048576)} MB)` }, 413);
          name = safeName(url.searchParams.get("name"));
          type = (url.searchParams.get("type") || "application/octet-stream").slice(0, 100);
        }
        if (!buf || !buf.byteLength) return json({ err: "empty upload" }, 400);
        const code = newCode();
        const manifest = { name, type, size: buf.byteLength, exp: Date.now() + EXPIRE_MS };

        await env.BEAM.put("m:" + code, JSON.stringify(manifest), { expirationTtl: TTL_S });
        await env.BEAM.put("d:" + code, buf, { expirationTtl: TTL_S });

        return json({
          ok: true,
          code,
          url: `${url.origin}/d/${code}`,
          msg: `📦 FileBeam: "${name}" — get it before it self-destructs (60 min): ${url.origin}/d/${code}`,
        });
      }

      /* ---- receiver metadata ---- */
      const mm = path.match(/^\/api\/meta\/([A-Z0-9]{6})$/);
      if (mm) {
        const m = await getManifest(env, mm[1]);
        if (!m) return json({ err: "expired" }, 410);
        return json(m);
      }

      /* ---- raw download ---- */
      const dr = path.match(/^\/d\/([A-Z0-9]{6})\/raw$/);
      if (dr) {
        const m = await getManifest(env, dr[1]);
        if (!m) return resp(gonePage("This beam has expired or never existed."), 410);
        let data;
        if (m.parts > 1) {
          if (!m.done) return resp(gonePage("This beam is still uploading — ask the sender to wait a minute."), 425);
          data = streamParts(env, dr[1], m.parts);
        } else {
          data = await env.BEAM.get("d:" + dr[1], { type: "arrayBuffer" });
          if (!data) return resp(gonePage("This beam vanished."), 410);
        }
        return new Response(data, {
          headers: {
            "content-type": m.type || "application/octet-stream",
            "content-length": String(m.size),
            "content-disposition": `attachment; filename="${m.name.replace(/"/g, "")}; filename*=UTF-8''${encodeURIComponent(m.name)}`,
            "cache-control": "no-store",
          },
        });
      }

      /* ---- receive page ---- */
      const dp = path.match(/^\/d\/([A-Z0-9]{6})$/);
      if (dp) {
        const m = await getManifest(env, dp[1]);
        if (!m) return resp(gonePage("This beam has expired or never existed."), 410);
        const kb = Math.max(1, Math.round(m.size / 1024));
        const sizeTxt = m.size >= 1048576 ? (m.size / 1048576).toFixed(1) + " MB" : kb + " KB";
        return resp(`${SHELL("FileBeam — incoming")}
<div class=logo>📦 File<span>Beam</span></div>
<div class=card style=text-align:center>
<h2>📥 Incoming beam</h2>
<div class=meta style=margin-top:18px>
<div style="font-size:20px;font-weight:700;word-break:break-all">${escapeHtml(m.name)}</div>
<div style=margin-top:6px>${sizeTxt}</div>
<div style=margin-top:2px;color:#fbbf24>⏳ expires ${new Date(m.exp).toLocaleTimeString()}</div>
</div>
<a class=btn href="/d/${dp[1]}/raw">⬇️ Download now</a>
</div>${FOOTER}`);
      }

      /* ---- home ---- */
      if (path === "/") return resp(homePage(Math.floor(MAX_BEAM / 1048576)));

      return resp(`${SHELL("404")}<div style=min-height:60vh;display:flex;align-items:center;width:100%>
<div class=card style=text-align:center><h2>🧭 Lost?</h2><a class=btn href="/">Back to FileBeam</a></div>
</div>${FOOTER}`, 404);
    } catch (e) {
      return json({ err: String((e && e.message) || e) }, 500);
    }
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function resp(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}
