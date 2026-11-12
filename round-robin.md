# Round-Robin Connection Strategies

This document covers round-robin connection selection strategies in fetch-undici and undici.

## Connection Selection Comparison

| Dispatcher | Selection Algorithm | Use Case |
|------------|---------------------|----------|
| `Pool` | Picks available/idle connection | Standard single-origin pooling |
| `RoundRobinPool` | Round-robin over its connections (all are used; not a strict 1 → 2 → 3 order) | Even distribution to single origin |
| `BalancedPool` | Least-busy upstream | Load balancing across multiple origins |
| `ProxyAgent` | Picks available connection (like Pool) | Proxy with connection pooling |

## Key Insight

`RoundRobinPool` and `ProxyAgent` serve different purposes:

- **RoundRobinPool**: Single origin, spreads requests over its connections. Observed with undici 7 and `connections: 3`, sequential requests used connections 1, 2, 3, 2, 3, 2 — every connection is used, but the order is not a strict 1 → 2 → 3 → 1 cycle. For a strict cycle, use the `RoundRobinDispatcher` wrapper below.
- **ProxyAgent**: Routes through proxy, but does NOT round-robin connections

## Round-Robin Through Proxy

`ProxyAgent` does not provide round-robin connection selection. To achieve round-robin behavior through a proxy, create a custom dispatcher wrapper.

### Custom RoundRobinDispatcher

```typescript
import { Dispatcher, ProxyAgent } from 'undici'

/**
 * Round-robin dispatcher that cycles through multiple dispatchers
 */
class RoundRobinDispatcher extends Dispatcher {
  private _dispatchers: Dispatcher[] = []
  private _currentIndex = 0
  private _closed = false

  constructor(dispatchers: Dispatcher[]) {
    super()
    this._dispatchers = dispatchers
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (this._dispatchers.length === 0) {
      throw new Error('No dispatchers available')
    }
    const dispatcher = this._dispatchers[this._currentIndex]
    this._currentIndex = (this._currentIndex + 1) % this._dispatchers.length
    return dispatcher.dispatch(options, handler)
  }

  get closed(): boolean {
    return this._closed
  }

  async close(): Promise<void> {
    this._closed = true
    await Promise.all(this._dispatchers.map(d => d.close()))
  }

  async destroy(): Promise<void> {
    this._closed = true
    await Promise.all(this._dispatchers.map(d => d.destroy()))
  }
}
```

### Usage: Round-Robin Through Proxy

```typescript
import { AsyncClientPool } from 'fetch-undici'
import { ProxyAgent } from 'undici'

// Create multiple proxy agent instances
const proxyAgents = Array.from({ length: 5 }, () =>
  new ProxyAgent({ uri: 'http://proxy.example.com:8080' })
)

// Wrap in round-robin dispatcher
const rrProxy = new RoundRobinDispatcher(proxyAgents)

const client = new AsyncClientPool({
  mounts: {
    'https://': rrProxy
  }
})

// Requests cycle through proxy connections: agent1 → agent2 → agent3 → ...
await client.get('https://api.example.com/users')
await client.get('https://api.example.com/orders')  // Uses next agent
await client.get('https://api.example.com/products') // Uses next agent

await client.close()
await rrProxy.close()
```

### Usage: Round-Robin Across Multiple Proxies

```typescript
import { AsyncClientPool } from 'fetch-undici'
import { ProxyAgent } from 'undici'

// Multiple different proxy servers
const proxyAgents = [
  new ProxyAgent({ uri: 'http://proxy1.example.com:8080' }),
  new ProxyAgent({ uri: 'http://proxy2.example.com:8080' }),
  new ProxyAgent({ uri: 'http://proxy3.example.com:8080' })
]

const rrProxy = new RoundRobinDispatcher(proxyAgents)

const client = new AsyncClientPool({
  mounts: {
    'https://': rrProxy
  }
})

// Requests cycle through different proxies
await client.get('https://api.example.com/users')    // → proxy1
await client.get('https://api.example.com/orders')   // → proxy2
await client.get('https://api.example.com/products') // → proxy3
await client.get('https://api.example.com/items')    // → proxy1 (cycles back)
```

## Summary: Choosing the Right Approach

| Need | Solution |
|------|----------|
| Single origin, round-robin connections | `RoundRobinPool` |
| Single origin, standard pooling | `Pool` |
| Multiple origins, load-balanced | `BalancedPool` |
| Single proxy, standard pooling | `ProxyAgent` |
| Single proxy, round-robin connections | `RoundRobinDispatcher` with multiple `ProxyAgent` |
| Multiple proxies, round-robin | `RoundRobinDispatcher` with `ProxyAgent` per proxy |

## References

- [Undici Pool](https://undici.nodejs.org/#/docs/api/Pool.md)
- [Undici BalancedPool](https://undici.nodejs.org/#/docs/api/BalancedPool.md)
- [Undici RoundRobinPool](https://undici.nodejs.org/#/docs/api/RoundRobinPool.md)
- [Undici ProxyAgent](https://undici.nodejs.org/#/docs/api/ProxyAgent.md)
