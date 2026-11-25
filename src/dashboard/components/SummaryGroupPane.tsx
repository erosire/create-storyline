// R6 / U4 — ONE SUMMARY GROUP's pane: what it is for, what the Writer has written, what the Reviewer left open.
//
// WHY THIS FILE IS A THIN WRAPPER SINCE T-W4. The pane's implementation is the PHRASE-GENERIC entry pane in
// `PhraseEntries.tsx`: the Summary's five groups and Phrase ②'s chapter entries are the same wire shape
// (`PhraseGroupRow`, its revisions, its findings, its lock, the Author's one hand write), so one component renders
// both and the two phrases cannot drift apart on a lock badge or a `writer_busy` refusal. What this file keeps is
// the phrase's own answer to two questions the shared pane asks it: WHICH phrase am I (`SUMMARY_SURFACE` — the
// wording and the `data-testid` namespace Phrase ① has always used), and WHAT is a group's text (prose, so the
// write is `{content, note}` — a chapter entry's text is composed from contract fields, and that editor lives on
// the Plotlines side of the same component).
//
// WHAT THIS PANE EXISTS AT ALL (U4). U1's rail puts a button per group in front of the Author, and a button that
// opens nothing is chrome. This is the pane those buttons open: the group's own text, its revision number, and the
// findings the Reviewer aims at it — which had no address anywhere in the workspace before, the defect that made a
// grouped book unreadable in the desk. The five groups share one compiled Overview, so this pane shows what makes
// THIS group different (its purpose line, its findings, its history) and leaves the shared text to the Summary
// overview pane.
//
// THE RULES ARE THE CONTRACT'S, NOT THIS FILE'S. Identity is the group's UUID (U2), a finding's scope is
// `targeted` with an unscoped legacy row meaning every group (U5), history is metadata plus the ONE archived body
// the wire sends for the diff (U3), a locked group is settled content that refuses a revise (R1), and a disabled
// control states the wire's own reason (U-16). Every one of those reads is a `story-contract` selector, called by
// the shared pane, so the rail's mark, this pane's badge and the lock buttons are four readings of one rule.
import { PhraseEntryDetail, SUMMARY_SURFACE } from './PhraseEntries';
import type { StoryActions, StoryViewData } from './story-contract';
import type { StorySelection } from './story-nav';

export interface SummaryGroupPaneProps {
    view: StoryViewData;
    /** The pinned action surface; every method is optional, and an absent one says so on the control. */
    actions?: StoryActions;
    /** The group the rail's selection addresses — its UUID, never its index or `order` (U2). */
    groupId?: string;
    onSelect?: (selection: StorySelection) => void;
}

/**
 * Phrase ①'s entry pane. `editor:'content'` is the Summary's half of the one real difference between the two
 * phrases: a group's text is prose the Author can rewrite, so the write is `{content, note}` and the route installs
 * it as the group's next revision (R2).
 */
export function SummaryGroupPane({ view, actions = {}, groupId, onSelect }: SummaryGroupPaneProps) {
    return (
        <PhraseEntryDetail
            view={view}
            surface={SUMMARY_SURFACE}
            actions={actions}
            entryId={groupId}
            editor="content"
            onSelect={onSelect}
        />
    );
}

export default SummaryGroupPane;
