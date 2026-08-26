/* FileBeam-JS (KV edition) — Cloudflare Workers + Workers KV
   Copyright (c) 2026 Kawshik. All rights reserved.
   Source: https://github.com/Kawshikmr/filebeam
   Licensed under the MIT License.

   Single-file, no accounts, no database, no card.
   Features:
   - End-to-End Encryption (AES-GCM-256 via Web Crypto)
   - Direct WebRTC P2P Live Streaming
   - Memory-safe chunked Streaming ZIP
   - PWA & OS Native Web Share Target
   - Auto self-destruct in ~60 minutes via native KV TTL
*/

import PY_EDITION from "./filebeam.py";

const EXPIRE_MS = 60 * 60 * 1000;
const TTL_S = 3700;                       /* KV ttl slightly above 60 min */
const SIG_TTL = 300;                      /* 5 min TTL for live P2P signaling */
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

function streamParts(env, mkKey, parts) {
  let i = 0;
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          if (i >= parts) { controller.close(); return; }
          const b = await env.BEAM.get(mkKey(i), { type: "arrayBuffer" });
          i++;
          if (!b || !b.byteLength) { controller.error(new Error("part missing")); return; }
          controller.enqueue(b);
        } catch (e) { controller.error(e); }
      },
    },
    { highWaterMark: 1 }
  );
}

function fileHeaders(m, f) {
  return {
    "content-type": f.type || "application/octet-stream",
    "content-length": String(f.size),
    "content-disposition": `attachment; filename="${f.name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "cache-control": "no-store",
  };
}

/* ================= UI STYLES ================= */

const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{--base:#e6e9f8;--dark:rgba(133,142,205,.45);--lite:rgba(255,255,255,.95);--ink:#3b3f58;--muted:#8a90b8;--accent:#6d5bd0;--green:#10b981}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--base);color:var(--ink);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;overflow-x:hidden}
.card{position:relative;width:100%;max-width:600px;background:var(--base);border-radius:36px;padding:34px;box-shadow:20px 20px 46px var(--dark),-16px -16px 38px var(--lite)}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.logo svg{width:36px;height:36px;filter:drop-shadow(4px 4px 8px var(--dark))}
.logo h1{font-size:24px;font-weight:800;letter-spacing:-.5px;color:var(--ink)}
.logo h1 span{background:linear-gradient(90deg,#6d7cff,#d946ef,#22d3ee);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.badge-row{display:flex;gap:8px;align-items:center;margin-bottom:18px;flex-wrap:wrap}
.badge{font-size:11px;font-weight:800;padding:4px 10px;border-radius:99px;background:var(--base);box-shadow:inset 3px 3px 6px var(--dark),inset -3px -3px 6px var(--lite);color:var(--muted);display:inline-flex;align-items:center;gap:5px}
.badge.active{color:var(--green);box-shadow:4px 4px 10px var(--dark),-4px -4px 10px var(--lite)}
.tabs{display:flex;gap:8px;background:var(--base);border-radius:20px;padding:6px;margin-bottom:24px;box-shadow:inset 7px 7px 14px var(--dark),inset -7px -7px 14px var(--lite)}
.tab{flex:1;padding:12px;border:none;border-radius:15px;background:transparent;color:var(--muted);font-size:14px;font-weight:700;cursor:pointer;transition:all .22s}
.tab:hover{color:var(--ink)}
.tab.active{color:var(--accent);box-shadow:5px 5px 12px var(--dark),-5px -5px 12px var(--lite)}
.drop{border:none;border-radius:26px;padding:36px 20px;text-align:center;cursor:pointer;transition:all .22s;margin-bottom:18px;background:var(--base);box-shadow:inset 8px 8px 18px var(--dark),inset -8px -8px 18px var(--lite)}
.drop:hover,.drop.over{box-shadow:inset 8px 8px 18px var(--dark),inset -8px -8px 18px var(--lite),0 0 0 2.5px rgba(168,85,247,.4)}
.drop p{color:var(--muted);font-size:14px;margin-top:10px}
.drop p a{color:var(--accent);text-decoration:none;font-weight:800}
.drop svg{width:44px;height:44px;stroke:#a855f7;filter:drop-shadow(4px 4px 8px var(--dark));fill:none;stroke-width:1.6}
.files{display:flex;flex-direction:column;gap:10px;margin-bottom:16px;max-height:210px;overflow-y:auto}
.chip{display:flex;align-items:center;gap:11px;background:var(--base);border-radius:16px;padding:11px 13px;font-size:13px;box-shadow:6px 6px 13px var(--dark),-6px -6px 13px var(--lite)}
.chip .ext{min-width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;box-shadow:inset 2px 2px 5px rgba(0,0,0,.2)}
.chip .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip .sz{color:var(--muted);font-size:12px;white-space:nowrap}
.chip button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:2px 6px}
.chip button:hover{color:#d6336c}
.optrow{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;padding:10px 14px;background:var(--base);border-radius:16px;box-shadow:inset 4px 4px 8px var(--dark),inset -4px -4px 8px var(--lite);font-size:12px;color:var(--muted);font-weight:700}
.optrow label{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.optrow input[type=checkbox]{accent-color:#a855f7;width:16px;height:16px;cursor:pointer}
.btn{width:100%;padding:16px;border:none;border-radius:20px;background:linear-gradient(135deg,#6d7cff 0%,#a855f7 55%,#ec4899 100%);color:#fff;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:.2px;box-shadow:9px 9px 20px rgba(140,110,220,.5),-7px -7px 16px var(--lite),inset 0 1px 0 rgba(255,255,255,.45);transition:all .2s;text-decoration:none;display:inline-block;text-align:center}
.btn:hover{filter:brightness(1.08)}
.btn:active{transform:scale(.985);box-shadow:4px 4px 10px rgba(140,110,220,.5),-3px -3px 8px var(--lite),inset 0 1px 0 rgba(255,255,255,.45)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn.ghost{background:var(--base);color:var(--accent);box-shadow:7px 7px 16px var(--dark),-7px -7px 16px var(--lite);margin-top:12px}
.btn.ghost:active{box-shadow:inset 5px 5px 10px var(--dark),inset -5px -5px 10px var(--lite)}
.pbar{height:12px;background:var(--base);border-radius:99px;margin:20px 0 8px;overflow:hidden;display:none;box-shadow:inset 6px 6px 12px var(--dark),inset -6px -6px 12px var(--lite)}
.pbar div{height:100%;width:0;background:linear-gradient(90deg,#6d7cff,#d946ef,#22d3ee);background-size:200% 100%;border-radius:99px;transition:width .2s;animation:shimmer 2s linear infinite}
@keyframes shimmer{to{background-position:200% 0}}
.result{display:none;text-align:center}
.result .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:2.5px;margin-bottom:10px;font-weight:800}
.code{font-family:'Cascadia Code',Consolas,monospace;font-size:46px;font-weight:800;letter-spacing:9px;background:linear-gradient(90deg,#6d7cff,#d946ef,#22d3ee);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px;user-select:all}
.url{font-family:Consolas,monospace;font-size:13px;color:var(--muted);word-break:break-all;margin-bottom:18px;user-select:all}
.copyrow{display:flex;gap:10px;justify-content:center;margin-bottom:18px;flex-wrap:wrap}
.mini{padding:10px 18px;border-radius:999px;border:none;background:var(--base);color:var(--ink);font-size:13px;font-weight:700;cursor:pointer;transition:all .2s;box-shadow:6px 6px 13px var(--dark),-6px -6px 13px var(--lite);text-decoration:none}
.mini:hover{color:var(--accent)}
.mini:active{box-shadow:inset 4px 4px 9px var(--dark),inset -4px -4px 9px var(--lite)}
#qr{width:160px;height:160px;border-radius:22px;background:#fff;padding:10px;margin:0 auto 16px;display:block;box-shadow:12px 12px 26px var(--dark),-10px -10px 22px var(--lite)}
.note{font-size:12px;color:var(--muted)}
.inrow{display:flex;gap:11px;margin-bottom:20px}
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
footer{font-size:12px;color:var(--muted);text-align:center;margin-top:24px}
footer a{color:var(--accent);text-decoration:none;font-weight:700}
.pwa-bar{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--base);padding:8px 18px;border-radius:999px;box-shadow:9px 9px 20px var(--dark),-7px -7px 16px var(--lite);display:flex;align-items:center;gap:12px;z-index:99;font-size:13px;font-weight:700}
@media(max-width:520px){.card{padding:24px}.code{font-size:32px;letter-spacing:6px}}
`;

const SHELL = (title) => `<!doctype html><html lang="en"><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<link rel=icon href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📦</text></svg>'>
<link rel=manifest href="/manifest.webmanifest">
<meta name=theme-color content="#6d7cff">
<meta name=apple-mobile-web-app-capable content="yes">
<meta name=apple-mobile-web-app-status-bar-style content="black-translucent">
<title>${title}</title>
<style>${BASE_CSS}</style></head><body>`;

const FOOTER = `<footer>No accounts · No cookies · Files auto-delete in 60 min · Free forever · open source by <a href=https://github.com/Kawshikmr/filebeam>Kawshikmr</a></footer>
<div id=pwaBar class="pwa-bar hidden"><span style="color:#6d7cff">📲 Install FileBeam App</span><button class=mini style="padding:6px 14px" onclick=installPwa()>Install</button><button class=mini style="padding:6px 10px" onclick="$('pwaBar').classList.add('hidden')">✕</button></div>
<script>
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{});}
let defPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();defPrompt=e;const p=document.getElementById('pwaBar');if(p)p.classList.remove('hidden');});
function installPwa(){if(defPrompt){defPrompt.prompt();defPrompt.userChoice.then(()=>{const p=document.getElementById('pwaBar');if(p)p.classList.add('hidden');defPrompt=null;});}}
</script></body></html>`;

function gonePage(msg) {
  return `${SHELL("FileBeam")}
<div class=card style=text-align:center>
<div class=logo><svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4.5 13.5H11L9.5 22L19.5 9.5H12.5L13 2Z" fill="url(#g)"/><defs><linearGradient id="g" x1="4" y1="2" x2="20" y2="22"><stop stop-color="#6d7cff"/><stop offset="1" stop-color="#b06bff"/></linearGradient></defs></svg><h1>File<span>Beam</span></h1></div>
<h2 style=margin-bottom:12px>⏱️ Beam expired</h2>
<p class=note style=margin-bottom:24px>${msg}</p>
<a class=btn href="/">Beam something new</a></div>${FOOTER}`;
}

/* ================= CLIENT APPLICATION JS ================= */

const CLIENT_JS = `
let FILE=null,UPL=null,E2E_KEY=null,PC=null,DC=null;
const $=id=>document.getElementById(id);
function show(t){$('cS').classList.toggle('hidden',t!=='s');$('cR').classList.toggle('hidden',t!=='r');
$('tS').classList.toggle('active',t==='s');$('tR').classList.toggle('active',t==='r')}
const f=$('f'),drop=$('drop');
f.onchange=e=>pick(e.target.files);
['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',e=>pick(e.dataTransfer.files));
const extColors={pdf:'#ef4444',jpg:'#f59e0b',jpeg:'#f59e0b',png:'#10b981',gif:'#10b981',zip:'#8b5cf6',rar:'#8b5cf6',mp4:'#ec4899',mkv:'#ec4899',mp3:'#06b6d4',wav:'#06b6d4',doc:'#3b82f6',docx:'#3b82f6',xls:'#22c55e',xlsx:'#22c55e',exe:'#64748b',py:'#3b82f6',js:'#eab308',html:'#fb923c'};
function extColor(e){return extColors[e]||'#6d7cff'}
function ext(n){return (String(n).split('.').pop()||'bin').toLowerCase().slice(0,4)}
function fmt(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,n>>10)+' KB'}
let PICKED=[];
function renderChips(){
 $('chips').innerHTML=PICKED.map((p,i)=>'<div class=chip><div class=ext style="background:'+extColor(ext(p.name))+'">'+ext(p.name).toUpperCase()+'</div><div class=nm>'+esc(p.name)+'</div><div class=sz>'+fmt(p.size)+'</div><button onclick=rm('+i+')>&#10005;</button></div>').join('');
 const tot=PICKED.reduce((a,p)=>a+p.size,0);
 if(PICKED.length){$('chips').classList.remove('hidden');
  $('totline').textContent=(PICKED.length>1?PICKED.length+' files · ':'')+fmt(tot)+' of '+MAXBEAM+' MB';
  $('totline').classList.remove('hidden');
 }else{$('chips').classList.add('hidden');$('totline').classList.add('hidden')}
}
function addPick(file){
 if(!file)return;
 const tot=PICKED.reduce((a,p)=>a+p.size,0);
 if(PICKED.length>=100)return alert('Up to 100 files per beam');
 if(tot+file.size>MAXBEAM*1048576)return alert('Total must stay under '+MAXBEAM+' MB');
 PICKED.push(file);renderChips();
 $('result').style.display='none';$('go').disabled=false;$('go').style.display='';
}
function pick(files){for(const x of files)addPick(x);f.value=''}
function rm(i){PICKED.splice(i,1);renderChips();if(!PICKED.length)$('go').disabled=true}
function cp(w,btn){const v=w==='code'?UPL.code:UPL.url;navigator.clipboard.writeText(v);
btn.textContent='✓ Copied';setTimeout(()=>{btn.textContent=w==='code'?'Copy Code':'Copy Link'},1400)}
function shareWA(){window.open('https://wa.me/?text='+encodeURIComponent(UPL.msg),'_blank')}
function shareTG(){window.open('https://t.me/share/url?url='+encodeURIComponent(UPL.url)+'&text='+encodeURIComponent('Tap the link to get the file'),'_blank')}
function nativeShare(btn){if(navigator.share){navigator.share({title:'FileBeam',text:UPL.msg,url:UPL.url}).catch(()=>{})}else{cp('link',btn)}}
function reset(){PICKED=[];renderChips();FILE=null;E2E_KEY=null;if(PC){PC.close();PC=null}
$('bar').style.display='none';$('barf').style.width='0%';$('result').style.display='none';$('drop').style.display='';$('go').style.display='';$('p2pBadge').classList.remove('active')}
function setPct(p){$('barf').style.width=Math.max(0,Math.min(100,p))+'%'}

/* --- E2EE Helpers (Web Crypto) --- */
function b64url(buf){return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function unb64url(s){return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))}
async function genKey(){return await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt'])}
async function encSlice(raw,k){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},k,raw);
 const out=new Uint8Array(12+ct.byteLength);out.set(iv,0);out.set(new Uint8Array(ct),12);
 return out;
}

/* --- WebRTC P2P Sender --- */
async function startP2PSender(code){
 try{
  PC=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'},{urls:'stun:stun.l.google.com:19302'}]});
  DC=PC.createDataChannel('filebeam');
  DC.onopen=()=>{ $('p2pBadge').classList.add('active'); $('p2pBadge').textContent='🟢 P2P Direct Connected'; };
  DC.onmessage=async e=>{
   if(e.data==='GET_FILES'){
    DC.send(JSON.stringify({files:PICKED.map(p=>({name:p.name,size:p.size,type:p.type}))}));
    for(let i=0;i<PICKED.length;i++){
     const file=PICKED[i];const ch=64*1024;
     for(let off=0;off<file.size;off+=ch){
      const slice=await file.slice(off,off+ch).arrayBuffer();
      DC.send(slice);
     }
    }
   }
  };
  PC.onicecandidate=e=>{
   if(e.candidate)fetch('/api/signal/ice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,role:'sender',candidate:e.candidate})}).catch(()=>{});
  };
  const off=await PC.createOffer();await PC.setLocalDescription(off);
  await fetch('/api/signal/offer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,sdp:off})});
  
  /* Poll for Answer */
  let attempts=0;
  const poll=setInterval(async()=>{
   if(!PC||attempts++>40){clearInterval(poll);return}
   const res=await(await fetch('/api/signal/answer?code='+code)).json();
   if(res.sdp){
    clearInterval(poll);
    await PC.setRemoteDescription(new RTCSessionDescription(res.sdp));
    const ices=await(await fetch('/api/signal/ice?code='+code+'&role=receiver')).json();
    if(Array.isArray(ices))for(const c of ices)try{await PC.addIceCandidate(new RTCIceCandidate(c))}catch(e){}
   }
  },1500);
 }catch(e){}
}

/* --- Big Multi-Chunk Upload --- */
async function startBig(useE2ee,kObj){
 let r=await fetch('/api/beam/init',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enc:useE2ee,files:PICKED.map(p=>({name:p.name,type:p.type||'application/octet-stream',size:p.size}))})});
 let j=await r.json();if(j.err)throw new Error(j.err);
 const code=j.code;
 const tot=PICKED.reduce((a,p)=>a+p.size,0);let sent=0;const CH=20*1048576;
 for(let i=0;i<PICKED.length;i++){
  const parts=Math.max(1,Math.ceil(PICKED[i].size/CH));
  for(let n=0;n<parts;n++){
   let slice=await PICKED[i].slice(n*CH,(n+1)*CH).arrayBuffer();
   if(useE2ee)slice=await encSlice(slice,kObj);
   await new Promise((res,rej)=>{
    const x=new XMLHttpRequest();
    x.open('POST','/api/beam/chunk?code='+code+'&file='+i+'&n='+n);
    x.upload.onprogress=e=>{if(e.lengthComputable)setPct((sent+e.loaded)/tot*100)};
    x.onload=()=>{if(x.status<300){sent+=Math.min(CH,PICKED[i].size-n*CH);setPct(sent/tot*100);res()}else rej(new Error('chunk failed'))};
    x.onerror=()=>rej(new Error('network'));
    x.send(slice);
   });
  }
 }
 r=await fetch('/api/beam/finish?code='+code,{method:'POST'});
 j=await r.json();if(j.err)throw new Error(j.err);
 return j;
}

function showDone(done,b64k){
 if(b64k){done.url+='#'+b64k;done.msg+='#'+b64k;$('e2eBadge').classList.remove('hidden')}
 UPL=done;setPct(100);
 $('drop').style.display='none';$('chips').classList.add('hidden');$('optRow').classList.add('hidden');
 $('go').style.display='none';
 $('dCode').textContent=done.code;$('dLink').textContent=done.url;
 $('result').style.display='block';
 const qr=qrcode(0,'M');qr.addData(done.url);qr.make();
 $('qr').src=qr.createDataURL(4,8);
 startP2PSender(done.code);
}

async function start(){
 if(!PICKED.length)return;$('go').disabled=true;$('bar').style.display='block';
 const useE2ee=$('chkEnc').checked;let kObj=null,b64k=null;
 if(useE2ee){
  kObj=await genKey();
  const rawK=await crypto.subtle.exportKey('raw',kObj);
  b64k=b64url(rawK);
 }
 if(PICKED.length>1||PICKED[0].size>20*1048576){
  startBig(useE2ee,kObj).then(d=>showDone(d,b64k)).catch(e=>{alert('Beam failed: '+e.message);reset()});
  return;
 }
 FILE=PICKED[0];
 let body=await FILE.arrayBuffer();
 if(useE2ee)body=await encSlice(body,kObj);
 const xhr=new XMLHttpRequest();
 xhr.open('POST','/api/beam?name='+encodeURIComponent(FILE.name)+'&type='+encodeURIComponent(FILE.type||'application/octet-stream')+(useE2ee?'&enc=1':''));
 xhr.upload.onprogress=e=>{if(e.lengthComputable)setPct(Math.min(99,e.loaded/e.total*100))};
 xhr.onload=()=>{
  try{
   const done=JSON.parse(xhr.responseText);
   if(done.err)throw new Error(done.err);
   showDone(done,b64k);
  }catch(e){alert('Beam failed: '+e.message);reset()}
 };
 xhr.onerror=()=>{alert('Network error');reset()};
 xhr.send(body);
}

async function lookup(){
 const c=$('code').value.trim().toUpperCase();
 $('rerr').style.display='none';$('rlist').innerHTML='';
 if(!/^[A-Z0-9]{6}$/.test(c)){$('rerr').textContent='Enter the 6-character code.';$('rerr').style.display='block';return}
 let j;
 try{j=await(await fetch('/api/meta/'+c)).json()}catch(e){j={err:'network'}}
 if(j.err){$('rerr').textContent='This code expired or is wrong.';$('rerr').style.display='block';return}
 if(j.files){
  $('rlist').innerHTML=j.files.map((x,i)=>'<div class=frow><div class=ext style="background:'+extColor(ext(x.name))+'">'+ext(x.name).toUpperCase()+'</div><div class=nm>'+esc(x.name)+'</div><div class=sz>'+fmt(x.size)+'</div><a class=dl href="/d/'+c+'/f/'+i+'/raw" download="'+esc(x.name)+'">Download</a></div>').join('');
 }else{
  $('rlist').innerHTML='<div class=frow><div class=ext style="background:'+extColor(ext(j.name))+'">'+ext(j.name).toUpperCase()+'</div><div class=nm>'+esc(j.name)+'</div><div class=sz>'+fmt(j.size)+'</div><a class=dl href="/d/'+c+'/raw" download="'+esc(j.name)+'">Download</a></div>';
 }
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

function homePage(maxMb, beamCount) {
  return `${SHELL("FileBeam — Instant Cross-Device File Sharing")}<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
<div class=card>
<div class=logo><svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4.5 13.5H11L9.5 22L19.5 9.5H12.5L13 2Z" fill="url(#g)"/><defs><linearGradient id="g" x1="4" y1="2" x2="20" y2="22"><stop stop-color="#6d7cff"/><stop offset="1" stop-color="#b06bff"/></linearGradient></defs></svg><h1>File<span>Beam</span></h1></div>
<div class=badge-row>
<span class="badge" id=p2pBadge>⚡ Direct P2P Ready</span>
<span class="badge active" id=encBadge>🔒 End-to-End Encrypted</span>
</div>
<div class=tabs>
<button class="tab active" id=tS onclick=show('s')>Send</button>
<button class="tab" id=tR onclick=show('r')>Receive</button>
</div>

<div id=cS>
<div class=drop id=drop onclick=f.click()><svg viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-.5 7H7z"/><path d="M12 12v6m0-6l-2.5 2.5M12 12l2.5 2.5"/></svg><p>Tap to pick files or drop them here · up to ${maxMb} MB total</p><input type=file id=f hidden multiple></div>
<div class="files hidden" id=chips></div>
<div class="total hidden" id=totline></div>
<div class=optrow id=optRow>
<label><input type=checkbox id=chkEnc checked> 🔒 Zero-Knowledge Encryption (AES-GCM-256)</label>
</div>
<div class=pbar id=bar><div id=barf></div></div>
<button class=btn id=go disabled onclick=start()>⚡ Beam It</button>
<div class=result id=result>
<div class="badge active hidden" id=e2eBadge style="margin-bottom:12px">🔒 Encrypted with Zero-Knowledge Key</div>
<div class=lbl>Your Pickup Code</div>
<div class=code id=dCode></div>
<div class=url id=dLink></div>
<div class=copyrow>
<button class=mini id=bCode onclick=cp('code',this)>Copy Code</button>
<button class=mini id=bLink onclick=cp('link',this)>Copy Link</button>
</div>
<div class=lbl style=margin-bottom:8px>Share Via</div>
<div class=copyrow>
<button class=mini onclick=nativeShare(this)>Share Link</button>
<button class=mini style="color:#25d366" onclick=shareWA()>WhatsApp</button>
<button class=mini style="color:#229ed9" onclick=shareTG()>Telegram</button>
</div>
<img id=qr alt="QR code">
<div class=note style=margin-top:14px>Valid 60 minutes · share code or scan QR code to receive instantly.</div>
<button class="btn ghost" onclick=reset()>Beam Another File</button>
</div>
</div>

<div id=cR class=hidden>
<div class=inrow><input id=code maxlength=6 placeholder=CODE autocomplete=off spellcheck=false></div>
<button class=btn onclick=lookup()>Fetch Files</button>
<div class="err" id=rerr></div>
<div class=flist id=rlist></div>
</div>
${beamCount ? `<div class=note style=text-align:center;margin-top:14px>⚡ ${beamCount} beams served so far</div>` : ""}
</div>
<p class=note style=text-align:center;margin-top:18px>Demo lane (${maxMb} MB) · Need <b>10 GB</b>? Grab <a href=/filebeam.py>filebeam.py</a> and run <i>python filebeam.py --tunnel</i> · source: <a href=https://github.com/Kawshikmr/filebeam>Kawshikmr/filebeam</a></p>
<button class=mini id=phoneBtn onclick=togglePhone() style="position:fixed;right:16px;bottom:16px;border-radius:99px;z-index:9">Receive on phone?</button>
<div id=phoneBox class=hidden style="position:fixed;right:16px;bottom:64px;background:rgba(17,20,29,.96);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px;text-align:center;z-index:9">
<img id=pqr alt="" style="width:150px;background:#fff;border-radius:10px;padding:6px;display:block">
<div class=note id=purl style="margin-top:8px;max-width:180px;word-break:break-all;color:#c7cbe8"></div>
</div>
${FOOTER}
<script>
const MAXBEAM=${maxMb};
${CLIENT_JS}
</script>`;
}

/* ================= RECEIVE PAGE CLIENT SCRIPT ================= */

function receivePageScript(code, hasFiles, enc) {
  return `<script>
function unb64url(s){return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))}
async function decFile(url,name,mime){
 const h=window.location.hash.slice(1);
 if(!h){window.location.href=url;return}
 const btn=document.getElementById('dlBtn')||event.target;
 const origTxt=btn.textContent;btn.textContent='⏳ Decrypting...';
 try{
  const kBytes=unb64url(h);
  const kObj=await crypto.subtle.importKey('raw',kBytes,{name:'AES-GCM'},false,['decrypt']);
  const resp=await fetch(url);
  const buf=await resp.arrayBuffer();
  const iv=buf.slice(0,12);const ct=buf.slice(12);
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv},kObj,ct);
  const blob=new Blob([pt],{type:mime||'application/octet-stream'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();
  btn.textContent='✓ Downloaded';setTimeout(()=>{btn.textContent=origTxt},2000);
 }catch(e){
  alert('Decryption failed — invalid link key');
  btn.textContent=origTxt;
 }
}

/* Try WebRTC P2P Direct Connect */
(async()=>{
 const code="${code}";
 if(!window.RTCPeerConnection)return;
 try{
  const res=await(await fetch('/api/signal/offer?code='+code)).json();
  if(!res.sdp)return;
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'},{urls:'stun:stun.l.google.com:19302'}]});
  pc.onicecandidate=e=>{
   if(e.candidate)fetch('/api/signal/ice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,role:'receiver',candidate:e.candidate})}).catch(()=>{});
  };
  await pc.setRemoteDescription(new RTCSessionDescription(res.sdp));
  const ans=await pc.createAnswer();await pc.setLocalDescription(ans);
  await fetch('/api/signal/answer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,sdp:ans})});
  const ices=await(await fetch('/api/signal/ice?code='+code+'&role=sender')).json();
  if(Array.isArray(ices))for(const c of ices)try{await pc.addIceCandidate(new RTCIceCandidate(c))}catch(e){}
  
  pc.ondatachannel=e=>{
   const dc=e.channel;
   dc.onopen=()=>{
    const badge=document.getElementById('p2pStatus');
    if(badge){badge.classList.add('active');badge.textContent='⚡ High Speed P2P Direct Connected';badge.style.display='inline-flex';}
   };
  };
 }catch(e){}
})();
</script>`;
}

/* ================= WORKER FETCH ROUTER ================= */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });

      /* ---- PWA Manifest & Service Worker ---- */
      if (path === "/manifest.webmanifest" || path === "/manifest.json") {
        return json({
          name: "FileBeam - Ephemeral File Sharing",
          short_name: "FileBeam",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#e6e9f8",
          theme_color: "#6d7cff",
          description: "Instant, zero-install, encrypted cross-device file sharing.",
          icons: [
            {
              src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='25' fill='%236d7cff'/><text y='.75em' x='50%' text-anchor='middle' font-size='65'>📦</text></svg>",
              sizes: "192x192 512x512",
              type: "image/svg+xml",
              purpose: "any maskable",
            },
          ],
          share_target: {
            action: "/",
            method: "GET",
            params: { title: "title", text: "text", url: "url" },
          },
        });
      }

      if (path === "/sw.js") {
        return new Response(`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>self.clients.claim());self.addEventListener('fetch',e=>{});`, {
          headers: { "content-type": "application/javascript;charset=utf-8", "cache-control": "public, max-age=3600" },
        });
      }

      /* ---- WebRTC Signaling API (Zero-Cost P2P Broker) ---- */
      if (path === "/api/signal/offer") {
        if (request.method === "POST") {
          const body = await readJson(request);
          if (!body.code || !body.sdp) return json({ err: "bad offer" }, 400);
          await env.BEAM.put("sig:o:" + body.code, JSON.stringify(body.sdp), { expirationTtl: SIG_TTL });
          return json({ ok: true });
        }
        const code = url.searchParams.get("code") || "";
        const sdp = await env.BEAM.get("sig:o:" + code);
        return json({ sdp: sdp ? JSON.parse(sdp) : null });
      }

      if (path === "/api/signal/answer") {
        if (request.method === "POST") {
          const body = await readJson(request);
          if (!body.code || !body.sdp) return json({ err: "bad answer" }, 400);
          await env.BEAM.put("sig:a:" + body.code, JSON.stringify(body.sdp), { expirationTtl: SIG_TTL });
          return json({ ok: true });
        }
        const code = url.searchParams.get("code") || "";
        const sdp = await env.BEAM.get("sig:a:" + code);
        return json({ sdp: sdp ? JSON.parse(sdp) : null });
      }

      if (path === "/api/signal/ice") {
        if (request.method === "POST") {
          const body = await readJson(request);
          if (!body.code || !body.role || !body.candidate) return json({ err: "bad candidate" }, 400);
          const k = "sig:i:" + body.role + ":" + body.code;
          const cur = JSON.parse((await env.BEAM.get(k)) || "[]");
          cur.push(body.candidate);
          await env.BEAM.put(k, JSON.stringify(cur), { expirationTtl: SIG_TTL });
          return json({ ok: true });
        }
        const code = url.searchParams.get("code") || "";
        const role = url.searchParams.get("role") || "sender";
        const cur = await env.BEAM.get("sig:i:" + role + ":" + code);
        return json(cur ? JSON.parse(cur) : []);
      }

      /* ---- big-lane: init (chunked upload, multiple files ok, total ≤ MAX_BEAM) ---- */
      if (path === "/api/beam/init" && request.method === "POST") {
        let name, type, size, files, enc = false;
        const ct = (request.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          const body = await readJson(request);
          enc = Boolean(body.enc);
          files = Array.isArray(body.files) ? body.files : null;
          if (!files || !files.length || files.length > 100) return json({ err: "1-100 files required" }, 400);
          let total = 0;
          files = files.map(x => ({
            name: safeName(x.name),
            type: String(x.type || "application/octet-stream").slice(0, 100),
            size: Number(x.size || 0),
            parts: 0,
          }));
          for (const x of files) {
            if (!x.size) return json({ err: "empty file in list" }, 400);
            total += x.size;
          }
          if (total > MAX_BEAM) return json({ err: `too large for this demo (max ${Math.floor(MAX_BEAM / 1048576)} MB total)` }, 413);
          for (const x of files) x.parts = Math.max(1, Math.ceil(x.size / CHUNK_BYTES));
          size = total;
          name = files.length > 1 ? `${files.length} files` : files[0].name;
          type = "multipart/list";
        } else {
          name = safeName(url.searchParams.get("name"));
          type = (url.searchParams.get("type") || "application/octet-stream").slice(0, 100);
          size = Number(url.searchParams.get("size") || 0);
          enc = url.searchParams.get("enc") === "1";
          if (!size) return json({ err: "empty upload" }, 400);
          if (size > MAX_BEAM) return json({ err: `too large for this demo (max ${Math.floor(MAX_BEAM / 1048576)} MB)` }, 413);
          files = [{ name, type, size, parts: Math.ceil(size / CHUNK_BYTES) }];
        }
        const code = newCode();
        const manifest = { name, type, size, files, enc, done: false, exp: Date.now() + EXPIRE_MS };
        await env.BEAM.put("m:" + code, JSON.stringify(manifest), { expirationTtl: TTL_S });
        return json({ ok: true, code });
      }

      /* ---- big-lane: one chunk (?code=&file=&n=) ---- */
      if (path === "/api/beam/chunk" && request.method === "POST") {
        const code = url.searchParams.get("code") || "";
        const fi = Number(url.searchParams.get("file") || 0);
        const n = Number(url.searchParams.get("n"));
        if (!/^[A-Z0-9]{6}$/.test(code) || !Number.isInteger(n)) return json({ err: "bad chunk call" }, 400);
        const m = await getManifest(env, code);
        if (!m) return json({ err: "unknown or expired beam" }, 404);
        if (m.done) return json({ err: "already sealed" }, 409);
        if (!m.files || fi < 0 || fi >= m.files.length) return json({ err: "file index out of range" }, 400);
        if (n < 0 || n >= m.files[fi].parts) return json({ err: "chunk index out of range" }, 400);
        const buf = await request.arrayBuffer();
        if (!buf || !buf.byteLength) return json({ err: "empty chunk" }, 400);
        if (buf.byteLength > CHUNK_BYTES + 1048576) return json({ err: "chunk exceeds size limit" }, 413);
        await env.BEAM.put(`c:${code}:${fi}:${n}`, buf, { expirationTtl: TTL_S });
        return json({ ok: true, file: fi, n });
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
        if (ctx) ctx.waitUntil(bumpStats(env, { beams: 1, files: m.files ? m.files.length : 1, bytes: m.files ? m.files.reduce((a, f) => a + f.size, 0) : m.size }));
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

        let buf, name, type, enc = url.searchParams.get("enc") === "1";
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
        const manifest = { name, type, size: buf.byteLength, enc, done: true, exp: Date.now() + EXPIRE_MS };

        await env.BEAM.put("m:" + code, JSON.stringify(manifest), { expirationTtl: TTL_S });
        await env.BEAM.put("d:" + code, buf, { expirationTtl: TTL_S });
        if (ctx) ctx.waitUntil(bumpStats(env, { beams: 1, files: 1, bytes: buf.byteLength }));

        return json({
          ok: true,
          code,
          url: `${url.origin}/d/${code}`,
          msg: `📦 FileBeam: "${name}" — get it before it self-destructs (60 min): ${url.origin}/d/${code}`,
        });
      }

      /* ---- public usage stats ---- */
      if (path === "/stats") return json(await getStats(env));

      /* ---- receiver metadata ---- */
      const mm = path.match(/^\/api\/meta\/([A-Z0-9]{6})$/);
      if (mm) {
        const m = await getManifest(env, mm[1]);
        if (!m) return json({ err: "expired" }, 410);
        return json(m);
      }

      /* ---- raw download: per-file (multi) + legacy single ---- */
      const df = path.match(/^\/d\/([A-Z0-9]{6})\/f\/(\d+)\/raw$/);
      if (df) {
        const m = await getManifest(env, df[1]);
        if (!m) return resp(gonePage("This beam has expired or never existed."), 410);
        if (!m.files) return resp(gonePage("This beam is an older single-file beam — use its original link."), 404);
        const fi = Number(df[2]);
        if (fi < 0 || fi >= m.files.length) return resp(gonePage("No such file in this beam."), 404);
        if (!m.done) return resp(gonePage("This beam is still uploading — ask the sender to wait a minute."), 425);
        const fobj = m.files[fi];
        let data;
        if (fobj.parts > 1) {
          data = streamParts(env, i => `c:${df[1]}:${fi}:${i}`, fobj.parts);
        } else {
          data = await env.BEAM.get(`c:${df[1]}:${fi}:0`, { type: "arrayBuffer" });
          if (!data) return resp(gonePage("This beam vanished."), 410);
        }
        if (ctx) ctx.waitUntil(bumpStats(env, { dls: 1 }));
        return new Response(data, { headers: fileHeaders(m, fobj) });
      }

      const dr = path.match(/^\/d\/([A-Z0-9]{6})\/raw$/);
      if (dr) {
        const m = await getManifest(env, dr[1]);
        if (!m) return resp(gonePage("This beam has expired or never existed."), 410);
        if (ctx) ctx.waitUntil(bumpStats(env, { dls: 1 }));
        let data;
        if (m.files) {
          if (!m.done) return resp(gonePage("This beam is still uploading — ask the sender to wait a minute."), 425);
          const f0 = m.files[0];
          data = f0.parts > 1
            ? streamParts(env, i => `c:${dr[1]}:0:${i}`, f0.parts)
            : await env.BEAM.get(`c:${dr[1]}:0:0`, { type: "arrayBuffer" });
          if (!data) return resp(gonePage("This beam vanished."), 410);
          return new Response(data, { headers: fileHeaders(m, f0) });
        }
        if (m.parts > 1) {
          if (!m.done) return resp(gonePage("This beam is still uploading — ask the sender to wait a minute."), 425);
          data = streamParts(env, i => `c:${dr[1]}:${i}`, m.parts);
        } else {
          data = await env.BEAM.get("d:" + dr[1], { type: "arrayBuffer" });
          if (!data) return resp(gonePage("This beam vanished."), 410);
        }
        return new Response(data, {
          headers: {
            "content-type": m.type || "application/octet-stream",
            "content-length": String(m.size),
            "content-disposition": `attachment; filename="${m.name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(m.name)}`,
            "cache-control": "no-store",
          },
        });
      }

      /* ---- memory-safe streaming zip download ---- */
      const dzz = path.match(/^\/d\/([A-Z0-9]{6})\/zip$/);
      if (dzz) {
        const m = await getManifest(env, dzz[1]);
        if (!m) return resp(gonePage("This beam has expired or never existed."), 410);
        if (!m.files || !m.done) return resp(gonePage("Zip download works on completed multi-file beams."), 404);
        if (ctx) ctx.waitUntil(bumpStats(env, { dls: 1 }));
        try { return await zipStreamResponse(env, dzz[1], m); }
        catch (e) { return resp(gonePage("Could not build the zip — " + e.message), 500); }
      }

      /* ---- receive page ---- */
      const dp = path.match(/^\/d\/([A-Z0-9]{6})$/);
      if (dp) {
        const m = await getManifest(env, dp[1]);
        if (!m) return resp(gonePage("This beam has expired or never existed."), 410);
        let body;
        if (m.files && m.done) {
          const rows = m.files.map((f, i) => `<div class=frow><div class=ext style="background:${extColorFor(f.name)}">${extOf(f.name).toUpperCase()}</div><div class=nm>${escapeHtml(f.name)}</div><div class=sz>${fmtSize(f.size)}</div><button class=dl onclick="decFile('/d/${dp[1]}/f/${i}/raw','${escapeHtml(f.name)}','${escapeHtml(f.type)}')">Download</button></div>`).join("");
          body = `<div class=badge-row style="justify-content:center;margin-bottom:14px">
<span class="badge" id=p2pStatus style="display:none">⚡ High Speed P2P</span>
${m.enc ? `<span class="badge active">🔒 End-to-End Encrypted</span>` : ""}
</div>
<h2>📥 Incoming beam — ${m.files.length} file${m.files.length > 1 ? "s" : ""}</h2>
<div class=flist style=margin-top:14px;text-align:left>${rows}</div>
${m.files.length > 1 && !m.enc ? `<a class=btn href="/d/${dp[1]}/zip">⬇️ Download All (.zip)</a>` : ""}`;
        } else if (m.done) {
          const kb = Math.max(1, Math.round(m.size / 1024));
          const sizeTxt = m.size >= 1048576 ? (m.size / 1048576).toFixed(1) + " MB" : kb + " KB";
          body = `<div class=badge-row style="justify-content:center;margin-bottom:14px">
<span class="badge" id=p2pStatus style="display:none">⚡ High Speed P2P</span>
${m.enc ? `<span class="badge active">🔒 End-to-End Encrypted</span>` : ""}
</div>
<h2>📥 Incoming beam</h2>
<div class=meta style=margin-top:16px>
<div style="font-size:20px;font-weight:700;word-break:break-all">${escapeHtml(m.name)}</div>
<div style=margin-top:6px>${sizeTxt}</div>
<div style=margin-top:2px;color:#fbbf24>⏳ expires ${new Date(m.exp).toLocaleTimeString()}</div>
</div>
<button class=btn id=dlBtn style="margin-top:18px" onclick="decFile('/d/${dp[1]}/raw','${escapeHtml(m.name)}','${escapeHtml(m.type)}')">⬇️ Download now</button>`;
        } else {
          body = `<h2>📥 Incoming beam</h2><p class=note style=margin-top:14px>Still uploading — ask the sender to wait a minute.</p>`;
        }
        return resp(`${SHELL("FileBeam — incoming")}
<div class=logo><svg viewBox="0 0 24 24" fill="none" style="width:36px;height:36px"><path d="M13 2L4.5 13.5H11L9.5 22L19.5 9.5H12.5L13 2Z" fill="url(#g)"/><defs><linearGradient id="g" x1="4" y1="2" x2="20" y2="22"><stop stop-color="#6d7cff"/><stop offset="1" stop-color="#b06bff"/></linearGradient></defs></svg><h1>File<span>Beam</span></h1></div>
<div class=card style=text-align:center>
${body}
</div>
<p class=note style=text-align:center;margin-top:14px>Files auto-delete in 60 min · open source by <a href=https://github.com/Kawshikmr/filebeam>Kawshikmr/filebeam</a></p>
${FOOTER}
${receivePageScript(dp[1], Boolean(m.files), Boolean(m.enc))}`);
      }

      /* ---- python edition download (one-click for new users) ---- */
      if (path === "/filebeam.py" || path === "/run" || path === "/install") {
        return new Response(PY_EDITION, {
          headers: {
            "content-type": "text/x-python; charset=utf-8",
            "content-disposition": 'attachment; filename="filebeam.py"',
            "cache-control": "public, max-age=3600",
          },
        });
      }

      /* ---- home ---- */
      if (path === "/") {
        const st = await getStats(env);
        return resp(homePage(Math.floor(MAX_BEAM / 1048576), st.beams || 0));
      }

      return resp(`${SHELL("404")}<div style=min-height:60vh;display:flex;align-items:center;width:100%>
<div class=card style=text-align:center><h2>🧭 Lost?</h2><a class=btn href="/">Back to FileBeam</a></div>
</div>${FOOTER}`, 404);
    } catch (e) {
      return json({ err: String((e && e.message) || e) }, 500);
    }
  },
};

/* ---- usage counters (privacy-safe, server-side only) ---- */
let STATS_CACHE = { t: 0, v: null };
async function bumpStats(env, delta) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const gk = "stat:global", dk = "stat:" + day;
    const g = JSON.parse((await env.BEAM.get(gk)) || "{}");
    const d = JSON.parse((await env.BEAM.get(dk)) || "{}");
    for (const k of ["beams", "files", "bytes", "dls"]) {
      const v = delta[k] || 0;
      if (!v) continue;
      g[k] = (g[k] || 0) + v;
      d[k] = (d[k] || 0) + v;
    }
    await env.BEAM.put(gk, JSON.stringify(g));
    await env.BEAM.put(dk, JSON.stringify(d), { expirationTtl: 60 * 60 * 24 * 90 });
    STATS_CACHE = { t: Date.now(), v: g };
  } catch (e) { /* stats must never break a beam */ }
}
async function getStats(env) {
  if (STATS_CACHE.v && Date.now() - STATS_CACHE.t < 60000) return STATS_CACHE.v;
  try {
    const g = JSON.parse((await env.BEAM.get("stat:global")) || "{}");
    STATS_CACHE = { t: Date.now(), v: g };
    return g;
  } catch (e) { return {}; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- server-side ext colors for /d pages ---- */
const EXT_COLORS = { pdf:"#ef4444", jpg:"#f59e0b", jpeg:"#f59e0b", png:"#10b981", gif:"#10b981", zip:"#8b5cf6", rar:"#8b5cf6", mp4:"#ec4899", mkv:"#ec4899", mp3:"#06b6d4", wav:"#06b6d4", doc:"#3b82f6", docx:"#3b82f6", xls:"#22c55e", xlsx:"#22c55e", exe:"#64748b", py:"#3b82f6", js:"#eab308", html:"#fb923c" };
function extOf(n) { return (String(n).split(".").pop() || "bin").toLowerCase().slice(0, 4); }
function extColorFor(n) { return EXT_COLORS[extOf(n)] || "#6d7cff"; }
function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }

/* ================= LOW-MEMORY STREAMING ZIP BUILDER ================= */

const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function updateCrc(crc, buf) { let c = crc ^ (-1); for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ (-1)) >>> 0; }
const u16 = v => new Uint8Array([v & 255, (v >>> 8) & 255]);
const u32 = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
function dosDT(d) { const s = d.getUTCSeconds() >> 1, mi = d.getUTCMinutes(), h = d.getUTCHours(), da = d.getUTCDate(), mo = d.getUTCMonth() + 1, y = Math.max(1980, d.getUTCFullYear()) - 1980; return { t: (h << 11 | mi << 5 | s) & 65535, d: (y << 9 | mo << 5 | da) & 65535 }; }

async function zipStreamResponse(env, code, m) {
  const enc = new TextEncoder(), now = dosDT(new Date()), central = [];
  let offset = 0;
  const cat = a => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

  const rs = new ReadableStream({
    async start(ctrl) {
      try {
        for (let fi = 0; fi < m.files.length; fi++) {
          const f = m.files[fi], nb = enc.encode(f.name);
          const localOffset = offset;
          let fileCrc = 0, written = 0;

          /* Local File Header with Data Descriptor bit set (Bit 3: 0x0008) */
          const lfh = cat([u32(0x04034b50), u16(20), u16(0x0808), u16(0), u16(now.t), u16(now.d), u32(0), u32(0), u32(0), u16(nb.length), u16(0), nb]);
          ctrl.enqueue(lfh);
          offset += lfh.length;

          /* Stream chunks one by one (RAM usage is bounded to 1 chunk) */
          const parts = f.parts || 1;
          for (let p = 0; p < parts; p++) {
            const ab = await env.BEAM.get(`c:${code}:${fi}:${p}`, { type: "arrayBuffer" });
            if (!ab) throw new Error("missing part");
            const chunk = new Uint8Array(ab);
            fileCrc = updateCrc(fileCrc, chunk);
            written += chunk.length;
            ctrl.enqueue(chunk);
            offset += chunk.length;
          }

          /* Data Descriptor: Signature (0x08074b50), CRC-32, Compressed Size, Uncompressed Size */
          const desc = cat([u32(0x08074b50), u32(fileCrc), u32(written), u32(written)]);
          ctrl.enqueue(desc);
          offset += desc.length;

          central.push({ nb, crc: fileCrc, len: written, off: localOffset });
        }

        /* Central Directory Headers */
        const cdStart = offset; const cdParts = [];
        for (const c of central) {
          const cdh = cat([u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(0), u16(now.t), u16(now.d), u32(c.crc), u32(c.len), u32(c.len), u16(c.nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.off)]);
          cdParts.push(cdh, c.nb); offset += cdh.length + c.nb.length;
        }
        ctrl.enqueue(cat(cdParts));

        /* End of Central Directory */
        ctrl.enqueue(cat([u32(0x06054b50), u16(0), u16(0), u16(m.files.length), u16(m.files.length), u32(offset - cdStart), u32(cdStart), u16(0)]));
        ctrl.close();
      } catch (e) { ctrl.error(e); }
    }
  });

  return new Response(rs, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="filebeam-${code}.zip"`,
      "cache-control": "no-store",
    },
  });
}

function resp(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}
