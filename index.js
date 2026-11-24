import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createMoraleEngine } from './host/morale.js';

const localRequire = createRequire(import.meta.url);
const hostRoot = process.env.DSH_INSTALL_DIR
  ?? (process.resourcesPath && join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
function loadSchemastery() {
  try {
    return hostRoot
      ? createRequire(join(hostRoot, 'package.json'))('@deepseek-ai/schemastery')
      : localRequire('@deepseek-ai/schemastery');
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND' || !String(err.message).includes('@deepseek-ai/schemastery')) {
      throw err;
    }
    const chain = () => ({ default: chain, min: chain, max: chain, volatile: chain });
    return { object: chain, string: chain, number: chain, boolean: chain, array: chain, dict: chain, union: chain, const: chain };
  }
}
const schemastery = loadSchemastery();
const z = schemastery.default ?? schemastery;

const ROUTE = '/crew-morale/state';

const pack = z.object({
  commandName: z.string().default('rum'),
  commandDescription: z.dict(z.string()).default({}),
  protestPhrases: z.dict(z.array(z.string())).default({}),
  retryPhrases: z.dict(z.array(z.string())).default({}),
  failedPhrases: z.dict(z.array(z.string())).default({}),
  cancelledPhrases: z.dict(z.array(z.string())).default({}),
  rumPhrases: z.dict(z.array(z.string())).default({}),
  confetti: z.object({
    colors: z.array(z.string()).default([]),
    particleCount: z.number().default(90),
    spread: z.number().default(75),
  }).default({}),
});

export const Config = z.object({
  initial: z.number().min(0).default(100).volatile(),
  retryDelta: z.number().default(-4).volatile(),
  failedDelta: z.number().default(-12).volatile(),
  cancelledDelta: z.number().default(-3).volatile(),
  lowThreshold: z.number().min(0).default(30).volatile(),
  rumTarget: z.number().min(0).default(100).volatile(),
  pack: z.union([z.const(false), pack]).default(false).volatile(),
});

const unwrap = (field) => (field && typeof field.get === 'function' ? field.get() : field);
const primarySubtag = (lang) => String(lang ?? '').split(/[-_]/)[0].toLowerCase();

export function pickLocalized(map, preference) {
  if (!map || typeof map !== 'object') return '';
  if (preference && typeof map[preference] === 'string' && map[preference].trim()) {
    return map[preference].trim();
  }
  const want = primarySubtag(preference);
  if (want) {
    for (const [id, text] of Object.entries(map)) {
      if (primarySubtag(id) === want && typeof text === 'string' && text.trim()) {
        return text.trim();
      }
    }
  }
  if (typeof map.en === 'string' && map.en.trim()) return map.en.trim();
  for (const [id, text] of Object.entries(map)) {
    if (primarySubtag(id) === 'en' && typeof text === 'string' && text.trim()) {
      return text.trim();
    }
  }
  for (const text of Object.values(map)) {
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

function readService(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(key);
    if (ctx?.reflect && typeof ctx.reflect.get === 'function') return ctx.reflect.get(key);
  } catch {}
  return undefined;
}

function readSettingsDoc(ctx, ns) {
  try {
    const entries = readService(ctx, 'settings')?.describe?.() ?? [];
    return entries.find((entry) => String(entry?.ns) === ns)?.value;
  } catch {
    return undefined;
  }
}

export function apply(ctx, config = {}) {
  ctx.inject(['settings'], (scope) => scope.effect(
    () => scope.settings.configure({ auto: false }, ctx.fiber),
  ));

  const engine = createMoraleEngine({
    initial: unwrap(config.initial),
    retryDelta: unwrap(config.retryDelta),
    failedDelta: unwrap(config.failedDelta),
    cancelledDelta: unwrap(config.cancelledDelta),
    lowThreshold: unwrap(config.lowThreshold),
    rumTarget: unwrap(config.rumTarget),
  });

  const syncConfig = () => {
    const saved = readSettingsDoc(ctx, 'dsh-crew-morale') || readSettingsDoc(ctx, 'crew-morale');
    engine.setConfig({
      initial: saved?.initial ?? unwrap(config.initial),
      retryDelta: saved?.retryDelta ?? unwrap(config.retryDelta),
      failedDelta: saved?.failedDelta ?? unwrap(config.failedDelta),
      cancelledDelta: saved?.cancelledDelta ?? unwrap(config.cancelledDelta),
      lowThreshold: saved?.lowThreshold ?? unwrap(config.lowThreshold),
      rumTarget: saved?.rumTarget ?? unwrap(config.rumTarget),
    });
  };

  ctx.effect(() => {
    const offVolatile = ctx.on?.('loader/volatile-update', syncConfig);
    const offDoc = ctx.on?.('settings/document-updated', (ns) => {
      if (String(ns) === 'dsh-crew-morale' || String(ns) === 'crew-morale') syncConfig();
    });
    syncConfig();
    return () => {
      try { offVolatile?.(); } catch {}
      try { offDoc?.(); } catch {}
    };
  }, 'dsh-crew-morale: config sync');

  let lastPolledSessionId = null;

  ctx.inject(['commands'], (scope) => scope.effect(() => {
    let unregister = null;
    let currentCmd = '';
    let currentDesc = '';

    const installCommand = () => {
      const saved = readSettingsDoc(scope, 'dsh-crew-morale') || readSettingsDoc(scope, 'crew-morale');
      const currentPack = saved?.pack !== undefined ? saved.pack : unwrap(config.pack);
      if (!currentPack || typeof currentPack !== 'object') {
        if (unregister) {
          try { unregister(); } catch {}
          unregister = null;
          currentCmd = '';
          currentDesc = '';
        }
        return;
      }
      const cmdName = typeof currentPack.commandName === 'string' && currentPack.commandName.trim()
        ? currentPack.commandName.trim()
        : 'rum';
      const preference = readSettingsDoc(scope, 'locale')?.preference;
      const desc = pickLocalized(currentPack.commandDescription, preference);
      if (cmdName === currentCmd && desc === currentDesc && unregister) return;
      if (unregister) {
        try { unregister(); } catch {}
        unregister = null;
      }
      currentCmd = cmdName;
      currentDesc = desc;
      const handler = async (commandCtx) => {
        const sid = commandCtx?.sessionId
          || commandCtx?.session?.id
          || commandCtx?.agent?.session?.id
          || commandCtx?.agent?.sessionId
          || lastPolledSessionId
          || null;
        const live = sid ? readService(scope, 'sessions')?.get?.(sid) : null;
        if (live) engine.foldSession(sid, live);
        engine.triggerRum(sid);
        return { kind: 'success' };
      };
      try {
        unregister = scope.commands.register({
          name: cmdName,
          description: desc,
          recordInput: false,
          handler,
        });
      } catch (error) {
        console.warn('[dsh-crew-morale] command registration failed:', error);
      }
    };

    const offVolatile = scope.on?.('loader/volatile-update', installCommand);
    const offDoc = scope.on?.('settings/document-updated', (ns) => {
      const id = String(ns);
      if (id === 'dsh-crew-morale' || id === 'crew-morale' || id === 'locale') installCommand();
    });
    installCommand();

    return () => {
      try { offVolatile?.(); } catch {}
      try { offDoc?.(); } catch {}
      try { unregister?.(); } catch {}
    };
  }, 'dsh-crew-morale: /rum command'));

  ctx.inject(['webServer'], (scope) => scope.effect(() => {
    return scope.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'x-content-type-options': 'nosniff' });
          res.end();
          return;
        }
        let url;
        try {
          url = new URL(req.url ?? ROUTE, 'http://dsh.local');
        } catch {
          res.writeHead(400, { 'x-content-type-options': 'nosniff' });
          res.end();
          return;
        }
        if (url.pathname !== ROUTE) {
          res.writeHead(404, { 'x-content-type-options': 'nosniff' });
          res.end();
          return;
        }
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId) lastPolledSessionId = sessionId;
        const since = url.searchParams.get('since') ?? '0';
        const live = sessionId ? readService(scope, 'sessions')?.get?.(sessionId) : null;
        const payload = engine.readState(sessionId, live, since);
        const body = Buffer.from(JSON.stringify(payload));
        res.writeHead(200, {
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          'content-length': String(body.byteLength),
          'content-type': 'application/json; charset=utf-8',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      },
    });
  }, 'dsh-crew-morale: state route'));
}
