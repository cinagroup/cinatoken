var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// packages/core/src/upstream-protocol.ts
function buildOpenAiCompatibleImagesUrl(baseUrl, suffix) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("OpenAI images base URL is empty");
  }
  const lower = base.toLowerCase();
  const standardGenerations = /\/images\/generations$/i.test(lower);
  const standardEdits = /\/images\/edits$/i.test(lower);
  const vendorGenerations = /(?:^|\/)(?:openai-)?image-generations$/i.test(lower);
  const vendorEdits = /(?:^|\/)(?:openai-)?image-edits$/i.test(lower);
  if (standardGenerations) {
    return suffix === "generations" ? base : base.replace(/\/images\/generations$/i, "/images/edits");
  }
  if (standardEdits) {
    return suffix === "edits" ? base : base.replace(/\/images\/edits$/i, "/images/generations");
  }
  if (vendorGenerations) {
    if (suffix === "generations") {
      return base;
    }
    return base.replace(
      /(openai-)?image-generations$/i,
      (_m, openaiPrefix) => `${openaiPrefix ?? ""}image-edits`
    );
  }
  if (vendorEdits) {
    if (suffix === "edits") {
      return base;
    }
    return base.replace(
      /(openai-)?image-edits$/i,
      (_m, openaiPrefix) => `${openaiPrefix ?? ""}image-generations`
    );
  }
  return `${base}/images/${suffix}`;
}
var UPSTREAM_PROTOCOLS, PROTOCOL_LIST;
var init_upstream_protocol = __esm({
  "packages/core/src/upstream-protocol.ts"() {
    "use strict";
    UPSTREAM_PROTOCOLS = [
      "openai",
      "anthropic",
      "gemini",
      "dashscope"
    ];
    PROTOCOL_LIST = UPSTREAM_PROTOCOLS.join(", ");
  }
});

// packages/core/src/gemini-upstream-url.ts
function trimTrailingSlash(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}
function geminiUpstreamBaseHasPathPrefix(baseUrl) {
  try {
    const pathname = new URL(baseUrl.trim()).pathname;
    return pathname !== "" && pathname !== "/";
  } catch {
    return false;
  }
}
function assertGeminiUpstreamBaseUrl(baseUrl) {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error(
      "Gemini upstream base URL is empty (configure providers.endpoints.gemini.base with full path prefix)"
    );
  }
  if (!geminiUpstreamBaseHasPathPrefix(trimmed)) {
    throw new Error(
      "Gemini upstream base URL must include path prefix before {model} (e.g. .../v1beta/models for Developer API, .../v1/publishers/google/models for Vertex Express)"
    );
  }
}
function buildGeminiUpstreamActionUrl(baseUrl, modelName, action) {
  assertGeminiUpstreamBaseUrl(baseUrl);
  const base = normalizeGeminiUpstreamBaseForAuthMatch(baseUrl);
  const modelSegment = `${encodeURIComponent(modelName)}:${action}`;
  return `${base}/${modelSegment}`;
}
function normalizeGeminiUpstreamBaseForAuthMatch(baseUrl) {
  const trimmed = baseUrl.trim();
  try {
    const u = new URL(trimmed);
    u.hostname = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "";
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return trimTrailingSlash(trimmed);
  }
}
var init_gemini_upstream_url = __esm({
  "packages/core/src/gemini-upstream-url.ts"() {
    "use strict";
  }
});

// packages/core/src/route-topology.ts
function canonicalizeRequestOperation(protocol, operation) {
  const op = operation.trim();
  if (protocol.trim().toLowerCase() !== "gemini") return op;
  if (op === GEMINI_GENERATE_OPERATION || GEMINI_LEGACY_GENERATE_OPERATIONS.includes(op)) {
    return GEMINI_GENERATE_OPERATION;
  }
  return op;
}
var GEMINI_GENERATE_OPERATION, GEMINI_LEGACY_GENERATE_OPERATIONS;
var init_route_topology = __esm({
  "packages/core/src/route-topology.ts"() {
    "use strict";
    GEMINI_GENERATE_OPERATION = "models.generate";
    GEMINI_LEGACY_GENERATE_OPERATIONS = [
      "generateContent",
      "streamGenerateContent"
    ];
  }
});

// packages/core/src/provider-endpoints.ts
function trimSlash(url) {
  return url.replace(/\/+$/, "");
}
function fillEndpointTemplate(template, vars) {
  return template.replace(/\{model\}/g, () => encodeURIComponent(vars.model ?? "")).replace(/\{action\}/g, () => encodeURIComponent(vars.action ?? "")).replace(/\{task_id\}/g, () => encodeURIComponent(vars.taskId ?? ""));
}
function resolveGeminiWireAction(capability, options) {
  const fromOptions = options.action?.trim();
  if (fromOptions === "generateContent" || fromOptions === "streamGenerateContent") {
    return fromOptions;
  }
  if (capability === "generateContent" || capability === "streamGenerateContent") {
    return capability;
  }
  throw new Error(
    "Gemini upstream endpoint requires action (generateContent or streamGenerateContent)"
  );
}
function buildDashScopeWebSocketUrl(base, endpoint) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api-ws/v1/${endpoint}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
function resolveUpstreamEndpoint(protocol, capability, providerEndpoints, options = {}) {
  const canonicalCapability = canonicalizeRequestOperation(
    protocol,
    capability
  );
  const writable = WRITABLE_CAPABILITIES_BY_PROTOCOL[protocol];
  if (!writable.includes(capability) && !CAPABILITIES_BY_PROTOCOL[protocol].includes(canonicalCapability)) {
    throw new Error(
      `Capability ${JSON.stringify(capability)} is not valid for protocol "${protocol}"`
    );
  }
  const cfg = providerEndpoints[protocol];
  if (protocol === "gemini") {
    const action = resolveGeminiWireAction(capability, options);
    const model = options.model;
    const familyTemplate = cfg?.endpoints?.[GEMINI_GENERATE_OPERATION];
    if (familyTemplate) {
      if (!model) throw new Error("Gemini upstream endpoint requires model name");
      return fillEndpointTemplate(familyTemplate, { model, action });
    }
    const legacyTemplate = cfg?.endpoints?.[action];
    if (legacyTemplate) {
      if (!model) throw new Error("Gemini upstream endpoint requires model name");
      return fillEndpointTemplate(legacyTemplate, { model, action });
    }
    const base2 = cfg?.base;
    if (base2) {
      if (!model) throw new Error("Gemini upstream endpoint requires model name");
      return buildGeminiUpstreamActionUrl(trimSlash(base2), model, action);
    }
    const who2 = options.providerId != null && options.providerId !== "" ? `provider_id=${JSON.stringify(options.providerId)}` : "provider";
    throw new Error(
      `${who2}: no upstream endpoint for protocol "gemini" capability "${GEMINI_GENERATE_OPERATION}" (configure providers.endpoints.gemini)`
    );
  }
  const resolvedCapability = canonicalCapability;
  const allowed = CAPABILITIES_BY_PROTOCOL[protocol];
  if (!allowed.includes(resolvedCapability)) {
    throw new Error(
      `Capability ${JSON.stringify(capability)} is not valid for protocol "${protocol}"`
    );
  }
  const template = cfg?.endpoints?.[resolvedCapability];
  if (template) {
    if (resolvedCapability === "audio.transcriptions.tasks" && !options.taskId) {
      throw new Error("DashScope task endpoint requires taskId");
    }
    return fillEndpointTemplate(template, {
      model: options.model,
      action: options.action,
      taskId: options.taskId
    });
  }
  const base = cfg?.base;
  if (base) {
    const root = trimSlash(base);
    switch (resolvedCapability) {
      case "chat":
        return `${root}/chat/completions`;
      case "responses":
        return `${root}/responses`;
      case "embeddings":
        return `${root}/embeddings`;
      case "rerank":
        return `${root}/rerank`;
      case "images.generations":
        return buildOpenAiCompatibleImagesUrl(root, "generations");
      case "images.edits":
        return buildOpenAiCompatibleImagesUrl(root, "edits");
      case "audio.transcriptions":
        return protocol === "dashscope" ? `${root}/services/audio/asr/transcription` : `${root}/audio/transcriptions`;
      case "audio.transcriptions.multimodal":
        return `${root}/services/aigc/multimodal-generation/generation`;
      case "audio.transcriptions.tasks":
        if (!options.taskId) {
          throw new Error("DashScope task endpoint requires taskId");
        }
        return `${root}/tasks/${encodeURIComponent(options.taskId)}`;
      case "audio.speech":
        return protocol === "dashscope" ? `${root}/services/audio/tts/SpeechSynthesizer` : `${root}/audio/speech`;
      case "audio.speech.multimodal":
        return `${root}/services/aigc/multimodal-generation/generation`;
      case "audio.realtime.inference":
        return buildDashScopeWebSocketUrl(root, "inference");
      case "audio.realtime.session":
        return buildDashScopeWebSocketUrl(root, "realtime");
      case "audio.hotwords":
        return `${root}/services/audio/asr/customization`;
      case "audio.voices":
        return `${root}/services/audio/tts/customization`;
      case "messages":
        return `${root}/v1/messages`;
      default: {
        throw new Error(`Unhandled capability: ${JSON.stringify(resolvedCapability)}`);
      }
    }
  }
  const who = options.providerId != null && options.providerId !== "" ? `provider_id=${JSON.stringify(options.providerId)}` : "provider";
  throw new Error(
    `${who}: no upstream endpoint for protocol "${protocol}" capability "${resolvedCapability}" (configure providers.endpoints.${protocol})`
  );
}
var OPENAI_ENDPOINT_CAPABILITIES, ANTHROPIC_ENDPOINT_CAPABILITIES, GEMINI_ENDPOINT_CAPABILITIES, GEMINI_LEGACY_ENDPOINT_CAPABILITIES, DASHSCOPE_ENDPOINT_CAPABILITIES, CAPABILITIES_BY_PROTOCOL, ENDPOINT_CAPABILITIES_BY_OPERATION, WRITABLE_CAPABILITIES_BY_PROTOCOL, ALL_CAPABILITIES;
var init_provider_endpoints = __esm({
  "packages/core/src/provider-endpoints.ts"() {
    "use strict";
    init_gemini_upstream_url();
    init_route_topology();
    init_upstream_protocol();
    OPENAI_ENDPOINT_CAPABILITIES = [
      "chat",
      "responses",
      "embeddings",
      "rerank",
      "images.generations",
      "images.edits",
      "audio.transcriptions",
      "audio.speech"
    ];
    ANTHROPIC_ENDPOINT_CAPABILITIES = ["messages"];
    GEMINI_ENDPOINT_CAPABILITIES = [
      GEMINI_GENERATE_OPERATION
    ];
    GEMINI_LEGACY_ENDPOINT_CAPABILITIES = [
      ...GEMINI_LEGACY_GENERATE_OPERATIONS
    ];
    DASHSCOPE_ENDPOINT_CAPABILITIES = [
      "audio.transcriptions",
      "audio.transcriptions.multimodal",
      "audio.transcriptions.tasks",
      "audio.speech",
      "audio.speech.multimodal",
      "audio.realtime.inference",
      "audio.realtime.session",
      "audio.hotwords",
      "audio.voices"
    ];
    CAPABILITIES_BY_PROTOCOL = {
      openai: OPENAI_ENDPOINT_CAPABILITIES,
      anthropic: ANTHROPIC_ENDPOINT_CAPABILITIES,
      gemini: GEMINI_ENDPOINT_CAPABILITIES,
      dashscope: DASHSCOPE_ENDPOINT_CAPABILITIES
    };
    ENDPOINT_CAPABILITIES_BY_OPERATION = {
      openai: {
        chat: ["chat"],
        responses: ["responses"],
        embeddings: ["embeddings"],
        rerank: ["rerank"],
        "images.generations": ["images.generations"],
        "images.edits": ["images.edits"],
        "audio.transcriptions": ["audio.transcriptions"],
        "audio.speech": ["audio.speech"]
      },
      anthropic: {
        messages: ["messages"]
      },
      gemini: {
        [GEMINI_GENERATE_OPERATION]: [GEMINI_GENERATE_OPERATION]
      },
      dashscope: {
        "audio.transcriptions": ["audio.transcriptions"],
        "audio.transcriptions.multimodal": ["audio.transcriptions.multimodal"],
        "audio.transcriptions.async": [
          "audio.transcriptions",
          "audio.transcriptions.tasks"
        ],
        "audio.transcriptions.realtime.inference": ["audio.realtime.inference"],
        "audio.transcriptions.realtime.session": ["audio.realtime.session"],
        "audio.speech": ["audio.speech"],
        // SpeechSynthesizer streaming uses the same HTTP/SSE endpoint.
        "audio.speech.stream": ["audio.speech"],
        "audio.speech.multimodal": ["audio.speech.multimodal"],
        "audio.speech.realtime.inference": ["audio.realtime.inference"],
        "audio.speech.realtime.session": ["audio.realtime.session"]
      }
    };
    WRITABLE_CAPABILITIES_BY_PROTOCOL = {
      openai: OPENAI_ENDPOINT_CAPABILITIES,
      anthropic: ANTHROPIC_ENDPOINT_CAPABILITIES,
      gemini: [...GEMINI_ENDPOINT_CAPABILITIES, ...GEMINI_LEGACY_ENDPOINT_CAPABILITIES],
      dashscope: DASHSCOPE_ENDPOINT_CAPABILITIES
    };
    ALL_CAPABILITIES = /* @__PURE__ */ new Set([
      ...OPENAI_ENDPOINT_CAPABILITIES,
      ...ANTHROPIC_ENDPOINT_CAPABILITIES,
      ...GEMINI_ENDPOINT_CAPABILITIES,
      ...GEMINI_LEGACY_ENDPOINT_CAPABILITIES,
      ...DASHSCOPE_ENDPOINT_CAPABILITIES
    ]);
  }
});

// packages/proxy/src/services/resource-completion.ts
function observeResourceCleanup(operation) {
  try {
    return operation().then(() => "confirmed", () => "unconfirmed");
  } catch {
    return Promise.resolve("unconfirmed");
  }
}
function createResourceCompletionGroup() {
  let pending = 0;
  let sealed = false;
  let outcome = "confirmed";
  let resolve;
  const completion = new Promise((done) => {
    resolve = done;
  });
  const finish = () => {
    if (sealed && pending === 0) resolve(outcome);
  };
  return {
    completion,
    track(task) {
      if (sealed) {
        void task.catch(() => void 0);
        throw new Error("Resource completion group is sealed");
      }
      pending++;
      void task.then((value) => {
        if (value !== "confirmed") outcome = "unconfirmed";
      }, () => {
        outcome = "unconfirmed";
      }).then(() => {
        pending--;
        finish();
      });
    },
    seal() {
      sealed = true;
      finish();
    }
  };
}

// packages/proxy/src/services/egress/owned-upstream-response.ts
function ownUpstreamResponse(response, signal) {
  if (!response.body) return { response, resourceCompletion: Promise.resolve("confirmed") };
  let reader = response.body.getReader();
  let controller;
  let closed = false;
  let resolve;
  const resourceCompletion = new Promise((done) => {
    resolve = done;
  });
  const finish = (outcome) => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", abort);
    reader?.releaseLock();
    reader = void 0;
    resolve(outcome);
  };
  const cancel = () => {
    if (closed) return;
    const source = reader;
    finish(observeResourceCleanup(() => source.cancel("upstream_response_stopped")));
  };
  const abort = () => {
    if (closed) return;
    cancel();
    controller.error(new Error("Upstream response body stopped"));
  };
  const body = new ReadableStream({
    start(value) {
      controller = value;
    },
    async pull(value) {
      if (closed) return;
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          value.close();
          finish("confirmed");
        } else value.enqueue(next.value);
      } catch {
        if (closed) return;
        cancel();
        value.error(new Error("Upstream response body unavailable"));
      }
    },
    cancel
  }, { highWaterMark: 0 });
  const owned = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return { response: owned, resourceCompletion };
}

// packages/proxy/src/services/egress/json-upload-body.ts
import { createHash } from "node:crypto";

// packages/proxy/src/services/egress/compact-json-string-page.ts
var JSON_TEXT_PAGE_CHARS = 64 * 1024;
var CompactJsonStringPage = class _CompactJsonStringPage {
  #bytes;
  #length;
  constructor(text, byteLength) {
    this.#length = text.length;
    this.#bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code < 128) this.#bytes[offset++] = code;
      else if (code === 65533) this.#bytes[offset++] = 255;
      else if (code < 2048) {
        this.#bytes[offset++] = 192 | code >> 6;
        this.#bytes[offset++] = 128 | code & 63;
      } else {
        const low = text.charCodeAt(i + 1);
        if (code >= 55296 && code <= 56319 && low >= 56320 && low <= 57343) {
          code = 65536 + (code - 55296 << 10) + low - 56320;
          i++;
          this.#bytes[offset++] = 240 | code >> 18;
          this.#bytes[offset++] = 128 | code >> 12 & 63;
        } else this.#bytes[offset++] = 224 | code >> 12;
        this.#bytes[offset++] = 128 | code >> 6 & 63;
        this.#bytes[offset++] = 128 | code & 63;
      }
    }
    Object.freeze(this);
  }
  static from(text) {
    if (typeof text !== "string" || text.length > JSON_TEXT_PAGE_CHARS) throw new RangeError("Invalid JSON string page");
    if (text.length < 1024 || !/[^\u0000-\u00ff]/.test(text)) return text;
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i), low = text.charCodeAt(i + 1);
      if (code < 128 || code === 65533) bytes++;
      else if (code < 2048) bytes += 2;
      else if (code >= 55296 && code <= 56319 && low >= 56320 && low <= 57343) {
        bytes += 4;
        i++;
      } else bytes += 3;
    }
    return bytes + 64 < text.length * 2 ? new _CompactJsonStringPage(text, bytes) : text;
  }
  get length() {
    return this.#length;
  }
  get byteLength() {
    return this.#bytes.length;
  }
  decode() {
    const units = new Uint16Array(this.#length), bytes = this.#bytes;
    let offset = 0;
    for (let i = 0; i < bytes.length; ) {
      const lead = bytes[i++];
      if (lead < 128) units[offset++] = lead;
      else if (lead === 255) units[offset++] = 65533;
      else if (lead < 224) units[offset++] = (lead & 31) << 6 | bytes[i++] & 63;
      else if (lead < 240) units[offset++] = (lead & 15) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
      else {
        const point = ((lead & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63) - 65536;
        units[offset++] = 55296 | point >> 10;
        units[offset++] = 56320 | point & 1023;
      }
    }
    const pieces = [];
    for (let i = 0; i < units.length; i += 4096) pieces.push(String.fromCharCode(...units.subarray(i, i + 4096)));
    return pieces.join("");
  }
  toJSON() {
    throw new TypeError("Compact JSON pages are internal only");
  }
  [Symbol.toPrimitive]() {
    throw new TypeError("Compact JSON pages require explicit decoding");
  }
};
var decodeJsonStringPage = (page) => typeof page === "string" ? page : page.decode();

// packages/proxy/src/services/egress/json-string-pages.ts
var JsonStringPages = class _JsonStringPages {
  #pages;
  #length;
  constructor(pages) {
    for (const page of pages) {
      if (typeof page !== "string" && !(page instanceof CompactJsonStringPage) || page.length > JSON_TEXT_PAGE_CHARS) throw new RangeError("Invalid JSON string page");
    }
    this.#pages = Object.freeze([...pages]);
    this.#length = pages.reduce((length, page) => length + page.length, 0);
    Object.freeze(this);
  }
  get length() {
    return this.#length;
  }
  *chunks() {
    for (const page of this.#pages) yield decodeJsonStringPage(page);
  }
  /** Explicit legacy boundary only. Do not retain the full copy in this object. */
  materialize() {
    return [...this.chunks()].join("");
  }
  /** Decode only trim boundaries; share all immutable interior storage pages. */
  trim(checkActive) {
    checkActive?.();
    let first = 0, last = this.#pages.length - 1, start = "", end = "", changed = false;
    while (first <= last) {
      checkActive?.();
      const page = decodeJsonStringPage(this.#pages[first]);
      start = page.trimStart();
      if (start) {
        changed ||= start.length !== page.length;
        break;
      }
      changed = true;
      first++;
    }
    if (first > last) return "";
    while (last >= first) {
      checkActive?.();
      const page = last === first ? start : decodeJsonStringPage(this.#pages[last]);
      end = page.trimEnd();
      if (end) {
        changed ||= end.length !== page.length;
        break;
      }
      changed = true;
      last--;
    }
    if (!changed) return this;
    return new _JsonStringPages(first === last ? [end] : [start, ...this.#pages.slice(first + 1, last), end]);
  }
  toJSON() {
    throw new TypeError("Paged JSON strings require the streaming encoder");
  }
  [Symbol.toPrimitive]() {
    throw new TypeError("Paged JSON strings require explicit materialization");
  }
};
function isJsonString(value) {
  return typeof value === "string" || value instanceof JsonStringPages;
}
function* jsonStringChunks(value) {
  if (value instanceof JsonStringPages) {
    yield* value.chunks();
    return;
  }
  for (let start = 0; start < value.length; start += JSON_TEXT_PAGE_CHARS) {
    yield value.slice(start, start + JSON_TEXT_PAGE_CHARS);
  }
}

// packages/proxy/src/services/egress/stream-json-body.ts
var JSON_OUTPUT_PAGE_BYTES = 64 * 1024;
var JSON_STRING_PIECE_CHARS = 8 * 1024;
var NEEDS_JSON_ESCAPING = /["\\\u0000-\u001f\ud800-\udfff]/;
function assertJsonTree(value, limits, checkActive) {
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1) throw new RangeError("Invalid JSON encoding limits");
  let nodes = 0;
  const active = /* @__PURE__ */ new Set();
  const count = () => {
    if (++nodes > limits.maxNodes) throw new RangeError("JSON encoding structure exceeds its limit");
    checkActive?.();
  };
  const visit = (item, depth) => {
    count();
    if (item === null || isJsonString(item) || typeof item === "boolean" || typeof item === "number") return;
    if (typeof item !== "object" || depth >= limits.maxDepth || active.has(item)) throw new TypeError("Expected a bounded JSON tree");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError("Expected a plain JSON object");
    }
    active.add(item);
    const inspectProperty = (key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("JSON accessors and sparse arrays are not supported");
      const child = descriptor.value;
      visit(child, depth + 1);
    };
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) inspectProperty(String(index));
    } else {
      for (const key of Object.keys(item)) {
        count();
        inspectProperty(key);
      }
    }
    active.delete(item);
  };
  visit(value, 0);
}
function* stringPieces(value) {
  yield '"';
  let highSurrogate = "";
  for (const chunk of jsonStringChunks(value)) {
    for (let start = 0; start < chunk.length; ) {
      const end = Math.min(chunk.length, start + JSON_STRING_PIECE_CHARS - highSurrogate.length);
      let piece = highSurrogate + chunk.slice(start, end);
      start = end;
      highSurrogate = "";
      const last = piece.charCodeAt(piece.length - 1);
      if (last >= 55296 && last <= 56319) {
        highSurrogate = piece.slice(-1);
        piece = piece.slice(0, -1);
      }
      if (piece) yield NEEDS_JSON_ESCAPING.test(piece) ? JSON.stringify(piece).slice(1, -1) : piece;
    }
  }
  if (highSurrogate) yield JSON.stringify(highSurrogate).slice(1, -1);
  yield '"';
}
function* valuePieces(value) {
  if (isJsonString(value)) {
    yield* stringPieces(value);
    return;
  }
  if (value === null || typeof value !== "object") {
    yield JSON.stringify(value);
    return;
  }
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      yield* valuePieces(value[index]);
    }
    yield "]";
  } else {
    yield "{";
    let first = true;
    for (const key of Object.keys(value)) {
      if (!first) yield ",";
      first = false;
      yield* stringPieces(key);
      yield ":";
      yield* valuePieces(value[key]);
    }
    yield "}";
  }
}
function stringByteLength(value, checkActive) {
  let length = 2, highSurrogate = false;
  for (const chunk of jsonStringChunks(value)) {
    for (let index = 0; index < chunk.length; index++) {
      if (index % JSON_STRING_PIECE_CHARS === 0) checkActive?.();
      const code = chunk.charCodeAt(index);
      if (highSurrogate) {
        highSurrogate = false;
        if (code >= 56320 && code <= 57343) {
          length += 4;
          continue;
        }
        length += 6;
      }
      if (code >= 55296 && code <= 56319) highSurrogate = true;
      else if (code >= 56320 && code <= 57343) length += 6;
      else if (code < 32) length += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
      else if (code === 34 || code === 92) length += 2;
      else length += code < 128 ? 1 : code < 2048 ? 2 : 3;
    }
  }
  return length + (highSurrogate ? 6 : 0);
}
function jsonBodyByteLength(value, limits, checkActive) {
  assertJsonTree(value, limits, checkActive);
  let length = 0;
  const add = (bytes) => {
    length += bytes;
    if (!Number.isSafeInteger(length)) throw new RangeError("JSON wire length exceeds the safe integer range");
  };
  const count = (item) => {
    checkActive?.();
    if (isJsonString(item)) {
      add(stringByteLength(item, checkActive));
      return;
    }
    if (item === null || typeof item !== "object") {
      add(JSON.stringify(item).length);
      return;
    }
    if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1));
      for (let index = 0; index < item.length; index++) count(item[index]);
    } else {
      const keys = Object.keys(item);
      add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        add(stringByteLength(key, checkActive) + 1);
        count(item[key]);
      }
    }
  };
  count(value);
  return length;
}
function streamJsonBody(value, limits, lifecycle = {}) {
  lifecycle.signal?.throwIfAborted();
  lifecycle.checkActive?.();
  assertJsonTree(value, limits, lifecycle.checkActive);
  let iterator = valuePieces(value);
  value = void 0;
  let pending = "";
  let closed = false;
  let controller;
  const encoder6 = new TextEncoder();
  const finish = () => {
    if (closed) return;
    closed = true;
    lifecycle.signal?.removeEventListener("abort", onAbort);
    iterator?.return();
    iterator = void 0;
    pending = "";
    const onFinished = lifecycle.onFinished;
    lifecycle = {};
    onFinished?.();
  };
  const fail = () => {
    if (closed) return;
    finish();
    controller.error(new Error("JSON response delivery was interrupted"));
  };
  const onAbort = () => fail();
  return new ReadableStream({
    start(target) {
      controller = target;
      lifecycle.signal?.addEventListener("abort", onAbort, { once: true });
      if (lifecycle.signal?.aborted) onAbort();
    },
    pull(target) {
      if (closed) return;
      try {
        lifecycle.checkActive?.();
        lifecycle.signal?.throwIfAborted();
        if (closed) return;
        const page = new Uint8Array(JSON_OUTPUT_PAGE_BYTES);
        let used = 0;
        while (used < page.length) {
          if (!pending) {
            const next = iterator.next();
            if (next.done) {
              finish();
              break;
            }
            pending = next.value;
            if (!pending) continue;
          }
          const { read, written } = encoder6.encodeInto(pending, page.subarray(used));
          if (read === 0) break;
          used += written;
          pending = pending.slice(read);
        }
        if (used) target.enqueue(used === page.length ? page : page.subarray(0, used));
        if (closed) target.close();
      } catch {
        fail();
      }
    },
    cancel() {
      finish();
    }
  }, { highWaterMark: 0 });
}

// packages/proxy/src/services/egress/json-upload-body.ts
var ENCODING_LIMITS = Object.freeze({ maxDepth: Number.MAX_SAFE_INTEGER, maxNodes: Number.MAX_SAFE_INTEGER });
function snapshotJson(value, checkActive, active = /* @__PURE__ */ new Set(), key = "") {
  checkActive();
  if (value instanceof JsonStringPages) return value;
  if (value !== null && typeof value === "object" || typeof value === "bigint") {
    const toJSON = value.toJSON;
    if (typeof toJSON === "function") value = Reflect.apply(toJSON, value, [key]);
  }
  if (value instanceof Number) value = Number(value);
  else if (value instanceof String) value = String(value);
  else if (value instanceof Boolean) value = Boolean.prototype.valueOf.call(value);
  else if (value instanceof BigInt) throw new TypeError("JSON request bigint is not supported");
  if (typeof value === "function" || typeof value === "symbol") return void 0;
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" || value === void 0) return value;
  if (typeof value !== "object" || active.has(value)) throw new TypeError("Expected a JSON request without cycles or bigint");
  active.add(value);
  const source = value;
  const property = (name) => snapshotJson(source[name], checkActive, active, name);
  let result;
  if (Array.isArray(value)) {
    const array = [];
    const length = value.length;
    for (let index = 0; index < length; index++) array.push(property(String(index)) ?? null);
    result = array;
  } else {
    const object = {};
    for (const key2 of Object.keys(value)) {
      const child = property(key2);
      if (child !== void 0) Object.defineProperty(object, key2, { value: child, enumerable: true, configurable: true, writable: true });
    }
    result = object;
  }
  active.delete(value);
  return Object.freeze(result);
}
function createJsonUploadBody(value, signal, checkActive) {
  const assertActive = () => {
    signal.throwIfAborted();
    checkActive();
  };
  const snapshot = snapshotJson(value, assertActive);
  const contentLength = jsonBodyByteLength(snapshot, ENCODING_LIMITS, assertActive);
  const owner = new AbortController();
  const onAbort = () => {
    owner.abort();
  };
  const onFinished = () => {
    signal.removeEventListener("abort", onAbort);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    assertActive();
    const body = streamJsonBody(snapshot, ENCODING_LIMITS, { signal: owner.signal, checkActive: assertActive, onFinished });
    const digestSha256 = async () => {
      const hash = createHash("sha256");
      const digestBody = streamJsonBody(snapshot, ENCODING_LIMITS, {
        signal,
        checkActive: assertActive
      });
      const reader = digestBody.getReader();
      let bytes = 0;
      try {
        while (true) {
          assertActive();
          const part = await reader.read();
          assertActive();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > contentLength) throw new Error("JSON upload digest length mismatch");
          hash.update(part.value);
        }
        if (bytes !== contentLength) throw new Error("JSON upload digest length mismatch");
        return hash.digest("hex");
      } finally {
        void reader.cancel("json_upload_digest_finished").catch(() => void 0);
        reader.releaseLock();
      }
    };
    return {
      body,
      contentLength,
      preparedSnapshot: snapshot,
      digestSha256,
      dispose: () => {
        onFinished();
        owner.abort();
      }
    };
  } catch (error) {
    onFinished();
    throw error;
  }
}

// packages/proxy/src/services/egress/owned-json-upload-body.ts
function createOwnedJsonUploadBody(value, signal) {
  const raw = createJsonUploadBody(value, new AbortController().signal, () => signal.throwIfAborted());
  return ownEncoder(raw, signal);
}
function ownEncoder(raw, signal) {
  let reader;
  let controller;
  let closed = false, pulled = false;
  let resolveResource;
  const resourceCompletion = new Promise((resolve) => {
    resolveResource = resolve;
  });
  const finish = (outcome) => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", stop);
    raw.dispose();
    reader?.releaseLock();
    reader = void 0;
    resolveResource(outcome);
  };
  const streamSource = {
    // workerd's declared source length, not a manually forced HTTP header.
    expectedLength: raw.contentLength,
    start(source) {
      controller = source;
    },
    async pull(source) {
      if (closed) return;
      pulled = true;
      try {
        reader ??= raw.body.getReader();
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          source.close();
          finish("confirmed");
        } else source.enqueue(next.value);
      } catch {
        if (!closed) {
          source.error(new Error("JSON upload encoding failed"));
          finish("unconfirmed");
        }
      }
    },
    cancel() {
      const completion = observeResourceCleanup(() => reader ? reader.cancel() : raw.body.cancel());
      finish(completion);
      return completion.then(() => void 0);
    }
  };
  const body = new ReadableStream(streamSource, { highWaterMark: 0 });
  function stop() {
    if (closed) return;
    const untouched = !pulled && !body.locked;
    controller.error(new Error("JSON upload stopped"));
    finish(untouched ? "confirmed" : "unconfirmed");
  }
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return {
    body,
    contentLength: raw.contentLength,
    preparedSnapshot: raw.preparedSnapshot,
    digestSha256: raw.digestSha256,
    resourceCompletion,
    stop
  };
}

// packages/proxy/src/services/egress/with-owned-json-upload.ts
async function withOwnedJsonUpload(value, signal, run) {
  const resources = createResourceCompletionGroup();
  const upload = createOwnedJsonUploadBody(value, signal ?? new AbortController().signal);
  resources.track(upload.resourceCompletion);
  try {
    const result = await run(upload);
    if (result.resourceCompletion) resources.track(result.resourceCompletion);
    return { ...result, resourceCompletion: resources.completion };
  } finally {
    upload.stop();
    resources.seal();
  }
}

// packages/proxy/src/services/egress/prepared-text-attempt.ts
import { createHash as createHash2 } from "node:crypto";
var SHA256_HEX = /^[a-f0-9]{64}$/;
var ROUTE_DOMAIN = "cinatoken.text.route-source.v1\n";
var CREDENTIAL_DOMAIN = "cinatoken.text.wire-credentials.v1\n";
var sha256 = (value) => createHash2("sha256").update(value).digest("hex");
function captureTextRouteIdentity(route2) {
  const source = JSON.stringify([
    route2.targetId,
    route2.providerId,
    route2.endpoint?.id ?? null,
    route2.providerKeyId ?? null,
    route2.providerModelName,
    route2.upstreamProtocol,
    route2.upstreamOperation,
    route2.providerEndpoints,
    route2.providerApiKey
  ]);
  if (!source || !route2.targetId || !route2.providerId || !route2.providerModelName) {
    throw new TypeError("Incomplete text route identity");
  }
  return Object.freeze({
    targetId: route2.targetId,
    providerId: route2.providerId,
    endpointId: route2.endpoint?.id ?? null,
    providerKeyId: route2.providerKeyId ?? null,
    providerModelName: route2.providerModelName,
    upstreamProtocol: route2.upstreamProtocol,
    upstreamOperation: route2.upstreamOperation,
    routeSourceSha256: createHash2("sha256").update(ROUTE_DOMAIN).update(source).digest("hex")
  });
}
function createPreparedTextAttempt(params) {
  if (!SHA256_HEX.test(params.outboundBodySha256) || params.outboundBodyCanonicalSha256 !== void 0 && !SHA256_HEX.test(params.outboundBodyCanonicalSha256) || !Number.isSafeInteger(params.outboundBodyBytes) || params.outboundBodyBytes < 0) {
    throw new TypeError("Invalid prepared text body identity");
  }
  const url = new URL(params.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Invalid prepared text upstream URL");
  }
  const headers = new Headers(params.headers);
  const bindings = [];
  const authorization = headers.get("authorization");
  if (authorization) {
    const bearer = /^Bearer (.*)$/i.exec(authorization);
    if (!bearer) throw new TypeError("Unsupported text authorization identity");
    bindings.push(Object.freeze({ location: "authorization-bearer", sha256: sha256(bearer[1]) }));
  }
  const apiKey = headers.get("x-api-key");
  if (apiKey !== null) bindings.push(Object.freeze({ location: "x-api-key", sha256: sha256(apiKey) }));
  for (const queryKey of url.searchParams.getAll("key")) {
    bindings.push(Object.freeze({ location: "query-key", sha256: sha256(queryKey) }));
  }
  if (url.username || url.password) {
    bindings.push(Object.freeze({ location: "url-userinfo", sha256: sha256(`${url.username}:${url.password}`) }));
  }
  if (bindings.length === 0) throw new TypeError("Missing prepared text credential identity");
  const credentialBindings = Object.freeze(bindings);
  return Object.freeze({
    kind: "text-json-v1",
    routeIdentity: params.routeIdentity,
    method: params.method,
    upstreamUrlSha256: sha256(params.url),
    outboundBodySha256: params.outboundBodySha256,
    outboundBodyBytes: params.outboundBodyBytes,
    ...params.outboundBodyCanonicalSha256 === void 0 ? {} : { outboundBodyCanonicalSha256: params.outboundBodyCanonicalSha256 },
    credentialBindings,
    credentialFingerprintSha256: createHash2("sha256").update(CREDENTIAL_DOMAIN).update(JSON.stringify(credentialBindings)).digest("hex")
  });
}

// packages/core/src/gcp-oauth-lifecycle.ts
var GCP_OAUTH_TIMEOUT_MS = 3e4;
var GCP_OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;
var GcpTokenExchangeError = class extends Error {
  constructor(code, status) {
    const messages = {
      cancelled: "GCP token exchange cancelled",
      timeout: "GCP token exchange timed out",
      failed: "GCP token exchange failed",
      invalid_response: "GCP token exchange returned an invalid response",
      response_too_large: "GCP token exchange response exceeds the limit",
      http_error: "GCP token exchange was rejected"
    };
    super(messages[code]);
    this.code = code;
    this.status = status;
    this.name = "GcpTokenExchangeError";
  }
};
function createGcpOAuthLifecycle(parentSignal, timeoutMs = GCP_OAUTH_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GCP_OAUTH_TIMEOUT_MS) {
    throw new RangeError("Invalid GCP OAuth timeout");
  }
  const controller = new AbortController();
  const deadlineAtMs = Date.now() + timeoutMs;
  let closed = false;
  const stop = (code) => controller.abort(new GcpTokenExchangeError(code));
  const onParentAbort = () => stop("cancelled");
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  const check = () => {
    if (!controller.signal.aborted && Date.now() >= deadlineAtMs) stop("timeout");
    controller.signal.throwIfAborted();
    if (closed) throw new GcpTokenExchangeError("cancelled");
  };
  async function wait(operation, discard) {
    check();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => controller.signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        settled = true;
        cleanup();
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      void Promise.resolve().then(() => {
        check();
        return operation();
      }).then((value) => {
        cleanup();
        if (settled) {
          discard?.(value);
          return;
        }
        try {
          check();
        } catch (error) {
          settled = true;
          discard?.(value);
          reject(error);
          return;
        }
        settled = true;
        resolve(value);
      }, (error) => {
        cleanup();
        settled = true;
        reject(error);
      }).catch(reject);
    });
  }
  return {
    signal: controller.signal,
    check,
    wait,
    dispose() {
      closed = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  };
}
function discardGcpOAuthResponse(response) {
  void response.body?.cancel("gcp_oauth_stopped").catch(() => void 0);
}
async function readGcpOAuthResponse(response, owner) {
  try {
    owner.check();
  } catch (error) {
    discardGcpOAuthResponse(response);
    throw error;
  }
  if (Number(response.headers.get("content-length")) > GCP_OAUTH_MAX_RESPONSE_BYTES) {
    discardGcpOAuthResponse(response);
    throw new GcpTokenExchangeError("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const bytes = new Uint8Array(GCP_OAUTH_MAX_RESPONSE_BYTES);
  let size = 0;
  let eof = false;
  try {
    while (true) {
      const { done, value } = await owner.wait(() => reader.read());
      if (done) {
        eof = true;
        break;
      }
      if (value.byteLength > bytes.byteLength - size) throw new GcpTokenExchangeError("response_too_large");
      bytes.set(value, size);
      size += value.byteLength;
    }
    owner.check();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } finally {
    if (!eof) void reader.cancel("gcp_oauth_stopped").catch(() => void 0);
    reader.releaseLock();
  }
}

// packages/core/src/request-auxiliary-auth-budget.ts
var RequestAuxiliaryAuthLimitError = class extends Error {
  constructor() {
    super("Request auxiliary authentication limit reached");
    this.name = "RequestAuxiliaryAuthLimitError";
  }
};

// packages/core/src/gcp-service-account-token.ts
var GCP_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
var GCP_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
var TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1e3;
var JWT_LIFETIME_SECONDS = 3600;
var GCP_TOKEN_CACHE_MAX_ENTRIES = 256;
var tokenCache = /* @__PURE__ */ new Map();
var cacheGeneration = {};
function parseGcpServiceAccountJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.type !== "service_account") return null;
    const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email.trim() : "";
    const privateKey = typeof parsed.private_key === "string" ? parsed.private_key : "";
    if (!clientEmail || !privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
      return null;
    }
    const tokenUri = typeof parsed.token_uri === "string" ? parsed.token_uri.trim() : "";
    return {
      type: "service_account",
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, "\n"),
      ...tokenUri ? { token_uri: tokenUri } : {}
    };
  } catch {
    return null;
  }
}
function gcpServiceAccountCacheKey(account) {
  return JSON.stringify([account.client_email, account.private_key, account.token_uri?.trim() || GCP_OAUTH_TOKEN_URL, GCP_CLOUD_PLATFORM_SCOPE]);
}
async function resolveProviderUpstreamSecret(raw, options = {}) {
  if (options.signal?.aborted) throw new GcpTokenExchangeError("cancelled");
  const account = parseGcpServiceAccountJson(raw);
  if (!account) {
    return { secret: raw, isServiceAccount: false };
  }
  const accessToken = await getGcpAccessToken(account, options);
  return {
    secret: accessToken,
    isServiceAccount: true,
    clientEmail: account.client_email
  };
}
async function getGcpAccessToken(account, options = {}) {
  const nowMs = options.nowMs ?? Date.now;
  const owner = createGcpOAuthLifecycle(options.signal, options.timeoutMs);
  const generation = cacheGeneration;
  try {
    const digest = await owner.wait(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(gcpServiceAccountCacheKey(account))));
    const cacheKey = base64UrlEncode(new Uint8Array(digest));
    for (const [key, token2] of tokenCache) {
      if (token2.expiresAtMs - TOKEN_REFRESH_SKEW_MS <= nowMs()) tokenCache.delete(key);
    }
    const cached = tokenCache.get(cacheKey);
    if (cached) {
      tokenCache.delete(cacheKey);
      tokenCache.set(cacheKey, cached);
      return cached.accessToken;
    }
    const token = await exchangeGcpAccessToken(account, options, owner);
    owner.check();
    if (generation === cacheGeneration && token.expiresAtMs - TOKEN_REFRESH_SKEW_MS > nowMs()) {
      tokenCache.delete(cacheKey);
      while (tokenCache.size >= GCP_TOKEN_CACHE_MAX_ENTRIES) {
        const oldest = tokenCache.keys().next();
        if (!oldest.done) tokenCache.delete(oldest.value);
      }
      tokenCache.set(cacheKey, token);
    }
    return token.accessToken;
  } catch (error) {
    owner.check();
    if (error instanceof RequestAuxiliaryAuthLimitError) throw error;
    throw error instanceof GcpTokenExchangeError ? error : new GcpTokenExchangeError("failed");
  } finally {
    owner.dispose();
  }
}
async function exchangeGcpAccessToken(account, options, owner) {
  const nowMs = options.nowMs ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenUrl = account.token_uri?.trim() || GCP_OAUTH_TOKEN_URL;
  options.auxiliaryAuth?.assertAvailable();
  const assertion = await signGcpServiceAccountJwt(account, tokenUrl, nowMs, owner);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });
  const requestedAtMs = nowMs();
  const response = await owner.wait(() => {
    options.auxiliaryAuth?.consume();
    return fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: owner.signal,
      redirect: "manual"
    });
  }, discardGcpOAuthResponse);
  if (!response.ok) {
    discardGcpOAuthResponse(response);
    throw new GcpTokenExchangeError("http_error", response.status);
  }
  const text = await readGcpOAuthResponse(response, owner);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new GcpTokenExchangeError("invalid_response");
  }
  if (payload == null || typeof payload !== "object" || Array.isArray(payload) || !("access_token" in payload) || typeof payload.access_token !== "string" || !/^[\x21-\x7e]+$/.test(payload.access_token) || !("expires_in" in payload) || typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0 || "token_type" in payload && (typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer")) {
    throw new GcpTokenExchangeError("invalid_response");
  }
  const expiresAtMs = requestedAtMs + Math.min(JWT_LIFETIME_SECONDS, payload.expires_in) * 1e3;
  if (expiresAtMs <= nowMs()) throw new GcpTokenExchangeError("invalid_response");
  return {
    accessToken: payload.access_token,
    expiresAtMs
  };
}
async function signGcpServiceAccountJwt(account, audience, nowMs = Date.now, owner) {
  owner?.check();
  const nowSeconds = Math.floor(nowMs() / 1e3);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.client_email,
    sub: account.client_email,
    aud: audience,
    iat: nowSeconds,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    scope: GCP_CLOUD_PLATFORM_SCOPE
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const key = await (owner ? owner.wait(() => importRsaPrivateKey(account.private_key)) : importRsaPrivateKey(account.private_key));
  const sign = () => crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    bytesToArrayBuffer(new TextEncoder().encode(signingInput))
  );
  const signature = await (owner ? owner.wait(sign) : sign());
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
async function importRsaPrivateKey(pem) {
  return crypto.subtle.importKey(
    "pkcs8",
    bytesToArrayBuffer(decodePemToDer(pem)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
function bytesToArrayBuffer(bytes) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
function decodePemToDer(pem) {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const pkcs8 = normalized.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (pkcs8?.[1]) return uint8FromBase64(pkcs8[1]);
  const pkcs1 = normalized.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/);
  if (pkcs1?.[1]) {
    return wrapPkcs1ToPkcs8(uint8FromBase64(pkcs1[1]));
  }
  throw new Error("GCP service account private_key must be a PEM PRIVATE KEY");
}
function wrapPkcs1ToPkcs8(pkcs1) {
  const version = new Uint8Array([2, 1, 0]);
  const rsaOid = new Uint8Array([
    48,
    13,
    6,
    9,
    42,
    134,
    72,
    134,
    247,
    13,
    1,
    1,
    1,
    5,
    0
  ]);
  const octet = encodeDer(4, pkcs1);
  return encodeDer(48, concatBytes(version, rsaOid, octet));
}
function encodeDer(tag, content) {
  const length = encodeDerLength(content.length);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}
function encodeDerLength(length) {
  if (length < 128) return new Uint8Array([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 255);
    value >>= 8;
  }
  return new Uint8Array([128 | bytes.length, ...bytes]);
}
function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function base64UrlJson(value) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}
function base64UrlEncode(bytes) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64Encode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function uint8FromBase64(base64) {
  const cleaned = base64.replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// packages/core/src/request-deadline.ts
var RequestExecutionStoppedError = class extends Error {
  constructor(reason) {
    super(reason === "deadline_exceeded" ? "Request deadline exceeded" : "Request was cancelled");
    this.reason = reason;
    this.name = "RequestExecutionStoppedError";
  }
};

// packages/core/src/vertex-openai-model.ts
function isVertexOpenAiCompatibleUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().endsWith("aiplatform.googleapis.com") && parsed.pathname.includes("/endpoints/openapi");
  } catch {
    return false;
  }
}
function applyVertexOpenAiModelPrefix(upstreamUrl, modelName) {
  const trimmed = modelName.trim();
  if (!trimmed || !isVertexOpenAiCompatibleUrl(upstreamUrl)) return trimmed;
  if (trimmed.includes("/")) return trimmed;
  return `google/${trimmed}`;
}

// packages/core/src/model-endpoint-catalog.ts
var AUDIO_ENDPOINT_PRICING_OPERATIONS = [
  "audio.transcriptions",
  "audio.transcriptions.multimodal",
  "audio.transcriptions.async",
  "audio.transcriptions.realtime.inference",
  "audio.transcriptions.realtime.session",
  "audio.speech",
  "audio.speech.stream",
  "audio.speech.multimodal",
  "audio.speech.realtime.inference"
];
var PRICE_KEYS = [
  "audio",
  "audio_output",
  "completion",
  "discount",
  "image",
  "image_output",
  "image_token",
  "input_audio_cache",
  "input_cache_read",
  "input_cache_write",
  "input_cache_write_1h",
  "internal_reasoning",
  "prompt",
  "request",
  "web_search",
  "currency"
];
var OPTIONAL_DECIMAL_PRICE_KEYS = PRICE_KEYS.filter(
  (key) => !["currency", "prompt", "completion", "discount"].includes(key)
);

// packages/proxy/src/services/request-deadline.ts
function markTextStreamCancellation(usage, signal) {
  if (signal?.reason instanceof RequestExecutionStoppedError && signal.reason.reason === "deadline_exceeded") {
    usage.stream_error ??= "Request deadline exceeded";
  } else {
    usage.cancelled = true;
  }
}

// packages/proxy/src/services/route-default-params.ts
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonStringPages);
}
function deepMergeDefaults(defaultValue, userValue) {
  if (userValue !== void 0) {
    if (Array.isArray(userValue)) {
      return userValue;
    }
    if (isPlainObject(defaultValue) && isPlainObject(userValue)) {
      const merged = {};
      const keys = /* @__PURE__ */ new Set([...Object.keys(defaultValue), ...Object.keys(userValue)]);
      for (const key of keys) {
        merged[key] = deepMergeDefaults(defaultValue[key], userValue[key]);
      }
      return merged;
    }
    return userValue;
  }
  return defaultValue;
}
function buildRouteRequestBody(route2, userBody) {
  const finalBody = deepMergeDefaults(route2.customParams ?? {}, userBody);
  const normalized = isPlainObject(finalBody) ? finalBody : { ...userBody };
  const speedControlledBody = route2.gatewayTextSpeedControlled ? { ...normalized } : normalized;
  if (route2.gatewayTextSpeedControlled) delete speedControlledBody.speed;
  const sessionControlledBody = route2.gatewaySessionIdControlled ? { ...speedControlledBody } : speedControlledBody;
  if (route2.gatewaySessionIdControlled) delete sessionControlledBody.session_id;
  const withSpeed = route2.gatewayTextSpeed ? { ...sessionControlledBody, speed: route2.gatewayTextSpeed } : sessionControlledBody;
  const requestedServiceTier = route2.gatewayRequestedServiceTier ?? route2.gatewayServiceTier;
  return requestedServiceTier ? { ...withSpeed, service_tier: requestedServiceTier } : withSpeed;
}

// packages/proxy/src/services/bounded-request-body.ts
var MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;

// packages/proxy/src/services/chat-final-quote-input.ts
var FinalChatQuoteInputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FinalChatQuoteInputError";
  }
};
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FinalChatQuoteInputError("Final Chat body contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new FinalChatQuoteInputError("Final Chat body contains a non-JSON object");
    }
    const out = /* @__PURE__ */ Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === void 0) throw new FinalChatQuoteInputError("Final Chat body contains undefined");
      out[key] = canonical(item);
    }
    return out;
  }
  throw new FinalChatQuoteInputError("Final Chat body contains non-JSON data");
}
function canonicalJson(value) {
  const encoded = JSON.stringify(canonical(value));
  if (typeof encoded !== "string") throw new FinalChatQuoteInputError("Final Chat body is not JSON");
  return encoded;
}
async function sha256Hex(data) {
  const owned = data instanceof ArrayBuffer ? data : new ArrayBuffer(data.byteLength);
  if (data instanceof Uint8Array) new Uint8Array(owned).set(data);
  const bytes = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function canonicalChatJsonSha256(value) {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

// packages/proxy/src/services/egress/upstream-request-id.ts
var UPSTREAM_REQUEST_ID_HEADER_NAMES = [
  // —— provider 官方标准头 ——
  "x-request-id",
  // OpenAI 及多数 OpenAI 兼容供应商
  "request-id",
  // Anthropic（直连）
  "anthropic-request-id",
  "x-goog-request-id",
  // Google / Gemini
  "x-amzn-requestid",
  // AWS Bedrock
  "x-amzn-request-id",
  "apim-request-id",
  // Azure API Management（Azure OpenAI）
  "x-ms-request-id",
  // Azure
  // —— Gemini / Google 中转与 CDN 兜底头 ——
  "http_x_reqid",
  // 七牛 APISIX 等代理（上游 x-goog-request-id 的别名）
  "x-cloud-trace-context",
  // GCP（值为 TRACE_ID/SPAN;o=1，取 TRACE_ID 段）
  "eo-log-uuid",
  // EdgeOne CDN
  // —— 其他中转 / CDN 兜底头 ——
  "x-ws-request-id"
  // 网宿（Wangsu）边缘网关
];
var UPSTREAM_ID_MAX_LENGTH = 200;
function normalizeUpstreamId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > UPSTREAM_ID_MAX_LENGTH) return null;
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : null;
}
function normalizeCloudTraceContextRequestId(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  return normalizeUpstreamId(slash >= 0 ? trimmed.slice(0, slash) : trimmed);
}
function extractHeaderRequestId(headers, name) {
  const raw = headers.get(name);
  if (!raw) return null;
  if (name === "x-cloud-trace-context") {
    return normalizeCloudTraceContextRequestId(raw);
  }
  return normalizeUpstreamId(raw);
}
function extractUpstreamRequestId(headers) {
  for (const name of UPSTREAM_REQUEST_ID_HEADER_NAMES) {
    const value = extractHeaderRequestId(headers, name);
    if (value) return value;
  }
  return null;
}

// packages/proxy/src/services/egress/sse-data-line.ts
function fieldName(line) {
  const separator = line.indexOf(":");
  return separator < 0 ? line : line.slice(0, separator);
}
function fieldValue(line) {
  const separator = line.indexOf(":");
  if (separator < 0) return "";
  const value = line.slice(separator + 1);
  return value.startsWith(" ") ? value.slice(1) : value;
}
function isDataField(line) {
  return fieldName(line) === "data";
}
function parseSseEventData(event) {
  const values = [];
  for (const line of event.split(/\r\n|\r|\n/)) {
    if (line.startsWith(":") || !isDataField(line)) continue;
    values.push(fieldValue(line));
  }
  return values.length > 0 ? values.join("\n") : null;
}
function preferredLineEnding(event) {
  if (event.includes("\r\n")) return "\r\n";
  if (event.includes("\r")) return "\r";
  return "\n";
}
function rewriteSseEventData(event, data) {
  const lineEnding = preferredLineEnding(event);
  const lines = event.split(/\r\n|\r|\n/);
  while (lines.at(-1) === "") lines.pop();
  const rewritten = [];
  let inserted = false;
  for (const line of lines) {
    if (!isDataField(line)) {
      rewritten.push(line);
      continue;
    }
    if (!inserted) {
      rewritten.push(`data: ${data}`);
      inserted = true;
    }
  }
  if (!inserted) rewritten.push(`data: ${data}`);
  return `${rewritten.join(lineEnding)}${lineEnding}${lineEnding}`;
}
function terminateSseEvent(event) {
  const lineEnding = preferredLineEnding(event);
  const lines = event.split(/\r\n|\r|\n/);
  while (lines.at(-1) === "") lines.pop();
  return `${lines.join(lineEnding)}${lineEnding}${lineEnding}`;
}
function lineEndingLengthAt(value, index) {
  if (value[index] === "\n") return 1;
  if (value[index] !== "\r") return 0;
  if (index + 1 >= value.length) return -1;
  return value[index + 1] === "\n" ? 2 : 1;
}
function findEventBoundaryEnd(value, start) {
  let index = start;
  while (index < value.length) {
    const firstLength = lineEndingLengthAt(value, index);
    if (firstLength < 0) return null;
    if (firstLength === 0) {
      index += 1;
      continue;
    }
    const secondIndex = index + firstLength;
    const secondLength = lineEndingLengthAt(value, secondIndex);
    if (secondLength < 0) return null;
    if (secondLength > 0) return secondIndex + secondLength;
    index = secondIndex;
  }
  return null;
}
var BoundedSseEventFramer = class {
  constructor(maxEventChars, limitErrorMessage) {
    this.maxEventChars = maxEventChars;
    this.limitErrorMessage = limitErrorMessage;
  }
  buffer = "";
  async push(chunk, handleEvent) {
    this.buffer += chunk;
    let consumed = 0;
    while (true) {
      const boundaryEnd = findEventBoundaryEnd(this.buffer, consumed);
      if (boundaryEnd === null) break;
      if (boundaryEnd - consumed > this.maxEventChars) {
        this.buffer = "";
        throw new Error(this.limitErrorMessage);
      }
      const event = this.buffer.slice(consumed, boundaryEnd);
      consumed = boundaryEnd;
      if (await handleEvent(event)) {
        this.buffer = "";
        return true;
      }
    }
    if (consumed > 0) this.buffer = this.buffer.slice(consumed);
    if (this.buffer.length > this.maxEventChars) {
      this.buffer = "";
      throw new Error(this.limitErrorMessage);
    }
    return false;
  }
  finish() {
    if (this.buffer.length > this.maxEventChars) {
      this.buffer = "";
      throw new Error(this.limitErrorMessage);
    }
    const remainder = this.buffer;
    this.buffer = "";
    return remainder;
  }
};

// packages/proxy/src/services/egress/audio-transcription-upload.ts
var PAGE_BYTES = 64 * 1024;
var TEXT_UNITS = 8 * 1024;
var encoder = new TextEncoder();

// packages/proxy/src/services/egress/bounded-response-body.ts
var UpstreamResponseBodyTooLargeError = class extends Error {
  constructor(upstreamStatus) {
    super("Upstream response body exceeds the configured limit");
    this.upstreamStatus = upstreamStatus;
    this.name = "UpstreamResponseBodyTooLargeError";
  }
};
async function consumeResponseTextWithinLimit(response, maxBytes, consumeText, signal, trackResourceCompletion) {
  let cancellation;
  const cancel = (source, reason) => {
    if (!source || cancellation) return;
    cancellation = observeResourceCleanup(() => source.cancel(reason));
    trackResourceCompletion?.(cancellation);
  };
  if (signal?.aborted) {
    cancel(response.body, signal.reason);
    signal.throwIfAborted();
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    cancel(response.body, "upstream_response_too_large");
    throw new UpstreamResponseBodyTooLargeError(response.status);
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let rejectPendingRead;
  const onAbort = () => {
    rejectPendingRead?.(signal?.reason);
    cancel(reader, signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await new Promise((resolve, reject) => {
        rejectPendingRead = reject;
        void reader.read().then(resolve, reject);
      });
      rejectPendingRead = void 0;
      signal?.throwIfAborted();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        cancel(reader, "upstream_response_too_large");
        throw new UpstreamResponseBodyTooLargeError(response.status);
      }
      try {
        for (let offset = 0; offset < value.byteLength; offset += 64 * 1024) {
          signal?.throwIfAborted();
          consumeText(decoder.decode(value.subarray(offset, offset + 64 * 1024), { stream: true }));
        }
      } catch (error) {
        cancel(reader, "upstream_response_inspection_failed");
        throw error;
      }
    }
    consumeText(decoder.decode());
  } catch (error) {
    cancel(reader, "upstream_response_read_failed");
    throw error;
  } finally {
    rejectPendingRead = void 0;
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
async function responseTextWithinLimit(response, maxBytes, signal, inspectText, trackResourceCompletion) {
  const parts = [];
  let page = "";
  await consumeResponseTextWithinLimit(response, maxBytes, (text) => {
    inspectText?.(text);
    page += text;
    if (page.length >= 64 * 1024) {
      parts.push(page);
      page = "";
    }
  }, signal, trackResourceCompletion);
  if (page) parts.push(page);
  return parts.join("");
}

// packages/proxy/src/services/gateway-error-codes.ts
var GATEWAY_ERROR_CODE_HEADER = "X-OctaFuse-Error-Code";
var GatewayErrorCode = {
  // gateway.*
  invalidJson: "gateway.invalid_json",
  missingModel: "gateway.missing_model",
  modelNotFound: "gateway.model_not_found",
  budgetExceeded: "gateway.budget_exceeded",
  authFailed: "gateway.auth_failed",
  permissionDenied: "gateway.permission_denied",
  authRateLimited: "gateway.auth_rate_limited",
  publicCatalogRateLimited: "gateway.public_catalog_rate_limited",
  analyticsRateLimited: "gateway.analytics_rate_limited",
  publicCatalogUnavailable: "gateway.public_catalog_unavailable",
  internalError: "gateway.internal_error",
  imageSettlementUnconfirmed: "gateway.image_settlement_unconfirmed",
  capacityUnavailable: "gateway.capacity_unavailable",
  routeNotFound: "gateway.route_not_found",
  payloadTooLarge: "gateway.payload_too_large",
  noRoute: "gateway.no_route",
  routeResolutionFailed: "gateway.route_resolution_failed",
  invalidRequest: "gateway.invalid_request",
  resourceConflict: "gateway.resource_conflict",
  invalidPresetReference: "gateway.invalid_preset_reference",
  presetNotFound: "gateway.preset_not_found",
  presetInvalid: "gateway.preset_invalid",
  guardrailBlocked: "gateway.guardrail_blocked",
  guardrailInvalid: "gateway.guardrail_invalid",
  zdrNoRoute: "gateway.zdr_no_route",
  dataCollectionNoRoute: "gateway.data_collection_no_route",
  zdrToolsUnsupported: "gateway.zdr_tools_unsupported",
  upstreamRequestFailed: "gateway.upstream_request_failed",
  dispatchLimitExceeded: "gateway.dispatch_limit_exceeded",
  auxiliaryAuthLimitExceeded: "gateway.auxiliary_auth_limit_exceeded",
  requestDeadlineExceeded: "gateway.request_deadline_exceeded",
  requestCancelled: "gateway.request_cancelled",
  upstreamResponseTooLarge: "gateway.upstream_response_too_large",
  responsesStateRouteUnavailable: "responses.state_route_unavailable",
  responsesUnsupportedStateOperation: "responses.unsupported_state_operation",
  // circuit.*
  circuitSensitiveContent: "circuit.sensitive_content",
  circuitClientError: "circuit.client_error",
  circuitUpstreamCapacityExhausted: "circuit.upstream_capacity_exhausted",
  // upstream.*
  upstreamContentFilter: "upstream.content_filter",
  upstreamInvalidRequest: "upstream.invalid_request",
  upstreamRateLimited: "upstream.rate_limited",
  upstreamAuthFailed: "upstream.auth_failed",
  upstreamNotFound: "upstream.not_found",
  upstreamServerError: "upstream.server_error",
  upstreamTimeout: "upstream.timeout"
};

// packages/proxy/src/services/openrouter-error-protocol.ts
var MAX_PUBLIC_ERROR_MESSAGE_CHARS = 512;
var MAX_PROVIDER_CODE_CHARS = 96;
var MAX_METADATA_KEYS = 32;
var MAX_METADATA_ARRAY_ITEMS = 32;
var MAX_METADATA_DEPTH = 3;
var ERROR_TYPE_BY_GATEWAY_CODE = {
  [GatewayErrorCode.invalidJson]: "invalid_request",
  [GatewayErrorCode.missingModel]: "invalid_request",
  [GatewayErrorCode.modelNotFound]: "not_found",
  [GatewayErrorCode.budgetExceeded]: "payment_required",
  [GatewayErrorCode.authFailed]: "authentication",
  [GatewayErrorCode.permissionDenied]: "permission_denied",
  [GatewayErrorCode.authRateLimited]: "rate_limit_exceeded",
  [GatewayErrorCode.publicCatalogRateLimited]: "rate_limit_exceeded",
  [GatewayErrorCode.analyticsRateLimited]: "rate_limit_exceeded",
  [GatewayErrorCode.publicCatalogUnavailable]: "server",
  [GatewayErrorCode.internalError]: "server",
  [GatewayErrorCode.imageSettlementUnconfirmed]: "server",
  [GatewayErrorCode.capacityUnavailable]: "server",
  [GatewayErrorCode.routeNotFound]: "not_found",
  [GatewayErrorCode.payloadTooLarge]: "payload_too_large",
  [GatewayErrorCode.noRoute]: "not_found",
  [GatewayErrorCode.routeResolutionFailed]: "provider_unavailable",
  [GatewayErrorCode.invalidRequest]: "invalid_request",
  [GatewayErrorCode.resourceConflict]: "conflict",
  [GatewayErrorCode.invalidPresetReference]: "invalid_request",
  [GatewayErrorCode.presetNotFound]: "not_found",
  [GatewayErrorCode.presetInvalid]: "invalid_request",
  [GatewayErrorCode.guardrailBlocked]: "permission_denied",
  [GatewayErrorCode.guardrailInvalid]: "invalid_request",
  [GatewayErrorCode.zdrNoRoute]: "not_found",
  [GatewayErrorCode.dataCollectionNoRoute]: "not_found",
  [GatewayErrorCode.zdrToolsUnsupported]: "invalid_request",
  [GatewayErrorCode.upstreamRequestFailed]: "provider_unavailable",
  [GatewayErrorCode.dispatchLimitExceeded]: "provider_unavailable",
  [GatewayErrorCode.auxiliaryAuthLimitExceeded]: "provider_unavailable",
  [GatewayErrorCode.requestDeadlineExceeded]: "timeout",
  [GatewayErrorCode.requestCancelled]: "provider_unavailable",
  [GatewayErrorCode.upstreamResponseTooLarge]: "provider_unavailable",
  [GatewayErrorCode.responsesStateRouteUnavailable]: "invalid_request",
  [GatewayErrorCode.responsesUnsupportedStateOperation]: "invalid_request",
  [GatewayErrorCode.circuitSensitiveContent]: "rate_limit_exceeded",
  [GatewayErrorCode.circuitClientError]: "invalid_request",
  [GatewayErrorCode.circuitUpstreamCapacityExhausted]: "rate_limit_exceeded",
  [GatewayErrorCode.upstreamContentFilter]: "content_policy_violation",
  [GatewayErrorCode.upstreamInvalidRequest]: "invalid_request",
  [GatewayErrorCode.upstreamRateLimited]: "rate_limit_exceeded",
  [GatewayErrorCode.upstreamAuthFailed]: "provider_unavailable",
  [GatewayErrorCode.upstreamNotFound]: "provider_unavailable",
  [GatewayErrorCode.upstreamServerError]: "provider_unavailable",
  [GatewayErrorCode.upstreamTimeout]: "timeout"
};
var STATUS_BY_ERROR_TYPE = {
  authentication: 401,
  permission_denied: 403,
  payment_required: 402,
  rate_limit_exceeded: 429,
  provider_overloaded: 529,
  provider_unavailable: 502,
  invalid_request: 400,
  conflict: 409,
  invalid_prompt: 400,
  not_found: 404,
  precondition_failed: 412,
  payload_too_large: 413,
  unprocessable: 422,
  content_policy_violation: 400,
  context_length_exceeded: 400,
  max_tokens_exceeded: 400,
  token_limit_exceeded: 400,
  string_too_long: 400,
  timeout: 504,
  server: 500,
  unmapped: 500
};
var RESPONSE_CODE_BY_ERROR_TYPE = {
  rate_limit_exceeded: "rate_limit_exceeded",
  context_length_exceeded: "invalid_prompt",
  invalid_request: "invalid_prompt",
  conflict: "server_error",
  content_policy_violation: "image_content_policy_violation",
  authentication: "server_error",
  provider_overloaded: "server_error",
  provider_unavailable: "server_error",
  timeout: "server_error",
  server: "server_error",
  payment_required: "server_error",
  permission_denied: "server_error",
  invalid_prompt: "server_error",
  not_found: "server_error",
  precondition_failed: "server_error",
  payload_too_large: "server_error",
  unprocessable: "server_error",
  max_tokens_exceeded: "server_error",
  token_limit_exceeded: "server_error",
  string_too_long: "server_error",
  unmapped: "server_error"
};
var ANTHROPIC_TYPE_BY_ERROR_TYPE = {
  authentication: "authentication_error",
  permission_denied: "permission_error",
  payment_required: "billing_error",
  not_found: "not_found_error",
  rate_limit_exceeded: "rate_limit_error",
  provider_overloaded: "overloaded_error",
  timeout: "timeout_error",
  context_length_exceeded: "invalid_request_error",
  content_policy_violation: "invalid_request_error",
  invalid_request: "invalid_request_error",
  conflict: "invalid_request_error",
  invalid_prompt: "invalid_request_error",
  precondition_failed: "invalid_request_error",
  payload_too_large: "invalid_request_error",
  unprocessable: "invalid_request_error",
  max_tokens_exceeded: "invalid_request_error",
  token_limit_exceeded: "invalid_request_error",
  string_too_long: "invalid_request_error",
  provider_unavailable: "api_error",
  server: "api_error",
  unmapped: "api_error"
};
function collapseWhitespace(value) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}
function sanitizePublicErrorMessage(value, fallback = "Request failed") {
  let message = collapseWhitespace(value);
  message = message.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]").replace(
    /\b(api[_ -]?key|access[_ -]?token|authorization)(\s*[:=]\s*)[^\s,;]+/gi,
    "$1$2[redacted]"
  ).replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[redacted]@");
  if (!message) message = fallback;
  return message.length <= MAX_PUBLIC_ERROR_MESSAGE_CHARS ? message : `${message.slice(0, MAX_PUBLIC_ERROR_MESSAGE_CHARS - 1)}\u2026`;
}
function sanitizeProviderCode(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized || !/^[A-Za-z0-9_.:/-]+$/.test(normalized)) return null;
  return normalized.slice(0, MAX_PROVIDER_CODE_CHARS);
}
function sanitizeMetadataValue(value, depth) {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : void 0;
  if (typeof value === "string") return sanitizePublicErrorMessage(value, "");
  if (depth >= MAX_METADATA_DEPTH) return void 0;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_METADATA_ARRAY_ITEMS).map((item) => sanitizeMetadataValue(item, depth + 1)).filter((item) => item !== void 0);
  }
  if (typeof value !== "object") return void 0;
  const sanitized = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_METADATA_KEYS)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
    const next = sanitizeMetadataValue(item, depth + 1);
    if (next !== void 0) sanitized[key] = next;
  }
  return sanitized;
}
function sanitizeMetadata(metadata) {
  const sanitized = sanitizeMetadataValue(metadata ?? {}, 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized : {};
}
function openRouterErrorTypeForGatewayCode(code) {
  return ERROR_TYPE_BY_GATEWAY_CODE[code];
}
function openRouterStatusForErrorType(errorType) {
  return STATUS_BY_ERROR_TYPE[errorType];
}
function openRouterStatusForGatewayCode(code) {
  if (code === GatewayErrorCode.capacityUnavailable) return 503;
  if (code === GatewayErrorCode.imageSettlementUnconfirmed) return 503;
  return openRouterStatusForErrorType(openRouterErrorTypeForGatewayCode(code));
}
function buildOpenRouterErrorBody(options) {
  const message = sanitizePublicErrorMessage(options.message);
  const metadata = sanitizeMetadata(options.metadata);
  const providerCode = sanitizeProviderCode(options.providerCode);
  if (options.skin === "anthropic") {
    return {
      type: "error",
      error: {
        type: ANTHROPIC_TYPE_BY_ERROR_TYPE[options.errorType],
        message,
        error_type: options.errorType
      },
      request_id: options.requestId ?? null,
      ...options.legacyCode ? { code: options.legacyCode } : {}
    };
  }
  if (options.skin === "responses") {
    return {
      status: "failed",
      error: {
        code: RESPONSE_CODE_BY_ERROR_TYPE[options.errorType],
        message
      },
      error_type: options.errorType,
      ...options.requestId ? { id: options.requestId } : {},
      ...options.legacyCode ? { code: options.legacyCode } : {}
    };
  }
  return {
    error: {
      code: options.status,
      message,
      metadata: {
        ...metadata,
        error_type: options.errorType,
        ...providerCode ? { provider_code: providerCode } : {}
      }
    },
    ...options.legacyCode ? { code: options.legacyCode } : {}
  };
}
function publicMessageForGatewayError(code, message) {
  switch (code) {
    case GatewayErrorCode.capacityUnavailable:
      return "Gateway capacity is unavailable";
    case GatewayErrorCode.internalError:
      return "Internal server error";
    case GatewayErrorCode.imageSettlementUnconfirmed:
      return "Image settlement persistence is unconfirmed. Upstream may have completed; do not automatically retry.";
    case GatewayErrorCode.noRoute:
    case GatewayErrorCode.zdrNoRoute:
    case GatewayErrorCode.dataCollectionNoRoute:
      return "No available model provider meets the routing requirements";
    case GatewayErrorCode.routeResolutionFailed:
    case GatewayErrorCode.upstreamRequestFailed:
    case GatewayErrorCode.upstreamAuthFailed:
    case GatewayErrorCode.upstreamNotFound:
    case GatewayErrorCode.upstreamServerError:
      return "Upstream provider is unavailable";
    case GatewayErrorCode.upstreamTimeout:
      return "Upstream provider timed out";
    default:
      return sanitizePublicErrorMessage(message);
  }
}
function buildChatMidstreamErrorEvent(params) {
  const status = openRouterStatusForErrorType("provider_unavailable");
  return `data: ${JSON.stringify({
    ...params.id ? { id: params.id } : {},
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model: params.model,
    provider: params.provider,
    error: {
      code: status,
      message: sanitizePublicErrorMessage(
        params.message ?? "Upstream provider stream interrupted"
      ),
      metadata: { error_type: "provider_unavailable" }
    },
    choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }]
  })}

`;
}

// packages/proxy/src/services/gateway-error-response.ts
function publicErrorHeaders(code, status, extra) {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=UTF-8");
  headers.set("Cache-Control", "no-store");
  headers.set(GATEWAY_ERROR_CODE_HEADER, code);
  headers.delete("Content-Length");
  if (status !== 429 && status !== 503 && status !== 529) headers.delete("Retry-After");
  return headers;
}
function buildGatewayErrorResponse(opts, skin) {
  const status = openRouterStatusForGatewayCode(opts.code);
  const errorType = openRouterErrorTypeForGatewayCode(opts.code);
  const message = publicMessageForGatewayError(opts.code, opts.message);
  const body = buildOpenRouterErrorBody({
    skin,
    status,
    message,
    errorType,
    legacyCode: opts.code,
    metadata: opts.metadata,
    requestId: opts.requestId
  });
  return new Response(JSON.stringify(body), {
    status,
    headers: publicErrorHeaders(opts.code, status, opts.headers)
  });
}
function gatewayErrorResponse(opts) {
  return buildGatewayErrorResponse(opts, opts.skin ?? "chat");
}

// packages/proxy/src/services/egress/openai-audio-driver.ts
var AUDIO_TRANSCRIPTION_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var AUDIO_MAX_BYTES_PER_FILE = 25 * 1024 * 1024;

// packages/proxy/src/services/egress/audio-duration.ts
var MAX_AUDIO_DURATION_SECONDS = 25 * 60;

// packages/proxy/src/services/endpoint-audio-billing-pricing.ts
var MAX_SAFE_COST = Number.MAX_SAFE_INTEGER;
var AUDIO_OPERATION_SET = new Set(AUDIO_ENDPOINT_PRICING_OPERATIONS);

// packages/proxy/src/services/dashscope-realtime-guardrails.ts
var DASHSCOPE_REALTIME_MAX_SESSION_MS = 10 * 60 * 1e3;
var DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS = 30 * 1e3;
var DASHSCOPE_REALTIME_MAX_AUDIO_SECONDS = 10 * 60;
var DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS = DASHSCOPE_REALTIME_MAX_AUDIO_SECONDS + 1;
var DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES = 4 * 1024 * 1024;
var DASHSCOPE_REALTIME_MAX_CLIENT_BYTES = 32 * 1024 * 1024;
var DASHSCOPE_REALTIME_GUARDRAIL_LEASE_MS = 15 * 60 * 1e3;

// packages/proxy/src/services/egress/text-upstream-url.ts
function assertTextUpstreamHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Text upstream endpoint is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Text upstream endpoint must use http(s)");
  }
}

// packages/proxy/src/services/egress/ambiguous-upstream-status.ts
function ambiguousDispatchedStatusMeta(status) {
  const mayHideAcceptedWork = status >= 300 && status < 400 || status === 408 || status === 499 || status >= 500;
  return mayHideAcceptedWork ? { upstreamOutcomeUnknown: true, failoverForbidden: true } : void 0;
}

// packages/proxy/src/services/egress/text-json-response.ts
var TEXT_JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
var TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS = 4096;
function invalidTextSuccessResponse(params) {
  return {
    response: gatewayErrorResponse({
      status: 502,
      code: GatewayErrorCode.upstreamRequestFailed,
      message: `Upstream provider returned an invalid ${params.protocol} response`,
      skin: params.skin,
      requestId: params.requestId
    }),
    meta: {
      upstreamOutcomeUnknown: true,
      failoverForbidden: true,
      gatewayGeneratedError: true
    }
  };
}
async function cancelInvalidTextSuccessResponse(response, params) {
  void response.body?.cancel("invalid_text_success_response").catch(() => void 0);
  return invalidTextSuccessResponse(params);
}
function unreadableTextJsonResponse(params) {
  return {
    response: gatewayErrorResponse({
      status: 502,
      code: params.tooLarge ? GatewayErrorCode.upstreamResponseTooLarge : GatewayErrorCode.upstreamRequestFailed,
      message: params.tooLarge ? "Upstream response exceeded the gateway size limit" : "Upstream provider returned an invalid JSON response",
      skin: params.skin,
      requestId: params.requestId
    }),
    meta: {
      upstreamOutcomeUnknown: true,
      failoverForbidden: true,
      gatewayGeneratedError: true,
      ...params.tooLarge ? { responseBodyTooLarge: true } : {}
    }
  };
}
async function readBoundedTextJsonObject(response, options) {
  let text;
  try {
    text = await responseTextWithinLimit(
      response,
      options.maxBytes ?? TEXT_JSON_RESPONSE_MAX_BYTES,
      options.signal
    );
  } catch (error) {
    return {
      ok: false,
      ...unreadableTextJsonResponse({
        ...options,
        tooLarge: error instanceof UpstreamResponseBodyTooLargeError
      })
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      ...unreadableTextJsonResponse({ ...options, tooLarge: false })
    };
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      ...unreadableTextJsonResponse({ ...options, tooLarge: false })
    };
  }
  return { ok: true, value: parsed };
}
function rebuildTextJsonResponse(response, value) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Transfer-Encoding");
  return new Response(JSON.stringify(value), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
function preDispatchCancelledTextResponse(skin, requestId) {
  const status = 499;
  return new Response(JSON.stringify(buildOpenRouterErrorBody({
    skin,
    status,
    message: "Request was cancelled before upstream dispatch",
    errorType: "provider_unavailable",
    legacyCode: GatewayErrorCode.upstreamRequestFailed,
    requestId
  })), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      [GATEWAY_ERROR_CODE_HEADER]: GatewayErrorCode.upstreamRequestFailed
    }
  });
}

// packages/proxy/src/services/egress/service-tier-contract.ts
function normalizeResponseTextSpeed(value) {
  return value === "fast" || value === "standard" ? value : null;
}
function normalizeOpenAiResponseServiceTier(value) {
  if (value === "flex") return "flex";
  if (value === "priority" || value === "fast") return "priority";
  if (value === "default" || value === "standard" || value === "auto") return "default";
  return null;
}

// packages/proxy/src/services/egress/openai-responses-driver.ts
var MAX_RESPONSES_SSE_EVENT_CHARS = 256 * 1024;
var encoder2 = new TextEncoder();

// packages/proxy/src/services/egress/openai-embeddings-driver.ts
var OPENAI_EMBEDDINGS_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

// packages/proxy/src/services/egress/openai-rerank-driver.ts
var OPENAI_RERANK_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

// packages/proxy/src/services/image-attempt-context.ts
import { createHash as createHash3 } from "node:crypto";

// packages/proxy/src/services/json-structure-budget.ts
var IMAGE_JSON_STRUCTURE_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 65536
});
var IMAGE_JSON_MAX_PROPERTY_NAME_CHARS = 256;
var IMAGE_JSON_ADMISSION_LIMITS = Object.freeze({
  ...IMAGE_JSON_STRUCTURE_LIMITS,
  maxPropertyNameChars: IMAGE_JSON_MAX_PROPERTY_NAME_CHARS
});

// packages/proxy/src/services/multipart-body-inspector.ts
var MULTIPART_MAX_HEADER_BYTES = 16 * 1024;
var MULTIPART_MAX_FIELD_BYTES = 64 * 1024;
var MULTIPART_MAX_FIELDS_BYTES = 128 * 1024;
var MAX_FRAMING_BYTES = 16 * 1024;

// packages/proxy/src/services/streaming-multipart-body.ts
var MULTIPART_FILE_PAGE_BYTES = 64 * 1024;

// packages/proxy/src/services/image-attempt-context.ts
var MAX_DIGEST_JSON_BYTES = 4 * MAX_REQUEST_BODY_BYTES;
var MAX_FILE_BYTES = 20 * 1024 * 1024;
var JSON_LIMITS = Object.freeze({
  maxDepth: IMAGE_JSON_STRUCTURE_LIMITS.maxDepth + 4,
  maxNodes: IMAGE_JSON_STRUCTURE_LIMITS.maxNodes + 128
});

// packages/proxy/src/services/egress/multipart-upload-body.ts
var encoder3 = new TextEncoder();

// packages/proxy/src/services/egress/image-response-usage.ts
var IMAGE_MAX_USAGE_JSON_BYTES = 64 * 1024;
var USAGE_LIMITS = Object.freeze({ maxDepth: IMAGE_JSON_STRUCTURE_LIMITS.maxDepth, maxNodes: 3 * IMAGE_JSON_STRUCTURE_LIMITS.maxNodes + 16 });

// packages/proxy/src/services/egress/openai-images-driver.ts
var IMAGE_MAX_REFERENCE_COUNT = 5;
var IMAGE_MAX_BYTES_PER_FILE = 20 * 1024 * 1024;
var IMAGE_MAX_TOTAL_UPLOAD_BYTES = IMAGE_MAX_REFERENCE_COUNT * IMAGE_MAX_BYTES_PER_FILE;
var IMAGE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
var NORMALIZED_IMAGE_JSON_LIMITS = Object.freeze({
  maxDepth: IMAGE_JSON_STRUCTURE_LIMITS.maxDepth,
  maxNodes: 3 * IMAGE_JSON_STRUCTURE_LIMITS.maxNodes + 16
});
var IMAGE_MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;
var SSE_DONE_FRAME = new TextEncoder().encode("data: [DONE]\n\n");
var SSE_KEEPALIVE_FRAME = new TextEncoder().encode(": keep-alive\n\n");

// packages/tool-engines/src/http/bounded-response.ts
var TOOL_PROVIDER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
var TOOL_PROVIDER_OUTPUT_MAX_BYTES = TOOL_PROVIDER_RESPONSE_MAX_BYTES - 16 * 1024;

// packages/proxy/src/services/egress/dashscope-audio-driver.ts
var DASHSCOPE_SYNC_ASR_MAX_DATA_URL_BYTES = 10 * 1024 * 1024;
var DASHSCOPE_MULTIMODAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// packages/proxy/src/services/egress/audio-speech-driver.ts
var AUDIO_SPEECH_MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
var SPEECH_SSE_MAX_EVENT_CHARS = 8 * 1024 * 1024;

// packages/proxy/src/services/egress/dashscope-realtime-driver.ts
var DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES = 4 * 1024 * 1024;
var DASHSCOPE_REALTIME_MAX_PROVIDER_BYTES = 32 * 1024 * 1024;

// packages/proxy/src/services/egress/finish-reason-contract.ts
var CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
var MAX_NATIVE_FINISH_REASON_LENGTH = 128;
function normalizeNativeFinishReason(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_NATIVE_FINISH_REASON_LENGTH && !CONTROL_CHAR_PATTERN.test(trimmed) ? trimmed : null;
}
function normalizeCanonicalFinishReason(value) {
  switch (value) {
    case "tool_calls":
    case "stop":
    case "length":
    case "content_filter":
    case "error":
      return value;
    default:
      return null;
  }
}

// packages/proxy/src/services/egress/anthropic-driver.ts
var MAX_ANTHROPIC_SSE_EVENT_CHARS = 256 * 1024;
var encoder4 = new TextEncoder();

// packages/proxy/src/services/egress/gemini-driver.ts
var GEMINI_SSE_MAX_LINE_CHARS = 256 * 1024;

// packages/proxy/src/services/ordinary-budget-lifecycle.ts
var ORDINARY_BUDGET_ADMISSION_LEASE_MS = 2 * 60 * 1e3;
var ORDINARY_BUDGET_DISPATCH_LEASE_MS = 15 * 60 * 1e3;

// packages/proxy/src/services/request-guardrails.ts
var GUARDRAIL_BUDGET_ADMISSION_LEASE_MS = 2 * 60 * 1e3;
var GUARDRAIL_BUDGET_DISPATCH_LEASE_MS = 15 * 60 * 1e3;
var GUARDRAIL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// packages/proxy/src/services/request-log-record-status.ts
var MAX_MATERIALIZED_ERROR_BODY_BYTES = 64 * 1024;

// packages/proxy/src/services/failover-dispatch.ts
var STICKY_STALE_GC_PROBABILITY = 1 / 500;
var STICKY_STALE_GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var MAX_DISPATCH_TRACE_ERROR_BODY_BYTES = 8 * 1024;
function markUpstreamOutcomeUnknown(error) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return Object.assign(normalized, { upstreamOutcomeUnknown: true });
}

// packages/proxy/src/services/egress/openai-stream-usage-request.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function ensureOpenAiStreamIncludesUsage(body) {
  if (body.stream !== true) return body;
  const current = isRecord(body.stream_options) ? body.stream_options : {};
  return {
    ...body,
    stream_options: {
      ...current,
      include_usage: true
    }
  };
}

// packages/proxy/src/services/egress/openai-driver.ts
var EMPTY_USAGE_LOCAL = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  raw_usage: null
};
var MAX_OPENAI_SSE_EVENT_CHARS = 256 * 1024;
function isPlainObject2(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function nonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function optionalSafeCount(value) {
  return value === void 0 || nonNegativeSafeInteger(value);
}
function effectiveSafeCount(primary, fallback) {
  if (nonNegativeSafeInteger(primary)) return primary;
  return nonNegativeSafeInteger(fallback) ? fallback : null;
}
function validProviderUsage(value) {
  if (!isPlainObject2(value)) return false;
  const prompt = value.prompt_tokens;
  const input = value.input_tokens;
  const completion = value.completion_tokens;
  const output = value.output_tokens;
  if (!nonNegativeSafeInteger(prompt) && !nonNegativeSafeInteger(input) || !nonNegativeSafeInteger(completion) && !nonNegativeSafeInteger(output) || !nonNegativeSafeInteger(value.total_tokens) || prompt !== void 0 && input !== void 0 && prompt !== input || completion !== void 0 && output !== void 0 && completion !== output) return false;
  const promptDetails = value.prompt_tokens_details;
  const completionDetails = value.completion_tokens_details;
  if (promptDetails !== void 0 && !isPlainObject2(promptDetails)) return false;
  if (completionDetails !== void 0 && !isPlainObject2(completionDetails)) return false;
  if (!optionalSafeCount(promptDetails?.cached_tokens) || !optionalSafeCount(promptDetails?.cache_creation_tokens) || !optionalSafeCount(completionDetails?.reasoning_tokens) || !optionalSafeCount(completionDetails?.text_tokens) || !optionalSafeCount(completionDetails?.image_tokens)) return false;
  const inputCount = effectiveSafeCount(prompt, input);
  const outputCount = effectiveSafeCount(completion, output);
  if (inputCount == null || outputCount == null) return false;
  const cacheRead = nonNegativeSafeInteger(promptDetails?.cached_tokens) ? promptDetails.cached_tokens : 0;
  const cacheWrite = nonNegativeSafeInteger(promptDetails?.cache_creation_tokens) ? promptDetails.cache_creation_tokens : 0;
  const cacheCount = cacheRead + cacheWrite;
  const totalCount = value.total_tokens;
  if ((!Number.isSafeInteger(inputCount + outputCount) || totalCount !== inputCount + outputCount) && (!Number.isSafeInteger(inputCount + cacheCount + outputCount) || totalCount !== inputCount + cacheCount + outputCount)) return false;
  const reasoning = completionDetails?.reasoning_tokens;
  return reasoning === void 0 || nonNegativeSafeInteger(reasoning) && reasoning <= outputCount;
}
function validChatMessage(value) {
  if (!isPlainObject2(value) || value.role !== "assistant") return false;
  const hasContent = Object.prototype.hasOwnProperty.call(value, "content");
  const content = value.content;
  const validContent = content === null || typeof content === "string" || Array.isArray(content);
  return hasContent && validContent || Array.isArray(value.tool_calls) || isPlainObject2(value.function_call) || typeof value.refusal === "string";
}
function validChatSuccessResponse(value) {
  if (value.object !== "chat.completion" || normalizeUpstreamId(value.id) == null || typeof value.model !== "string" || !value.model.trim() || !nonNegativeSafeInteger(value.created) || !Array.isArray(value.choices) || value.choices.length === 0 || value.choices.length > TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS || value.usage !== void 0 && !validProviderUsage(value.usage)) return false;
  const indexes = /* @__PURE__ */ new Set();
  for (const choice of value.choices) {
    if (!isPlainObject2(choice) || !nonNegativeSafeInteger(choice.index) || indexes.has(choice.index) || !Object.prototype.hasOwnProperty.call(choice, "finish_reason") || choice.finish_reason !== null && typeof choice.finish_reason !== "string" || !validChatMessage(choice.message)) return false;
    indexes.add(choice.index);
  }
  return true;
}
var encoder5 = new TextEncoder();
function normalizeInputTokensFromPrompt(args) {
  const { promptTokens, completionTokens, cacheRead, cacheWrite, totalTokens } = args;
  const cacheTotal = cacheRead + cacheWrite;
  if (cacheTotal <= 0) return promptTokens;
  if (promptTokens < cacheTotal) {
    return promptTokens + cacheTotal;
  }
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens >= 0) {
    const expectedWithIncludedCache = promptTokens + completionTokens;
    const expectedWithPureInputPrompt = promptTokens + cacheTotal + completionTokens;
    const diffIncluded = Math.abs(totalTokens - expectedWithIncludedCache);
    const diffPureInput = Math.abs(totalTokens - expectedWithPureInputPrompt);
    if (diffPureInput < diffIncluded) {
      return promptTokens + cacheTotal;
    }
  }
  return promptTokens;
}
function usageFromProvider(u) {
  const promptTokensRaw = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.prompt_tokens_details?.cache_creation_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  const promptTokens = normalizeInputTokensFromPrompt({
    promptTokens: promptTokensRaw,
    completionTokens,
    cacheRead,
    cacheWrite,
    totalTokens: u.total_tokens
  });
  const rawJson = JSON.stringify(u);
  const nativePrompt = effectiveSafeCount(u.prompt_tokens, u.input_tokens);
  const nativeCompletion = effectiveSafeCount(u.completion_tokens, u.output_tokens);
  const nativeCached = nonNegativeSafeInteger(u.prompt_tokens_details?.cached_tokens) ? u.prompt_tokens_details.cached_tokens : null;
  const nativeReasoning = nonNegativeSafeInteger(u.completion_tokens_details?.reasoning_tokens) ? u.completion_tokens_details.reasoning_tokens : null;
  const nativeCompletionImages = nonNegativeSafeInteger(u.completion_tokens_details?.image_tokens) ? u.completion_tokens_details.image_tokens : null;
  const usage = {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    total_tokens: u.total_tokens ?? promptTokens + completionTokens,
    raw_usage: rawJson,
    native_tokens_prompt: nativePrompt,
    native_tokens_completion: nativeCompletion,
    native_tokens_cached: nativeCached,
    native_tokens_reasoning: nativeReasoning,
    native_tokens_completion_images: nativeCompletionImages
  };
  if (Object.prototype.hasOwnProperty.call(u, "speed")) {
    usage.speed = normalizeResponseTextSpeed(u.speed);
  }
  return usage;
}
function hasOpenAiReasoningDelta(parsed) {
  for (const choice of parsed.choices ?? []) {
    const delta = choice?.delta;
    if (!delta) continue;
    const rc = delta.reasoning_content;
    if (typeof rc === "string" && rc.length > 0) return true;
    const th = delta.thinking;
    if (typeof th === "string" && th.length > 0) return true;
    const r = delta.reasoning;
    if (typeof r === "string" && r.length > 0) return true;
  }
  return false;
}
function hasOpenAiContentDelta(parsed) {
  for (const choice of parsed.choices ?? []) {
    const delta = choice?.delta;
    if (!delta) continue;
    if (typeof delta.content === "string" && delta.content.length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
    if (delta.function_call != null) return true;
  }
  return false;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function applyProviderUsage(target, providerUsage) {
  const next = usageFromProvider(providerUsage);
  target.input_tokens = next.input_tokens;
  target.output_tokens = next.output_tokens;
  target.cache_read_tokens = next.cache_read_tokens;
  target.cache_write_tokens = next.cache_write_tokens;
  target.reasoning_tokens = next.reasoning_tokens;
  target.total_tokens = next.total_tokens;
  target.raw_usage = next.raw_usage;
  target.native_tokens_prompt = next.native_tokens_prompt;
  target.native_tokens_completion = next.native_tokens_completion;
  target.native_tokens_cached = next.native_tokens_cached;
  target.native_tokens_reasoning = next.native_tokens_reasoning;
  target.native_tokens_completion_images = next.native_tokens_completion_images;
  if (Object.prototype.hasOwnProperty.call(next, "speed")) target.speed = next.speed;
}
function processChatSseEvent(params) {
  const parsedData = parseSseEventData(params.event);
  if (parsedData === null) return { wire: params.event, stop: false };
  const data = parsedData.trim();
  if (!data) return { wire: params.event, stop: false };
  if (data === "[DONE]") {
    params.state.sawDone = true;
    return { wire: params.event, stop: true };
  }
  let parsed;
  try {
    const candidate = JSON.parse(data);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("invalid event");
    parsed = candidate;
  } catch {
    params.usage.stream_error = params.usage.stream_error ?? "Malformed OpenAI SSE data event";
    params.state.sawFailure = true;
    return {
      wire: buildChatMidstreamErrorEvent({
        id: params.state.associationId,
        model: params.publicModelId ?? "",
        provider: params.publicProviderName ?? ""
      }),
      stop: true
    };
  }
  params.timing?.markFirstEvent();
  if (hasOpenAiReasoningDelta(parsed)) params.timing?.markFirstReasoningToken();
  if (hasOpenAiContentDelta(parsed)) params.timing?.markFirstToken();
  const eventId = normalizeUpstreamId(parsed.id);
  if (eventId) {
    params.state.associationId ??= eventId;
    params.usage.upstreamMessageId ??= eventId;
  }
  if (parsed.usage) {
    if (Object.prototype.hasOwnProperty.call(parsed.usage, "speed")) {
      parsed.usage.speed = normalizeResponseTextSpeed(parsed.usage.speed);
    }
    applyProviderUsage(params.usage, parsed.usage);
  }
  if (parsed.error && typeof parsed.error === "object") {
    params.usage.stream_error = sanitizePublicErrorMessage(
      nonEmptyString(parsed.error.message) ?? "Upstream Chat Completions stream failed",
      "Upstream Chat Completions stream failed"
    );
    params.state.sawFailure = true;
    return {
      wire: buildChatMidstreamErrorEvent({
        id: params.state.associationId,
        model: params.publicModelId ?? "",
        provider: params.publicProviderName ?? ""
      }),
      stop: true
    };
  }
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(parsed, "service_tier")) {
    params.state.serviceTier = normalizeOpenAiResponseServiceTier(parsed.service_tier);
  }
  parsed.service_tier = params.state.serviceTier;
  params.usage.service_tier = params.state.serviceTier;
  changed = true;
  if (params.state.associationId && parsed.id !== params.state.associationId) {
    parsed.id = params.state.associationId;
    changed = true;
  }
  if (params.publicModelId && Object.prototype.hasOwnProperty.call(parsed, "model")) {
    parsed.model = params.publicModelId;
    changed = true;
  }
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  let hasTerminalFinish = false;
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const finishReason = nonEmptyString(choice.finish_reason);
    const nativeFinishReason = nonEmptyString(choice.native_finish_reason);
    if (finishReason) {
      hasTerminalFinish = true;
      params.state.lastFinishReason = finishReason;
      params.state.lastNativeFinishReason = nativeFinishReason ?? finishReason;
      if (!nativeFinishReason) {
        choice.native_finish_reason = finishReason;
        changed = true;
      }
    } else if (nativeFinishReason) {
      params.state.lastNativeFinishReason = nativeFinishReason;
    }
    if (choice.index === 0) {
      params.usage.finish_reason = normalizeCanonicalFinishReason(choice.finish_reason);
      params.usage.native_finish_reason = normalizeNativeFinishReason(
        choice.native_finish_reason ?? choice.finish_reason
      );
    }
  }
  if (parsed.usage != null && choices.length === 0) {
    const finishReason = params.state.lastFinishReason ?? params.state.lastNativeFinishReason ?? "stop";
    const nativeFinishReason = params.state.lastNativeFinishReason ?? finishReason;
    parsed.choices = [{
      index: 0,
      delta: { content: "", role: "assistant" },
      finish_reason: finishReason,
      native_finish_reason: nativeFinishReason
    }];
    if (!eventId && params.state.associationId) parsed.id = params.state.associationId;
    changed = true;
  } else if (parsed.usage != null && choices.length > 0 && !hasTerminalFinish) {
    delete parsed.usage;
    changed = true;
  }
  return {
    wire: changed ? rewriteSseEventData(params.event, JSON.stringify(parsed)) : params.event,
    stop: false
  };
}
async function pumpWithUsageTracking(upstream, downstream, usage, resolveUsage, stopDownstream, requestSignal, timing, publicModelId, publicProviderName, publicCorrelationId) {
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  const writer = downstream.getWriter();
  const state = {
    sawDone: false,
    sawFailure: false,
    associationId: normalizeUpstreamId(publicCorrelationId),
    lastFinishReason: null,
    lastNativeFinishReason: null,
    serviceTier: null
  };
  const framer = new BoundedSseEventFramer(
    MAX_OPENAI_SSE_EVENT_CHARS,
    "OpenAI SSE event exceeded the gateway framing limit"
  );
  let clientDisconnected = false;
  let finished = false;
  let cleanupConfirmed = true;
  let cancellation;
  const cancelUpstream = (reason) => {
    cancellation ??= reader.cancel(reason).catch(() => {
      cleanupConfirmed = false;
    });
  };
  const markClientDisconnected = () => {
    if (finished || clientDisconnected) return;
    markTextStreamCancellation(usage, requestSignal);
    clientDisconnected = true;
    cancelUpstream(requestSignal?.reason);
    stopDownstream(requestSignal?.reason ?? new Error("Text response delivery stopped"));
  };
  const onAbort = () => {
    markClientDisconnected();
  };
  if (requestSignal?.aborted) markClientDisconnected();
  else {
    requestSignal?.addEventListener("abort", onAbort, { once: true });
  }
  void writer.closed.catch(markClientDisconnected);
  const writeWire = async (wire) => {
    if (!wire || clientDisconnected) return !clientDisconnected;
    try {
      await writer.write(encoder5.encode(wire));
      return true;
    } catch {
      markClientDisconnected();
      return false;
    }
  };
  const processEvent = (event) => processChatSseEvent({
    event,
    state,
    usage,
    timing,
    publicModelId,
    publicProviderName
  });
  const handleEvent = async (event) => {
    if (clientDisconnected) return true;
    const processed = processEvent(event);
    const written = await writeWire(processed.wire);
    return processed.stop || !written || clientDisconnected;
  };
  try {
    while (true) {
      if (clientDisconnected) break;
      const { done, value } = await reader.read();
      if (clientDisconnected) break;
      if (done) {
        const stopped = await framer.push(decoder.decode(), handleEvent);
        const remainder = stopped ? "" : framer.finish();
        if (remainder.trim() && !clientDisconnected) {
          await handleEvent(terminateSseEvent(remainder));
        }
        if (!state.sawDone && !state.sawFailure && !clientDisconnected) {
          usage.stream_error = usage.stream_error ?? "Upstream Chat stream ended before data: [DONE]";
          state.sawFailure = true;
          await writeWire(buildChatMidstreamErrorEvent({
            id: state.associationId,
            model: publicModelId ?? "",
            provider: publicProviderName ?? ""
          }));
        }
        break;
      }
      if (value.byteLength > 0) timing?.markFirstByte();
      const stop = await framer.push(decoder.decode(value, { stream: true }), handleEvent);
      if (stop || clientDisconnected) {
        cancelUpstream(stop ? "Chat SSE terminal event received" : requestSignal?.reason);
        break;
      }
    }
  } catch (err) {
    if (!clientDisconnected) {
      cancelUpstream("Chat SSE processing failed");
      usage.stream_error = usage.stream_error ?? sanitizePublicErrorMessage(
        err instanceof Error ? err.message : String(err),
        "Upstream Chat Completions stream failed"
      );
      console.warn("[Gateway Proxy] pump error", err instanceof Error ? err.message : String(err));
      if (!state.sawFailure) {
        state.sawFailure = true;
        await writeWire(buildChatMidstreamErrorEvent({
          id: state.associationId,
          model: publicModelId ?? "",
          provider: publicProviderName ?? ""
        }));
      }
    }
  } finally {
    finished = true;
    requestSignal?.removeEventListener("abort", onAbort);
    if (!clientDisconnected) reader.releaseLock();
    timing?.markStreamComplete();
    resolveUsage(usage);
    try {
      await writer.close();
    } catch (err) {
      console.warn(
        "[Gateway Proxy] pump writer.close (non-fatal)",
        err instanceof Error ? err.message : String(err),
        { clientDisconnected, usageCancelled: usage.cancelled }
      );
    }
    await cancellation;
    if (clientDisconnected) reader.releaseLock();
  }
  return cleanupConfirmed ? "confirmed" : "unconfirmed";
}
function streamResponseWithUsage(response, requestSignal, timing, publicModelId, publicProviderName, publicCorrelationId) {
  let resolveUsage;
  const usagePromise = new Promise((resolve) => {
    resolveUsage = resolve;
  });
  const usage = { ...EMPTY_USAGE_LOCAL };
  let stopDownstream;
  const { readable, writable } = new TransformStream({
    // Preserve graceful read-side cancellation while rejecting blocked writes.
    start(controller) {
      stopDownstream = () => controller.terminate();
    }
  });
  const resourceCompletion = pumpWithUsageTracking(
    response.body,
    writable,
    usage,
    resolveUsage,
    stopDownstream,
    requestSignal,
    timing,
    publicModelId,
    publicProviderName,
    publicCorrelationId
  ).catch(() => "unconfirmed");
  return {
    response: new Response(readable, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    }),
    usagePromise,
    resourceCompletion
  };
}
async function nonStreamResponseWithUsage(response, timing, publicModelId, publicCorrelationId, requestSignal) {
  const materialized = await readBoundedTextJsonObject(response, {
    skin: "chat",
    requestId: publicCorrelationId,
    signal: requestSignal
  });
  timing?.markStreamComplete();
  if (!materialized.ok) {
    return {
      response: materialized.response,
      usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
      meta: materialized.meta
    };
  }
  const parsed = materialized.value;
  if (!validChatSuccessResponse(parsed)) {
    const invalid = invalidTextSuccessResponse({
      skin: "chat",
      protocol: "Chat Completions",
      requestId: publicCorrelationId
    });
    return {
      ...invalid,
      usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL })
    };
  }
  const providerUsage = parsed.usage;
  if (providerUsage && Object.prototype.hasOwnProperty.call(providerUsage, "speed")) {
    providerUsage.speed = normalizeResponseTextSpeed(
      providerUsage.speed
    );
  }
  let usage = providerUsage != null ? usageFromProvider(providerUsage) : { ...EMPTY_USAGE_LOCAL };
  const msgId = normalizeUpstreamId(parsed.id);
  if (msgId) usage = { ...usage, upstreamMessageId: msgId };
  const primaryChoice = parsed.choices.find((choice) => choice.index === 0) ?? parsed.choices[0];
  if (primaryChoice) {
    usage.finish_reason = normalizeCanonicalFinishReason(primaryChoice.finish_reason);
    usage.native_finish_reason = normalizeNativeFinishReason(
      primaryChoice.native_finish_reason ?? primaryChoice.finish_reason
    );
  }
  const generationId = normalizeUpstreamId(publicCorrelationId);
  if (generationId) parsed.id = generationId;
  if (publicModelId) parsed.model = publicModelId;
  const serviceTier = normalizeOpenAiResponseServiceTier(parsed.service_tier);
  parsed.service_tier = serviceTier;
  usage.service_tier = serviceTier;
  return {
    response: rebuildTextJsonResponse(response, parsed),
    usagePromise: Promise.resolve(usage)
  };
}
async function dispatchOpenAiRoute(route2, body, requestSignal, timing, attempt, beforeFetch, publicCorrelationId, auxiliaryAuth, upstreamHeadersObserved) {
  const url = resolveUpstreamEndpoint("openai", "chat", route2.providerEndpoints, {
    providerId: route2.providerId
  });
  assertTextUpstreamHttpUrl(url);
  const routeIdentity = beforeFetch ? captureTextRouteIdentity(route2) : null;
  const cancelledBeforeDispatch = () => ({
    response: preDispatchCancelledTextResponse("chat", publicCorrelationId),
    usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL, cancelled: true }),
    upstreamRequestId: null,
    meta: {
      failoverForbidden: true,
      gatewayGeneratedError: true
    }
  });
  if (requestSignal?.aborted) return cancelledBeforeDispatch();
  const requestBody = ensureOpenAiStreamIncludesUsage({
    ...buildRouteRequestBody(route2, body),
    model: applyVertexOpenAiModelPrefix(url, route2.providerModelName)
  });
  return withOwnedJsonUpload(requestBody, requestSignal, async (upload) => {
    const { secret } = await resolveProviderUpstreamSecret(route2.providerApiKey, { signal: requestSignal, auxiliaryAuth });
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": String(upload.contentLength),
      Authorization: `Bearer ${secret}`
    };
    new Headers(headers);
    if (requestSignal?.aborted) return cancelledBeforeDispatch();
    if (beforeFetch) {
      let outboundBodyCanonicalSha256;
      try {
        outboundBodyCanonicalSha256 = await canonicalChatJsonSha256(upload.preparedSnapshot);
      } catch {
      }
      const prepared = createPreparedTextAttempt({
        routeIdentity,
        url,
        method: "POST",
        headers,
        outboundBodySha256: await upload.digestSha256(),
        outboundBodyBytes: upload.contentLength,
        outboundBodyCanonicalSha256
      });
      await beforeFetch(prepared);
    }
    if (requestSignal?.aborted) return cancelledBeforeDispatch();
    let response;
    try {
      const init = {
        method: "POST",
        // A redirect is another unbudgeted dispatch and may forward credentials.
        redirect: "manual",
        headers,
        body: upload.body,
        duplex: "half",
        signal: requestSignal
      };
      response = await fetch(url, init);
    } catch (error) {
      throw markUpstreamOutcomeUnknown(error);
    }
    upstreamHeadersObserved?.(response.status);
    timing?.markAttemptHeaders(attempt, response.status);
    const upstreamRequestId = extractUpstreamRequestId(response.headers);
    const normalizedContentType = (response.headers.get("Content-Type") ?? "").toLowerCase();
    const streamRequested = requestBody.stream === true;
    if (response.ok && streamRequested && response.body && normalizedContentType.includes("text/event-stream")) {
      const result = streamResponseWithUsage(
        response,
        requestSignal,
        timing,
        route2.gatewayModelId,
        route2.providerName,
        publicCorrelationId
      );
      return { ...result, upstreamRequestId };
    }
    const owned = ownUpstreamResponse(response, requestSignal);
    response = owned.response;
    if (response.ok) {
      if (!streamRequested && normalizedContentType.includes("application/json")) {
        const result = await nonStreamResponseWithUsage(
          response,
          timing,
          route2.gatewayModelId,
          publicCorrelationId,
          requestSignal
        );
        return { ...result, upstreamRequestId, resourceCompletion: owned.resourceCompletion };
      }
      const invalid = await cancelInvalidTextSuccessResponse(response, {
        skin: "chat",
        protocol: "Chat Completions",
        requestId: publicCorrelationId
      });
      timing?.markStreamComplete();
      return {
        ...invalid,
        usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
        upstreamRequestId,
        resourceCompletion: owned.resourceCompletion
      };
    }
    return {
      response,
      usagePromise: Promise.resolve(EMPTY_USAGE_LOCAL),
      upstreamRequestId,
      resourceCompletion: owned.resourceCompletion,
      meta: ambiguousDispatchedStatusMeta(response.status)
    };
  });
}

// packages/proxy/src/services/text-usage-settlement.ts
function hasAuthoritativeTextUsage(usage) {
  return typeof usage.raw_usage === "string" && usage.raw_usage.length > 0 || usage.total_tokens > 0 || usage.input_tokens > 0 || usage.output_tokens > 0 || usage.reasoning_tokens > 0;
}
function textUsageCostIsUnknown(input) {
  if (input.upstreamOutcomeUnknown) return true;
  if (!input.upstreamResponseOk) return false;
  return !input.usageAvailable || input.cancelled === true || input.streamError === true || input.responseBodyTooLarge === true || input.serviceTierPricingUnknown === true;
}

// product-sse-cancel-worker.mjs
var streamPath = "/fixture/product-sse";
var minimalPath = "/fixture/minimal-readable";
function localURL(raw) {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw Error("owned loopback only");
  return url;
}
async function observe(env, caseId, kind, value) {
  const target = localURL(env.OBSERVATION_URL);
  const response = await fetch(target, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseId, kind, value, workerWallTime: Date.now() }) });
  if (response.status !== 204) throw Error("observation was not recorded");
  await response.body?.cancel();
}
function route(base) {
  return { targetId: "synthetic", providerId: "synthetic", providerName: "synthetic", providerModelName: "synthetic", gatewayModelId: "public/synthetic", upstreamProtocol: "openai", upstreamOperation: "chat", adapter: "passthrough", providerEndpoints: { openai: { base } }, providerApiKey: "synthetic-only", customParams: null, routeGroup: "default", routePriority: 0, routeWeight: 1 };
}
var product_sse_cancel_worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/warmup" && request.method === "GET") return new Response("owned-worker-ready");
    if (request.method !== "POST" || ![streamPath, minimalPath].includes(url.pathname)) return new Response(null, { status: 404 });
    const caseId = url.pathname === streamPath ? "product" : "minimal";
    request.signal.addEventListener("abort", () => {
      ctx.waitUntil(observe(env, caseId, "request-signal-aborted", { aborted: request.signal.aborted }));
    }, { once: true });
    await observe(env, caseId, "request-start", { signalInitiallyAborted: request.signal.aborted });
    if (caseId === "minimal") {
      let timer;
      let chunks = 0;
      let stopped = false;
      const body = new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            if (stopped) return;
            if (++chunks > 400) {
              stopped = true;
              clearInterval(timer);
              controller.error(Error("minimal stream ceiling"));
              return;
            }
            try {
              controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ minimal: true, sequence: chunks }) + "\n\n"));
            } catch (error) {
              stopped = true;
              clearInterval(timer);
              ctx.waitUntil(observe(env, caseId, "minimal-enqueue-error", { chunks, message: String(error.message) }));
            }
          }, 40);
        },
        cancel() {
          stopped = true;
          clearInterval(timer);
          return observe(env, caseId, "minimal-source-cancel", { chunks, stopped: true });
        }
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
    }
    const upstream = localURL(env.UPSTREAM_BASE);
    const result = await dispatchOpenAiRoute(route(upstream.href), { stream: true }, request.signal);
    if (!result.resourceCompletion || typeof result.resourceCompletion.then !== "function") throw Error("real driver resourceCompletion missing");
    const usageTask = result.usagePromise.then((usage) => observe(env, caseId, "usage-settled", {
      usage,
      costUnknown: textUsageCostIsUnknown({ upstreamResponseOk: result.response.ok, usageAvailable: hasAuthoritativeTextUsage(usage), cancelled: usage.cancelled === true, streamError: Boolean(usage.stream_error), upstreamOutcomeUnknown: result.meta?.upstreamOutcomeUnknown === true, responseBodyTooLarge: result.meta?.responseBodyTooLarge === true })
    }));
    const resourceTask = result.resourceCompletion.then((outcome) => observe(env, caseId, "resource-completion-settled", { outcome }));
    ctx.waitUntil(Promise.all([usageTask, resourceTask]).catch((error) => {
      console.error(JSON.stringify({ fixture: "product-sse-cancel", kind: "observer-failed", caseId, message: String(error.message) }));
      throw error;
    }));
    return result.response;
  }
};
export {
  product_sse_cancel_worker_default as default
};
