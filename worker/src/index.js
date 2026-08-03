const UPSTREAM_ORIGIN = "https://aihaotan.com";
const UPSTREAM_PAGE_SIZE = 96;
const MAX_FILTER_SCAN_PAGES = 8;
const ALLOWED_PATHS = new Set([
  "/api/goods",
  "/api/search",
  "/api/search/hot",
  "/api/shops",
  "/api/about",
  "/api/changes",
  "/api/reports",
  "/api/shop-comments",
  "/api/shop-submissions"
]);

function corsHeaders(request) {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function jsonResponse(body, status, request) {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", status >= 200 && status < 300 ? "public, max-age=1, s-maxage=1" : "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function integerParam(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number.parseInt(value || "", 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, 0), maximum);
}

function priceBound(value) {
  if (value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readPriceRange(url) {
  const min = priceBound(url.searchParams.get("minPrice"));
  const max = priceBound(url.searchParams.get("maxPrice"));
  return { min, max, active: min !== null || max !== null, valid: min === null || max === null || min <= max };
}

function productMatches(row, range) {
  const stock = Number(row?.stock || 0);
  const price = Number(row?.price);
  return stock > 0 && Number.isFinite(price) &&
    (range.min === null || price >= range.min) &&
    (range.max === null || price <= range.max);
}

function sortProducts(rows, sortBy) {
  return rows.sort((left, right) => {
    if (sortBy === "stock") {
      return Number(right.stock || 0) - Number(left.stock || 0) || Number(left.price || 0) - Number(right.price || 0);
    }
    return Number(left.price || 0) - Number(right.price || 0) || Number(right.stock || 0) - Number(left.stock || 0);
  });
}

async function fetchUpstreamJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 1, cacheEverything: true }
  });
  if (!response.ok) throw new Error(`${url.pathname} returned ${response.status}`);
  return response.json();
}

async function fetchFilteredGoods(url, range) {
  if (!range.valid) return [];

  const sortBy = url.searchParams.get("sortBy") === "stock" ? "stock" : "price_asc";
  const keyword = url.searchParams.get("keyword") || "";
  const limit = integerParam(url.searchParams.get("limit"), 24, 96);
  const offset = integerParam(url.searchParams.get("offset"), 0);
  const targetCount = offset + limit;
  const matches = [];

  for (let page = 0; page < MAX_FILTER_SCAN_PAGES; page += 1) {
    const upstreamUrl = new URL("/api/goods", UPSTREAM_ORIGIN);
    upstreamUrl.searchParams.set("keyword", keyword);
    upstreamUrl.searchParams.set("sortBy", sortBy);
    upstreamUrl.searchParams.set("offset", String(page * UPSTREAM_PAGE_SIZE));
    upstreamUrl.searchParams.set("limit", String(UPSTREAM_PAGE_SIZE));
    const rows = await fetchUpstreamJson(upstreamUrl);
    if (!Array.isArray(rows)) throw new Error("/api/goods returned a non-array response");

    matches.push(...rows.filter((row) => productMatches(row, range)));
    const lastPrice = Number(rows[rows.length - 1]?.price);
    const reachedPriceEnd = sortBy === "price_asc" && range.max !== null && Number.isFinite(lastPrice) && lastPrice > range.max;
    const enoughForPage = sortBy === "price_asc" && matches.length >= targetCount;
    if (rows.length < UPSTREAM_PAGE_SIZE || reachedPriceEnd || enoughForPage) break;
  }

  return sortProducts(matches, sortBy).slice(offset, offset + limit);
}

async function readRequestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return null;
  return request.arrayBuffer();
}

function upstreamInit(request, body) {
  const headers = new Headers();
  headers.set("Accept", request.headers.get("Accept") || "application/json");
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  const init = { method: request.method, headers, cf: { cacheTtl: request.method === "GET" ? 1 : 0, cacheEverything: request.method === "GET" } };
  if (body !== null && request.method !== "GET" && request.method !== "HEAD") init.body = body;
  return init;
}

async function handleRequest(request, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, upstream: UPSTREAM_ORIGIN }, 200, request);
  }
  if (!ALLOWED_PATHS.has(url.pathname)) {
    return jsonResponse({ error: "Not found" }, 404, request);
  }

  const range = readPriceRange(url);
  const body = await readRequestBody(request);

  if (request.method === "GET" && url.pathname === "/api/goods" && range.active) {
    return jsonResponse(await fetchFilteredGoods(url, range), 200, request);
  }

  const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM_ORIGIN);
  const response = await fetch(upstreamUrl, upstreamInit(request, body));
  const responseHeaders = corsHeaders(request);
  responseHeaders.set("Content-Type", response.headers.get("Content-Type") || "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", request.method === "GET" ? "public, max-age=1, s-maxage=1" : "no-store");
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export default {
  async fetch(request, env, ctx) {
    const cacheKey = request.method === "GET" ? new Request(request.url, { method: "GET" }) : null;
    if (cacheKey) {
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
    }

    try {
      const response = await handleRequest(request, ctx);
      if (cacheKey && response.ok) ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return jsonResponse({ error: String(error?.message || error) }, 502, request);
    }
  }
};
