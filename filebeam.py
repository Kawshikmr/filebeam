# FileBeam - Instant zero-dependency peer-to-peer file sharing
# Copyright (c) 2026 Kawshik. All rights reserved.
# Source: https://github.com/Kawshikmr/filebeam
# Licensed under the MIT License. See LICENSE in the project root.
import http.server
import socketserver
import socket
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import webbrowser
import zlib
import zipfile

HOST = "0.0.0.0"
PORT = 9348
TTL_SECONDS = 60 * 60
CHUNK = 256 * 1024
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
MAX_TOTAL = 10 * 1024 * 1024 * 1024

BASE_DIR = tempfile.mkdtemp(prefix="filebeam-")
TRANSFERS = {}
LOCK = threading.Lock()
DISPLAY_URL = None
BASE_URL = None
TUNNEL_ON = False


def new_code():
    return "".join(secrets.choice(ALPHABET) for _ in range(6))


def clean_name(name):
    name = urllib.parse.unquote(name).replace("\\", "/")
    parts = [p for p in name.split("/") if p not in ("", ".")]
    safe_parts = []
    for p in parts:
        p = re.sub(r'[<>:"|?*\x00-\x1f]', "_", os.path.basename(p)).strip()
        if p and p != "..":
            safe_parts.append(p[:100])
    out = "/".join(safe_parts)[:250]
    return out or "file"


def cleanup_loop():
    while True:
        time.sleep(60)
        now = time.time()
        with LOCK:
            dead = [c for c, e in TRANSFERS.items() if now - e["created"] > TTL_SECONDS]
            for c in dead:
                shutil.rmtree(TRANSFERS[c]["dir"], ignore_errors=True)
                del TRANSFERS[c]


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def mDNS_name():
    """Return the mDNS/Bonjour hostname (e.g., DESKTOP-ABC.local)"""
    try:
        name = socket.gethostname()
        return f"{name}.local"
    except Exception:
        return None


_EXP = [0] * 512
_LOG = [0] * 256


def _init_gf():
    x = 1
    for i in range(255):
        _EXP[i] = x
        _LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        _EXP[i] = _EXP[i - 255]


_init_gf()


def _gf_mul(a, b):
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _rs_encode(data, nec):
    gen = [1]
    for i in range(nec):
        ng = [0] * (len(gen) + 1)
        for j, c in enumerate(gen):
            ng[j] ^= c
            ng[j + 1] ^= _gf_mul(c, _EXP[i])
        gen = ng
    msg = list(data) + [0] * nec
    for i in range(len(data)):
        coef = msg[i]
        if coef:
            for j, c in enumerate(gen):
                msg[i + j] ^= _gf_mul(c, coef)
    return msg[len(data):]


_ECC_L = {1: (19, 7), 2: (34, 10), 3: (55, 15), 4: (80, 20), 5: (108, 26)}
_ALIGN = {2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30]}
_REMAINDER = {1: 0, 2: 7, 3: 7, 4: 7, 5: 7}


def _format_bits(mask):
    d = (0b01 << 3) | mask
    v = d << 10
    g = 0b10100110111
    for i in range(14, 9, -1):
        if v & (1 << i):
            v ^= g << (i - 10)
    return ((d << 10) | v) ^ 0b101010000010010


def _build_matrix(payload):
    data = payload.encode("utf-8")
    ver = None
    for v in sorted(_ECC_L):
        dcw, nec = _ECC_L[v]
        if len(data) <= dcw - 2:
            ver = v
            break
    if ver is None:
        return None
    dcw, nec = _ECC_L[ver]
    bits = "0100" + format(len(data), "08b")
    for b in data:
        bits += format(b, "08b")
    cap = dcw * 8
    term = min(4, cap - len(bits))
    bits += "0" * term
    while len(bits) % 8:
        bits += "0"
    pads = (dcw * 8 - len(bits)) // 8
    bits += ("1110110000010001" * ((pads * 8 // 16) + 1))[: pads * 8]
    cw = [int(bits[i * 8:(i + 1) * 8], 2) for i in range(dcw)]
    final = cw + _rs_encode(cw, nec)
    stream = "".join(format(b, "08b") for b in final)
    stream += "0" * _REMAINDER[ver]

    n = 17 + 4 * ver
    m = [[None] * n for _ in range(n)]

    def finder(r, c):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                rr, cc = r + dr, c + dc
                if 0 <= rr < n and 0 <= cc < n:
                    if 0 <= dr <= 6 and 0 <= dc <= 6:
                        ring = dr in (0, 6) or dc in (0, 6)
                        core = 2 <= dr <= 4 and 2 <= dc <= 4
                        m[rr][cc] = 1 if (ring or core) else 0
                    else:
                        m[rr][cc] = 0

    def align(r, c):
        for dr in range(-2, 3):
            for dc in range(-2, 3):
                m[r + dr][c + dc] = 1 if max(abs(dr), abs(dc)) in (0, 2) else 0

    finder(0, 0)
    finder(0, n - 7)
    finder(n - 7, 0)
    for i in range(8, n - 8):
        m[6][i] = 1 if i % 2 == 0 else 0
        m[i][6] = 1 if i % 2 == 0 else 0
    if ver >= 2:
        for a in _ALIGN[ver]:
            for b in _ALIGN[ver]:
                if (a <= 6 and b <= 6) or (a <= 6 and b >= n - 7) or (a >= n - 7 and b <= 6):
                    continue
                align(a, b)
    m[4 * ver + 9][8] = 1

    fb = _format_bits(0)
    fbits = [(fb >> i) & 1 for i in range(14, -1, -1)]
    reserved = set()
    for c in range(9):
        if c != 6:
            reserved.add((8, c))
    for r in range(9):
        if r != 6:
            reserved.add((r, 8))
    for i in range(8):
        reserved.add((n - 1 - i, 8))
    for i in range(8):
        reserved.add((8, n - 8 + i))

    col = n - 1
    up = True
    idx = 0
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(n - 1, -1, -1) if up else range(n)
        for r in rows:
            for c in (col, col - 1):
                if m[r][c] is None and (r, c) not in reserved:
                    bit = 1 if idx < len(stream) and stream[idx] == "1" else 0
                    idx += 1
                    flip = 1 if (r + c) % 2 == 0 else 0
                    m[r][c] = bit ^ flip
        up = not up
        col -= 2

    for i, bit in enumerate(fbits):
        if i < 6:
            m[8][i] = bit
        elif i == 6:
            m[8][7] = bit
        elif i == 7:
            m[8][8] = bit
        elif i == 8:
            m[7][8] = bit
        else:
            m[14 - i][8] = bit
    for i in range(8):
        m[n - 1 - i][8] = fbits[i]
    for i in range(8):
        m[8][n - 8 + i] = fbits[i]
    return m


def qr_svg(data):
    mat = _build_matrix(data[:200])
    if mat is None:
        return None
    n = len(mat)
    q = 4
    size = (n + 2 * q) * 8
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" shape-rendering="crispEdges">']
    parts.append(f'<rect width="{size}" height="{size}" fill="#ffffff"/>')
    for r in range(n):
        for c in range(n):
            if mat[r][c]:
                parts.append(f'<rect x="{(c+q)*8}" y="{(r+q)*8}" width="8" height="8"/>')
    parts.append("</svg>")
    return "".join(parts)


PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FileBeam</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--base:#e6e9f8;--dark:rgba(133,142,205,.45);--lite:rgba(255,255,255,.95);--ink:#3b3f58;--muted:#8a90b8}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--base);color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:22px;overflow-x:hidden}
.bg{display:none}
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
.drop svg{width:44px;height:44px;stroke:#a855f7;filter:drop-shadow(4px 4px 8px var(--dark))}
.files{display:flex;flex-direction:column;gap:10px;margin-bottom:16px;max-height:210px;overflow-y:auto}
.chip{display:flex;align-items:center;gap:11px;background:var(--base);border-radius:16px;padding:11px 13px;font-size:13px;box-shadow:6px 6px 13px var(--dark),-6px -6px 13px var(--lite)}
.chip .ext{min-width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;box-shadow:inset 2px 2px 5px rgba(0,0,0,.18)}
.chip .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip .sz{color:var(--muted);font-size:12px;white-space:nowrap}
.chip button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:2px 6px}
.chip button:hover{color:#d6336c}
.total{font-size:12px;color:var(--muted);margin-bottom:14px}
.btn{width:100%;padding:16px;border:none;border-radius:20px;background:linear-gradient(135deg,#6d7cff 0%,#a855f7 55%,#ec4899 100%);color:#fff;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:.2px;box-shadow:9px 9px 20px rgba(140,110,220,.5),-7px -7px 16px var(--lite),inset 0 1px 0 rgba(255,255,255,.45);transition:all .2s}
.btn:hover{filter:brightness(1.08)}
.btn:active{transform:scale(.985);box-shadow:4px 4px 10px rgba(140,110,220,.5),-3px -3px 8px var(--lite),inset 0 1px 0 rgba(255,255,255,.45)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn.ghost{background:var(--base);color:#6d5bd0;box-shadow:7px 7px 16px var(--dark),-7px -7px 16px var(--lite);margin-top:12px}
.btn.ghost:active{box-shadow:inset 5px 5px 10px var(--dark),inset -5px -5px 10px var(--lite)}
.pbar{height:12px;background:var(--base);border-radius:99px;margin:20px 0 8px;overflow:hidden;display:none;box-shadow:inset 6px 6px 12px var(--dark),inset -6px -6px 12px var(--lite)}
.pbar div{height:100%;width:0;background:linear-gradient(90deg,#6d7cff,#d946ef,#22d3ee);background-size:200% 100%;border-radius:99px;transition:width .2s;animation:shimmer 2s linear infinite}
@keyframes shimmer{to{background-position:200% 0}}
.ptext{font-size:12px;color:var(--muted);text-align:center;display:none}
.result{display:none;text-align:center}
.result .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:2.5px;margin-bottom:12px;font-weight:800}
.code{font-family:'Cascadia Code',Consolas,monospace;font-size:47px;font-weight:800;letter-spacing:10px;background:linear-gradient(90deg,#6d7cff,#d946ef,#22d3ee);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px;user-select:all}
.url{font-family:Consolas,monospace;font-size:13px;color:var(--muted);word-break:break-all;margin-bottom:20px;user-select:all}
.copyrow{display:flex;gap:11px;justify-content:center;margin-bottom:22px;flex-wrap:wrap}
.mini{padding:11px 21px;border-radius:999px;border:none;background:var(--base);color:var(--ink);font-size:13px;font-weight:700;cursor:pointer;transition:all .2s;box-shadow:6px 6px 13px var(--dark),-6px -6px 13px var(--lite)}
.mini:hover{color:#6d5bd0}
.mini:active{box-shadow:inset 4px 4px 9px var(--dark),inset -4px -4px 9px var(--lite)}
.mini.ok{color:#0ca678}
.mini.prev{background:var(--base);color:var(--ink);box-shadow:6px 6px 13px var(--dark),-6px -6px 13px var(--lite);padding:7px 14px;font-size:12px}
.mini.prev:hover{color:#a855f7}
.mini.prev:active{box-shadow:inset 4px 4px 9px var(--dark),inset -4px -4px 9px var(--lite)}
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
@media(max-width:520px){.card{padding:26px}.code{font-size:33px;letter-spacing:6px}}
</style>
</head>
<body>
<div class="bg"></div>
<div class="card">
<div class="logo">
<svg viewBox="0 0 24 24" fill="none"><path d="M13 2L4.5 13.5H11L9.5 22L19.5 9.5H12.5L13 2Z" fill="url(#g)"/><defs><linearGradient id="g" x1="4" y1="2" x2="20" y2="22"><stop stop-color="#6d7cff"/><stop offset="1" stop-color="#b06bff"/></linearGradient></defs></svg>
<h1>File<span>Beam</span></h1>
</div>
<div class="tabs">
<button class="tab active" id="tabSend" onclick="show('send')">Send</button>
<button class="tab" id="tabRecv" onclick="show('recv')">Receive</button>
</div>

<div id="paneSend">
<div class="drop" id="drop">
<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0l-4 4m4-4l4 4"/><path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
<p>Drop files or folders here, or <a href="#" style="color:#6d7cff" onclick="event.preventDefault();$('fi').click()">browse files</a> / <a href="#" style="color:#6d7cff" onclick="event.preventDefault();$('fid').click()">pick a folder</a></p>
<input type="file" id="fi" multiple class="hidden">
<input type="file" id="fid" webkitdirectory class="hidden">
</div>
<div class="files hidden" id="chips"></div>
<div class="total hidden" id="totline"></div>
<div class="pbar" id="pb"><div id="pbf"></div></div>
<div class="ptext" id="pt"></div>
<button class="btn" id="sendBtn" disabled onclick="doSend(false)">Beam It</button>

<div class="result" id="result">
<div class="lbl">Your Code</div>
<div class="code" id="codeOut"></div>
<div class="url" id="urlOut"></div>
<div class="copyrow">
<button class="mini" id="cpCode" onclick="cp('code')">Copy Code</button>
<button class="mini" id="cpUrl" onclick="cp('url')">Copy Link</button>
</div>
<div class="lbl" style="margin-bottom:10px">Share Via</div>
<div class="copyrow">
<button class="mini" onclick="nativeShare()">Share</button>
<button class="mini" style="border-color:#25d366;color:#25d366" onmouseover="" onclick="shareWA()">WhatsApp</button>
<button class="mini" style="border-color:#229ed9;color:#229ed9" onclick="shareTG()">Telegram</button>
</div>
<img id="qr" alt="QR">
<div class="note">Valid 60 minutes. Share the code or link with the receiver.</div>
<button class="btn ghost" style="margin-top:18px" onclick="resetSend()">Beam Another File</button>
</div>
</div>

<div id="paneRecv" class="hidden">
<div class="err" id="rerr"></div>
<div class="inrow">
<input id="codeIn" maxlength="6" placeholder="CODE" autocomplete="off">
</div>
<button class="btn" onclick="doLookup()">Fetch Files</button>
<div class="flist hidden" id="rlist" style="margin-top:20px"></div>
<button class="btn ghost hidden" id="dlAll" onclick="dlAll()">Download All (zip)</button>
</div>
</div>

<button class="mini" id="phoneBtn" onclick="togglePhone()" style="position:fixed;right:16px;bottom:16px;border-radius:99px">Receive on phone?</button>
<div id="phoneBox" class="hidden" style="position:fixed;right:16px;bottom:64px;background:rgba(17,20,29,.95);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:14px;text-align:center;z-index:9">
<img id="pqr" alt="" style="width:150px;background:#fff;border-radius:10px;padding:6px;display:block">
<div class="note" id="purl" style="margin-top:8px;max-width:180px;word-break:break-all"></div>
</div>

<script>
const $=id=>document.getElementById(id);
let picked=[],sid=null,RCODE=null;
const extColors={pdf:'#ef4444',jpg:'#f59e0b',jpeg:'#f59e0b',png:'#10b981',gif:'#10b981',zip:'#8b5cf6',rar:'#8b5cf6',mp4:'#ec4899',mkv:'#ec4899',mp3:'#06b6d4',wav:'#06b6d4',doc:'#3b82f6',docx:'#3b82f6',xls:'#22c55e',xlsx:'#22c55e',exe:'#64748b',py:'#3b82f6',js:'#eab308',html:'#fb923c'};
function ext(n){const p=n.split('.');return p.length>1?p.pop().toLowerCase():'?'}
function extColor(e){return extColors[e]||'#6d7cff'}
function fmt(b){if(b<1024)return b+' B';if(b<1048576)return (b/1024).toFixed(1)+' KB';if(b<1073741824)return (b/1048576).toFixed(1)+' MB';return (b/1073741824).toFixed(2)+' GB'}
function show(t){['send','recv'].forEach(x=>{$('pane'+(x==='send'?'Send':'Recv')).classList.toggle('hidden',x!==t);$('tab'+(x==='send'?'Send':'Recv')).classList.toggle('active',x===t)})}
const drop=$('drop');
drop.onclick=()=>$('fi').click();
$('fi').onchange=e=>addFiles(e.target.files);
['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',e=>handleDrop(e.dataTransfer));
function addFiles(fl){for(const f of fl){f._rel=f.webkitRelativePath||f._rel||f.name;if(!picked.some(p=>p.name===f.name&&p.size===f.size))picked.push(f)}render()}
async function handleDrop(dt){
let entries=[];
if(dt.items&&dt.items.length&&dt.items[0].webkitGetAsEntry){
for(const it of dt.items){const en=it.webkitGetAsEntry();if(en)entries.push(en)}
}
if(!entries.length){addFiles(dt.files);return}
const out=[];
const walk=(en,base)=>new Promise(res=>{
if(en.isFile){en.file(f=>{f._rel=base+f.name;out.push(f);res()},()=>res())}
else if(en.isDirectory){
const rd=en.createReader();
const next=()=>rd.readEntries(async list=>{
if(!list.length)return res();
for(const c of list)await walk(c,base+en.name+'/');
next()
},()=>res())
}else res()
});
for(const en of entries)await walk(en,'');
if(out.length)addFiles(out);
}
function render(){
const c=$('chips');c.innerHTML='';
let tot=0;
picked.forEach((f,i)=>{tot+=f.size;
const d=document.createElement('div');d.className='chip';
const e=ext(f.name);
d.innerHTML=`<div class="ext" style="background:${extColor(e)}">${e.slice(0,4).toUpperCase()}</div><div class="nm">${f._rel||f.name}</div><div class="sz">${fmt(f.size)}</div><button onclick="rm(${i})">&#10005;</button>`;
c.appendChild(d)});
c.classList.toggle('hidden',!picked.length);
$('totline').textContent=picked.length?`${picked.length} file(s) - ${fmt(tot)} total`:'';
$('totline').classList.toggle('hidden',!picked.length);
$('sendBtn').disabled=!picked.length;
}
function rm(i){picked.splice(i,1);render()}
function doSend(direct){
if(!picked.length)return;
$('sendBtn').disabled=true;$('sendBtn').textContent='Beaming...';
$('pb').style.display='block';$('pt').style.display='block';
const total=picked.reduce((a,f)=>a+f.size,0);let sent=0;
const next=i=>{
if(i>=picked.length){finish();return}
const f=picked[i];const x=new XMLHttpRequest();
x.open('POST','/api/upload',true);
x.setRequestHeader('X-File-Name',encodeURIComponent(f._rel||f.name));
if(sid)x.setRequestHeader('X-Beam-Sid',sid);
x.upload.onprogress=e=>{const overall=sent+e.loaded;$('pbf').style.width=(overall/total*100)+'%';$('pt').textContent=`${fmt(overall)} / ${fmt(total)}`};
x.onload=()=>{if(x.status===200){const r=JSON.parse(x.responseText);sid=r.sid;sent+=f.size;next(i+1)}else{fail('Upload failed ('+x.status+')')}};
x.onerror=()=>fail('Connection lost');
x.send(f)};
next(0);
function fail(m){$('pt').textContent=m;$('sendBtn').disabled=false;$('sendBtn').textContent='Beam It'}
function finish(){
fetch('/api/finish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:sid,direct:direct})})
.then(r=>r.json()).then(r=>{
if(r.direct){
$('pbf').style.width='100%';
$('pt').textContent='Sent - files saved in the FileBeam Inbox folder on this PC';
setTimeout(resetSend,2500);
return}
$('pbf').style.width='100%';$('pt').textContent='Done';
const link=r.url+'/?code='+r.code;
$('codeOut').textContent=r.code;
$('urlOut').textContent=link;
$('qr').src='/api/qr?data='+encodeURIComponent(link);
$('result').style.display='block';
drop.classList.add('hidden');$('chips').classList.add('hidden');$('totline').classList.add('hidden');
$('sendBtn').classList.add('hidden');
}).catch(()=>fail('Finish failed'));
}
}
function cp(w){
const t=w==='code'?$('codeOut').textContent:$('urlOut').textContent;
navigator.clipboard.writeText(t).then(()=>{
const b=$(w==='code'?'cpCode':'cpUrl');b.textContent='Copied';b.classList.add('ok');
setTimeout(()=>{b.textContent=w==='code'?'Copy Code':'Copy Link';b.classList.remove('ok')},1500)});
}
function shareText(){
const c=$('codeOut').textContent,u=$('urlOut').textContent;
return {c,u,msg:`Files incoming! Tap to receive:\n${u}\nCode: ${c}`};
}
function nativeShare(){
const s=shareText();
if(navigator.share){navigator.share({title:'FileBeam',text:s.msg}).catch(()=>{})}
else{navigator.clipboard.writeText(s.msg);const b=event.target;b.textContent='Copied';setTimeout(()=>b.textContent='Share',1500)}
}
function shareWA(){
const s=shareText();
window.open('https://wa.me/?text='+encodeURIComponent(s.msg),'_blank');
}
function shareTG(){
const s=shareText();
window.open('https://t.me/share/url?url='+encodeURIComponent(s.u)+'&text='+encodeURIComponent('Tap the link to get the files'),'_blank');
}
function resetSend(){
picked=[];sid=null;
render();
$('result').style.display='none';
$('pb').style.display='none';$('pbf').style.width='0';
$('pt').style.display='none';$('pt').textContent='';
$('sendBtn').textContent='Beam It';
drop.classList.remove('hidden');
}
$('codeIn').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'')});
$('codeIn').addEventListener('keydown',e=>{if(e.key==='Enter')doLookup()});
function doLookup(){
const code=$('codeIn').value.trim();
$('rerr').style.display='none';
if(code.length!==6){$('rerr').textContent='Enter the 6-character code';$('rerr').style.display='block';return}
fetch('/api/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})})
.then(r=>r.json()).then(r=>{
if(!r.ok){$('rerr').textContent=r.error;$('rerr').style.display='block';return}
RCODE=code;
const l=$('rlist');l.innerHTML='';
r.files.forEach((f,i)=>{
const d=document.createElement('div');d.className='frow';
const e=ext(f.name);
const ex=document.createElement('div');ex.className='ext';ex.style.background=extColor(e);ex.textContent=e.slice(0,4).toUpperCase();
const nm=document.createElement('div');nm.className='nm';nm.textContent=f.name;
const sz=document.createElement('div');sz.className='sz';sz.textContent=fmt(f.size);
const a=document.createElement('a');a.className='dl';a.href='/api/get/'+code+'/'+i;a.download=f.name.split('/').pop();a.textContent='Get';
const prev=document.createElement('button');prev.className='mini prev';prev.textContent='Preview';prev.onclick=(ev)=>{ev.preventDefault();previewFile(code,i,f.name)};
d.append(ex,nm,sz,a,prev);
l.appendChild(d)});
l.classList.remove('hidden');
$('dlAll').classList.remove('hidden');
}).catch(()=>$('rerr').textContent='Connection failed');
}
function dlAll(){if(RCODE)location.href='/api/zip/'+RCODE}
function dl(code,i,f,btn,ev){
if(f.size>314572800)return;
ev.preventDefault();
btn.textContent='0%';
const x=new XMLHttpRequest();
x.open('GET','/api/get/'+code+'/'+i,true);
x.responseType='blob';
x.onprogress=e=>{if(e.lengthComputable)btn.textContent=Math.round(e.loaded/e.total*100)+'%'};
x.onload=()=>{
if(x.status===200){
const a=document.createElement('a');a.href=URL.createObjectURL(x.response);a.download=f.name.split('/').pop();document.body.appendChild(a);a.click();a.remove();
setTimeout(()=>URL.revokeObjectURL(a.href),4000);
btn.textContent='Done';setTimeout(()=>btn.textContent='Get',1500)
}else{btn.textContent='Retry'}};
x.send();
}
function previewFile(code, idx, name){
const ext=name.split('.').pop().toLowerCase();
if(['jpg','jpeg','png','gif','bmp','webp','svg','pdf'].includes(ext)){
window.open('/api/preview/'+code+'/'+idx,'_blank')
}else{
alert('Preview not available for this file type')
}
}
function togglePhone(){
const b=$('phoneBox');
if(b.classList.contains('hidden')){
fetch('/api/info').then(r=>r.json()).then(info=>{
$('pqr').src='/api/qr?data='+encodeURIComponent(info.url);
$('purl').textContent=info.url;
b.classList.remove('hidden')
})
}else b.classList.add('hidden')
}
window.addEventListener('hashchange',()=>location.reload());
const pm=location.pathname.match(/^\/([A-Z0-9]{6})\/?$/);
const h=((new URLSearchParams(location.search).get('code'))||(pm&&pm[1])||location.hash.replace('#','')||'').toUpperCase();
if(/^[A-Z0-9]{6}$/.test(h)){$('codeIn').value=h;show('recv');setTimeout(doLookup,150)}
</script>
</body>
</html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, body):
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/favicon.ico":
            body = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>"
                    "<text y='.9em' font-size='90'>&#128230;</text></svg>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/":
            return self.send_html(PAGE)
        if path == "/api/info":
            return self.send_json({"url": DISPLAY_URL})
        if path == "/api/qr":
            qs = urllib.parse.parse_qs(parsed.query)
            data = qs.get("data", [""])[0]
            svg = qr_svg(data)
            if svg is None:
                return self.send_json({"error": "too long"}, 400)
            body = svg.encode()
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        m = re.match(r"^/([A-Z0-9]{6})$", path)
        if m:
            return self.send_html(PAGE)
        m = re.match(r"^/api/get/([A-Z0-9]{6})/(\d+)$", path)
        if m:
            return self.serve_file(m.group(1), int(m.group(2)))
        m = re.match(r"^/api/preview/([A-Z0-9]{6})/(\d+)$", path)
        if m:
            return self.serve_preview(m.group(1), int(m.group(2)))
        m = re.match(r"^/api/zip/([A-Z0-9]{6})$", path)
        if m:
            return self.serve_zip(m.group(1))
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/upload":
            return self.handle_upload()
        if path == "/api/finish":
            return self.handle_finish()
        if path == "/api/lookup":
            return self.handle_lookup()
        self.send_json({"error": "not found"}, 404)

    def handle_upload(self):
        name = clean_name(self.headers.get("X-File-Name", "file"))
        sid = self.headers.get("X-Beam-Sid") or secrets.token_hex(8)
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > MAX_TOTAL:
            return self.send_json({"error": "too large"}, 413)
        with LOCK:
            entry = TRANSFERS.get("sid:" + sid)
            if not entry:
                d = tempfile.mkdtemp(dir=BASE_DIR)
                entry = {"dir": d, "files": [], "created": time.time()}
                TRANSFERS["sid:" + sid] = entry
            safe = clean_name(name)
            n = 1
            base = safe
            while os.path.exists(os.path.join(entry["dir"], *safe.split("/"))):
                root, ext2 = os.path.splitext(base)
                safe = f"{root}({n}){ext2}"
                n += 1
            fp = os.path.join(entry["dir"], *safe.split("/"))
            os.makedirs(os.path.dirname(fp), exist_ok=True)
        remaining = length
        with open(fp, "wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(CHUNK, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        with LOCK:
            entry["files"].append(safe)
        self.send_json({"sid": sid, "file": safe, "size": length})

    def handle_finish(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        sid = body.get("sid", "")
        direct = bool(body.get("direct"))
        with LOCK:
            entry = TRANSFERS.pop("sid:" + sid, None)
            if not entry or not entry["files"]:
                return self.send_json({"error": "no files"}, 400)
            if direct:
                home = os.path.expanduser("~")
                desk = None
                for cand in [os.path.join(home, "OneDrive", "Desktop"), os.path.join(home, "Desktop")]:
                    if os.path.isdir(cand):
                        desk = cand
                        break
                inbox = os.path.join(desk or home, "FileBeam Inbox")
                os.makedirs(inbox, exist_ok=True)
                moved = 0
                for f in entry["files"]:
                    src = os.path.join(entry["dir"], *f.split("/"))
                    dest = os.path.join(inbox, *f.split("/"))
                    n = 1
                    base_dest = dest
                    while os.path.exists(dest):
                        root, ext2 = os.path.splitext(base_dest)
                        dest = f"{root}({n}){ext2}"
                        n += 1
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    shutil.move(src, dest)
                    moved += 1
                shutil.rmtree(entry["dir"], ignore_errors=True)
                print(f"  [inbox] received {moved} file(s) -> {inbox}")
                try:
                    if sys.platform == "win32":
                        subprocess.Popen(["explorer", inbox])
                    elif sys.platform == "darwin":
                        subprocess.Popen(["open", inbox])
                    else:
                        subprocess.Popen(["xdg-open", inbox])
                except Exception:
                    pass
                return self.send_json({"direct": True, "count": moved, "saved_to": inbox})
            code = new_code()
            while code in TRANSFERS:
                code = new_code()
            entry["created"] = time.time()
            TRANSFERS[code] = entry
        if TUNNEL_ON:
            for _ in range(16):
                if DISPLAY_URL != BASE_URL:
                    break
                time.sleep(0.5)
        self.send_json({"code": code, "count": len(entry["files"]), "url": DISPLAY_URL})

    def handle_lookup(self):
        time.sleep(0.25)
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        code = str(body.get("code", "")).upper().strip()
        with LOCK:
            entry = TRANSFERS.get(code)
            if not entry:
                return self.send_json({"ok": False, "error": "Code not found or expired"})
            files = [{"name": f, "size": os.path.getsize(os.path.join(entry["dir"], f))} for f in entry["files"]]
        self.send_json({"ok": True, "files": files})

    def serve_file(self, code, idx):
        with LOCK:
            entry = TRANSFERS.get(code)
            if not entry or idx < 0 or idx >= len(entry["files"]):
                return self.send_json({"error": "not found"}, 404)
            fname = entry["files"][idx]
            fp = os.path.join(entry["dir"], *fname.split("/"))
        size = os.path.getsize(fp)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(fname.split("/")[-1]))
        self.end_headers()
        with open(fp, "rb") as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def serve_zip(self, code):
        with LOCK:
            entry = TRANSFERS.get(code)
            if not entry:
                return self.send_json({"error": "not found"}, 404)
            tmp = tempfile.mktemp(suffix=".zip", dir=BASE_DIR)
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
                for f in entry["files"]:
                    z.write(os.path.join(entry["dir"], *f.split("/")), f)
        size = os.path.getsize(tmp)
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", "attachment; filename=filebeam-" + code + ".zip")
        self.end_headers()
        with open(tmp, "rb") as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)
        os.remove(tmp)

    def serve_preview(self, code, idx):
        with LOCK:
            entry = TRANSFERS.get(code)
            if not entry or idx < 0 or idx >= len(entry["files"]):
                return self.send_json({"error": "not found"}, 404)
            fname = entry["files"][idx]
            fp = os.path.join(entry["dir"], *fname.split("/"))
        size = os.path.getsize(fp)
        ext = fname.split(".")[-1].lower() if "." in fname else ""
        img_types = {"jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"}
        pdf_types = {"pdf"}
        if ext in img_types:
            ctype = "image/" + ("jpeg" if ext in ("jpg", "jpeg") else ext)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", "inline; filename*=UTF-8''" + urllib.parse.quote(fname))
            self.end_headers()
            with open(fp, "rb") as f:
                while True:
                    chunk = f.read(CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        elif ext in pdf_types:
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", "inline; filename*=UTF-8''" + urllib.parse.quote(fname))
            self.end_headers()
            with open(fp, "rb") as f:
                while True:
                    chunk = f.read(CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        else:
            self.send_json({"error": "not previewable"}, 400)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    global DISPLAY_URL
    global PORT
    global MAX_TOTAL
    global BASE_URL
    global TUNNEL_ON
    args = sys.argv[1:]
    lan_only = "--lan" in args
    tunnel = not lan_only
    if "--port" in args:
        i = args.index("--port")
        if i + 1 < len(args):
            try:
                PORT = int(args[i + 1])
            except ValueError:
                print("  Invalid --port value, using default", PORT)
    if "--max" in args:
        i = args.index("--max")
        if i + 1 < len(args):
            try:
                MAX_TOTAL = int(float(args[i + 1]) * 1024 * 1024 * 1024)
            except ValueError:
                print("  Invalid --max value, using default")
    threading.Thread(target=cleanup_loop, daemon=True).start()
    srv = Server((HOST, PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    ip = lan_ip()
    mdns = mDNS_name()
    base = f"http://{ip}:{PORT}" if PORT != 80 else f"http://{ip}"
    if mdns:
        mdns_base = f"http://{mdns}:{PORT}" if PORT != 80 else f"http://{mdns}"
    else:
        mdns_base = base
    DISPLAY_URL = mdns_base if mdns else base
    BASE_URL = base
    TUNNEL_ON = tunnel
    print("")
    print("  FileBeam is running")
    print(f"  Local:   http://localhost:{PORT}")
    if mdns:
        print(f"  LAN (mDNS): {mdns_base}")
        print(f"  LAN (IP):   {base}")
    else:
        print(f"  LAN:     {base}")
    proc = None
    if tunnel:
        print("  Starting cloudflared tunnel (share THIS link)...")
        try:
            logf = tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace")
            qcfg = os.path.join(tempfile.gettempdir(), "filebeam_quick_tunnel.yml")
            with open(qcfg, "w", encoding="utf-8") as fh:
                fh.write("ingress:\n  - service: http://localhost:%d\n" % PORT)
            proc = subprocess.Popen(
                ["cloudflared", "tunnel",
                 "--config", qcfg,
                 "--protocol", "http2",
                 "--edge-ip-version", "4",
                 "--url", f"http://localhost:{PORT}"],
                stdout=logf, stderr=subprocess.STDOUT,
            )

            def watch():
                global DISPLAY_URL
                start_url = DISPLAY_URL
                deadline = time.time() + 45
                while time.time() < deadline and DISPLAY_URL == start_url:
                    time.sleep(0.6)
                    try:
                        logf.seek(0)
                        txt = logf.read()
                    except Exception:
                        continue
                    mm = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", txt)
                    if mm:
                        DISPLAY_URL = mm.group(0)
                        print(f"  Public:  {DISPLAY_URL}")
                        print("  Share this link. Ctrl+C to stop.")
                        return
                if DISPLAY_URL == start_url:
                    print("  Tunnel did not report a URL yet - LAN link stays active.")

            threading.Thread(target=watch, daemon=True).start()
        except FileNotFoundError:
            print("  cloudflared not found - falling back to LAN-only links")
    print("")
    print("  Open the URL in a browser. First Windows run: allow firewall access.")
    print("  Codes expire in 60 minutes. Ctrl+C to stop.")
    print("")
    threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        if proc is not None:
            proc.terminate()

if __name__ == "__main__":
    main()
