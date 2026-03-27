function maskProxyForLog(url) {
    // Avoid printing credentials if proxy URL contains user:pass@
    return url.replace(/:([^@]+)@/g, ':***@');
}
// OpenAI SDK uses `fetch` (in Node) and undici respects `HTTP_PROXY/HTTPS_PROXY`.
// Since we can't "create" a VPN in code, we enable proxy by setting env vars.
export function applyOpenaiProxyEnv() {
    const proxyUrl = process.env.OPENAI_PROXY_URL?.trim();
    if (!proxyUrl)
        return;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.HTTPS_proxy = proxyUrl;
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTP_proxy = proxyUrl;
    const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
    if (noProxy)
        process.env.NO_PROXY = noProxy;
    // eslint-disable-next-line no-console
    console.log(`[openaiProxy] Using proxy: ${maskProxyForLog(proxyUrl)}`);
}
