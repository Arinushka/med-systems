import { fetch as undiciFetch, ProxyAgent } from 'undici';
function getProxyUrl() {
    const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    if (httpsProxy && httpsProxy.trim().length > 0)
        return httpsProxy.trim();
    const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (httpProxy && httpProxy.trim().length > 0)
        return httpProxy.trim();
    return null;
}
// Forces OpenAI requests through the proxy by passing undici `dispatcher`.
export function createProxiedOpenaiFetch() {
    const proxyUrl = getProxyUrl();
    if (!proxyUrl)
        return undefined;
    const agent = new ProxyAgent(proxyUrl);
    const proxiedFetch = ((input, init) => {
        return undiciFetch(input, {
            ...(init ?? {}),
            dispatcher: agent,
        });
    });
    return proxiedFetch;
}
