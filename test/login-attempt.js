import http from 'http';

const BACK_URL = process.env.BACK_URL || 'http://127.0.0.1:3000';
const urlToTest = process.env.TEST_URL || 'https://practicetestautomation.com/practice-test-login/';

function post(path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const url = new URL(path, BACK_URL);
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
    const payload = {
      url: urlToTest,
      credentials: { username: 'student', password: 'Password123' },
      options: { maxWaitMsPerAction: 60000, maxRetries: 2, headless: true }
    };
    const r = await post('/login/attempt', payload);
    console.log('LOGIN_ATTEMPT_STATUS', r.status);
    console.log('LOGIN_ATTEMPT_BODY', r.body);
    process.exit(r.status === 200 ? 0 : 1);
  } catch (e) {
    console.error('LOGIN_ATTEMPT_ERROR', String(e.message || e));
    process.exit(2);
  }
})();


