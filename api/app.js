const CORE_SOURCE_URL =
  "https://raw.githubusercontent.com/jmtghbd67p-commits/56wan/94e0a945245fbdc87caf1c0152cc81f6c8dc0940/api/app.js";
const FESTIVAL_API = "https://api.data.go.kr/openapi/tn_pubr_public_cltur_fstvl_api";
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
  const get = key => req.query?.[key] ?? url.searchParams.get(key) ?? "";
  const themes = String(get("themes") || get("theme") || "")
    .split(",").map(v => v.trim()).filter(Boolean);
  return {
    mode: String(get("mode") || ""),
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
  const start = digits8(recordValue(record, ["fstvlStartDate","eventStartDate","startDate"]));
  const end = digits8(recordValue(record, ["fstvlEndDate","eventEndDate","endDate"])) || start;
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

async function fetchFestivalRows() {
  if (!FESTIVAL_KEY) return [];
  let last = "";
  for (const serviceKey of serviceKeyVariants()) {
    const params = new URLSearchParams({
      serviceKey,
      pageNo: "1",
      numOfRows: "1000",
      type: "json"
    });
    const response = await fetch(`${FESTIVAL_API}?${params}`, { cache: "no-store" });
    const text = await response.text();
    last = text.slice(0, 180);
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const rows = data ? rowsFrom(data) : [];
    if (response.ok && rows.length) {
      console.log("[festival api]", JSON.stringify({ status: response.status, total: rows.length }));
      return rows;
    }
  }
  console.warn("[festival api empty]", last);
  return [];
}

function regionTokens(text) {
  const t = String(text || "")
    .replace(/전남광주통합특별시/g, "전라남도")
    .replace(/전남특별자치도/g, "전라남도")
    .replace(/전남/g, "전라남도")
    .replace(/광주광역시/g, "광주")
    .replace(/\s+/g, " ")
    .trim();
  const m = t.match(/(전라남도|전라북도|광주|서울|부산|대구|인천|대전|울산|세종|경기도|강원(?:특별자치도|도)?|충청북도|충청남도|경상북도|경상남도|제주(?:특별자치도)?)[ ]+([가-힣]+(?:시|군|구))/);
  return m ? { province: m[1], district: m[2] } : null;
}
function normRegionName(v) {
  return String(v || "")
    .replace(/전남광주통합특별시/g, "전라남도")
    .replace(/전남특별자치도/g, "전라남도")
    .replace(/^전남(?=\s)/g, "전라남도")
    .replace(/강원특별자치도/g, "강원도")
    .replace(/제주특별자치도/g, "제주도")
    .replace(/\s+/g, "")
    .trim();
}
async function originAdministrativeRegion(origin) {
  if (!KAKAO || !origin) return null;
  const params = new URLSearchParams({ x: String(origin.x), y: String(origin.y) });
  const response = await fetch(
    `https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?${params}`,
    { headers: { Authorization: `KakaoAK ${KAKAO}` } }
  );
  const data = await response.json().catch(() => ({}));
  const row = (data?.documents || []).find(x => x.region_type === "H") || data?.documents?.[0];
  if (!row) return null;
  return {
    province: row.region_1depth_name || "",
    district: row.region_2depth_name || "",
    label: `${row.region_1depth_name || ""} ${row.region_2depth_name || ""}`.trim()
  };
}
function graphKeyFor(region) {
  if (!region) return null;
  const wantedDistrict = normRegionName(region.district);
  const wantedProvince = normRegionName(region.province);
  const keys = Object.keys(SIGUNGU_GRAPH || {});
  return keys.find(k => {
    const n = normRegionName(k);
    return n.includes(wantedDistrict) && (!wantedProvince || n.includes(wantedProvince));
  }) || keys.find(k => normRegionName(k).includes(wantedDistrict)) || null;
}
function allowedGraphRegions(region, maxMinutes) {
  const start = graphKeyFor(region);
  if (!start) return [];
  const depthLimit = maxMinutes <= 40 ? 1 : 2;
  const seen = new Set([start]);
  let frontier = [start];
  for (let depth = 0; depth < depthLimit; depth += 1) {
    const next = [];
    for (const key of frontier) {
      const neighbors = Array.isArray(SIGUNGU_GRAPH?.[key]) ? SIGUNGU_GRAPH[key] : [];
      for (const n of neighbors) {
        if (!seen.has(n)) { seen.add(n); next.push(n); }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return [...seen];
}
function festivalInAllowedRegion(row, allowed) {
  if (!allowed?.length) return true;
  const address = [recordValue(row, ["addr1","rdnmadr","roadNmAddr","lnmadr","address"]), recordValue(row, ["addr2"])].filter(Boolean).join(" ");
  const n = normRegionName(address);
  return allowed.some(r => {
    const rt = regionTokens(String(r).replace(/([가-힣]+(?:시|군|구))$/, " $1"));
    const district = rt?.district || String(r).match(/([가-힣]+(?:시|군|구))$/)?.[1] || "";
    return district && n.includes(normRegionName(district));
  });
}

async function festivalItems(origin, maxMinutes, visitDate) {
  const targetDate = digits8(visitDate);
  const [allRows, originRegion] = await Promise.all([
    fetchFestivalRows(targetDate),
    originAdministrativeRegion(origin)
  ]);
  const allowed = allowedGraphRegions(originRegion, maxMinutes);
  const rows = allRows
    .filter(row => activeOn(row, targetDate))
    .filter(row => festivalInAllowedRegion(row, allowed));

  console.log("[festival region filter]", JSON.stringify({
    origin: originRegion?.label || "",
    maxMinutes,
    allowedCount: allowed.length,
    allowed: allowed.slice(0, 20),
    before: allRows.length,
    after: rows.length
  }));

  const candidates = [];
  for (const row of rows) {
    const name = recordValue(row, ["title","fstvlNm","festivalNm","eventNm","name"]);
    if (!name) continue;
    const address = [
      recordValue(row, ["addr1","rdnmadr","roadNmAddr","lnmadr","address"]),
      recordValue(row, ["addr2"])
    ].filter(Boolean).join(" ");

    let x = Number(recordValue(row, ["mapx","longitude","lon","x"]));
    let y = Number(recordValue(row, ["mapy","latitude","lat","y"]));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const point = await geocode(address);
      if (!point) continue;
      x = point.x; y = point.y;
    }

    const dx = (x - origin.x) * Math.cos(origin.y * Math.PI / 180);
    const dy = y - origin.y;
    const straightKm = Math.sqrt(dx*dx + dy*dy) * 111;
    candidates.push({ row, name, address, x, y, straightKm });
  }

  candidates.sort((a,b) => a.straightKm - b.straightKm);

  // 지역+인접 시군구로 이미 줄였으므로, 이 후보들에 대해서만 실제 차량시간을 확인한다.
  const routed = await Promise.all(
    candidates.slice(0, 30).map(async c => ({ ...c, route: await route(origin, {x:c.x,y:c.y}) }))
  );

  const results = [];
  for (const c of routed) {
    if (!c.route || c.route.minutes > maxMinutes) continue;
    const start = recordValue(c.row, ["eventstartdate","fstvlStartDate","eventStartDate","startDate"]);
    const end = recordValue(c.row, ["eventenddate","fstvlEndDate","eventEndDate","endDate"]);
    results.push({
      id: `festival:${c.name}:${digits8(start)}`,
      name: c.name,
      display_name: c.name,
      category: "지역축제",
      address: c.address,
      road_address: c.address,
      phone: recordValue(c.row, ["tel","phoneNumber","phone"]),
      place_url: "",
      x: c.x, y: c.y,
      route_minutes: c.route.minutes,
      route_distance: c.route.distance,
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
    date: targetDate,
    regionCandidates: rows.length,
    routed: routed.length,
    count: results.length,
    names: results.slice(0,10).map(x=>x.name)
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
