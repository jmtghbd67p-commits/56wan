const CORE_SOURCE_URL =
  "https://raw.githubusercontent.com/jmtghbd67p-commits/56wan/94e0a945245fbdc87caf1c0152cc81f6c8dc0940/api/app.js";
const FESTIVAL_API = "https://apis.data.go.kr/B551011/KorService2/searchFestival2";
const KAKAO = process.env.KAKAO_REST_KEY;
const FESTIVAL_KEY = process.env.CULTURE_DATA_SERVICE_KEY;
const SIGUNGU_GRAPH = require("./sigungu-graph");

let coreHandlerPromise;

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean).map(v => String(v).trim()))];
}

function serviceKeyVariants() {
  let raw = String(FESTIVAL_KEY || "").trim()
    .replace(/^serviceKey\s*=\s*/i, "")
    .replace(/^['"]|['"]$/g, "");
  if (!raw) return [];
  const values = [raw];
  let current = raw;
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      values.push(next);
      current = next;
    } catch { break; }
  }
  return uniqueStrings(values);
}

async function loadCoreHandler() {
  if (!coreHandlerPromise) {
    coreHandlerPromise = (async () => {
      const response = await fetch(CORE_SOURCE_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error(`정상 백엔드 원본 로드 실패 ${response.status}`);
      const source = await response.text();
      const mod = { exports: {} };
      const runner = new Function(
        "module","exports","require","process","fetch","URL","URLSearchParams",
        "AbortController","Buffer","console","setTimeout","clearTimeout",
        source
      );
      const localRequire = id => id === "./sigungu-graph" ? SIGUNGU_GRAPH : require(id);
      runner(
        mod, mod.exports, localRequire, process, fetch, URL, URLSearchParams,
        AbortController, Buffer, console, setTimeout, clearTimeout
      );
      if (typeof mod.exports !== "function") throw new Error("정상 백엔드 핸들러를 읽지 못했습니다.");
      return mod.exports;
    })().catch(error => {
      coreHandlerPromise = null;
      throw error;
    });
  }
  return coreHandlerPromise;
}

function queryInfo(req) {
  const url = new URL(req.url, "http://local");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const get = key => body[key] ?? req.query?.[key] ?? url.searchParams.get(key) ?? "";
  const themes = String(get("themes") || get("theme") || "")
    .split(",").map(v => v.trim()).filter(Boolean);
  return {
    mode: String(req.query?.mode ?? url.searchParams.get("mode") ?? ""),
    themes,
    visitDate: String(get("visitDate") || ""),
    x: Number(get("x")),
    y: Number(get("y")),
    maxMinutes: Math.max(10, Math.min(120, Number(get("maxMinutes")) || 40))
  };
}

function digits8(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

function rowsFrom(data) {
  const x =
    data?.response?.body?.items?.item ??
    data?.response?.body?.items ??
    data?.items?.item ??
    data?.items ??
    [];
  return Array.isArray(x) ? x : (x && typeof x === "object" ? [x] : []);
}

function recordValue(record, names) {
  for (const name of names) {
    const key = Object.keys(record || {}).find(k => k.toLowerCase() === name.toLowerCase());
    if (key != null && record[key] != null) return String(record[key]).trim();
  }
  return "";
}

function activeOn(record, target) {
  const start = digits8(recordValue(record, ["eventstartdate","fstvlStartDate","eventStartDate","startDate"]));
  const end = digits8(recordValue(record, ["eventenddate","fstvlEndDate","eventEndDate","endDate"])) || start;
  if (!target || !start) return true;
  return start <= target && target <= end;
}

async function geocode(address) {
  if (!KAKAO || !address) return null;
  const response = await fetch(
    `https://dapi.kakao.com/v2/local/search/address.json?${new URLSearchParams({query:address,size:"1"})}`,
    { headers: { Authorization: `KakaoAK ${KAKAO}` } }
  );
  const data = await response.json().catch(() => ({}));
  const item = data?.documents?.[0];
  if (!item) return null;
  return { x: Number(item.x), y: Number(item.y) };
}

async function route(origin, target) {
  if (!KAKAO || !origin || !target) return null;
  const params = new URLSearchParams({
    origin: `${origin.x},${origin.y}`,
    destination: `${target.x},${target.y}`,
    priority: "TIME",
    alternatives: "false",
    road_details: "false"
  });
  const response = await fetch(
    `https://apis-navi.kakaomobility.com/v1/directions?${params}`,
    { headers: { Authorization: `KakaoAK ${KAKAO}` } }
  );
  const data = await response.json().catch(() => ({}));
  const summary = data?.routes?.[0]?.summary;
  if (!summary || !Number.isFinite(Number(summary.duration))) return null;
  return {
    minutes: Math.max(1, Math.round(Number(summary.duration) / 60)),
    distance: Number(summary.distance) || 0
  };
}

async function fetchFestivalRows(visitDate) {
  if (!FESTIVAL_KEY) return [];
  const target = digits8(visitDate) || new Date().toISOString().slice(0,10).replace(/-/g,"");
  let last = "";
  for (const serviceKey of serviceKeyVariants()) {
    const params = new URLSearchParams({
      serviceKey,
      MobileOS: "ETC",
      MobileApp: "56wan",
      _type: "json",
      numOfRows: "500",
      pageNo: "1",
      arrange: "A",
      eventStartDate: target
    });
    const response = await fetch(`${FESTIVAL_API}?${params}`, { cache: "no-store" });
    const text = await response.text();
    last = text.slice(0, 240);
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const rows = data ? rowsFrom(data) : [];
    if (response.ok && data?.response?.header?.resultCode === "0000") {
      console.log("[tourapi festival]", JSON.stringify({
        status: response.status,
        total: Number(data?.response?.body?.totalCount || rows.length),
        returned: rows.length,
        date: target
      }));
      return rows;
    }
  }
  console.warn("[tourapi festival empty]", last);
  return [];
}
async function festivalItems(origin, maxMinutes, visitDate) {
  const targetDate = digits8(visitDate);
  const rows = (await fetchFestivalRows(targetDate)).filter(row => activeOn(row, targetDate));
  const results = [];
  for (const row of rows) {
    const name = recordValue(row, ["title","fstvlNm","festivalNm","eventNm","name"]);
    if (!name) continue;
    const address = [recordValue(row, ["addr1","rdnmadr","roadNmAddr","lnmadr","address"]), recordValue(row, ["addr2"])].filter(Boolean).join(" ");
    let x = Number(recordValue(row, ["mapx","longitude","lon","x"]));
    let y = Number(recordValue(row, ["mapy","latitude","lat","y"]));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const point = await geocode(address);
      if (!point) continue;
      x = point.x; y = point.y;
    }
    const routed = await route(origin, {x,y});
    if (!routed || routed.minutes > maxMinutes) continue;
    const start = recordValue(row, ["eventstartdate","fstvlStartDate","eventStartDate","startDate"]);
    const end = recordValue(row, ["eventenddate","fstvlEndDate","eventEndDate","endDate"]);
    results.push({
      id: `festival:${name}:${digits8(start)}`,
      name,
      display_name: name,
      category: "지역축제",
      address,
      road_address: address,
      phone: recordValue(row, ["tel","phoneNumber","phone"]),
      place_url: "",
      x, y,
      route_minutes: routed.minutes,
      route_distance: routed.distance,
      route_estimated: false,
      family_evidence: 999,
      festival: true,
      festival_period: [start,end].filter(Boolean).join(" ~ "),
      festival_start: start,
      festival_end: end,
      season_kind: "festival",
      matched_themes: ["season"]
    });
  }
  results.sort((a,b) => a.route_minutes - b.route_minutes);
  console.log("[festival result]", JSON.stringify({
    date: targetDate, count: results.length, names: results.slice(0,10).map(x=>x.name)
  }));
  return results.slice(0, 10);
}

function captureResponse() {
  const headers = new Map();
  let statusCode = 200;
  let body = "";
  return {
    set statusCode(v) { statusCode = v; },
    get statusCode() { return statusCode; },
    setHeader(k,v) { headers.set(String(k).toLowerCase(), String(v)); },
    getHeader(k) { return headers.get(String(k).toLowerCase()); },
    end(v="") { body += v == null ? "" : String(v); },
    write(v="") { body += v == null ? "" : String(v); },
    snapshot() { return { statusCode, headers, body }; }
  };
}

module.exports = async function handler(req, res) {
  try {
    const core = await loadCoreHandler();
    const info = queryInfo(req);

    if (info.mode !== "theme" || !info.themes.includes("season")) {
      return core(req, res);
    }

    const captured = captureResponse();
    await core(req, captured);
    const snap = captured.snapshot();

    let data;
    try { data = JSON.parse(snap.body || "{}"); }
    catch {
      res.statusCode = snap.statusCode;
      for (const [k,v] of snap.headers) res.setHeader(k,v);
      return res.end(snap.body);
    }

    if (snap.statusCode >= 200 && snap.statusCode < 300 && data?.ok &&
        Number.isFinite(info.x) && Number.isFinite(info.y)) {
      try {
        const extra = await festivalItems(
          {x:info.x,y:info.y}, info.maxMinutes, info.visitDate
        );
        const existing = Array.isArray(data.items) ? data.items : [];
        const seen = new Set(existing.map(x => String(x.name || x.display_name || "").replace(/\s/g,"")));
        const festivals = extra.filter(x => !seen.has(String(x.name).replace(/\s/g,"")));
        data.items = [...festivals, ...existing].slice(0, 10);
        data.hasMore = Boolean(data.hasMore || festivals.length + existing.length > 10);
      } catch (error) {
        console.warn("[festival merge skipped]", error?.stack || error?.message || String(error));
      }
    }

    res.statusCode = snap.statusCode;
    res.setHeader("Content-Type","application/json; charset=utf-8");
    res.setHeader("Cache-Control","no-store");
    return res.end(JSON.stringify(data));
  } catch (error) {
    console.error("[api/app wrapper]", error?.stack || error?.message || String(error));
    res.statusCode = 500;
    res.setHeader("Content-Type","application/json; charset=utf-8");
    res.setHeader("Cache-Control","no-store");
    return res.end(JSON.stringify({
      ok:false,
      error:error?.message || "추천 정보를 불러오지 못했습니다."
    }));
  }
};
