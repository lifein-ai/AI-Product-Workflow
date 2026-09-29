function createRequestId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `discovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createSubmissionGuard({ log = console.info } = {}) {
  let activeAction = null;

  return {
    begin(kind, detail = {}) {
      if (activeAction) {
        log("Duplicate Request", {
          attempted_kind: kind,
          active_kind: activeAction.kind,
          request_id: activeAction.requestId,
          ...detail
        });
        return null;
      }

      const action = { kind, requestId: createRequestId() };
      activeAction = action;
      log("Initial Request", {
        action_kind: kind,
        request_id: action.requestId,
        ...detail
      });
      return action;
    },

    finish(action) {
      if (activeAction === action) activeAction = null;
    },

    isActive() {
      return activeAction !== null;
    }
  };
}
