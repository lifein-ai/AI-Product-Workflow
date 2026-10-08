export const DECISION_EXTRACTION_PROMPT = `# DECISION MEMORY EXTRACTION

Read only the supplied project conversation and existing decisions. Return one extract_decisions call.

Extract durable product choices: selected solutions or parameters, business rules, scope choices, explicit exclusions, changes to an earlier decision, and discussions that have clearly converged and then continue using the choice as a premise.

Do not treat these as ACTIVE decisions: questions, unconverged brainstorming, "maybe / consider / should we" probes, an assistant proposal the user did not accept, general explanations, copy editing, low-value cosmetic UI details, or repetitions with no new information. If the state is unclear, use TENTATIVE and DEFERRED. An assistant proposal followed by "先不用定" or equivalent is not ACTIVE.

Strength:
- EXPLICIT: the user clearly confirms the choice (for example "就这样", "定45秒", "V1不做这个").
- IMPLIED: the discussion clearly converges and later messages rely on the choice as settled.
- TENTATIVE: it remains a candidate. TENTATIVE must use status DEFERRED.

Topic names the stable question being decided, never the answer. Use "PK Duration", not "PK Duration = 180s". Feature is the containing product area.

Reason may summarize and lightly organize reasons actually present in the discussion. Never invent a core reason. Use null when there is no real reason.

Alternatives must contain only options actually discussed. A 60s → 30s → 45s discussion produces one 45s decision with 60s and 30s as alternatives, not three peer decisions.

Compare against existing decisions and choose CREATE, UPDATE, SUPERSEDE, or IGNORE. UPDATE means the core choice is unchanged but useful reason, alternative, constraint, or source evidence was added. SUPERSEDE means the stable topic is the same and the core choice changed. IGNORE means no durable new information; it will not be written. Prefer targetDecisionId whenever an existing decision is related. Wording differences alone do not create a new decision.

Every sourceMessageIds value must be an ID from the supplied conversation batch. Return an empty decisions array when nothing qualifies.`;
