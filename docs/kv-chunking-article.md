# Sending 150 MB Files on Cloudflare Workers — With a Database That Only Holds 25 MB

*How FileBeam chunks big uploads into Workers KV pieces, streams them back as one file, and zips multi-file beams — all on the free tier.*

**Live demo:** [https://filebeam.dpdns.org](https://filebeam.dpdns.org) · **Source:** [Kawshikmr/filebeam](https://github.com/Kawshikmr/filebeam)

---

## The constraint that shaped everything

Cloudflare Workers KV is a dream for free hosting: no servers, no database bill, reads are generous.
But it has a hard wall: **each value can store at most 25 MB.**

Meanwhile, people want to send *actual files* — recordings, PDFs, datasets. A 24 MB ceiling kills the product before it starts.

So FileBeam does what real databases have done forever: **split, store, reassemble.**

## The chunking design

An upload larger than 20 MB never touches KV as one blob. Instead:

1. **Init** — the browser tells the worker what's coming: name, type, size.
   The worker computes how many 20 MB parts the file needs and mints a 6-character code.
   A *manifest* lands in KV describing the whole beam.

```json
{
  "files": [{ "name": "video.mp4", "type": "video/mp4",
              "size": 73400320, "parts": 4 }],
  "done": false,
  "exp": 1756000000000
}
```

2. **Chunk upload** — the browser slices the file locally (`Blob.slice`) and PUTs each piece:

```
POST /api/beam/chunk?code=RW4AKP&file=0&n=0..3   →  c:RW4AKP:0:0 … :3
```

Keys are deterministic: `c:<code>:<fileIndex>:<partIndex>`. Out-of-range part numbers are rejected server-side, so a buggy client can't pollute the namespace.

3. **Seal** — `/api/beam/finish` flips `done: true`. From here the beam behaves exactly like a small one.

## Reassembly without loading anything into RAM twice

Downloads stream through a `ReadableStream` that pulls each part from KV **in order** and pipes it straight into the response:

```js
function streamParts(env, mkKey, parts) {
  return new ReadableStream({
    async pull(ctrl) {
      if (i >= parts) { ctrl.close(); return; }
      const buf = await env.BEAM.get(mkKey(i), { type: "arrayBuffer" });
      ctrl.enqueue(new Uint8Array(buf));
      i++;
    }
  });
}
```

No temp files, no double-buffering, and the receiver sees a normal byte-perfect download — verified with SHA-256 comparisons up to 30 MB during development.

## Multi-file beams and the ZIP trick

The manifest naturally grew into an array of files (up to 100, 150 MB total). Receivers get a clean file list — plus a **Download All (.zip)** button.

Building that zip inside a Worker — with no libraries allowed — meant writing a minimal **STORE-method ZIP writer**: local headers, CRC32 table, central directory, EOCD. ~40 lines total, streamed file-by-file so memory stays flat even near the size cap.

```js
const CRC_T = (() => { /* standard CRC-32 table */ })();
async function* zipParts(files) {
  for (const f of files) {
    const data = await load(f);
    yield localHeader(f, crc32(data));
    yield data;
  }
  yield centralDirectory(); yield eocd();
}
```

Windows Explorer, macOS Archive Utility and Linux `unzip` all accept it — tested against real extraction, not just byte equality.

## Why 150 MB is the honest free-tier ceiling

| Resource | Free allowance | Cost per 150 MB beam |
|---|---|---|
| KV writes | 1,000/day | ~9 (manifest + 8 parts) |
| KV storage pool | 1 GB | cleared by TTL in ~60 min |
| Reads | 100,000/day | 8 per download |

~110 full-size beams/day fits comfortably. TTLs do the garbage collection — expired beams simply evaporate, which doubles as the privacy feature.

## What the single file buys you

Everything above lives in one `worker.js` (~660 lines, zero dependencies). The companion `filebeam.py` brings the same UI to your own machine with a 10 GB cap and a Cloudflare Tunnel public link — also dependency-free.

Try it: [https://filebeam.dpdns.org](https://filebeam.dpdns.org) · star/fork: [github.com/Kawshikmr/filebeam](https://github.com/Kawshikmr/filebeam)

---

*Built as a free-only experiment: every lane above runs on Cloudflare's free tier. If you ship something with this pattern, tell me!*
