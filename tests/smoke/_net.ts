/**
 * Reachability probe for the smoke suites that drive a real browser against
 * https://example.com. Offline / firewalled CI should SKIP those suites, not
 * fail them. Import and gate: `describe.skipIf(!ONLINE)(...)`.
 */
export async function exampleComReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch("https://example.com", {
      method: "HEAD",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // Any HTTP answer means the network path is up.
    return res.status < 500;
  } catch {
    return false;
  }
}
