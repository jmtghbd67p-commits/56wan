const LIVE_API_ORIGIN = 'https://56wan-465f9i6yo-wk9q6nbk4w-4956.vercel.app';

module.exports = async function handler(req, res) {
  try {
    const upstream = await fetch(`${LIVE_API_ORIGIN}${req.url}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.setHeader('cache-control', upstream.headers.get('cache-control') || 'public, max-age=0, must-revalidate');
    res.setHeader('x-56wan-api-proxy', '1');
    res.send(body);
  } catch {
    res.status(502).json({ ok: false, error: '추천 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }
};
