# 📦 FileBeam Lite — the hosted edition

The exact same FileBeam face, running as **one Cloudflare Worker + Workers KV**.
No accounts · no database · no server · files self-destruct in 60 minutes.

| | Lite (this folder) | Full (`filebeam.py`) |
|---|---|---|
| Max beam size | **150 MB** (auto-chunked) | **10 GB** |
| Runs on | Cloudflare's edge — free tier | any PC with Python |
| Receiver needs | just a link or 6-char code | just a browser on your WiFi/tunnel |
| Cost | ₹0 forever | ₹0 forever |

**Free-tier headroom:** ~140 big beams/day, 1 GB live storage churning hourly.

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
