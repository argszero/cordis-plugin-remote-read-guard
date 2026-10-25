/**
 * Browser half of @argszero/cordis-plugin-remote-read-guard.
 *
 * Arms {@link guardAccessor} on the Client Remote reads the plugin-manager page
 * depends on, and re-arms them across namespace remounts.
 *
 * ## Where the arms come from
 *
 * Each Client Remote namespace is its own cordis Service on a dotted name
 * (`packages/api/gateway/src/client/index.ts`: `RemoteNamespaceService` is
 * constructed with `remote.${name}`), and the client assembly mounts them
 * asynchronously after this plugin's own `apply`. So the arming is a
 * `ctx.inject(['remote.<namespace>'], …)`: cordis parks that fiber until the
 * service exists, and re-runs it when a namespace is disposed and rebuilt —
 * measured on `@deepseek-ai/cordis` 4.0.4, which is the behaviour the remount arm
 * of `test/plugin.spec.mjs` pins.
 *
 * `ctx.get(name)` is used to read the service rather than a property access, and
 * that is deliberate: `ctx.get` is an optional lookup, while a property read
 * requires the name to be declared up front — `inject: ['remote']` alone throws
 * `cannot get property "remote.pluginInventory" without inject`.
 *
 * ## What this half does not do
 *
 * It never cancels a read, never retries one, and never substitutes a value. A
 * read it reports as failed may still answer later, and when it does the guard
 * says so through `onEvent` — "the Host was slow" and "the Host never answered"
 * call for different fixes.
 *
 * @module @argszero/cordis-plugin-remote-read-guard/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type ReadGuardEvent } from './guard.ts';
export type { EmptyDetails, GuardedFailure, GuardedOk, GuardedResult, GuardOutcome, ReadGuardEvent, ReadGuardSettings, } from './guard.ts';
export { DEFAULT_TIMEOUT_MS, GUARD_FAILURE_CODE, GUARDED_READS, guardFailure } from './guard.ts';
/**
 * Services this browser half declares. None: it reads the Remote namespaces
 * through `ctx.inject` waits inside {@link apply}, because they are mounted by the
 * client assembly *after* this plugin's own fiber — declaring them here would park
 * this plugin instead, and a parked plugin never arms anything.
 */
export declare const inject: readonly string[];
/** What was armed, and what could not be. */
export interface GuardRecord {
    /** The guarded read, as `<namespace>.<method>`. */
    readonly read: string;
    /** `armed` once the wrapper is in place; `pending` while its namespace is not mounted yet. */
    readonly status: 'armed' | 'pending' | 'skipped';
    /** Why a read was skipped, or the namespace currently missing. */
    readonly detail?: string;
}
/**
 * Change the guard's settings. Call it before the namespaces mount for the next
 * read to use the new deadline; every read reads `timeoutMs` when it is called,
 * so a later change applies to later reads rather than to the ones in flight.
 *
 * Today nothing in a shipped dsh profile can reach this: a browser-half plugin
 * receives no config — `packages/client/modules/src/client/entries.ts` builds each
 * loader entry from the row's `id` alone, and the boot row carries no config field
 * — so a deployment that needs a different deadline has to reach this door from a
 * client module it also ships, or patch {@link DEFAULT_TIMEOUT_MS}. That is a
 * boundary of the plugin, not a choice of it.
 * @param next - the settings to apply; omitted fields are left as they are.
 */
export declare function configure(next: {
    timeoutMs?: number;
    onEvent?: ((event: ReadGuardEvent) => void) | undefined;
}): void;
/**
 * What the guard has armed, in the order it tried. A test — or an operator
 * reading a crash report — can tell "the guard ran and skipped this read" apart
 * from "the guard never ran", which a passing read alone cannot show.
 * @returns one record per guarded read this half has tried.
 */
export declare function guardReport(): GuardRecord[];
/**
 * Take the guard off every read it armed, and put the namespaces back as they
 * were. The plugin needs this only for its own tests and for an operator
 * unwinding it by hand; cordis disposal is enough on a real page, where the
 * namespace instance dies with its fiber.
 * @returns how many reads were restored.
 */
export declare function unwrapAll(): number;
/**
 * Client plugin body: arm the guard on every guarded read.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
