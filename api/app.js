
const KAKAO = process.env.KAKAO_REST_KEY;
const NAVER_ID = process.env.NAVER_API_KEY_ID;
const NAVER_SECRET = process.env.NAVER_API_KEY_SECRET;
const NAVER_BASE = "https://naverapihub.apigw.ntruss.com";

function send(res, status, data){
  res.statusCode=status;
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.setHeader("Cache-Control","no-store");
  res.end(JSON.stringify(data));
}
async function readBody(req){
  if(req.body && typeof req.body==="object") return req.body;
  let s=""; for await(const c of req) s+=c;
  try{return s?JSON.parse(s):{}}catch{return {}}
}
function needKeys(kind="kakao"){
  if(kind==="kakao" && !KAKAO) throw new Error("Vercel 환경변수 KAKAO_REST_KEY가 없습니다.");
  if(kind==="naver" && (!NAVER_ID || !NAVER_SECRET)) throw new Error("Vercel 환경변수 NAVER_API_KEY_ID / NAVER_API_KEY_SECRET가 없습니다.");
}
async function kakaoGet(url){
  needKeys("kakao");
  const r=await fetch(url,{headers:{Authorization:`KakaoAK ${KAKAO}`}});
  const t=await r.text(); let d; try{d=JSON.parse(t)}catch{d={raw:t}};
  if(!r.ok) throw new Error(d?.message||d?.msg||`Kakao API ${r.status}`);
  return d;
}
async function kakaoPost(url, body){
  needKeys("kakao");
  const r=await fetch(url,{method:"POST",headers:{Authorization:`KakaoAK ${KAKAO}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const t=await r.text(); let d; try{d=JSON.parse(t)}catch{d={raw:t}};
  if(!r.ok) throw new Error(d?.message||d?.msg||`Kakao Mobility ${r.status}`);
  return d;
}
function hav(a,b){
  const R=6371, p=Math.PI/180;
  const dlat=(b.y-a.y)*p, dlon=(b.x-a.x)*p;
  const s=Math.sin(dlat/2)**2+Math.cos(a.y*p)*Math.cos(b.y*p)*Math.sin(dlon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
async function geocode(q){
  let u=`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(q)}`;
  let d=await kakaoGet(u);
  if(d.documents?.length){
    const x=d.documents[0]; return {x:+x.x,y:+x.y,name:x.address_name||q};
  }
  u=`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=1`;
  d=await kakaoGet(u);
  if(d.documents?.length){
    const x=d.documents[0]; return {x:+x.x,y:+x.y,name:x.place_name||q};
  }
  throw new Error("출발지를 찾지 못했습니다.");
}
const AGE_Q={
 "1~2세":["아기랑 가볼만한 곳","키즈카페","아쿠아리움","동물원","수목원","어린이 체험"],
 "3~4세":["어린이 체험관","어린이박물관","키즈 체험","동물 체험","어린이과학관","실내놀이터","수목원","어린이미술관"],
 "5~6세":["어린이 과학관","체험 박물관","동물원","놀이공원","어린이 미술관","수목원","키즈 체험"],
 "7세+":["과학관","박물관 체험","놀이공원","동물원","수목원","미술관","체험관"]
};
async function keyword(q, origin, radius=null, size=15){
  const p=new URLSearchParams({query:q,x:String(origin.x),y:String(origin.y),sort:"distance",size:String(size)});
  if(radius) p.set("radius",String(radius));
  const d=await kakaoGet(`https://dapi.kakao.com/v2/local/search/keyword.json?${p}`);
  return d.documents||[];
}
async function category(code, origin, radius=5000, size=15){
  const p=new URLSearchParams({category_group_code:code,x:String(origin.x),y:String(origin.y),sort:"distance",radius:String(radius),size:String(size)});
  const d=await kakaoGet(`https://dapi.kakao.com/v2/local/search/category.json?${p}`);
  return d.documents||[];
}
async function matrix(origin, docs){
  if(!docs.length) return [];
  const dest=docs.slice(0,30).map((d,i)=>({x:+d.x,y:+d.y,key:String(i)}));
  const r=await kakaoPost("https://apis-navi.kakaomobility.com/v1/destinations/directions",{
    origin:{x:+origin.x,y:+origin.y},
    destinations:dest,
    radius:5000,
    priority:"TIME"
  });
  const byKey=new Map((r.routes||[]).filter(x=>x.result_code===0).map(x=>[x.key,x]));
  return dest.map((z,i)=>{
    const route=byKey.get(String(i));
    if(!route) return null;
    return { ...docs[i], route_minutes:Math.round(route.summary.duration/60), route_distance:route.summary.distance };
  }).filter(Boolean);
}
function normalize(d){
  return {
    id:d.id, name:d.place_name, category:d.category_name, category_group_code:d.category_group_code,
    address:d.address_name, road_address:d.road_address_name, phone:d.phone, place_url:d.place_url,
    x:+d.x,y:+d.y,distance_m:+d.distance||null,route_minutes:d.route_minutes,route_distance:d.route_distance
  };
}
async function searchMain(origin, age, maxMinutes){
  const queries=AGE_Q[age]||AGE_Q["3~4세"];
  let all=[], hit=new Map();
  for(const q of queries){
    const arr=await keyword(q,origin,null,15);
    for(const d of arr){
      if(!d.id) continue;
      if((d.category_name||"").includes("음식점")) continue;
      if(!hit.has(d.id)){hit.set(d.id,{...d,hits:0});all.push(hit.get(d.id))}
      hit.get(d.id).hits++;
    }
  }
  const rough=maxMinutes<=40?55:100;
  all=all.filter(d=>hav(origin,{x:+d.x,y:+d.y})<=rough)
         .sort((a,b)=>(b.hits-a.hits)||((+a.distance||999999)-(+b.distance||999999)))
         .slice(0,30);
  const routed=await matrix(origin,all);
  return routed.filter(x=>x.route_minutes<=maxMinutes)
    .map(x=>({...normalize(x),hits:x.hits||1}))
    .sort((a,b)=>(b.hits-a.hits)||(a.route_minutes-b.route_minutes));
}
async function searchNearby(origin, type){
  let arr=[];
  if(type==="food") arr=await category("FD6",origin,5000,15);
  else if(type==="cafe") arr=await category("CE7",origin,5000,15);
  else{
    for(const q of ["어린이 놀이터","공원","도서관","체험","박물관"]){
      const xs=await keyword(q,origin,7000,8); arr.push(...xs);
    }
    const m=new Map(); arr.forEach(d=>{if(d.id&&!m.has(d.id))m.set(d.id,d)}); arr=[...m.values()];
    arr=arr.filter(d=>!["FD6","CE7"].includes(d.category_group_code)).slice(0,20);
  }
  const routed=await matrix(origin,arr.slice(0,20));
  return routed.map(normalize).sort((a,b)=>a.route_minutes-b.route_minutes).slice(0,8);
}
async function naver(path, params){
  needKeys("naver");
  const u=new URL(NAVER_BASE+path);
  Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,String(v)));
  u.searchParams.set("format","json");
  const r=await fetch(u,{headers:{"X-NCP-APIGW-API-KEY-ID":NAVER_ID,"X-NCP-APIGW-API-KEY":NAVER_SECRET}});
  const t=await r.text(); let d; try{d=JSON.parse(t)}catch{d={raw:t}};
  if(!r.ok) throw new Error(`NAVER API ${r.status}`);
  return d;
}
async function naverEnrich(name, address=""){
  const q=[name,address.split(" ").slice(0,2).join(" ")].filter(Boolean).join(" ");
  const [images,blogs,cafes,ops,book,local]=await Promise.all([
    naver("/search/v1/image",{query:q,display:2,start:1,sort:"sim",filter:"large"}).catch(()=>({items:[]})),
    naver("/search/v1/blog",{query:`${q} 아이`,display:3,start:1,sort:"sim"}).catch(()=>({items:[]})),
    naver("/search/v1/cafearticle",{query:`${q} 아이`,display:2,start:1,sort:"sim"}).catch(()=>({items:[]})),
    naver("/search/v1/webkr",{query:`${q} 영업시간 휴무`,display:3,start:1}).catch(()=>({items:[]})),
    naver("/search/v1/webkr",{query:`${q} 네이버 예약`,display:3,start:1}).catch(()=>({items:[]})),
    naver("/search/v1/local",{query:q,display:1,start:1,sort:"comment"}).catch(()=>({items:[]}))
  ]);
  const booking=(book.items||[]).find(x=>/booking\.naver\.com|m\.booking\.naver\.com/.test(x.link||""))||null;
  return {images:images.items||[],blogs:blogs.items||[],cafes:cafes.items||[],operations:ops.items||[],booking,local:local.items||[]};
}
module.exports=async function(req,res){
  try{
    const mode=req.query?.mode || new URL(req.url,"http://x").searchParams.get("mode");
    if(mode==="health") return send(res,200,{ok:true,kakao:!!KAKAO,naver:!!(NAVER_ID&&NAVER_SECRET)});
    if(mode==="geocode"){
      const q=req.query?.q || new URL(req.url,"http://x").searchParams.get("q") || "";
      return send(res,200,{ok:true,origin:await geocode(q)});
    }
    if(mode==="naver"){
      const u=new URL(req.url,"http://x"); const name=u.searchParams.get("name")||"", address=u.searchParams.get("address")||"";
      return send(res,200,{ok:true,data:await naverEnrich(name,address)});
    }
    const body=await readBody(req);
    if(mode==="main"){
      const x=+body.x,y=+body.y,age=body.age||"3~4세",maxMinutes=+body.maxMinutes||40;
      return send(res,200,{ok:true,items:await searchMain({x,y},age,maxMinutes)});
    }
    if(mode==="nearby"){
      const x=+body.x,y=+body.y,type=body.type||"sub";
      return send(res,200,{ok:true,items:await searchNearby({x,y},type)});
    }
    return send(res,400,{ok:false,error:"unknown mode"});
  }catch(e){console.error(e);return send(res,500,{ok:false,error:e.message||String(e)})}
}
