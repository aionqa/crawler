import http from 'http';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';

function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: '1', method, params });
  const url = new URL('/rpc', AGENT);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  try {
    const r = await rpc('health', {});
    console.log('AGENT_HEALTH_STATUS', r.status);
    console.log('AGENT_HEALTH_BODY', r.body);
    process.exit(r.status === 200 ? 0 : 1);
  } catch (e) {
    console.error('AGENT_HEALTH_ERROR', String(e.message || e));
    process.exit(2);
  }
})();




