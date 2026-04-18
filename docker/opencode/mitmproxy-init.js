// NODE_OPTIONS preload: wire undici's EnvHttpProxyAgent so Node.js built-in fetch
// and http/https clients honor HTTP_PROXY / HTTPS_PROXY / NO_PROXY on every invocation.
// Runs on every node process startup.
//
// Fails loud: if undici is unresolvable or EnvHttpProxyAgent throws, the process
// exits non-zero. Silent failure here would leave opencode with no proxy agent in
// a network-isolated container, producing opaque fetch timeouts far from the cause.
// The image's build-time check (Dockerfile) ensures require('undici') resolves, so
// a runtime failure here means something is actually broken.
try {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = require("undici");
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch (e) {
  process.stderr.write(
    `[thor] FATAL: mitmproxy-init failed to set proxy agent: ${e}\n` +
      `[thor] Without this, opencode's HTTPS calls will time out (network isolation is on).\n` +
      `[thor] Check that 'undici' is installed in the opencode image.\n`,
  );
  process.exit(1);
}
