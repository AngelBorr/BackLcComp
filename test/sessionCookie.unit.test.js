import assert from 'node:assert/strict'
import env, { resolveCookieConfig } from '../src/config.js'
import SessionsService from '../src/services/service.sessions.js'
import { logoutUser } from '../src/controllers/controller.sessions.js'

describe('JWT cookie configuration (isolated unit tests)', () => {
  const environmentCases = [
    ['development', false, 'lax'],
    ['staging', true, 'none'],
    ['production', true, 'none']
  ]

  for (const [nodeEnvironment, secure, sameSite] of environmentCases) {
    it(`uses secure=${secure} and sameSite=${sameSite} in ${nodeEnvironment}`, () => {
      const cookie = resolveCookieConfig({ NODE_ENV: nodeEnvironment })

      assert.equal(cookie.secure, secure)
      assert.equal(cookie.sameSite, sameSite)
    })
  }

  it('parses COOKIE_SECURE=false as boolean false', () => {
    const cookie = resolveCookieConfig({
      NODE_ENV: 'staging',
      COOKIE_SECURE: 'false'
    })

    assert.equal(cookie.secure, false)
  })

  it('normalizes an explicit COOKIE_SAME_SITE=lax override', () => {
    const cookie = resolveCookieConfig({
      NODE_ENV: 'staging',
      COOKIE_SAME_SITE: 'lax'
    })

    assert.equal(cookie.sameSite, 'lax')
  })

  it('uses the centralized cookie configuration during login', async () => {
    let captured
    const response = {
      cookie(name, token, options) {
        captured = { name, token, options }
      }
    }

    await new SessionsService().generateAuthResponse({
      _id: '507f1f77bcf86cd799439011',
      firstName: 'Cookie',
      lastName: 'Test',
      email: 'cookie-test@example.invalid',
      role: 'USER'
    }, response)

    assert.equal(captured.name, env.cookie.name)
    assert.equal(typeof captured.token, 'string')
    assert.deepEqual(captured.options, {
      httpOnly: true,
      secure: env.cookie.secure,
      sameSite: env.cookie.sameSite,
      maxAge: env.cookie.maxAge,
      path: '/',
      ...(env.cookie.domain ? { domain: env.cookie.domain } : {})
    })
  })

  it('uses matching centralized attributes during logout', async () => {
    let cleared
    const response = {
      clearCookie(name, options) {
        cleared = { name, options }
      },
      status() {
        return this
      },
      json() {
        return this
      }
    }

    await logoutUser(
      { user: { email: 'cookie-test@example.invalid' } },
      response,
      (error) => { throw error }
    )

    assert.deepEqual(cleared, {
      name: env.cookie.name,
      options: {
        httpOnly: true,
        secure: env.cookie.secure,
        sameSite: env.cookie.sameSite,
        path: '/',
        ...(env.cookie.domain ? { domain: env.cookie.domain } : {})
      }
    })
  })
})
