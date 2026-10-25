window.__ModuleLoader__.load({ id: "@argszero/cordis-plugin-remote-read-guard", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  DEFAULT_TIMEOUT_MS: () => DEFAULT_TIMEOUT_MS,
  GUARDED_READS: () => GUARDED_READS,
  GUARD_FAILURE_CODE: () => GUARD_FAILURE_CODE,
  apply: () => apply,
  configure: () => configure,
  guardFailure: () => guardFailure,
  guardReport: () => guardReport,
  inject: () => inject,
  unwrapAll: () => unwrapAll
});
module.exports = __toCommonJS(index_exports);

// src/client/guard.ts
var GUARD_FAILURE_CODE = "gateway/internal";
var DEFAULT_TIMEOUT_MS = 15e3;
var GUARDED_MARK = Symbol.for("@argszero/cordis-plugin-remote-read-guard/guarded");
var GUARDED_READS = [
  "pluginInventory.list",
  "pluginManager.listBundles",
  "pluginManager.listPlugins"
];
function threwMessage(read, message) {
  return `${read} threw instead of resolving. This is an assembly fault \u2014 the Remote face folds carrier failures into the { ok: false } branch itself, so a rejection here means the call could not be made. Cause: ${message}`;
}
function deadlineMessage(read, timeoutMs) {
  return `${read} did not answer within ${String(timeoutMs)}ms. The read is reported as failed so its consumer can leave its loading state; the call itself was not cancelled and may still answer.`;
}
function guardFailure(message, code = GUARD_FAILURE_CODE) {
  return { ok: false, error: { isDSHRemoteError: true, code, message, details: {} } };
}
function isPromiseLike(value) {
  return typeof value === "object" && value !== null && typeof value.then === "function";
}
function isGuarded(method) {
  return typeof method === "function" && method[GUARDED_MARK] === true;
}
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}
function bounded(answer, read, settings2) {
  const timeoutMs = settings2.timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      settings2.onEvent?.({ kind: "deadline", read, detail: `${String(timeoutMs)}ms` });
      resolve(guardFailure(deadlineMessage(read, timeoutMs)));
    }, timeoutMs);
    const answerLate = (detail) => {
      settings2.onEvent?.({ kind: "late", read, detail });
    };
    answer.then(
      (value) => {
        if (settled) {
          answerLate("resolved");
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          answerLate(messageOf(error));
          return;
        }
        settled = true;
        clearTimeout(timer);
        settings2.onEvent?.({ kind: "threw", read, detail: messageOf(error) });
        resolve(guardFailure(threwMessage(read, messageOf(error))));
      }
    );
  });
}
function guardAccessor(holder, method, read, settings2) {
  const descriptor = Object.getOwnPropertyDescriptor(holder, method);
  if (descriptor === void 0) return { kind: "skipped", reason: "missing" };
  const get = descriptor.get;
  if (typeof get !== "function") return { kind: "skipped", reason: "not-an-accessor" };
  if (descriptor.configurable !== true) return { kind: "skipped", reason: "not-configurable" };
  if (isGuarded(get)) return { kind: "skipped", reason: "already-guarded" };
  const guardedGetter = function guardedGetter2() {
    const owner = this;
    return function guardedCall(...args) {
      let answer;
      try {
        answer = get.call(owner)(...args);
      } catch (error) {
        settings2.onEvent?.({ kind: "threw", read, detail: messageOf(error) });
        return Promise.resolve(guardFailure(threwMessage(read, messageOf(error))));
      }
      if (isPromiseLike(answer)) return bounded(answer, read, settings2);
      return answer;
    };
  };
  Object.defineProperty(guardedGetter, GUARDED_MARK, { value: true });
  Object.defineProperty(holder, method, {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get: guardedGetter
  });
  return { kind: "armed", original: descriptor };
}
function restoreAccessor(holder, method, original) {
  if (original === void 0) return false;
  Object.defineProperty(holder, method, original);
  return true;
}

// src/client/index.ts
var inject = [];
var settings = { timeoutMs: DEFAULT_TIMEOUT_MS };
var records = /* @__PURE__ */ new Map();
var originals = /* @__PURE__ */ new Map();
function configure(next) {
  if (next.timeoutMs !== void 0) {
    if (!Number.isFinite(next.timeoutMs) || next.timeoutMs <= 0) {
      throw new Error(`remote-read-guard: timeoutMs must be a positive finite number, got ${String(next.timeoutMs)}`);
    }
    settings.timeoutMs = next.timeoutMs;
  }
  if ("onEvent" in next) settings.onEvent = next.onEvent;
}
function guardReport() {
  return [...records.values()].map((record) => ({ ...record }));
}
function unwrapAll() {
  let restored = 0;
  for (const [read, entry] of originals) {
    if (restoreAccessor(entry.holder, entry.method, entry.descriptor)) restored += 1;
    records.set(read, { read, status: "skipped", detail: "unwrapped" });
  }
  originals.clear();
  return restored;
}
function byNamespace(reads) {
  const grouped = /* @__PURE__ */ new Map();
  for (const read of reads) {
    const at = read.lastIndexOf(".");
    const namespace = at === -1 ? read : read.slice(0, at);
    const method = at === -1 ? "" : read.slice(at + 1);
    const methods = grouped.get(namespace);
    if (methods === void 0) grouped.set(namespace, [method]);
    else methods.push(method);
  }
  return grouped;
}
function apply(ctx) {
  for (const [namespace, methods] of byNamespace(GUARDED_READS)) {
    ctx.inject([`remote.${namespace}`], (scoped) => {
      const holder = scoped.get(`remote.${namespace}`);
      if (holder === void 0) {
        for (const method of methods) records.set(`${namespace}.${method}`, { read: `${namespace}.${method}`, status: "pending", detail: namespace });
        return;
      }
      for (const method of methods) {
        const read = `${namespace}.${method}`;
        const outcome = guardAccessor(holder, method, read, settings);
        if (outcome.kind === "armed") {
          records.set(read, { read, status: "armed" });
          originals.set(read, { holder, method, descriptor: outcome.original });
        } else {
          records.set(read, { read, status: "skipped", detail: outcome.reason });
        }
      }
    });
  }
}
return module.exports; } });
