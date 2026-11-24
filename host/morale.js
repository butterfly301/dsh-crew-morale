const DEFAULT_CONFIG = Object.freeze({
  initial: 100,
  retryDelta: -4,
  failedDelta: -12,
  cancelledDelta: -3,
  lowThreshold: 30,
  rumTarget: 100,
});

const NOTICE_TTL_MS = 5000;
const MAX_SESSIONS = 256;

export function normalizeMoraleConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (val, fallback) => (typeof val === 'number' && Number.isFinite(val) ? Math.trunc(val) : fallback);
  return {
    initial: Math.max(0, num(src.initial, DEFAULT_CONFIG.initial)),
    retryDelta: num(src.retryDelta, DEFAULT_CONFIG.retryDelta),
    failedDelta: num(src.failedDelta, DEFAULT_CONFIG.failedDelta),
    cancelledDelta: num(src.cancelledDelta, DEFAULT_CONFIG.cancelledDelta),
    lowThreshold: Math.max(0, num(src.lowThreshold, DEFAULT_CONFIG.lowThreshold)),
    rumTarget: Math.max(0, num(src.rumTarget, DEFAULT_CONFIG.rumTarget)),
  };
}

function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function eventAtOf(session, seq) {
  if (typeof session?.eventAt === 'function') return session.eventAt(seq);
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents(seq, seq + 1)[0];
  return undefined;
}

export function createMoraleEngine(initialConfig = {}) {
  let cfg = normalizeMoraleConfig(initialConfig);
  const sessions = new Map();
  let noticeSeq = 1;
  let confettiSeq = 1;
  const confettiQueue = [];

  function setConfig(next) {
    cfg = normalizeMoraleConfig(next);
  }

  function ensureEntry(sessionId) {
    let entry = sessions.get(sessionId);
    if (!entry) {
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        sessions.delete(oldest);
      }
      entry = {
        score: cfg.initial,
        inheritedEventCount: 0,
        foldedThrough: -1,
        turnOpen: false,
        pendingNotice: null,
        activeNotice: null,
      };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  function clampScore(score) {
    return Math.max(0, score);
  }

  function foldSession(sessionId, session, now = Date.now()) {
    if (!sessionId || !session) return null;
    const entry = ensureEntry(sessionId);
    const inherited = countOf(session.inheritedEventCount);
    const end = countOf(session.seq);

    if (
      entry.inheritedEventCount !== inherited
      || entry.foldedThrough >= end
      || entry.foldedThrough < inherited - 1
    ) {
      entry.inheritedEventCount = inherited;
      entry.foldedThrough = inherited - 1;
      entry.score = cfg.initial;
      entry.turnOpen = false;
      entry.pendingNotice = null;
      entry.activeNotice = null;
    }

    for (let seq = entry.foldedThrough + 1; seq < end; seq += 1) {
      const event = eventAtOf(session, seq);
      if (!event) continue;
      const type = event.type;
      const at = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : now;

      if (type === 'turn/start') {
        entry.turnOpen = true;
        if (entry.pendingNotice) {
          entry.activeNotice = {
            id: noticeSeq++,
            kind: entry.pendingNotice.kind,
            at: now,
            expiresAt: now + NOTICE_TTL_MS,
          };
          entry.pendingNotice = null;
        }
      } else if (type === 'llm/retry-started') {
        entry.score = clampScore(entry.score + cfg.retryDelta);
        entry.activeNotice = {
          id: noticeSeq++,
          kind: 'retry',
          at,
          expiresAt: now + NOTICE_TTL_MS,
        };
      } else if (type === 'turn/end') {
        entry.turnOpen = false;
        const kind = event.data?.reason?.kind;
        if (kind === 'error' || kind === 'max-tokens') {
          entry.score = clampScore(entry.score + cfg.failedDelta);
          entry.pendingNotice = { kind: 'failed' };
        } else if (kind === 'aborted' || kind === 'interrupted') {
          entry.score = clampScore(entry.score + cfg.cancelledDelta);
          entry.pendingNotice = { kind: 'cancelled' };
        }
      }
      entry.foldedThrough = seq;
    }
    return entry;
  }

  function triggerRum(sessionId = null, now = Date.now()) {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : '__global__';
    const entry = ensureEntry(id);
    entry.score = cfg.rumTarget;
    entry.pendingNotice = null;
    if (entry.turnOpen) {
      entry.activeNotice = {
        id: noticeSeq++,
        kind: 'rum',
        at: now,
        expiresAt: now + NOTICE_TTL_MS,
      };
    }
    confettiQueue.push({
      id: confettiSeq++,
      sessionId: id,
      at: now,
    });
    if (confettiQueue.length > 64) confettiQueue.shift();
    return entry;
  }

  function readState(sessionId, session = null, sinceConfettiId = 0, now = Date.now()) {
    let entry = null;
    if (sessionId) {
      entry = session ? foldSession(sessionId, session, now) : ensureEntry(sessionId);
    }
    if (entry?.activeNotice && entry.activeNotice.expiresAt <= now) {
      entry.activeNotice = null;
    }
    const floor = Number.isFinite(Number(sinceConfettiId)) ? Math.trunc(Number(sinceConfettiId)) : 0;
    const confettiEvents = confettiQueue.filter((evt) => evt.id > floor);

    return {
      ok: true,
      sessionId: sessionId || null,
      lowMorale: entry ? entry.score < cfg.lowThreshold : false,
      turnOpen: entry ? entry.turnOpen : false,
      notice: entry?.activeNotice
        ? { id: entry.activeNotice.id, kind: entry.activeNotice.kind }
        : null,
      confettiCursor: confettiSeq - 1,
      confettiEvents,
    };
  }

  function snapshotScore(sessionId) {
    return sessions.get(sessionId)?.score ?? cfg.initial;
  }

  return {
    setConfig,
    foldSession,
    triggerRum,
    readState,
    snapshotScore,
  };
}
