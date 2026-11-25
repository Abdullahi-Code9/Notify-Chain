import { createServer } from 'node:http';

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (request.method !== 'POST') {
    response.writeHead(405);
    response.end();
    return;
  }

  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }

  let rpcRequest;
  try {
    rpcRequest = JSON.parse(body);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }

  let result;
  if (rpcRequest.method === 'getLatestLedger') {
    result = { sequence: 100 };
  } else if (rpcRequest.method === 'getEvents') {
    result = { events: [], latestLedger: 100, cursor: '100' };
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: rpcRequest.id,
      error: { code: -32601, message: `Unsupported local RPC method: ${rpcRequest.method}` },
    }));
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: rpcRequest.id, result }));
});

server.listen(8000, '0.0.0.0');
