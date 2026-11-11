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
import { criterionById } from '../../shared/criteria';
import type {
    Chapter,
    Criterion,
    Finding,
    Idea,
    Plotline,
    Proposal,
    Revision,
    Run,
    Story,
    Summary,
    Template,
    Verdict
} from '../../shared/types';
import type { GoalSurface } from '../api';
import type { CompletionPreview, StoryActions, StoryViewData } from './story-contract';

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
export function fixtureStory(): Story {
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
        status_reason: 'The Reader proposed three directions; the Author has not chosen one (D-28).',
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
        chapter_deps: { c2: ['c4', 'c5'] }
    };
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

/** §4.3 — the chapter contracts, side by side with the prose they govern (U-4). */
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
            must_happen: 'The index answers in a voice that is not hers.',
            // C-2: an unaligned plotline is shown as the gap it is, not silently corrected.
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

/** §4.10 — one approved finding (queued Writer work) and one fixed (not open). */
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
        author: 'reader',
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
            author: 'reader',
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
            author: 'checker',
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
            author: 'reader',
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
            author: 'reader',
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
 * §4.9 — the verdict rows behind U-13. D-21's side-by-side panes show what the checkers said ABOUT
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
                    role: 'checker',
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
                    name: 'reader',
                    kind: 'reader',
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
            name: 'core-reader',
            title: 'Core reader (built-in)',
            roles: [{ name: 'reader', kind: 'reader', prompt: 'Judge the artifact against the Goal.' }],
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
export function fixtureView(options: { completion?: CompletionPreview | null } = {}): StoryViewData {
    return {
        story: fixtureStory(),
        summary: fixtureSummary(),
        plotlines: fixturePlotlines(),
        chapters: fixtureChapters(),
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
        assignTemplates: record('assignTemplates'),
        createTemplate: record('createTemplate'),
        patchTemplate: record('patchTemplate'),
        killRun: record('killRun'),
        requestAssistant: record('requestAssistant'),
        selectRevision: record('selectRevision'),
        // U-13a — the merge request the Author raises from the comparison pane (D-23).
        mergeRevisions: record('mergeRevisions'),
        // L-23 — the stalled screen's directive exit (U-1a).
        sendDirective: record('sendDirective')
    };

    return { actions, calls };
}
