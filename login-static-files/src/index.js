import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3004;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'login-static' });
});

// Basic RPC endpoint structure
app.post('/rpc', (req, res) => {
  const { method, params } = req.body;
  
  if (method === 'login') {
    // TODO: Implement login logic
    res.json({
      success: true,
      message: 'Login-static service is running',
      method: method,
      params: params
    });
  } else {
    res.status(400).json({
      error: 'Unknown method',
      method: method
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[login-static] Server running on port ${PORT}`);
  console.log(`[login-static] Health check: http://localhost:${PORT}/health`);
});
