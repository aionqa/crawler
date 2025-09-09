import http from 'http';

const BACK_URL = process.env.BACK_URL || 'http://127.0.0.1:3000';

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, BACK_URL), { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  try {
    const r = await request('/healthz');
    console.log('BACK_HEALTH_STATUS', r.status);
    console.log('BACK_HEALTH_BODY', r.body);
    process.exit(r.status === 200 ? 0 : 1);
  } catch (e) {
    console.error('BACK_HEALTH_ERROR', String(e.message || e));
    process.exit(2);
  }
})();


