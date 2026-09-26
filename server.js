// Shopping List Organizer - paste a messy list, and an AI on YOUR machine (QVAC) sorts every item into a store aisle.
// Open http://localhost:3058 after starting.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The QVAC worker can be slow to start on some computers. Wait up to 3 minutes for it.
process.env.QVAC_RPC_INIT_TIMEOUT_MS ??= "180000";
const { loadModel, completion, LLAMA_3_2_1B_INST_Q4_0 } = await import("@qvac/sdk");

const PORT = 3058;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Step 1: load the AI model (downloads the first time, then it's cached) ----
let modelId = null;
const status = { ready: false, message: "Starting...", percent: null, error: null };
async function startModel() {
  try {
    status.message = "Loading the AI model (first run downloads it)...";
    modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: "llm",
      onProgress: (p) => { const v = typeof p === "number" ? p : p?.percentage; if (typeof v === "number") status.percent = Math.round(v); },
    });
    status.ready = true; status.message = "AI list sorter ready";
    console.log("Model loaded. Open http://localhost:" + PORT);
  } catch (err) { status.error = String(err?.message || err); console.error("Could not load model:", err); }
}

// One AI job at a time
let chain = Promise.resolve();
const enqueue = (job) => { const p = chain.then(job); chain = p.catch(() => {}); return p; };

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > limit) { reject(new Error("Too big")); req.destroy(); } });
    req.on("end", () => resolve(data)); req.on("error", reject);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const clean = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);

const AISLES = ["Produce", "Bakery", "Meat & fish", "Dairy & eggs", "Frozen", "Pantry", "Snacks & sweets", "Drinks", "Household", "Personal care", "Baby & pets", "Other"];
// QVAC "structured output": every item must come back with one of the aisles above.
const SCHEMA = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { item: { type: "string" }, aisle: { type: "string", enum: AISLES } }, required: ["item", "aisle"], additionalProperties: false } } }, required: ["items"], additionalProperties: false };
const SYSTEM_PROMPT = `You sort shopping list items into supermarket aisles. Reply with JSON only.
For EVERY item in the list, return the item (keep the user's words and quantities, fix obvious spelling) and its aisle.
Allowed aisles: ${AISLES.join(", ")}. Do not add or remove items.`;

async function sortList(items) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // This is the QVAC call that runs the AI on-device
      const run = completion({ modelId, stream: true, history: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "List:\n" + items.map((i) => "- " + i).join("\n") }],
        responseFormat: { type: "json_schema", json_schema: { name: "Aisles", schema: SCHEMA } } });
      let out = "";
      for await (const event of run.events) if (event.type === "contentDelta") out += event.text;
      const got = (JSON.parse(out).items || []).map((x) => ({ item: clean(x.item, 80), aisle: AISLES.includes(x.aisle) ? x.aisle : "Other" })).filter((x) => x.item);
      if (!got.length) continue;
      // Safety net: anything the AI dropped is put back under "Other", so no item is ever lost
      const seen = got.map((g) => g.item.toLowerCase());
      // (compares word beginnings, so a spelling fix like "tomatos" -> "tomatoes" still counts as the same item)
      items.forEach((i) => { const w = i.toLowerCase().replace(/^[\d\s.,x]+/, "").split(/\s+/)[0].slice(0, 5); if (w && !seen.some((s) => s.includes(w))) got.push({ item: i, aisle: "Other" }); });
      return got.slice(0, 120);
    } catch (err) { console.error("Sort attempt failed:", err.message); }
  }
  return null;
}

// ---- Step 2: the web server ----
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(path.join(__dirname, "public", "index.html")));
    }
    if (req.method === "GET" && req.url === "/api/status") return json(res, 200, status);
    if (req.method === "POST" && req.url === "/api/sort") {
      if (!status.ready) return json(res, 503, { error: "The AI list sorter is not ready yet." });
      const items = (JSON.parse(await readBody(req, 20000)).items || []).map((i) => clean(i, 80)).filter(Boolean).slice(0, 80);
      if (!items.length) return json(res, 400, { error: "Add some items first." });
      const r = await enqueue(() => sortList(items));
      return r ? json(res, 200, r) : json(res, 502, { error: "The AI couldn't sort this list. Try again." });
    }
    res.writeHead(404); res.end("Not found");
  } catch (err) { console.error(err); json(res, 500, { error: String(err?.message || err) }); }
});

// "127.0.0.1" means only YOUR computer can reach this app
server.listen(PORT, "127.0.0.1", () => console.log("Server running at http://localhost:" + PORT));
startModel();
