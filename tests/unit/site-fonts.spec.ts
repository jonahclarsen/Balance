import { expect, test } from '@playwright/test'
import { accessAuthorized } from '../../website/worker.js'
import { fontFamilies, overrideCss, resolveRole, sanitizeFavorites, sanitizeSettings } from '../../website/public/admin/fonts.js'

const env = {
  ACCESS_ISSUER: 'https://example-team.cloudflareaccess.com',
  ACCESS_AUD: 'admin-audience',
  ADMIN_EMAIL: 'admin@example.com',
}

const encode = (value: object | Uint8Array) => {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value))
  return Buffer.from(bytes).toString('base64url')
}

async function signedRequest(privateKey: CryptoKey, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  const claims = { iss: env.ACCESS_ISSUER, aud: [env.ACCESS_AUD], email: env.ADMIN_EMAIL, type: 'app', sub: 'user', iat: now, exp: now + 600, ...overrides }
  const unsigned = `${encode({ alg: 'RS256', kid: 'key' })}.${encode(claims)}`
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(unsigned)))
  return new Request('https://balance.jonah.art/admin/', { headers: { cookie: `theme=dark; CF_Authorization=${unsigned}.${encode(signature)}` } })
}

test('admin access accepts only the Access token for the admin', async () => {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
  const { privateKey, publicKey } = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify'])
  const other = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify'])
  const resolveKey = async () => publicKey

  expect(await accessAuthorized(await signedRequest(privateKey), env, resolveKey)).toBe(true)
  for (const claims of [{ email: 'other@example.com' }, { aud: ['other'] }, { iss: 'https://other.cloudflareaccess.com' }, { exp: 1 }, { type: 'service' }, { nbf: Math.floor(Date.now() / 1000) + 600 }]) {
    expect(await accessAuthorized(await signedRequest(privateKey, claims), env, resolveKey), JSON.stringify(claims)).toBe(false)
  }
  expect(await accessAuthorized(await signedRequest(other.privateKey), env, resolveKey)).toBe(false)
  expect(await accessAuthorized(new Request('https://balance.jonah.art/admin/'), env, resolveKey)).toBe(false)
  for (const config of [{ ...env, ADMIN_EMAIL: '' }, { ...env, ACCESS_AUD: '' }, { ...env, ACCESS_ISSUER: 'https://untrusted.example.com' }]) {
    expect(await accessAuthorized(await signedRequest(privateKey), config, resolveKey)).toBe(false)
  }
})

test('saved font settings keep only known roles, fonts and weights', () => {
  const settings = sanitizeSettings({
    heading: { family: 'Fraunces', weight: 650 },
    body: { family: "Inter'; } body { display: none", weight: 400 },
    mono: { family: 'Space Mono', weight: 100 },
    unknown: { family: 'Inter', weight: 400 },
  })
  expect(settings).toEqual({ heading: { family: 'Fraunces', weight: 600 }, mono: { family: 'Space Mono', weight: 400 } })
  expect(overrideCss(settings)).toContain("--font-heading: 'Fraunces'")
})

test('favorites keep only catalog fonts, once each, in catalog order', () => {
  expect(sanitizeFavorites(['Space Mono', 'Inter', 'Comic Sans', 'Inter', 42])).toEqual(['Inter', 'Space Mono'])
  expect(sanitizeFavorites('Inter')).toEqual([])
})

test('roles follow their parent until overridden and only overridden fonts load', () => {
  expect(fontFamilies({})).toEqual([])
  const settings = { heading: { family: 'Inter', weight: 800 } }
  expect(resolveRole(settings, 'hero')).toMatchObject({ font: { family: 'Inter' }, weight: 800 })
  expect(fontFamilies(settings)).toEqual(['Inter:wght@800'])
  expect(fontFamilies({ ...settings, hero: { family: 'Inter', weight: 300 } })).toEqual(['Inter:wght@300;800'])
})
