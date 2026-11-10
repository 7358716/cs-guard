/**
 * 路由安全围栏回归测试（v1.8.0 新增）
 *
 * 🔴 真实漏洞（生产公网入口实测）：旧 judge() 只检查 Cookie **名字**是否以
 *    `dsh-auth-` 开头，不校验签名 ⇒ `Cookie: dsh-auth-forged` 就能读写配置。
 *
 * v1.8.0 判据：
 *   ① Origin 同源
 *   ② 回环 + localhost 直连（本机管理员）放行
 *   ③ 其余委托宿主 connection.requestRejection（真实签名/会话/可信 Host）
 *   ④ 拿不到 connection ⇒ fail-closed
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  judge, isLoopbackAddr, isLocalHostHeader, isTrustedHostHeader, hasAuthCookie,
  safeGetConnection, verifySession, safeErrorText,
} from '../src/web/guard.js'

/** 造一个假 request */
const req = ({ host = 'localhost', origin, cookie, addr = '127.0.0.1', method = 'GET' } = {}) => ({
  method,
  headers: {
    ...(host === undefined ? {} : { host }),
    ...(origin === undefined ? {} : { origin }),
    ...(cookie === undefined ? {} : { cookie }),
  },
  socket: { remoteAddress: addr },
})

/** 假宿主 connection 服务：只有 valid-cookie 才放行 */
const fakeConnection = (validCookie) => ({
  requestRejection(r) {
    const cookie = r.headers?.cookie ?? ''
    if (cookie === validCookie) return undefined          // 放行
    if (!cookie) return 401
    return 403
  },
})

test('回环 + localhost 直连（本机管理员）放行', () => {
  assert.equal(judge(req(), {}).ok, true)
  assert.equal(judge(req({ host: '127.0.0.1:3080' }), {}).ok, true)
  assert.equal(judge(req({ addr: '::1', host: '[::1]:3080' }), {}).ok, true)
})

test('无 cookie + 公网 Host ⇒ 403', () => {
  const v = judge(req({ host: 'example.com' }))
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
})

test('🔴 回归：伪造 dsh-auth-* cookie、无 connection 服务 ⇒ fail-closed 403', () => {
  const v = judge(req({ host: 'example.com', cookie: 'dsh-auth-forged' }), {})
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
  assert.equal(v.reason, 'auth-unverifiable')
})

test('🔴 回归：伪造 cookie + 可信 Host + 回环（反代场景）⇒ 仍拒绝', () => {
  const v = judge(req({ host: 'example.com', cookie: 'dsh-auth-forged', addr: '127.0.0.1' }), {
    trustedHosts: ['example.com'],
  })
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
})

test('委托 connection：真实有效 cookie ⇒ 放行', () => {
  const conn = fakeConnection('dsh-auth-abc=v2.sig')
  const v = judge(req({ host: 'example.com', cookie: 'dsh-auth-abc=v2.sig' }), { getConnection: () => conn })
  assert.equal(v.ok, true)
})

test('委托 connection：伪造 cookie ⇒ 403', () => {
  const conn = fakeConnection('dsh-auth-real=v2.sig')
  const v = judge(req({ host: 'example.com', cookie: 'dsh-auth-forged' }), { getConnection: () => conn })
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
})

test('委托 connection：无会话 ⇒ 401', () => {
  const conn = fakeConnection('x')
  const v = judge(req({ host: 'example.com' }), { getConnection: () => conn })
  assert.equal(v.ok, false)
  assert.equal(v.status, 401)
  assert.equal(v.reason, 'invalid-or-missing-session')
})

test('connection 校验抛错 ⇒ fail-closed 403（不放行）', () => {
  const v = judge(req({ host: 'example.com', cookie: 'dsh-auth-x' }), {
    getConnection: () => ({ requestRejection() { throw new Error('boom') } }),
  })
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
  assert.equal(v.reason, 'auth-check-failed')
})

test('getConnection 本身抛错 ⇒ 不抛、拒绝', () => {
  const v = judge(req({ host: 'example.com' }), { getConnection: () => { throw new Error('boom') } })
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
})

test('Origin 跨域一律拒绝（防 CSRF）', () => {
  const v = judge(req({ host: 'localhost', origin: 'http://evil.example' }), {})
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'cross-origin')
})

test('Origin 同源放行', () => {
  assert.equal(judge(req({ host: 'localhost:3080', origin: 'http://localhost:3080' }), {}).ok, true)
})

test('外部地址 + 合法 connection 也走宿主校验（不能绕过）', () => {
  const v = judge(req({ host: 'example.com', addr: '203.0.113.9' }), { getConnection: () => fakeConnection('x') })
  assert.equal(v.ok, false)
  assert.equal(v.status, 401)
})

test('基础判据函数', () => {
  assert.equal(isLoopbackAddr('127.0.0.1'), true)
  assert.equal(isLoopbackAddr('127.5.5.5'), true)
  assert.equal(isLoopbackAddr('10.0.0.1'), false)
  assert.equal(isLocalHostHeader('LOCALHOST:3080'), true)
  assert.equal(isLocalHostHeader('[::1]:3080'), true)
  assert.equal(isLocalHostHeader('example.com'), false)
  assert.equal(isTrustedHostHeader('example.com:80', ['example.com']), true)
  assert.equal(isTrustedHostHeader('evil.com', ['example.com']), false)
  assert.equal(hasAuthCookie({ headers: { cookie: 'a=1; dsh-auth-x=v' } }), true)
  assert.equal(hasAuthCookie({ headers: { cookie: 'a=1' } }), false)
  assert.equal(hasAuthCookie({}), false)
})

test('safeGetConnection 兼容函数/对象/空值', () => {
  const conn = { requestRejection: () => undefined }
  assert.equal(safeGetConnection(() => conn), conn)
  assert.equal(safeGetConnection(conn), conn)
  assert.equal(safeGetConnection(() => null), null)
  assert.equal(safeGetConnection(undefined), null)
  assert.equal(safeGetConnection({}), null)
})

test('verifySession 放行/拒绝/异常三态', () => {
  assert.deepEqual(verifySession({}, { requestRejection: () => undefined }), { ok: true })
  assert.equal(verifySession({}, { requestRejection: () => 401 }).status, 401)
  assert.equal(verifySession({}, { requestRejection: () => 403 }).status, 403)
  assert.equal(verifySession({}, { requestRejection: () => { throw 1 } }).status, 403)
})

test('safeErrorText 脱敏 URL 凭据与 token', () => {
  const s = safeErrorText(new Error('connect https://alice:pw@example.com/x?token=abc123 failed'))
  assert.ok(!s.includes('alice'))
  assert.ok(!s.includes('pw@'))
  assert.ok(!s.includes('abc123'))
  assert.ok(s.includes('***'))
})

// ── 2026-11-04 测试回归（真实 P0 安全漏洞）──────────────────────────────
// 🔴 P0-1：代理请求（remoteAddress=127.0.0.1 但带 X-Forwarded-*）不得按
//   loopback 放行 —— 否则 Host: localhost 即可绕过会话校验（公网 nginx 实测可利用）。
test('2026-11-04 P0-1：代理请求带 X-Forwarded-For 不得按 loopback 放行', () => {
  const proxied = {
    headers: { host: 'localhost', 'x-forwarded-for': '1.2.3.4' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const v = judge(proxied, {})
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
  assert.match(v.reason, /proxied-without-auth/)
})

test('2026-11-04 P0-1：代理请求带 X-Real-IP 同样不得放行', () => {
  const proxied = {
    headers: { host: '127.0.0.1', 'x-real-ip': '8.8.8.8' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  assert.equal(judge(proxied, {}).ok, false)
})

test('2026-11-04 P0-1：无代理头时 loopback + localhost 仍放行', () => {
  const direct = { headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(judge(direct, {}).ok, true)
})

// 🔴 P0-2：trustedHosts 参数此前被接受但从未使用（死代码）。
test('2026-11-04 P0-2：trustedHosts 生效（能走到 connection 校验而非直接拒）', () => {
  const r = { headers: { host: 'example.com' }, socket: { remoteAddress: '10.0.0.5' } }
  // 无 connection 服务时：可信 Host 也必须真实会话校验 → fail-closed
  const v = judge(r, { trustedHosts: ['example.com'] })
  assert.equal(v.ok, false)
  assert.match(v.reason, /trusted-host-without-session/)
})

test('2026-11-04 P0-2：不可信 Host 不在清单里 → 走外部校验路径', () => {
  const r = { headers: { host: 'evil.example' }, socket: { remoteAddress: '10.0.0.5' } }
  const v = judge(r, { trustedHosts: ['example.com'] })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'external-without-auth')
})
