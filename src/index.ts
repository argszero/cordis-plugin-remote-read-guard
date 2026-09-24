/**
 * Node half of @argszero/cordis-plugin-remote-read-guard.
 *
 * Deliberately empty. This plugin's whole substance is in the browser half — the
 * reads it bounds are made by the Web UI, on the client — and the browser half
 * reaches the page because this package declares `dsh.client`:
 * `@deepseek-ai/dsh-client-modules` scans the Host Loader's entries for that
 * declaration, so mounting this row is what puts the guard in the Web shell. A
 * node half that did anything here would be guarding a plane where these calls
 * do not exist.
 *
 * @module @argszero/cordis-plugin-remote-read-guard
 */

/** Required services: none — this half only has to exist for the row to mount. */
export const inject: readonly string[] = []

/**
 * Mount the package. The browser half is discovered from the manifest, not from
 * here, so there is nothing to install on the Host.
 */
export function apply(): void {}
