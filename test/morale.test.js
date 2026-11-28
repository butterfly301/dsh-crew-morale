import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createMoraleEngine } from '../host/morale.js';
import { apply as applyHost, pickLocalized } from '../index.js';

const CLIENT_CODE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function makeSession(events) {
  return {
    inheritedEventCount: 0,
    get seq() { return events.length; },
    eventAt: (i) => events[i],
  };
}

test('morale isolates per session, deducts on retry/fail/cancel, and surfaces pending end notices on next turn', () => {
  const engine = createMoraleEngine({
    initial: 100,
    retryDelta: -4,
    failedDelta: -12,
    cancelledDelta: -3,
    lowThreshold: 30,
    rumTarget: 100,
  });

  const s1Events = [
    { type: 'turn/start', time: 1000 },
    { type: 'llm/retry-started', time: 2000 },
  ];
  const s1 = makeSession(s1Events);
  const st1 = engine.readState('s1', s1, 0, 2500);
  assert.equal(engine.snapshotScore('s1'), 96);
  assert.equal(st1.notice?.kind, 'retry');
  assert.equal(st1.lowMorale, false);

  // s2 stays isolated at initial 100
  const s2 = makeSession([{ type: 'turn/start', time: 2600 }]);
  engine.readState('s2', s2, 0, 2700);
  assert.equal(engine.snapshotScore('s2'), 100);

  // Fail s1 repeatedly until below lowThreshold (< 30)
  for (let i = 0; i < 6; i += 1) {
    s1Events.push({ type: 'turn/end', time: 3000 + i * 10, data: { reason: { kind: 'error' } } });
  }
  const afterFail = engine.readState('s1', s1, 0, 8000);
  // 96 - 72 = 24 < 30
  assert.equal(engine.snapshotScore('s1'), 24);
  assert.equal(afterFail.lowMorale, true);
  // End notice stays silent while idle until next turn/start
  assert.equal(afterFail.notice, null);

  // Next turn/start surfaces pending failed notice
  s1Events.push({ type: 'turn/start', time: 9000 });
  const nextTurn = engine.readState('s1', s1, 0, 9100);
  assert.equal(nextTurn.notice?.kind, 'failed');

  // Cancelled deducts -3 and does not throw
  s1Events.push({ type: 'turn/end', time: 10_000, data: { reason: { kind: 'aborted' } } });
  engine.readState('s1', s1, 0, 10_100);
  assert.equal(engine.snapshotScore('s1'), 21);
});

test('/rum restores morale to target without cooldown and emits confetti every time', () => {
  const engine = createMoraleEngine();
  const s1Events = [
    { type: 'turn/start', time: 1000 },
    { type: 'turn/end', time: 2000, data: { reason: { kind: 'error' } } },
  ];
  const s1 = makeSession(s1Events);
  engine.readState('s1', s1, 0, 2100);
  assert.equal(engine.snapshotScore('s1'), 88);

  // Idle /rum emits confetti without leaving stale status notice
  engine.triggerRum('s1', 3000);
  const afterIdleRum = engine.readState('s1', s1, 0, 3050);
  assert.equal(engine.snapshotScore('s1'), 100);
  assert.equal(afterIdleRum.confettiEvents.length, 1);
  assert.equal(afterIdleRum.notice, null);

  // Repeated /rum while task running emits confetti every time + 5s notice
  s1Events.push({ type: 'turn/start', time: 4000 });
  engine.readState('s1', s1, afterIdleRum.confettiCursor, 4050);
  engine.triggerRum('s1', 4100);
  engine.triggerRum('s1', 4200);
  const afterRunningRum = engine.readState('s1', s1, afterIdleRum.confettiCursor, 4250);
  assert.equal(afterRunningRum.confettiEvents.length, 2);
  assert.equal(afterRunningRum.notice?.kind, 'rum');
});

test('host pickLocalized prefers exact -> primary -> en -> first, and updates /rum description on locale change', () => {
  const map = {
    'de-pirate': 'Rum!',
    'en-pirate': 'Pour rum!',
    'zh-pirate': '倒朗姆酒！',
  };
  assert.equal(pickLocalized(map, 'zh-pirate'), '倒朗姆酒！');
  assert.equal(pickLocalized(map, 'zh-CN'), '倒朗姆酒！');
  assert.equal(pickLocalized(map, 'ko'), 'Pour rum!');
  assert.equal(pickLocalized(map, undefined), 'Pour rum!');

  const registered = [];
  const listeners = new Map();
  let pref = 'zh-pirate';
  const ctx = {
    fiber: {},
    get(key) { return this[key]; },
    settings: {
      configure() {},
      describe: () => [
        { ns: 'locale', value: { preference: pref } },
        { ns: 'dsh-crew-morale', value: { pack: { commandName: 'rum', commandDescription: map } } },
      ],
    },
    commands: {
      register(cmd) {
        registered.push(cmd);
        return () => {};
      },
    },
    webServer: { register: () => () => {} },
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt)?.delete(fn);
    },
    effect(fn) { return fn(); },
    inject(deps, fn) {
      if (deps.includes('commands') || deps.includes('settings')) return fn(ctx);
      return () => {};
    },
  };
  applyHost(ctx, {});
  assert.equal(registered.at(-1).description, '倒朗姆酒！');

  pref = 'fr';
  for (const fn of listeners.get('settings/document-updated') || []) fn('locale');
  assert.equal(registered.at(-1).description, 'Pour rum!');
});

test('client transitions from loading to ready, dispatches localized notices with en fallback, and clears protest on session switch', async () => {
  const dispatched = [];
  let loadedMod = null;
  let formSnap = { status: 'loading', value: undefined };
  const formSubs = new Set();
  const sessionSubs = new Set();
  let activeSession = 's1';
  let activeLocale = 'zh-pirate';
  const polledSince = [];
  let pollFn = null;
  let serverResponse = { ok: true, sessionId: 's1', lowMorale: false, turnOpen: false, notice: null, confettiCursor: 0, confettiEvents: [] };

  const sandbox = {
    window: {
      __ModuleLoader__: { load(m) { loadedMod = m; } },
      dispatchEvent(evt) { dispatched.push(evt); },
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    URLSearchParams,
    fetch: async (url) => {
      polledSince.push(String(url));
      return { ok: true, json: async () => serverResponse };
    },
    setInterval(fn) { pollFn = fn; return 1; },
    clearInterval() {},
    console,
  };
  vm.runInNewContext(CLIENT_CODE, sandbox);

  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: { [activeSession]: { id: activeSession, retainedBy: { mainView: 1 } } },
      }),
      subscribe: (fn) => { sessionSubs.add(fn); return () => sessionSubs.delete(fn); },
    },
  };

  const ctx = {
    locale: { getSnapshot: () => ({ active: activeLocale }) },
    sessions,
    configForms: {
      get: (ns) => ({
        getSnapshot: () => (ns === 'dsh-crew-morale' ? formSnap : { status: 'unavailable', value: undefined }),
        subscribe: (fn) => { formSubs.add(fn); return () => formSubs.delete(fn); },
      }),
    },
    effect: (fn) => fn(),
    inject: (deps, fn) => (deps.includes('sessions') ? fn(ctx) : () => {}),
  };

  const cleanup = loadedMod.factory().apply(ctx);

  // Initial loading state does not poll
  assert.equal(polledSince.length, 0);

  // Transition dsh-crew-morale form to ready -> primes cursor immediately
  formSnap = {
    status: 'ready',
    value: {
      pack: {
        confetti: { colors: ['#fff'], particleCount: 50, spread: 70 },
        protestPhrases: { 'de-pirate': ['DE protest'], 'en-pirate': ['EN protest'], 'zh-pirate': ['ZH protest'] },
        rumPhrases: { 'de-pirate': ['DE rum'], 'en-pirate': ['EN rum'], 'zh-pirate': ['干杯'] },
      },
    },
  };
  for (const fn of formSubs) fn();
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  assert.equal(polledSince.length, 1);
  assert.equal(dispatched.length, 0);

  // Unknown locale falls back to en-pirate (NOT de-pirate), and lowMorale sets protest override
  activeLocale = 'ko';
  serverResponse = {
    ok: true,
    sessionId: 's1',
    lowMorale: true,
    turnOpen: true,
    notice: { id: 1, kind: 'rum' },
    confettiCursor: 1,
    confettiEvents: [{ id: 1 }],
  };
  pollFn?.();
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  assert.equal(dispatched.filter((e) => e.type === 'dsh:confetti').length, 1);
  const noticeEvt = dispatched.find((e) => e.type === 'dsh:status-text:override' && e.detail.source === 'crew-morale-notice');
  assert.equal(noticeEvt?.detail?.text, 'EN rum');

  // Switching to s2 clears s1 protest overrides immediately
  activeSession = 's2';
  for (const fn of sessionSubs) fn();
  const clearedS1 = dispatched.filter((e) => e.type === 'dsh:status-text:override' && e.detail.sessionId === 's1' && e.detail.clear === true);
  assert.ok(clearedS1.length >= 2);

  cleanup?.();
});

test('historical end notices do not surface when an old session is opened', () => {
  const engine = createMoraleEngine({
    initial: 100,
    retryDelta: -4,
    failedDelta: -12,
    cancelledDelta: -3,
    lowThreshold: 30,
    rumTarget: 100,
  });
  const session = makeSession([
    { type: 'turn/start', time: 1000 },
    { type: 'turn/end', time: 2000, data: { reason: { kind: 'error' } } },
    { type: 'turn/start', time: 3000 },
  ]);
  const state = engine.readState('old', session, 0, 100000);
  assert.equal(state.notice, null);
  assert.equal(engine.snapshotScore('old'), 88);
});

test('live session events update existing entries without refolding history', () => {
  const engine = createMoraleEngine({
    initial: 100,
    retryDelta: -4,
    failedDelta: -12,
    cancelledDelta: -3,
    lowThreshold: 30,
    rumTarget: 100,
  });
  engine.readState('s', makeSession([{ type: 'turn/start', time: 1000 }]), 0, 2000);
  engine.applyEvent('s', { type: 'turn/end', data: { reason: { kind: 'error' } }, time: 3000 }, 3000);
  assert.equal(engine.snapshotScore('s'), 88);
  engine.applyEvent('s', { type: 'turn/start', time: 4000 }, 4000);
  const state = engine.readState('s', null, 0, 4500);
  assert.equal(state.notice?.kind, 'failed');
});
