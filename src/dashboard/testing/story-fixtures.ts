/**
 * Deterministic fixtures for the story-surface tests (spec §6 / §10, W10–W13).
 *
 * WHY THE CLOCK IS FIXED: elapsed time, staleness and "last change" all render from timestamps,
 * and a test may not assert a value it has to compute at runtime (S-6 shows elapsed; a test that
 * reads `new Date()` has no answer to compare against). `NOW` is a frozen instant and every
 * fixture timestamp is an offset from it, so `formatElapsed(run.started_at, run.ended_at, NOW)`
 * has ONE value a reader can verify by eye.
 *
 * WHAT THE FIXTURE STATE IS (each piece exists to pin one spec rule):
 *   - Story at phase ③, `pending / idea_selection`, both lower locks signed (L-31's precondition).
 *   - Four chapters, one per activity group (decision 0/5): contested (c2), awaiting a fix (c4),
 *     drafting (c3, and with no plotline — C-1), clean (c1).
 *   - Three Ideas open in phase ③ (so the lock gate has a reason, L-7a), one of them a repeat of a
 *     decided Idea (D-32) and one verified (D-27's ordering).
 *   - Two competing drafts on c2 (D-23's gate) plus a Summary unit (U-13's standalone pane), and the
 *     §4.9 verdict rows that judge them — per-draft for one (U-13/D-21), unit-targeted only for the
 *     other, so both the populated and the "no verdicts yet" branch of the pane have real data.
 *   - One live writer run and one torn-down editor run (U-7's row set, S-3's end reason,
 *     U-17's "runs the pause stopped" count).
 *
 * `fixtureActions()` records every call, so a test asserts the EXACT route arguments a click
 * produced (U-16's button, D-35's dial, G-1's ops) rather than "something happened".
 */
import type {
    CastMember,
    Chapter,
    Criterion,
    Finding,
    Idea,
    LedgerEntry,
    Plotline,
    Proposal,
    Revision,
    Run,
    Story,
    Summary,
    Template,
    Verdict
} from '../../types';
import type {
    GoalSurface,
    PhraseFindingRow,
    PhraseGroupRow,
    PhraseGroupScore,
    PhraseRevisionRow,
    PhraseTaskRow,
    PhraseView,
    // R7 — the stub's cleanup answer is a wire value, so the fixture states it as one (see `fixtureActions`).
    SeedCleanupProposal
} from '../api';
// R6 — the five Summary groups come from the catalog module, not from a copy: the rail, the panes and these
// fixtures all read the same product data, so a test cannot pin a group set the server does not send (R1).
// R7 — the stub's `source_hash` is the same 8 hex digits the server journals for these bytes
// (`shared/seed-hash.ts`), so a card that compares a proposal against the draft it was computed over is testing
// its real comparison here rather than one against an invented digest.
import {
    DEFAULT_SUMMARY_CRITICS,
    criterionById,
    fixtureVocabulary,
    orderedPhraseGroupDefinitions,
    seedHashOf
} from './product-values';
import type { CompletionPreview, StoryActions, StoryViewData } from '../components/story-contract';

/** Frozen "now" — every relative figure in the story surface is measured against this instant. */
export const NOW = '2026-11-11T12:00:00.000Z';

/** Minutes before `NOW`, as the ISO string the records store (§4 `created_at`/`updated_at`). */
function ago(minutes: number): string {
    return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

/** The Seed: Author-written, read-only for every agent, every phase (P5). */
export const SEED_IDEA =
    'An archivist in a flooded megacity discovers the cathedral of data her successor sealed, and finds her own voice in the index.';

/** §4.1 — the Story at phase ③, awaiting the Author (L-37a's `awaiting`, not `stalled`). */
export function fixtureStory(editorGroupLocking = false): Story {
    return {
        id: 's1',
        rev: 14,
        created_at: ago(600),
        updated_at: ago(6),
        title: 'Neon Cathedral',
        phase: 'chapters',
        idea: SEED_IDEA,
        summary_locked: true,
        plotlines_locked: true,
        pending_kind: 'idea_selection',
        status: 'pending',
        status_reason: 'The Critic proposed three directions; the Author has not chosen one (D-28).',
        consistency: 'Seed→Summary 2/2 · Summary→Plotlines 6/7 · Plotlines→Chapters 1/3 · Whole Story 0/3',
        trend: 'flat',
        goal_ref: 'g1',
        auto_approve: ['critical', 'major'],
        author_stop: false,
        progress: 'chapters 2 of 4 drafted · 1 hole in act two · 3 setups unpaid',
        blocked_on: 'the Ideas tray (3 open)',
        digest_rev: 7,
        template_refs: ['t-chapters'],
        // L-9: the declared dependency set — what D-37a's recheck walks when the Author edits.
        chapter_deps: { c2: ['c4', 'c5'] },
        // R2 — the Editor-locking Setting. ABSENT IS THE DEFAULT (the flag is additive on `Story`, and
        // `story-contract.isEditorGroupLockingEnabled` reads absence as OFF), so the no-arg fixture keeps
        // sending no key at all; `fixtureStory(true)` is how a test opts the Story INTO the Setting.
        ...(editorGroupLocking ? ({ editor_group_locking: true } as Partial<Story>) : {})
    } as Story;
}

/** §4.2 — the locked Summary (L-30: the only way back in is a backtrack). */
export function fixtureSummary(): Summary {
    return {
        id: 'sum1',
        rev: 9,
        created_at: ago(500),
        updated_at: ago(120),
        story_id: 's1',
        chapter_count: 7,
        premise: 'A flooded city keeps its memory in a sealed cathedral of data.',
        promise: 'The archivist will have to choose between the record and the person she was.',
        theme: 'Memory is a decision, not a store.',
        tone: 'Close third, present tense, spare and technical; no irony.',
        ending: 'She seals the index with her own voice in it.',
        world_rules: 'Data decays unless it is read; the sealed stacks dream.',
        locked: true
    };
}

/**
 * §4.3 — the chapter contracts, side by side with the prose they govern (U-4).
 *
 * R5 (W2) — A CONTRACT IS ITS ORDERED BEATS. C-7 asks whether the prose delivers every beat in the order the
 * contract lists them, and C-3/C-8 ask about the LAST beat, so the list is written as a list here and its last item
 * is the change the chapter owes. The five prose fields stay filled because a real §4.3 row still carries them
 * (`types.ts` documents them deprecated): they are the compatibility mirror `story-contract.plotlineBeatsOf` falls
 * back to when a row has NO `beats`, and a fixture that dropped them could not show that a row carrying BOTH answers
 * from `beats` — the server's own precedence, which this desk mirrors rather than re-decides.
 */
export function fixturePlotlines(): Plotline[] {
    return [
        {
            id: 'p1',
            rev: 4,
            created_at: ago(420),
            updated_at: ago(90),
            story_id: 's1',
            chapter_ref: 'c1',
            order: 1,
            heading: 'The Sealed Stack',
            // The change is the LAST beat, which is what C-3 reads and what the old `must_change` field used to hold
            // as a separate sentence.
            beats: ['She is refused entry and names the refusal.', 'She goes from archivist to trespasser.'],
            must_happen: 'She is refused entry and names the refusal.',
            must_change: 'She goes from archivist to trespasser.',
            pov: 'Hale',
            setups: 'The sealed stack · her own voice in the index',
            payoffs: '—',
            contract_locked: true,
            aligned: true,
            needs_recheck: false
        },
        {
            id: 'p2',
            rev: 3,
            created_at: ago(400),
            updated_at: ago(30),
            story_id: 's1',
            chapter_ref: 'c2',
            order: 2,
            heading: 'Ghost Index',
            beats: ['The index answers in a voice that is not hers.', 'She stops trusting the record.'],
            // R5 — the optional dialogue: the lines this chapter has to land, in order, and the only contract field
            // besides the beats the desk prints.
            dialogue: ['"That is my voice, and it is not in the catalogue."'],
            // C-2: an unaligned plotline is shown as the gap it is, not silently corrected.
            must_happen: 'The index answers in a voice that is not hers.',
            must_change: 'She stops trusting the record.',
            pov: 'Hale',
            setups: 'her own voice in the index',
            payoffs: 'the sealed stack dreams',
            contract_locked: true,
            aligned: false,
            needs_recheck: true
        }
    ];
}

/** §4.4 — sections are the addressable prose (D-7); `origin: 'author'` is the protected span (P9). */
export function fixtureChapters(): Chapter[] {
    return [
        {
            // `clean`: one selected revision, no open approved finding, state `done`.
            id: 'c1',
            rev: 11,
            created_at: ago(390),
            updated_at: ago(70),
            story_id: 's1',
            plotline_ref: 'p1',
            order: 1,
            title: 'The Sealed Stack',
            summary: 'Hale is refused entry and names the refusal.',
            sections: [
                {
                    id: 's1',
                    text: 'The stack door did not open for her badge. Hale read the refusal aloud, to the corridor, as a citation.',
                    origin: 'writer',
                    last_run_ref: 'r-1',
                    last_why: 'C-4: no scene break in the chapter (evidence: ch. 1, ¶1).'
                },
                {
                    id: 's2',
                    text: 'She kept the citation in her coat, against the cold of the index.',
                    origin: 'author'
                }
            ],
            state: 'done',
            current_revision: 'rv-sel-1',
            author_locked: false,
            round: 2,
            last_score: '4/5 criteria passed'
        },
        {
            // `contested`: two competing drafts (D-23) — the unit cannot advance.
            id: 'c2',
            rev: 8,
            created_at: ago(380),
            updated_at: ago(12),
            story_id: 's1',
            plotline_ref: 'p2',
            order: 2,
            title: 'Ghost Index',
            summary: 'The index answers in someone else\u2019s voice.',
            sections: [
                {
                    id: 's3',
                    text: 'The index answered before she touched it, in a voice she had heard read aloud years earlier.',
                    origin: 'writer',
                    last_run_ref: 'r-2',
                    last_why: 'C-8: the chapter must change who speaks.'
                }
            ],
            state: 'in_review',
            author_locked: false,
            // G-1 / §14 item 2: the per-chapter bar, held higher than its neighbours.
            bar_override: 'drop C-12 · +1 soft',
            round: 3,
            last_score: '2/5 criteria passed'
        },
        {
            // `drafting`, and with NO plotline: C-1 fails, so nothing can judge it (P4).
            id: 'c3',
            rev: 3,
            created_at: ago(200),
            updated_at: ago(20),
            story_id: 's1',
            order: 3,
            title: 'The Water Line',
            sections: [
                {
                    id: 's4',
                    text: 'The water line crossed the floor of the reading room at exactly the speed of a decision.',
                    origin: 'writer'
                }
            ],
            state: 'drafting',
            author_locked: false,
            round: 1
        },
        {
            // `awaiting`: the plotline says needs_recheck, and an approved finding is queued work (D-34, L-11a).
            id: 'c4',
            rev: 6,
            created_at: ago(180),
            updated_at: ago(9),
            story_id: 's1',
            order: 4,
            title: 'Act Two, Drowned',
            sections: [
                { id: 's5', text: 'Nine hundred words passed with nothing in them changing.', origin: 'writer' }
            ],
            state: 'needs_recheck',
            author_locked: false,
            round: 2,
            last_score: '1/5 criteria passed'
        }
    ];
}

/** §4.5 — the cast sheet the Characters phrase renders (D-9: `state_now` is a tracked fact). */
export function fixtureCast(): CastMember[] {
    return [
        {
            id: 'cast_member_1',
            rev: 3,
            created_at: ago(420),
            updated_at: ago(90),
            story_id: 's1',
            name: 'Hale',
            want: 'Get inside the sealed stack and read what her successor left.',
            need: 'Admit that she wrote the index herself.',
            arc: 'From archivist to trespasser to author of the record.',
            voice: 'Clipped, technical, cites everything; goes quiet when frightened.',
            state_now: 'Holds the refusal citation; no longer trusts the badge system.',
            traits: 'Patient · exact · allergic to euphemism',
            gender: 'woman'
        },
        {
            id: 'cast_member_2',
            rev: 2,
            created_at: ago(400),
            updated_at: ago(30),
            story_id: 's1',
            name: 'The Curator',
            want: 'Keep the cathedral sealed and the water out.',
            need: 'Be read by someone who remembers the flood.',
            arc: 'From gatekeeper to the first voice inside the index.',
            voice: 'Warm, procedural, never angry.',
            state_now: 'Answers before Hale touches the index.',
            traits: 'Unhurried · institutional',
            gender: 'unknown'
        }
    ];
}

/** §4.6 — the continuity facts the Continuity folder renders (C-5/C-6 are server checks). */
export function fixtureLedger(): LedgerEntry[] {
    return [
        {
            id: 'ledger_1',
            rev: 2,
            created_at: ago(410),
            updated_at: ago(90),
            story_id: 's1',
            kind: 'setup',
            subject: 'the sealed stack',
            detail: 'The closed stack behind the reading room must be entered before chapter 3.',
            chapter_ref: 'c1',
            status: 'open',
            fingerprint: 'fp-ledger-stack'
        },
        {
            id: 'ledger_2',
            rev: 1,
            created_at: ago(200),
            updated_at: ago(30),
            story_id: 's1',
            kind: 'fact',
            subject: 'her own voice in the index',
            detail: 'The index speaks in Hale’s voice before the reader hears her speak aloud.',
            chapter_ref: 'c2',
            status: 'conflict',
            fingerprint: 'fp-ledger-voice'
        }
    ];
}

/**
 * §4.10 — one approved finding (queued Writer work) and one fixed (not open).
 *
 * T3 — the two rows also carry the two CLAIM TYPES, because every surface that reads these rows (the Findings
 * folder, a chapter's rows, the stalled-Story line) has to show the distinction and the folder's closed list is
 * where a resolved Proposal has to be legible as one. `f1` is an Issue: the chapter contradicting the book's own
 * shape is a defect, and an Issue owns `critical`/`major`/`minor` (§4.10's cost ladder). `f2` is a Proposal — a
 * structural change that would improve the opening rather than a commitment the text breaks — and a Proposal owns
 * `major`/`minor`/`taste`, never `critical`, which is why it sits at `minor` here and not on `f1`.
 */
export function fixtureFindings(): Finding[] {
    return [
        {
            id: 'f1',
            rev: 3,
            created_at: ago(60),
            updated_at: ago(8),
            story_id: 's1',
            target_ref: 'c4',
            criterion_ref: 'C-8',
            title: 'Act two changes nothing',
            detail: 'The chapter opens and closes with the same arrangement of facts.',
            evidence: 'ch. 4, ¶2 — 900 words, no reversal, no new knowledge.',
            cost: 'major',
            kind: 'issue',
            fingerprint: 'fp-c4-no-change',
            state: 'approved',
            confirmed_by: 'r-3',
            approved_by: 'auto',
            seen_count: 3,
            related_refs: ['c4']
        },
        {
            id: 'f2',
            rev: 4,
            created_at: ago(150),
            updated_at: ago(75),
            story_id: 's1',
            target_ref: 'c1',
            criterion_ref: 'C-4',
            title: 'No scene break at the door',
            evidence: 'ch. 1, ¶1 — one unbroken block.',
            cost: 'minor',
            kind: 'proposal',
            fingerprint: 'fp-c1-block',
            state: 'fixed',
            confirmed_by: 'r-1',
            approved_by: 'author',
            seen_count: 1
        }
    ];
}

/** §4.17 — the Ideas of the CURRENT phase, plus one from phase ① (D-36: trays are phase-scoped). */
export function fixtureIdeas(): Idea[] {
    const decided: Idea = {
        // D-32: the earlier decision the repeat must be shown WITH.
        id: 'i-old',
        rev: 2,
        created_at: ago(300),
        updated_at: ago(240),
        story_id: 's1',
        phase: 'chapters',
        body: 'Make the curator an early copy of the archivist.',
        kind: 'direction',
        author: 'critic',
        sources: [],
        fingerprint: 'fp-copy',
        seen_count: 1,
        state: 'discarded',
        selection_note: 'Refuted at the phase ② lock — too early to land.'
    };

    return [
        {
            // Verified first (D-27), and the one Idea whose Select fires without a confirm.
            id: 'i-verified',
            rev: 2,
            created_at: ago(40),
            updated_at: ago(10),
            story_id: 's1',
            phase: 'chapters',
            unit_ref: 'c2',
            body: 'Let the archive hum only when she lies.',
            kind: 'possibility',
            author: 'editor',
            sources: [
                {
                    url_or_title: 'City Water Bulletin 14',
                    claim: 'The stacks resonate at 40 Hz when the pumps cycle.',
                    accessed_at: ago(45)
                }
            ],
            fingerprint: 'fp-hum',
            seen_count: 1,
            state: 'verified',
            verification: {
                verdict: 'verified',
                evidence: 'Bulletin 14, p. 3 — the resonance claim is measured, not inferred.',
                meets_guidelines: true,
                checked_by_run: 'r-4',
                checked_at: ago(11)
            }
        },
        {
            // Unverified: selecting it needs the explicit \u201cI know\u201d (D-27), and it repeats a settled Idea (D-32).
            id: 'i-repeat',
            rev: 1,
            created_at: ago(30),
            updated_at: ago(30),
            story_id: 's1',
            phase: 'chapters',
            unit_ref: 'c4',
            body: 'Make the curator an early copy of the archivist.',
            kind: 'direction',
            author: 'critic',
            sources: [],
            fingerprint: 'fp-copy',
            seen_count: 3,
            state: 'proposed',
            verification: {
                verdict: 'unverifiable',
                evidence: 'No record of the curator precedes chapter 3 (C-15).',
                meets_guidelines: false,
                checked_by_run: 'r-4',
                checked_at: ago(25)
            }
        },
        {
            id: 'i-warning',
            rev: 1,
            created_at: ago(18),
            updated_at: ago(18),
            story_id: 's1',
            phase: 'chapters',
            unit_ref: 'c3',
            body: 'Cut the relay scene: it repeats the chapter before it.',
            kind: 'warning',
            author: 'reader',
            sources: [],
            fingerprint: 'fp-relay',
            seen_count: 1,
            state: 'proposed'
        },
        {
            // Phase ①\u2019s tray — must NOT appear while the Story is at phase ③ (D-36).
            id: 'i-phase1',
            rev: 1,
            created_at: ago(480),
            updated_at: ago(480),
            story_id: 's1',
            phase: 'summary',
            body: 'Open the book on the flood, not the archive.',
            kind: 'direction',
            author: 'critic',
            sources: [],
            fingerprint: 'fp-open',
            seen_count: 1,
            state: 'proposed'
        },
        decided,
        {
            // A selected Idea: below the tray, with the note that decided it (D-29).
            id: 'i-selected',
            rev: 3,
            created_at: ago(90),
            updated_at: ago(50),
            story_id: 's1',
            phase: 'chapters',
            body: 'Give Hale the door code nobody issued.',
            kind: 'possibility',
            author: 'critic',
            sources: [],
            fingerprint: 'fp-code',
            seen_count: 2,
            state: 'selected',
            selection_note: 'Taken — becomes the next Writer\u2019s brief (D-29).',
            absorbed_into: 'w-9'
        }
    ];
}

/** §4.15 — the competing drafts (c2), one selected draft (c1), and the Summary unit (U-13). */
export function fixtureRevisions(): Revision[] {
    return [
        {
            id: 'rv-c2-a',
            rev: 1,
            created_at: ago(14),
            updated_at: ago(14),
            story_id: 's1',
            unit_kind: 'chapter',
            unit_ref: 'c2',
            body: [
                {
                    id: 's3',
                    text: 'The index answered before she touched it, in a voice she had heard read aloud years earlier.'
                }
            ],
            run_ref: 'r-5',
            template_ref: 't-chapters',
            state: 'competing',
            verdict_refs: ['v-1', 'v-2']
        },
        {
            id: 'rv-c2-b',
            rev: 1,
            created_at: ago(13),
            updated_at: ago(13),
            story_id: 's1',
            unit_kind: 'chapter',
            unit_ref: 'c2',
            body: 'The index answered in her own voice, and she did not recognise it.',
            run_ref: 'r-6',
            template_ref: 't-chapters',
            state: 'competing',
            verdict_refs: []
        },
        {
            id: 'rv-sel-1',
            rev: 2,
            created_at: ago(80),
            updated_at: ago(70),
            story_id: 's1',
            unit_kind: 'chapter',
            unit_ref: 'c1',
            body: [
                {
                    id: 's1',
                    text: 'The stack door did not open for her badge. Hale read the refusal aloud, to the corridor, as a citation.'
                }
            ],
            run_ref: 'r-1',
            template_ref: 't-chapters',
            state: 'selected',
            verdict_refs: ['v-3'],
            selection_note: 'Chose the citation line: it makes the refusal a fact she can quote (D-24).'
        },
        {
            // The Summary unit: not a chapter, so the standalone comparison pane renders it (U-13).
            id: 'rv-sum-a',
            rev: 1,
            created_at: ago(130),
            updated_at: ago(130),
            story_id: 's1',
            unit_kind: 'summary',
            unit_ref: 'sum1',
            body: {
                premise: 'A flooded city keeps its memory in a sealed cathedral of data.',
                ending: 'She seals the index with her own voice in it.'
            },
            run_ref: 'r-0',
            template_ref: 't-builtin',
            state: 'competing',
            verdict_refs: []
        }
    ];
}

/**
 * §4.9 — the verdict rows behind U-13. D-21's side-by-side panes show what the readers said ABOUT
 * EACH DRAFT, and §6.2a files those against a `revision_N` (v-1, v-2 on rv-c2-a; v-4 on c1's selected
 * draft). v-3 is the UNIT-targeted row that c2's second draft falls back to, so the pane's two
 * branches — "this draft was judged" and "only the unit was" — both have real data. `rv-c2-b`
 * deliberately has no verdict of its own, keeping the fallback next to the populated case.
 */
export function fixtureVerdicts(): Verdict[] {
    return [
        {
            id: 'v-1',
            rev: 1,
            created_at: ago(12),
            updated_at: ago(12),
            story_id: 's1',
            target_ref: 'rv-c2-a',
            target_kind: 'chapter',
            run_ref: 'r-7',
            template_ref: 't-chapters',
            round: 1,
            criteria_passed: [
                { criterion: 'C-7', result: true, evidence: 'the index answers in the chapter' },
                {
                    criterion: 'C-8',
                    result: false,
                    evidence: 'the 1911 survey is named once and never paid off (D-15 evidence)',
                    finding_ref: 'f-2'
                }
            ],
            hard_pass: false,
            soft_count: 1,
            recommendation: 'fix'
        },
        {
            id: 'v-2',
            rev: 1,
            created_at: ago(11),
            updated_at: ago(11),
            story_id: 's1',
            target_ref: 'rv-c2-a',
            target_kind: 'chapter',
            run_ref: 'r-8',
            template_ref: 't-chapters',
            round: 2,
            criteria_passed: [
                { criterion: 'C-7', result: true, evidence: 'the index answers in the chapter' },
                { criterion: 'C-8', result: true, evidence: 'the survey line is answered by the steeple bell' }
            ],
            hard_pass: true,
            soft_count: 2,
            recommendation: 'advance'
        },
        {
            // Unit-targeted: this is what c2's second draft falls back to when it has no verdict of
            // its own (the tool convention §8.3 files, `target_ref` = the unit).
            id: 'v-3',
            rev: 1,
            created_at: ago(10),
            updated_at: ago(10),
            story_id: 's1',
            target_ref: 'c2',
            target_kind: 'chapter',
            run_ref: 'r-9',
            template_ref: 't-chapters',
            round: 1,
            criteria_passed: [
                { criterion: 'C-9', result: false, evidence: 'the chapter ends before its contract pays off' }
            ],
            hard_pass: false,
            soft_count: 0,
            recommendation: 'fix'
        },
        {
            // The selected draft of c1 carries its OWN verdict — a unit that has already been through the
            // loop still shows the judgement that stands against the prose that survived (D-22: the note
            // and the verdicts outlive the drafts that lost to it).
            id: 'v-4',
            rev: 1,
            created_at: ago(70),
            updated_at: ago(70),
            story_id: 's1',
            target_ref: 'rv-sel-1',
            target_kind: 'chapter',
            run_ref: 'r-1',
            template_ref: 't-chapters',
            round: 1,
            criteria_passed: [{ criterion: 'C-7', result: true, evidence: 'the citation line delivers the refusal' }],
            hard_pass: true,
            soft_count: 2,
            recommendation: 'advance'
        }
    ];
}

/** §4.16 — one pending proposal against c2's section, one already decided (U-5's filter). */
export function fixtureProposals(): Proposal[] {
    return [
        {
            id: 'pr-1',
            rev: 1,
            created_at: ago(12),
            updated_at: ago(12),
            story_id: 's1',
            target_ref: 's3',
            target_field: 'sections[].text',
            patch: {
                section_id: 's3',
                text: 'The index answered before she touched it, in a voice she had heard read aloud — and it was hers.'
            },
            why: 'C-8: the chapter must change who speaks, and it does not yet (D-20).',
            run_ref: 'r-2',
            state: 'pending'
        },
        {
            // Decided already, and against another chapter: ProseEditor must not list it (U-5).
            id: 'pr-2',
            rev: 2,
            created_at: ago(70),
            updated_at: ago(65),
            story_id: 's1',
            target_ref: 's1',
            target_field: 'sections[].text',
            patch: { section_id: 's1', text: 'The stack door did not open for her badge, so she cited the corridor.' },
            why: 'C-4: a scene break the reviewer can see.',
            run_ref: 'r-1',
            state: 'accepted'
        }
    ];
}

/** §4.13 — one live writer run, one torn-down editor run (the pause's own count). */
export function fixtureRuns(): Run[] {
    return [
        {
            id: 'r-5',
            rev: 1,
            created_at: ago(3),
            updated_at: ago(1),
            story_id: 's1',
            work_item_ref: 'w-9',
            template_ref: 't-chapters',
            role: 'writer',
            state: 'working',
            // 2m30s before `NOW` — so the row's elapsed figure is exactly `2m 30s`.
            started_at: '2026-11-11T11:57:30.000Z',
            ended_at: null,
            tokens: 1234,
            kind: 'work',
            // D-38: three writer agents inside ONE run, and the panel disagreed (U-8d's marker).
            delegated: [
                {
                    role: 'reader',
                    task: 'check C-8 against the plotline',
                    summary: '1 of 3 preferred the earlier cut — dissent recorded in the selection note.',
                    tokens: 300
                }
            ]
        },
        {
            id: 'r-2',
            rev: 2,
            created_at: ago(35),
            updated_at: ago(30),
            story_id: 's1',
            work_item_ref: 'w-7',
            template_ref: 't-builtin',
            role: 'editor',
            state: 'torn_down',
            started_at: '2026-11-11T11:30:00.000Z',
            ended_at: '2026-11-11T11:34:20.000Z',
            tokens: 900,
            kind: 'work',
            // S-3 records WHY: this is the row U-17's banner counts as stopped by the pause.
            end_reason: 'killed by author stop (D-37)',
            delegated: []
        }
    ];
}

/**
 * §16.1 job 5 — the deep-review Run rows a settled phase-① round leaves behind for its winner: one row
 * per pass, keyed the way the ledger mints the claim (`records.ts:deepReviewKeyOf` /
 * `story-contract.ts:deepReviewKeyOf` = `wi_review_<revisionId>_a<pass>`).
 *
 * WHY A FIXTURE NEEDS TO SHOW THESE (T11/F1): `StoryView.runs` is a REQUIRED, uncapped slice
 * (`api.ts:StoryView`, `server/api/projections.ts` sends every run row of the Story), so a phase-①
 * baseline that carries no `wi_review_` row is not a clean Story — it is a revision nobody has read, and
 * `deepReviewProgress` owes all `summary_critics` passes for it. A test that wants "the review is done"
 * has to say so with these rows; only an explicitly legacy payload may omit the slice.
 */
export function fixtureReviewRuns(
    revisionId: string,
    passes = DEFAULT_SUMMARY_CRITICS,
    state: Run['state'] = 'torn_down'
): Run[] {
    return Array.from({ length: passes }, (_, index) => {
        const pass = index + 1;

        return {
            id: `r-review-${revisionId}-a${pass}`,
            rev: 1,
            created_at: ago(40),
            updated_at: ago(35),
            story_id: 's1',
            work_item_ref: `wi_review_${revisionId}_a${pass}`,
            template_ref: 't-builtin',
            role: 'critic',
            state,
            started_at: ago(40),
            ended_at: state === 'working' ? null : ago(35),
            tokens: 800,
            kind: 'work',
            delegated: []
        } satisfies Run;
    });
}

/** §4.12 — the catalogue: one Author crew (assignable, editable), one built-in (duplicate-only). */
export function fixtureTemplates(): Template[] {
    return [
        {
            id: 't-chapters',
            rev: 3,
            created_at: ago(500),
            updated_at: ago(20),
            name: 'chapters',
            title: 'Chapter crew',
            description: 'The crew that writes and judges chapters.',
            roles: [
                {
                    name: 'writer',
                    kind: 'writer',
                    prompt: 'Write the chapter to the plotline contract.',
                    model: 'local-large',
                    agents: 3,
                    aggregate: 'merge'
                },
                { name: 'editor', kind: 'editor', prompt: 'Select one draft and write the selection note.', agents: 1 },
                {
                    name: 'critic',
                    kind: 'critic',
                    prompt: 'Read for the Goal criteria.',
                    web: true,
                    agents: 2,
                    aggregate: 'majority'
                }
            ],
            serves_phase: ['chapters'],
            done_definition: 'every criterion the plotline names is answerable from the prose',
            selection_rules: 'Prefers the draft that changes who speaks; refuses a draft that only reads better.',
            attempts: 2,
            escalation_rule: 'two flat rounds on the same criterion (L-18)',
            builtin: false,
            editable: true
        },
        {
            id: 't-builtin',
            rev: 1,
            created_at: ago(900),
            updated_at: ago(900),
            name: 'core-critic',
            title: 'Core critic (built-in)',
            roles: [{ name: 'critic', kind: 'critic', prompt: 'Judge the artifact against the Goal.' }],
            serves_phase: ['summary'],
            done_definition: 'a verdict per criterion',
            attempts: 1,
            builtin: true,
            editable: false
        }
    ];
}

/** The Goal's criterion list, cloned from the built-in roster (G-1: the Author edits their own copy). */
function goalCriteria(): Criterion[] {
    const ids = ['C-7', 'C-8', 'C-9', 'C-10', 'C-11', 'C-13', 'C-12', 'C-0', 'C-14'];
    return ids
        .map((id) => criterionById(id))
        .filter((criterion): criterion is Criterion => criterion !== undefined)
        .map((criterion) => ({ ...criterion }));
}

/** The Goal surface exactly as `getStory` returns it (G-2's strings are printed verbatim). */
export function fixtureGoal(): GoalSurface {
    return {
        goal: {
            id: 'g1',
            rev: 5,
            created_at: ago(600),
            updated_at: ago(40),
            story_id: 's1',
            title: 'Consistent at every level, and written like mine',
            threshold_soft: 3,
            criteria: goalCriteria(),
            flat_rounds: 3,
            regress_tolerance: 2
        },
        phase_progress: '4/7 \u00b7 failing: C-8, C-11',
        failing: [
            {
                criterion: 'C-8',
                fix_hint: 'Change who speaks by the end of chapter 2 (C-8).',
                evidence: 'ch. 2, \u00b61 — the index answers, and she is unchanged by it.'
            },
            {
                criterion: 'C-11',
                fix_hint: 'Pay the promise the Summary makes, in act two (C-11).',
                evidence: 'ch. 4 — the promise is unmentioned after chapter 3.'
            }
        ],
        chapter_progress: {
            c1: '4/5 criteria passed',
            c2: '2/5 criteria passed',
            c4: '1/5 criteria passed'
        }
    };
}

/** Decision 17 — the cost block, with the downgrade count that makes the pattern visible. */
export function fixtureCostDistribution() {
    return {
        confirmed_per_cost: { critical: 0, major: 4, minor: 9, taste: 12 },
        downgrades: 11
    };
}

/** §6.9 — the completion preview with L-25b's exact numbers. */
export function fixtureCompletion(): CompletionPreview {
    return { open_findings: 47, open_ideas: 12, oldest: 'chapter 2' };
}

/**
 * The whole `getStory` payload the panels render. `completion_preview` is `null` by default
 * (the panel must be absent, not empty), and `fixtureCompletion()` supplies it when a test needs it.
 */
/**
 * R6 — the `GET /stories/:id/phrases` read, built from `shared/phrase`'s OWN catalog so the five groups, their
 * titles, their descriptions and their composition order cannot drift from the product data (and so a test can
 * assert that World rules is NOT one of the five — R1).
 *
 * The default state is a grouped book mid-review, chosen so the group surface's whole range is on screen at once
 * without a test assembling rows itself:
 *
 *   - Premise  — written twice, clean, with TWO superseded rows (so `2 archived` is a count a reader can check).
 *   - Promise  — open findings: one CRITICAL it shares with Theme (the cross-group chip) and one MINOR alone.
 *   - Theme    — `writer_busy`: the Writer is replacing its text now, and the revise control must shut (R4/F8).
 *   - Tone     — written, and the target of the finding the Reviewer never scoped to a group (`unscoped`), which
 *                by R3's rule therefore stands against ALL FIVE groups (the U5 case a flat list hides).
 *   - Ending   — `revision: 0`: never written, so the pane shows its purposeful empty state and the Overview
 *                reports one of five unwritten (R1/U4).
 *   - Findings — the three open rows above PLUS one `fixed` row against Premise, which must appear NOWHERE:
 *                a fixed finding is archived out of every active list (U5).
 *   - Scores   — T3: two passes over the four WRITTEN groups, newest first, one vector per pass (`vh-2` then
 *                `vh-3`, the current hash matching `review.vector_hash`). Premise 78→84 and Promise 55→62 are
 *                the improvements, Tone 64→58 is the rewrite that went backwards, Theme has a single pass (so
 *                no delta), and Ending carries no `scores` KEY because it has no text — which is also why this
 *                book's rail header prints no overall average (one unscored group silences it; the average is
 *                pinned on `testing/shell-fakes.tsx:groupedPhraseView`, where all five are scored).
 *   - Kinds    — T3: `f-cross` is an explicit Issue, `f-minor` an explicit Proposal (it asks for a word change,
 *                not for a repair), and `f-wide`/`f-fixed` carry NO kind at all — the legacy rows every findings
 *                surface has to read as an Issue.
 *
 * The ids are readable (`grp-premise`, `f-cross`) rather than random. That is deliberate: the dashboard addresses
 * a group by its id STRING, so a readable id asserts the same contract a uuid does — and every ref in a test
 * (`summary-group:grp-premise`) stays readable (U2).
 */
export function fixturePhrase(overrides: Partial<PhraseView> = {}): PhraseView {
    const definitions = orderedPhraseGroupDefinitions();
    const group = (key: string, row: Partial<PhraseGroupRow>): PhraseGroupRow => {
        const definition = definitions.find((candidate) => candidate.key === key);

        return {
            id: `grp-${key}`,
            key,
            title: definition?.title ?? key,
            description: definition?.description ?? `The ${key} group of the Summary.`,
            order: definition?.order ?? 0,
            content: '',
            revision: 0,
            updated_by: null,
            previous_content: '',
            history: [],
            owed_by_findings: [],
            writer_busy: false,
            ...row
        };
    };

    /** One revision-history row: metadata and `chars`, because the projection sends no archived prose (R2). */
    const revision = (key: string, number: number, state: string, chars: number): PhraseRevisionRow => ({
        id: `rev-${key}-${number}`,
        number,
        state,
        at: ago(30 - number * 5),
        run_ref: `run_${key}_${number}`,
        finding_refs: [],
        task_refs: [],
        chars
    });

    /**
     * T3 — one scoring pass over ONE group, in the shape the projection sends (`api.ts:PhraseGroupScore`).
     *
     * `hash` is the pass's text vector, and it is the reason the fixture passes them out in pairs: a single
     * Critic pass scores ALL FIVE groups with the same `vector_hash`, `at` and `run_ref`, so a test may not
     * invent a per-group pass — and a group's `scores` list is newest first, exactly like `history`. `value`
     * is the 0–100 percentage the rail prints; `phraseScorePercent` is what turns it into the number.
     */
    const score = (value: number, hash: string, at: string, rationale?: string): PhraseGroupScore => ({
        value,
        vector_hash: hash,
        at,
        run_ref: `run_critic_${hash}`,
        ...(rationale === undefined ? {} : { rationale })
    });

    const allIds = definitions.map((definition) => `grp-${definition.key}`);

    const groups: PhraseGroupRow[] = [
        group('premise', {
            content: 'A keeper of a lighthouse begins lying to the sea, and the sea believes her.',
            revision: 3,
            updated_by: 'writer',
            // The revision immediately before the latest, verbatim — the one body the wire sends so the pane
            // can diff `begins` against the `starts` it replaced.
            previous_content: 'A keeper of a lighthouse starts lying to the sea, and the sea believes her.',
            // Newest first, `latest` INCLUDED (R2) — the pane counts the archived rows and never opens them.
            history: [
                revision('premise', 3, 'latest', 74),
                revision('premise', 2, 'archived', 75),
                revision('premise', 1, 'archived', 40)
            ],
            // T3 — two passes, the newer one against the vector the review is on (`vh-3`, the same hash in
            // `review` below), the older one before the rewrite that fixed the set-up. 78 → 84 is the rail's
            // "this group is converging" case, and the rationale is the Critic's own sentence for the number.
            scores: [
                score(84, 'vh-3', ago(10), 'the lie is set up in the first sentence and paid for in the last'),
                score(78, 'vh-2', ago(90))
            ]
        }),
        group('promise', {
            content: 'The reader is promised that the lie will cost her the light itself.',
            revision: 2,
            updated_by: 'writer',
            // Only the latest-vs-previous body; the older archived text stays off the wire.
            previous_content: 'The reader is warned the lie will cost her the light itself.',
            history: [revision('promise', 2, 'latest', 68), revision('promise', 1, 'archived', 60)],
            // T3 — up 7. No rationale on either pass: the pane prints the number and the movement, and prints
            // NOTHING where the Critic wrote no sentence.
            scores: [score(62, 'vh-3', ago(10)), score(55, 'vh-2', ago(90))]
        }),
        group('theme', {
            content: 'What the book is about: the price of a story told to keep the dark out.',
            revision: 1,
            updated_by: 'writer',
            history: [revision('theme', 1, 'latest', 66)],
            // T3 — ONE pass, so there is no previous percentage and the pane prints no delta line. The Writer
            // holds this group right now, which is exactly the state where a second number would be a lie: the
            // text the next pass scores does not exist yet.
            scores: [score(71, 'vh-3', ago(10))],
            // R4/F8: the same read the revise route 409s on, so a disabled control cannot disagree with the wire.
            writer_busy: true,
            // R3: the finding this group's NEXT text has to answer.
            owed_by_findings: ['f-cross']
        }),
        group('tone', {
            content: 'Plain sentences, salt in every image, and no authorial wink.',
            revision: 1,
            updated_by: 'writer',
            history: [revision('tone', 1, 'latest', 47)],
            // T3 — the REGRESSION case, and it is a real one rather than a made-up number: the vh-2 pass scored
            // the mirrored text (see `review.mirror` below, in sync and holding `tone`), the group's first own
            // revision replaced it, and the vh-3 pass that scored THAT text rates it six points worse. The pane's
            // `down 6` sentence and the rail's tooltip are the only places the desk admits a rewrite went wrong.
            scores: [
                score(58, 'vh-3', ago(10), 'two authorial winks survive in the middle paragraph'),
                score(64, 'vh-2', ago(90))
            ]
        }),
        group('ending', {
            // R1: `revision: 0` IS "never written" — the empty state's authority, not a missing field.
            content: '',
            revision: 0,
            // T3 — NO `scores` key at all, and it stays that way on purpose: an unscored group must render
            // nothing on the rail and no score block in its pane, and one unscored group is what keeps this
            // book's phrase header from printing an overall average (the all-or-nothing rule in
            // `story-contract.ts:phraseOverallScore`). The header's number is pinned on the clean five-group
            // view in `testing/shell-fakes.tsx:groupedPhraseView`.
            history: []
        })
    ];

    const findings: PhraseFindingRow[] = [
        {
            id: 'f-cross',
            title: 'the promise names a cost the premise never sets up',
            cost: 'critical',
            // T3 — an Issue, and the cost proves it: `critical` is the ladder's word for a contradiction the
            // text cannot live with, which is a claim no Proposal is ever allowed to make (§4.10).
            kind: 'issue',
            state: 'confirmed',
            seen_count: 3,
            group_refs: ['grp-promise', 'grp-theme'],
            unscoped: false,
            targeted: ['grp-promise', 'grp-theme'],
            resolved: ['grp-promise'],
            // R3: Theme's text has not answered it yet, which is the fact the chip beside the finding states.
            missing: ['grp-theme'],
            resolved_all: false
        },
        {
            id: 'f-wide',
            // A legacy row that named NO group: `unscoped` is spelled out by the projection so a pane never
            // infers it from an empty array, and R3 resolves it against every group of this Story.
            title: 'the Overview never says who the keeper is lying for',
            cost: 'major',
            // T3 — and deliberately NO `kind` key: this is the row raised before the field existed, the case
            // every findings surface must render as an Issue rather than blank, `—` or a crash.
            state: 'unconfirmed',
            seen_count: 1,
            group_refs: [],
            unscoped: true,
            targeted: [...allIds],
            resolved: [],
            missing: [...allIds],
            resolved_all: false
        },
        {
            id: 'f-minor',
            // A note, not a blocker: it costs the group an `open`, never a `blocking` (U4's badges).
            title: 'the promise restates the premise in other words',
            cost: 'minor',
            // T3 — the PROPOSAL of the set, and the fixture's comment already gives it away: the Critic is not
            // claiming a contradiction, it is asking for the repetition to go. A word-change claim is exactly
            // what `proposal` exists for (§4.10), it owns `minor` on the cost ladder, and the group pane's row
            // has to say so in front of the cost — otherwise the Author reads three blockers and one preference
            // in the same voice and approves all four.
            kind: 'proposal',
            state: 'approved',
            seen_count: 1,
            group_refs: ['grp-promise'],
            unscoped: false,
            targeted: ['grp-promise'],
            resolved: [],
            missing: ['grp-promise'],
            resolved_all: false
        },
        {
            id: 'f-fixed',
            // Archived out: a `fixed` row is in no active list, so it must appear in NO pane and NO badge (U5).
            title: 'the lighthouse was a different colour in the first draft',
            cost: 'major',
            state: 'fixed',
            seen_count: 2,
            group_refs: ['grp-premise'],
            unscoped: false,
            targeted: ['grp-premise'],
            resolved: ['grp-premise'],
            missing: [],
            resolved_all: true
        }
    ];

    const tasks: PhraseTaskRow[] = [
        { id: 't-theme', title: 'rewrite Theme to answer the promise it borrows', state: 'claimed', owner_role: 'writer', attempts: 1, finding_ref: 'f-cross' },
        { id: 't-ending', title: 'write the Ending group', state: 'open', owner_role: 'writer', attempts: 0, finding_ref: null },
        { id: 't-tone', title: 'set the tone the premise implies', state: 'done', owner_role: 'writer', attempts: 1, finding_ref: null }
    ];

    const open = findings.filter((finding) => ['unconfirmed', 'confirmed', 'approved'].includes(finding.state));
    const blocking = open.filter((finding) => finding.cost === 'critical' || finding.cost === 'major');

    return {
        story_id: 's1',
        mode: 'groups',
        phrase_id: 'ph-1',
        revision: 3,
        overview: groups
            .filter((row) => row.content.length > 0)
            .map((row) => row.content)
            .join('\n\n'),
        groups,
        findings,
        tasks,
        review: {
            mode: 'groups',
            // CATALOG KEYS, not ids (R1) — the panes convert them to titles for the Author (U6).
            unwritten_groups: ['ending'],
            written_groups: groups.filter((row) => row.revision > 0).length,
            vector: Object.fromEntries(groups.map((row) => [row.id, row.revision])),
            vector_hash: 'vh-3',
            review_seats: 3,
            reviews_on_current_vector: 3,
            deep_reviews_on_current_vector: 1,
            open_findings: open.length,
            blocking_findings: blocking.length,
            open_tasks: tasks.filter((task) => task.state !== 'done').length,
            mirror: { summary_id: 'sum-1', in_sync: true, locked: false, fields: ['premise', 'promise', 'theme', 'tone'] }
        },
        // D-67 — the reviewed block for the mid-review book, and it is `pending` because the book IS: Ending
        // has no text at all, and every group is named by an unresolved ISSUE row (the critical `f-cross` on
        // promise/theme, and the unscoped `f-wide` major, which R3 resolves against ALL FIVE groups), so no
        // group is selectable and the selection is partial.
        //
        // WHY NO SCORES HERE EITHER. The reviewed scores join on `reviewed.vector_hash`, and a PARTIAL
        // selection has a hash no Reader row carries (the seat only ever claims a complete one) — so the strip
        // prints selections and gaps and no numbers. The LIVE rows keep their D-65 trend rows (`vh-2`/`vh-3`),
        // which is what the group pane and the rail read; the two lists are different reads of different text,
        // and the Summary tab is not allowed to confuse them.
        reviewed: {
            state: 'pending',
            complete: false,
            // A partial selection still names the groups it HAS — this one has none.
            vector: {},
            vector_hash: 'vh-partial',
            overview: '',
            groups: groups.map((row) => ({
                id: row.id,
                key: row.key,
                selected_revision: null,
                selected_id: null,
                clean_run_ref: null,
                latest_revision: row.revision,
                superseded: false,
                // Every group of this book is inside an open issue's scope: `f-wide` is UNSCOPED, which R3
                // resolves to the whole Overview, so it names all five.
                issues_open: true,
                gap: row.revision === 0 ? 'unwritten' : 'no_clean_revision',
                scores: []
            })),
            chosen: null,
            stale: false,
            // The two ISSUE rows, with the catalog KEYS each one scopes to (`f-minor` is a proposal and
            // `f-fixed` is archived, so neither holds a clean verdict back).
            blocking_issues: [
                { id: 'f-cross', title: 'the promise names a cost the premise never sets up', cost: 'critical', group_keys: ['promise', 'theme'] },
                { id: 'f-wide', title: 'the Overview never says who the keeper is lying for', cost: 'major', group_keys: definitions.map((definition) => definition.key) }
            ],
            // Theme is mid-rewrite (`writer_busy`), which is the state the choose refuses on.
            writer_busy: true
        },
        ...overrides
    };
}

/**
 * The whole view the story panes render. `phrase` opts the book INTO the group workspace: the phrase read and
 * `story.summary_mode` are one fact on the wire (`projections.ts` echoes the mode), so passing rows without the
 * mode would render a pane the server can never produce.
 */
export function fixtureView(
    options: {
        completion?: CompletionPreview | null;
        phrase?: PhraseView;
        /** R2 — opts the Story into the Editor-locking Setting (see `fixtureStory`). */
        editorGroupLocking?: boolean;
    } = {},
): StoryViewData {
    const base = fixtureViewBase(options);

    if (options.phrase === undefined) {
        return base;
    }

    return { ...base, story: { ...base.story, summary_mode: 'groups' }, phrase: options.phrase };
}

function fixtureViewBase(
    options: { completion?: CompletionPreview | null; editorGroupLocking?: boolean } = {},
): StoryViewData {
    return {
        story: fixtureStory(options.editorGroupLocking === true),
        summary: fixtureSummary(),
        plotlines: fixturePlotlines(),
        chapters: fixtureChapters(),
        cast: fixtureCast(),
        ledger: fixtureLedger(),
        goal: fixtureGoal(),
        ideas: fixtureIdeas(),
        revisions: fixtureRevisions(),
        // U-13 / §6.2a: the drafts' verdicts ride with the view so the comparison pane can show the
        // judgement per draft instead of a bare ref list.
        verdicts: fixtureVerdicts(),
        findings: fixtureFindings(),
        proposals: fixtureProposals(),
        runs: fixtureRuns(),
        // The shell resolves the assignment ids into records (see `StoryViewData`).
        templates: fixtureTemplates().filter((template) => template.id === 't-chapters'),
        cost_distribution: fixtureCostDistribution(),
        vocabulary: fixtureVocabulary(),
        completion_preview: options.completion ?? null,
        // U-1a: the stalled screen's "what the crews tried" list. Two rounds, oldest first, and the
        // second one's numbers are deliberately the SAME as the first — that flat pair is what makes
        // the stall, so the fixture shows the case the pane exists for.
        level_history: [
            {
                round: 6,
                at: ago(90),
                phase: 'chapters',
                levels: { summary: '4/4', plotlines: '6/6', chapters: '4/6', whole: '2/5' },
                fingerprint_closed: ['fp-c4-no-change'],
                fingerprint_reopened: [],
                findings_confirmed_new: ['fp-c2-voice'],
                flat_streak: 0,
                trend: 'improving',
                runs_closed: 11
            },
            {
                round: 7,
                at: ago(30),
                phase: 'chapters',
                levels: { summary: '4/4', plotlines: '6/6', chapters: '4/6', whole: '2/5' },
                fingerprint_closed: [],
                fingerprint_reopened: ['fp-c4-no-change'],
                findings_confirmed_new: [],
                flat_streak: 2,
                trend: 'flat',
                runs_closed: 13
            }
        ],
        digest: {
            id: 'd-7',
            rev: 7,
            created_at: ago(20),
            updated_at: ago(20),
            story_id: 's1',
            body: 'Derived from the Summary at rev 9 and the plotlines at rev 3. Nothing has contradicted them.',
            stale: false,
            current: true,
            journal_seq: 41
        }
    };
}

/**
 * Recording action stub: every key of `StoryActions` exists, and `calls` holds the exact argument
 * list of every call, in call order. Tests assert `calls.backtrack` deep-equals
 * `[['s1', 'summary']]` — the route arguments the click produced, not a boolean.
 */
export function fixtureActions() {
    const calls: Record<string, unknown[][]> = {};
    const record =
        (name: string) =>
        (...args: unknown[]): void => {
            (calls[name] ??= []).push(args);
        };

    const actions: Required<StoryActions> = {
        stop: record('stop'),
        resume: record('resume'),
        lockPhase: record('lockPhase'),
        backtrack: record('backtrack'),
        editSection: record('editSection'),
        unapproveChapter: record('unapproveChapter'),
        // U-10b — the chapter-scale approval (the server approves each finding as its own commit).
        approveChapterFindings: record('approveChapterFindings'),
        acceptProposal: record('acceptProposal'),
        rejectProposal: record('rejectProposal'),
        undo: record('undo'),
        selectIdea: record('selectIdea'),
        discardIdea: record('discardIdea'),
        deferIdea: record('deferIdea'),
        acceptCompletion: record('acceptCompletion'),
        patchGoal: record('patchGoal'),
        setChapterBar: record('setChapterBar'),
        setAutoApprove: record('setAutoApprove'),
        setSummaryReview: record('setSummaryReview'),
        requestSummaryRevision: record('requestSummaryRevision'),
        assignTemplates: record('assignTemplates'),
        createTemplate: record('createTemplate'),
        patchTemplate: record('patchTemplate'),
        killRun: record('killRun'),
        requestAssistant: record('requestAssistant'),
        selectRevision: record('selectRevision'),
        // U-13a — the merge request the Author raises from the comparison pane (D-23).
        mergeRevisions: record('mergeRevisions'),
        // L-23 — the stalled screen's directive exit (U-1a).
        sendDirective: record('sendDirective'),
        // R6 / R2 — the Author's rewrite of ONE Summary group. Recorded like every other verb, so a test asserts
        // the exact `(storyId, groupId, {content, note})` the pane's Send produced — the UUID, never an index.
        revisePhraseGroup: record('revisePhraseGroup'),
        // D-68 — the whole-Summary choose. It is on the stub for the same reason every verb is: a pane's
        // click has to land in `calls` so the test asserts the ARGUMENTS (`[['s1']]`), not a boolean.
        chooseReviewedSummary: record('chooseReviewedSummary'),
        // R1 — the group lock verbs, recorded for the same reason: the pane's confirm click has to produce
        // `calls.lockPhraseGroup === [['s1', 'grp-premise']]`, which is the UUID-addressed route call the
        // server actually takes. `setEditorGroupLocking` is the Author's Setting write, and the pair
        // `(storyId, enabled)` is what the Settings switch has to send.
        lockPhraseGroup: record('lockPhraseGroup'),
        unlockPhraseGroup: record('unlockPhraseGroup'),
        setEditorGroupLocking: record('setEditorGroupLocking'),
        // T-W4 — Phrase ②'s three verbs, recorded for the same reason: a test asserts the exact arguments the
        // control produced (`setPlotlinesMode: [['s1','groups']]`, `startPhrase: [['s1','plotlines',{source:'compiled'}]]`,
        // `revisePhraseEntry: [['s1','grp-chapter-1',{plotpoints:{…}}]]`) rather than a "was called" boolean.
        setPlotlinesMode: record('setPlotlinesMode'),
        startPhrase: record('startPhrase'),
        revisePhraseEntry: record('revisePhraseEntry'),
        // R7 — the Seed proofread, on the stub for the same reason every verb is: a click on "Ask the Editor to
        // proofread this" has to land in `calls` with the exact `(storyId, key, seed)` the card sent, because the
        // draft riding in the query IS the claim under test. Unlike the others it also has to RESOLVE — the card
        // renders its proposal area from the returned value. The default answer is the neutral one, "nothing to
        // fix": it cannot invent a rewrite nobody asked for, and `changed:false` leaves the Author's text as the
        // one the next Start press would copy. A test that wants a proposal, a guard refusal, or a route failure
        // replaces this member with its own function.
        requestSeedCleanup: async (storyId: string, phraseKey: string, seed: string): Promise<SeedCleanupProposal> => {
            (calls.requestSeedCleanup ??= []).push([storyId, phraseKey, seed]);

            return { ok: true, source_hash: seedHashOf(seed), text: seed, changed: false };
        }
    };

    return { actions, calls };
}
