/**
 * Basic tests for fetch-undici
 */

import { describe, it, expect } from 'vitest'
import {
  AsyncClient,
  Headers,
  Request,
  Response,
  Timeout,
  Limits,
  BasicAuth,
  BearerAuth,
  HTTPError,
  HTTPStatusError
} from './index.js'

describe('fetch-undici', () => {
  describe('Headers', () => {
    it('should create headers from object', () => {
      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-Custom': 'value'
      })
      expect(headers.get('content-type')).toBe('application/json')
      expect(headers.get('x-custom')).toBe('value')
    })

    it('should support case-insensitive access', () => {
      const headers = new Headers({ 'Content-Type': 'text/plain' })
      expect(headers.get('CONTENT-TYPE')).toBe('text/plain')
      expect(headers.get('content-type')).toBe('text/plain')
    })
  })

  describe('Timeout', () => {
    it('should create timeout with defaults', () => {
      const timeout = new Timeout()
      expect(timeout.connect).toBe(5000)
      expect(timeout.read).toBe(30000)
    })

    it('should create timeout from number', () => {
      const timeout = new Timeout(10000)
      expect(timeout.connect).toBe(10000)
      expect(timeout.read).toBe(10000)
    })
  })

  describe('Limits', () => {
    it('should create limits with defaults', () => {
      const limits = new Limits()
      expect(limits.maxConnections).toBe(100)
      expect(limits.maxConnectionsPerHost).toBe(10)
    })
  })

  describe('Auth', () => {
    it('should create BasicAuth', () => {
      const auth = new BasicAuth('user', 'pass')
      const request = new Request('GET', 'https://example.com')
      const authRequest = auth.apply(request)
      expect(authRequest.headers.get('Authorization')).toMatch(/^Basic /)
    })

    it('should create BearerAuth', () => {
      const auth = new BearerAuth('mytoken')
      const request = new Request('GET', 'https://example.com')
      const authRequest = auth.apply(request)
      expect(authRequest.headers.get('Authorization')).toBe('Bearer mytoken')
    })
  })

  describe('AsyncClient', () => {
    it('should create client with base URL', () => {
      const client = new AsyncClient({
        baseUrl: 'https://api.example.com'
      })
      expect(client).toBeInstanceOf(AsyncClient)
    })
  })

  describe('Response', () => {
    it('should create response with status properties', () => {
      const response = new Response({
        statusCode: 200,
        headers: { 'content-type': 'application/json' }
      })
      expect(response.statusCode).toBe(200)
      expect(response.ok).toBe(true)
      expect(response.isSuccess).toBe(true)
      expect(response.isError).toBe(false)
    })

    it('should identify error responses', () => {
      const response404 = new Response({ statusCode: 404 })
      expect(response404.isClientError).toBe(true)
      expect(response404.isError).toBe(true)
      expect(response404.ok).toBe(false)

      const response500 = new Response({ statusCode: 500 })
      expect(response500.isServerError).toBe(true)
      expect(response500.isError).toBe(true)
    })
  })

  describe('Exceptions', () => {
    it('should create HTTPStatusError', () => {
      const response = new Response({ statusCode: 404 })
      const error = new HTTPStatusError(response)
      expect(error).toBeInstanceOf(HTTPError)
      expect(error.statusCode).toBe(404)
    })
  })
})
