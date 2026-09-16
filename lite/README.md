# 📦 FileBeam Lite — the hosted edition

The exact same FileBeam face, running as **one Cloudflare Worker + Workers KV**.
No accounts · no database · no card · files self-destruct in 60 minutes.

### Features
- 🔒 **Zero-Knowledge E2EE**: Client-side AES-GCM-256 encryption.
- 🔑 **Password-protected beams**: Optional per-beam password (salted PBKDF2-SHA256 gate).
- 🎟️ **Download-count limits**: Stop a link working after N downloads (0 = unlimited).
- 🔥 **Burn now**: Sender can instantly delete a beam before it expires.
- ⚡ **Direct WebRTC P2P**: Live device-to-device streaming when both devices are active.
- 📦 **Memory-Safe Streaming ZIP**: Chunk-by-chunk low-RAM zip generation.
- 📲 **PWA & Web Share Target**: Installable app with native OS Share integration.
- 🛡️ **Abuse protection**: per-IP + global rate limits on uploads/downloads.
- 📄 **Privacy & Terms pages**: honest zero-claims, linked in the footer.

| | Lite (this folder) | Full (`filebeam.py`) |
|---|---|---|
| Max beam size | **500 MB** (auto-chunked, parallel upload) | **10 GB** |
| Runs on | Cloudflare's edge — free tier | any PC with Python |
| Receiver needs | just a link or 6-char code | just a browser on your WiFi/tunnel |
| Encryption | AES-GCM-256 (Zero-Knowledge) | Local / Tunnel TLS |
| Cost | ₹0 forever | ₹0 forever |

**Free-tier headroom:** ~40 big beams/day, 1 GB live storage churning hourly.
Parallel chunk upload (4 streams) plus Download All (per-file or `.zip`) and a per-file "downloaded" tick that survives page reloads (localStorage).

## Deploy your own lane in 2 minutes

```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create BEAM      # copy the printed id
```

Create `wrangler.toml` next to `filebeam-worker.js`:

```toml
name = "filebeam"
main = "filebeam-worker.js"
compatibility_date = "2026-08-01"

[[kv_namespaces]]
binding = "BEAM"
id = "PASTE_YOUR_NAMESPACE_ID_HERE"
```

```bash
wrangler deploy
```

Done — your own `https://filebeam.<your-subdomain>.workers.dev`, free forever.
