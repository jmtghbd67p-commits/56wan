const KAKAO = process.env.KAKAO_REST_KEY;
const NAVER_ID = process.env.NAVER_API_KEY_ID;
const NAVER_SECRET = process.env.NAVER_API_KEY_SECRET;
const SIGUNGU_GRAPH = require("./sigungu-graph");
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
  culturalSpaces: 24 * 60 * 60 * 1000,
  // 문화센터 강좌는 접수·마감이 수시로 바뀌므로 짧게 보관한다. 지점 목록만 길게
  // 캐시하고, 선택 날짜의 강좌 목록은 최대 10분 뒤에 다시 공식 시간표를 확인한다.
  cultureCenterBranches: 24 * 60 * 60 * 1000,
  cultureCenterClasses: 10 * 60 * 1000
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
  },
  culture: {
    title: "문화센터",
    description: "백화점 · 마트 · 아울렛의 유아·어린이 강좌",
    // 일반 장소 검색으로는 수업 날짜를 확인할 수 없어서, 아래의 공식 시간표
    // 어댑터(searchCultureCenterTheme)만 사용한다.
    queries: [],
    include: [],
    childFocused: true
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

// data.go.kr은 인증키를 "Encoding" 값(%2F 등 포함)과 "Decoding" 값(원문)
// 두 형식으로 보여 준다. Vercel에 어느 형식이 들어가도 요청은 한 번만 URL
// 인코딩돼야 한다. 과거에는 한 형식만 가정해 승인된 키도 API에서 인식하지 못할
// 여지가 있었다. serviceKey= 접두어를 통째로 붙여넣은 경우도 함께 보정한다.
function cultureServiceKeyVariants() {
  let raw = String(CULTURE_DATA_SERVICE_KEY || "").trim();
  raw = raw.replace(/^serviceKey\s*=\s*/i, "").replace(/^['\"]|['\"]$/g, "").trim();
  if (!raw) return [];

  const variants = [raw];
  let decoded = raw;
  // 일반 인코딩·이중 인코딩 키까지 정규화 후보로 둔다. 실제 값은 URLSearchParams가
  // 한 번만 인코딩하므로, 이 중 API가 받아들이는 형식으로 자동 요청된다.
  for (let step = 0; step < 2; step += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      variants.push(next);
      decoded = next;
    } catch {
      break;
    }
  }
  return uniqueStrings(variants);
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
  const keyVariants = cultureServiceKeyVariants();
  let lastFailure = null;
  for (const serviceKey of keyVariants) {
    const search = new URLSearchParams({ ...params, serviceKey });
    const response = await fetch(`${CULTURE_BASE}${path}?${search}`);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    const apiRejected = /SERVICE_ACCESS_DENIED|SERVICE_KEY_IS_NOT_REGISTERED|NO_OPENAPI_SERVICE/i.test(text);
    if (response.ok && !apiRejected) return data || text;

    const detail = String(text).replace(/\s+/g, " ").slice(0, 180);
    lastFailure = new Error(`문화정보 API ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  throw lastFailure || new Error("문화정보 API 인증키 형식을 확인하지 못했습니다.");
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

function kakaoPlace(item) {
  return {
    id: `kakao:${item.id || `${item.x}:${item.y}:${item.place_name}`}`,
    place_name: String(item.place_name || "").trim(),
    category_name: String(item.category_name || "").trim(),
    description: String(item.category_group_name || "").trim(),
    address_name: String(item.address_name || "").trim(),
    road_address_name: String(item.road_address_name || "").trim(),
    place_url: String(item.place_url || "").trim(),
    x: Number(item.x),
    y: Number(item.y)
  };
}

function kakaoAddressPlace(item) {
  const roadAddress = item.road_address || {};
  const address = item.address || {};
  const addressName = String(item.address_name || roadAddress.address_name || address.address_name || "").trim();
  return {
    id: `kakao-address:${item.x}:${item.y}:${addressName}`,
    place_name: String(roadAddress.address_name || addressName).trim(),
    category_name: "주소",
    description: "",
    address_name: String(address.address_name || addressName).trim(),
    road_address_name: String(roadAddress.address_name || "").trim(),
    place_url: "",
    x: Number(item.x),
    y: Number(item.y)
  };
}

async function localAddressSearch(query) {
  const normalizedQuery = String(query || "").trim().replace(/\s+/g, " ");
  if (!normalizedQuery) return [];
  return cached(`kakao:address:${normalizedQuery}`, CACHE_TTL.geocode, async () => {
    const data = await kakao(`https://dapi.kakao.com/v2/local/search/address.json?${new URLSearchParams({ query: normalizedQuery, size: "10" })}`);
    return (data.documents || []).map(kakaoAddressPlace)
      .filter(item => Number.isFinite(item.x) && Number.isFinite(item.y) && item.place_name);
  });
}

// 백화점·아울렛처럼 고유 지점명이 중요한 장소는 한 검색 공급자의 상위 결과에
// 누락될 수 있다. 카카오의 공개 키워드 검색을 보완해 실제 쇼핑몰 좌표를 수집한다.
async function localKeywordSearch(query) {
  const normalizedQuery = String(query || "").trim().replace(/\s+/g, " ");
  if (!normalizedQuery) return [];
  return cached(`kakao:keyword:${normalizedQuery}`, CACHE_TTL.localSearch, async () => {
    const data = await kakao(`https://dapi.kakao.com/v2/local/search/keyword.json?${new URLSearchParams({ query: normalizedQuery, size: "15" })}`);
    return (data.documents || []).map(kakaoPlace)
      .filter(item => Number.isFinite(item.x) && Number.isFinite(item.y) && item.place_name);
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
    // 도로명 주소는 네이버 지역검색에서 상호명보다 낮게 취급되어 빈 배열로
    // 내려오는 경우가 있다. 출발지 자체를 찾지 못하면 문화센터 범위 검증도
    // 시작할 수 없으므로, 같은 공개 지도 검색의 카카오 키워드 결과로 보완한다.
    const naverResults = await localSearch(normalizedQuery).catch(error => {
      console.warn("[geocode naver failed]", error.message || String(error));
      return [];
    });
    const addressResults = await localAddressSearch(normalizedQuery).catch(error => {
      console.warn("[geocode kakao address failed]", error.message || String(error));
      return [];
    });
    const keywordResults = await localKeywordSearch(normalizedQuery).catch(error => {
      console.warn("[geocode kakao failed]", error.message || String(error));
      return [];
    });
    const results = [...addressResults, ...naverResults, ...keywordResults];
    const exact = results.find(item => `${item.road_address_name} ${item.address_name} ${item.place_name}`.includes(normalizedQuery)) || results[0];
    if (!exact) throw new Error("지도 검색에서 출발지를 찾지 못했습니다.");
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
  // 역지오코딩 결과에 행정통합 전 명칭이 섞여도 검색어는 네이버 지역검색이
  // 이해하는 생활권 도시명으로 맞춘다. (예: 전남광주통합특별시 → 광주)
  const label = String(originLabel || "").trim().replace(/전남광주통합특별시/g, "광주");
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

// 메인 장소 주변을 찾을 때는 출발지용 검색어를 재사용하면 안 된다. 예를 들어
// "전남광주통합특별시 무안군 삼향읍 남악4로"는 출발지 후보 검색에는 광주로
// 넓혀도 되지만, 메인 주변 식당을 찾을 때 "광주 맛집"으로 검색하면 남악과
// 수십 km 떨어진 결과만 받아 전부 거리 필터에서 탈락한다.
function nearbyAreaHints(originLabel = "") {
  const label = String(originLabel || "").trim();
  if (!label) return [];
  const administrative = label.match(/[가-힣]{2,}(?:특별자치시|특별시|광역시|도|시|군|구|읍|면|동)/g) || [];
  const roadLocality = label.match(/(?:^|\s)([가-힣]{2,})\d*(?:로|길)(?=\s|$)/)?.[1] || "";
  const localAdministrative = administrative.filter(value => /(?:읍|면|동)$/.test(value)).at(-1) || "";
  const districtAdministrative = administrative.filter(value => /(?:군|구|시)$/.test(value)
    && !/(?:특별시|광역시|특별자치시)$/.test(value)).at(-1) || "";
  // 도로명에 생활권 이름이 들어가면 가장 먼저 쓰되, 읍·면·동과 시·군·구도
  // 차례대로 폴백한다. "남악 → 삼향읍 → 무안군"처럼 넓어진다.
  return uniqueStrings([roadLocality, localAdministrative, districtAdministrative]).slice(0, 3);
}

// 검색 범위는 시·도 중심점 추정이 아니라, 출발지 시·군·구의 실제 인접 관계로
// 계산한다. 단계 1은 출발지+맞닿은 시·군·구, 단계 2·3은 그 경계를 한 번씩 더
// 넓힌다. 해안·광역 경계를 억지로 같은 생활권으로 묶지 않으며, 최종 포함 여부는
// 계속 카카오 차량시간으로 판정한다.
const AREA_ALIASES = [
  [/전남광주통합특별시/g, "광주"], [/서울특별시/g, "서울"], [/부산광역시/g, "부산"],
  [/대구광역시/g, "대구"], [/인천광역시/g, "인천"], [/광주광역시/g, "광주"],
  [/대전광역시/g, "대전"], [/울산광역시/g, "울산"], [/세종특별자치시/g, "세종"],
  [/제주특별자치도/g, "제주"], [/강원특별자치도/g, "강원"], [/강원도/g, "강원"],
  [/경기도/g, "경기"], [/전라남도/g, "전남"], [/전라북도|전북특별자치도/g, "전북"],
  [/충청남도/g, "충남"], [/충청북도/g, "충북"], [/경상남도/g, "경남"], [/경상북도/g, "경북"]
];

function normalizedAreaLabel(value = "") {
  return AREA_ALIASES.reduce((label, [expression, replacement]) => label.replace(expression, replacement), String(value || ""))
    .replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
}

function compactAreaLabel(value = "") {
  return normalizedAreaLabel(value).replace(/\s/g, "");
}

function canonicalSigunguName(value = "") {
  const label = compactAreaLabel(value);
  if (!label) return "";
  // "경기 고양시 덕양구"처럼 복합 행정구역부터 먼저 맞춘다. 단순 "남구"만
  // 들어온 경우에는 전국에 동명이 많으므로 추측하지 않는다.
  const matches = Object.keys(SIGUNGU_GRAPH)
    .filter(name => label.includes(compactAreaLabel(name)))
    .sort((a, b) => compactAreaLabel(b).length - compactAreaLabel(a).length);
  if (matches[0]) return matches[0];

  // 역지오코더가 "무안읍 무안군"처럼 읍·면·동과 군을 함께 주되 시·도를
  // 생략하는 경우가 있다. 이때 마지막 시·군·구 이름이 전국에서 하나로
  // 정해질 때만 그래프의 정식 이름으로 보완한다. "남구"처럼 동명이 많은
  // 이름은 여전히 추측하지 않는다.
  const districtNames = normalizedAreaLabel(value).match(/[가-힣]+(?:시|군|구)/g) || [];
  for (const districtName of [...districtNames].reverse()) {
    const suffixMatches = Object.keys(SIGUNGU_GRAPH)
      .filter(name => compactAreaLabel(name).endsWith(compactAreaLabel(districtName)));
    if (suffixMatches.length === 1) return suffixMatches[0];
  }
  return "";
}

function rangeAreaHints(resolvedOriginLabel = "", suppliedOriginLabel = "", level = 1) {
  const start = canonicalSigunguName(resolvedOriginLabel) || canonicalSigunguName(suppliedOriginLabel);
  const hops = Math.max(1, Math.min(3, Number(level) || 1));
  if (!start) return [];
  const seen = new Set([start]);
  let frontier = [start];
  const result = [start];
  for (let step = 0; step < hops; step += 1) {
    const next = uniqueStrings(frontier.flatMap(name => SIGUNGU_GRAPH[name] || []))
      .filter(name => !seen.has(name));
    next.forEach(name => seen.add(name));
    result.push(...next);
    frontier = next;
    if (!frontier.length) break;
  }
  return result;
}

function usableSearchHints(values) {
  // '남구'를 접미사 제거한 '남'처럼 장소 검색에 쓸 수 없는 한 글자 힌트는 버린다.
  return uniqueStrings(values).filter(value => String(value).replace(/\s/g, "").length >= 2);
}

function themedQueries(definition, originLabel, suppliedHints = [], preview = false, rangeAreas = [], queryBudget = 24) {
  const hints = uniqueStrings([...(suppliedHints || []), ...areaHints(originLabel)]);
  const landmarkHint = hints.find(hint => /(?:역|공항|터미널|휴게소|IC)$/i.test(String(hint)));
  const areas = uniqueStrings(rangeAreas);
  const primaryArea = areas[0] || hints[0] || "";
  const terms = definition.queries.slice(0, preview ? 6 : definition.queries.length);
  if (!primaryArea) return terms.slice(0, preview ? 6 : queryBudget);

  const planned = [];
  const add = query => { if (query && !planned.includes(query)) planned.push(query); };
  // 출발지 구역은 테마의 모든 핵심 검색어로 확인한다. 예: "광주 남구 도예 체험".
  terms.forEach(term => add(`${primaryArea} ${term}`));
  // 공항·역 등 장소명으로 출발한 경우, 이 지점과 직접 연결된 시설도 보완한다.
  if (landmarkHint && landmarkHint !== primaryArea) terms.slice(0, 3).forEach(term => add(`${landmarkHint} ${term}`));

  const nearbyAreas = areas.slice(1);
  if (definition === THEME.animals) {
    // 고양이카페는 구 경계 하나만 넘어도 누락되기 쉬워 모든 범위 지역에서 먼저 확인한다.
    nearbyAreas.forEach(area => add(`${area} 고양이카페`));
    nearbyAreas.forEach(area => add(`${area} 실내동물원`));
    nearbyAreas.forEach(area => add(`${area} 동물카페`));
  } else {
    // 인접 지역도 테마의 세부 활동어를 순환해 실제로 검색한다. 1·2·3단계 모두
    // 같은 방식으로 확장되며, 캐시된 호출은 재검색하지 않는다.
    for (let round = 0; round < terms.length; round += 1) {
      nearbyAreas.forEach((area, index) => add(`${area} ${terms[(round + index) % terms.length]}`));
    }
  }
  return planned.slice(0, Math.max(preview ? 8 : 12, queryBudget));
}

const originAreaCache = new Map();

function areaNameFromReverseResponse(data) {
  const address = data?.address || {};
  // 현재 위치 검색에는 사용자가 입력한 "광주 남구" 같은 문맥이 없다.
  // 구 이름만 반환하면 "남구 박물관"처럼 전국 검색어가 되어 후보가 0건이
  // 될 수 있으므로, 도시와 구를 함께 보존한다.
  const province = address.province || address.state || "";
  const city = address.city || address.town || address.municipality || address.state_district || "";
  const district = address.city_district || address.borough || address.county || "";
  // 군 지역은 city가 '무안읍'처럼 읍으로 내려오는 경우가 있다. 이 경우
  // '무안읍 무안군'보다 '전라남도 무안군'이 인접 시·군·구 그래프와 정확히
  // 일치한다. 광역시의 구도 동일하게 시·도 문맥을 우선 보존한다.
  if (province && district && !String(province).includes(String(district))) return `${province} ${district}`;
  if (city && district && !String(city).includes(String(district))) return `${city} ${district}`;
  return province || city || district || "";
}

async function reverseAreaLabel(lat, lon) {
  const cacheKey = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
  if (originAreaCache.has(cacheKey)) return originAreaCache.get(cacheKey);
  // v3: 읍·면·동이 함께 내려오는 군 지역도 시·도+군으로 정규화한다. 이전
  // '무안읍 무안군' 같은 캐시를 재사용하지 않는다.
  const value = cached(`origin-area:v3:${cacheKey}`, CACHE_TTL.area, async () => {
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
  const routeKey = `kakao:routes:v3:${pointKey(origin)}:${targets.map(doc => doc.id || `${doc.x},${doc.y}`).join("|")}`;
  return cached(routeKey, CACHE_TTL.route, async () => {
    // 다중 목적지 API의 radius는 출발지~목적지 간 이동가능 거리가 아니라 각
    // 좌표를 도로에 맞추는 길찾기 반경(최대 20km)이다. 1시간 후보는 이를 넘는
    // 경우가 많아 전부 304으로 탈락한다. 단일 자동차 길찾기는 총 1,500km까지
    // 지원하므로, 후보별 실제 차량 경로를 병렬 조회해 최종 범위를 판정한다.
    const routed = await Promise.all(targets.map(async doc => {
      const targetKey = `kakao:route:v1:${pointKey(origin)}:${pointKey(doc)}`;
      try {
        return await cached(targetKey, CACHE_TTL.route, async () => {
          const params = new URLSearchParams({
            origin: `${+origin.x},${+origin.y}`,
            destination: `${+doc.x},${+doc.y}`,
            priority: "TIME",
            alternatives: "false",
            road_details: "false",
            car_fuel: "GASOLINE",
            car_hipass: "false"
          });
          const data = await kakao(`https://apis-navi.kakaomobility.com/v1/directions?${params}`);
          const summary = data.routes?.[0]?.summary;
          if (!summary || !Number.isFinite(Number(summary.duration))) throw new Error("차량 경로 요약이 없습니다.");
          return {
            ...doc,
            route_minutes: Math.max(1, Math.round(Number(summary.duration) / 60)),
            route_distance: Number(summary.distance) || 0,
            route_estimated: false
          };
        });
      } catch (error) {
        console.warn("[route fallback]", doc.place_name || doc.name || "", error.message || String(error));
        return estimatedRoute(origin, doc);
      }
    }));
    const actual = routed.filter(route => !route.route_estimated).length;
    console.log("[route lookup]", JSON.stringify({ requested: targets.length, actual, fallback: targets.length - actual }));
    return routed;
  });
}

// 문화센터 사이트는 공개된 예약 화면이지만, 지점·강좌마다 별도의 로그인 세션을
// 만들거나 신청을 시도하지 않는다. 날짜·시간·대상·상세 링크처럼 방문 판단에 필요한
// 공개 시간표만 짧은 시간 안에 읽어 온다.
async function fetchOfficialText(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        "User-Agent": "LittleTrip-CultureSchedule/1.0",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`공식 문화센터 ${response.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOfficialJson(url, options = {}, timeoutMs = 6500) {
  const text = await fetchOfficialText(url, options, timeoutMs);
  try { return JSON.parse(text); } catch { throw new Error("공식 문화센터 응답 형식을 읽지 못했습니다."); }
}

function compactCultureName(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .replace(/롯데마트|롯데백화점|롯데아울렛|롯데몰|타임빌라스|롯데|마트|maxx|맥스|현대프리미엄아울렛|현대아울렛|현대백화점|더현대|신세계백화점|신세계|이마트|문화센터|컬처센터|컬처클럽/g, "")
    .replace(/[\s·ㆍ,()\-_.]/g, "")
    .replace(/점$/, "");
}

function formatVisitDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) return "";
  const year = +digits.slice(0, 4), month = +digits.slice(4, 6), day = +digits.slice(6, 8);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}월 ${day}일 (${weekday})`;
}

function oneDayChildClass(text, count = "") {
  const value = `${text || ""} ${count || ""}`.replace(/\s+/g, " ");
  const child = /영아|영유아|유아|어린이|아동|키즈|엄마랑\s*아가랑|보호자\s*동반|가족|패밀리/.test(value);
  const oneDay = String(count) === "1" || /(?:^|\s)1\s*회(?:\s|$)|원데이|일일\s*(?:특강|강좌)|하루\s*특강/.test(value);
  return child && oneDay;
}

// 이마트 컬처클럽은 공개 강좌 화면 자체가 사용하는 읽기 전용 AppSync 조회를
// 제공한다. 키나 엔드포인트를 소스에 고정하지 않고 공개 번들에서 매번 확인해,
// 운영사가 교체했을 때도 로그인·신청 없이 공식 시간표만 읽는다.
const EMART_BUNDLE_URL = "https://www.cultureclub.emart.com/static/js/main.2402cf18.chunk.js";

async function emartPublicConfig() {
  return cached("culture-center:emart:public-config:v1", CACHE_TTL.cultureCenterBranches, async () => {
    const bundle = await fetchOfficialText(EMART_BUNDLE_URL, {}, 12000);
    const endpoint = (bundle.match(/"awsappsyncgraphqlEndpoint":"(https:[^"]+\/graphql)"/) || [])[1];
    const apiKey = (bundle.match(/"awsappsyncapiKey":"([^"]+)"/) || [])[1];
    if (!endpoint || !apiKey) throw new Error("이마트 공개 강좌 조회 설정을 찾지 못했습니다.");
    return { endpoint, apiKey };
  });
}

async function emartPublicGraphql(query, variables) {
  const { endpoint, apiKey } = await emartPublicConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok || data.errors?.length) throw new Error(data.errors?.[0]?.message || `이마트 문화센터 ${response.status}`);
    return data.data || {};
  } finally {
    clearTimeout(timer);
  }
}

async function emartBranches() {
  return cached("culture-center:emart:branches:v1", CACHE_TTL.cultureCenterBranches, async () => {
    const data = await emartPublicGraphql(`
      query getStoreAreaList($isAll: Boolean!) {
        getStoreAreaList(isAll: $isAll) {
          area
          storeListInfo { storeName storeNickName storeCode storeCenter }
        }
      }
    `, { isAll: true });
    return uniqueStrings((data.getStoreAreaList || []).flatMap(area => (area.storeListInfo || [])
      .map(store => `${store.storeCode}|${store.storeNickName || store.storeName || ""}`)))
      .map(value => {
        const [code, name] = value.split("|");
        return { code, name };
      }).filter(branch => branch.code && branch.name);
  });
}

function emartClassTime(value) {
  const start = String(value?.startTime || "").replace(/(\d{2})(\d{2})$/, "$1:$2");
  const end = String(value?.endTime || "").replace(/(\d{2})(\d{2})$/, "$1:$2");
  return start && end ? `${start}~${end}` : "시간은 상세에서 확인";
}

async function emartOneDayClasses(branch, visitDate) {
  const digits = String(visitDate || "").replace(/\D/g, "");
  const query = `
    query getClassByFiltering($filterData: [FilterData], $from: Int, $size: Int) {
      getClassByFiltering(filterData: $filterData, sortKey: "deadline", from: $from, size: $size) {
        data {
          classId classTitle classStatusBO classTimes classFee classMaterialFee
          classTime { startTime endTime }
          mainCategory { categoryName categoryCode }
          subCategory { categoryName categoryCode }
          mainStoreInfo { storeName storeNickName storeCode }
          classDateInfo { classStartDate classEndDate }
          classDetail { classDetailInfo { classDetailInfoTitle classDetailInfoContent } }
        }
      }
    }
  `;
  const data = await emartPublicGraphql(query, {
    filterData: [
      { type: "mainStoreInfo.storeCode", data: [String(branch.code)] },
      { type: "classDate", data: [digits, digits] }
    ],
    from: 0,
    size: 500
  });
  const rawCourses = data.getClassByFiltering?.data;
  if (!Array.isArray(rawCourses)) {
    console.warn("[emart class response shape]", JSON.stringify({
      branch: branch.name,
      response: rawCourses && typeof rawCourses === "object" ? Object.keys(rawCourses) : typeof rawCourses
    }));
    return [];
  }
  return rawCourses.filter(course => {
    const detailItems = Array.isArray(course.classDetail?.classDetailInfo)
      ? course.classDetail.classDetailInfo
      : (course.classDetail?.classDetailInfo ? [course.classDetail.classDetailInfo] : []);
    const details = detailItems.map(item => `${item.classDetailInfoTitle || ""} ${item.classDetailInfoContent || ""}`).join(" ");
    const text = `${course.classTitle || ""} ${course.mainCategory?.categoryName || ""} ${course.subCategory?.categoryName || ""} ${details}`;
    const child = /Little|With\s*Mom|Kids|자녀|위드맘|키즈|어린이|유아|영아|아동|보호자|가족/i.test(text);
    const count = Number(String(course.classTimes || "").replace(/[^0-9]/g, ""));
    return child && count === 1;
  }).map(course => ({
    id: `emart:${branch.code}:${course.classId}:${digits}`,
    title: String(course.classTitle || "").trim(),
    time: emartClassTime(course.classTime),
    target: String(course.subCategory?.categoryName || course.mainCategory?.categoryName || "유아·어린이").trim(),
    price: currencyLabel(course.classFee || course.classMaterialFee),
    status: String(course.classStatusBO || "공식 시간표 · 접수 상태는 상세에서 확인"),
    sourceName: "이마트 문화센터",
    sourceUrl: `https://www.cultureclub.emart.com/class/${encodeURIComponent(course.classId)}`
  })).filter(course => course.title);
}

// 신세계 아카데미의 공개 강좌찾기 화면이 사용하는 읽기 전용 목록 API다.
// 지점 선택 UI는 새 신세계 사이트에, 강좌 목록은 아카데미 프레임에 분리돼 있어
// 지점 코드와 강좌 코드가 서로 다르다. 아래 코드는 아카데미 프레임에서 실제로
// 내려오는 storeCode를 사용한다. 광주점은 장기 휴관으로 현재 목록에 없다.
const SHINSEGAE_LECTURE_LIST_URL = "https://sacademy.shinsegae.com/sdotcom/web/HP0010P0/getLectList.do";
const SHINSEGAE_BRANCHES = [
  ["01", "본점"], ["03", "타임스퀘어"], ["14", "강남점"], ["15", "마산점"],
  ["16", "신세계 사우스시티"], ["18", "센텀시티"], ["19", "의정부점"],
  ["37", "김해점"], ["40", "스타필드 하남점"], ["70", "천안아산점"],
  ["90", "대구신세계"], ["D1", "대전신세계 Art & Science"]
].map(([code, name]) => ({ code, name }));
const SHINSEGAE_SEMESTERS = ["S1", "S2", "S3", "S4"];

function shinsegaePeriodIncludes(period, visitDate) {
  const dates = String(period || "").match(/20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}/g) || [];
  if (!dates.length) return false;
  const normalized = dates.map(value => {
    const [year, month, day] = value.split(/[.\-/]/);
    return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
  }).sort();
  const target = String(visitDate || "").replace(/\D/g, "");
  return normalized[0] <= target && target <= normalized[normalized.length - 1];
}

async function shinsegaeSemesterClasses(branch, semester) {
  return cached(`culture-center:shinsegae:${branch.code}:${semester}:v1`, CACHE_TTL.cultureCenterClasses, async () => {
    const requestPage = async page => {
      const form = new URLSearchParams({
        ordKey: "", curPage: String(page), vipUseFlag: "", prmStoreCode: "", prmYearCode: "", prmSmstCode: "", prmLectCode: "",
        yearCode: "", smstCode: "", sttlmBtnYn: "Y", adminFlag: "", autoSeachYn: "Y", search: "Y",
        storeCode: branch.code, onOffCode: "", onlineStoreCode: "", lectGrType: "", lectGrCode: "", schSmstCode: semester,
        rcptStat: "", dayCode: "", lectTimeCode: "", targetCode: "", tchName: "", lectName: "", srchCndCd: "01", srchWrd: "", pageSize: "100"
      });
      return fetchOfficialJson(SHINSEGAE_LECTURE_LIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: form.toString()
      }, 9000);
    };
    const first = await requestPage(1);
    const rows = Array.isArray(first?.lectList) ? first.lectList : [];
    const total = Number(first?.param?.totalCount || first?.totalCount || rows.length);
    const pages = Math.min(5, Math.ceil(total / 100));
    if (pages > 1) {
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, index) => requestPage(index + 2)));
      rest.forEach(page => rows.push(...(Array.isArray(page?.lectList) ? page.lectList : [])));
    }
    return rows;
  });
}

async function shinsegaeOneDayClasses(branch, visitDate) {
  const semesters = await Promise.all(SHINSEGAE_SEMESTERS.map(semester => shinsegaeSemesterClasses(branch, semester).catch(error => {
    console.warn("[shinsegae semester lookup failed]", branch.name, semester, error.message || String(error));
    return [];
  })));
  const seen = new Set();
  return semesters.flat().filter(record => {
    const key = `${record.storeCode || branch.code}:${record.lectCode || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const text = `${record.lectName || ""} ${record.tlectTargetMemCodeName || ""} ${record.tchName || ""}`;
    return String(record.lectCnt || "") === "1"
      && shinsegaePeriodIncludes(record.lectPeriod, visitDate)
      && oneDayChildClass(text, record.lectCnt);
  }).map(record => ({
    id: `shinsegae:${branch.code}:${record.lectCode}:${visitDate}`,
    title: String(record.lectName || "").trim(),
    time: String(record.lectHm || "시간은 상세에서 확인").trim(),
    target: String(record.tlectTargetMemCodeName || "유아·어린이").trim(),
    price: currencyLabel(record.lectAmt || record.lectAmtCurr),
    status: String(record.lectStat || "공식 시간표 · 접수 상태는 상세에서 확인"),
    sourceName: "신세계 문화센터",
    sourceUrl: "https://www.shinsegae.com/culture/academy/lecture.do"
  })).filter(course => course.title);
}

function cultureMallProvider(place) {
  // "다이소 롯데마트월드컵점"처럼 쇼핑몰 안에 입점한 매장이 검색될 수 있다.
  // 장소명 자체가 체인명으로 시작하는 경우만 문화센터가 있는 실제 쇼핑몰로 인정한다.
  const name = String(place.place_name || "").trim().replace(/\s+/g, "");
  // 문화센터·ATM·세탁소·충전소 등은 실제 쇼핑몰과 같은 좌표로 따로 검색된다.
  // 이들을 남겨두면 가까운 한 매장이 후보 한도를 모두 차지한다.
  if (/(?:문화센터|컬처센터|ATM|현금인출|전기차|충전소|세탁|드라이|다이소|주차|주차장|약국|은행|푸드코트|토이|안경|사거리|교차로|물류|혁신|공인중개|수산|빌|예정|타워)/i.test(name)) return "";
  if (/^롯데\s*마트(?:$|[가-힣]|MAXX|맥스)/i.test(name)) return "lottemart";
  if (/^(?:롯데백화점|롯데아울렛|롯데몰|타임빌라스)(?:$|\s|[가-힣(])/i.test(name)) return "lottedepartment";
  if (/^(?:현대백화점|더현대|현대프리미엄아울렛|현대아울렛)(?:$|\s|[가-힣(])/i.test(name)) return "hyundai";
  // 지도 공급자는 같은 건물을 "신세계마켓 신세계백화점 강남점"처럼
  // 표기하기도 한다. 단순 신세계마켓은 제외하되, 실제 백화점명이 함께 있는
  // 경우만 본점 좌표로 인정한다.
  if (/^신세계백화점(?:$|\s|[가-힣(])/i.test(name) || /^신세계(?:마켓|몰).*신세계백화점/i.test(name)) return "shinsegae";
  if (/^이마트(?:$|\s|[가-힣(])/i.test(name)) return "emart";
  return "";
}

function cultureMallCandidateScore(place) {
  const name = String(place.place_name || "").replace(/\s+/g, "");
  // 본점 명칭은 높은 점수, 상가·전문점 이름은 낮은 점수로 둔다. 동점이면
  // 지도 검색 공급자와 관계없이 실제 쇼핑몰 명칭을 우선해 좌표 중복을 합친다.
  let score = 0;
  if (/^(?:롯데마트|롯데백화점|롯데아울렛|롯데몰|타임빌라스|현대백화점|더현대|현대프리미엄아울렛|현대아울렛|신세계백화점|신세계|이마트)/.test(name)) score += 100;
  if (/점\s*$/.test(name)) score += 20;
  if (/^(?:롯데마트|롯데백화점|롯데아울렛|롯데몰|타임빌라스|현대백화점|더현대|현대프리미엄아울렛|현대아울렛|신세계백화점|신세계|이마트)[가-힣\s]*(?:점)?$/.test(name)) score += 20;
  return score;
}

function uniqueCultureMalls(origin, places) {
  const selected = [];
  const candidates = [...places].sort((a, b) => (cultureMallCandidateScore(b) - cultureMallCandidateScore(a))
    || (haversine(origin, a) - haversine(origin, b)));
  for (const place of candidates) {
    // 지도 공급자가 달라도 실제 매장 좌표는 250m 안에 반복된다.
    const sameMall = selected.findIndex(existing => existing.provider === place.provider && haversine(existing, place) <= 0.25);
    if (sameMall < 0) {
      selected.push(place);
      continue;
    }
    if (cultureMallCandidateScore(place) > cultureMallCandidateScore(selected[sameMall])) selected[sameMall] = place;
  }
  return selected;
}

function bestCultureBranch(place, branches) {
  const mallName = compactCultureName(place.place_name);
  if (!mallName) return null;
  const scored = branches.map(branch => {
    const branchName = compactCultureName(branch.name);
    let score = 0;
    if (mallName === branchName) score = 100;
    else if (mallName.includes(branchName) || branchName.includes(mallName)) score = 80;
    else {
      const mallTokens = mallName.match(/[가-힣a-z]+/g) || [];
      const branchTokens = branchName.match(/[가-힣a-z]+/g) || [];
      score = mallTokens.filter(token => token.length > 1 && branchTokens.includes(token)).length * 18;
    }
    return { branch, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 55 ? scored[0].branch : null;
}

async function lotteMartBranches() {
  return cached("culture-center:lottemart:branches:v1", CACHE_TTL.cultureCenterBranches, async () => {
    const html = await fetchOfficialText("https://culture.lottemart.com/cu/gus/course/schedule/scheduleEvent.do");
    const branches = [];
    const pattern = /fn_headerChooseStore\(this,\s*'([^']+)',\s*'([^']+)'\)/g;
    let match;
    while ((match = pattern.exec(html))) branches.push({ code: match[1], name: stripHtml(match[2]) });
    return uniqueStrings(branches.map(branch => `${branch.code}|${branch.name}`)).map(value => {
      const [code, name] = value.split("|");
      return { code, name };
    });
  });
}

function lotteMartSeason(year, month) {
  if (month >= 3 && month <= 5) return `${year}년 봄`;
  if (month >= 6 && month <= 8) return `${year}년 여름`;
  if (month >= 9 && month <= 11) return `${year}년 가을`;
  return `${year}년 겨울`;
}

function currencyLabel(value) {
  const amount = Number(String(value || "").replace(/[^0-9]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? `${amount.toLocaleString("ko-KR")}원` : "";
}

async function lotteMartOneDayClasses(branch, visitDate) {
  const digits = String(visitDate || "").replace(/\D/g, "");
  const year = digits.slice(0, 4), month = digits.slice(4, 6);
  const form = new URLSearchParams({
    cls_cd: "", temp_str_cd: "", month_fg: "", dates_dd: "", dates: "", search_ym: "",
    termChoice: year, strMonth: month, strLectureInfo: lotteMartSeason(year, Number(month)),
    day_fg: "01", str_cd: branch.code, lecture: "2",
    clsTarget2: "", clsTarget3: "3", clsTarget4: "4", clsTarget5: ""
  });
  const data = await fetchOfficialJson("https://culture.lottemart.com/cu/gus/course/schedule/searchEventList.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: form.toString()
  });
  const records = Array.isArray(data?.listCourseTimeTable) ? data.listCourseTimeTable : [];
  return records.filter(record => {
    const scheduleDate = String(record.DATES || "").replace(/\D/g, "").slice(0, 8);
    const text = `${record.CLS_NM || ""} ${record.P_CLASS_PATH_NM || ""} ${record.CODE_NAME || ""} ${record.AGE_FROM_TO || ""}`;
    return scheduleDate === digits && oneDayChildClass(text, record.CLS_CNT || record.WEEK_CLS_CNT);
  }).map(record => {
    const courseId = String(record.CLS_CD || `${branch.code}-${record.CLS_NM}-${record.DATES}`);
    const query = new URLSearchParams({
      cls_cd: courseId,
      currPageNo: "1",
      search_str_cd: branch.code,
      search_term_cd: `${year}${month}`
    });
    return {
      id: `lottemart:${branch.code}:${courseId}:${digits}`,
      title: stripHtml(record.CLS_NM),
      time: String(record.WEEK || "").trim() || "시간은 상세에서 확인",
      target: String(record.AGE_FROM_TO || record.CODE_NAME || "유아·어린이").trim(),
      price: currencyLabel(record.FEE),
      status: "공식 시간표 · 접수 상태는 상세에서 확인",
      sourceName: "롯데마트 문화센터",
      sourceUrl: `https://culture.lottemart.com/cu/gus/course/courseinfo/courseview.do?${query}`
    };
  });
}

async function hyundaiBranches() {
  return cached("culture-center:hyundai:branches:v2", CACHE_TTL.cultureCenterBranches, async () => {
    const html = await fetchOfficialText("https://www.ehyundai.com/newCulture/CT/CT010100_L.do");
    const branches = [];
    const addBranch = (code, rawName) => {
      const name = textFromHtml(rawName).replace(/^전체\s*/, "").trim();
      if (code && /점|아울렛|가든파이브|더현대|커넥트현대/.test(name)) branches.push({ code, name });
    };
    const pattern = /<option\b[^>]*value=["'](\d{2,4})["'][^>]*>([\s\S]*?)<\/option>/gi;
    let match;
    while ((match = pattern.exec(html))) addBranch(match[1], match[2]);

    // 현재 지점 선택 UI는 일부 지점을 option이 아닌 radio/checkbox input과
    // label로 렌더링한다. 입력 태그 뒤의 라벨 텍스트와 지점 코드를 함께 읽는다.
    const inputPattern = /<input\b[^>]*value=["'](\d{2,4})["'][^>]*>([\s\S]{0,220}?)(?=<input\b|<\/label>|<\/li>)/gi;
    while ((match = inputPattern.exec(html))) addBranch(match[1], match[2]);

    // 지점 메뉴·강좌 링크의 stCd도 보완 근거로 사용한다.
    const linkPattern = /<a\b[^>]*href=["'][^"']*(?:[?&]|&amp;)stCd=(\d{2,4})[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = linkPattern.exec(html))) addBranch(match[1], match[2]);

    // 더현대 서울의 공식 강좌 상세 URL에 사용되는 현재 지점코드다. 지점 선택
    // HTML이 다시 바뀌더라도 여의도점이 전체 검색에서 탈락하지 않게 한다.
    addBranch("400", "더현대 서울");

    const unique = new Map();
    for (const branch of branches) {
      const key = `${branch.code}:${compactCultureName(branch.name)}`;
      if (!unique.has(key)) unique.set(key, branch);
    }
    return [...unique.values()];
  });
}

function textFromHtml(value) {
  return stripHtml(String(value || "").replace(/<br\s*\/?>/gi, " ")).replace(/\s+/g, " ").trim();
}

async function hyundaiOneDayClasses(branch, visitDate) {
  const digits = String(visitDate || "").replace(/\D/g, "");
  const year = digits.slice(0, 4), month = digits.slice(4, 6), day = digits.slice(6, 8);
  const params = new URLSearchParams({
    page: "1", stCd: branch.code, keyword: "", nickCrsNm: "", timeCntGubn: "1", applyGubn: "",
    yearGubnSta: year, yearGubnEnd: year, monthGubnSta: month, monthGubnEnd: month,
    dayGubnSta: day, dayGubnEnd: day, timeGubnSta: "", timeGubnEnd: "", day: "",
    upCrsTy2: "2,3,4,5", partnerQuotaGubn: "", orderGubn: "status", pageSize: "36",
    detailSearch: "1", ctGubn: "", promCrsKind: "all"
  });
  const html = await fetchOfficialText(`https://www.ehyundai.com/newCulture/CT/CT010100_L.do?${params}`);
  const results = [];
  const blockPattern = /<li\b[^>]*>([\s\S]*?CT010100_V\.do[\s\S]*?)<\/li>/gi;
  let match;
  while ((match = blockPattern.exec(html))) {
    const block = match[1];
    const title = textFromHtml((block.match(/<dt\b[^>]*>([\s\S]*?)<\/dt>/i) || [])[1]);
    const href = (block.match(/href=["']([^"']*CT010100_V\.do[^"']*)["']/i) || [])[1] || "";
    const text = textFromHtml(block);
    const dateMatch = text.match(/(\d{4})\.(\d{2})\.(\d{2})/);
    const courseDate = dateMatch ? `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}` : "";
    if (!title || !href || courseDate !== digits || !oneDayChildClass(text)) continue;
    const time = (text.match(/\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\b/) || [])[0] || "시간은 상세에서 확인";
    const target = textFromHtml((block.match(/class=["'][^"']*etc[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1]) || "유아·어린이";
    const price = (text.match(/\d{1,3}(?:,\d{3})*\s*원/) || [])[0] || "";
    results.push({
      id: `hyundai:${branch.code}:${title}:${digits}:${time}`,
      title,
      time,
      target,
      price,
      status: "공식 시간표 · 접수 상태는 상세에서 확인",
      sourceName: /아울렛|가든파이브|더현대/.test(branch.name) ? "현대아울렛 문화센터" : "현대백화점 문화센터",
      sourceUrl: new URL(href.replace(/&amp;/g, "&"), "https://www.ehyundai.com").href
    });
  }
  return results;
}

function formValues(html, formId) {
  const form = String(html || "").match(new RegExp(`<form\\b[^>]*id=["']${formId}["'][^>]*>([\\s\\S]*?)<\\/form>`, "i"));
  const values = new URLSearchParams();
  if (!form) return values;
  const inputPattern = /<(?:input|select)\b([^>]*)>/gi;
  let match;
  while ((match = inputPattern.exec(form[1]))) {
    const attrs = match[1];
    const name = (attrs.match(/\bname=["']([^"']+)["']/i) || [])[1];
    if (!name) continue;
    const type = ((attrs.match(/\btype=["']([^"']+)["']/i) || [])[1] || "").toLowerCase();
    if (/submit|button|reset/.test(type)) continue;
    const value = (attrs.match(/\bvalue=["']([^"']*)["']/i) || [])[1] || "";
    values.set(name, value);
  }
  return values;
}

function classDateFromText(text, visitDate) {
  const digits = String(visitDate || "").replace(/\D/g, "");
  const full = String(text || "").match(/(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (full) return `${full[1]}${String(full[2]).padStart(2, "0")}${String(full[3]).padStart(2, "0")}` === digits;
  const short = String(text || "").match(/(?:^|\s|\[)(\d{1,2})[.\-/](\d{1,2})(?:\s|\]|\))/);
  return !!short && `${digits.slice(0, 4)}${String(short[1]).padStart(2, "0")}${String(short[2]).padStart(2, "0")}` === digits;
}

async function lotteDepartmentBranches() {
  return cached("culture-center:lottedepartment:branches:v1", CACHE_TTL.cultureCenterBranches, async () => {
    const html = await fetchOfficialText("https://culture.lotteshopping.com/index.do");
    const branches = [];
    const pattern = /<a\b[^>]*href=["']([^"']*\/application\/search\/list\.do\?[^"']*brchCd=([^&"']+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(html))) {
      const name = textFromHtml(match[3]);
      if (name) branches.push({ code: match[2], name });
    }
    const unique = new Map();
    for (const branch of branches) if (!unique.has(branch.code)) unique.set(branch.code, branch);
    return [...unique.values()];
  });
}

async function lotteDepartmentOneDayClasses(branch, visitDate, mallName = "") {
  // 롯데문화센터의 특강은 일반 강좌 목록과 분리돼 있다. 일반 첫 페이지를 읽으면
  // 정기 강좌만 보여 날짜에 맞는 특강을 놓칠 수 있으므로, 공개 화면과 같은
  // `특강(3) + 영·유아/아동` 조건으로 각각 읽는다. 목록의 제목·시간에 이미 날짜와
  // 횟수가 포함돼 있어, 신청 화면을 열거나 로그인하지 않고도 날짜를 대조할 수 있다.
  const makeListUrl = category => `https://culture.lotteshopping.com/application/search/list.do?${new URLSearchParams({
    type: "branch",
    brchCd: branch.code,
    lrclsCtegryCd: category,
    lectClCdList: "3",
    pageIndex: "3",
    listCnt: "20",
    orderSet: "C"
  })}`;
  const pages = await Promise.all(["02", "03"].map(category => fetchOfficialText(makeListUrl(category))));
  const results = [];
  const linkPattern = /<a\b[^>]*href=["']([^"']*\/application\/search\/view\.do[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const html of pages) {
    let match;
    while ((match = linkPattern.exec(html))) {
      const block = match[2];
      const text = textFromHtml(block);
      const title = textFromHtml((block.match(/<p\b[^>]*class=["'][^"']*(?:tit|title)[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1]) || text.slice(0, 120);
      if (!title || !classDateFromText(text, visitDate) || !oneDayChildClass(text)) continue;
      const time = (text.match(/\b\d{1,2}:\d{2}\s*(?:~|-)\s*\d{1,2}:\d{2}\b/) || [])[0] || "시간은 상세에서 확인";
      // 가격은 링크 밖의 하단 영역에 있다. 카드 하나의 범위에서만 읽어 다음 강좌의
      // 가격이 섞이지 않도록 현재 링크 바로 뒤를 제한한다.
      const price = (html.slice(linkPattern.lastIndex, linkPattern.lastIndex + 900).match(/\d{1,3}(?:,\d{3})*\s*원/) || [])[0] || "";
      results.push({
        id: `lottedepartment:${branch.code}:${title}:${visitDate}:${time}`,
        title,
        time,
        target: /영.?유아/.test(text) ? "영·유아" : (/아동|어린이|키즈|개월|세/.test(text) ? "어린이" : "유아·어린이"),
        price,
        status: "공식 시간표 · 접수 상태는 상세에서 확인",
        sourceName: /아울렛|몰|타임빌라스/.test(`${mallName} ${branch.name}`) ? "롯데아울렛 문화센터" : "롯데백화점 문화센터",
        sourceUrl: new URL(match[1].replace(/&amp;/g, "&"), "https://culture.lotteshopping.com").href
      });
    }
  }
  return [...new Map(results.map(course => [course.id, course])).values()];
}

function cultureMallSearchAreas(originLabel, rangeAreas) {
  const ranges = uniqueStrings(rangeAreas || []).filter(place => String(place).replace(/\s/g, "").length >= 2);
  // 군 지역은 첫 몇 개의 인접 군만 순서대로 조회하면, 실제 1시간 안에 있는
  // 광역시·시 단위 상권이 뒤로 밀릴 수 있다. 출발지와 인접 그래프 안의 도시
  // 중심지를 먼저 섞고, 남은 지역도 보완한다. 특정 지역명에 의존하지 않는다.
  const cityCenters = ranges.filter(place => /(?:특별시|광역시|특별자치시|(?:^|\s)[가-힣]+시)(?:\s|$)/.test(String(place).trim()));
  return uniqueStrings([
    ...areaHints(originLabel),
    ranges[0],
    ...cityCenters,
    ...ranges
  ]).filter(place => String(place).replace(/\s/g, "").length >= 2).slice(0, 7);
}

function cultureMallQueries(originLabel, rangeAreas) {
  const places = cultureMallSearchAreas(originLabel, rangeAreas);
  const chains = ["롯데마트", "롯데백화점", "롯데아울렛", "타임빌라스", "현대백화점", "더현대", "현대프리미엄아울렛", "신세계백화점", "이마트"];
  return uniqueStrings((places.length ? places : [""]).flatMap(place => chains.map(chain => `${place} ${chain}`.trim())));
}

async function searchCultureCenterTheme(origin, maxMinutes, originLabel = "", options = {}) {
  const visitDate = String(options.visitDate || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(visitDate)) throw new Error("문화센터 테마는 놀이 날짜를 선택해 주세요.");
  // 입점 매장을 쇼핑몰로 오인하던 이전 결과 캐시를 재사용하지 않는다.
  const cacheKey = `culture-center:classes:v14:${visitDate}:${pointKey(origin, 2)}:${maxMinutes <= 40 ? 40 : 75}`;
  const allItems = await cached(cacheKey, CACHE_TTL.cultureCenterClasses, async () => {
    const mallQueries = cultureMallQueries(originLabel, options.rangeAreas);
    // 카카오 지도 검색은 모든 생활권 후보를 확인하고, 네이버 검색은 앞쪽 우선
    // 후보를 교차검증한다. 군 단위에서 요청 수가 무한정 늘지 않게 제한한다.
    const groups = await Promise.all(mallQueries.flatMap((query, index) => [
      localKeywordSearch(query).catch(error => {
        console.warn("[culture mall kakao search failed]", query, error.message || String(error));
        return [];
      }),
      ...(index < 28 ? [localSearch(query).catch(error => {
        console.warn("[culture mall naver search failed]", query, error.message || String(error));
        return [];
      })] : [])
    ]));
    const roughKm = maxMinutes <= 40 ? 48 : 110;
    const malls = uniqueCultureMalls(origin, [...new Map(groups.flat()
      .map(place => ({ ...place, provider: cultureMallProvider(place) }))
      .filter(place => place.provider && haversine(origin, place) <= roughKm)
      .map(place => [place.id, place])).values()])
      .sort((a, b) => haversine(origin, a) - haversine(origin, b)).slice(0, maxMinutes <= 40 ? 14 : 18);
    console.log("[culture mall candidates]", JSON.stringify({
      areas: cultureMallSearchAreas(originLabel, options.rangeAreas),
      queries: mallQueries.length,
      malls: malls.map(mall => mall.place_name)
    }));
    const routed = (await routes(origin, malls, maxMinutes <= 40 ? 14 : 18)).filter(place => Number(place.route_minutes) <= maxMinutes);
    const [lotteBranches, lotteDepartmentStoreBranches, hyundaiStoreBranches, emartStoreBranches] = await Promise.all([
      lotteMartBranches().catch(error => { console.warn("[lottemart branches failed]", error.message || String(error)); return []; }),
      lotteDepartmentBranches().catch(error => { console.warn("[lotte department branches failed]", error.message || String(error)); return []; }),
      hyundaiBranches().catch(error => { console.warn("[hyundai branches failed]", error.message || String(error)); return []; }),
      emartBranches().catch(error => { console.warn("[emart branches failed]", error.message || String(error)); return []; })
    ]);
    const lookupTrace = [];
    // 1시간 범위에서는 목포·남악의 가까운 매장만 앞쪽에 몰릴 수 있다. 가까운
    // 8개만 읽으면 광주의 백화점·마트가 아예 조회 대상에서 빠진다. 이미 경로
    // 검증을 마친 최대 12개 모두의 공개 시간표를 병렬로 확인한다.
    const groupsByMall = await Promise.all(routed.slice(0, maxMinutes <= 40 ? 14 : 18).map(async mall => {
      const branches = mall.provider === "lottemart" ? lotteBranches
        : mall.provider === "lottedepartment" ? lotteDepartmentStoreBranches
          : mall.provider === "hyundai" ? hyundaiStoreBranches
            : mall.provider === "shinsegae" ? SHINSEGAE_BRANCHES
              : emartStoreBranches;
      const branch = bestCultureBranch(mall, branches);
      if (!branch) {
        lookupTrace.push({ mall: mall.place_name, provider: mall.provider, route: mall.route_minutes, branch: "unmatched", courses: 0 });
        return [];
      }
      try {
        const courses = mall.provider === "lottemart"
          ? await lotteMartOneDayClasses(branch, visitDate)
          : mall.provider === "lottedepartment"
            ? await lotteDepartmentOneDayClasses(branch, visitDate, mall.place_name)
            : mall.provider === "hyundai"
              ? await hyundaiOneDayClasses(branch, visitDate)
              : mall.provider === "shinsegae"
                ? await shinsegaeOneDayClasses(branch, visitDate)
                : await emartOneDayClasses(branch, visitDate);
        lookupTrace.push({ mall: mall.place_name, provider: mall.provider, route: mall.route_minutes, branch: branch.name, courses: courses.length });
        const displayMall = mall.provider === "shinsegae"
          ? { ...mall, place_name: `신세계백화점 ${branch.name}` }
          : mall;
        return courses.map(course => ({ mall: displayMall, course }));
      } catch (error) {
        console.warn("[culture class lookup failed]", mall.provider, branch.name, error.message || String(error));
        lookupTrace.push({ mall: mall.place_name, provider: mall.provider, route: mall.route_minutes, branch: branch.name, courses: 0, error: String(error.message || error).slice(0, 80) });
        return [];
      }
    }));
    const dateLabel = formatVisitDate(visitDate);
    const items = groupsByMall.flat().map(({ mall, course }) => normalized(mall, {
      id: course.id,
      name: course.title,
      display_name: course.title,
      category: `${course.sourceName} · ${mall.place_name}`,
      route_minutes: mall.route_minutes,
      route_distance: mall.route_distance,
      route_estimated: !!mall.route_estimated,
      mall_name: mall.place_name,
      culture_class: true,
      culture_date: visitDate,
      culture_date_label: dateLabel,
      culture_time: course.time,
      culture_target: course.target,
      culture_price: course.price,
      culture_status: course.status,
      culture_source: course.sourceName,
      source_url: course.sourceUrl,
      family_evidence: 100,
      matched_themes: ["culture"]
    }));
    const byCourse = new Map();
    for (const item of items) if (!byCourse.has(item.id)) byCourse.set(item.id, item);
    const ordered = [...byCourse.values()].sort((a, b) => (a.route_minutes - b.route_minutes)
      || String(a.culture_time).localeCompare(String(b.culture_time), "ko")
      || String(a.name).localeCompare(String(b.name), "ko"));
    // 가까운 한 매장의 시간대가 결과 전체를 채우면, 다른 백화점·아울렛의
    // 실제 수업이 있어도 보이지 않게 된다. 매장마다 최대 3개만 먼저 보여
    // "주변 문화센터" 비교가 가능하도록 한다.
    const mallCount = new Map();
    const result = [];
    for (const item of ordered) {
      const mallKey = String(item.mall_name || item.culture_source || item.id);
      const count = mallCount.get(mallKey) || 0;
      if (count >= 3) continue;
      mallCount.set(mallKey, count + 1);
      result.push(item);
      if (result.length >= 12) break;
    }
    console.log("[culture center search]", JSON.stringify({
      date: visitDate,
      origin: pointKey(origin, 2),
      maxMinutes,
      malls: malls.map(mall => ({ name: mall.place_name, provider: mall.provider, roughKm: Math.round(haversine(origin, mall)) })),
      reachable: routed.length,
      lookup: lookupTrace.sort((a, b) => a.route - b.route),
      items: result.length
    }));
    return result;
  });
  const excluded = new Set((options.excludeIds || []).map(String));
  return allItems.filter(item => !excluded.has(String(item.id)));
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
  // v2: 과거에는 API 승인 전의 빈 결과까지 6시간 캐시돼, 인증키를 바로잡아도
  // 재조회하지 않는 문제가 있었다. 실패는 cached() 바깥에서 처리해 저장하지 않는다.
  const key = `culture:programs:v2:${date}:${pointKey(origin, 2)}:${maxMinutes <= 40 ? 40 : 75}`;
  try {
    return await cached(key, CACHE_TTL.culturalPrograms, async () => {
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
    });
  } catch (error) {
    // 이 데이터는 전시 제목을 보강하는 선택 기능이다. 승인 지연·일시 오류가
    // 기본 문화시설 후보를 막아서는 안 된다. 오류 결과 자체는 캐시하지 않는다.
    console.warn("[culture program search skipped]", error.message || String(error));
    return [];
  }
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
  // 미술관·갤러리 이름을 쓰더라도 '갤러리카페'는 관람 시설이 아니라 식음 공간이다.
  // 문화·전시 메인 후보에서는 제외한다. 실제 갤러리·화랑 업종은 그대로 허용한다.
  if (definition === THEME.experience && /(?:갤러리|미술|아트)\s*카페|갤러리카페/.test(category)) return false;
  if (definition.exclude?.some(word => text.includes(word))) return false;

  if (definition === THEME.craft) return isChildCraftVenue(doc);
  if (definition === THEME.animals) return isNatureOrAnimalVenue(doc);
  if (definition === THEME.indoor) return isIndoorPlayVenue(doc);
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

// 실내 놀이는 일반 키즈카페·키즈파크·실내놀이터만 추천한다. 무인 공간 대여나
// 키즈풀·풀파티처럼 한 팀이 시간 단위로 빌리는 프라이빗 시설은 나들이 추천의
// 성격이 달라 제외한다. 단순히 "대관 가능"이라고 적힌 일반 키즈카페까지
// 빼지 않도록, 대관 단서만으로는 제외하지 않는다.
function isIndoorPlayVenue(doc) {
  const name = String(doc.place_name || "");
  const category = String(doc.category_name || "");
  const text = `${name} ${category} ${doc.description || ""}`;
  const rentalOnly = /무인|셀프\s*키즈|프라이빗|키즈풀|키즈\s*풀|풀파티|풀\s*파티|풀빌라|파티룸|키즈룸|공간\s*(?:대여|대관)|시간제\s*(?:대여|대관)|(?:대여|대관)\s*(?:전용|전문)/.test(text);
  if (rentalOnly) return false;
  const nonVenue = /사무실|판매|용품점|대여소|렌탈샵|교육원|학원/.test(text);
  if (nonVenue) return false;
  return /키즈카페|키즈파크|실내놀이터|트램폴린|점핑|플레이|빙상|스케이트|클라이밍/.test(text);
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
  // 문화센터는 일반 장소 후보가 아니라 선택한 날짜의 공식 수업 시간표를 기준으로
  // 결과를 만들기 때문에, 미리보기에는 넣지 않고 실제 검색에서만 조회한다.
  if (key === "culture") return options.preview ? [] : searchCultureCenterTheme(origin, maxMinutes, originLabel, options);
  const baseDefinition = THEME[key];
  if (!baseDefinition) return [];
  const definition = key === "season" ? { ...baseDefinition, queries: seasonQueries(options.visitDate) } : baseDefinition;
  const [queryResults, contentDocs, culturalDocs] = await Promise.all([
    Promise.all(themedQueries(definition, originLabel, options.searchHints, !!options.preview, options.rangeAreas, options.queryBudget).map(async query => ({
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
  const roughKm = maxMinutes <= 35 ? 45 : (maxMinutes <= 60 ? 75 : 105);
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
  // 선택 테마가 많아도 한 번의 추천 요청이 과도한 외부 검색으로 커지지 않게
  // 테마별 예산을 분배한다. 동일 지역·검색어는 6시간 캐시된다.
  const queryBudget = selected.length === 1 ? 28 : Math.max(12, Math.floor(48 / selected.length));
  const groups = await Promise.all(selected.map(key => searchTheme(key, origin, maxMinutes, originLabel, {
    ...options,
    candidateLimit,
    queryBudget
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
  const hints = nearbyAreaHints(originLabel);
  const attemptedHints = [];
  const allGroups = [];
  let rawCount = 0;
  let suitableCount = 0;
  let nearbyCount = 0;

  const candidatesFromGroups = groups => {
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
    rawCount = [...byVenue.values()].length;
    const suitable = [...byVenue.values()].filter(doc => isSuitableNearby(doc, type));
    suitableCount = suitable.length;
    const nearby = suitable.filter(doc => haversine(origin, doc) <= 25);
    nearbyCount = nearby.length;
    return nearby.sort((a, b) => (b.nearby_popularity - a.nearby_popularity)
      || (a.nearby_best_rank - b.nearby_best_rank)
      || (haversine(origin, a) - haversine(origin, b))).slice(0, 20);
  };

  let candidates = [];
  // 가장 가까운 생활권부터 검색하고, 후보가 모자랄 때만 읍·면·동 → 시·군·구로
  // 넓힌다. 주소가 없을 때는 기존처럼 지역명 없는 일반 검색을 한 번 수행한다.
  for (const hint of (hints.length ? hints : [""])) {
    attemptedHints.push(hint || "전국");
    const queries = uniqueStrings(terms.map(term => hint ? `${hint} ${term}` : term));
    const groups = await Promise.all(queries.map(query => localSearch(query).catch(error => {
      console.warn("[naver nearby failed]", type, query, error.message || String(error));
      return [];
    })));
    allGroups.push(...groups);
    candidates = candidatesFromGroups(allGroups);
    if (candidates.length >= 5) break;
  }
  const routed = await routes(origin, candidates);
  // 보조 콘텐츠·식당·카페는 메인에서 실제 차량 20분 이내여야 한다.
  // 앞의 25km 조건은 외부 경로 요청량을 줄이는 사전 필터일 뿐, 최종 기준이 아니다.
  const withinTwentyMinutes = routed.filter(doc => Number(doc.route_minutes) <= 20);
  const result = withinTwentyMinutes.map(doc => normalized(doc, {
    route_minutes: doc.route_minutes,
    route_distance: doc.route_distance,
    route_estimated: !!doc.route_estimated,
    nearby_summary: nearbySummary(doc, type),
    nearby_popularity: doc.nearby_popularity
  })).sort((a, b) => (b.nearby_popularity - a.nearby_popularity)
    || (a.route_minutes - b.route_minutes)).slice(0, 8);
  console.info("[nearby search]", JSON.stringify({
    type,
    origin: pointKey(origin),
    originLabel: String(originLabel || "").slice(0, 120),
    hints: attemptedHints,
    raw: rawCount,
    suitable: suitableCount,
    within25km: nearbyCount,
    within20minutes: withinTwentyMinutes.length,
    result: result.length
  }));
  return result;
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
    // 화면은 이동시간만 받는다. 30분은 인접 2단계, 1시간은 3단계까지
    // 후보를 넓혀 수집한 뒤 실제 차량시간으로 최종 제외한다.
    const requestedRangeLevel = +value("rangeLevel");
    const rangeLevel = Math.max(1, Math.min(3, Number.isFinite(requestedRangeLevel) && requestedRangeLevel > 0
      ? requestedRangeLevel
      : (maxMinutes <= 40 ? 2 : 3)));
    const suppliedOriginLabel = String(value("originLabel") || "").trim();
    // "김포공항" 같은 사용자가 입력한 지점명과 역지오코딩한 "강서구"를 모두
    // 검색 힌트로 쓴다. 전자는 항공박물관처럼 지점 연관 시설을, 후자는 주변
    // 과학관·미술관 같은 행정구역 시설을 놓치지 않게 한다.
    const resolvedOriginLabel = await originAreaLabel(origin);
    const originLabel = suppliedOriginLabel || resolvedOriginLabel;
    const rangeAreas = rangeAreaHints(resolvedOriginLabel, suppliedOriginLabel, rangeLevel);
    const searchHints = usableSearchHints([
      ...areaHints(suppliedOriginLabel),
      ...areaHints(resolvedOriginLabel),
      ...rangeAreas
    ]);
    console.log("[search range]", JSON.stringify({
      suppliedOriginLabel,
      resolvedOriginLabel,
      rangeLevel,
      rangeStart: rangeAreas[0] || "",
      rangeAreas: rangeAreas.length
    }));

    if (mode === "theme-preview") {
      const themes = await Promise.all(Object.keys(THEME).map(async key => ({
        key,
        title: THEME[key].title,
        description: THEME[key].description,
        items: await searchTheme(key, origin, maxMinutes, originLabel, { preview: true, visitDate: value("visitDate"), searchHints, rangeAreas })
      })));
      return send(res, 200, { ok: true, transitEnabled: false, themes: uniquePreviewThemes(themes) }, policy);
    }
    if (mode === "theme") {
      const selectedThemes = uniqueStrings(String(value("themes") || value("theme") || "experience").split(","));
      const excludeIds = uniqueStrings(String(value("exclude") || "").split(",")).slice(0, 60);
      return send(res, 200, {
        ok: true,
        transitEnabled: false,
        items: await searchThemes(selectedThemes, origin, maxMinutes, originLabel, { visitDate: value("visitDate"), excludeIds, searchHints, rangeAreas })
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
module.exports.__test = { suitable, THEME, seasonQueries, themedQueries, areaHints, nearbyAreaHints, rangeAreaHints, canonicalSigunguName, areaNameFromReverseResponse, usableSearchHints, isResearchVenue, hasDirectChildActivity, isCulturalVenue, displayNameForPlace, isChildCraftVenue, isIndoorPlayVenue, isSeasonPlayVenue, compareCandidateQuality, isSuitableNearby, nearbySummary, dataRecords, currentCulturalProgram, childFriendlyCultureProgram, programPeriod, cultureVenueMatchScore, officialProgramEvidenceItem, compactCultureName, formatVisitDate, oneDayChildClass, cultureMallProvider, bestCultureBranch };
