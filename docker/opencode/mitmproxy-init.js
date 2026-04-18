// NODE_OPTIONS preload: wire undici's EnvHttpProxyAgent so Node.js built-in fetch
// and http/https clients honor HTTP_PROXY / HTTPS_PROXY / NO_PROXY on every invocation.
// Runs on every node process startup — keep it fast and never throw.
try {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = require("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch (e) {
  process.stderr.write(`[thor] mitmproxy-init: failed to set proxy agent: ${e}\n`);
}
