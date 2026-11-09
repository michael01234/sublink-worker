/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from 'hono';
import { Layout } from '../components/Layout.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { Form } from '../components/Form.jsx';
import { Footer } from '../components/Footer.jsx';
import { UpdateChecker } from '../components/UpdateChecker.jsx';
import { SingboxConfigBuilder } from '../builders/SingboxConfigBuilder.js';
import { ClashConfigBuilder } from '../builders/ClashConfigBuilder.js';
import { SurgeConfigBuilder } from '../builders/SurgeConfigBuilder.js';
import { createTranslator, resolveLanguage } from '../i18n/index.js';
import { encodeBase64, decodeBase64, tryDecodeSubscriptionLines } from '../utils.js';
import { isBlockedProxyName } from '../builders/BaseConfigBuilder.js';

// --- my-sub fork patch: name of a raw share link for notice filtering ---
function shareLinkName(link) {
    if (link.startsWith('vmess://')) {
        try {
            const obj = JSON.parse(decodeBase64(link.slice('vmess://'.length)));
            return obj?.ps || '';
        } catch {
            return '';
        }
    }
    const hashIdx = link.indexOf('#');
    if (hashIdx === -1) return '';
    const raw = link.slice(hashIdx + 1);
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}
import { APP_NAME, APP_SUBTITLE } from '../constants.js';
import { ShortLinkService } from '../services/shortLinkService.js';
import { ConfigStorageService } from '../services/configStorageService.js';
import { ServiceError, MissingDependencyError } from '../services/errors.js';
import { normalizeRuntime } from '../runtime/runtimeConfig.js';
import { PREDEFINED_RULE_SETS, SING_BOX_CONFIG, SING_BOX_CONFIG_V1_11, generateSubconverterConfig } from '../config/index.js';

const DEFAULT_USER_AGENT = 'v2rayN/6.55';

export function createApp(bindings = {}) {
    const runtime = normalizeRuntime(bindings);
    const services = {
        shortLinks: runtime.kv ? new ShortLinkService(runtime.kv, { shortLinkTtlSeconds: runtime.config.shortLinkTtlSeconds }) : null,
        configStorage: runtime.kv ? new ConfigStorageService(runtime.kv, { configTtlSeconds: runtime.config.configTtlSeconds }) : null
    };

    const app = new Hono();

    app.use('*', async (c, next) => {
        const acceptLanguage = getRequestHeader(c.req, 'Accept-Language');
        const lang = c.req.query('lang') || acceptLanguage?.split(',')[0] || 'zh-CN';
        c.set('lang', lang);
        c.set('t', createTranslator(lang));
        await next();
    });

    // --- my-sub hardening gate (private fork patch) ---
    // Only short-code subscription routes are public. The conversion
    // endpoints they redirect to require the GATE_KEY binding value,
    // which the redirect handler appends server-side. Everything else
    // (converter UI, /shorten-v2, POST /config, /resolve, /subconverter)
    // is closed to the public.
    app.use('*', async (c, next) => {
        const path = new URL(c.req.url).pathname;
        if (/^\/(b|c|x|s)\/[^/]+$/.test(path) || /^\/r\/[^/]+(\/(c|b|v))?$/.test(path) || path === '/favicon.ico') return next();
        if (/^\/(singbox|clash|surge|xray)$/.test(path)) {
            const gate = c.req.query('gate');
            if (gate && runtime.gateKey && gate === runtime.gateKey) return next();
            return c.text('Forbidden', 403);
        }
        return c.text('Forbidden', 403);
    });

    // --- my-sub residential direct-distribution route (private fork patch) ---
    // Serves a single HTTP proxy endpoint (credentials in the RES_LINK
    // plain_text binding, deploy-time only) as a ready-made subscription in
    // three client formats. Bearer model matches the short codes: the
    // RES_TOKEN path segment is the secret; any other token gets 403.
    const RES_NAME = '美国住宅-IPRoyal';
    const FRONT_NAME = '前置-VLESS';
    const resAuthorized = (c) => Boolean(runtime.resToken && runtime.resLink) && c.req.param('token') === runtime.resToken;
    const resUrl = () => { try { return new URL(runtime.resLink); } catch { return null; } };
    // Optional chain front: a vless share link (RES_FRONT binding). When it
    // parses, the Clash and sing-box variants chain the residential HTTP
    // proxy behind it (dialer-proxy / detour) so the slow direct first leg
    // is replaced by the user's tuned front line. vless+reality only.
    const frontUrl = () => {
        if (!runtime.resFront) return null;
        try {
            const u = new URL(runtime.resFront);
            return u.protocol === 'vless:' ? u : null;
        } catch { return null; }
    };
    const frontParams = (u) => ({
        uuid: decodeURIComponent(u.username),
        host: u.hostname,
        port: Number(u.port),
        flow: u.searchParams.get('flow') || '',
        sni: u.searchParams.get('sni') || '',
        fp: u.searchParams.get('fp') || 'chrome',
        pbk: u.searchParams.get('pbk') || '',
        sid: u.searchParams.get('sid') || ''
    });
    // Main-subscription injection: for the owner's own subscription only
    // (identified by his front server address inside the config string),
    // add the chained residential node into the built Clash / sing-box
    // configs, so it ships inside the main subscription itself.
    const isOwnSubscription = (configParam) => typeof configParam === 'string' && configParam.includes('66.154.126.57');
    const RES_GROUPS = ['🚀 节点选择', '🌐 非中国', '🐟 漏网之鱼'];
    const injectResidentialSingbox = (cfgObj) => {
        const u = resUrl(); if (!u || !Array.isArray(cfgObj?.outbounds)) return;
        if (cfgObj.outbounds.some(o => o.tag === RES_NAME)) return;
        const http = { type: 'http', tag: RES_NAME, server: u.hostname, server_port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
        const f = frontUrl();
        if (f) {
            const p = frontParams(f);
            if (!cfgObj.outbounds.some(o => o.tag === 'front-vless')) {
                cfgObj.outbounds.push({ type: 'vless', tag: 'front-vless', server: p.host, server_port: p.port, uuid: p.uuid, flow: p.flow, tls: { enabled: true, server_name: p.sni, utls: { enabled: true, fingerprint: p.fp }, reality: { enabled: true, public_key: p.pbk, short_id: p.sid } } });
            }
            http.detour = 'front-vless';
        }
        cfgObj.outbounds.push(http);
        for (const o of cfgObj.outbounds) {
            if (o.type === 'selector' && RES_GROUPS.includes(o.tag) && Array.isArray(o.outbounds) && !o.outbounds.includes(RES_NAME)) o.outbounds.push(RES_NAME);
        }
    };
    const injectResidentialClash = (cfgObj) => {
        const u = resUrl(); if (!u || !Array.isArray(cfgObj?.proxies)) return;
        if (cfgObj.proxies.some(p => p.name === RES_NAME)) return;
        const http = { name: RES_NAME, type: 'http', server: u.hostname, port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
        const f = frontUrl();
        if (f) {
            const p = frontParams(f);
            if (!cfgObj.proxies.some(x => x.name === FRONT_NAME)) {
                cfgObj.proxies.push({ name: FRONT_NAME, type: 'vless', server: p.host, port: p.port, uuid: p.uuid, network: 'tcp', udp: true, tls: true, flow: p.flow, servername: p.sni, 'client-fingerprint': p.fp, 'reality-opts': { 'public-key': p.pbk, 'short-id': p.sid } });
            }
            http['dialer-proxy'] = FRONT_NAME;
        }
        cfgObj.proxies.push(http);
        for (const g of cfgObj['proxy-groups'] || []) {
            if (g.type === 'select' && RES_GROUPS.includes(g.name) && Array.isArray(g.proxies) && !g.proxies.includes(RES_NAME)) g.proxies.push(RES_NAME);
        }
    };

    app.get('/r/:token', (c) => {
        if (!resAuthorized(c)) return c.text('Forbidden', 403);
        return c.text(btoa(runtime.resLink), 200, { 'Content-Type': 'text/plain; charset=utf-8' });
    });
    app.get('/r/:token/v', (c) => {
        // v2rayN variant: v2rayN cannot parse http:// share links at all
        // (no Fmt handler; upstream issue #5332), but its subscription
        // importer accepts a full sing-box JSON as a custom-config profile.
        if (!resAuthorized(c)) return c.text('Forbidden', 403);
        const u = resUrl(); if (!u) return c.text('Forbidden', 403);
        return c.json({
            log: { level: 'warn', timestamp: true },
            dns: {
                servers: [
                    { type: 'https', tag: 'remote', server: '8.8.8.8', detour: 'res-us' },
                    { type: 'local', tag: 'local' }
                ],
                final: 'remote',
                strategy: 'ipv4_only'
            },
            inbounds: [
                { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 10808 }
            ],
            outbounds: [
                { type: 'http', tag: 'res-us', server: u.hostname, server_port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
                { type: 'direct', tag: 'direct' }
            ],
            route: {
                rules: [{ ip_is_private: true, outbound: 'direct' }],
                final: 'res-us'
            }
        });
    });
    app.get('/r/:token/c', (c) => {
        if (!resAuthorized(c)) return c.text('Forbidden', 403);
        const u = resUrl(); if (!u) return c.text('Forbidden', 403);
        const f = frontUrl();
        const proxies = [];
        let dialer = '';
        if (f) {
            const p = frontParams(f);
            proxies.push(`  - {name: "${FRONT_NAME}", type: vless, server: ${p.host}, port: ${p.port}, uuid: ${p.uuid}, network: tcp, tls: true, udp: true, flow: ${p.flow}, servername: ${p.sni}, client-fingerprint: ${p.fp}, reality-opts: {public-key: ${p.pbk}, short-id: ${p.sid}}}`);
            dialer = `, dialer-proxy: "${FRONT_NAME}"`;
        }
        proxies.push(`  - {name: "${RES_NAME}", type: http, server: ${u.hostname}, port: ${u.port}, username: ${decodeURIComponent(u.username)}, password: ${decodeURIComponent(u.password)}${dialer}}`);
        const yaml = [
            'mixed-port: 7890',
            'mode: rule',
            'proxies:',
            ...proxies,
            'proxy-groups:',
            `  - {name: PROXY, type: select, proxies: ["${RES_NAME}", DIRECT]}`,
            'rules:',
            '  - GEOIP,CN,DIRECT',
            '  - MATCH,PROXY',
            ''
        ].join('\n');
        return c.text(yaml, 200, { 'Content-Type': 'text/yaml; charset=utf-8' });
    });
    app.get('/r/:token/b', (c) => {
        if (!resAuthorized(c)) return c.text('Forbidden', 403);
        const u = resUrl(); if (!u) return c.text('Forbidden', 403);
        const outbounds = [];
        const http = { type: 'http', tag: RES_NAME, server: u.hostname, server_port: Number(u.port), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
        const f = frontUrl();
        if (f) {
            const p = frontParams(f);
            outbounds.push({
                type: 'vless', tag: 'front-vless', server: p.host, server_port: p.port, uuid: p.uuid, flow: p.flow,
                tls: { enabled: true, server_name: p.sni, utls: { enabled: true, fingerprint: p.fp }, reality: { enabled: true, public_key: p.pbk, short_id: p.sid } }
            });
            http.detour = 'front-vless';
        }
        outbounds.push(http, { type: 'direct', tag: 'direct' });
        return c.json({ outbounds, route: { final: RES_NAME } });
    });

    app.get('/', (c) => {
        const t = c.get('t');
        const lang = resolveLanguage(c.get('lang'));
        const subtitle = APP_SUBTITLE[lang] || APP_SUBTITLE['zh-CN'];

        return c.html(
            <Layout title={t('pageTitle')} description={t('pageDescription')} keywords={t('pageKeywords')}>
                <div class="flex flex-col min-h-screen">
                    <Navbar />
                    <main class="flex-1">
                        <div class="container mx-auto px-4 py-8 pt-24">
                            <div class="max-w-4xl mx-auto">
                                <div class="text-center mb-12 pt-8">
                                    <h1 class="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white mb-4 tracking-tight">
                                        {APP_NAME}
                                    </h1>
                                    <p class="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
                                        {subtitle}
                                    </p>
                                </div>
                                <Form t={t} lang={lang} />
                            </div>
                        </div>
                    </main>
                    <Footer />
                    <UpdateChecker />
                </div>
            </Layout>
        );
    });

    app.get('/singbox', async (c) => {
        try {
            const config = c.req.query('config');
            if (!config) {
                return c.text('Missing config parameter', 400);
            }

            const selectedRules = parseSelectedRules(c.req.query('selectedRules'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const ua = c.req.query('ua') || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const enableClashUI = parseBooleanFlag(c.req.query('enable_clash_ui'));
            const externalController = c.req.query('external_controller');
            const externalUiDownloadUrl = c.req.query('external_ui_download_url');
            const configId = c.req.query('configId');
            const lang = c.get('lang');

            const requestedSingboxVersion = c.req.query('singbox_version') || c.req.query('sb_version') || c.req.query('sb_ver');
            const requestUserAgent = getRequestHeader(c.req, 'User-Agent');
            const singboxConfigVersion = resolveSingboxConfigVersion(requestedSingboxVersion, requestUserAgent);

            let baseConfig = singboxConfigVersion === '1.11' ? SING_BOX_CONFIG_V1_11 : SING_BOX_CONFIG;
            if (configId?.startsWith('singbox_')) {
                const storage = requireConfigStorage(services.configStorage);
                const storedConfig = await storage.getConfigById(configId);
                if (storedConfig) {
                    baseConfig = storedConfig;
                }
            }

            const builder = new SingboxConfigBuilder(
                config,
                selectedRules,
                customRules,
                baseConfig,
                lang,
                ua,
                groupByCountry,
                enableClashUI,
                externalController,
                externalUiDownloadUrl,
                singboxConfigVersion,
                includeAutoSelect
            );
            await builder.build();
            if (isOwnSubscription(config)) injectResidentialSingbox(builder.config);
            const userinfo = builder.getSubscriptionUserinfo();
            if (userinfo) {
                c.header('subscription-userinfo', userinfo);
            }
            return c.json(builder.config);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/clash', async (c) => {
        try {
            const config = c.req.query('config');
            if (!config) {
                return c.text('Missing config parameter', 400);
            }

            const selectedRules = parseSelectedRules(c.req.query('selectedRules'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const ua = c.req.query('ua') || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const enableClashUI = parseBooleanFlag(c.req.query('enable_clash_ui'));
            const externalController = c.req.query('external_controller');
            const externalUiDownloadUrl = c.req.query('external_ui_download_url');
            const configId = c.req.query('configId');
            const lang = c.get('lang');

            let baseConfig;
            if (configId?.startsWith('clash_')) {
                const storage = requireConfigStorage(services.configStorage);
                baseConfig = await storage.getConfigById(configId);
            }

            const builder = new ClashConfigBuilder(
                config,
                selectedRules,
                customRules,
                baseConfig,
                lang,
                ua,
                groupByCountry,
                enableClashUI,
                externalController,
                externalUiDownloadUrl,
                includeAutoSelect
            );
            await builder.build();
            if (isOwnSubscription(config)) injectResidentialClash(builder.config);
            const userinfo = builder.getSubscriptionUserinfo();
            const headers = { 'Content-Type': 'text/yaml; charset=utf-8' };
            if (userinfo) {
                headers['subscription-userinfo'] = userinfo;
            }
            return c.text(builder.formatConfig(), 200, headers);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/surge', async (c) => {
        try {
            const config = c.req.query('config');
            if (!config) {
                return c.text('Missing config parameter', 400);
            }

            const selectedRules = parseSelectedRules(c.req.query('selectedRules'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const ua = c.req.query('ua') || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const configId = c.req.query('configId');
            const lang = c.get('lang');

            let baseConfig;
            if (configId?.startsWith('surge_')) {
                const storage = requireConfigStorage(services.configStorage);
                baseConfig = await storage.getConfigById(configId);
            }

            const builder = new SurgeConfigBuilder(
                config,
                selectedRules,
                customRules,
                baseConfig,
                lang,
                ua,
                groupByCountry,
                includeAutoSelect
            );
            builder.setSubscriptionUrl(c.req.url);
            await builder.build();

            const userinfo = builder.getSubscriptionUserinfo();
            if (userinfo) {
                c.header('subscription-userinfo', userinfo);
            }
            return c.text(builder.formatConfig());
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/subconverter', (c) => {
        try {
            const rawSelectedRules = c.req.query('selectedRules');
            let selectedRules;

            if (!rawSelectedRules) {
                selectedRules = PREDEFINED_RULE_SETS.balanced;
            } else if (PREDEFINED_RULE_SETS[rawSelectedRules]) {
                selectedRules = PREDEFINED_RULE_SETS[rawSelectedRules];
            } else {
                try {
                    const parsed = JSON.parse(rawSelectedRules);
                    if (Array.isArray(parsed)) {
                        selectedRules = parsed;
                    } else {
                        return c.text('Invalid selectedRules: must be a preset name (minimal, balanced, comprehensive) or a JSON array', 400);
                    }
                } catch {
                    return c.text(`Invalid selectedRules: "${rawSelectedRules}" is not a valid preset name or JSON array. Valid presets: minimal, balanced, comprehensive`, 400);
                }
            }

            const includeAutoSelect = c.req.query('include_auto_select') !== 'false';
            const groupByCountry = parseBooleanFlag(c.req.query('group_by_country'));
            const customRules = parseJsonArray(c.req.query('customRules'));
            const lang = c.get('lang');

            const config = generateSubconverterConfig({
                selectedRules,
                customRules,
                lang,
                includeAutoSelect,
                groupByCountry
            });

            return c.text(config, 200, {
                'Content-Type': 'text/plain; charset=utf-8'
            });
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/xray', async (c) => {
        const inputString = c.req.query('config');
        if (!inputString) {
            return c.text('Missing config parameter', 400);
        }

        const proxylist = inputString.split('\n');
        const finalProxyList = [];
        let subscriptionUserinfo;
        const userAgent = c.req.query('ua') || getRequestHeader(c.req, 'User-Agent') || DEFAULT_USER_AGENT;
        const headers = { 'User-Agent': userAgent };

        for (const proxy of proxylist) {
            const trimmedProxy = proxy.trim();
            if (!trimmedProxy) continue;

            if (trimmedProxy.startsWith('http://') || trimmedProxy.startsWith('https://')) {
                try {
                    const response = await fetch(trimmedProxy, { method: 'GET', headers });
                    const fetchedUserinfo = response.headers.get('subscription-userinfo');
                    if (fetchedUserinfo && subscriptionUserinfo === undefined) {
                        subscriptionUserinfo = fetchedUserinfo;
                    }
                    const text = await response.text();
                    let processed = tryDecodeSubscriptionLines(text, { decodeUriComponent: true });
                    if (!Array.isArray(processed)) processed = [processed];
                    finalProxyList.push(...processed.filter(item => typeof item === 'string' && item.trim() !== ''));
                } catch (e) {
                    runtime.logger.warn('Failed to fetch the proxy', e);
                }
            } else {
                let processed = tryDecodeSubscriptionLines(trimmedProxy);
                if (!Array.isArray(processed)) processed = [processed];
                finalProxyList.push(...processed.filter(item => typeof item === 'string' && item.trim() !== ''));
            }
        }

        const visibleProxyList = finalProxyList.filter(link => !isBlockedProxyName(shareLinkName(link)));
        const finalString = visibleProxyList.join('\n');
        if (!finalString) {
            return c.text('Missing config parameter', 400);
        }

        const responseHeaders = {};
        if (subscriptionUserinfo) {
            responseHeaders['subscription-userinfo'] = subscriptionUserinfo;
        }

        return c.text(encodeBase64(finalString), 200, responseHeaders);
    });

    app.get('/shorten-v2', async (c) => {
        try {
            const url = c.req.query('url');
            if (!url) {
                return c.text('Missing URL parameter', 400);
            }
            let parsedUrl;
            try {
                parsedUrl = new URL(url);
            } catch {
                return c.text('Invalid URL parameter', 400);
            }
            const queryString = parsedUrl.search;

            const shortLinks = requireShortLinkService(services.shortLinks);
            const code = await shortLinks.createShortLink(queryString, c.req.query('shortCode'));
            return c.text(code);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    const redirectHandler = (prefix) => async (c) => {
        try {
            const code = c.req.param('code');
            const shortLinks = requireShortLinkService(services.shortLinks);
            const originalParam = await shortLinks.resolveShortCode(code);
            if (!originalParam) return c.text('Short URL not found', 404);

            const url = new URL(c.req.url);
            const gateSuffix = runtime.gateKey
                ? `${originalParam.startsWith('?') ? '&' : '?'}gate=${encodeURIComponent(runtime.gateKey)}`
                : '';
            return c.redirect(`${url.origin}/${prefix}${originalParam}${gateSuffix}`);
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    };

    app.get('/s/:code', redirectHandler('surge'));
    app.get('/b/:code', redirectHandler('singbox'));
    app.get('/c/:code', redirectHandler('clash'));
    app.get('/x/:code', redirectHandler('xray'));

    app.post('/config', async (c) => {
        try {
            const { type, content } = await c.req.json();
            const storage = requireConfigStorage(services.configStorage);
            const configId = await storage.saveConfig(type, content);
            return c.text(configId);
        } catch (error) {
            if (error instanceof SyntaxError) {
                return c.text(`Invalid format: ${error.message}`, 400);
            }
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/resolve', async (c) => {
        try {
            const shortUrl = c.req.query('url');
            const t = c.get('t');
            if (!shortUrl) return c.text(t('missingUrl'), 400);

            let urlObj;
            try {
                urlObj = new URL(shortUrl);
            } catch {
                return c.text(t('invalidShortUrl'), 400);
            }
            const pathParts = urlObj.pathname.split('/');
            if (pathParts.length < 3) return c.text(t('invalidShortUrl'), 400);

            const prefix = pathParts[1];
            const shortCode = pathParts[2];
            if (!['b', 'c', 'x', 's'].includes(prefix)) return c.text(t('invalidShortUrl'), 400);

            const shortLinks = requireShortLinkService(services.shortLinks);
            const originalParam = await shortLinks.resolveShortCode(shortCode);
            if (!originalParam) return c.text(t('shortUrlNotFound'), 404);

            const mapping = { b: 'singbox', c: 'clash', x: 'xray', s: 'surge' };
            const originalUrl = `${urlObj.origin}/${mapping[prefix]}${originalParam}`;
            return c.json({ originalUrl });
        } catch (error) {
            return handleError(c, error, runtime.logger);
        }
    });

    app.get('/favicon.ico', async (c) => {
        if (!runtime.assetFetcher) {
            return c.notFound();
        }
        try {
            return await runtime.assetFetcher(c.req.raw);
        } catch (error) {
            runtime.logger.warn('Asset fetch failed', error);
            return c.notFound();
        }
    });

    return app;
}

export function parseSelectedRules(raw) {
    if (!raw) return [];

    // 首先检查是否是预设名称 (minimal, balanced, comprehensive)
    // 这确保向后兼容主分支的 API 行为
    if (typeof raw === 'string' && PREDEFINED_RULE_SETS[raw]) {
        return PREDEFINED_RULE_SETS[raw];
    }

    // 尝试解析为 JSON 数组
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        // 解析失败，回退到 minimal 预设
        console.warn(`Failed to parse selectedRules: ${raw}, falling back to minimal`);
        return PREDEFINED_RULE_SETS.minimal;
    }
}

function parseJsonArray(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function parseBooleanFlag(value) {
    return value === 'true' || value === true;
}

function parseSemverLike(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const match = trimmed.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: match[3] ? Number(match[3]) : 0
    };
}

function isSingboxLegacyConfig(version) {
    if (!version || Number.isNaN(version.major) || Number.isNaN(version.minor)) {
        return false;
    }
    if (version.major !== 1) {
        return version.major < 1;
    }
    return version.minor < 12;
}

// 1.14 swaps rule-set download_detour for http_client, which older clients
// reject as an unknown field, so it needs its own config tier.
function isSingboxModernConfig(version) {
    if (!version || Number.isNaN(version.major) || Number.isNaN(version.minor)) {
        return false;
    }
    if (version.major !== 1) {
        return version.major > 1;
    }
    return version.minor >= 14;
}

function resolveSingboxConfigTier(version) {
    if (isSingboxLegacyConfig(version)) return '1.11';
    return isSingboxModernConfig(version) ? '1.14' : '1.12';
}

function resolveSingboxConfigVersion(requestedVersion, userAgent) {
    const normalizedRequested = typeof requestedVersion === 'string' ? requestedVersion.trim().toLowerCase() : '';
    if (normalizedRequested && normalizedRequested !== 'auto') {
        if (normalizedRequested === 'legacy') return '1.11';
        if (normalizedRequested === 'latest') return '1.14';
        const parsed = parseSemverLike(normalizedRequested);
        if (parsed) {
            return resolveSingboxConfigTier(parsed);
        }
    }

    if (typeof userAgent === 'string' && userAgent) {
        const uaMatch = userAgent.match(/sing-box\/(\d+\.\d+(?:\.\d+)?)/i) || userAgent.match(/sing-box\s+(\d+\.\d+(?:\.\d+)?)/i);
        const versionString = uaMatch?.[1];
        const parsed = versionString ? parseSemverLike(versionString) : null;
        if (parsed) {
            return resolveSingboxConfigTier(parsed);
        }
    }

    return '1.12';
}

function getRequestHeader(request, name) {
    if (!request || !name) {
        return undefined;
    }

    try {
        const value = request.header(name);
        if (value !== undefined) {
            return value;
        }
    } catch {
        // Fallback if HonoRequest.header cannot read from the raw request.
    }

    const headers = request.raw?.headers;
    if (!headers) {
        return undefined;
    }

    if (typeof headers.get === 'function') {
        return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
    }

    if (typeof headers === 'object') {
        const lowerName = name.toLowerCase();
        const headerValue = headers[lowerName] ?? headers[name];
        if (Array.isArray(headerValue)) {
            return headerValue[0];
        }
        return headerValue;
    }

    return undefined;
}

function requireShortLinkService(service) {
    if (!service) {
        throw new MissingDependencyError('Short link functionality is unavailable');
    }
    return service;
}

function requireConfigStorage(service) {
    if (!service) {
        throw new MissingDependencyError('Config storage functionality is unavailable');
    }
    return service;
}

function handleError(c, error, logger) {
    if (error instanceof ServiceError) {
        return c.text(error.message, error.status);
    }
    logger.error?.('Unhandled error', error);
    return c.text(`Error: ${error.message}`, 500);
}
