// dsh-quote-chip — host half.
//
// The whole feature is browser-side (the composer, the selection toolbar, the
// reference chip). This half exists only so the bundle mounts a row and the
// client half (dsh/client.js) is discovered by dsh.client. It registers nothing
// and touches no host internal, so it can never break the host boot path.

export const inject = []

export function apply() {}
