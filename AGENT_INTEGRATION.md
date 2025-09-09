# Agent Integration (Backend <-> Crawlers/Login)

- Transport: HTTP JSON-RPC 2.0 to each agent's /rpc.
- Request example:
  {"jsonrpc":"2.0","id":"1","method":"attemptLogin","params":{"url":"https://practicetestautomation.com/practice-test-login/","credentials":{"username":"student","password":"Password123"},"options":{"maxWaitMsPerAction":60000,"maxRetries":2}}}
- Response: {"jsonrpc":"2.0","id":"1","result": { messages: [...], data: {...}, timestamp }}
- Chat-like messages are returned instead of logs. Backend can display and allow follow-up commands.
