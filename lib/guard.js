const GUARD_FAILURE_CODE = "gateway/internal";
const DEFAULT_TIMEOUT_MS = 15e3;
const GUARDED_MARK = Symbol.for("@argszero/cordis-plugin-remote-read-guard/guarded");
const GUARDED_READS = [
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
function bounded(answer, read, settings) {
  const timeoutMs = settings.timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      settings.onEvent?.({ kind: "deadline", read, detail: `${String(timeoutMs)}ms` });
      resolve(guardFailure(deadlineMessage(read, timeoutMs)));
    }, timeoutMs);
    const answerLate = (detail) => {
      settings.onEvent?.({ kind: "late", read, detail });
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
        settings.onEvent?.({ kind: "threw", read, detail: messageOf(error) });
        resolve(guardFailure(threwMessage(read, messageOf(error))));
      }
    );
  });
}
function guardAccessor(holder, method, read, settings) {
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
        settings.onEvent?.({ kind: "threw", read, detail: messageOf(error) });
        return Promise.resolve(guardFailure(threwMessage(read, messageOf(error))));
      }
      if (isPromiseLike(answer)) return bounded(answer, read, settings);
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
export {
  DEFAULT_TIMEOUT_MS,
  GUARDED_READS,
  GUARD_FAILURE_CODE,
  bounded,
  deadlineMessage,
  guardAccessor,
  guardFailure,
  isGuarded,
  isPromiseLike,
  restoreAccessor,
  threwMessage
};
