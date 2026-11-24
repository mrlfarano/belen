import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 8787)
let tokenPolls = 0

const server = createServer((req, res) => {
  if (req.url?.includes('ratelimit')) {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'rate limited' } }))
    return
  }

  if (req.url?.includes('/bad/')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
    res.write('data: {"broken":\n\n')
    res.write('data: {"choices":[{"delta":{"content":""}}]}\n\n')
    res.end()
    return
  }

  if (req.url === '/oauth/device') {
    tokenPolls = 0
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        device_code: 'device-code-123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://127.0.0.1:8787/oauth/activate',
        expires_in: 600,
        interval: 1,
      }),
    )
    return
  }

  if (req.url === '/oauth/token') {
    tokenPolls += 1
    if (tokenPolls < 2) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'authorization_pending' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        access_token: 'oauth-access-1',
        refresh_token: 'oauth-refresh-1',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    )
    return
  }

  if (req.url === '/oauth/refresh') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        access_token: 'oauth-access-2',
        refresh_token: 'oauth-refresh-2',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    )
    return
  }

  if (req.url === '/v1/oauth/chat/completions') {
    const auth = req.headers['authorization']
    if (auth !== 'Bearer oauth-access-1' && auth !== 'Bearer oauth-access-2') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'oauth ok' } }] }))
    return
  }

  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        data: [
          { id: 'mock-fast', object: 'model', context_length: 128000 },
          { id: 'mock-deep', object: 'model', context_length: 1000000 },
        ],
      }),
    )
    return
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        /* ignore */
      }

      if (parsed.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const words = ['The ', 'mock ', 'provider ', 'streams ', 'tokens ', 'cleanly.']
        let i = 0
        const timer = setInterval(() => {
          if (i < words.length) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`,
            )
          } else {
            res.write('data: [DONE]\n\n')
            clearInterval(timer)
            res.end()
          }
        }, 30)
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock provider listening on http://127.0.0.1:${PORT}/v1`)
})
