const KAKAO = process.env.KAKAO_REST_KEY;
const NAVER_ID = process.env.NAVER_API_KEY_ID;
const NAVER_SECRET = process.env.NAVER_API_KEY_SECRET;
const NAVER_BASE = "https://naverapihub.apigw.ntruss.com";

// 같은 외부 조회를 메모리·Vercel 런타임 캐시에 저장한다. 런타임 캐시를
// 쓸 수 없는 로컬 환경에서는 메모리 캐시만 사용해도 앱은 정상 동작한다.
const memoryCache = new Map();
const CACHE_LIMIT = 500;
let runtimeCache = null;
let runtimeCacheChecked = false;
const CACHE_TTL = {
  localSearch: 6 * 60 * 60 * 1000,
  blogSearch: 12 * 60 * 60 * 1000,
  geocode: 7 * 24 * 60 * 60 * 1000,
  route: 30 * 60 * 1000,
  area: 7 * 24 * 60 * 60 * 1000
};

function sharedRuntimeCache() {
  if (runtimeCacheChecked) return runtimeCache;
  runtimeCacheChecked = true;
  try {
    runtimeCache = require("@vercel/functions").getCache();
  } catch (error) {
    // 개발 환경이나 지원하지 않는 배포 환경에서는 메모리 캐시로 안전하게 폴백한다.
    console.warn("[runtime cache unavailable]", error.message || String(error));
    runtimeCache = null;
  }
  return runtimeCache;
}

function cached(key, ttl, loader) {
  const now = Date.now();
  const existing = memoryCache.get(key);
  if (existing && existing.expiresAt > now) return existing.value;

  const value = Promise.resolve().then(async () => {
    const shared = sharedRuntimeCache();
    const sharedKey = `littletrip:v1:${key}`;
    if (shared) {
      try {
        const fromCache = await shared.get(sharedKey);
        if (fromCache !== null && fromCache !== undefined) return fromCache;
      } catch (error) {
        console.warn("[runtime cache read failed]", error.message || String(error));
      }
    }

    const fresh = await loader();
    if (shared) {
      try {
        await shared.set(sharedKey, fresh, { ttl: Math.ceil(ttl / 1000) });
      } catch (error) {
        console.warn("[runtime cache write failed]", error.message || String(error));
      }
    }
    return fresh;
  }).catch(error => {
    if (memoryCache.get(key)?.value === value) memoryCache.delete(key);
    throw error;
  });
  memoryCache.set(key, { value, expiresAt: now + ttl });

  for (const [oldKey, entry] of memoryCache) {
    if (entry.expiresAt <= now) memoryCache.delete(oldKey);
  }
  while (memoryCache.size > CACHE_LIMIT) memoryCache.delete(memoryCache.keys().next().value);
  return value;
}

function pointKey(point, digits = 3) {
  return `${Number(point.y).toFixed(digits)},${Number(point.x).toFixed(digits)}`;
}

function cachePolicy(mode) {
  if (mode === "geocode") return { maxAge: 86400, stale: 604800 };
  if (mode === "theme-preview") return { maxAge: 3600, stale: 86400 };
  if (mode === "theme") return { maxAge: 3600, stale: 86400 };
  if (mode === "nearby") return { maxAge: 900, stale: 3600 };
  return null;
}

const THEME = {
  experience: {
    title: "박물관 · 전시탐험",
    description: "어린이체험관 · 과학관 · 몰입형 전시",
    queries: ["어린이박물관", "어린이 체험관", "어린이 과학관", "어린이 전시관", "키즈 체험관"],
    include: ["박물관", "체험", "과학관", "미술관", "전시관", "문화관", "기념관"],
    childFocused: true
  },
  craft: {
    title: "만들기 · 공방",
    description: "도예 · 쿠킹 · 흙놀이 · 미술",
    queries: ["피자 만들기 체험", "쿠킹 체험", "도예 체험", "어린이 공방 체험", "베이킹 체험", "어린이 미술 체험", "농장 체험", "수확 체험"],
    contentQuery: "피자 만들기 체험",
    include: ["공방", "체험", "도예", "도자기", "베이킹", "미술", "공예", "요리"]
  },
  playground: {
    title: "놀이터 · 야외놀이",
    description: "공원 · 모래놀이 · 유아숲",
    queries: ["어린이 놀이터", "대형 놀이터", "유아숲체험원", "어린이공원", "모래놀이터"],
    include: ["놀이터", "어린이공원", "유아숲", "놀이시설", "모래놀이"],
    exclude: ["키즈카페", "실내놀이터", "트램폴린", "빙상", "스케이트", "스포츠"]
  },
  animals: {
    title: "동물 · 자연체험",
    description: "동물원 · 농장 · 곤충 · 숲 · 수목원",
    queries: ["동물원", "동물 체험", "목장 체험", "곤충 체험", "아쿠아리움", "수목원", "유아숲체험원", "생태공원"],
    include: ["동물", "목장", "농장", "곤충", "아쿠아리움", "수족관", "승마", "수목원", "생태", "유아숲", "휴양림", "숲", "정원", "식물원"]
  },
  indoor: {
    title: "실내 놀이 · 액티비티",
    description: "키즈카페 · 트램폴린 · 빙상장",
    queries: ["키즈카페", "키즈파크", "실내놀이터", "트램폴린 파크", "어린이 빙상장", "어린이 실내 액티비티"],
    include: ["키즈", "실내놀이터", "트램폴린", "놀이방", "점핑", "플레이", "빙상", "스케이트", "클라이밍"]
  },
  season: {
    title: "시즌 한정",
    description: "물놀이 · 눈놀이 · 계절 나들이",
    queries: ["어린이 물놀이장", "계곡 물놀이", "야외수영장", "워터파크"],
    include: ["물놀이", "계곡", "수영장", "워터", "분수", "눈썰매", "스케이트", "빙상"]
  }
};

function send(res, status, data, policy = null) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (policy) {
    // 일부 Vercel Functions 환경은 일반 Cache-Control의 s-maxage를 브라우저용
    // 헤더에서 제거한다. Vercel 전용 헤더도 함께 지정해야 CDN 캐시가 확실히 작동한다.
    const cdn = `public, max-age=${policy.maxAge}, stale-while-revalidate=${policy.stale}`;
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.setHeader("CDN-Cache-Control", cdn);
    res.setHeader("Vercel-CDN-Cache-Control", cdn);
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
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

function requireNaver() {
  if (!NAVER_ID || !NAVER_SECRET) {
    throw new Error("Vercel 환경변수 NAVER_API_KEY_ID 또는 NAVER_API_KEY_SECRET가 없습니다.");
  }
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

async function naver(path, params = {}) {
  requireNaver();
  const search = new URLSearchParams({ ...params, format: "json" });
  const response = await fetch(`${NAVER_BASE}${path}?${search}`, {
    headers: {
      "X-NCP-APIGW-API-KEY-ID": NAVER_ID,
      "X-NCP-APIGW-API-KEY": NAVER_SECRET
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(data?.errorMessage || data?.message || data?.error?.message || `Naver API ${response.status}`);
  }
  return data;
}

function haversine(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.y - a.y) * rad;
  const dLon = (b.x - a.x) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.y * rad) * Math.cos(b.y * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}

function naverCoordinate(value) {
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate)) return NaN;
  return Math.abs(coordinate) > 1000 ? coordinate / 10000000 : coordinate;
}

function naverPlace(item) {
  const x = naverCoordinate(item.mapx);
  const y = naverCoordinate(item.mapy);
  const place_name = stripHtml(item.title);
  return {
    id: `${x}:${y}:${place_name}`,
    place_name,
    category_name: stripHtml(item.category),
    description: stripHtml(item.description),
    address_name: item.address || "",
    road_address_name: item.roadAddress || "",
    place_url: item.link || "",
    x,
    y
  };
}

async function localSearch(query) {
  const normalizedQuery = String(query || "").trim().replace(/\s+/g, " ");
  return cached(`naver:local:${normalizedQuery}`, CACHE_TTL.localSearch, async () => {
    const data = await naver("/search/v1/local", { query: normalizedQuery, display: "5", sort: "comment" });
    return (data.items || []).map(naverPlace).filter(item => Number.isFinite(item.x) && Number.isFinite(item.y) && item.place_name);
  });
}

async function geocode(query) {
  const normalizedQuery = String(query || "").trim().replace(/\s+/g, " ");
  return cached(`geocode:${normalizedQuery}`, CACHE_TTL.geocode, async () => {
    const results = await localSearch(normalizedQuery);
    const exact = results.find(item => `${item.road_address_name} ${item.address_name} ${item.place_name}`.includes(normalizedQuery)) || results[0];
    if (!exact) throw new Error("네이버 지역검색에서 출발지를 찾지 못했습니다.");
    return { x: exact.x, y: exact.y, name: exact.road_address_name || exact.address_name || exact.place_name };
  });
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

function compactName(value) {
  return String(value || "").replace(/[\s·ㆍ,()\-_.]/g, "");
}

function venueKey(doc) {
  const name = compactName(doc.place_name || doc.name);
  const match = name.match(/^(.+?(?:박물관|과학관|미술관|기념관|문화관|전시관|공원|수목원|식물원|동물원|아쿠아리움|수족관|목장|농장|도서관|휴양림|키즈파크|키즈카페))/);
  return match ? match[1] : name;
}

function venueScore(doc) {
  const name = compactName(doc.place_name || doc.name);
  const root = venueKey(doc);
  const mentions = +(doc.hits || doc.family_evidence || 1);
  const childFacility = /어린이|유아|키즈|체험|놀이터|관찰|아열대|전시|과학/.test(name);
  return mentions * 100 + (name !== root ? 35 : -35) + (childFacility ? 25 : 0) - ((+doc.distance || +doc.distance_m || 0) / 10000);
}

function uniqueVenues(docs) {
  const representatives = new Map();
  for (const doc of docs) {
    const key = venueKey(doc);
    const previous = representatives.get(key);
    if (!previous || venueScore(doc) > venueScore(previous)) representatives.set(key, doc);
  }
  return [...representatives.values()];
}

function uniquePreviewThemes(themes) {
  const usedVenues = new Set();
  return themes.map(theme => ({
    ...theme,
    items: theme.items.filter(item => {
      const key = venueKey(item);
      if (usedVenues.has(key)) return false;
      usedVenues.add(key);
      return true;
    })
  }));
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

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value).trim()))];
}

function areaHints(originLabel = "") {
  const label = String(originLabel || "").trim();
  if (!label) return [];
  const administrative = label.match(/[가-힣]{2,}(?:특별시|광역시|특별자치시|도|시|군|구|읍|면|동)/g) || [];
  const roadPrefix = label.match(/^([가-힣]{2,}?)(?:[가-힣]*(?:로|길)|\s|$)/)?.[1];
  const words = label.split(/\s+/).map(word => word.replace(/[0-9,.-]/g, "")).filter(Boolean);
  const removeAdministrativeSuffix = value => String(value || "").replace(/(특별자치시|특별시|광역시|시|도|군|구|읍|면|동)$/g, "");
  const firstArea = removeAdministrativeSuffix(words[0]);
  const lastArea = removeAdministrativeSuffix(administrative.at(-1));
  const firstIsProvinceOrCombined = /^(전남|전북|전남광주통합|전북특별|강원|충남|충북|경남|경북|경기|제주|세종)/.test(firstArea);
  const primary = roadPrefix || (firstIsProvinceOrCombined ? lastArea : firstArea) || lastArea;
  return uniqueStrings([primary, [firstArea, lastArea].filter(Boolean).join(" "), lastArea]).slice(0, 3);
}

function themedQueries(definition, originLabel) {
  const hints = areaHints(originLabel);
  if (!hints.length) return definition.queries.slice(0, 4);
  const localQueries = definition.queries.slice(0, 3).map(query => `${hints[0]} ${query}`);
  // 지역 결과가 너무 적을 때만 대표 활동어 하나를 넓게 보완한다.
  return uniqueStrings([...localQueries, ...definition.queries.slice(0, 1)]);
}

const originAreaCache = new Map();

async function originAreaLabel(origin) {
  const cacheKey = `${Number(origin.y).toFixed(3)},${Number(origin.x).toFixed(3)}`;
  if (originAreaCache.has(cacheKey)) return originAreaCache.get(cacheKey);
  const value = cached(`origin-area:${cacheKey}`, CACHE_TTL.area, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=ko&lat=${encodeURIComponent(origin.y)}&lon=${encodeURIComponent(origin.x)}`, {
        headers: { "User-Agent": "littletrip/1.0" },
        signal: controller.signal
      });
      const data = response.ok ? await response.json() : {};
      const address = data?.address || {};
      return address.city || address.county || address.state_district || address.province || "";
    } catch (error) {
      console.warn("[origin area lookup failed]", error.message || String(error));
      return "";
    } finally {
      clearTimeout(timeout);
    }
  });
  originAreaCache.set(cacheKey, value);
  return value;
}

// 만들기 후보를 블로그에서 보완할 때는, 체험 장소를 뜻하는 이름만 뽑는다.
// '미술관'처럼 단순 관광 장소까지 꺼내오면 만들기 체험으로 오인될 수 있다.
const CRAFT_CONTENT_VENUE_SUFFIX = "체험농장|생태나라|치즈마을|체험마을|농장|농원|목장|공방|도예원|베이킹스튜디오|쿠킹스튜디오";

function contentVenueNames(items) {
  const expression = new RegExp(`(?:[가-힣A-Za-z0-9&·]+(?:\\s+[가-힣A-Za-z0-9&·]+){0,3}\\s*)?(?:${CRAFT_CONTENT_VENUE_SUFFIX})`, "g");
  const names = [];
  for (const item of items || []) {
    const text = stripHtml(`${item.title || ""} ${item.description || ""}`);
    for (const match of text.matchAll(expression)) {
      const words = match[0].replace(/\s+/g, " ").trim().split(" ");
      const name = words.slice(-3).join(" ");
      if (name.length >= 3 && name.length <= 32) names.push(name);
    }
  }
  // 블로그에서 뽑은 후보를 전부 다시 지역검색하면 호출량이 급증한다.
  // 상위 8개만 검증해도 체험 장소 발굴에는 충분하다.
  return uniqueStrings(names).slice(0, 8);
}

async function contentMatchedPlaces(query) {
  const normalizedQuery = String(query || "").trim().replace(/\s+/g, " ");
  return cached(`naver:content:${normalizedQuery}`, CACHE_TTL.blogSearch, async () => {
    const data = await naver("/search/v1/blog", { query: normalizedQuery, display: "20", sort: "sim" });
    const names = contentVenueNames(data.items);
    const groups = await Promise.all(names.map(name => localSearch(name).catch(error => {
      console.warn("[naver content resolve failed]", name, error.message || String(error));
      return [];
    })));
    return groups.flat().map(place => ({ ...place, content_evidence: true }));
  });
}

function isResearchVenue(doc) {
  const name = String(doc.place_name || doc.name || "");
  return /연구소|연구원|연구센터|시험장/.test(name);
}

function hasDirectChildActivity(doc) {
  const text = `${doc.place_name || doc.name || ""} ${doc.category_name || doc.category || ""} ${doc.description || ""}`;
  // 연구기관의 업종이 단순히 '박물관'으로 표시되는 일은 흔하다. 어린이·체험
  // 근거가 있는 경우만 바로 통과시키고, 나머지는 블로그 근거를 별도로 확인한다.
  return /어린이|유아|키즈|놀이|샌드|체험관|과학관|몰입형|인터랙티브/.test(text);
}

async function routes(origin, docs, limit = 24) {
  if (!docs.length) return [];
  const targets = docs.slice(0, limit);
  const routeKey = `kakao:routes:${pointKey(origin)}:${targets.map(doc => doc.id || `${doc.x},${doc.y}`).join("|")}`;
  return cached(routeKey, CACHE_TTL.route, async () => {
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
  });
}

function suitable(doc, definition, query = "") {
  const name = String(doc.place_name || "");
  const category = String(doc.category_name || "");
  const text = `${name} ${category} ${doc.description || ""}`;

  // 검색어에 '체험'이 들어갔다고 결과 장소까지 체험 장소인 것은 아니다.
  // 음식점·카페 같은 업종은 어떤 만들기 검색어에서 나왔더라도 후보가 될 수 없다.
  const foodOrStay = /음식점|카페,?디저트|술집|주점|모텔|호텔|부동산|교회/.test(category);
  if (foodOrStay) return false;
  if (definition.exclude?.some(word => text.includes(word))) return false;

  if (definition === THEME.craft) {
    const activityInPlace = /공방|도예|도자기|베이킹|쿠킹|만들기|공예|피자\s*체험|농장\s*체험|수확\s*체험|요리\s*(?:체험|교육|교실|수업|클래스)|미술\s*(?:체험|교육|교실|수업|클래스)/.test(text);
    const safeActivityCategory = /공방|도자기|체험|테마파크|농장|농원|목장|요리교육|미술교육|공예|문화센터|키즈카페|실내놀이터/.test(category);
    const educationWithoutActivity = /학원|교습시설/.test(category) && !activityInPlace;
    if (educationWithoutActivity) return false;

    // 직접 검색 결과는 장소 자체에 활동 근거가 있어야 하며,
    // 블로그 보완 결과도 체험·농장 등 안전한 업종일 때만 허용한다.
    return activityInPlace || (!!doc.content_evidence && safeActivityCategory);
  }

  if (!definition.include.some(word => text.includes(word))) return false;
  // '연구소'라는 이유만으로 제외하지는 않는다. 다만 어린이 활동 근거가 없는
  // 일반 연구기관은 전시탐험 후보에서 빼고, 블로그 검색으로 근거가 확인되면 통과시킨다.
  if (definition.childFocused && isResearchVenue(doc) && !hasDirectChildActivity(doc) && !doc.child_evidence) return false;
  if (/학원/.test(category)) return false;
  return true;
}

function seasonQueries(visitDate) {
  const month = Number(String(visitDate || "").slice(5, 7)) || new Date().getMonth() + 1;
  if (month >= 6 && month <= 9) return ["어린이 물놀이장", "계곡 물놀이", "야외수영장", "분수 물놀이장", "워터파크"];
  if (month === 12 || month <= 2) return ["어린이 눈썰매장", "빙상장", "스케이트장", "눈놀이장"];
  return ["어린이 계절 체험", "어린이 야외 나들이", "가족 생태 체험"];
}

async function searchTheme(key, origin, maxMinutes, originLabel = "", options = {}) {
  const baseDefinition = THEME[key];
  if (!baseDefinition) return [];
  const definition = key === "season" ? { ...baseDefinition, queries: seasonQueries(options.visitDate) } : baseDefinition;
  const [queryResults, contentDocs] = await Promise.all([
    Promise.all(themedQueries(definition, originLabel).map(async query => ({
      query,
      docs: await localSearch(query).catch(error => {
        console.warn("[naver local failed]", key, query, error.message || String(error));
        return [];
      })
    }))),
    definition.contentQuery ? contentMatchedPlaces(`${areaHints(originLabel)[0] || ""} ${definition.contentQuery}`.trim()).catch(error => {
      console.warn("[naver content search failed]", key, error.message || String(error));
      return [];
    }) : Promise.resolve([])
  ]);
  if (contentDocs.length) queryResults.push({ query: definition.contentQuery, docs: contentDocs });
  const byId = new Map();
  for (const { query, docs } of queryResults) {
    for (const doc of docs) {
      if (!doc.id || !suitable(doc, definition, query)) continue;
      if (!byId.has(doc.id)) byId.set(doc.id, { ...doc, distance: Math.round(haversine(origin, doc) * 1000), hits: 0 });
      const candidate = byId.get(doc.id);
      candidate.content_evidence ||= !!doc.content_evidence;
      candidate.hits += doc.content_evidence ? 2 : 1;
    }
  }
  const roughKm = maxMinutes <= 40 ? 45 : 90;
  const candidates = uniqueVenues([...byId.values()])
    .filter(doc => haversine(origin, { x: +doc.x, y: +doc.y }) <= roughKm)
    .sort((a, b) => (venueScore(b) - venueScore(a)) || ((+a.distance || 9999999) - (+b.distance || 9999999)))
    .slice(0, options.preview ? 12 : 24);
  const routed = await routes(origin, candidates, options.preview ? 12 : 24);
  const candidateLimit = options.candidateLimit || (options.preview ? 6 : 12);
  const items = routed
    .filter(doc => doc.route_minutes <= maxMinutes)
    .map(doc => normalized(doc, {
      route_minutes: doc.route_minutes,
      route_distance: doc.route_distance,
      route_estimated: !!doc.route_estimated,
      family_evidence: doc.hits || 1
    }))
    // 이동시간은 통과 여부만 판단한다. 최종 순서는 테마 검색 근거와 이동시간으로 정한다.
    .sort((a, b) => (b.family_evidence - a.family_evidence) || (a.route_minutes - b.route_minutes))
    .slice(0, candidateLimit);
  console.log("[theme search]", JSON.stringify({ theme: key, candidates: candidates.length, items: items.length }));
  // 블로그 검색 결과는 장소 ID에 묶인 후기가 아니라 키워드 결과다.
  // 동명이거나 일반명인 장소에 다른 지역·해외 글이 섞이는 것을 확인했으므로,
  // 추천 순위와 화면에는 이 값을 사용하지 않는다.
  return items
    .map(item => ({ ...item, matched_themes: [key] }))
    .sort(compareCandidateQuality);
}

function compareCandidateQuality(a, b) {
  // 블로그 키워드 결과는 순위에 쓰지 않는다. 테마 검색에서 여러 번 확인된 장소를
  // 먼저 두고, 그다음 실제 이동시간으로만 안정적으로 정렬한다.
  return (b.family_evidence || 0) - (a.family_evidence || 0)
    || (a.route_minutes || 9999) - (b.route_minutes || 9999);
}

async function searchThemes(keys, origin, maxMinutes, originLabel = "", options = {}) {
  const selected = uniqueStrings(keys).filter(key => THEME[key]);
  if (!selected.length) return [];
  // 여러 테마를 동시에 고를 때도 외부 검색 호출이 과도하게 늘지 않도록
  // 테마별 후보 수를 나눠 갖는다. 결과 목록은 최대 10곳이다.
  const candidateLimit = selected.length === 1 ? 12 : Math.max(3, Math.ceil(16 / selected.length));
  const groups = await Promise.all(selected.map(key => searchTheme(key, origin, maxMinutes, originLabel, {
    ...options,
    candidateLimit
  })));
  const byVenue = new Map();
  for (const item of groups.flat()) {
    const venue = venueKey(item);
    const previous = byVenue.get(venue);
    if (!previous || compareCandidateQuality(item, previous) < 0) {
      byVenue.set(venue, { ...item, matched_themes: uniqueStrings([...(previous?.matched_themes || []), ...(item.matched_themes || [])]) });
    } else {
      previous.matched_themes = uniqueStrings([...(previous.matched_themes || []), ...(item.matched_themes || [])]);
    }
  }
  return [...byVenue.values()].sort(compareCandidateQuality).slice(0, 10);
}

async function searchNearby(origin, type, originLabel = "") {
  const terms = type === "food" ? ["가족 식당", "맛집", "한식"]
    : type === "cafe" ? ["카페", "베이커리 카페"]
      : ["어린이 놀이터", "공원", "도서관", "체험관", "박물관"];
  const hint = areaHints(originLabel)[0];
  const queries = uniqueStrings(terms.map(term => hint ? `${hint} ${term}` : term));
  const docs = (await Promise.all(queries.map(query => localSearch(query).catch(error => {
    console.warn("[naver nearby failed]", type, query, error.message || String(error));
    return [];
  })))).flat();
  const candidates = uniqueVenues(docs)
    .filter(doc => haversine(origin, doc) <= 25)
    .sort((a, b) => haversine(origin, a) - haversine(origin, b))
    .slice(0, 20);
  const routed = await routes(origin, candidates);
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
    const policy = req.method === "GET" ? cachePolicy(mode) : null;
    if (mode === "health") return send(res, 200, { ok: true, naver: !!(NAVER_ID && NAVER_SECRET), kakao: !!KAKAO });
    if (mode === "geocode") {
      const query = req.query?.q || url.searchParams.get("q") || "";
      return send(res, 200, { ok: true, origin: await geocode(query) }, policy);
    }

    const body = req.method === "GET" ? {} : await readBody(req);
    const value = key => body[key] ?? req.query?.[key] ?? url.searchParams.get(key) ?? "";
    const origin = { x: +value("x"), y: +value("y") };
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) throw new Error("출발지 좌표가 올바르지 않습니다.");
    const maxMinutes = Math.max(10, Math.min(120, +value("maxMinutes") || 40));
    const originLabel = value("originLabel") || await originAreaLabel(origin);

    if (mode === "theme-preview") {
      const themes = await Promise.all(Object.keys(THEME).map(async key => ({
        key,
        title: THEME[key].title,
        description: THEME[key].description,
        items: await searchTheme(key, origin, maxMinutes, originLabel, { preview: true, visitDate: value("visitDate") })
      })));
      return send(res, 200, { ok: true, transitEnabled: false, themes: uniquePreviewThemes(themes) }, policy);
    }
    if (mode === "theme") {
      const selectedThemes = uniqueStrings(String(value("themes") || value("theme") || "experience").split(","));
      return send(res, 200, {
        ok: true,
        transitEnabled: false,
        items: await searchThemes(selectedThemes, origin, maxMinutes, originLabel, { visitDate: value("visitDate") })
      }, policy);
    }
    if (mode === "nearby") {
      return send(res, 200, { ok: true, items: await searchNearby(origin, value("type") || "sub", originLabel) }, policy);
    }
    return send(res, 400, { ok: false, error: "unknown mode" });
  } catch (error) {
    console.error("[api/app]", error?.stack || error?.message || String(error));
    return send(res, 500, { ok: false, error: error?.message || "추천 정보를 불러오지 못했습니다." });
  }
};

// 배포 전 후보 판정 회귀 검증에만 사용한다. HTTP 응답에는 노출되지 않는다.
module.exports.__test = { suitable, THEME, seasonQueries, isResearchVenue, hasDirectChildActivity, compareCandidateQuality };
