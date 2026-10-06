/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium } from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'

const args = process.argv.slice(2)
assert.equal(args.length, 2, 'Usage: node run-public-early-controls.mjs ORIGIN FRESH_TEMP_OUTPUT_DIRECTORY')
const candidate = new URL(args[0])
assert.ok(
  ((candidate.hostname === '127.0.0.1' || candidate.hostname === 'localhost') && candidate.protocol === 'http:') ||
    candidate.origin === 'https://cinatoken.com',
  'Only an owned loopback HTTP origin or the authorized public CinaToken origin is allowed'
)
assert.equal(candidate.pathname, '/')
assert.equal(candidate.search, '')
assert.equal(candidate.hash, '')
assert.equal(candidate.username, '')
assert.equal(candidate.password, '')
const origin = candidate.origin
const out = path.resolve(args[1])
const temp = path.resolve(os.tmpdir())
const relativeOutput = path.relative(temp, out)
assert.ok(relativeOutput && relativeOutput !== '..' && !relativeOutput.startsWith('..' + path.sep) && !path.isAbsolute(relativeOutput), 'Output must be a fresh descendant of the OS Temp directory')
assert.equal(fs.existsSync(out), false, 'Refuse to overwrite any prior evidence directory')
assert.ok(fs.statSync(path.dirname(out)).isDirectory(), 'The output parent must already exist')
fs.mkdirSync(out)
const sha = (data) => createHash('sha256').update(data).digest('hex')
const json = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const fileRecord = (file) => {
  const bytes = fs.readFileSync(file)
  return { path: file, bytes: bytes.length, sha256: sha(bytes) }
}
const scriptRecord = fileRecord(fileURLToPath(import.meta.url))
const overallDeadline = Date.now() + 12 * 60_000
const observedAssets = new Map()
const errors = (error) => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack ?? null })
const locales = ['en', 'zh', 'ja', 'ko']
const localeCopy = {
  en: { theme: 'Appearance', language: 'Language', home: 'Bring your AI resources together.', models: 'Model catalog' },
  zh: { theme: '外观', language: '语言', home: '集中管理你的 AI 资源。', models: '模型目录' },
  ja: { theme: '外観', language: '言語', home: 'AI リソースをひとつに。', models: 'モデルカタログ' },
  ko: { theme: '화면 테마', language: '언어', home: 'AI 리소스를 한곳에 모으세요.', models: '모델 카탈로그' },
}
const publicDocument = (url) => /^\/(?:en|zh|ja|ko)(?:\/models(?:\/[^/]+\/[^/]+)?)?$/.test(url.pathname)
const safeURL = (raw) => {
  try {
    const url = new URL(raw)
    return url.origin + url.pathname + url.search + url.hash
  } catch {
    return '[unavailable]'
  }
}
const snapshot = async (page) => page.evaluate(() => {
  const cookie = (name) => {
    try {
      return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(name + '=')) ?? null
    } catch {
      return '[read denied]'
    }
  }
  const control = (name) => document.querySelector('select[data-cinatoken-public-preference="' + name + '"]')
  const canonical = document.querySelector('link[rel="canonical"]')
  return {
    url: location.href,
    readyState: document.readyState,
    locale: document.documentElement.lang,
    classes: [...document.documentElement.classList],
    publicHydration: document.documentElement.dataset.cinatokenPublicHydration ?? null,
    hydrationFailure: document.documentElement.dataset.cinatokenHydration ?? null,
    theme: control('theme')?.value ?? null,
    localeControl: control('locale')?.value ?? null,
    themeCookie: cookie('cinatoken-theme'),
    localeCookie: cookie('NEXT_LOCALE'),
    title: document.title,
    canonical: canonical?.href ?? null,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    viewport: { width: innerWidth, height: innerHeight },
    mainTextLength: document.querySelector('main')?.innerText.trim().length ?? 0,
    heading: document.querySelector('main h1')?.textContent.trim() ?? null,
    controller: {
      present: !!window.cinatokenPublicPreferences,
      syncControls: typeof window.cinatokenPublicPreferences?.syncControls === 'function',
      dispose: typeof window.cinatokenPublicPreferences?.dispose === 'function',
    },
    observation: window.__qaPublicPreferences ? {
      themeFrames: window.__qaPublicPreferences.themeFrames,
      policyViolations: window.__qaPublicPreferences.policyViolations,
      pageshow: window.__qaPublicPreferences.pageshow,
      cookieSetterFailures: window.__qaPublicPreferences.cookieSetterFailures,
    } : null,
  }
})
function scriptContract(html, headers) {
  const csp = headers['content-security-policy'] ?? ''
  const policy = /(?:^|;)\s*script-src\s+([^;]+)/.exec(csp)?.[1] ?? ''
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1]
  assert.ok(nonce, 'Every HTML response needs its own script nonce')
  assert.ok(policy.includes("'self'"))
  assert.ok(!policy.includes("'unsafe-inline'"), 'Do not relax script CSP')
  assert.ok(!policy.includes("'unsafe-eval'"), 'Do not relax script CSP')
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  assert.ok(scripts.length >= 4, 'Require bootstrap, router protocol and client entry')
  const entries = []
  for (const match of scripts) {
    assert.ok(new RegExp('\\bnonce=["\']' + nonce + '["\']').test(match[1]), 'All scripts including the early bridge must carry the response nonce')
    const src = /\bsrc=["']([^"']+)["']/.exec(match[1])?.[1]
    if (src) {
      const url = new URL(src, origin)
      assert.equal(url.origin, origin)
      assert.ok(url.pathname.startsWith('/web-assets/'))
      entries.push(url.pathname)
    }
  }
  assert.ok(entries.length > 0)
  assert.ok(!/\bon(?:change|input)=/i.test(html), 'Handlers must not use inline event attributes')
  return { nonce, scriptCount: scripts.length, entryPaths: [...new Set(entries)] }
}
const report = {
  at: new Date().toISOString(),
  origin,
  runner: scriptRecord,
  scope: 'Fresh anonymous Chrome contexts, real HTTP compiled SSR and public assets; controlled asset delays and preference-only cookies. Only the exact GET /api/user/me anonymous 401 may additionally be observed and must have the Unauthorized envelope. No login, personal browser profile, authenticated session, workspace or business write.',
  preparedFor: { controller: 'window.cinatokenPublicPreferences', controls: 'data-cinatoken-public-preference=theme|locale', hydration: 'html data-cinatoken-public-hydration=ready' },
  browserFallback: 'Existing bundled Playwright and installed Chrome; no dependency installation; Browser plugin unavailable in the preceding investigation',
  cases: [],
  fatal: [],
  realAuthentication: false,
  businessWrites: false,
  bfcache: { executed: false, reason: 'The installed Playwright launch defaults explicitly include --disable-back-forward-cache (coreBundle.js:34645). This runner preserves the default browser mode, records real pageshow.persisted values, and makes no BFCache restore claim.' },
}
let browser
let preflight
const preflightAt = Date.now()
try {
  const response = await fetch(origin + '/en', { method: 'GET', credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { accept: 'text/html' } })
  assert.equal(response.status, 200, 'Fresh public preflight must be direct HTTP 200')
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/i)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(bytes.length <= 24 * 1024 * 1024)
  const headers = Object.fromEntries(response.headers)
  const contract = scriptContract(bytes.toString('utf8'), headers)
  const canonicalTag = /<link\b[^>]*\brel=["']canonical["'][^>]*>/i.exec(bytes.toString('utf8'))?.[0]
  const canonicalHref = canonicalTag && /\bhref=["']([^"']+)["']/.exec(canonicalTag)?.[1]
  assert.ok(canonicalHref, 'Preflight must have a canonical URL')
  const canonicalOrigin = new URL(canonicalHref).origin
  fs.writeFileSync(path.join(out, 'preflight-en.html'), bytes, { flag: 'wx' })
  preflight = { status: response.status, elapsedMs: Date.now() - preflightAt, bytes: bytes.length, sha256: sha(bytes), canonicalOrigin, ...contract, headers }
  report.preflight = preflight
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, timeout: 30_000, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] })
  report.browserVersion = browser.version()
} catch (error) {
  report.fatal.push({ stage: 'preflight-or-browser-launch', ...errors(error) })
}

async function runCase(spec) {
  const row = {
    id: spec.id,
    at: new Date().toISOString(),
    kind: spec.kind,
    javaScriptEnabled: spec.noJS !== true,
    gate: spec.gate ?? null,
    syntheticPreferenceCookies: spec.themeCookie ? [{ name: 'cinatoken-theme', value: spec.themeCookie }] : [],
    viewport: spec.viewport ?? { width: 1280, height: 900 },
    colorScheme: spec.colorScheme ?? 'light',
    cookieSetterFailureInjected: spec.cookieFailure === true,
    navigationRequests: [],
    requestStarts: [],
    responses: [],
    assetResponses: [],
    failedRequests: [],
    policyViolations: [],
    console: [],
    pageErrors: [],
    gateRequests: [],
    blockedRequests: [],
    evidenceErrors: [],
    expectedAnonymous401: [],
    observations: [],
    screenshots: [],
    checks: {},
    timedOut: false,
  }
  report.cases.push(row)
  let context
  let page
  let gateReleased = false
  let releaseGate
  const gatePromise = new Promise((resolve) => { releaseGate = resolve })
  const pendingEvidence = new Set()
  const outstandingRequests = new Set()
  const requestRows = new Map()
  const gatedRows = new Map()
  const pendingRoutes = new Set()
  const routeCompletions = new Map()
  const documentRows = new Map()
  let sequence = 0
  let expectedLocaleNavigation = false
  let deadlineTimer
  const collect = (promise) => {
    const job = Promise.resolve(promise).catch((error) => row.evidenceErrors.push(errors(error)))
    pendingEvidence.add(job)
    void job.then(() => pendingEvidence.delete(job))
  }
  const drainEvidence = async () => {
    while (pendingEvidence.size) await Promise.all([...pendingEvidence])
  }
  const awaitRequests = async () => {
    const started = Date.now()
    while (outstandingRequests.size) {
      assert.ok(Date.now() - started < 15_000, 'Required public HTTP requests must terminate')
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    await drainEvidence()
  }
  const save = async (stage) => {
    const state = await snapshot(page)
    row.observations.push({ stage, at: new Date().toISOString(), ...state })
    return state
  }
  const shot = async (stage) => {
    const file = path.join(out, spec.id + '-' + stage + '.png')
    await page.screenshot({ path: file, fullPage: false, timeout: 15_000 })
    row.screenshots.push({ stage, ...fileRecord(file) })
  }
  const theme = () => page.locator('header select[data-cinatoken-public-preference="theme"]')
  const locale = () => page.locator('header select[data-cinatoken-public-preference="locale"]')
  const waitEarly = async () => {
    await page.locator('main h1').waitFor({ state: 'visible', timeout: 15_000 })
    assert.equal(await theme().count(), 1)
    assert.equal(await locale().count(), 1)
    await page.waitForFunction(() => typeof window.cinatokenPublicPreferences?.syncControls === 'function' && typeof window.cinatokenPublicPreferences?.dispose === 'function', null, { timeout: 15_000 })
  }
  const waitHydrated = async () => {
    await page.waitForFunction(() => document.documentElement.dataset.cinatokenPublicHydration === 'ready', null, { timeout: 30_000 })
    const state = await save('hydrated')
    assert.equal(state.hydrationFailure, null)
    assert.equal(state.publicHydration, 'ready')
    assert.equal(state.controller.present, true)
    assert.ok(state.mainTextLength > 0)
    assert.ok(state.heading)
    assert.equal(await page.locator('nextjs-portal,vite-error-overlay,#webpack-dev-server-client-overlay').count(), 0)
    await awaitRequests()
    return state
  }
  const gatePrecondition = async () => {
    const started = Date.now()
    while (!row.gateRequests.some((item) => item.pending)) {
      assert.ok(Date.now() - started < 15_000, 'At least one real script must enter the selected gate')
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    // Complete the real HTML security evidence without releasing the deferred client.
    // This keeps deliberate locale navigation from truncating the response-body audit.
    await drainEvidence()
    const state = await save('before-early-action')
    assert.notEqual(state.publicHydration, 'ready', 'An early action must precede the real shell hydration commit')
    assert.equal(gateReleased, false)
    row.gatePendingBeforeAction = row.gateRequests.filter((item) => item.pending).length
    assert.ok(row.gatePendingBeforeAction > 0)
    row.checks.actualScriptHeldBeforeAction = true
  }
  const acceptTheme = async (value, cookieExpected = true) => {
    await page.waitForFunction((expected) => document.documentElement.classList.contains(expected) && document.querySelector('select[data-cinatoken-public-preference="theme"]')?.value === expected, value, { timeout: 5_000 })
    const state = await save('theme-accepted-' + value)
    assert.ok(state.classes.includes(value))
    assert.equal(state.theme, value)
    if (cookieExpected) assert.equal(state.themeCookie, 'cinatoken-theme=' + value)
    else assert.equal(state.themeCookie, null)
    return state
  }
  const startThemeWatch = async () => page.evaluate(() => {
    window.__qaPublicPreferences.themeFrames = []
    window.__qaPublicPreferences.watchTheme = true
  })
  const assertStableTheme = async (value) => {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const state = await save('theme-no-rollback-' + value)
    assert.ok(state.observation.themeFrames.length > 0, 'Observe real DOM frames across bundle release and hydration')
    for (const frame of state.observation.themeFrames) {
      assert.equal(frame.theme, value, 'Hydration must preserve the native select choice')
      assert.ok(frame.classes.includes(value), 'Hydration must preserve the effective theme')
      assert.ok(!frame.classes.includes(value === 'dark' ? 'light' : 'dark'), 'Hydration must never roll back to the previous theme')
    }
    await page.evaluate(() => { window.__qaPublicPreferences.watchTheme = false })
    row.checks.themeStableThroughHydration = true
  }
  const checkCanonical = async (state, selected) => {
    assert.equal(state.locale, selected)
    assert.equal(state.localeControl, selected)
    const canonical = new URL(state.canonical)
    assert.equal(canonical.origin, preflight.canonicalOrigin)
    assert.equal(canonical.pathname, '/' + selected + '/models')
    assert.equal(canonical.search, '')
    assert.equal(canonical.hash, '')
  }
  const changeLocale = async (selected, early = false) => {
    const before = new URL(page.url())
    const target = new URL(before.href)
    target.pathname = before.pathname.replace(/^\/(?:en|zh|ja|ko)(?=\/|$)/, '/' + selected)
    const baseline = row.navigationRequests.length
    expectedLocaleNavigation = true
    await locale().selectOption(selected, { timeout: 15_000 })
    await page.waitForURL(target.href, { waitUntil: 'commit', timeout: 30_000 })
    await page.locator('main h1').waitFor({ state: 'visible', timeout: 15_000 })
    const state = await save(early ? 'early-locale-navigated' : 'normal-locale-navigated')
    assert.equal(page.url(), target.href, 'Language navigation must preserve the exact query and fragment')
    assert.equal(state.localeCookie, 'NEXT_LOCALE=' + selected)
    if (before.pathname.endsWith('/models')) await checkCanonical(state, selected)
    else {
      assert.equal(state.locale, selected)
      assert.equal(state.localeControl, selected)
    }
    const actual = row.navigationRequests.slice(baseline)
    assert.equal(actual.length, 1, 'One selection must create exactly one main-frame document request, including canceled starts')
    assert.equal(actual[0].url, target.origin + target.pathname + target.search)
    row.observations.push({ stage: 'locale-request-window', selected, baseline, expectedURL: target.href, startedRequests: actual.map((item) => ({ ...item })) })
    return { baseline, expectedURL: target.href }
  }
  const checkNetwork = async () => {
    await awaitRequests()
    const state = await save('final')
    row.policyViolations = state.observation?.policyViolations ?? []
    assert.deepEqual(row.pageErrors, [])
    assert.deepEqual(row.blockedRequests, [])
    assert.deepEqual(row.evidenceErrors, [])
    assert.deepEqual(row.policyViolations, [])
    assert.deepEqual(row.failedRequests.filter((item) => !item.expected), [])
    assert.deepEqual(row.responses.filter((item) => item.status >= 400 && !item.expected), [])
    row.explainedConsole = row.console.filter((item) => item.type === 'error' && item.location === origin + '/api/user/me' && /^Failed to load resource: the server responded with a status of 401/.test(item.message) && row.expectedAnonymous401.length > 0)
    row.unexplainedConsole = row.console.filter((item) => item.type === 'error' && !row.explainedConsole.includes(item))
    assert.deepEqual(row.unexplainedConsole, [])
    assert.equal(state.hydrationFailure, null)
    assert.equal(state.overflow, false)
    row.checks.noUnexpectedNetworkPageOrCSPError = true
    row.checks.noPageOverflow = true
    return state
  }
  try {
    context = await browser.newContext({ viewport: row.viewport, colorScheme: row.colorScheme, javaScriptEnabled: row.javaScriptEnabled, locale: 'en-US', serviceWorkers: 'block', bypassCSP: false })
    if (spec.themeCookie) await context.addCookies([{ name: 'cinatoken-theme', value: spec.themeCookie, url: origin, sameSite: 'Lax' }])
    if (!spec.noJS) await context.addInitScript(({ cookieFailure }) => {
      window.__qaPublicPreferences = { themeFrames: [], watchTheme: false, policyViolations: [], pageshow: [], cookieSetterFailures: 0 }
      window.addEventListener('securitypolicyviolation', (event) => window.__qaPublicPreferences.policyViolations.push({ effectiveDirective: event.effectiveDirective, violatedDirective: event.violatedDirective, blockedURI: event.blockedURI, disposition: event.disposition, sample: event.sample }))
      window.addEventListener('pageshow', (event) => window.__qaPublicPreferences.pageshow.push({ persisted: event.persisted, at: performance.now() }))
      if (cookieFailure) {
        let prototype = document
        let descriptor
        while (prototype && !descriptor) {
          descriptor = Object.getOwnPropertyDescriptor(prototype, 'cookie')
          prototype = Object.getPrototypeOf(prototype)
        }
        if (!descriptor || typeof descriptor.get !== 'function') throw new Error('Cannot install an observational cookie setter failure seam')
        const get = descriptor.get
        Object.defineProperty(document, 'cookie', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() { return get.call(document) },
          set() {
            window.__qaPublicPreferences.cookieSetterFailures++
            throw new DOMException('Owned synthetic preference storage denial', 'SecurityError')
          },
        })
      }
      const observe = () => {
        const observation = window.__qaPublicPreferences
        if (observation.watchTheme) {
          const select = document.querySelector('select[data-cinatoken-public-preference="theme"]')
          const frame = { at: performance.now(), classes: [...document.documentElement.classList], theme: select?.value ?? null, hydration: document.documentElement.dataset.cinatokenPublicHydration ?? null }
          if (observation.themeFrames.length < 5000) observation.themeFrames.push(frame)
        }
        requestAnimationFrame(observe)
      }
      requestAnimationFrame(observe)
    }, { cookieFailure: spec.cookieFailure === true })
    page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) row.console.push({ type: message.type(), message: message.text(), location: safeURL(message.location().url) }) })
    page.on('pageerror', (error) => row.pageErrors.push(errors(error)))
    page.on('request', (request) => {
      const item = { sequence: ++sequence, at: new Date().toISOString(), url: safeURL(request.url()), method: request.method(), resourceType: request.resourceType(), documentAtStart: safeURL(page.url()), finished: false, failed: false }
      row.requestStarts.push(item)
      requestRows.set(request, item)
      outstandingRequests.add(request)
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) row.navigationRequests.push(item)
    })
    page.on('requestfinished', (request) => {
      outstandingRequests.delete(request)
      const item = requestRows.get(request)
      if (item) item.finished = true
    })
    page.on('requestfailed', (request) => {
      outstandingRequests.delete(request)
      const item = requestRows.get(request)
      if (item) item.failed = true
      const gate = gatedRows.get(request)
      const failure = request.failure()?.errorText ?? '[unavailable]'
      const expected = expectedLocaleNavigation && !!gate && gate.held && !gate.fulfilled && /ERR_ABORTED/.test(failure)
      row.failedRequests.push({ sequence: item?.sequence ?? null, url: safeURL(request.url()), method: request.method(), resourceType: request.resourceType(), failure, expected, reason: expected ? 'A real early locale full-document navigation canceled this specifically held old-document script' : null })
      if (gate) { gate.requestAborted = true; gate.pending = false; gate.expectedAbort = expected }
    })
    page.on('response', (response) => {
      const request = response.request()
      const item = { sequence: requestRows.get(request)?.sequence ?? null, url: safeURL(response.url()), status: response.status(), type: request.resourceType(), at: new Date().toISOString() }
      row.responses.push(item)
      if (new URL(response.url()).pathname === '/api/user/me') collect((async () => {
        assert.equal(response.status(), 401, 'The fresh anonymous session observation must be Unauthorized')
        const body = await response.json()
        assert.equal(body.success, false)
        assert.equal(body.message, 'Unauthorized')
        item.expected = true
        item.expectedEnvelope = { success: false, message: 'Unauthorized' }
        row.expectedAnonymous401.push({ sequence: item.sequence, url: item.url, status: item.status, envelope: item.expectedEnvelope })
      })())
      if (['script', 'stylesheet'].includes(request.resourceType())) collect((async () => {
        const bytes = await response.body()
        assert.ok(bytes.length <= 16 * 1024 * 1024)
        const content = { bytes: bytes.length, sha256: sha(bytes) }
        if (observedAssets.has(item.url)) assert.deepEqual(content, observedAssets.get(item.url), 'Immutable public asset bytes must not change during the acceptance')
        else observedAssets.set(item.url, content)
        row.assetResponses.push({ ...item, ...content })
      })())
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) collect((async () => {
        const bytes = await response.body()
        assert.ok(bytes.length <= 24 * 1024 * 1024)
        const headers = await response.allHeaders()
        const contract = scriptContract(bytes.toString('utf8'), headers)
        assert.deepEqual(contract.entryPaths, preflight.entryPaths, 'Do not mix client entry versions during a single frozen-candidate acceptance')
        const filename = spec.id + '-document-' + item.sequence + '.html'
        fs.writeFileSync(path.join(out, filename), bytes, { flag: 'wx' })
        const proof = { ...item, headers, bytes: bytes.length, sha256: sha(bytes), contract, file: path.join(out, filename) }
        documentRows.set(request, proof)
        row.observations.push({ stage: 'actual-document-security-contract', ...proof })
      })())
    })
    await context.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const anonymousSessionObservation = url.pathname === '/api/user/me' && url.search === ''
      if (url.origin !== origin || request.method() !== 'GET' || (request.resourceType() === 'document' ? !publicDocument(url) : !url.pathname.startsWith('/web-assets/') && !anonymousSessionObservation)) {
        row.blockedRequests.push({ url: safeURL(request.url()), method: request.method(), type: request.resourceType(), reason: 'Outside public document/static-asset-only scope' })
        await route.abort('blockedbyclient')
        return
      }
      const script = request.resourceType() === 'script' && url.pathname.endsWith('.js')
      const entry = preflight.entryPaths.includes(url.pathname)
      const shouldHold = !gateReleased && script && (spec.gate === 'main' ? entry : spec.gate === 'dynamic' && !entry)
      if (!shouldHold) { await route.continue(); return }
      const gate = { sequence: requestRows.get(request)?.sequence ?? null, url: safeURL(request.url()), documentAtStart: safeURL(page.url()), gate: spec.gate, isEntry: entry, held: true, pending: true, fulfilled: false, at: new Date().toISOString() }
      row.gateRequests.push(gate)
      gatedRows.set(request, gate)
      pendingRoutes.add(gate)
      let complete
      routeCompletions.set(gate, new Promise((resolve) => { complete = resolve }))
      try {
        await gatePromise
        gate.releaseAt = new Date().toISOString()
        if (!gate.requestAborted) {
          await route.continue()
          gate.fulfilled = true
        } else gate.skippedBecauseRequestAborted = true
      } catch (error) {
        gate.routeError = errors(error)
        if (!gate.expectedAbort) row.evidenceErrors.push({ stage: 'gate-release', ...errors(error) })
      } finally {
        gate.pending = false
        pendingRoutes.delete(gate)
        complete()
      }
    })
    const work = (async () => {
      const startURL = origin + spec.route
      const response = await page.goto(startURL, { waitUntil: spec.gate === 'main' ? 'commit' : 'domcontentloaded', timeout: 30_000 })
      assert.equal(response?.status(), 200)
      if (spec.noJS) {
        await page.locator('main h1').waitFor({ state: 'visible', timeout: 15_000 })
        const state = await save('true-no-javascript')
        assert.equal(state.locale, spec.locale)
        assert.equal(state.localeControl, spec.locale)
        assert.ok(state.mainTextLength > 0)
        assert.ok(state.heading)
        assert.equal(state.heading, localeCopy[spec.locale][spec.route.endsWith('/models') ? 'models' : 'home'])
        assert.equal(state.publicHydration, null)
        assert.equal(state.controller.present, false)
        assert.equal(await theme().locator('option').count(), 3)
        assert.equal(await locale().locator('option').count(), 4)
        assert.equal(await page.getByRole('combobox', { name: localeCopy[spec.locale].theme, exact: true }).count(), 1)
        assert.equal(await page.getByRole('combobox', { name: localeCopy[spec.locale].language, exact: true }).count(), 1)
        const bounds = await page.locator('main h1').boundingBox()
        assert.ok(bounds?.width > 0 && bounds?.height > 0, 'SSR text must actually be visible without product JavaScript')
        row.checks.trueNoJSVisibleSSR = true
        await shot('visible-nojs')
        await checkNetwork()
        return
      }
      await waitEarly()
      if (spec.gate) await gatePrecondition()
      if (spec.kind === 'theme') {
        const initial = await save('initial-preference')
        if (spec.themeCookie === 'dark') { assert.ok(initial.classes.includes('dark')); assert.equal(initial.theme, 'dark') }
        const beforeIDs = await page.locator('#root [id]').evaluateAll((elements) => elements.map((element) => element.id))
        await page.evaluate(() => { window.__qaPublicPreferences.serverH1 = document.querySelector('main h1') })
        await theme().selectOption(spec.chooseTheme, { timeout: 15_000 })
        await acceptTheme(spec.chooseTheme)
        await startThemeWatch()
        row.earlyActionAt = new Date().toISOString()
        row.gatePendingAfterAcceptedAction = row.gateRequests.filter((item) => item.pending).length
        assert.ok(row.gatePendingAfterAcceptedAction > 0, 'The user-visible preference must take effect before any gated bundle is released')
        await shot('accepted-before-client')
        gateReleased = true
        releaseGate()
        await waitHydrated()
        await assertStableTheme(spec.chooseTheme)
        const sameH1 = await page.evaluate(() => window.__qaPublicPreferences.serverH1 === document.querySelector('main h1'))
        assert.equal(sameH1, true)
        assert.deepEqual(await page.locator('#root [id]').evaluateAll((elements) => elements.map((element) => element.id)), beforeIDs)
        row.checks.serverH1AndIDsRetained = true
        if (spec.gate === 'dynamic') {
          await page.setViewportSize({ width: 390, height: 844 })
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
          await waitHydrated()
          const reload = await acceptTheme(spec.chooseTheme)
          assert.equal(reload.overflow, false)
          row.checks.mobileHardReloadPreferenceRetained = true
          await shot('mobile-hard-reload')
        } else {
          await theme().selectOption('light')
          await acceptTheme('light')
          await theme().selectOption('system')
          await page.emulateMedia({ colorScheme: 'dark' })
          await page.waitForFunction(() => document.querySelector('select[data-cinatoken-public-preference="theme"]')?.value === 'system' && document.documentElement.classList.contains('dark'), null, { timeout: 5_000 })
          const system = await save('system-media-dark')
          assert.equal(system.themeCookie, 'cinatoken-theme=system')
          await page.emulateMedia({ colorScheme: 'light' })
          await page.waitForFunction(() => document.documentElement.classList.contains('light'), null, { timeout: 5_000 })
          row.checks.systemMediaChange = true
        }
      } else if (spec.kind === 'locale') {
        const window = await changeLocale(spec.chooseLocale, true)
        row.earlyActionAt = new Date().toISOString()
        gateReleased = true
        releaseGate()
        await waitHydrated()
        assert.equal(page.url(), window.expectedURL)
        assert.equal(row.navigationRequests.slice(window.baseline).length, 1)
        const state = await save('locale-after-hydration')
        await checkCanonical(state, spec.chooseLocale)
        row.checks.localeRetainedWithoutDuplicateNavigation = true
        const next = spec.chooseLocale === 'zh' ? 'ja' : 'zh'
        const second = await changeLocale(next)
        await waitHydrated()
        assert.equal(row.navigationRequests.slice(second.baseline).length, 1, 'Bridge and React must not double-handle a normal language selection')
        row.checks.normalLocaleAfterHydrationHandledOnce = true
      } else if (spec.kind === 'cookie-failure') {
        await theme().selectOption('dark')
        await acceptTheme('dark', false)
        await startThemeWatch()
        assert.ok((await save('storage-denial-accepted')).observation.cookieSetterFailures > 0, 'The real product path must encounter the injected write denial')
        gateReleased = true
        releaseGate()
        await waitHydrated()
        await assertStableTheme('dark')
        await theme().selectOption('light')
        await acceptTheme('light', false)
        const failedStorage = await save('storage-denial-still-operable')
        assert.ok(failedStorage.observation.cookieSetterFailures >= 2)
        row.checks.memoryPreferenceSurvivesCookieFailureAndHydration = true
      } else if (spec.kind === 'normal') {
        const hydrated = await waitHydrated()
        assert.equal(hydrated.locale, spec.locale)
        assert.equal(hydrated.localeControl, spec.locale)
        assert.equal(hydrated.heading, localeCopy[spec.locale][spec.route.endsWith('/models') ? 'models' : 'home'])
        const canonical = new URL(hydrated.canonical)
        assert.equal(canonical.origin, preflight.canonicalOrigin)
        assert.equal(canonical.pathname, spec.route)
        assert.equal(canonical.search, '')
        assert.equal(canonical.hash, '')
        assert.equal(await theme().locator('option').count(), 3)
        assert.equal(await locale().locator('option').count(), 4)
        assert.equal(await page.getByRole('combobox', { name: localeCopy[spec.locale].theme, exact: true }).count(), 1)
        assert.equal(await page.getByRole('combobox', { name: localeCopy[spec.locale].language, exact: true }).count(), 1)
        assert.ok((await theme().getAttribute('aria-label')) || (await theme().evaluate((element) => element.labels?.[0]?.textContent.trim())))
        assert.ok((await locale().getAttribute('aria-label')) || (await locale().evaluate((element) => element.labels?.[0]?.textContent.trim())))
        if (spec.themeCookie === 'system') {
          assert.equal(hydrated.theme, 'system')
          assert.ok(hydrated.classes.includes('dark'))
          await page.emulateMedia({ colorScheme: 'light' })
          await page.waitForFunction(() => document.documentElement.classList.contains('light'), null, { timeout: 5_000 })
          await page.emulateMedia({ colorScheme: 'dark' })
          await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 5_000 })
          row.checks.systemMediaChange = true
        }
        await theme().selectOption('dark')
        await acceptTheme('dark')
        if (spec.keyboard) {
          await theme().focus()
          await page.keyboard.press('ArrowUp')
          await page.keyboard.press('Enter')
          await acceptTheme('light')
          assert.equal(await theme().evaluate((element) => element === document.activeElement), true)
          row.checks.nativeSelectKeyboardOperable = true
          await theme().selectOption('dark')
          await acceptTheme('dark')
        }
        const next = locales[(locales.indexOf(spec.locale) + 1) % locales.length]
        const window = await changeLocale(next)
        await waitHydrated()
        assert.equal(row.navigationRequests.slice(window.baseline).length, 1)
        assert.equal(page.url(), window.expectedURL)
        await acceptTheme('dark')
        row.checks.normalFourLanguageShellInteraction = true
      }
      const final = await checkNetwork()
      assert.equal(final.publicHydration, 'ready')
      await shot('final')
    })()
    const timeout = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => { row.timedOut = true; reject(new Error('Owned browser case deadline 90 seconds')) }, 90_000)
    })
    await Promise.race([work, timeout])
    row.outcome = 'PASS'
    row.intendedExitCode = 0
  } catch (error) {
    row.outcome = 'FAIL'
    row.intendedExitCode = 1
    row.failure = errors(error)
    if (page && !page.isClosed()) {
      try { await save('failure'); await shot('failure') } catch (diagnostic) { row.failureCaptureError = errors(diagnostic) }
    }
  } finally {
    clearTimeout(deadlineTimer)
    gateReleased = true
    releaseGate()
    try {
      await context?.close()
      row.contextClosed = true
    } catch (error) {
      row.contextClosed = false
      row.closeError = errors(error)
      row.outcome = 'FAIL'
      row.intendedExitCode = 1
    }
    await drainEvidence()
    if (routeCompletions.size) {
      let cleanupTimer
      try {
        await Promise.race([
          Promise.all([...routeCompletions.values()]),
          new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('Owned gated route cleanup deadline 5 seconds')), 5000) }),
        ])
      } catch (error) {
        row.evidenceErrors.push({ stage: 'gated-route-cleanup', ...errors(error) })
      } finally {
        clearTimeout(cleanupTimer)
      }
    }
    row.gateCounts = {
      held: row.gateRequests.length,
      continuedAfterRelease: row.gateRequests.filter((item) => item.fulfilled).length,
      expectedNavigationAborts: row.gateRequests.filter((item) => item.expectedAbort).length,
      pendingAtEnd: row.gateRequests.filter((item) => item.pending).length,
      activeRouteTasksAtEnd: pendingRoutes.size,
    }
    if (row.gateCounts.pendingAtEnd || row.gateCounts.activeRouteTasksAtEnd || row.evidenceErrors.length) {
      row.outcome = 'FAIL'
      row.intendedExitCode = 1
      row.finalEvidenceError = 'Unclosed gated route or response-evidence failure'
    }
    row.finishedAt = new Date().toISOString()
    json(spec.id + '.json', row)
    console.log(JSON.stringify({ id: row.id, outcome: row.outcome, failure: row.failure?.message ?? null, held: row.gateCounts.held, mainDocumentStarts: row.navigationRequests.length, contextClosed: row.contextClosed, report: path.join(out, spec.id + '.json') }))
  }
}

const specs = [
  { id: 'early-theme-main', kind: 'theme', gate: 'main', route: '/en', chooseTheme: 'dark' },
  { id: 'early-theme-dynamic', kind: 'theme', gate: 'dynamic', route: '/zh/models', themeCookie: 'dark', chooseTheme: 'light' },
  { id: 'early-locale-main', kind: 'locale', gate: 'main', route: '/en/models?q=HTTP+fixture&vendors=%5B%22Vendor%22%5D#pricing', chooseLocale: 'zh' },
  { id: 'early-locale-dynamic', kind: 'locale', gate: 'dynamic', route: '/ja/models?q=HTTP+fixture#pricing', chooseLocale: 'ko' },
  { id: 'cookie-failure-memory', kind: 'cookie-failure', gate: 'main', route: '/en', cookieFailure: true },
  { id: 'normal-en-keyboard', kind: 'normal', route: '/en', locale: 'en', keyboard: true },
  { id: 'normal-zh-mobile', kind: 'normal', route: '/zh/models', locale: 'zh', viewport: { width: 390, height: 844 }, themeCookie: 'dark' },
  { id: 'normal-ja-mobile-system', kind: 'normal', route: '/ja', locale: 'ja', viewport: { width: 390, height: 844 }, themeCookie: 'system', colorScheme: 'dark' },
  { id: 'normal-ko', kind: 'normal', route: '/ko/models', locale: 'ko' },
  ...locales.map((locale) => ({ id: 'nojs-' + locale, kind: 'nojs', route: '/' + locale + (locale === 'zh' || locale === 'ko' ? '/models' : ''), locale, noJS: true, viewport: locale === 'zh' || locale === 'ja' ? { width: 390, height: 844 } : { width: 1280, height: 900 } })),
]
report.plannedCases = specs.map((item) => ({ ...item }))
try {
  if (browser && preflight) for (const spec of specs) {
    assert.ok(Date.now() + 95_000 <= overallDeadline, 'Stop before starting another case outside the owned 12-minute overall budget')
    await runCase(spec)
  }
} catch (error) {
  report.fatal.push({ stage: 'case-driver', ...errors(error) })
} finally {
  try {
    if (browser) {
      await browser.close()
      report.browserClosed = true
    } else report.browserClosed = null
  } catch (error) {
    report.browserClosed = false
    report.fatal.push({ stage: 'browser-close', ...errors(error) })
  }
  report.summary = {
    planned: specs.length,
    attempted: report.cases.length,
    passed: report.cases.filter((item) => item.outcome === 'PASS').length,
    failed: report.cases.filter((item) => item.outcome === 'FAIL').length,
    early: report.cases.filter((item) => item.kind === 'theme' || item.kind === 'locale').length,
    noJS: report.cases.filter((item) => item.javaScriptEnabled === false).length,
    mobileNormal: report.cases.filter((item) => item.kind === 'normal' && item.viewport.width === 390).length,
    observedUniqueJSAndCSS: observedAssets.size,
  }
  report.intendedExitCode = report.fatal.length || report.summary.attempted !== specs.length || report.summary.failed || report.browserClosed !== true ? 1 : 0
  report.outcome = report.intendedExitCode === 0 ? 'PASS' : 'FAIL'
  report.finishedAt = new Date().toISOString()
  json('report.json', report)
  console.log(JSON.stringify({ outcome: report.outcome, intendedExitCode: report.intendedExitCode, summary: report.summary, browserClosed: report.browserClosed, fatal: report.fatal.map((item) => ({ stage: item.stage, message: item.message })), report: fileRecord(path.join(out, 'report.json')) }))
  process.exitCode = report.intendedExitCode
}
