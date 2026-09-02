const fs = require("node:fs");

// 별도의 base64 복사본을 두면 app.js가 바뀔 때 다운로드 파일만 과거 버전으로
// 남는다. 정적 require.resolve를 사용해 Vercel 번들에도 최신 app.js가 항상
// 포함되게 하고, 요청 때 그 파일을 그대로 내려보낸다.
const SOURCE_PATH = require.resolve("./app.js");

module.exports = function downloadCurrentApp(req, res) {
  const source = fs.readFileSync(SOURCE_PATH);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="app.js"');
  res.setHeader("Content-Length", String(source.length));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Oyukwan-Source-Version", "2026-09-01-provider-map-fix-v1");
  res.end(source);
};
