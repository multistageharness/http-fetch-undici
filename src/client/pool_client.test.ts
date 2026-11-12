import { describe, it, expect, vi, afterEach } from 'vitest'
import { AsyncClientPool } from './pool_client.js'
import { AsyncClient } from './client.js'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, ProxyAgent } from 'undici'

describe('AsyncClientPool', () => {
    it('should not close shared dispatchers when client is closed', async () => {
        // 1. Create a "shared" dispatcher (MockAgent for testing)
        const sharedAgent = new MockAgent()
        sharedAgent.disableNetConnect()

        // Spy on the close method
        const closeSpy = vi.spyOn(sharedAgent, 'close')
        const destroySpy = vi.spyOn(sharedAgent, 'destroy')

        // 2. Create AsyncClientPool with this shared agent
        const client = new AsyncClientPool({
            mounts: {
                'https://example.com': sharedAgent
            }
        })

        // 3. Verify it works (we need to mock a request)
        const pool = sharedAgent.get('https://example.com')
        pool.intercept({
            path: '/test',
            method: 'GET'
        }).reply(200, { ok: true })

        const response = await client.get('https://example.com/test')
        expect(response.ok).toBe(true)

        // 4. Close the client
        await client.close()

        // 5. Verify the shared agent was NOT closed
        expect(closeSpy).not.toHaveBeenCalled()
        expect(destroySpy).not.toHaveBeenCalled()
        expect(client.closed).toBe(true)

        // Cleanup
        await sharedAgent.close()
    })

    it('should still support standard AsyncClient features like retries', async () => {
        // 1. Create a shared dispatcher
        const sharedAgent = new MockAgent()
        sharedAgent.disableNetConnect()

        const client = new AsyncClientPool({
            mounts: {
                'https://retry.com': sharedAgent
            },
            retry: {
                maxRetries: 2,
                retryDelay: 10 // fast retry for test
            }
        })

        const pool = sharedAgent.get('https://retry.com')

        // Fail twice, succeed third time
        pool.intercept({ path: '/retry', method: 'GET' }).reply(500)
        pool.intercept({ path: '/retry', method: 'GET' }).reply(500)
        pool.intercept({ path: '/retry', method: 'GET' }).reply(200, { success: true })

        const response = await client.get('https://retry.com/retry')
        expect(response.ok).toBe(true)

        await client.close()
        await sharedAgent.close()
    })

    it('should verify standard AsyncClient DOES close dispatchers (control test)', async () => {
        const agent = new MockAgent()
        agent.disableNetConnect()
        const closeSpy = vi.spyOn(agent, 'close')

        const client = new AsyncClient({
            mounts: {
                'https://control.com': agent
            }
        })

        await client.close()

        // Standard client SHOULD close the dispatcher
        expect(closeSpy).toHaveBeenCalled()
    })
})
