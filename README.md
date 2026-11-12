# fetch-undici

Polyglot HTTP client wrapper for Node.js using Undici. Provides httpx-compatible API for seamless polyglot development.

## Installation

```bash
npm install fetch-undici
```

## Quick Start

### Convenience Functions

```typescript
import { get, post } from 'fetch-undici'

// GET request
const response = await get('https://api.example.com/users')
const users = await response.json()

// POST request with JSON
const created = await post('https://api.example.com/users', {
  json: { name: 'Alice', email: 'alice@example.com' }
})
```

### AsyncClient

```typescript
import { AsyncClient, BasicAuth } from 'fetch-undici'

const client = new AsyncClient({
  baseUrl: 'https://api.example.com',
  auth: new BasicAuth('user', 'pass'),
  timeout: { connect: 5000, read: 30000 }
})

const response = await client.get('/users')
response.raiseForStatus() // Throws if 4xx/5xx
const data = await response.json()

await client.close()
```

### Using `await using` (Node.js 20+)

```typescript
await using client = new AsyncClient({
  baseUrl: 'https://api.example.com'
})

const response = await client.get('/users')
// client.close() called automatically
```

## Features

- **httpx-compatible API** - Familiar patterns for Python developers
- **High performance** - Built on Undici, the fastest Node.js HTTP client
- **HTTP/2 support** - Enable with `http2: true`
- **Authentication** - BasicAuth, BearerAuth, DigestAuth
- **URL pattern routing** - MountRouter for multi-service architectures
- **Streaming** - `aiterBytes()`, `aiterText()`, `aiterLines()`
- **TLS/mTLS** - Full TLS configuration support
- **Proxy support** - HTTP proxy with authentication
- **Structured logging** - Verbose logging for debugging
- **SDK layer** - Specialized interfaces for CLI, LLM Agents, DevTools
- **Retry patterns** - Exponential backoff with jitter, circuit breaker

## Retry & Circuit Breaker

### Exponential Backoff with Jitter

```typescript
import { AsyncClient, JitterStrategy } from 'fetch-undici'

const client = new AsyncClient({
  baseUrl: 'https://api.example.com',
  retry: {
    maxRetries: 3,
    retryDelay: 500, // Initial delay 500ms
    retryBackoff: 2.0, // Double each retry
    maxRetryDelay: 30000, // Cap at 30 seconds
    jitter: JitterStrategy.FULL, // Recommended
    retryOnStatus: [429, 500, 502, 503, 504],
    retryOnException: true, // Retry on connection errors
    respectRetryAfter: true // Honor Retry-After header
  }
})

// Requests automatically retry on transient failures
const response = await client.get('/users')
await client.close()
```

### Jitter Strategies

```typescript
import { JitterStrategy } from 'fetch-undici'

// NONE - Exact exponential backoff (not recommended)
// FULL - Random between 0 and calculated delay (recommended)
// EQUAL - Half fixed, half random
// DECORRELATED - Based on previous delay (good for distributed systems)
```

### Circuit Breaker

```typescript
import { AsyncClient, CircuitBreaker } from 'fetch-undici'

const client = new AsyncClient({
  baseUrl: 'https://api.example.com',
  circuitBreaker: {
    failureThreshold: 5, // Open after 5 failures
    successThreshold: 2, // Close after 2 successes in half-open
    timeout: 30000 // Try half-open after 30 seconds
  }
})

// Access circuit state
console.log(client.circuitBreaker?.state) // 'closed', 'open', 'half_open'
console.log(client.circuitBreaker?.isOpen) // true/false
```

The breaker works with or without `retry`. It is checked before every request
(an open circuit throws `CircuitOpenError`), and every attempt records an
outcome: transport errors (timeouts, connection/socket/DNS errors) and failure
statuses (`retry.retryOnStatus`, default 429/500/502/503/504) count as failures;
any other completed response (including 4xx) counts as a success. Aborted
requests and errors thrown by hooks are not counted.

Retry details: discarded intermediate responses are closed before the next
attempt; `Retry-After` (integer seconds or HTTP-date) is honored and capped at
`maxRetryDelay`; timeouts and network errors are retried for idempotent
requests; jitter state is per request.

### Idempotency-Aware Retry

By default, only idempotent methods (GET, HEAD, OPTIONS, PUT, DELETE) are retried. POST/PATCH require an `Idempotency-Key` (or `X-Idempotency-Key`) header, set per request or in the client's default headers:

```typescript
// POST with idempotency key - will retry on failure
await client.post('/orders', {
  headers: { 'Idempotency-Key': 'unique-request-id' },
  json: { product: 'item-1', quantity: 1 }
})
```

## Response Caching

### CachingClient (Wrapper Pattern)

```typescript
import { CachingClient } from 'fetch-undici'

const client = new CachingClient({
  baseUrl: 'https://api.example.com',
  cache: {
    ttl: 60000, // 1 minute default TTL
    methods: ['GET', 'HEAD'], // Methods to cache
    maxEntries: 1000 // Max cache entries
  }
})

// First request - cache miss, fetches from network
const response1 = await client.get('/users')

// Second request - cache hit, returns cached data
const response2 = await client.get('/users')

// Manual cache operations
await client.cache.invalidate('GET:https://api.example.com/users')
await client.cache.invalidatePattern('GET:https://api.example.com/users/*')
await client.cache.clear()

await client.close()
```

### withCache HOF (Functional Pattern)

```typescript
import { request, withCache } from 'fetch-undici'

const cachedRequest = withCache(request, { ttl: 60000 })

const response = await cachedRequest('GET', 'https://api.example.com/users')

// Access cache manager
await cachedRequest.cache.invalidate('GET:https://api.example.com/users')
```

### Custom Cache Key Strategy (Dot Notation)

```typescript
import { CachingClient, createDotNotationKeyStrategy } from 'fetch-undici'

// Include specific request properties in cache key
const client = new CachingClient({
  baseUrl: 'https://api.example.com',
  cache: {
    ttl: 60000,
    keyStrategy: createDotNotationKeyStrategy([
      'headers.Authorization', // Different cache per user
      'params.page', // Different cache per page
      'body.filter' // Different cache per filter
    ])
  }
})

// Cache key: GET:https://api.example.com/users:headers.Authorization=Bearer ****:params.page=1
```

## Configuration

### Timeout

```typescript
import { AsyncClient, Timeout } from 'fetch-undici'

const client = new AsyncClient({
  timeout: new Timeout({
    connect: 5000, // Connection timeout (ms)
    read: 30000, // Read timeout - sets both headersTimeout and bodyTimeout
    write: 30000, // Write timeout (ms)
    pool: 5000, // Pool acquire timeout (ms)
    headersTimeout: 300000, // Time to receive HTTP headers (overrides read)
    bodyTimeout: 300000 // Time between body data chunks (overrides read)
  })
})
```

### Connection Limits

```typescript
import { AsyncClient, Limits } from 'fetch-undici'

const client = new AsyncClient({
  limits: new Limits({
    maxConnections: 100, // Total connections
    maxConnectionsPerHost: 10, // Connections per origin
    keepAliveTimeout: 30000, // Keep-alive timeout (ms)
    keepAliveMaxTimeout: 600000, // Max keep-alive timeout (ms)
    keepAliveTimeoutThreshold: 1000, // Subtracted from server hints (ms)
    maxConcurrentStreams: 100, // HTTP/2 concurrent streams
    maxHeaderSize: 16384, // Max header size (bytes)
    pipelining: 1 // Pipelining factor (1 = disabled)
  })
})
```

### HTTP/2 and Advanced Options

```typescript
import { AsyncClient } from 'fetch-undici'

const client = new AsyncClient({
  baseUrl: 'https://api.example.com',

  // HTTP/2 support
  http2: true, // Enable HTTP/2
  allowH2: true, // Allow HTTP/2 connections (default: true)

  // Response limits
  maxResponseSize: 10 * 1024 * 1024, // 10MB max response (-1 = disabled)

  // Pipelining
  pipelining: 1, // Pipelining factor (1 = no pipelining)

  // Custom connect options for socket creation
  connect: {
    timeout: 30000,
    keepAlive: true,
    keepAliveInitialDelay: 1000
  }
})
```

### Undici Interceptors

```typescript
import { AsyncClient } from 'fetch-undici'
import type { Dispatcher } from 'undici'

// Custom interceptor
const loggingInterceptor: Dispatcher.DispatchInterceptor = (dispatch) => {
  return (opts, handler) => {
    console.log(`Request: ${opts.method} ${opts.path}`)
    return dispatch(opts, handler)
  }
}

const client = new AsyncClient({
  baseUrl: 'https://api.example.com',
  interceptors: [loggingInterceptor]
})
```

### TLS/mTLS

```typescript
import { AsyncClient } from 'fetch-undici'
import { readFileSync } from 'fs'

// Skip verification (development only!)
const client1 = new AsyncClient({ verify: false })

// mTLS
const client2 = new AsyncClient({
  tls: {
    cert: readFileSync('/path/to/client.pem'),
    key: readFileSync('/path/to/client-key.pem'),
    ca: readFileSync('/path/to/ca.pem')
  }
})
```

### Proxy Configuration

```typescript
import { AsyncClient, Proxy } from 'fetch-undici'

// Simple proxy URL
const client1 = new AsyncClient({
  proxy: 'http://proxy.example.com:8080'
})

// Proxy with authentication
const client2 = new AsyncClient({
  proxy: new Proxy({
    url: 'http://proxy.example.com:8080',
    auth: {
      username: 'proxyuser',
      password: '*****'
    }
  })
})

// HTTPS proxy
const client3 = new AsyncClient({
  proxy: new Proxy({
    url: 'https://secure-proxy.example.com:443',
    auth: {
      username: 'user',
      password: 'pass'
    }
  })
})

// Use environment variables (http_proxy/HTTP_PROXY, https_proxy/HTTPS_PROXY, no_proxy/NO_PROXY)
const client4 = new AsyncClient({
  trustEnv: true
})

// Skip the proxy for some hosts (curl/httpx NO_PROXY semantics)
const client5 = new AsyncClient({
  proxy: new Proxy({ url: 'http://proxy.example.com:8080', noProxy: ['localhost', '.internal.example.com'] })
})
```

Hosts matching `noProxy` (or `NO_PROXY` with `trustEnv`) use a direct
connection. The client-created proxy follows redirects (per `followRedirects`)
and runs your `interceptors`.

#### Proxy with Custom Headers

```typescript
import { AsyncClient, Proxy } from 'fetch-undici'

const client = new AsyncClient({
  proxy: new Proxy({
    url: 'http://proxy.example.com:8080',
    headers: {
      'Proxy-Authorization': 'Basic ' + Buffer.from('user:pass').toString('base64'),
      'X-Proxy-Token': 'custom-token'
    }
  })
})
```

#### Using Undici ProxyAgent Directly

```typescript
import { AsyncClient } from 'fetch-undici'
import { ProxyAgent } from 'undici'

// For advanced proxy configurations, use Undici's ProxyAgent
const proxyAgent = new ProxyAgent({
  uri: 'http://proxy.example.com:8080',
  token: 'Basic ' + Buffer.from('user:pass').toString('base64'),
  requestTls: {
    // TLS options for requests through proxy
    rejectUnauthorized: true
  }
})

const client = new AsyncClient({
  mounts: {
    'https://': proxyAgent // Route all HTTPS through proxy
  }
})
```

#### ProxyAgent with Redirect Support

When using `ProxyAgent` with mounts, redirect handling requires Undici's
`interceptors.redirect` since `ProxyAgent` does not support the `maxRedirections`
request option directly:

```typescript
import { ProxyAgent, interceptors } from 'undici'

const proxyAgent = new ProxyAgent({ uri: 'http://proxy:8080' })

// Compose with redirect interceptor
const redirectEnabledProxy = proxyAgent.compose(
  interceptors.redirect({ maxRedirections: 10 })
)

const client = new AsyncClient({
  mounts: {
    'https://': redirectEnabledProxy
  },
  followRedirects: false  // Disable client-level redirect handling since interceptor handles it
})
```

#### Environment-Based Proxy

```typescript
import { AsyncClient, getEnvProxy } from 'fetch-undici'

// Automatically reads HTTP_PROXY, HTTPS_PROXY, NO_PROXY
const envProxy = getEnvProxy()
console.log('HTTP Proxy:', envProxy.http?.url)
console.log('HTTPS Proxy:', envProxy.https?.url)
console.log('No Proxy:', envProxy.noProxy)

// Or let AsyncClient handle it
const client = new AsyncClient({
  baseUrl: 'https://api.example.com',
  trustEnv: true // Uses environment proxy settings
})
```

#### Selective Proxy Routing

```typescript
import { AsyncClient } from 'fetch-undici'
import { ProxyAgent, Pool } from 'undici'

// Different proxies for different destinations
const client = new AsyncClient({
  mounts: {
    // Internal API - direct connection
    'https://api.internal.com/': new Pool('https://api.internal.com'),

    // External APIs - through corporate proxy
    'https://external.api.com/': new ProxyAgent({
      uri: 'http://corporate-proxy:8080'
    }),

    // Default - through general proxy
    'https://': new ProxyAgent({
      uri: 'http://general-proxy:8080'
    })
  }
})

// Requests automatically routed
await client.get('https://api.internal.com/users') // Direct
await client.get('https://external.api.com/data') // Corporate proxy
await client.get('https://other.example.com/resource') // General proxy
```

#### Pool with Proxy (Connection Pooling via Proxy)

To route pooled connections through a proxy, use `ProxyAgent` with pool-level configuration:

```typescript
import { ProxyAgent } from 'undici'

// ProxyAgent with connection pool settings
const proxyPool = new ProxyAgent({
  uri: 'http://proxy.example.com:8080',
  token: 'Basic ' + Buffer.from('user:pass').toString('base64'),

  // Pool options for connections through proxy
  connections: 100,              // Max connections in pool
  keepAliveTimeout: 60000,       // Keep-alive timeout (ms)
  keepAliveMaxTimeout: 120000,   // Max keep-alive timeout (ms)
  pipelining: 1,                 // HTTP pipelining factor

  // TLS options for the connection to proxy
  proxyTls: {
    rejectUnauthorized: true
  },

  // TLS options for the tunneled connection to target
  requestTls: {
    rejectUnauthorized: true,
    ca: readFileSync('/path/to/ca.pem') // Custom CA for target
  }
})

// Use with AsyncClient
const client = new AsyncClient({
  mounts: {
    'https://': proxyPool
  }
})

// All HTTPS requests go through the proxy with connection pooling
const response = await client.get('https://api.example.com/users')
```

#### Direct Pool Requests via Proxy

For lower-level control, use `ProxyAgent.request()` directly:

```typescript
import { ProxyAgent } from 'undici'

const proxy = new ProxyAgent({
  uri: 'http://proxy.example.com:8080',
  connections: 50,
  keepAliveTimeout: 30000
})

// Make pooled requests through proxy
const response = await proxy.request({
  origin: 'https://api.example.com',
  path: '/users',
  method: 'GET',
  headers: {
    'Accept': 'application/json'
  }
})

const data = await response.body.json()

// Clean up
await proxy.close()
```

#### Pool with SOCKS Proxy

For SOCKS proxies, use the `socks-proxy-agent` package with undici:

```typescript
import { setGlobalDispatcher, Agent } from 'undici'
import { SocksProxyAgent } from 'socks-proxy-agent'

// Create SOCKS proxy agent
const socksAgent = new SocksProxyAgent('socks5://proxy.example.com:1080')

// For fetch-undici, use with custom dispatcher
import { AsyncClient } from 'fetch-undici'

const client = new AsyncClient({
  baseUrl: 'https://api.example.com',
  // Pass custom connect options for SOCKS
  mounts: {
    'https://': new Agent({
      connect: {
        // Custom connect function for SOCKS
      }
    })
  }
})
```

## Authentication

### Basic Auth

```typescript
import { BasicAuth } from 'fetch-undici'
const auth = new BasicAuth('username', 'password')
```

### Bearer Token

```typescript
import { BearerAuth } from 'fetch-undici'
const auth = new BearerAuth('your-jwt-token')
```

### Digest Auth

```typescript
import { AsyncClient, DigestAuth } from 'fetch-undici'
const client = new AsyncClient({ auth: new DigestAuth('username', 'password') })
await client.get('https://example.com/protected')
```

The client answers one `401` Digest challenge automatically: the first request
goes out without credentials, the 401 is closed, and the request is re-sent
with the computed `Authorization` header (request hooks run for both). Later
requests reuse the challenge. A request whose body is a stream cannot be
replayed, so its 401 is returned as-is.

`BearerAuth` accepts an async token provider (`new BearerAuth(async () => token)`);
the client awaits it for every request.

## URL Pattern Routing (Mounts)

```typescript
import { AsyncClient, createPool } from 'fetch-undici'
import { Pool } from 'undici'

const client = new AsyncClient({
  mounts: {
    'https://api.internal.com/': new Pool('https://api.internal.com', {
      connections: 50
    }),
    'https://': new Pool('https://default', { connections: 10 }),
    'all://': new Pool('http://fallback', { connections: 5 })
  }
})
```

### AsyncClientPool (Shared Dispatchers & Pool Types)

`AsyncClientPool` supports both shared dispatchers and built-in pool management
with Pool, BalancedPool and RoundRobinPool types.

With the `pool` option, the created pool is mounted for each of its origins, so
requests to those origins (including relative URLs) go through it. If no
`baseUrl` is given, it defaults to the first origin. Requests to other origins
use the normal per-origin dispatchers. Note: requests through the built-in pool
or through mounted dispatchers do not follow redirects unless the dispatcher
does it itself (or you pass `followRedirects: true` per request).

#### Shared Dispatchers

When sharing dispatchers across multiple clients, use `AsyncClientPool` to prevent
the dispatcher from being closed when a single client closes:

```typescript
import { AsyncClientPool } from 'fetch-undici'
import { ProxyAgent } from 'undici'

// Shared singleton proxy agent
const sharedProxy = new ProxyAgent({ uri: 'http://proxy:8080' })

// Create clients that share the proxy agent
const client1 = new AsyncClientPool({
  mounts: { 'https://': sharedProxy }
})

const client2 = new AsyncClientPool({
  mounts: { 'https://': sharedProxy }
})

// Use clients
await client1.get('https://api.example.com/users')
await client2.get('https://api.example.com/orders')

// Close client1 - sharedProxy stays open for client2!
await client1.close()

// client2 can still use sharedProxy
await client2.get('https://api.example.com/products')

// When done with all clients, close the shared dispatcher manually
await client2.close()
await sharedProxy.close()
```

#### Pool Types

`AsyncClientPool` supports three pool types:

| Type | Description | Use Case |
|------|-------------|----------|
| `pool` | Standard connection pool to a single origin | Single API endpoint |
| `balanced` | Load-balanced pool across multiple origins (least-busy) | Multiple API replicas |
| `round-robin` | Round-robin connection selection for single origin | Even connection distribution |

#### Standard Pool (Single Origin)

```typescript
import { AsyncClientPool, PoolType } from 'fetch-undici'

const client = new AsyncClientPool({
  pool: {
    type: PoolType.POOL, // or 'pool'
    origins: 'https://api.example.com',
    connections: 50 // Max connections in pool
  }
})

await client.get('/users')

// Access pool stats
console.log(client.stats) // { connected, free, pending, queued, running, size }

await client.close()
```

#### BalancedPool (Multiple Origins)

Load-balance requests across multiple origins using least-busy algorithm:

```typescript
import { AsyncClientPool, PoolType } from 'fetch-undici'

const client = new AsyncClientPool({
  pool: {
    type: PoolType.BALANCED, // or 'balanced'
    origins: [
      'https://api1.example.com',
      'https://api2.example.com',
      'https://api3.example.com'
    ],
    connections: 10 // Per-origin connection limit
  }
})

// Requests to any of the origins are load-balanced
// (baseUrl defaults to the first origin)
await client.get('/users') // -> api1, api2, or api3

// View current upstreams
console.log(client.upstreams) // ['https://api1...', 'https://api2...', ...]

// Dynamically add/remove upstreams
client.addUpstream('https://api4.example.com')
client.removeUpstream('https://api1.example.com')

await client.close()
```

#### RoundRobinPool (Single Origin, Round-Robin Connections)

Cycle through connections to a single origin in round-robin fashion:

```typescript
import { AsyncClientPool, PoolType } from 'fetch-undici'

const client = new AsyncClientPool({
  pool: {
    type: PoolType.ROUND_ROBIN, // or 'round-robin'
    origins: 'https://api.example.com',
    connections: 10,
    clientTtl: 60000 // Optional: client TTL in ms before removal
  }
})

// Requests are spread across the pool's connections (round-robin selection;
// see round-robin.md for the exact order)
await client.get('/users')

// Access pool stats
console.log(client.stats)

await client.close()
```

#### Helper Functions

```typescript
import {
  createClientPool,
  createBalancedPool,
  createRoundRobinPool,
  AsyncClientPool
} from 'fetch-undici'

// Create pools directly
const pool = createClientPool('https://api.example.com', { connections: 10 })
const balancedPool = createBalancedPool([
  'https://api1.example.com',
  'https://api2.example.com'
], { connections: 10 })
const rrPool = createRoundRobinPool('https://api.example.com', {
  connections: 10,
  clientTtl: 60000
})

// Use with mounts for fine-grained routing
const client = new AsyncClientPool({
  mounts: {
    'https://api.example.com/': pool,
    'https://rr.example.com/': rrPool,
    'https://': balancedPool
  }
})
```

#### Mounts with AsyncClient vs AsyncClientPool

Both `AsyncClient` and `AsyncClientPool` accept `mounts` for routing requests to
specific dispatchers. The key difference is **dispatcher ownership**:

| Client | On `close()` | Use Case |
|--------|--------------|----------|
| `AsyncClient` | Closes all mounted dispatchers | Single client, exclusive pool ownership |
| `AsyncClientPool` | Does NOT close mounted dispatchers | Shared pools across multiple clients |

**Using AsyncClient with Mounts (Exclusive Ownership)**

```typescript
import { AsyncClient, createRoundRobinPool, createBalancedPool } from 'fetch-undici'

const rrPool = createRoundRobinPool('https://api.example.com', { connections: 10 })
const balancedPool = createBalancedPool([
  'https://api1.example.com',
  'https://api2.example.com'
])

const client = new AsyncClient({
  mounts: {
    'https://api.example.com/': rrPool,
    'https://': balancedPool
  }
})

await client.get('https://api.example.com/users')  // Uses rrPool
await client.get('https://other.example.com/data') // Uses balancedPool

await client.close()  // ⚠️ Both rrPool and balancedPool are closed!
```

**Using AsyncClientPool with Mounts (Shared Ownership)**

```typescript
import { AsyncClientPool, createRoundRobinPool } from 'fetch-undici'

// Shared singleton pool
const sharedPool = createRoundRobinPool('https://api.example.com', {
  connections: 10,
  clientTtl: 60000
})

// Multiple clients share the same pool
const client1 = new AsyncClientPool({
  baseUrl: 'https://api.example.com',
  mounts: { 'https://': sharedPool }
})

const client2 = new AsyncClientPool({
  baseUrl: 'https://api.example.com',
  mounts: { 'https://': sharedPool }
})

// Both clients use the same underlying connections
await client1.get('/users')
await client2.get('/orders')

// Close clients - sharedPool stays open!
await client1.close()
await client2.close()

// Manually close the shared pool when completely done
await sharedPool.close()
```

**When to Use Which**

- Use `AsyncClient` when:
  - You have a single client with dedicated pools
  - Pools should be automatically cleaned up with the client

- Use `AsyncClientPool` when:
  - Multiple clients need to share the same pool/dispatcher
  - You're using a global ProxyAgent or connection pool
  - You need fine-grained control over pool lifecycle

## Response Handling

```typescript
const response = await client.get('/users')

// Status properties
response.ok // true for 2xx
response.isRedirect // true for 3xx
response.isClientError // true for 4xx
response.isServerError // true for 5xx

// Body methods
await response.json()
await response.text()
await response.bytes()

// Error handling
response.raiseForStatus() // Throws HTTPStatusError if 4xx/5xx

// Release an unread body (frees the connection)
await response.aclose()
```

Notes:
- Redirects are followed by default (`followRedirects: true`, `maxRedirects: 10`;
  both overridable per request with `followRedirects`). `response.url` and
  `response.request` reflect the final URL. Exceeding `maxRedirects` or a
  redirect loop throws `TooManyRedirectsError`. `response.history` is not
  populated (always `[]`).
- Responses are **not** decompressed: a `Content-Encoding: gzip` body is
  returned as raw gzip bytes.
- Errors raised while reading the body are library errors too
  (`ReadTimeoutError` for body timeouts, `StreamError` for `maxResponseSize`,
  `SocketError` for a connection reset).

## Streaming

```typescript
// Byte streaming
for await (const chunk of response.aiterBytes()) {
  console.log(`Received ${chunk.length} bytes`)
}

// Text streaming
for await (const text of response.aiterText()) {
  console.log(text)
}

// Line streaming (NDJSON, SSE)
for await (const line of response.aiterLines()) {
  const event = JSON.parse(line)
}
```

## SDK Usage

### CLI Context

```typescript
import { CLIContext } from 'fetch-undici/sdk'

const cli = new CLIContext({
  baseUrl: 'https://api.example.com',
  verbose: true
})

// Resolves after the file is fully written; write errors return { success: false, exitCode: 1 }
const result = await cli.download('/files/data.zip', {
  output: './data.zip',
  onProgress: (downloaded, total) => {
    console.log(`${((downloaded / total) * 100).toFixed(1)}%`)
  }
})

process.exit(result.exitCode)
```

### LLM Agent Context

```typescript
import { AgentHTTPClient } from 'fetch-undici/sdk'

const agent = new AgentHTTPClient({
  baseUrl: 'https://api.example.com'
})

const result = await agent.get('/users')
// Returns structured response with suggestions:
// { success: true, statusCode: 200, data: [...], summary: "GET /users returned 25 items", headers, duration }
// Objects: "GET /users/1 returned object with keys: id, name, ..." (first 5 keys)
// Errors never throw: { success: false, statusCode: 0 | 4xx | 5xx, error, suggestion, summary }
// Network errors are classified by type (timeout, DNS, connection refused/reset, TLS, proxy, redirects)
```

### SDK (retrying envelope client)

```typescript
import { createSDK } from 'fetch-undici/sdk'

const sdk = createSDK({
  baseUrl: 'https://api.example.com',
  auth: { type: 'api-key', apiKey: 'k', headerName: 'X-API-Key' }, // or 'basic' | 'bearer' | 'custom'
  maxRetries: 3
})
const res = await sdk.get('/users') // { success, statusCode, data?, error?, headers, duration }
```

Response headers in SDK/agent envelopes are `Record<string, string | string[]>`;
repeated headers (e.g. `set-cookie`) are arrays.

### Pool singletons

`getPool(origin, config)` returns one `PoolClient` per origin. The config only
applies when the pool is created; later calls return the existing pool (a
warning is logged if a config is passed). Closed pools are removed from
`getActivePoolOrigins()`. JSON helpers return `undefined` for an empty body
(e.g. 204) and throw `HTTPStatusError` (message `HTTP <status>: <body>`) for
status >= 400.

## Logging

Set `LOG_LEVEL` environment variable: `trace`, `debug`, `info`, `warn`, `error`

```bash
LOG_LEVEL=debug node app.js
```

## API Reference

### Convenience Functions

- `get(url, options?)` - GET request
- `post(url, options?)` - POST request
- `put(url, options?)` - PUT request
- `patch(url, options?)` - PATCH request
- `del(url, options?)` - DELETE request
- `head(url, options?)` - HEAD request
- `options(url, options?)` - OPTIONS request

### Classes

- `AsyncClient` - Main HTTP client
- `AsyncClientPool` - HTTP client with Pool/BalancedPool/RoundRobinPool support
- `PoolType` - Pool type enum (`POOL`, `BALANCED`, `ROUND_ROBIN`)
- `Timeout` - Timeout configuration
- `Limits` - Connection limits
- `TLSConfig` - TLS configuration
- `Proxy` - Proxy configuration
- `BasicAuth`, `BearerAuth`, `DigestAuth` - Authentication
- `Headers` - HTTP headers
- `Request`, `Response` - HTTP messages
- `MountRouter` - URL pattern routing
- `CircuitBreaker` - Circuit breaker pattern
- `JitterStrategy` - Jitter strategies enum
- `CachingClient` - HTTP client with built-in caching
- `CacheManager` - Core caching logic
- `MemoryStorage` - In-memory cache storage

### AsyncClientOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | - | Base URL for all requests |
| `headers` | `HeadersInit` | - | Default headers |
| `auth` | `Auth` | - | Authentication handler |
| `timeout` | `Timeout \| TimeoutOptions \| number` | - | Timeout configuration |
| `limits` | `Limits \| LimitsOptions` | - | Connection limits |
| `tls` | `TLSConfig \| boolean` | - | TLS configuration |
| `proxy` | `Proxy \| ProxyOptions \| string` | - | Proxy configuration (honors `noProxy`) |
| `http2` | `boolean` | `false` | Enable HTTP/2 |
| `allowH2` | `boolean` | `true` | Allow HTTP/2 connections |
| `maxResponseSize` | `number` | `-1` | Max response size (-1 = disabled) |
| `pipelining` | `number` | `1` | Pipelining factor |
| `connect` | `ConnectOptions` | - | Custom socket connect options |
| `interceptors` | `DispatchInterceptor[]` | - | Undici interceptors |
| `followRedirects` | `boolean` | `true` | Follow HTTP redirects (overridable per request) |
| `maxRedirects` | `number` | `10` | Maximum redirects (exceeding it throws `TooManyRedirectsError`) |
| `retry` | `RetryConfig` | - | Retry configuration |
| `circuitBreaker` | `CircuitBreakerConfig` | - | Circuit breaker configuration |

### TimeoutOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connect` | `number \| null` | `5000` | Connection timeout (ms) |
| `read` | `number \| null` | `30000` | Read timeout (headers + body) |
| `write` | `number \| null` | `30000` | Write timeout (ms) |
| `pool` | `number \| null` | `5000` | Pool acquire timeout (ms) |
| `headersTimeout` | `number \| null` | - | Headers timeout (overrides read) |
| `bodyTimeout` | `number \| null` | - | Body timeout (overrides read) |

### LimitsOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxConnections` | `number \| null` | `100` | Total connections |
| `maxConnectionsPerHost` | `number \| null` | `10` | Connections per origin |
| `keepAliveTimeout` | `number` | `30000` | Keep-alive timeout (ms) |
| `keepAliveMaxTimeout` | `number` | `600000` | Max keep-alive timeout (ms) |
| `keepAliveTimeoutThreshold` | `number` | `1000` | Subtracted from server hints (ms) |
| `maxConcurrentStreams` | `number` | - | HTTP/2 concurrent streams |
| `maxHeaderSize` | `number` | - | Max header size (bytes) |
| `pipelining` | `number` | `1` | Pipelining factor |

### PoolOptions (AsyncClientPool)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `type` | `PoolType \| 'pool' \| 'balanced' \| 'round-robin'` | `'pool'` | Pool type |
| `origins` | `string \| string[] \| URL \| URL[]` | - | Origin(s) for the pool |
| `connections` | `number \| null` | `null` | Max connections (null = unlimited) |
| `factory` | `Function` | - | Custom dispatcher factory |
| `clientTtl` | `number \| null` | `null` | Client TTL in ms (RoundRobinPool only) |

### Exceptions

- `HTTPError` - Base error
- `HTTPStatusError` - HTTP 4xx/5xx errors
- `TimeoutError` - Timeout errors
- `NetworkError` - Network errors
- `TooManyRedirectsError` - Redirect limit exceeded
- `CircuitOpenError` - Circuit breaker is open

## License

MIT
