import fs from "node:fs";
const src = fs.readFileSync("filebeam-worker.js", "utf8");
const dataUri = "data:text/javascript;base64," + Buffer.from(src).toString("base64");
import(dataUri).then(async (m) => {
  const worker = m.default;
  const store = new Map();
  const env = {
    BEAM: {
      get: async (k, o) => store.has(k) ? (o && o.type === "arrayBuffer" ? Buffer.from(store.get(k)) : store.get(k)) : null,
      put: async (k, v) => { store.set(k, typeof v === "string" ? v : Buffer.from(v)); },
      delete: async (k) => { store.delete(k); },
    },
  };
  const ctx = { waitUntil: () => {} };

  const home = await worker.fetch(new Request("https://filebeam.dpdns.org/"), env, ctx);
  const homeHtml = await home.text();
  console.log("HOME: status", home.status, "| max 500:", homeHtml.includes("up to 500 MB"), "| CHUNK:", homeHtml.includes("const CHUNK=25165824"), "| UPCONC:", homeHtml.includes("const UP_CONC=4"), "| dlrow:", homeHtml.includes("dlrow"), "| dlAllEach:", homeHtml.includes("dlAllEach"));

  // PWA manifest + sw (from remote base)
  const man = await worker.fetch(new Request("https://filebeam.dpdns.org/manifest.webmanifest"), env, ctx);
  const manJ = await man.json();
  console.log("MANIFEST:", man.status, "| share_target:", !!manJ.share_target);

  // E2EE init (enc true)
  const eInit = await (await worker.fetch(new Request("https://filebeam.dpdns.org/api/beam/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enc: true, files: [{ name: "sec.txt", type: "text/plain", size: 30 }] }) }), env, ctx)).json();
  console.log("E2EE INIT:", eInit.ok, eInit.code);
  const eso = new Uint8Array(30); eso.fill(90);
  await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/chunk?code=${eInit.code}&file=0&n=0`, { method: "POST", body: eso }), env, ctx);
  const eFin = await (await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/finish?code=${eInit.code}`, { method: "POST" }), env, ctx)).json();
  console.log("E2EE FINISH:", eFin.ok);
  const em = await (await worker.fetch(new Request(`https://filebeam.dpdns.org/api/meta/${eInit.code}`), env, ctx)).json();
  console.log("E2EE manifest enc flag:", em.enc === true);

  // WebRTC signaling routes alive
  const sig = await worker.fetch(new Request("https://filebeam.dpdns.org/api/signal/offer?code=ABC123"), env, ctx);
  console.log("SIGNAL offer GET:", sig.status, (await sig.text()).slice(0, 30));

  // Multi-file beam (parallel path shape)
  const initBody = JSON.stringify({ enc: false, files: [{ name: "a.bin", type: "application/octet-stream", size: 30 * 1024 * 1024 }, { name: "b.txt", type: "text/plain", size: 1000 }] });
  const init = await (await worker.fetch(new Request("https://filebeam.dpdns.org/api/beam/init", { method: "POST", headers: { "content-type": "application/json" }, body: initBody }), env, ctx)).json();
  const code = init.code;
  const chunkA1 = new Uint8Array(24 * 1024 * 1024).fill(65);
  const chunkA2 = new Uint8Array((30 * 1024 * 1024) - (24 * 1024 * 1024)).fill(66);
  const chunkB = new Uint8Array(1000).fill(67);
  const ups = await Promise.all([
    worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/chunk?code=${code}&file=0&n=0`, { method: "POST", body: chunkA1 }), env, ctx),
    worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/chunk?code=${code}&file=0&n=1`, { method: "POST", body: chunkA2 }), env, ctx),
    worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/chunk?code=${code}&file=1&n=0`, { method: "POST", body: chunkB }), env, ctx),
  ]);
  console.log("PARALLEL CHUNKS:", ups.map(r => r.status).join(","));
  await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/finish?code=${code}`, { method: "POST" }), env, ctx);

  // receive page: dlOne/dlAll + mark-downloaded script
  const recv = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${code}`), env, ctx);
  const recvHtml = await recv.text();
  console.log("RECEIVE: dlAll:", recvHtml.includes("dlAll"), "| dlOne:", recvHtml.includes("dlOne"), "| fb_done:", recvHtml.includes("fb_done_"), "| data-i:", recvHtml.includes("data-i"), "| zip:", recvHtml.includes("/zip"));

  // zip works
  const zip = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${code}/zip`), env, ctx);
  const zipBuf = Buffer.from(await zip.arrayBuffer());
  console.log("ZIP:", zip.status, "bytes:", zipBuf.length, "| pk:", zipBuf[0] === 0x50 && zipBuf[1] === 0x4b);

  // raw reassembly 30MB
  const raw = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${code}/f/0/raw`), env, ctx);
  const rawBuf = Buffer.from(await raw.arrayBuffer());
  console.log("RAW reassemble:", raw.status, rawBuf.length, "match:", rawBuf.length === 30 * 1024 * 1024);

  // dropafter limit: >500MB rejected
  const tooBig = await worker.fetch(new Request("https://filebeam.dpdns.org/api/beam/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enc: false, files: [{ name: "x.bin", type: "application/octet-stream", size: 501 * 1024 * 1024 }] }) }), env, ctx);
  console.log("500MB GUARD:", tooBig.status);

  // ===== NEW: password-protected beam =====
  const pw = "s3cret-test";
  const pInit = await (await worker.fetch(new Request("https://filebeam.dpdns.org/api/beam/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enc: true, pw: pw, files: [{ name: "pw.txt", type: "text/plain", size: 10 }] }) }), env, ctx)).json();
  console.log("PW INIT:", pInit.ok, pInit.pw === true, pInit.code);
  await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/chunk?code=${pInit.code}&file=0&n=0`, { method: "POST", body: new Uint8Array(10).fill(88) }), env, ctx);
  await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/finish?code=${pInit.code}`, { method: "POST" }), env, ctx);
  // meta without pw -> 401
  const pMetaNo = await worker.fetch(new Request(`https://filebeam.dpdns.org/api/meta/${pInit.code}`), env, ctx);
  const pMetaNoJ = await pMetaNo.json();
  console.log("PW META no-pw:", pMetaNo.status, pMetaNoJ.err);
  // meta with pw -> 200 ok
  const pMetaYes = await worker.fetch(new Request(`https://filebeam.dpdns.org/api/meta/${pInit.code}`, { headers: { "x-filebeam-pw": encodeURIComponent(pw) } }), env, ctx);
  console.log("PW META with-pw:", pMetaYes.status);
  // raw without pw -> 401 lock page
  const pRawNo = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${pInit.code}/raw`), env, ctx);
  console.log("PW RAW no-pw:", pRawNo.status, "| lock page has unlockpw:", (await pRawNo.text()).includes("unlockpw"));
  // raw with pw -> 200, payload intact
  const pRawYes = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${pInit.code}/raw`, { headers: { "x-filebeam-pw": encodeURIComponent(pw) } }), env, ctx);
  const pRawBuf = Buffer.from(await pRawYes.arrayBuffer());
  console.log("PW RAW with-pw:", pRawYes.status, pRawBuf.length, "| matches:", pRawBuf.length === 10 && pRawBuf[0] === 88);
  // wrong password -> 401
  const pRawBad = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${pInit.code}/raw`, { headers: { "x-filebeam-pw": "nope" } }), env, ctx);
  console.log("PW RAW wrong-pw:", pRawBad.status);

  // ===== NEW: download-count limit =====
  const dInit = await (await worker.fetch(new Request("https://filebeam.dpdns.org/api/beam/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enc: false, maxdl: 1, files: [{ name: "dl.txt", type: "text/plain", size: 5 }] }) }), env, ctx)).json();
  console.log("DL INIT:", dInit.ok, dInit.code);
  await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/chunk?code=${dInit.code}&file=0&n=0`, { method: "POST", body: new Uint8Array(5).fill(77) }), env, ctx);
  await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/finish?code=${dInit.code}`, { method: "POST" }), env, ctx);
  const dl1 = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${dInit.code}/f/0/raw`), env, ctx);
  console.log("DL #1 (allowed):", dl1.status, (await dl1.arrayBuffer()).byteLength);
  const dl2 = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${dInit.code}/f/0/raw`), env, ctx);
  console.log("DL #2 (blocked):", dl2.status, "| limit page:", (await dl2.text()).includes("download limit"));
  const dMeta = await (await worker.fetch(new Request(`https://filebeam.dpdns.org/api/meta/${dInit.code}`), env, ctx)).json();
  console.log("DL meta used/limit:", dMeta.dlUsed, dMeta.dl);

  // ===== NEW: burn / cancel =====
  const bInit = await (await worker.fetch(new Request("https://filebeam.dpdns.org/api/beam/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enc: false, files: [{ name: "burn.txt", type: "text/plain", size: 4 }] }) }), env, ctx)).json();
  console.log("BURN INIT:", bInit.ok, bInit.code);
  await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/chunk?code=${bInit.code}&file=0&n=0`, { method: "POST", body: new Uint8Array(4) }), env, ctx);
  await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/finish?code=${bInit.code}`, { method: "POST" }), env, ctx);
  const b1 = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${bInit.code}`), env, ctx);
  console.log("BURN pre (exists):", b1.status);
  const burn = await worker.fetch(new Request(`https://filebeam.dpdns.org/api/beam/burn/${bInit.code}`, { method: "POST" }), env, ctx);
  const burnJ = await burn.json();
  console.log("BURN POST:", burn.status, burnJ.ok);
  const b2 = await worker.fetch(new Request(`https://filebeam.dpdns.org/d/${bInit.code}`), env, ctx);
  console.log("BURN post (gone):", b2.status);

  // ===== NEW: privacy + terms pages =====
  const priv = await worker.fetch(new Request("https://filebeam.dpdns.org/privacy"), env, ctx);
  const privT = await priv.text();
  console.log("PRIVACY:", priv.status, "| mentions AES-GCM:", privT.includes("AES-GCM-256"), "| footer links:", privT.includes("/terms"));
  const terms = await worker.fetch(new Request("https://filebeam.dpdns.org/terms"), env, ctx);
  const termsT = await terms.text();
  console.log("TERMS:", terms.status, "| has 10GB referral:", termsT.includes("10 GB"), "| has 500 MB:", termsT.includes("500 MB"));

  // ===== NEW: rate limit (hit init caps is fine, just verify pages still serve) =====
  const rl = await worker.fetch(new Request("https://filebeam.dpdns.org/api/beam/init", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ enc: false, files: [{ name: "rl.txt", type: "text/plain", size: 3 }] }) }), env, ctx);
  console.log("RL normal init:", rl.status);

  console.log("\nALL CHECKS DONE");
}).catch(e => { console.error("FATAL", e); process.exit(1); });