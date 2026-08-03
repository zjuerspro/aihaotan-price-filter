import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const apiBase = (process.env.AIHAOTAN_API_BASE || "https://aihaotan.com").replace(/\/+$/, "");
const outputPath = path.resolve(process.cwd(), "goods-data.js");
const pageSize = 96;
const defaultKeywords = [
  "gpt free",
  "gpt",
  "chatgpt",
  "claude",
  "gemini",
  "grok",
  "team",
  "plus",
  "midjourney"
];

async function fetchJson(endpoint) {
  const response = await fetch(`${apiBase}${endpoint}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`${endpoint} returned ${response.status}`);
  }
  return response.json();
}

async function mapWithConcurrency(items, worker, concurrency = 4) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function parseExistingData(source) {
  try {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    return start >= 0 && end > start ? JSON.parse(source.slice(start, end + 1)) : null;
  } catch {
    return null;
  }
}

function comparableData(data) {
  return JSON.stringify({
    keywords: data.keywords || [],
    products: data.products || []
  });
}

const hotRows = await fetchJson("/api/search/hot?limit=8");
const hotKeywords = Array.isArray(hotRows)
  ? hotRows.map((row) => String(row.keyword || "").trim()).filter(Boolean)
  : [];
const keywords = [...new Set([...defaultKeywords, ...hotKeywords])].slice(0, 16);

const pages = await mapWithConcurrency(keywords, async (keyword) => {
  const params = new URLSearchParams({
    limit: String(pageSize),
    sortBy: "price_asc",
    offset: "0",
    keyword
  });
  const rows = await fetchJson(`/api/goods?${params}`);
  return Array.isArray(rows) ? rows : [];
});

const productsByGuid = new Map();
for (const page of pages) {
  for (const product of page) {
    const id = String(product?.guid || product?.linkUrl || product?.key || "").trim();
    if (id) productsByGuid.set(id, product);
  }
}

const products = [...productsByGuid.values()].sort((left, right) =>
  String(left.guid || left.key || "").localeCompare(String(right.guid || right.key || ""))
);
if (products.length < 50) {
  throw new Error(`Only ${products.length} products were returned; refusing to replace the current dataset.`);
}

let existing = null;
try {
  existing = parseExistingData(await readFile(outputPath, "utf8"));
} catch {
  existing = null;
}

const nextComparable = comparableData({ keywords, products });
if (existing && comparableData(existing) === nextComparable) {
  console.log(`No changes. Checked ${products.length} products from ${keywords.length} keywords.`);
  process.exit(0);
}

const nextData = {
  generatedAt: new Date().toISOString(),
  keywords,
  products
};
await writeFile(outputPath, `window.FAKA_LOCAL_DATA = ${JSON.stringify(nextData)};\n`, "utf8");
console.log(`Updated ${products.length} products from ${keywords.length} keywords.`);
