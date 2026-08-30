const KAKAO = process.env.KAKAO_REST_KEY;
const NAVER_ID = process.env.NAVER_API_KEY_ID;
const NAVER_SECRET = process.env.NAVER_API_KEY_SECRET;
// 공공데이터포털의 "한눈에보는문화정보"와 "문화시설" 서비스가 같은
// 인증키를 사용한다. 키는 브라우저·GitHub에 절대 노출하지 않고 Vercel에만 둔다.
const CULTURE_DATA_SERVICE_KEY = process.env.CULTURE_DATA_SERVICE_KEY;
const NAVER_BASE = "https://naverapihub.apigw.ntruss.com";
const CULTURE_BASE = "https://apis.data.go.kr/B553457/nopenapi/rest";

// 같은 외부 조회를 메모리·Vercel 런타임 캐시에 저장한다. 런타임 캐시를
// 쓸 수 없는 로컬 환경에서는 메모리 캐시만 사용해도 앱은 정상 동작한다.
const memoryCache = new Map();
const CACHE_LIMIT = 500;
let runtimeCache = null;
let runtimeCacheChecked = false;
const CACHE_TTL = {
  localSearch: 6 * 60 * 60 * 1000,
  // 공식 홈페이지·공공기관에 올라온 유아/어린이 프로그램 근거는 자주 바뀌지
  // 않으므로 길게 캐시한다. 네이버 지도 방문자 리뷰를 수집하는 용도가 아니다.
  officialProgramSearch: 14 * 24 * 60 * 60 * 1000,
  blogSearch: 12 * 60 * 60 * 1000,
  geocode: 7 * 24 * 60 * 60 * 1000,
  route: 30 * 60 * 1000,
  area: 7 * 24 * 60 * 60 * 1000,
  culturalPrograms: 6 * 60 * 60 * 1000,
  culturalSpaces: 24 * 60 * 60 * 1000
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
  // 추천 결과는 후보 필터 변경이나 신규 문화행사 반영이 빨라야 한다.
  // 한 시간 CDN 캐시로 두면 수정 후에도 사용자가 같은 조건에서 구후보를 본다.
  if (mode === "theme") return { maxAge: 60, stale: 300 };
  if (mode === "nearby") return { maxAge: 900, stale: 3600 };
  return null;
}

const THEME = {
  experience: {
    title: "문화 · 전시",
    description: "어린이체험관 · 과학관 · 몰입형 전시",
    // 비엔날레는 이름만으로 '어린이' 검색에 걸리지 않으므로 별도 검색어로 넣는다.
    // 과학관은 전시 일정과 무관하게 일반 장소 후보로 유지한다.
    // '국립항공박물관'처럼 이름에 어린이가 없는 문화시설도 먼저 수집한다.
    // 그 뒤 공식·공공기관 프로그램 근거로 우선순위를 정한다.
    queries: ["박물관", "과학관", "미술관", "전시관", "비엔날레 전시", "어린이박물관", "어린이 과학관", "어린이 체험관", "유아 체험관"],
    include: ["박물관", "체험", "과학관", "미술관", "전시관", "문화관", "기념관", "비엔날레"],
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
    // 실내동물원·유아숲체험원 모두 놓치지 않도록 두 종류를 앞쪽에 둔다.
    // 브랜드명만 있는 실내동물원은 업종(동물원·동물카페)을 함께 검증한다.
    queries: ["실내동물원", "동물카페", "고양이카페", "동물 체험", "동물원", "유아숲체험원", "아쿠아리움", "생태공원", "수목원", "목장 체험", "곤충 체험"],
    include: ["동물", "실내동물", "동물카페", "목장", "농장", "곤충", "아쿠아리움", "수족관", "승마", "수목원", "생태", "유아숲", "휴양림", "숲", "정원", "식물원"]
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
    queries: ["어린이 물놀이장", "계곡 물놀이", "어린이 야외수영장", "워터파크"],
    include: ["물놀이", "계곡", "워터", "분수", "눈썰매", "스케이트", "빙상"]
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

function requireCultureData() {
  if (!CULTURE_DATA_SERVICE_KEY) {
    throw new Error("Vercel 환경변수 CULTURE_DATA_SERVICE_KEY가 없습니다.");
  }
}

// data.go.kr은 URL 인코딩된 키와 원문 키가 모두 복사될 수 있다. 어느 쪽이
// 들어와도 한 번만 인코딩해 요청하도록 원문으로 정규화한다.
function cultureServiceKey() {
  const value = String(CULTURE_DATA_SERVICE_KEY || "").trim();
  try { return decodeURIComponent(value); } catch { return value; }
}

function decodeXml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim();
}

function xmlField(block, names) {
  for (const name of names) {
    const match = String(block || "").match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    if (match) return decodeXml(match[1]);
  }
  return "";
}

function xmlRecords(xml) {
  const records = [];
  const pattern = /<(?:db|item)(?:\s[^>]*)?>([\s\S]*?)<\/(?:db|item)>/gi;
  let match;
  while ((match = pattern.exec(String(xml || "")))) records.push(match[1]);
  return records;
}

function dataRecords(data) {
  if (Array.isArray(data)) return data;
  const candidates = [data?.response?.body?.items?.item, data?.body?.items?.item, data?.items?.item, data?.db, data?.item];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return [value];
  }
  return [];
}

async function culture(path, params = {}) {
  requireCultureData();
  // 문화포털 API는 JSON 형식 파라미터를 받지 않고 XML을 기본으로 반환한다.
  // format=json을 함께 보내면 400이 나와 문화 프로그램 검증 자체가 건너뛰어졌다.
  const search = new URLSearchParams({ ...params, serviceKey: cultureServiceKey() });
  const response = await fetch(`${CULTURE_BASE}${path}?${search}`);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok) {
    const detail = String(text).replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`문화정보 API ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  if (/SERVICE_ACCESS_DENIED|SERVICE_KEY_IS_NOT_REGISTERED|NO_OPENAPI_SERVICE/i.test(text)) {
    throw new Error("문화정보 API 사용 승인이 필요합니다.");
  }
  return data || text;
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

// 네이버 검색 API의 웹문서 결과만 사용한다. 지도 방문자 리뷰 화면이나 비공개
// 엔드포인트를 긁지 않는다. 이 결과는 "공식/공공기관에 유아·어린이 프로그램이
// 확인되는가"를 판별하는 보조 근거일 뿐, 후기 수나 평점으로 사용하지 않는다.
async function webSearch(query) {
  const normalizedQuery = String(query || "").trim().replace(/\s+/g, " ");
  if (!normalizedQuery) return [];
  return cached(`naver:web:${normalizedQuery}`, CACHE_TTL.officialProgramSearch, async () => {
    const data = await naver("/search/v1/webkr", { query: normalizedQuery, display: "10", sort: "sim" });
    return (data.items || []).map(item => ({
      title: stripHtml(item.title),
      description: stripHtml(item.description),
      link: String(item.link || "")
    })).filter(item => item.link && (item.title || item.description));
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
  // "서울 등촌역"처럼 광역 도시와 지하철역이 함께 입력되면, 서울보다
  // 등촌역을 먼저 써야 주변 후보를 찾을 수 있다.
  const landmark = words.find(word => /(?:역|공항|터미널|휴게소|IC)$/i.test(word));
  const removeAdministrativeSuffix = value => String(value || "").replace(/(특별자치시|특별시|광역시|시|도|군|구|읍|면|동)$/g, "");
  const firstArea = removeAdministrativeSuffix(words[0]);
  const lastArea = removeAdministrativeSuffix(administrative.at(-1));
  const firstIsProvinceOrCombined = /^(전남|전북|전남광주통합|전북특별|강원|충남|충북|경남|경북|경기|제주|세종)/.test(firstArea);
  const primary = roadPrefix || (firstIsProvinceOrCombined ? lastArea : firstArea) || lastArea;
  return uniqueStrings([landmark, primary, [firstArea, lastArea].filter(Boolean).join(" "), lastArea]).slice(0, 3);
}

function themedQueries(definition, originLabel, suppliedHints = [], preview = false, adjacentAreaHints = []) {
  const hints = uniqueStrings([...(suppliedHints || []), ...areaHints(originLabel)]);
  if (definition === THEME.experience) {
    // 이름에 "어린이"가 없는 국립·공립 문화시설을 놓치지 않되, 출발지와
    // 무관한 전국 결과가 섞이지 않도록 입력 위치와 행정구역을 함께 쓴다.
    const culturalKinds = ["박물관", "과학관", "미술관", "전시관"];
    const familyKinds = ["어린이박물관", "어린이 과학관"];
    if (!hints.length) return [...culturalKinds, ...familyKinds].slice(0, preview ? 6 : 8);
    const contextual = hints.slice(0, 2).flatMap((hint, index) => [
      ...culturalKinds,
      ...(index === 0 ? familyKinds : [])
    ].map(kind => `${hint} ${kind}`));
    return uniqueStrings(contextual).slice(0, preview ? 6 : 10);
  }
  // 동물·자연체험은 실내동물원과 유아숲체험원을 함께 찾아야 하므로
  // 후순위 검색어를 더 실행한다. 결과는 캐시되어 같은 조건 반복 비용은 없다.
  const queryLimit = preview ? 4 : (definition === THEME.animals ? 10 : 6);
  if (!hints.length) return definition.queries.slice(0, queryLimit);
  if (definition === THEME.animals) {
    // 네이버 지역검색은 지도 앱의 "현재 지도에서 검색"처럼 좌표 반경을 받지
    // 않는다. 역명만 쓰면 인근 고양이카페가 상위 다섯 결과에서 빠질 수 있어,
    // 역명과 역이 속한 구·동을 함께 검색한다. 서울 같은 광역 단위는 보조 힌트로
    // 쓰지 않는다.
    const broadArea = /^(서울|부산|대구|인천|광주|대전|울산|세종|제주|대한민국)$/;
    const localHints = hints.filter(hint => !broadArea.test(String(hint))).slice(0, 2);
    const primaryHint = localHints[0] || hints[0];
    const primaryQueries = definition.queries.slice(0, queryLimit).map(query => `${primaryHint} ${query}`);
    const metroHint = hints.find(hint => broadArea.test(String(hint)));
    const metroIndoorQueries = metroHint
      ? ["실내동물원", "동물카페", "고양이카페"].map(query => `${metroHint} ${query}`)
      : [];
    // 역·구 경계 바로 바깥의 고양이카페도 놓치지 않는다. 인접 구 이름은 출발
    // 좌표 주위에서만 얻고, 실제 장소 후보는 계속 네이버 지역검색으로 수집한다.
    const adjacentCatQueries = uniqueStrings(adjacentAreaHints)
      .filter(hint => !broadArea.test(String(hint)))
      .slice(0, 4)
      .map(hint => `${hint} 고양이카페`);
    if (localHints.length < 2) return uniqueStrings([...primaryQueries, ...adjacentCatQueries, ...metroIndoorQueries]);
    // 실내 동물 체험은 두 권역에서 한 번 더 확인한다. 자연·숲 검색어 전체를
    // 중복 호출하지 않아 비용과 응답시간은 제한한다.
    const nearbyIndoorQueries = ["실내동물원", "동물카페", "고양이카페", "동물 체험"];
    return uniqueStrings([
      ...primaryQueries,
      ...nearbyIndoorQueries.map(query => `${localHints[1]} ${query}`),
      ...adjacentCatQueries,
      ...metroIndoorQueries
    ]);
  }
  // 테마별 후순위 검색어도 실제로 실행한다. 예전에는 앞의 세 개만 검색해
  // 유아숲체험원·농장체험처럼 뒤에 있던 세부 장소가 후보 수집에서 빠졌다.
  return uniqueStrings(definition.queries.slice(0, queryLimit).map(query => `${hints[0]} ${query}`));
}

const originAreaCache = new Map();

function areaNameFromReverseResponse(data) {
  const address = data?.address || {};
  // 서울처럼 city가 넓은 경우는 구 단위가 후보 수집에 훨씬 정확하다.
  return address.city_district || address.borough || address.county || address.city || address.state_district || address.province || "";
}

async function reverseAreaLabel(lat, lon) {
  const cacheKey = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
  if (originAreaCache.has(cacheKey)) return originAreaCache.get(cacheKey);
  const value = cached(`origin-area:${cacheKey}`, CACHE_TTL.area, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=ko&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`, {
        headers: { "User-Agent": "littletrip/1.0" },
        signal: controller.signal
      });
      const data = response.ok ? await response.json() : {};
      return areaNameFromReverseResponse(data);
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

async function originAreaLabel(origin) {
  return reverseAreaLabel(origin.y, origin.x);
}

async function adjacentOriginAreas(origin) {
  // 네이버 지역검색은 지도처럼 반경을 받지 않는다. 약 3km 동서·남북 대각 지점을
  // 역지오코딩해 경계 인접 구 이름만 보완 검색어로 사용한다. 결과는 7일 캐시된다.
  const lat = Number(origin.y);
  const lon = Number(origin.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const offsets = [[0.035, -0.028], [0.035, 0.028], [-0.035, -0.028], [-0.035, 0.028]];
  const labels = await Promise.all(offsets.map(([dx, dy]) => reverseAreaLabel(lat + dy, lon + dx)));
  return uniqueStrings(labels);
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

// '국립어린이과학관 자전거대여소', 'OO어린이과학관점'처럼 실제 시설의
// 이름을 빌린 부속 매장·대여소가 지역검색에 함께 나온다. 이름만으로는 구분할 수
// 없으므로 네이버 업종과 장소명 끝부분을 함께 검사한다.
const NON_VENUE_CATEGORY = /쇼핑,?유통|판매|판촉|기념품|임대,?대여|자전거|자동차|렌터카|주차장|매표소|안내소|편의점|약국|병원|사진관|인쇄/;
const NON_VENUE_NAME = /(?:점|매장|샵|스토어|기념품(?:점|샵)?|자전거대여소|대여소|렌탈|주차장|매표소|안내소)$/;
const CULTURAL_CATEGORY = /여행,?명소|관광,?명소|문화,?예술|공연,?전시|박물관|미술관|과학관|도서관|기념관|문화관|전시관|아트센터|갤러리|비엔날레|관람,?체험/;
const CULTURAL_VENUE_NAME = /(?:박물관|미술관|과학관|도서관|기념관|문화관|전시관|체험관|아트센터|갤러리|비엔날레)$/;

function isCulturalVenue(doc) {
  const name = String(doc.place_name || doc.name || "").replace(/\s+/g, " ").trim();
  const category = String(doc.category_name || doc.category || "");
  if (!name || NON_VENUE_CATEGORY.test(category) || NON_VENUE_NAME.test(name)) return false;
  // 공공 문화 API에서 현재 프로그램이 확인된 장소는 예외적으로 허용한다.
  if (doc.cultural_program_evidence) return true;
  return CULTURAL_VENUE_NAME.test(name) && CULTURAL_CATEGORY.test(category);
}

// 공식 사이트의 프로그램 안내에서 아이 대상 여부를 확인할 때는 어린이만 보지
// 않는다. 유아·영유아·아동·키즈·미취학·초등·가족, 그리고 연령 표기를 함께
// 인정한다. 단, 체험/교육/전시 등 활동 단서도 동시에 있어야 한다.
const FAMILY_AUDIENCE_RE = /어린이|유아|영유아|아동|키즈|미취학|초등|가족/;
const AGE_AUDIENCE_RE = /(?:만\s*)?\d{1,2}\s*(?:개월|세)|\d{1,2}\s*[~∼-]\s*\d{1,2}\s*세/;
const FAMILY_ACTIVITY_RE = /체험|교육|프로그램|전시|놀이|관람|예약|교실|워크숍/;
const UNTRUSTED_SOURCE_HOST = /(^|\.)(?:naver\.com|naver\.net|kakao\.com|instagram\.com|facebook\.com|youtube\.com|tistory\.com|blog\.me|blog\.naver\.com)$/;

function sourceHost(value) {
  try { return new URL(String(value || "")).hostname.toLowerCase().replace(/^(?:www|m)\./, ""); }
  catch { return ""; }
}

function sameSourceHost(left, right) {
  return !!left && !!right && (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`));
}

function isPublicCulturalSource(host) {
  return host.endsWith(".go.kr") || host === "culture.go.kr" || host.endsWith(".culture.go.kr");
}

function evidenceMentionsVenue(text, doc) {
  const venue = compactName(doc.place_name || doc.name);
  const source = compactName(text);
  return venue.length >= 4 && source.includes(venue);
}

function officialProgramEvidenceItem(item, doc) {
  const text = `${item.title || ""} ${item.description || ""}`.replace(/\s+/g, " ").trim();
  if (!evidenceMentionsVenue(text, doc)) return null;
  if (!(FAMILY_AUDIENCE_RE.test(text) || AGE_AUDIENCE_RE.test(text)) || !FAMILY_ACTIVITY_RE.test(text)) return null;
  const host = sourceHost(item.link);
  const placeHost = sourceHost(doc.place_url);
  if (!host || UNTRUSTED_SOURCE_HOST.test(host)) return null;
  if (sameSourceHost(host, placeHost)) return { score: 80, source: host };
  if (isPublicCulturalSource(host)) return { score: 60, source: host };
  return null;
}

async function officialChildProgramEvidence(doc) {
  if (!isCulturalVenue(doc)) return null;
  const name = String(doc.place_name || doc.name || "").trim();
  if (!name) return null;
  // 첫 검색은 공식 기관의 프로그램·교육 페이지를 넓게 찾고, 유아 전용 문구만
  // 있는 곳은 두 번째 검색으로 보완한다. 두 번째 호출은 첫 결과가 부족할 때만 한다.
  const first = await webSearch(`${name} 어린이 체험 프로그램`).catch(error => {
    console.warn("[official program search failed]", name, error.message || String(error));
    return [];
  });
  let evidence = first.map(item => officialProgramEvidenceItem(item, doc)).filter(Boolean).sort((a, b) => b.score - a.score)[0] || null;
  if (!evidence) {
    const second = await webSearch(`${name} 유아 체험 프로그램`).catch(error => {
      console.warn("[official infant program search failed]", name, error.message || String(error));
      return [];
    });
    evidence = second.map(item => officialProgramEvidenceItem(item, doc)).filter(Boolean).sort((a, b) => b.score - a.score)[0] || null;
  }
  return evidence;
}

async function attachOfficialProgramEvidence(docs, limit = 12) {
  const checked = await Promise.all(docs.map(async (doc, index) => {
    if (index >= limit) return doc;
    const evidence = await officialChildProgramEvidence(doc);
    return evidence ? {
      ...doc,
      official_child_program_evidence: true,
      official_child_program_score: evidence.score,
      official_child_program_source: evidence.source
    } : doc;
  }));
  return checked;
}

// 과학관은 시설 자체가 목적지라 프로그램 제목을 붙이지 않는다. 반면 전시 일정에
// 따라 방문 판단이 달라지는 미술관·전시관·갤러리·비엔날레만 검증된 제목을 함께 보인다.
function displayNameForPlace(doc) {
  const name = String(doc.place_name || doc.name || "").trim();
  const programs = Array.isArray(doc.cultural_programs) ? doc.cultural_programs.filter(Boolean) : [];
  const programLedVenue = /미술관|전시관|갤러리|아트센터|비엔날레/.test(name);
  return programLedVenue && doc.cultural_program_evidence && programs.length
    ? `${name} — ${programs[0]}`
    : name;
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

function recordField(record, names) {
  if (typeof record === "string") return xmlField(record, names);
  const source = record || {};
  for (const name of names) {
    const key = Object.keys(source).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    if (key && source[key] !== undefined && source[key] !== null) return decodeXml(source[key]);
  }
  return "";
}

function cultureDate(value) {
  return String(value || "").replace(/[^0-9]/g, "").slice(0, 8);
}

function todayCultureDate() {
  const now = new Date();
  // API의 기간 파라미터는 YYYYMMDD 형식이다. 서버의 UTC 날짜가 아니라
  // 한국에서 실제로 보고 있는 날짜를 기준으로 맞춘다.
  const local = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${local.getUTCFullYear()}${String(local.getUTCMonth() + 1).padStart(2, "0")}${String(local.getUTCDate()).padStart(2, "0")}`;
}

function currentCulturalProgram(record) {
  const title = recordField(record, ["title", "prfnm", "name"]);
  const place = recordField(record, ["place", "fcltynm", "facilityName", "placeName"]);
  const realm = recordField(record, ["realmName", "realmname", "realm", "genre", "type"]);
  const age = recordField(record, ["useTrgt", "use_trgt", "age", "target", "audience"]);
  const start = cultureDate(recordField(record, ["startDate", "startdate", "prfpdfrom", "start"]));
  const end = cultureDate(recordField(record, ["endDate", "enddate", "prfpdto", "end"]));
  const seq = recordField(record, ["seq", "id", "pblprfrSn"]);
  const detailUrl = recordField(record, ["url", "detailUrl", "link"]);
  return { title, place, realm, age, start, end, seq, detailUrl };
}

function childFriendlyCultureProgram(program) {
  const text = `${program.title} ${program.place} ${program.realm} ${program.age}`;
  const adultOnly = /성인\s*전용|19\s*세|청소년\s*관람불가|주류|와인|성인물/.test(text);
  if (adultOnly || !program.title || !program.place) return false;
  // 전시·교육·체험 중심으로만 가져온다. 연극·콘서트처럼 별도 관람상품은
  // 이 테마의 '박물관 · 전시탐험' 후보에 섞지 않는다.
  const suitableRealm = /전시|교육|체험|도서|박물관|미술|문화/.test(`${program.realm} ${program.title}`);
  const suitablePlace = /박물관|미술관|도서관|과학관|문화관|전시관|기념관|아트센터|갤러리|비엔날레|어린이/.test(program.place);
  return suitableRealm && suitablePlace;
}

function programPeriod(program) {
  if (!program.start && !program.end) return "";
  const format = value => value.length === 8 ? `${value.slice(4, 6)}.${value.slice(6, 8)}` : value;
  return program.start && program.end ? `${format(program.start)} ~ ${format(program.end)}` : format(program.start || program.end);
}

async function culturalProgramsNear(origin, maxMinutes) {
  if (!CULTURE_DATA_SERVICE_KEY) return [];
  const date = todayCultureDate();
  const range = maxMinutes <= 40 ? 0.55 : 1.05;
  const key = `culture:programs:${date}:${pointKey(origin, 2)}:${maxMinutes <= 40 ? 40 : 75}`;
  return cached(key, CACHE_TTL.culturalPrograms, async () => {
    try {
      const payload = await culture("/publicperformancedisplays/period", {
        from: date,
        to: date,
        cPage: "1",
        rows: "100",
        place: "",
        keyword: "",
        sortStdr: "1",
        gpsxfrom: String(Number(origin.x) - range),
        gpsyfrom: String(Number(origin.y) - range),
        gpsxto: String(Number(origin.x) + range),
        gpsyto: String(Number(origin.y) + range)
      });
      const records = typeof payload === "string" ? xmlRecords(payload) : dataRecords(payload);
      return records.map(currentCulturalProgram).filter(childFriendlyCultureProgram);
    } catch (error) {
      // 이 데이터는 전시 제목을 보강하는 선택 기능이다. 승인 지연·일시 오류가
      // 기본 문화시설 후보를 막거나 같은 실패 호출을 반복하게 해서는 안 된다.
      console.warn("[culture program search skipped]", error.message || String(error));
      return [];
    }
  });
}

function cultureVenueMatchScore(place, venueName) {
  const name = compactName(place.place_name || place.name);
  const needle = compactName(venueName);
  if (!name || !needle) return -999;
  // 행사 장소가 '국립어린이과학관'일 때 '국립어린이과학관자전거대여소'가
  // 부분일치만으로 이기는 일을 막는다.
  if (!isCulturalVenue(place)) return -999;
  const exact = name === needle ? 120 : 0;
  const contained = name.includes(needle) || needle.includes(name) ? 70 : 0;
  const cultureType = /박물관|미술관|도서관|과학관|문화관|전시관|기념관|아트센터|갤러리/.test(name) ? 18 : 0;
  return exact + contained + cultureType;
}

function culturalFacilityDoc(record) {
  const place_name = recordField(record, ["title", "name", "fcltynm", "facilityName"]);
  const address_name = recordField(record, ["addr", "address", "roadAddr", "roadAddress"]);
  const category_name = recordField(record, ["type", "category", "fcltyType", "facilityType"]) || "문화시설";
  const x = Number(recordField(record, ["gpsx", "x", "longitude", "mapx"]));
  const y = Number(recordField(record, ["gpsy", "y", "latitude", "mapy"]));
  return { id: `culture:${place_name}:${x}:${y}`, place_name, address_name, road_address_name: address_name, category_name, x, y };
}

// 시설 API는 전시 제목을 주지 않으므로 후보 생성에는 단독으로 쓰지 않는다.
// 문화정보 API가 알려 준 '행사 장소'를 네이버가 찾지 못할 때만 박물관·미술관·도서관
// 시설 목록에서 좌표·주소를 보강하는 안전망으로 사용한다.
async function culturalFacilityFallback(venueName) {
  if (!CULTURE_DATA_SERVICE_KEY) return null;
  const entries = await cached("culture:spaces:all", CACHE_TTL.culturalSpaces, async () => {
    const paths = ["/cultureartspaces/museum", "/cultureartspaces/library", "/cultureartspaces/hall"];
    const groups = await Promise.all(paths.map(path => culture(path, { cPage: "1", rows: "200" }).catch(error => {
      console.warn("[culture facility lookup failed]", path, error.message || String(error));
      return [];
    })));
    return groups.flatMap(payload => {
      const records = typeof payload === "string" ? xmlRecords(payload) : dataRecords(payload);
      return records.map(culturalFacilityDoc).filter(doc => doc.place_name && Number.isFinite(doc.x) && Number.isFinite(doc.y));
    });
  });
  return entries
    .map(doc => ({ doc, score: cultureVenueMatchScore(doc, venueName) }))
    .filter(entry => entry.score >= 70)
    .sort((a, b) => b.score - a.score)[0]?.doc || null;
}

async function resolveCulturalVenue(venueName, originLabel) {
  const hint = areaHints(originLabel)[0] || "";
  const primaryQuery = `${hint} ${venueName}`.trim();
  let results = await localSearch(primaryQuery).catch(error => {
    console.warn("[culture venue resolve failed]", primaryQuery, error.message || String(error));
    return [];
  });
  let best = results
    .map(doc => ({ doc, score: cultureVenueMatchScore(doc, venueName) }))
    .filter(entry => entry.score >= 70)
    .sort((a, b) => b.score - a.score)[0]?.doc;
  if (!best && primaryQuery !== venueName) {
    results = await localSearch(venueName).catch(() => []);
    best = results
      .map(doc => ({ doc, score: cultureVenueMatchScore(doc, venueName) }))
      .filter(entry => entry.score >= 70)
      .sort((a, b) => b.score - a.score)[0]?.doc;
  }
  return best || culturalFacilityFallback(venueName);
}

async function culturalProgramPlaces(origin, maxMinutes, originLabel = "") {
  let programs;
  try {
    programs = await culturalProgramsNear(origin, maxMinutes);
  } catch (error) {
    console.warn("[culture program search failed]", error.message || String(error));
    return [];
  }
  const grouped = new Map();
  for (const program of programs) {
    const key = compactName(program.place);
    if (!key) continue;
    const list = grouped.get(key) || [];
    if (!list.some(item => item.title === program.title)) list.push(program);
    grouped.set(key, list);
  }
  const groups = [...grouped.values()]
    .sort((a, b) => b.length - a.length || a[0].place.localeCompare(b[0].place, "ko"))
    .slice(0, 16);
  const resolved = await Promise.all(groups.map(async list => {
    const venue = await resolveCulturalVenue(list[0].place, originLabel);
    if (!venue) return null;
    const titles = uniqueStrings(list.map(item => item.title)).slice(0, 3);
    const periods = uniqueStrings(list.map(programPeriod)).filter(Boolean).slice(0, 2);
    return {
      ...venue,
      distance: Math.round(haversine(origin, venue) * 1000),
      hits: 8 + titles.length,
      cultural_programs: titles,
      cultural_program_periods: periods,
      cultural_program_count: list.length,
      cultural_program_evidence: true
    };
  }));
  return resolved.filter(Boolean);
}

function suitable(doc, definition, query = "") {
  const name = String(doc.place_name || "");
  const category = String(doc.category_name || "");
  const text = `${name} ${category} ${doc.description || ""}`;

  // 검색어에 '체험'이 들어갔다고 결과 장소까지 체험 장소인 것은 아니다.
  // 음식점·카페 같은 업종은 어떤 만들기 검색어에서 나왔더라도 후보가 될 수 없다.
  // 단, 동물 테마의 검증된 동물카페·고양이카페는 아래 전용 판정으로 통과시킨다.
  const foodOrStay = /음식점|카페,?디저트|술집|주점|모텔|호텔|부동산|교회/.test(category);
  if (foodOrStay && definition !== THEME.animals) return false;
  if (definition.exclude?.some(word => text.includes(word))) return false;

  if (definition === THEME.craft) return isChildCraftVenue(doc);
  if (definition === THEME.animals) return isNatureOrAnimalVenue(doc);
  if (definition === THEME.season) return isSeasonPlayVenue(doc);

  // 문화·전시는 문화시설 본체만 후보가 될 수 있다. "어린이과학관점" 같은
  // 판매점·기념품점과 자전거대여소는 이름에 과학관이 있어도 여기서 탈락한다.
  if (definition === THEME.experience && !isCulturalVenue(doc)) return false;

  if (!definition.include.some(word => text.includes(word))) return false;
  // '연구소'라는 이유만으로 제외하지는 않는다. 다만 어린이 활동 근거가 없는
  // 일반 연구기관은 전시탐험 후보에서 빼고, 블로그 검색으로 근거가 확인되면 통과시킨다.
  if (definition.childFocused && isResearchVenue(doc) && !hasDirectChildActivity(doc) && !doc.child_evidence) return false;
  if (/학원/.test(category)) return false;
  return true;
}

// '요리교육'이라는 업종명만으로는 아이와 할 수 있는 체험이라고 판단할 수 없다.
// 학원·교습시설은 반드시 어린이/유아/키즈/가족 대상 근거가 있어야 한다.
function isChildCraftVenue(doc) {
  const name = String(doc.place_name || "");
  const category = String(doc.category_name || "");
  const text = `${name} ${category} ${doc.description || ""}`;
  const childAudience = /어린이|유아|키즈|아동|영유아|주니어|초등|가족/.test(text);
  const handsOn = /공방|도예|도자기|베이킹|쿠킹|만들기|공예|피자\s*체험|농장\s*체험|수확\s*체험|요리\s*(?:체험|교육|교실|수업|클래스)|미술\s*(?:체험|교육|교실|수업|클래스)/.test(text);
  const verifiedVenue = /체험농장|생태나라|치즈마을|체험마을|테마파크|농장|농원|목장|공방|도예원|베이킹스튜디오|쿠킹스튜디오/.test(`${name} ${category}`);
  const educationVenue = /학원|교습시설|교육원|교육센터|요리교육|미술교육/.test(category);
  if (!handsOn) return false;
  if (educationVenue) return childAudience;
  return childAudience || verifiedVenue || !!doc.content_evidence;
}

// 동물·자연체험 검색어에는 공원 화장실, 반려동물용품점, 이름만 수목원인
// 사무실도 함께 섞인다. 이름 단서만 보지 않고 실제 방문 가능한 업종까지 확인한다.
function isNatureOrAnimalVenue(doc) {
  const name = String(doc.place_name || "");
  const category = String(doc.category_name || "");
  const text = `${name} ${category} ${doc.description || ""}`;
  const nonVenue = /화장실|장애인편의|부속시설|경영컨설팅|전문,?기술서비스|반려동물용품|판매|매장|사무실|대여|렌탈/.test(text);
  if (nonVenue) return false;
  const verifiedAnimalDestination = /동물카페|고양이카페|캣카페|동물원|실내동물원|아쿠아리움|수족관|목장|농장/.test(category);
  // '고양이베이글'처럼 단어만 고양이인 일반 베이커리는 제외한다. 업종이
  // 고양이카페이거나, 상호 자체에 고양이(캣)+카페가 함께 있어야 한다.
  const namedCatCafe = /(?:고양이|냥이|캣|cat).*?(?:카페|cafe)|(?:카페|cafe).*?(?:고양이|냥이|캣|cat)/i.test(name)
    && /카페|커피/.test(category);
  const destinationCategory = /여행,?명소|관광,?명소|도시,?테마공원|관람,?체험|동물카페|동물원|아쿠아리움|수족관|식물원|수목원|목장|농장|휴양림/.test(category);
  const destinationName = /동물|목장|농장|곤충|아쿠아리움|수족관|수목원|생태공원|유아숲|휴양림|식물원|정원/.test(name);
  // '테이블에이'처럼 상호에는 동물 단어가 없더라도, 네이버 업종이 실제
  // 동물원·동물카페·아쿠아리움이면 방문 가능한 동물 체험 장소로 인정한다.
  return verifiedAnimalDestination || namedCatCafe || (destinationCategory && destinationName);
}

function directFamilyVenueScore(doc, key) {
  const text = `${doc.place_name || ""} ${doc.category_name || ""} ${doc.description || ""}`;
  if (key === "animals") {
    if (/어린이|유아|키즈|유아숲|체험원/.test(text)) return 12;
    if (/실내동물원|동물원|동물카페|고양이|냥이|캣|cat|아쿠아리움|수족관/.test(text)) return 9;
  }
  if (key === "craft" && /어린이|유아|키즈|가족/.test(text)) return 8;
  if (key === "experience" && /어린이|유아|영유아|아동|키즈|가족/.test(text)) return 4;
  return 0;
}

// 여름 '물놀이'는 운동 목적의 일반 수영장과 구분한다.
// 아이 물놀이 시설을 뜻하는 단서가 없거나, 휘트니스·강습 시설이면 제외한다.
function isSeasonPlayVenue(doc, month = new Date().getMonth() + 1) {
  const text = `${doc.place_name || ""} ${doc.category_name || ""} ${doc.description || ""}`;
  if (month >= 6 && month <= 9) {
    const ordinaryPool = /휘트니스|피트니스|헬스|스포츠센터|수영강습|수영교실|실내수영장|사우나|호텔/.test(text);
    const waterPlay = /어린이|유아|키즈|물놀이|워터파크|분수|계곡|야외수영장|물놀이터|수변놀이터/.test(text);
    return !ordinaryPool && waterPlay;
  }
  if (month === 12 || month <= 2) return /어린이|유아|키즈|눈썰매|눈놀이|빙상|스케이트/.test(text);
  return /어린이|유아|키즈|계절\s*체험|야외\s*나들이|가족\s*생태/.test(text);
}

function seasonQueries(visitDate) {
  const month = Number(String(visitDate || "").slice(5, 7)) || new Date().getMonth() + 1;
  if (month >= 6 && month <= 9) return ["어린이 물놀이장", "계곡 물놀이", "어린이 야외수영장", "분수 물놀이장", "워터파크"];
  if (month === 12 || month <= 2) return ["어린이 눈썰매장", "빙상장", "스케이트장", "눈놀이장"];
  return ["어린이 계절 체험", "어린이 야외 나들이", "가족 생태 체험"];
}

async function searchTheme(key, origin, maxMinutes, originLabel = "", options = {}) {
  const baseDefinition = THEME[key];
  if (!baseDefinition) return [];
  const definition = key === "season" ? { ...baseDefinition, queries: seasonQueries(options.visitDate) } : baseDefinition;
  const [queryResults, contentDocs, culturalDocs] = await Promise.all([
    Promise.all(themedQueries(definition, originLabel, options.searchHints, !!options.preview, options.adjacentAreaHints).map(async query => ({
      query,
      docs: await localSearch(query).catch(error => {
        console.warn("[naver local failed]", key, query, error.message || String(error));
        return [];
      })
    }))),
    definition.contentQuery ? contentMatchedPlaces(`${areaHints(originLabel)[0] || ""} ${definition.contentQuery}`.trim()).catch(error => {
      console.warn("[naver content search failed]", key, error.message || String(error));
      return [];
    }) : Promise.resolve([]),
    // 문화시설은 단독 추천하지 않는다. 현재 진행하는 전시·교육·체험이 확인된
    // 장소만 이 목록으로 합쳐, "장소명 — 프로그램 제목"을 보여 준다.
    key === "experience" ? culturalProgramPlaces(origin, maxMinutes, originLabel) : Promise.resolve([])
  ]);
  if (contentDocs.length) queryResults.push({ query: definition.contentQuery, docs: contentDocs });
  if (culturalDocs.length) queryResults.push({ query: "진행 중 문화 프로그램", docs: culturalDocs });
  const byId = new Map();
  for (const { query, docs } of queryResults) {
    for (const doc of docs) {
      if (!doc.id || !suitable(doc, definition, query)) continue;
      if (!byId.has(doc.id)) byId.set(doc.id, { ...doc, distance: Math.round(haversine(origin, doc) * 1000), hits: 0 });
      const candidate = byId.get(doc.id);
      candidate.content_evidence ||= !!doc.content_evidence;
      candidate.cultural_program_evidence ||= !!doc.cultural_program_evidence;
      candidate.cultural_programs = uniqueStrings([...(candidate.cultural_programs || []), ...(doc.cultural_programs || [])]).slice(0, 3);
      candidate.cultural_program_periods = uniqueStrings([...(candidate.cultural_program_periods || []), ...(doc.cultural_program_periods || [])]).slice(0, 2);
      candidate.cultural_program_count = Math.max(candidate.cultural_program_count || 0, doc.cultural_program_count || 0);
      candidate.hits += doc.cultural_program_evidence ? Math.max(4, (doc.cultural_programs || []).length * 2) : (doc.content_evidence ? 2 : 1);
    }
  }
  const roughKm = maxMinutes <= 40 ? 45 : 90;
  const candidates = uniqueVenues([...byId.values()])
    .filter(doc => haversine(origin, { x: +doc.x, y: +doc.y }) <= roughKm)
    .sort((a, b) => (venueScore(b) - venueScore(a)) || ((+a.distance || 9999999) - (+b.distance || 9999999)))
    .slice(0, options.preview ? 12 : 24);
  const routed = await routes(origin, candidates, options.preview ? 12 : 24);
  const reachable = routed.filter(doc => doc.route_minutes <= maxMinutes);
  // 문화시설을 수집한 다음에만 공식/공공기관 프로그램 근거를 확인한다.
  // 근거가 있는 곳은 우선하되, 프로그램 정보가 없는 과학관·박물관을 제거하지는 않는다.
  const enriched = key === "experience"
    ? await attachOfficialProgramEvidence(reachable, options.preview ? 6 : 12)
    : reachable;
  const candidateLimit = options.candidateLimit || (options.preview ? 6 : 12);
  const excludedIds = new Set((options.excludeIds || []).map(String));
  const items = enriched
    .map(doc => normalized(doc, {
      route_minutes: doc.route_minutes,
      route_distance: doc.route_distance,
      route_estimated: !!doc.route_estimated,
      display_name: displayNameForPlace(doc),
      // 기존 검색어 중복 횟수보다 확인된 공식 프로그램 근거를 우선한다.
      family_evidence: (doc.hits || 1) + directFamilyVenueScore(doc, key) + (doc.official_child_program_score || 0),
      official_child_program_evidence: !!doc.official_child_program_evidence,
      official_child_program_source: doc.official_child_program_source || "",
      cultural_programs: doc.cultural_programs || [],
      cultural_program_periods: doc.cultural_program_periods || [],
      cultural_program_count: doc.cultural_program_count || 0,
      cultural_program_evidence: !!doc.cultural_program_evidence
    }))
    // 이동시간은 통과 여부만 판단한다. 최종 순서는 테마 검색 근거와 이동시간으로 정한다.
    .sort((a, b) => (b.family_evidence - a.family_evidence) || (a.route_minutes - b.route_minutes))
    .filter(item => !excludedIds.has(String(item.id)))
    .slice(0, candidateLimit);
  console.log("[theme search]", JSON.stringify({
    theme: key,
    candidates: candidates.length,
    reachable: reachable.length,
    officialPrograms: enriched.filter(doc => doc.official_child_program_evidence).length,
    items: items.length
  }));
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

const FOOD_OR_CAFE_CATEGORY = /음식점|카페|커피|제과|디저트|베이커리|주점|술집|호프|한식|중식|일식|양식|분식|치킨|피자|패스트푸드|뷔페/;
const SUB_CONTENT_WORDS = /놀이터|어린이공원|공원|도서관|박물관|과학관|미술관|전시|체험|공방|문화관|기념관|궁궐|고궁|성곽|동물|수족관|아쿠아리움|식물원|수목원|정원|숲|휴양림|모터스튜디오/;

function nearbyText(doc) {
  return `${doc.place_name || ""} ${doc.category_name || ""} ${doc.description || ""}`;
}

function isSuitableNearby(doc, type) {
  const category = String(doc.category_name || "");
  const text = nearbyText(doc);
  if (type === "sub") {
    // '체험관' 검색에서 음식점이 함께 잡히는 경우가 있어 업종을 먼저 확실히 뺀다.
    return !FOOD_OR_CAFE_CATEGORY.test(category) && SUB_CONTENT_WORDS.test(text);
  }
  // 노키즈존이라고 명시된 경우만 제외한다. 아이 동반 시설 여부는 맛집·카페
  // 후보를 좁히는 기준으로 쓰지 않는다.
  if (/노\s*키즈\s*존|노키즈/.test(text)) return false;
  if (type === "food") return /음식점|한식|중식|일식|양식|분식|치킨|피자|패스트푸드|뷔페/.test(category);
  if (type === "cafe") return /카페|커피|제과|디저트|베이커리/.test(category);
  return false;
}

function nearbySummary(doc, type) {
  const text = nearbyText(doc);
  if (type === "food") return "메인 일정 전후에 들르기 좋은 식사 후보";
  if (type === "cafe") return "잠깐 쉬거나 간식을 먹기 좋은 카페 후보";
  if (/놀이터|어린이공원|모래/.test(text)) return "아이와 잠깐 뛰어놀기 좋은 야외 코스";
  if (/도서관|그림책/.test(text)) return "조용히 쉬며 책을 볼 수 있는 코스";
  if (/공방|도예|만들기|체험/.test(text)) return "만들기·체험을 더할 수 있는 코스";
  if (/박물관|과학관|미술관|전시|모터스튜디오|문화관|기념관/.test(text)) return "메인 전후로 들르기 좋은 전시·문화 코스";
  if (/궁궐|고궁|성곽/.test(text)) return "메인 전후로 들르기 좋은 역사 산책 코스";
  if (/동물|수족관|아쿠아리움/.test(text)) return "동물을 보고 관찰할 수 있는 코스";
  if (/수목원|식물원|정원|숲|휴양림|공원/.test(text)) return "가볍게 걷고 쉬기 좋은 자연 코스";
  return "메인 일정 사이에 들르기 좋은 보조 코스";
}

async function searchNearby(origin, type, originLabel = "") {
  // 식당·카페는 아이 친화 시설을 찾는 것이 아니라, 메인 근처의 인기 있는
  // 식당·카페를 찾는다. localSearch()는 네이버 지역검색의 comment(리뷰순) 정렬을 쓴다.
  const terms = type === "food" ? ["맛집", "한식 맛집", "양식 맛집"]
    : type === "cafe" ? ["카페", "베이커리 카페"]
      : ["어린이 놀이터", "공원", "도서관", "체험관", "박물관"];
  const hint = areaHints(originLabel)[0];
  const queries = uniqueStrings(terms.map(term => hint ? `${hint} ${term}` : term));
  const groups = await Promise.all(queries.map(query => localSearch(query).catch(error => {
    console.warn("[naver nearby failed]", type, query, error.message || String(error));
    return [];
  })));
  // 여러 네이버 리뷰순 검색에서 반복 등장하고 각 검색에서 상위에 있던 장소를
  // 우선한다. 과거에는 여기서 거리순으로 다시 정렬해 '맛집' 순위가 사라졌다.
  const byVenue = new Map();
  for (const group of groups) {
    group.forEach((doc, index) => {
      const key = venueKey(doc);
      const score = Math.max(1, group.length - index);
      const previous = byVenue.get(key);
      if (!previous) {
        byVenue.set(key, { ...doc, nearby_popularity: score, nearby_best_rank: index });
        return;
      }
      previous.nearby_popularity += score;
      if (index < previous.nearby_best_rank) {
        Object.assign(previous, doc, {
          nearby_popularity: previous.nearby_popularity,
          nearby_best_rank: index
        });
      }
    });
  }
  const candidates = [...byVenue.values()]
    .filter(doc => isSuitableNearby(doc, type))
    .filter(doc => haversine(origin, doc) <= 25)
    .sort((a, b) => (b.nearby_popularity - a.nearby_popularity)
      || (a.nearby_best_rank - b.nearby_best_rank)
      || (haversine(origin, a) - haversine(origin, b)))
    .slice(0, 20);
  const routed = await routes(origin, candidates);
  return routed.map(doc => normalized(doc, {
    route_minutes: doc.route_minutes,
    route_distance: doc.route_distance,
    route_estimated: !!doc.route_estimated,
    nearby_summary: nearbySummary(doc, type),
    nearby_popularity: doc.nearby_popularity
  })).sort((a, b) => (b.nearby_popularity - a.nearby_popularity)
    || (a.route_minutes - b.route_minutes)).slice(0, 8);
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://local");
    const mode = req.query?.mode || url.searchParams.get("mode");
    const policy = req.method === "GET" ? cachePolicy(mode) : null;
    if (mode === "health") return send(res, 200, { ok: true, naver: !!(NAVER_ID && NAVER_SECRET), kakao: !!KAKAO, culture: !!CULTURE_DATA_SERVICE_KEY });
    if (mode === "geocode") {
      const query = req.query?.q || url.searchParams.get("q") || "";
      return send(res, 200, { ok: true, origin: await geocode(query) }, policy);
    }

    const body = req.method === "GET" ? {} : await readBody(req);
    const value = key => body[key] ?? req.query?.[key] ?? url.searchParams.get(key) ?? "";
    const origin = { x: +value("x"), y: +value("y") };
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) throw new Error("출발지 좌표가 올바르지 않습니다.");
    const maxMinutes = Math.max(10, Math.min(120, +value("maxMinutes") || 40));
    const suppliedOriginLabel = String(value("originLabel") || "").trim();
    // "김포공항" 같은 사용자가 입력한 지점명과 역지오코딩한 "강서구"를 모두
    // 검색 힌트로 쓴다. 전자는 항공박물관처럼 지점 연관 시설을, 후자는 주변
    // 과학관·미술관 같은 행정구역 시설을 놓치지 않게 한다.
    const resolvedOriginLabel = await originAreaLabel(origin);
    const originLabel = suppliedOriginLabel || resolvedOriginLabel;
    const searchHints = uniqueStrings([
      ...areaHints(suppliedOriginLabel),
      ...areaHints(resolvedOriginLabel)
    ]);

    if (mode === "theme-preview") {
      const themes = await Promise.all(Object.keys(THEME).map(async key => ({
        key,
        title: THEME[key].title,
        description: THEME[key].description,
        items: await searchTheme(key, origin, maxMinutes, originLabel, { preview: true, visitDate: value("visitDate"), searchHints })
      })));
      return send(res, 200, { ok: true, transitEnabled: false, themes: uniquePreviewThemes(themes) }, policy);
    }
    if (mode === "theme") {
      const selectedThemes = uniqueStrings(String(value("themes") || value("theme") || "experience").split(","));
      const excludeIds = uniqueStrings(String(value("exclude") || "").split(",")).slice(0, 60);
      // 동물 테마만, 출발지와 맞닿은 구의 고양이카페를 추가로 네이버 지역검색한다.
      // 장소 수집에 카카오 지역검색을 쓰지 않으며, 카카오는 최종 차량시간에만 쓴다.
      const adjacentAreaHints = selectedThemes.includes("animals") ? await adjacentOriginAreas(origin) : [];
      return send(res, 200, {
        ok: true,
        transitEnabled: false,
        items: await searchThemes(selectedThemes, origin, maxMinutes, originLabel, { visitDate: value("visitDate"), excludeIds, searchHints, adjacentAreaHints })
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
module.exports.__test = { suitable, THEME, seasonQueries, themedQueries, areaHints, isResearchVenue, hasDirectChildActivity, isCulturalVenue, displayNameForPlace, isChildCraftVenue, isSeasonPlayVenue, compareCandidateQuality, isSuitableNearby, nearbySummary, dataRecords, currentCulturalProgram, childFriendlyCultureProgram, programPeriod, cultureVenueMatchScore, officialProgramEvidenceItem };
