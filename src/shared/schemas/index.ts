// Barrel for the structured-output contracts (documents/phase-1-research-pipeline.md §4.3).
//
// Both schemas are plain data plus their TS mirrors; nothing here imports a library, so the
// dashboard and the server can consume the same contract without dragging runtime code along.
export * from './summary-sample';
export * from './issue-list';
// SUMMARY PHRASE: the group Writer's answer and the group review's answer. Both are consumed by
// `WorkItem.responseSchema` exactly as the two above are, and both are additive — the legacy
// contracts stay for a `'sampling'` Story's existing run rows.
export * from './group-draft';
export * from './group-review';
// READER SCORING (D-65): the five-section score answer. Same no-tool contract shape as the two
// above, and consumed by `WorkItem.responseSchema` for the `score_sections` job.
export * from './section-scores';
// PHRASE GROUP LOCK (R-lock, `Story.editor_group_locking`): the Editor's per-group lock judgement.
// Same no-tool contract shape again, and the only structured answer whose product is a flag on an
// existing row (the `phrase_groups` lock) rather than a row of its own.
export * from './group-lock';
// PHRASE ② PLOTLINES: the chapter-entry Writer's answer. Same no-tool contract shape as the four
// above, and the one contract whose answer fields map field-for-field onto an existing §4 record
// (`plotlines`), which is what makes the chapter install a mirror write rather than a translation.
export * from './chapter-draft';
