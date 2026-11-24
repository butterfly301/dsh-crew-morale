window.__ModuleLoader__.load({
  id: 'dsh-crew-morale',
  factory() {
    const NS = 'dsh-crew-morale';
    const STATE_ROUTE = '/crew-morale/state';
    const OVERRIDE_EVENT = 'dsh:status-text:override';
    const CONFETTI_EVENT = 'dsh:confetti';
    const POLL_MS = 900;

    function dispatchCustom(type, detail) {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
        return;
      }
      window.dispatchEvent(new CustomEvent(type, { detail }));
    }

    function pickRandomPhrase(localizedMap, activeLang) {
      if (!localizedMap || typeof localizedMap !== 'object') return undefined;
      const primary = String(activeLang ?? '').split(/[-_]/)[0].toLowerCase();
      let list = activeLang && localizedMap[activeLang];
      if (!Array.isArray(list) && primary) {
        for (const [id, candidate] of Object.entries(localizedMap)) {
          if (String(id).split(/[-_]/)[0].toLowerCase() === primary) {
            list = candidate;
            break;
          }
        }
      }
      if (!Array.isArray(list)) {
        if (Array.isArray(localizedMap.en) && localizedMap.en.length > 0) {
          list = localizedMap.en;
        } else {
          for (const [id, candidate] of Object.entries(localizedMap)) {
            if (String(id).split(/[-_]/)[0].toLowerCase() === 'en' && Array.isArray(candidate) && candidate.length > 0) {
              list = candidate;
              break;
            }
          }
        }
      }
      if (!Array.isArray(list)) list = Object.values(localizedMap).find((v) => Array.isArray(v) && v.length > 0);
      if (!Array.isArray(list) || list.length === 0) return undefined;
      return list[Math.floor(Math.random() * list.length)];
    }

    function readSelectedSessionId(sessions) {
      try {
        const byId = sessions?.list?.getSnapshot?.()?.byId;
        if (!byId || typeof byId !== 'object') return null;
        const selected = Object.values(byId).filter((s) => s && s.retainedBy?.mainView > 0);
        return selected.length === 1 ? selected[0].id : null;
      } catch {
        return null;
      }
    }

    return {
      inject: ['configForms', 'locale'],
      apply(ctx) {
        return ctx.effect(() => {
          const form = ctx.configForms.get(NS);
          let currentPack = null;
          let activeSessionId = null;
          let confettiCursor = null;
          let lastNoticeId = 0;
          let activeProtestSession = null;
          let disposed = false;

          const clearOverrides = (sessionId) => {
            if (!sessionId) return;
            dispatchCustom(OVERRIDE_EVENT, { source: 'crew-morale-protest', sessionId, clear: true });
            dispatchCustom(OVERRIDE_EVENT, { source: 'crew-morale-notice', sessionId, clear: true });
          };

          const syncConfig = () => {
            const { status, value } = form.getSnapshot();
            if (status === 'loading') return;
            const prevPack = currentPack;
            const nextPack = status === 'ready' && value?.pack && typeof value.pack === 'object'
              ? value.pack
              : null;
            if (!nextPack && activeProtestSession) {
              clearOverrides(activeProtestSession);
              activeProtestSession = null;
            }
            currentPack = nextPack;
            if (nextPack && !prevPack) poll();
          };

          const applyServerState = (payload) => {
            if (!payload || payload.ok !== true) return;
            if (confettiCursor === null) {
              confettiCursor = typeof payload.confettiCursor === 'number' ? payload.confettiCursor : 0;
            } else {
              if (typeof payload.confettiCursor === 'number') confettiCursor = payload.confettiCursor;
              if (Array.isArray(payload.confettiEvents)) {
                for (const evt of payload.confettiEvents) {
                  if (evt && currentPack) {
                    dispatchCustom(CONFETTI_EVENT, currentPack.confetti || {});
                  }
                }
              }
            }

            if (!currentPack) return;
            const sid = payload.sessionId || activeSessionId;
            if (!sid) return;

            if (payload.lowMorale) {
              activeProtestSession = sid;
              dispatchCustom(OVERRIDE_EVENT, {
                source: 'crew-morale-protest',
                sessionId: sid,
                priority: 20,
                ttlMs: 0,
                interleaveEvery: 2,
                text: currentPack.protestPhrases || {},
              });
            } else if (activeProtestSession === sid) {
              activeProtestSession = null;
              dispatchCustom(OVERRIDE_EVENT, { source: 'crew-morale-protest', sessionId: sid, clear: true });
            }

            if (payload.notice && payload.notice.id !== lastNoticeId) {
              lastNoticeId = payload.notice.id;
              const noticeMap = payload.notice.kind === 'retry'
                ? currentPack.retryPhrases
                : payload.notice.kind === 'failed'
                  ? currentPack.failedPhrases
                  : payload.notice.kind === 'cancelled'
                    ? currentPack.cancelledPhrases
                    : payload.notice.kind === 'rum'
                      ? currentPack.rumPhrases
                      : null;
              const picked = pickRandomPhrase(noticeMap, ctx.locale?.getSnapshot?.()?.active);
              if (picked || noticeMap) {
                dispatchCustom(OVERRIDE_EVENT, {
                  source: 'crew-morale-notice',
                  sessionId: sid,
                  priority: 30,
                  ttlMs: 5000,
                  text: picked || noticeMap,
                });
              }
            }
          };

          const poll = () => {
            if (disposed || !currentPack || typeof fetch !== 'function') return;
            const params = new URLSearchParams();
            if (activeSessionId) params.set('sessionId', activeSessionId);
            params.set('since', confettiCursor === null ? '999999999' : String(confettiCursor));
            fetch(`${STATE_ROUTE}?${params.toString()}`, { cache: 'no-store' })
              .then((res) => (res && res.ok ? res.json() : null))
              .then((payload) => {
                if (!disposed && payload) applyServerState(payload);
              })
              .catch(() => {});
          };

          let stopSessions;
          if (typeof ctx.inject === 'function') {
            stopSessions = ctx.inject(['sessions'], (scope) => scope.effect(() => {
              const list = scope.sessions?.list;
              if (!list || typeof list.subscribe !== 'function') return undefined;
              const update = () => {
                const next = readSelectedSessionId(scope.sessions);
                if (next !== activeSessionId) {
                  if (activeProtestSession && activeProtestSession !== next) {
                    clearOverrides(activeProtestSession);
                    activeProtestSession = null;
                  }
                  activeSessionId = next;
                  poll();
                }
              };
              const unsub = list.subscribe(update);
              update();
              return () => { try { unsub?.(); } catch {} };
            }, 'dsh-crew-morale: active session'));
          }

          const unsubForm = form.subscribe(syncConfig);
          syncConfig();
          poll();
          const timer = setInterval(poll, POLL_MS);

          return () => {
            disposed = true;
            clearInterval(timer);
            try { stopSessions?.(); } catch {}
            try { unsubForm(); } catch {}
            if (activeProtestSession) clearOverrides(activeProtestSession);
          };
        }, 'dsh-crew-morale: morale tracker');
      },
    };
  },
});
