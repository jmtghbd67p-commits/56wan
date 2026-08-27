const KAKAO = process.env.KAKAO_REST_KEY;

const THEME = {
  experience: {
    title: "체험 · 박물관",
    description: "어린이·국립 박물관 · 과학관 · 체험관",
    queries: ["어린이박물관", "어린이 체험관", "어린이 과학관", "박물관 체험", "키즈 체험관"],
    include: ["박물관", "체험", "과학관", "미술관", "전시관", "문화관", "기념관"]
  },
  craft: {
    title: "만들기 · 공방체험",
    description: "도예 · 미술 · 요리 · 베이킹",
    queries: ["도예 체험", "어린이 공방 체험", "베이킹 체험", "어린이 미술 체험", "요리 체험"],
    include: ["공방", "체험", "도예", "도자기", "베이킹", "미술", "공예", "요리"]
  },
  playground: {
    title: "놀이터",
    description: "실제 놀이시설 · 모래놀이 · 유아숲",
    queries: ["어린이 놀이터", "대형 놀이터", "유아숲체험원", "어린이공원", "모래놀이터"],
    include: ["놀이터", "어린이공원", "유아숲", "놀이시설", "키즈파크"]
  },
  animals: {
    title: "동물 · 농장체험",
    description: "동물원 · 목장 · 곤충 · 먹이주기",
    queries: ["동물원", "동물 체험", "목장 체험", "곤충 체험", "아쿠아리움"],
    include: ["동물", "목장", "농장", "곤충", "아쿠아리움", "수족관", "승마"]
  },
  nature: {
    title: "자연 · 숲 · 생태",
    description: "수목원 · 숲체험 · 생태공원",
    queries: ["수목원", "생태공원", "유아숲체험원", "자연휴양림", "숲체험"],
    include: ["수목원", "생태", "유아숲", "휴양림", "숲", "정원", "식물원"]
  },
  indoor: {
    title: "키즈카페 · 실내놀이",
    description: "키즈파크 · 트램폴린 · 실내놀이터",
    queries: ["키즈카페", "키즈파크", "실내놀이터", "트램폴린 파크", "어린이 실내체험"],
    include: ["키즈", "실내놀이터", "트램폴린", "놀이방", "점핑", "플레이"]
  },
  books: {
    title: "책 · 도서관",
    description: "어린이도서관 · 그림책 · 북라운지",
    queries: ["어린이도서관", "그림책 도서관", "어린이 책방", "도서관 어린이자료실"],
    include: ["도서관", "그림책", "책방", "북카페", "북라운지"]
  },
  water: {
    title: "물놀이 · 계곡",
    description: "계곡 · 물놀이장 · 야외수영장",
    queries: ["어린이 물놀이장", "계곡 물놀이", "야외수영장", "워터파크", "분수 물놀이장"],
    include: ["물놀이", "계곡", "수영장", "워터", "분수"]
  }
};

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function requireKakao() {
  if (!KAKAO) throw new Error("Vercel 환경변수 KAKAO_REST_KEY가 없습니다.");
}

async function kakao(url, options = {}) {
  requireKakao();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `KakaoAK ${KAKAO}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.message || data?.msg || `Kakao API ${response.status}`);
  return data;
}

function haversine(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.y - a.y) * rad;
  const dLon = (b.x - a.x) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.y * rad) * Math.cos(b.y * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

async function geocode(query) {
  const address = await kakao(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}`);
  if (address.documents?.length) {
    const item = address.documents[0];
    return { x: +item.x, y: +item.y, name: item.address_name || query };
  }
  const result = await kakao(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=1`);
  if (result.documents?.length) {
    const item = result.documents[0];
    return { x: +item.x, y: +item.y, name: item.place_name || query };
  }
  throw new Error("출발지를 찾지 못했습니다.");
}

async function keyword(query, origin, size = 15, radius) {
  const params = new URLSearchParams({
    query,
    x: String(origin.x),
    y: String(origin.y),
    sort: "distance",
    size: String(size)
  });
  if (radius) params.set("radius", String(Math.min(radius, 20000)));
  const data = await kakao(`https://dapi.kakao.com/v2/local/search/keyword.json?${params}`);
  return data.documents || [];
}

async function category(code, origin, radius = 5000, size = 15) {
  const params = new URLSearchParams({
    category_group_code: code,
    x: String(origin.x),
    y: String(origin.y),
    sort: "distance",
    radius: String(Math.min(radius, 20000)),
    size: String(size)
  });
  const data = await kakao(`https://dapi.kakao.com/v2/local/search/category.json?${params}`);
  return data.documents || [];
}

function normalized(doc, extra = {}) {
  return {
    id: String(doc.id || `${doc.x},${doc.y},${doc.place_name}`),
    name: doc.place_name,
    category: doc.category_name,
    category_group_code: doc.category_group_code,
    address: doc.address_name,
    road_address: doc.road_address_name,
    phone: doc.phone,
    place_url: doc.place_url,
    x: +doc.x,
    y: +doc.y,
    distance_m: +doc.distance || null,
    ...extra
  };
}

function estimatedRoute(origin, doc) {
  const km = haversine(origin, { x: +doc.x, y: +doc.y });
  return {
    ...doc,
    route_minutes: Math.max(5, Math.round(km * 1.55 + 4)),
    route_distance: Math.round(km * 1300),
    route_estimated: true
  };
}

async function routes(origin, docs) {
  if (!docs.length) return [];
  const targets = docs.slice(0, 30);
  try {
    const data = await kakao("https://apis-navi.kakaomobility.com/v1/destinations/directions", {
      method: "POST",
      body: JSON.stringify({
        origin: { x: +origin.x, y: +origin.y },
        destinations: targets.map((doc, index) => ({ x: +doc.x, y: +doc.y, key: String(index) })),
        radius: 10000,
        priority: "TIME"
      })
    });
    const result = new Map((data.routes || []).filter(route => route.result_code === 0 && route.summary).map(route => [String(route.key), route]));
    const routed = targets.map((doc, index) => {
      const route = result.get(String(index));
      if (!route) return estimatedRoute(origin, doc);
      return {
        ...doc,
        route_minutes: Math.max(1, Math.round(route.summary.duration / 60)),
        route_distance: route.summary.distance,
        route_estimated: false
      };
    });
    console.log("[route matrix]", JSON.stringify({ requested: targets.length, actual: result.size, fallback: targets.length - result.size }));
    return routed;
  } catch (error) {
    console.warn("[route matrix fallback]", error.message || String(error));
    return targets.map(doc => estimatedRoute(origin, doc));
  }
}

function suitable(doc, definition) {
  const text = `${doc.place_name || ""} ${doc.category_name || ""}`;
  if (!definition.include.some(word => text.includes(word))) return false;
  if (/음식점|카페|술집|주점|모텔|호텔|부동산|교회|학원/.test(doc.category_name || "")) {
    return definition === THEME.craft && /체험|공방|도예|베이킹|미술|요리/.test(text);
  }
  return true;
}

async function searchTheme(key, origin, maxMinutes) {
  const definition = THEME[key];
  if (!definition) return [];
  const queryResults = await Promise.all(definition.queries.map(query => keyword(query, origin, 15).catch(error => {
    console.warn("[keyword failed]", key, query, error.message || String(error));
    return [];
  })));
  const byId = new Map();
  for (const list of queryResults) {
    for (const doc of list) {
      if (!doc.id || !suitable(doc, definition)) continue;
      if (!byId.has(doc.id)) byId.set(doc.id, { ...doc, hits: 0 });
      byId.get(doc.id).hits += 1;
    }
  }
  const roughKm = maxMinutes <= 40 ? 45 : 90;
  const candidates = [...byId.values()]
    .filter(doc => haversine(origin, { x: +doc.x, y: +doc.y }) <= roughKm)
    .sort((a, b) => (b.hits - a.hits) || ((+a.distance || 9999999) - (+b.distance || 9999999)))
    .slice(0, 18);
  const routed = await routes(origin, candidates);
  const items = routed
    .filter(doc => doc.route_minutes <= maxMinutes)
    .map(doc => normalized(doc, {
      route_minutes: doc.route_minutes,
      route_distance: doc.route_distance,
      route_estimated: !!doc.route_estimated,
      family_evidence: doc.hits || 1
    }))
    .sort((a, b) => (b.family_evidence - a.family_evidence) || (a.route_minutes - b.route_minutes))
    .slice(0, 12);
  console.log("[theme search]", JSON.stringify({ theme: key, candidates: candidates.length, items: items.length }));
  return items;
}

async function searchNearby(origin, type) {
  let candidates = [];
  if (type === "food") candidates = await category("FD6", origin, 7000, 15);
  else if (type === "cafe") candidates = await category("CE7", origin, 7000, 15);
  else {
    const lists = await Promise.all(["어린이 놀이터", "공원", "도서관", "체험관", "박물관"].map(query => keyword(query, origin, 10, 10000)));
    const byId = new Map();
    for (const doc of lists.flat()) {
      if (doc.id && !["FD6", "CE7"].includes(doc.category_group_code) && !byId.has(doc.id)) byId.set(doc.id, doc);
    }
    candidates = [...byId.values()].slice(0, 20);
  }
  const routed = await routes(origin, candidates.slice(0, 20));
  return routed.map(doc => normalized(doc, {
    route_minutes: doc.route_minutes,
    route_distance: doc.route_distance,
    route_estimated: !!doc.route_estimated
  })).sort((a, b) => a.route_minutes - b.route_minutes).slice(0, 8);
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://local");
    const mode = req.query?.mode || url.searchParams.get("mode");
    if (mode === "health") return send(res, 200, { ok: true, kakao: !!KAKAO });
    if (mode === "geocode") {
      const query = req.query?.q || url.searchParams.get("q") || "";
      return send(res, 200, { ok: true, origin: await geocode(query) });
    }

    const body = await readBody(req);
    const origin = { x: +body.x, y: +body.y };
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) throw new Error("출발지 좌표가 올바르지 않습니다.");
    const maxMinutes = Math.max(10, Math.min(120, +body.maxMinutes || 40));

    if (mode === "theme-preview") {
      const themes = await Promise.all(Object.keys(THEME).map(async key => ({
        key,
        title: THEME[key].title,
        description: THEME[key].description,
        items: await searchTheme(key, origin, maxMinutes)
      })));
      return send(res, 200, { ok: true, transitEnabled: false, themes });
    }
    if (mode === "theme") {
      return send(res, 200, {
        ok: true,
        transitEnabled: false,
        items: await searchTheme(body.theme || "experience", origin, maxMinutes)
      });
    }
    if (mode === "nearby") {
      return send(res, 200, { ok: true, items: await searchNearby(origin, body.type || "sub") });
    }
    return send(res, 400, { ok: false, error: "unknown mode" });
  } catch (error) {
    console.error("[api/app]", error?.stack || error?.message || String(error));
    return send(res, 500, { ok: false, error: error?.message || "추천 정보를 불러오지 못했습니다." });
  }
};
