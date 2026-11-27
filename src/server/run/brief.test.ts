// W5 acceptance for the brief (S-2, E-1, E-3, D-13, D-21, D-29, G-4, §4.13 `brief_hash`).
//
// Every assertion is an EXACT value, because the brief is an audit artifact: `runs.brief_hash`
// records what a run was told, and D-12a's "any past Digest is reconstructible" only holds if this
// text is a pure function of stored state. Fuzzy assertions here would hide the two failure modes
// the design actually has — a section silently missing (D-13: the run goes and reads the book), and
// a section whose wording moves between assemblies (which makes `brief_hash` useless as a key).
import { readFileSync } from 'node:fs';

import { Store, type Attribution } from '../store';
// D-33c: the live open-issue count in a Critic brief is the loop's OWN predicate, so the assertions
// that pin that count are built from it rather than from a number typed into the test.
import { openIssueFindings } from '../loop/records';
import { hashBrief, buildBrief, assembleBrief, BRIEF_CHAR_BUDGET, REVISIONS_HEADING, SEED_BRIEF_HEADING } from './brief';
import { resolveHarness } from './harness';
import { ensurePhraseCatalog } from '../phrase/catalog';
// THE STRUCTURE SEAT's fixture needs a real Plotlines Phrase row: the seat's `PHRASE SEED` section reads
// the phrase's OWN copied seed (`phrase/controllers/plotlines.ts:plotlinesStructureSeedSection`), so
// starting the phrase through its own function is the only way to get the row the section reads.
import { startPlotlinesPhrase } from '../phrase/controllers/plotlines';
import { recordUidAt } from '../store/persist';
import {
    AUTHOR_ATTR,
    seedChapter,
    seedDigest,
    seedFinding,
    seedGoal,
    seedIdea,
    seedPlotline,
    seedRevision,
    seedStory,
    seedTask,
    seedTemplate
} from './mock';
import type { WorkItem } from './types';
import type { StoryPhase } from '../../shared/types';

/** The §4.13 attribution a run's own bookkeeping carries (P11). */
const RUN: Attribution = { run_ref: 'run_0', why: 'lease heartbeat (S-4a)' };

/**
 * A seeded Story in the state a `check_unit` job arrives at: Story + Summary + Goal + Digest +
 * plotline + two chapters, one of which carries prose nobody but this chapter's crew may see.
 *
 * Ids are the store's own minted values (`story_0`, `summary_0`, `chapter_0`, …), which is what
 * makes every assertion below an exact one.
 */
function seedStore(options: {
    digests?: number;
    drafts?: number;
    draftLength?: number;
    chapters?: number;
    // The Story phase decides which review banner and which `check_unit` job sentence a Critic pass
    // gets (`brief.ts:criticReviewModeOf`), so the phase is a fixture knob, not a constant.
    phase?: StoryPhase;
} = {}) {
    const store = Store.empty();
    const story = seedStory(store, options.phase === undefined ? {} : { phase: options.phase });
    const goal = seedGoal(store, story.id);

    seedDigest(store, story.id, 'Maren reaches the ridge; the map is wrong; the town is under water.');

    const plotline = seedPlotline(store, story.id);
    const chapter = seedChapter(store, story.id, { plotline_ref: plotline.id });

    // The second chapter exists to prove E-1: its prose must NOT reach a brief, and for a
    // whole-Story job only its one line may.
    const other = seedChapter(store, story.id, {
        order: 2,
        title: 'The Reservoir',
        summary: 'Maren walks the drowned street.',
        sections: [
            {
                id: 'sec_1',
                text: 'SECOND CHAPTER PROSE — the drowned church bell rings under the water.',
                origin: 'writer'
            }
        ]
    });

    const template = seedTemplate(store, {
        name: 'reader-consistency',
        roles: [
            {
                name: 'reader',
                kind: 'reader',
                prompt: 'You hunt setup-payoff debt across the unit. Every failing criterion needs an evidence line (D-15).'
            }
        ],
        done_definition: 'every criterion has a verdict and every failure has a task'
    });

    // The competing drafts a `select` brief is allowed to show and no other kind is (D-21).
    const drafts = Array.from({ length: options.drafts ?? 0 }, (_unused, index) =>
        seedRevision(
            store,
            story.id,
            chapter.id,
            `DRAFT ${index + 1} — ${'x'.repeat(options.draftLength ?? 40)}`,
            `run_${index + 2}`
        )
    );

    return { store, story, goal, plotline, chapter, other, template, drafts };
}

/** The Work Item the sweep would hand a `check_unit` job (S-1: one job, one run). */
function itemFor(overrides: Partial<WorkItem> = {}): WorkItem {
    return {
        id: 'work_1',
        storyId: 'story_0',
        kind: 'check_unit',
        templateRef: 'reader-consistency',
        roleName: 'reader',
        unit: { kind: 'chapter', ref: 'chapter_0' },
        ...overrides
    };
}

// ---------------------------------------------------------------------------
// The phase-① deep review's engine note (CS-VERDICT-1)
// ---------------------------------------------------------------------------

/**
 * The budget `renderJob` clips the sweep note to (S-2): `brief.ts:renderJob` — `clip(item.note, 600)`.
 * Pinned here as a constant so the test says WHICH 600 characters survive, rather than trusting
 * the implementation's number.
 */
const NOTE_CHAR_CLIP = 600;

/**
 * The note the sweep really attaches to a phase-① deep-review job, read out of the `note:` literal in
 * `loop/work.ts:phase1PipelineCandidates` (§6.4 step 6) with its template holes filled the way the
 * loop fills them.
 *
 * It is DERIVED from that source rather than copied into a fixture on purpose: the assertion below is
 * "the decisive instruction survives the 600-character clip", and a hand-copied mirror can drift into
 * proving a sentence `work.ts` no longer sends. The extraction fails loudly if the note moves or goes.
 *
 * A long note is the whole point of the fixture — at ~1,597 characters the note is always clipped,
 * which is exactly what let the verdict instruction be clipped away silently (the shipped note named
 * the right ref at character 1,249 of a 1,514-character string).
 */
function deepReviewNote(pass: number, critics: number, unitRef: string, revisionId: string): string {
    const source = readFileSync(`${import.meta.dirname}/../loop/work.ts`, 'utf8');
    const marker = 'note: `Critic pass';
    const at = source.indexOf(marker);

    if (at === -1)
        throw new Error('loop/work.ts no longer attaches a `Critic pass …` note to the phase-① deep review');

    const open = source.indexOf('`', at);
    const close = source.indexOf('`', open + 1);

    return source
        .slice(open + 1, close)
        // The literal spells the typographic apostrophes as `\u2019` escapes; the model sees the
        // character, so the extraction has to resolve them the same way the template literal does.
        .replace(/\\u2019/g, '’')
        .replace(/\$\{pass\}/g, String(pass))
        .replace(/\$\{critics\}/g, String(critics))
        .replace(/\$\{selected\.unit_ref\}/g, unitRef)
        .replace(/\$\{selected\.id\}/g, revisionId);
}

/** Seeds the Critic template one of `DEEP_REVIEW_TEMPLATES` names, with the angle prompt it carries. */
function seedCriticTemplate(store: Store): void {
    seedTemplate(store, {
        name: 'critic-genre',
        serves_phase: ['summary'],
        roles: [
            {
                name: 'critic',
                kind: 'critic',
                web: true,
                prompt: 'You are a Critic (D-30): you judge the Overview against the Seed from one angle.'
            }
        ],
        // The template's own done-line is the wide Critic capability; a review pass replaces it (D-30).
        done_definition: 'every proposal is filed as an Idea with its sources'
    });
}

describe('brief — S-2 assembly', () => {
    it('renders S-2’s section list in order, and nothing else', () => {
        const { store } = seedStore();
        const item = itemFor();
        const brief = assembleBrief(store, item, resolveHarness(store, item));

        // Exact heading list, in render order: this is the assertion surface for "the brief is
        // self-contained" (S-2) — a missing section is a run that has to go look, which is D-13's
        // failure mode.
        expect(brief.sections).toEqual([
            'ROLE — reader (reader) of reader-consistency',
            'PHASE AND GOAL CRITERIA — Cold Mountain',
            'SEED — Author truth, read-only for you at every phase, forever',
            'DIGEST rev 1 (derived by the engine, never a crew: D-12a)',
            'ARTIFACT UNDER REVIEW — chapter chapter_0 — The Return (order 1, state drafting)',
            'THE JOB',
            'WHAT CHANGED SINCE THE LAST PASS',
            'SELECTED IDEAS THIS RUN MUST ABSORB (D-29 — selected, not yet written in)',
            'TOOLS AND HOW TO END'
        ]);
    });

    it('carries the role prompt, the phase question, the criteria, the Seed and the Digest verbatim (S-2, G-2, G-4, P5, D-13)', () => {
        const { store, story } = seedStore();
        const item = itemFor();
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain('You hunt setup-payoff debt across the unit.');
        expect(text).toContain('Done means: every criterion has a verdict and every failure has a task');
        // P4/D-13: the contract the prose must deliver is IN the brief, not one tool call away.
        expect(text).toContain('The contract this chapter must deliver (P4):');
        expect(text).toContain('must_happen: She sees the flooded church steeple.');
        // G-4: the Goal the whole crew is measured against, with P6's pass/fail rule.
        expect(text).toContain(
            'Goal "Consistent at every level, and written like mine": every HARD criterion must pass; at least 3 soft criteria must pass (P6: pass/fail with a citation, never a score).'
        );
        // G-2: a criterion arrives with its question and its fix hint, not just its id.
        expect(text).toContain(
            '- C-7 · HARD · you judge it\n  expanded prose delivers its chapter\u2019s `must_happen`\n  Q: Does the expanded prose deliver every event this chapter\u2019s must_happen names?\n  If it fails: Write the events the plotline names in this chapter; do not let an adjacent chapter do them instead.'
        );
        // C-12 sits outside the levels but is judged on every chapter (§5.2, PER_CHAPTER).
        expect(text).toContain('## Per chapter (outside the levels, \u00a75.2)');
        // P5/D-3b: the Seed is untouchable, and the brief says so where the agent reads it.
        expect(text).toContain(story.idea);
        expect(text).toContain('Maren reaches the ridge; the map is wrong; the town is under water.');
        // The job names the tool that reports it (S-4 is easier to obey when it is stated inline).
        expect(text).toContain('Judge the unit against the criteria above and report with `submitVerdict`');
    });

    it('bounds a Critic review pass: review mode first, findings-first, no Ideas, and no proposal-style done line (D-30)', () => {
        const { store, story } = seedStore();
        const revision = seedRevision(store, story.id, 'summary_0', 'DRAFT ONE — the valley under water.', 'run_1', {
            unit_kind: 'summary'
        });

        seedTemplate(store, {
            name: 'critic-genre',
            roles: [
                {
                    name: 'critic',
                    kind: 'critic',
                    web: true,
                    prompt:
                        'You are a Critic (D-30). You never write the book; proposeIdea is for jobs that ask for Ideas.'
                }
            ],
            done_definition: 'every proposal is filed as an Idea with its sources'
        });

        const item = itemFor({
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: { kind: 'summary', ref: 'summary_0' },
            revisionRef: revision.id
        });
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // The binding mode is rendered before the angle prompt, so the wider Critic capability
        // cannot be read as this pass's job.
        const mode = text.indexOf('PASS MODE — REVIEW');
        expect(mode).toBeGreaterThan(-1);
        expect(mode).toBeLessThan(text.indexOf('You are a Critic (D-30).'));

        // The template's proposal-style done-definition is replaced, not stacked, for this pass.
        expect(text).not.toContain('Done means: every proposal is filed as an Idea with its sources');
        // R-rule: the done-line is the pass's STOPPING rule, and it is stated as certainty, not as
        // completeness — the old "every critical and major issue you found" invited another dig.
        expect(text).toContain('Done means: every issue you are certain of — critical and major first — is filed');
        expect(text).toContain('do not propose Ideas in this pass');
        // D-33b: the Ideas ban is unchanged, and the sentence now names the pass's one legitimate outlet
        // for a proposal, which is the half whose absence had the Critic filing wishes as defects. The
        // noun changed with the kind token: a `kind: proposal` row is a Proposal, and the job line says so.
        expect(text).toContain(
            'REVIEW PASS: report defects and file genuine Proposals as `kind: proposal` findings — do not propose Ideas.'
        );
        // The sample and the Seed are in the brief, so the pass does not need to go looking.
        expect(text).toContain('DRAFT ONE — the valley under water.');
        expect(text).toContain('call `readSummary` only if the brief does not carry the sample');
    });

    it('orders a phase-① deep review to file BOTH verdict forms — at the Summary unit and at the draft — and keeps that inside the note clip (C-14, §6.4 step 6, D-21, D-30)', () => {
        const { store, story } = seedStore();

        // The round's winner, on the Summary unit — the record the deep review points a pass at
        // (`loop/work.ts`, `{ kind: 'summary', ref: selected.unit_ref }` + `revisionRef: selected.id`).
        const revision = seedRevision(store, story.id, 'summary_0', 'DRAFT ONE — the valley under water.', 'run_1', {
            unit_kind: 'summary',
            state: 'selected'
        });

        expect(revision.id).toBe('revision_0');

        seedCriticTemplate(store);

        // The note `work.ts` sends for THIS job (pass 1 of 2, this unit, this draft).
        const note = deepReviewNote(1, 2, 'summary_0', revision.id);

        // Pinned: the note is ~2.6× the clip, so the brief below carries a TRUNCATED note — the shape
        // that hid the verdict instruction in the shipped build (it named the right ref past char 600).
        // The number moved when T3 front-loaded the admissibility clause into the window (it had lived
        // at characters 950-1,320 of the shipped note, i.e. never sent at all). It moved again (+78) when
        // D-33b spelled the Issue/Proposal split into the sweep note, once more (+10) on 2026-11-26 when
        // the leading clause became "File ONE submitVerdict with both verdict lines" — "File TWO verdicts
        // with submitVerdict" reads as two tool calls, and the pass now ends on one
        // (`run/plugins/critic-termination.ts`) — and +67 with the MAJOR 3 follow-up the SAME day, when
        // the clause past the clip stopped sending the pass to a SECOND endpoint ("File the critical and
        // major issues with raiseFinding on …" became "… as findings[] entries of that SAME submitVerdict",
        // `tools/reader.ts:submitVerdict`'s `findings[]`). Every one of those edits lands in the CLIPPED
        // tail except the leading clause, so this number is bookkeeping about the tail, not the contract.
        // THE NUMBER IS A CLIP BUDGET, NOT A FORMALITY: in the longer-ids variant below the clause "Added
        // detail … are NOT defects" ends at character 594 (re-measured, unchanged by the +67), so a note
        // edit that costs more than 6 characters BEFORE that clause pushes it past the 600 clip and THIS
        // test's own "inside the window" assertions fail. The window assertions, not this number, are what
        // the doctrine depends on.
        expect(note.length).toBe(1_597);

        const item = itemFor({
            id: 'wi_review_revision_0_a1',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: { kind: 'summary', ref: 'summary_0' },
            revisionRef: revision.id,
            note
        });

        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // -- R1: the JOB names both records and says which one the Goal reads, in ONE call ---------
        // `criteria/engine.ts:scopeTargets` yields the Summary id for every `summary`-level criterion
        // (C-14); `summaryDraftEvidenceRefs` admits ONLY the currently selected draft's line as that
        // row's evidence. The brief asks for both filings: the Summary line the Goal reads, and the
        // draft line U-13's side-by-side view needs (D-21, §6.2a).
        //
        // WHAT THE PIN CHANGED FOR (2026-11-26): the rule it pins is unchanged — TWO LINES, in that
        // order, each named by its store-minted id, with the Summary line identified as the one the
        // Goal reads. What moved is the CALL SHAPE: "Report the verdict TWICE with `submitVerdict`"
        // reads as two tool calls, and each extra call is a round-trip a Critic pass spent itself on.
        // The assertion below pins the two lines as the CONTENT of one terminal report, so a rewrite
        // back into two calls fails here exactly as a rewrite that drops one of the targets does.
        expect(text).toContain(
            'Put BOTH verdict lines in the pass\u2019s ONE terminal report, about the same text and reaching the same answer: ' +
                'first at `target_ref` `summary_0` — the Summary unit the Goal\u2019s criteria are graded against, and the line the Goal actually reads — ' +
                'then at `target_ref` `revision_0`, the draft this brief carries, which is the per-draft record the crew panel and the revision rail read (D-21, U-13). ' +
                'Those two lines are one call, the last one this pass makes'
        );

        // -- R2: the pass's own done-definition names the SAME two targets, in ONE report ----------
        // (the template's proposal-style done-line is still replaced, not stacked, D-30).
        expect(text).toContain(
            'BOTH verdict lines sit in the ONE terminal `submitVerdict` report you end with, at `target_ref` `summary_0` AND at `target_ref` `revision_0`'
        );
        expect(text).not.toContain('Done means: every proposal is filed as an Idea with its sources');

        // -- R3: the contradictory draft-only instruction is gone from every section ---------------
        expect(text).not.toContain('against the revision named above');
        expect(text).not.toContain('Rate the sample with `submitVerdict`');
        expect(text).not.toContain('Rate the draft with submitVerdict');

        // -- R4: the decisive clause survives `renderJob`'s 600-character note clip ----------------
        const noteHeading = "The sweep's note on this job: ";
        const noteAt = text.indexOf(noteHeading);

        expect(noteAt).toBeGreaterThan(-1);
        // The clip marker states exactly what was dropped, so the window assertions below are about the
        // clipped form rather than a short fixture.
        expect(text).toContain(
            `… [clipped for the brief: ${
                note.length - NOTE_CHAR_CLIP
            } more characters — read the full record with the read tool]`
        );

        const carriedNote = text.slice(noteAt + noteHeading.length, noteAt + noteHeading.length + NOTE_CHAR_CLIP);

        // Both clauses of the note's verdict instruction are inside the surviving window…
        expect(carriedNote).toContain('File ONE submitVerdict with both verdict lines');
        expect(carriedNote).toContain('the goal verdict at target_ref summary_0');
        expect(carriedNote).toContain('and the draft\u2019s own line at target_ref revision_0');
        // …and so is T3's admissibility clause, which is the half that decides whether this pass files
        // a finding at all. In the shipped note the `THIS IS THE OVERVIEW, NOT PROSE` calibration sat at
        // character 950 and the phrasing rule at 1,320 — past the clip — so the Critics that kept costing
        // rounds on absences and wordings were never told not to. These two pins are the reason the note
        // is written front-loaded; move a clause past 600 and this test fails instead of the round.
        expect(carriedNote).toContain('THIS IS THE OVERVIEW, NOT PROSE; THE SEED IS GENERAL, NOT AN OUTLINE');
        expect(carriedNote).toContain(
            'Added detail, an open Seed question, an unstated stake and unplanted setup are NOT defects'
        );
        // The window really is the first 600 characters of a longer string (the clip marker below proves
        // the rest was dropped), so "inside the window" is a claim about what the model sees.
        expect(carriedNote.length).toBe(NOTE_CHAR_CLIP);
        // …and the note never contradicts the job.
        expect(carriedNote).not.toContain('never at the draft');
        // The unclipped job statement states the target BEFORE the note is reached: the job is the
        // authoritative wording and the note only reinforces it.
        expect(text.indexOf('`target_ref` `summary_0`')).toBeLessThan(noteAt);
    });

    it('keeps the Seed-silence clause inside the note clip when the store mints longer ids (T3)', () => {
        // WHY LONGER IDS: the failure this file exists for was a real Story — `summary_17` and
        // `revision_102`, two characters longer each than the fixture above. The note interpolates both
        // refs near its start, so every character the store mints pushes the whole surviving window
        // down, and the clause that decides whether an absence is reportable is the last thing in it.
        // This is the guard the comment at `loop/work.ts` promises: a note edit that pushes the clause
        // past 600 fails here instead of quietly stopping reaching the model.
        const note = deepReviewNote(1, 2, 'summary_17', 'revision_102');

        // The same note, +8 characters from the longer ids.
        expect(note.length).toBe(1_605);

        const carried = note.slice(0, NOTE_CHAR_CLIP);

        expect(carried.length).toBe(NOTE_CHAR_CLIP);
        expect(carried).toContain('File ONE submitVerdict with both verdict lines');
        expect(carried).toContain('the goal verdict at target_ref summary_17');
        expect(carried).toContain('and the draft\u2019s own line at target_ref revision_102');
        expect(carried).toContain('THIS IS THE OVERVIEW, NOT PROSE; THE SEED IS GENERAL, NOT AN OUTLINE');
        expect(carried).toContain(
            'Added detail, an open Seed question, an unstated stake and unplanted setup are NOT defects'
        );
    });

    it('states the whole admissibility rule where the clip cannot reach it — the job line and the review banner (T3)', () => {
        const { store, story } = seedStore();
        const revision = seedRevision(store, story.id, 'summary_0', 'DRAFT ONE — the valley under water.', 'run_1', {
            unit_kind: 'summary'
        });

        seedCriticTemplate(store);

        const item = itemFor({
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: { kind: 'summary', ref: 'summary_0' },
            revisionRef: revision.id
        });
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // R1 — THE JOB LINE, which `renderJob` never clips. The Reviewer gets the permission, its
        // consequences, the cost ladder and the quote test in the one paragraph it is working from, so
        // the rule cannot be lost to a clipped tail the way the shipped note lost it (T-6a).
        expect(text).toContain(
            'The Seed is general and is not an outline: where it is silent, or names a question in `open_questions`, the Writer may invent any specific that does not contradict it.'
        );
        expect(text).toContain(
            'an added detail, a Seed question left open, stakes or consequences the Seed never stated, and setup a Summary did not promise are NOT defects and never a C-14 finding'
        );
        expect(text).toContain(
            'a Summary is not required to foreshadow its own ending or to spell out what the Seed left open.'
        );
        expect(text).toContain(
            'Admissible proof is a quotation: file what you can quote the draft contradicting, and nothing that rests on an absence alone.'
        );
        // D-33b — the outlet the stand-down used to leave empty. The pass may not file an absence as a
        // defect AND may not file an Idea, so without this sentence the Critic's only move was to dress a
        // proposal in defect wording and watch the Editor dispute it. Pinned with the job line's own words:
        // the marker, the proposing title, and the fact that the Editor's rule for it is different.
        // THE ROUTE IS PART OF THE SENTENCE NOW (2026-11-27): the Proposal is an entry of the same one report
        // that ends the pass, not a call before it — "file it with `kind: proposal`" read as a
        // `raiseFinding` round-trip, which is the second call the terminal plugin then refused to run.
        expect(text).toContain(
            'An absence is never an issue, but it may be a PROPOSAL: where the draft contradicts nothing and you can still name a change that would genuinely make the book better, put it in that same `findings[]` as `kind: proposal`'
        );
        expect(text).toContain(
            'a marked Proposal is weighed on whether the story the Seed promises is better for it'
        );
        // The phrasing rule: in the shipped sweep note this sentence started at character 1,320, i.e. it
        // was never sent at all, while the rounds it was meant to prevent kept happening. D-33b made the
        // sentence name the KIND, not just the cost, because cost alone left a `taste` Issue looking
        // legal — and `raiseFinding` now refuses that pairing on the call.
        expect(text).toContain(
            'word choice, sentence shape, grammar and register are a PROPOSAL at this phase — `kind: proposal` at cost `taste` or `minor`, never an Issue — because phase \u2462 writes the sentences'
        );

        // R2 — THE REVIEW BANNER, engine-owned text rendered ahead of the Author-editable angle prompt
        // (§8: the four angle templates are Author copies; this file and the job line are not). It turns
        // the same permission into a test the pass can apply: quote the contradiction, or the finding is
        // not admissible.
        expect(text).toContain('WHAT COUNTS AS AN ISSUE: the Seed and its Brief are commitments, not an exhaustive outline');
        // D-33b — the two cost ladders, pinned where an Author cannot edit them away. Each kind's ladder
        // ends where the other's begins, and `loop/records.ts` and `tools/reader.ts:raiseFinding` refuse
        // the two pairings this sentence rules out: an `issue` at `taste`, a `proposal` at `critical`.
        expect(text).toContain('and it is rated `critical`, `major` or `minor` — never `taste`');
        expect(text).toContain('and it is rated `major`, `minor` or `taste`, never `critical`');
        expect(text).toContain(
            'do not demand explicit stakes, consequences or planting from a Summary unless an explicit Seed or Summary commitment, or an actual contradiction, makes it necessary'
        );
        expect(text).toContain(
            'A finding must quote that evidence \u2014 a finding that quotes only an absence, and cannot quote what it contradicts, is not admissible.'
        );
        // D-33b — the exception belongs in the banner too, not only in the four Author-editable angle
        // templates: this text declares itself the override, so an improvement rule stated anywhere else
        // is a rule an Author rewrite can delete.
        expect(text).toContain(
            'The one exception is a PROPOSAL: a change that would genuinely improve the book while contradicting nothing is filed with `kind: proposal`'
        );

        // R3 — the gates T3 does NOT relax, pinned in the same text so a future softening of the rule is
        // a deliberate edit: contradiction of the Seed / critical Knowledge / the artifact itself, the
        // central-commitment failure, and the phase-②/③ setup-and-payoff review (C-4, C-5, C-6).
        expect(text).toContain('a real contradiction of what the Seed, the Brief or established critical Knowledge states');
        expect(text).toContain(
            'a real contradiction inside the artifact itself, a clear failure to carry a commitment the Seed states centrally (as distinct from a detail it leaves open)'
        );
        expect(text).toContain(
            'In later phases the chapter and plotline setup-and-payoff checks (C-4, C-5, C-6) stay exactly as they are.'
        );

        // R4 — the banner binds BEFORE the role prompt, so a wider angle template cannot be read as this
        // pass's job (D-30), and the durable rule therefore outranks an Author rewrite of the angle text.
        expect(text.indexOf('WHAT COUNTS AS AN ISSUE')).toBeLessThan(text.indexOf('You are a Critic (D-30)'));
    });

    it('disputes an omission-only finding instead of confirming the absence (T3 — Editor verification and Critic confirmation)', () => {
        const { store, story } = seedStore();

        // The finding from the Author's report: a stake the Seed never stated, reported as if the Summary
        // had broken a promise. Its `evidence` quotes nothing but a silence, which is the shape the two
        // gates below exist to reject.
        const finding = seedFinding(store, story.id, {
            target_ref: 'summary_0',
            criterion_ref: 'C-14',
            title: 'the Summary never says what the protagonist loses',
            detail: 'No stake is stated anywhere in the Overview.',
            evidence: 'the Seed Brief carries `stakes:` with nothing after it',
            cost: 'major'
        });

        const verify = itemFor({
            id: 'work_2',
            kind: 'verify_findings',
            templateRef: 'editor-general',
            roleName: 'editor',
            unit: { kind: 'summary', ref: 'summary_0' },
            findingRefs: [finding.id]
        });
        const { text: verifyText } = buildBrief(store, verify, resolveHarness(store, verify));

        // ADMISSIBILITY BEFORE ACCURACY. The old job asked only "is the defect real", and an absence is
        // real forever — so `the Summary never says X` was confirmable on its own and bought the round a
        // Writer pass. The Editor is now told what makes a finding admissible BEFORE its truth is judged.
        expect(verifyText).toContain(
            'ADMISSIBILITY comes before accuracy: a defect is real only when the finding quotes a commitment and shows the artifact breaking it'
        );
        expect(verifyText).toContain('a claim whose whole case is an ABSENCE');
        expect(verifyText).toContain(
            'is an INVALID finding however true the absence is: `dispute` it and name the silence as the reason'
        );
        // D-33b — the SECOND evaluation mode, pinned beside the rule it is an exception to, in the one
        // paragraph the verify thread works from. This is the behaviour fix the Author asked for: a
        // proposal used to meet the absence rule and lose, every time, without being weighed.
        expect(verifyText).toContain(
            'A finding marked `proposal` in its bracket is the one claim this test does NOT judge: the Critic is proposing a change the Seed never had to promise, not reporting a defect, so the absence rule does not apply to it.'
        );
        expect(verifyText).toContain(
            '`confirm` it when the change genuinely strengthens the story the Seed promises and is worth a Writer pass, `dispute` it when it is not worth the pass or would contradict the installed text, and NEVER dispute it merely because the Seed never promised it.'
        );
        // And the scope of the old rule is now explicit, so a future edit cannot read it as a blanket ban
        // on every claim that mentions a silence.
        expect(verifyText).toContain('ADMISSIBILITY comes before accuracy: a defect is real only when');
        // The cost ladder is described the way the shipped dial actually behaves (no runtime change):
        // `taste` never blocks a phase-① round, and `minor` blocks exactly when the Story's
        // `auto_approve` costs cover it — which they do by default (`shared/types.ts:
        // DEFAULT_AUTO_APPROVE_COSTS` → `loop/records.ts:summaryBlockingCost`). D-33b adds the kind
        // clause: a `taste` row can only be a Proposal, since an `issue` at that cost is refused at the
        // call, so the Editor reading this never has to decide how to triage a taste-cost defect.
        expect(verifyText).toContain(
            'a `taste` row — which by rule is a Proposal, never an Issue — never blocks a Summary round, because the prose it would choose between is not written until phase \u2462'
        );
        expect(verifyText).toContain(
            '`minor` blocks exactly when this Story\u2019s `auto_approve` dial covers `minor`, which it does by default (D-35)'
        );

        // D-33d — the approval half of the same sentence. The paragraph above tells the Editor how to
        // VERDICT a proposal; this is the half that tells it the proposal still cannot be APPROVED while
        // an issue is open, which is the refusal `tools/editor.ts:approveFinding` hands back and the one
        // the crew otherwise discovers by spending a turn on it. The three HOLDING states are named
        // because `approved` is the state a crew reads as "handled" and it is not a resolution — and
        // because `disputed` is NOT in the list (2026-11-25): the Editor's own "not a defect" releases
        // the approval, so a row that drives no work can never wedge the queue.
        expect(verifyText).toContain(
            'ISSUES COME FIRST, and they gate the approval as well as the verdict (D-33d): while any issue on this Story is unresolved'
        );
        expect(verifyText).toContain(
            'only `unconfirmed`, `confirmed` and `approved` hold one open, and one you marked `disputed` releases it'
        );
        expect(verifyText).toContain(
            '`approveFinding` REFUSES a row marked `proposal`, whatever the dial says'
        );
        // …the instruction that follows, so the pass leaves the row where the next pass can finish it…
        expect(verifyText).toContain(
            'if it cannot be approved yet leave it `confirmed` — it is not lost, and the pass that has no issue left approves it'
        );
        // …the exception, because a refusal that also banned DECLINING would strand the row…
        expect(verifyText).toContain(
            'Discarding a proposal is always allowed, because declining a change is not an approval.'
        );
        // …and the guarantee that the rule never slows the defects down: the loop must keep taking the
        // very work that releases the proposals.
        expect(verifyText).toContain(
            'An ISSUE row is never held by this rule: the defects that unlock the proposals are exactly the work the loop must not stop taking.'
        );

        const confirm = itemFor({
            id: 'work_3',
            kind: 'confirm_finding',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: { kind: 'summary', ref: 'summary_0' },
            findingRefs: [finding.id]
        });
        const { text: confirmText } = buildBrief(store, confirm, resolveHarness(store, confirm));

        // The Critic's own second look carries the same test. Without it the confirmation pass re-approves
        // whatever the Editor waved through, because "the Overview really does not mention X" survives any
        // amount of independent checking — the absence keeps being true.
        expect(confirmText).toContain('An absence is not a defect: the Seed is general rather than an outline');
        expect(confirmText).toContain(
            '`dispute` an omission-only claim on that ground, and `confirm` only a finding that quotes a commitment and shows the draft breaking it.'
        );
    });

    it('marks a proposal in the findings block, and renders a plain issue exactly as it always did (D-33b)', () => {
        const { store, story } = seedStore();

        // Two rows on purpose. The proposal has to be visible to the Editor INSIDE the record list the
        // job carries — the bracket is the only place the finding itself is quoted to that thread, and
        // `tools/editor.ts` teaches its two evaluation modes off the row's `kind` (its `verifyFinding`
        // description, and the `Kind: proposal` marker at line 1162) — and the legacy row (no `kind`
        // field at all) has to render byte-identically, because every existing brief, fixture and
        // `brief_hash` depends on that line not moving.
        seedFinding(store, story.id, {
            criterion_ref: 'C-11',
            title: 'open the book on the lie instead of the truth',
            detail: 'chapter_1 sec_1 has him tell the truth at once; the lie first gives chapter 2 its tension',
            evidence: 'chapter_1 sec_1: "he told them the truth"',
            cost: 'major',
            kind: 'proposal'
        });
        seedFinding(store, story.id, {
            criterion_ref: 'C-4',
            title: 'the 1911 map is never paid off',
            evidence: 'chapter_1 sec_1 mentions the map; nothing answers it',
            cost: 'major'
        });

        const item = itemFor({
            id: 'work_9',
            kind: 'verify_findings',
            templateRef: 'editor-general',
            roleName: 'editor',
            unit: { kind: 'summary', ref: 'summary_0' },
            findingRefs: ['finding_0', 'finding_1']
        });
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain(
            '- finding_0 [unconfirmed, cost major, seen 1×, criterion C-11, proposal]: open the book on the lie instead of the truth'
        );
        expect(text).toContain(
            '- finding_1 [unconfirmed, cost major, seen 1×, criterion C-4]: the 1911 map is never paid off'
        );
        // The marker is a marker, not a rewrite of the line: nothing else about either row moved. The
        // unmarked row must not pick up EITHER kind word — D-33b's default is applied when a row is read,
        // never when the line is rendered, so a legacy brief renders byte-identically.
        expect(text).not.toContain('criterion C-4, proposal');
        expect(text).not.toContain('criterion C-4, issue');

        // D-33c/D-33d — the HEADING of that same block now says why the proposal is stuck. This fixture is
        // exactly the pass the sentence exists for: a Proposal row in front of an Editor, plus an open
        // issue the Editor would otherwise discover by calling `approveFinding` and eating a refusal. The
        // count is an issue COUNT, not a row count, and the one/plural form is pinned because the Author
        // reads this string.
        expect(text).toContain(
            'Findings in front of you (2, 1 unresolved issue — no Proposal is filed or approved until they close (D-33c, D-33d)):'
        );
    });

    it('leaves the findings heading byte-identical unless a Proposal row is actually blocked (D-33c, D-33d)', () => {
        // WHY THE ABSENCE IS PINNED AS HARD AS THE PRESENCE: `runs.brief_hash` (§4.13) is computed over the
        // assembled brief, and every existing brief in the store — every fixture, every cached comparison —
        // renders the plain heading. The annotation is conditional on TWO facts (a `proposal` row among
        // this job's rows, AND an unresolved issue on the Story), so every shape that is NOT that pair has
        // to come out exactly as it always did.
        //
        // ONE STORE PER SHAPE: the open-issue count is read at STORY scope (`records.ts:openIssueFindings`),
        // not from the job's row list — correct, because the rule the sentence explains is Story-scoped too
        // — and it is also what makes a shared store poison the other shapes: a second open issue seeded
        // for one case re-annotates the others underneath the test.
        const briefFor = (seed: (store: Store, storyId: string) => string[]): string => {
            const { store, story } = seedStore();
            const findingRefs = seed(store, story.id);
            const item = itemFor({
                id: `work_heading_${findingRefs.join('_')}`,
                kind: 'verify_findings',
                templateRef: 'editor-general',
                roleName: 'editor',
                unit: { kind: 'summary', ref: 'summary_0' },
                findingRefs
            });

            return buildBrief(store, item, resolveHarness(store, item)).text;
        };

        // (a) A plain issue-only tray. The issue IS open, and the heading still says nothing: no Proposal
        //     row is in front of this job, so the sentence would only be noise.
        const issueOnly = briefFor((store, storyId) => [
            seedFinding(store, storyId, {
                criterion_ref: 'C-4',
                title: 'the 1911 map is never paid off',
                evidence: 'chapter_1 sec_1 mentions the map; nothing answers it',
                cost: 'major'
            }).id
        ]);

        expect(issueOnly).toContain('Findings in front of you (1):');
        expect(issueOnly).not.toContain('unresolved issue');

        // (b) A Proposal with no issue anywhere to wait for. An open PROPOSAL is not an open ISSUE — the
        //     predicate counts rows whose KIND is issue (`records.ts:isOpenIssueFinding`).
        const proposalOnly = briefFor((store, storyId) => [
            seedFinding(store, storyId, {
                criterion_ref: 'C-11',
                title: 'open the book on the lie instead of the truth',
                evidence: 'chapter_1 sec_1: "he told them the truth"',
                cost: 'major',
                kind: 'proposal'
            }).id
        ]);

        expect(proposalOnly).toContain('Findings in front of you (1):');
        expect(proposalOnly).not.toContain('unresolved issue');

        // (c) THE RELEASE CASE. The Story's only issue is `fixed`, which is one of the two states that
        //     CLOSES one (`records.ts:CLOSED_FINDING_STATES`), so the proposal beside it is approvable and
        //     the heading has no business carrying the warning.
        const released = briefFor((store, storyId) => [
            seedFinding(store, storyId, {
                criterion_ref: 'C-6',
                title: 'the survey date is wrong in chapter 3',
                evidence: 'chapter_3 sec_2: "the 1911 survey"',
                cost: 'minor',
                state: 'fixed'
            }).id,
            seedFinding(store, storyId, {
                criterion_ref: 'C-11',
                title: 'open the book on the lie instead of the truth',
                evidence: 'chapter_1 sec_1: "he told them the truth"',
                cost: 'major',
                kind: 'proposal'
            }).id
        ]);

        expect(released).toContain('Findings in front of you (2):');
        expect(released).not.toContain('unresolved issue');

        // (d) THE DISPUTED RELEASE (2026-11-25). The Story's only issue is `disputed` — the Editor's
        //     "not a defect", which is out of `loop/types.ts:ISSUE_HOLDING_STATES` — so the Proposal
        //     beside it is filable and approvable, and the heading must not warn about it. This is the
        //     case that used to read "1 unresolved issue" forever over a row the loop could never move.
        const disputed = briefFor((store, storyId) => [
            seedFinding(store, storyId, {
                criterion_ref: 'C-6',
                title: 'the survey date is wrong in chapter 3',
                evidence: 'chapter_3 sec_2: "the 1911 survey"',
                cost: 'minor',
                state: 'disputed'
            }).id,
            seedFinding(store, storyId, {
                criterion_ref: 'C-11',
                title: 'open the book on the lie instead of the truth',
                evidence: 'chapter_1 sec_1: "he told them the truth"',
                cost: 'major',
                kind: 'proposal'
            }).id
        ]);

        expect(disputed).toContain('Findings in front of you (2):');
        expect(disputed).not.toContain('unresolved issue');
    });

    // -----------------------------------------------------------------------
    // D-33c LIVE STATE — the open-issue count a Critic review brief never carried (2026-11-26)
    // -----------------------------------------------------------------------

    /**
     * The brief for a Critic REVIEW job shaped exactly like the ones the real sweep dispatches:
     * `check_unit` + `roleName: 'critic'`, the Summary unit and the selected draft, and NO
     * `findingRefs`. That absence is the mechanism this section pins — the deep-review sites
     * (`loop/work.ts:2080-2098` legacy, `:1411-1435` group) never set `findingRefs`, so `renderJob`'s
     * findings bracket (the only place the count used to render) never appears for a Critic, and the
     * pass had to SPEND A TOOL CALL learning whether a Proposal was admissible. No `note` either: the
     * assertions below are about the engine-owned sections, and the sweep note's own copies of these
     * rules are pinned in `loop/phase1-verdict-contract.test.ts`.
     */
    function criticReviewStore(draft = true) {
        const base = seedStore();

        if (draft)
            seedRevision(base.store, base.story.id, 'summary_0', 'DRAFT ONE — the valley under water.', 'run_1', {
                unit_kind: 'summary',
                state: 'selected'
            });

        seedCriticTemplate(base.store);

        return base;
    }

    const criticReviewText = (store: Store): string => {
        const item = itemFor({
            id: 'wi_review_revision_0_a1',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: { kind: 'summary', ref: 'summary_0' },
            revisionRef: 'revision_0'
        });

        return buildBrief(store, item, resolveHarness(store, item)).text;
    };

    it('tells a Critic review pass how many issues are open, and that a Proposal is dismissed (D-33c — live state, not a rule)', () => {
        const { store, story } = criticReviewStore();

        // FIVE ROWS, TWO OF THEM OPEN ISSUES. The other three are the shapes that must not be counted:
        // an open PROPOSAL (a claim, not a defect — `loop/records.ts:isOpenIssueFinding` filters on
        // kind), a `disputed` issue (the Editor's own "not a defect", out of
        // `loop/types.ts:ISSUE_HOLDING_STATES`) and a `fixed` one. If any of those starts counting, the
        // number in the brief disagrees with the number `tools/reader.ts:dismissedProposal` quotes.
        seedFinding(store, story.id, {
            criterion_ref: 'C-14',
            fingerprint: 'C-14|chapter_1',
            title: 'the ending contradicts what the Seed states',
            cost: 'major'
        });
        seedFinding(store, story.id, {
            criterion_ref: 'C-4',
            fingerprint: 'C-4|chapter_2',
            title: 'the 1911 map is paid off in the wrong chapter',
            cost: 'critical',
            state: 'confirmed'
        });
        seedFinding(store, story.id, {
            criterion_ref: 'C-11',
            fingerprint: 'C-11|chapter_1',
            title: 'open the book on the lie instead of the truth',
            cost: 'minor',
            kind: 'proposal',
            state: 'confirmed'
        });
        seedFinding(store, story.id, {
            criterion_ref: 'C-6',
            fingerprint: 'C-6|chapter_1',
            title: 'the survey date is wrong in chapter 3',
            cost: 'minor',
            state: 'disputed'
        });
        seedFinding(store, story.id, {
            criterion_ref: 'C-6',
            fingerprint: 'C-6|chapter_2',
            title: 'a chapter gap an earlier round already closed',
            cost: 'major',
            state: 'fixed'
        });

        // THE COUNT IS THE LOOP'S OWN ANSWER, not a hand-written number: the expected sentence is built
        // from `openIssueFindings` itself, so a change to the holding set or to the kind filter moves
        // the assertion with it instead of leaving the brief quoting a number the gate no longer uses.
        const openIssues = openIssueFindings(store, story.id);

        expect(openIssues.map((finding) => finding.id)).toEqual(['finding_0', 'finding_1']);

        const text = criticReviewText(store);

        expect(text).toContain(
            `LIVE STATE — ${openIssues.length} issues are open on this Story right now, so a Proposal filed this pass is dismissed: no row, no work armed, and nothing to retry. Spend this pass on issues only.`
        );

        // RENDERED BEFORE THE ROLE PROMPT AND BEFORE THE CATALOGUE: the pass is told the fact before it
        // can spend a call discovering it, which is the entire fix (measured: 10 proposal-dismissal
        // records in one 33-minute run, each one a full round-trip).
        const liveAt = text.indexOf('LIVE STATE — ');

        expect(liveAt).toBeGreaterThan(-1);
        expect(liveAt).toBeLessThan(text.indexOf('You are a Critic (D-30)'));
        expect(liveAt).toBeLessThan(text.indexOf('# TOOLS AND HOW TO END'));

        // The banner and the job line both point at THIS line rather than restating a count of their
        // own, so the three cannot drift into three different numbers.
        expect(text).toContain('The LIVE STATE line printed with this banner is that same count');
        expect(text).toContain('The LIVE STATE line at the top of this brief is that count');

        // The findings bracket is still absent, which proves the mechanism is the live store read and not
        // rows wired into the job: a Critic review item carries no `findingRefs`, and this test builds
        // one the way `loop/work.ts` does.
        expect(text).not.toContain('Findings in front of you');

        // THE EDITOR SIDE IS UNTOUCHED: the same store, an Editor job, and the findings heading renders
        // exactly as it always did — the live-state line is critic-only, so the Editor's `brief_hash`
        // does not move (see the byte-identical test above).
        const editorItem = itemFor({
            id: 'work_verify_live',
            kind: 'verify_findings',
            templateRef: 'editor-general',
            roleName: 'editor',
            unit: { kind: 'summary', ref: 'summary_0' },
            findingRefs: ['finding_0']
        });
        const editorText = buildBrief(store, editorItem, resolveHarness(store, editorItem)).text;

        expect(editorText).not.toContain('LIVE STATE');
        expect(editorText).toContain('Findings in front of you (1):');
    });

    it('says "1 issue is open" in the singular, because a person reads this sentence (D-33c)', () => {
        const { store, story } = criticReviewStore();

        // The one open row is the `confirmed` one; the proposal beside it is not an issue.
        seedFinding(store, story.id, {
            criterion_ref: 'C-4',
            fingerprint: 'C-4|chapter_2',
            title: 'the 1911 map is paid off in the wrong chapter',
            cost: 'critical',
            state: 'confirmed'
        });
        seedFinding(store, story.id, {
            criterion_ref: 'C-11',
            fingerprint: 'C-11|chapter_1',
            title: 'open the book on the lie instead of the truth',
            cost: 'minor',
            kind: 'proposal',
            state: 'confirmed'
        });

        expect(openIssueFindings(store, story.id).map((finding) => finding.id)).toEqual(['finding_0']);
        expect(criticReviewText(store)).toContain(
            'LIVE STATE — 1 issue is open on this Story right now, so a Proposal filed this pass is dismissed:'
        );
    });

    it('tells the same pass, truthfully, that a Proposal is admissible when nothing is open (D-33c — the zero branch)', () => {
        const { store, story } = criticReviewStore();

        // EVERY RELEASED SHAPE: `disputed` (the Editor's non-defect), `fixed`, `discarded`, and an OPEN
        // PROPOSAL — which is a claim, never an issue. None of these holds a Proposal shut
        // (`loop/types.ts:ISSUE_HOLDING_STATES` is `unconfirmed`/`confirmed`/`approved` only), so the
        // brief must not claim the book is blocked.
        for (const [fingerprint, state] of [
            ['C-6|chapter_1', 'disputed'],
            ['C-6|chapter_2', 'fixed'],
            ['C-7|chapter_1', 'discarded']
        ] as const) {
            seedFinding(store, story.id, {
                criterion_ref: 'C-6',
                fingerprint,
                title: 'a claim this round has finished with',
                cost: 'minor',
                state
            });
        }

        seedFinding(store, story.id, {
            criterion_ref: 'C-11',
            fingerprint: 'C-11|chapter_1',
            title: 'open the book on the lie instead of the truth',
            cost: 'minor',
            kind: 'proposal',
            state: 'confirmed'
        });

        expect(openIssueFindings(store, story.id)).toEqual([]);

        const text = criticReviewText(store);

        expect(text).toContain(
            'LIVE STATE — no issue is open on this Story right now, so a Proposal you are certain of is admissible in this pass: file it with the verdicts in the one report you end with.'
        );
        // The dismissal sentence must not be present to misread, and neither may the count sentence.
        expect(text).not.toContain('so a Proposal filed this pass is dismissed');
        expect(text).not.toContain('issues are open on this Story right now');
    });

    it('retires the pass-pairing rule and every retry invitation from the Critic brief (D-33c, 2026-11-26)', () => {
        const { store, story } = criticReviewStore();

        seedFinding(store, story.id, {
            criterion_ref: 'C-14',
            fingerprint: 'C-14|chapter_1',
            title: 'the ending contradicts what the Seed states',
            cost: 'major'
        });

        // CASE-INSENSITIVE: the banner spelled the mirror rule in capitals ("an ISSUE AND A PROPOSAL
        // NEVER SHARE A PASS"), and the point of this test is the SHAPE of the promise, not its casing.
        const text = criticReviewText(store).toLowerCase();

        // Every sentence below promised a CALL THE RULE NO LONGER OFFERS. The mirror rule is removed with
        // `tools/reader.ts:dismissedProposal` (2026-11-26, `documents/specifications.md:333`), and a
        // dismissal has no "later" to bring the improvement in — it ends the thread. Each of these is a
        // round-trip the owner's complaint is about, so their absence is the assertion, not a side
        // effect of new text.
        expect(text).not.toContain('never share a pass');
        expect(text).not.toContain('refuses a `kind: proposal`');
        expect(text).not.toContain('refused and told how many issues are open');
        expect(text).not.toContain('bring it in a pass that has none left');
        expect(text).not.toContain('bring the improvement once the book has no defect left');
        expect(text).not.toContain('next review');
        // And the retry-shaped description of the answer itself is gone: it is a DISMISSAL.
        expect(text).toContain('a `kind: proposal` claim is dismissed rather than refused');
        expect(text).toContain('a `kind: proposal` claim is dismissed on the call');
    });

    it('ends the pass with ONE terminal report carrying both verdict lines and the findings (D-21, U-13, S-4)', () => {
        const { store } = criticReviewStore();

        const text = criticReviewText(store);

        // JOB LINE — the report is the pass's LAST act and it carries everything. The shape is described
        // in WORDS, never by naming parameters: the report's schema is being finalised in
        // `tools/reader.ts` alongside this prose, and a field name here would freeze a shape another
        // pass still owns.
        expect(text).toContain(
            'The pass ends with ONE terminal `submitVerdict` report carrying both verdict lines and every finding you are sure of, and the thread is over the moment that call fires'
        );
        expect(text).toContain('Put BOTH verdict lines in the pass\u2019s ONE terminal report');
        expect(text).toContain('Those two lines are one call, the last one this pass makes');
        // The D-21/U-13 double-target rule still binds, inside that one call — the assertion above names
        // both lines; the ids they aim at are pinned in the CS-VERDICT-1 test above.
        // BANNER — the same requirement ahead of the Author-editable angle prompt.
        expect(text).toContain(
            'it ends with ONE terminal report — `submitVerdict` carrying both verdict lines the Goal and the crew panel need AND every finding you are filing'
        );
        // DONE LINE — the last thing the crew reads before the catalogue.
        expect(text).toContain(
            'BOTH verdict lines sit in the ONE terminal `submitVerdict` report you end with, at `target_ref` `summary_0` AND at `target_ref` `revision_0`'
        );
        // PERMISSION LINE (`run/harness.ts:permissionLine`, kind `critic`) — the third copy, rendered in
        // TOOLS AND HOW TO END. IT MOVED AGAIN (2026-11-27): the line no longer advertises `raiseFinding` as
        // a filing path beside the report — every finding is a `findings[]` entry of the ONE terminal
        // `submitVerdict`, which is what `run/plugins/critic-termination.ts` enforces at the call — and it
        // names the `proposeIdea` allowance instead. Pinned WHOLE, because the brief, the banner and the
        // plugin have to say the same thing: a partial pin lets one of the three drift.
        expect(text).toContain(
            'You are a Critic: you close with ONE terminal report — `submitVerdict` carries every verdict line ' +
                'the pass owes and every finding in `findings[]`, and it is the last call you make — plus ' +
                '`proposeIdea` when the job explicitly asks for Ideas (D-26, T-9). Any write to a story ' +
                'artifact is refused naming P10 — report or propose, never edit.'
        );
        // The two-call framing cannot come back from this section. The old line named `raiseFinding` as the
        // claim-filing path and `submitVerdict` as a separate last call — the round-trip the terminal report
        // replaced — so its exact wording is pinned as an absence. (The bare verb still appears in the
        // S-4 report-tool list, which is a different sentence and still lists it.)
        expect(text).not.toContain('`raiseFinding` for a claim you can quote');
        expect(text).not.toContain('`submitVerdict` as the pass\u2019s last call');
        // The framing that read as two calls cannot come back from any section of this brief.
        expect(text).not.toContain('Report the verdict TWICE');
    });

    it('stops the pass on certainty and effort-then-value, and reads an empty pass as a completed one (D-30, S-4)', () => {
        const { store } = criticReviewStore();

        const text = criticReviewText(store);

        // EFFORT THEN VALUE, in both engine-owned places. The banner's version is the general rule; the
        // job line's is the sentence a tool-using pass acts on. Nit-picking is named, not implied.
        expect(text).toContain('CONCLUDE, DO NOT MINE: report what you are certain of and stop');
        expect(text).toContain(
            'A defect you had to dig for is not worth filing, nit-picking is forbidden, and a minor note or an improvement you cannot name against a quotation is not worth the call'
        );
        expect(text).toContain('CONCLUDE, DO NOT MINE: file the issues you are certain of and stop');
        expect(text).toContain('a defect you had to dig for is not worth filing, and nit-picking is forbidden');
        // The stop is CERTAINTY, in the done-line too, and the open-ended "you need not be exhaustive"
        // hedging (which reads as permission to keep looking) is gone with it.
        expect(text).toContain('Once the issues you are certain of are filed this pass is finished');
        expect(text).toContain('Done means: every issue you are certain of — critical and major first — is filed');
        expect(text).toContain('and you stopped there instead of digging for a defect worth less than the round it would buy');
        expect(text).not.toContain('You do not have to be exhaustive');
        expect(text).not.toContain('You do not need to be exhaustive');
        // S-4 vs D-30, reconciled in the shared etiquette section: the ledger counts the MISSING REPORT,
        // never a pass that filed nothing. Both halves are pinned because the contradiction was between
        // these two sentences specifically.
        expect(text).toContain(
            'What costs the Story a turn is the missing REPORT, never an empty set of findings'
        );
        expect(text).toContain('a pass that files nothing and reports that the text holds has done its job');
        expect(text).toContain('S-4 counts a run that never REPORTS, never a run that filed no finding');
    });

    it('gives a Summary Writer the licence to invent what the Seed leaves silent, and withholds it from the other units (T3)', () => {
        const { store } = seedStore();

        const summaryItem = itemFor({
            id: 'work_4',
            kind: 'write_unit',
            templateRef: 'writer-summary',
            roleName: 'writer',
            unit: { kind: 'summary', ref: 'summary_0' }
        });
        const { text: summaryText } = buildBrief(store, summaryItem, resolveHarness(store, summaryItem));

        // The tool-using Writer's copy of the rule the no-tool sampler gets from
        // `run/phase1-prompt.ts:SEED_CONTRACT_NOTE`: invention inside the Seed's silence is the job, and
        // the obligation that remains is not to contradict or drop what the brief STATES.
        expect(summaryText).toContain(
            'The Seed and its Brief commit what they STATE and are silent about everything else on purpose'
        );
        expect(summaryText).toContain(
            'Invention is the job here, not a defect you are penalised for, and no reviewer may ask the Summary for foreshadowing or detail neither the Seed nor your own draft promised.'
        );
        expect(summaryText).toContain(
            'What you must not do is contradict the brief, or drop a commitment it states explicitly.'
        );

        // A chapter Writer is NOT handed the Summary licence: at phase ③ the plotline and chapter
        // contracts are the commitments and the setup-and-payoff review (C-4, C-5, C-6) is in force, so
        // the licence has to stop at the Summary unit rather than leak into the prose phases.
        const chapterItem = itemFor({
            id: 'work_5',
            kind: 'write_unit',
            templateRef: 'writer-chapter',
            roleName: 'writer'
        });
        const { text: chapterText } = buildBrief(store, chapterItem, resolveHarness(store, chapterItem));

        expect(chapterText).toContain(
            'Write the unit named above (you are the only thing that writes story artifacts \u2014 P10, D-17b).'
        );
        expect(chapterText).not.toContain('Invention is the job here');
    });

    it('asks only for the Summary-targeted verdict when a Critic review carries no draft ref (defensive, S-2)', () => {
        const { store } = seedStore();

        seedCriticTemplate(store);

        const item = itemFor({
            id: 'wi_review_summary_0',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: { kind: 'summary', ref: 'summary_0' }
        });

        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // No `revisionRef` in the job means no invented draft target: the single required line is
        // stated, and the two-line contract is not offered with one of its two refs missing.
        expect(text).toContain(
            'Put the goal verdict in the pass\u2019s ONE terminal report, at `target_ref` `summary_0` — the record the Goal\u2019s criteria are graded against. ' +
                'A verdict filed at the draft alone is display evidence for the crew panel, not the line the Goal is measured on.'
        );
        expect(text).toContain(
            'the ONE terminal `submitVerdict` report you end with, at `target_ref` `summary_0`;'
        );
        // The two-line form cannot appear with only one ref to aim it at, and the retired
        // "call the tool twice" framing is gone from this section with the rest of the build.
        expect(text).not.toContain('then at `target_ref`');
        expect(text).not.toContain('the draft this brief carries');
        expect(text).not.toContain('Report the verdict TWICE');
        expect(text).not.toContain('against the revision named above');
    });

    it('labels a phase-② Critic pass as a chapter-contract review, not a Summary review (the phase mismatch this fixes)', () => {
        // The chapter lane dispatches `check_unit` with NO unit, so the phase is the only artifact
        // signal. Before this fix the item got the Summary banner while its job line named chapter
        // contracts, and the role prompt's C-14/C-15 calibration rode along into a prose-free phase.
        const { store } = seedStore({ phase: 'plotlines' });

        seedCriticTemplate(store);

        const item = itemFor({
            id: 'wi_check_chapter_0',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: undefined
        });

        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // The banner is prepended to the ROLE section, so the model meets the phase before it meets
        // the Author-editable role prompt it is overriding.
        expect(text.indexOf('PASS MODE — CHAPTER-CONTRACT REVIEW')).toBeLessThan(
            text.indexOf('You are a Critic (D-30): you judge the Overview against the Seed from one angle.')
        );
        expect(text).toContain('Phase: plotlines.');
        expect(text).toContain(
            'PASS MODE — CHAPTER-CONTRACT REVIEW (this overrides any wider instruction in the role prompt below). The chapter contracts and the phrase seed are in this brief'
        );
        expect(text).toContain(
            'use C-7, C-8 or C-9 for a chapter contract and C-0 through C-6 for the plotline contract the chapter fails'
        );
        expect(text).toContain('Judge CONTRACTS, not prose');
        expect(text).toContain(
            'The pass ends with ONE terminal report — `submitVerdict` carrying the goal verdict at the Story row AND every finding in `findings[]`'
        );
        // The job line is the chapter contract, filed at the Story row, and it never cites the
        // Summary-phase criteria.
        expect(text).toContain('Read the chapter contracts named above against the phrase seed.');
        expect(text).toContain(
            'put them in the `findings[]` array of the ONE terminal `submitVerdict`, each at `target_ref` `story_0`'
        );
        expect(text).toContain('never cite `C-14` or `C-15` here');
        // One goal verdict at the Story row: the Summary's two-line contract cannot ride in here.
        expect(text).toContain(
            'Put the goal verdict in the pass\u2019s ONE terminal report, at `target_ref` `story_0` — the whole Story the chapter contracts are graded against. The findings ride in that same report as `findings[]`; there is no draft line to file.'
        );
        expect(text).toContain(
            'is filed as a `findings[]` entry of the ONE terminal `submitVerdict` you end with, at `target_ref` `story_0`'
        );
        // The Summary banner and the Summary job sentence are gone, with the sentence the Author
        // screenshot showed in the wrong phase.
        expect(text).not.toContain('PASS MODE — REVIEW (this overrides');
        expect(text).not.toContain('Read the Summary named above');
        expect(text).not.toContain('BOTH verdict lines');
        expect(text).not.toContain('never a C-14 finding');
    });

    it('labels a phase-③ Critic pass as a prose review, where C-10 through C-13 are reportable', () => {
        // Phase ③ writes the sentences, so the Summary-phase rule "prose is never an Issue" is
        // backwards here. The prose banner states the override rather than leaving the role prompt
        // (editable by the Author) to carry it.
        const { store } = seedStore({ phase: 'chapters' });

        seedCriticTemplate(store);

        const item = itemFor({
            id: 'wi_check_chapter_0',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: undefined
        });

        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain('Phase: chapters.');
        expect(text).toContain(
            'PASS MODE — PROSE REVIEW (this overrides any wider instruction in the role prompt below). The chapter prose and its contract are in this brief'
        );
        expect(text).toContain(
            'Judge the PROSE this phase wrote: C-10, C-11, C-12 and C-13 apply, and word choice, sentence shape, grammar and register ARE reviewable here — the Summary-phase rule that prose is never an Issue does not apply to this pass.'
        );
        expect(text).toContain(
            'Read the chapter prose named above against its contract and the criteria. C-10, C-11, C-12 and C-13 apply;'
        );
        expect(text).toContain(
            'Put the critical and major issues in the `findings[]` array of the ONE terminal `submitVerdict`, each at `target_ref` `story_0`'
        );
        expect(text).toContain('— the whole Story the prose is graded against.');
        // Neither the Summary banner nor the chapter-contract banner belongs to this phase.
        expect(text).not.toContain('PASS MODE — REVIEW (this overrides');
        expect(text).not.toContain('PASS MODE — CHAPTER-CONTRACT REVIEW');
        expect(text).not.toContain('Read the Summary named above');
        expect(text).not.toContain('BOTH verdict lines');
    });

    it('keeps the Summary review banner when a Summary sample is reviewed in a later phase (S-2)', () => {
        // The unit kind wins over the phase: a phase-① deep review can be dispatched after the Story
        // has advanced, and a stale phase must not put the prose banner on a Summary review.
        const { store } = seedStore({ phase: 'chapters' });

        seedCriticTemplate(store);

        const item = itemFor({
            id: 'wi_review_summary_0',
            templateRef: 'critic-genre',
            roleName: 'critic',
            // `seedStory` mints the Story's own Summary row (`summary_0`); the draft ref is the one a
            // deep-review candidate carries (`loop/work.ts`) — named, not rowed, which is all the
            // verdict clause needs.
            unit: { kind: 'summary', ref: 'summary_0' },
            revisionRef: 'revision_0'
        });

        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text.indexOf('PASS MODE — REVIEW')).toBeLessThan(
            text.indexOf('You are a Critic (D-30): you judge the Overview against the Seed from one angle.')
        );
        expect(text).toContain(
            'PASS MODE — REVIEW (this overrides any wider instruction in the role prompt below). The Summary sample and the Seed are in this brief'
        );
        expect(text).toContain('Find the issues that matter and put them in the `findings[]` array of the one terminal `submitVerdict`');
        expect(text).toContain(
            'Put BOTH verdict lines in the pass\u2019s ONE terminal report'
        );
        expect(text).toContain('BOTH verdict lines sit in the ONE terminal `submitVerdict` report you end with');
        // The phase banners belong to the other two lanes; the Summary sample keeps its own rules.
        expect(text).not.toContain('PASS MODE — CHAPTER-CONTRACT REVIEW');
        expect(text).not.toContain('PASS MODE — PROSE REVIEW');
        expect(text).not.toContain('Read the chapter contracts named above');
        expect(text).not.toContain('Read the chapter prose named above');
    });

    it('names no invented artifact id when a Critic review carries no unit ref (defensive, S-2)', () => {
        const store = Store.empty();

        seedStory(store, { phase: 'summary' });
        seedCriticTemplate(store);

        const item = itemFor({
            id: 'wi_review_summary_0',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: undefined
        });

        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // With no ref in the item the brief points at the heading rather than asserting an id it does
        // not hold (a fabricated ref is the failure mode the fallback exists to avoid).
        expect(text).toContain(
            'Put the goal verdict in the pass\u2019s ONE terminal report, at the Summary unit this job names under ARTIFACT UNDER REVIEW above — this job carries no artifact ref of its own, so read the id from that heading'
        );
        expect(text).toContain(
            'the ONE terminal `submitVerdict` report you end with, at the Summary unit this job names under ARTIFACT UNDER REVIEW above;'
        );
        // No concrete-ref form is invented, and the old revision-only wording cannot come back.
        expect(text.includes('target_ref')).toBe(false);
        expect(text).not.toContain('against the revision named above');
    });

    it('names the unit, the phase and the permission row so a fresh context knows what it may do (D-17a, T-1a)', () => {
        const { store } = seedStore();
        const item = itemFor();
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain(
            'You are a reader: you read and report — `submitVerdict`, `raiseFinding`, `createTask`, `editTask`, `requestAuthor` (T-1b).'
        );
    });

    it('carries the open tasks the job must clear and the selected Ideas it must absorb (S-2, D-11, D-29)', () => {
        const { store } = seedStore();

        seedTask(store, 'story_0');
        seedIdea(store, 'story_0', { unit_ref: 'chapter_0' });

        const item = itemFor({ taskRefs: ['task_0'] });
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // Exact rendered lines — the queue (not a transcript) is the plan (D-11), and the brief has
        // to quote it correctly or the run works on the wrong thing.
        expect(text).toContain(
            'Tasks this job must clear (1):\n- task_0 [open, writer-prose, p1, C-4, 0 attempt(s)]: pay off the 1911 map in chapter 3'
        );
        expect(text).toContain(
            'SELECTED IDEAS THIS RUN MUST ABSORB (D-29 — selected, not yet written in)\n- idea_0 (direction, by critic-continuity, unverified)\nthe steeple bell should ring under the water'
        );
    });

    it('renders a missing Digest or Goal as a stated absence rather than a hole (T-6a, D-13, G-4)', () => {
        const store = Store.empty();
        const story = seedStory(store);

        seedChapter(store, story.id);

        const item = itemFor();
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain('(no Goal row for this Story — the built-in criteria below are all it has, G-4)');
        expect(text).toContain(
            '(no Digest record yet — this is the first pass. If you need one to judge, file a `digest_gap` finding, D-13.)'
        );
        // The headings survive an empty body: a trimmed or missing section stays visible (S-2).
        expect(text).toContain('# DIGEST (derived by the engine, never a crew: D-12a)');
    });

    it('shows the competing drafts to a select and a merge run only (D-21)', () => {
        const base = seedStore({ drafts: 2 });

        for (const kind of ['check_unit', 'write_unit', 'verify_findings'] as const) {
            const item = itemFor({ kind });
            const { text, sections } = buildBrief(base.store, item, resolveHarness(base.store, item));

            expect(sections.includes(REVISIONS_HEADING)).toBe(false);
            expect(text.includes('revision_id=revision_0')).toBe(false);
            // D-21 is about the draft BODIES, not just the ids: a Writer that can see its sibling's
            // prose converges, and a converging panel is not a panel (L-16).
            expect(text.includes('DRAFT 1')).toBe(false);
        }

        for (const kind of ['select', 'merge'] as const) {
            const item = itemFor({ kind });
            const { text, sections } = buildBrief(base.store, item, resolveHarness(base.store, item));

            expect(sections).toContain(REVISIONS_HEADING);
            // Side by side, in the stable id order, with each draft's verdicts named (T-2a needs the
            // verdicts to be readable at the moment of choice).
            expect(text).toContain(
                'revision_id=revision_0 · state=competing · verdicts: none\nDRAFT 1 — ' + 'x'.repeat(40)
            );
            expect(text).toContain(
                'revision_id=revision_1 · state=competing · verdicts: none\nDRAFT 2 — ' + 'x'.repeat(40)
            );
        }
    });

    it('keeps another chapter’s prose out of the brief and carries its one line instead (E-1, D-13)', () => {
        const { store } = seedStore();

        // A whole-Story job: the chapter LIST is the artifact, one line per chapter (E-1). The prose
        // of every chapter in one brief is context rot re-imported through the front door (P2).
        const whole = itemFor({ kind: 'whole_story_check', unit: undefined });
        const wholeBrief = buildBrief(store, whole, resolveHarness(store, whole));

        expect(wholeBrief.text).toContain('- chapter_0 · 1 · The Return [drafting, round 1, no selected revision]');
        expect(wholeBrief.text).toContain('- chapter_1 · 2 · The Reservoir [drafting, round 1, no selected revision]');
        expect(wholeBrief.text.includes('SECOND CHAPTER PROSE')).toBe(false);
        expect(wholeBrief.text.includes('The ridge was where she had put the ridge.')).toBe(false);

        // A chapter job: exactly one chapter's prose, and never its sibling's (D-21 for the drafts,
        // E-1 for the rest of the book).
        const chapterItem = itemFor();
        const chapterBrief = buildBrief(store, chapterItem, resolveHarness(store, chapterItem));

        expect(chapterBrief.text).toContain('The ridge was where she had put the ridge.');
        expect(chapterBrief.text.includes('SECOND CHAPTER PROSE')).toBe(false);
    });

    it('quotes the journal for "what changed since the last pass", and never a run row (S-2, P11, P3)', () => {
        const { store, chapter } = seedStore();

        // An ordinary Author edit (D-12: the crew absorbs it on the next pass) — attributed, with a
        // `why`, which is exactly what the section is made of.
        store.chapters.update(
            chapter.id,
            { summary: 'Maren reaches the ridge and lies about it.' },
            {
                run_ref: null,
                author: true,
                why: 'the Author changed the chapter summary by hand'
            }
        );

        // A spawned run row plus a heartbeat: bookkeeping, not a story fact (P3), and excluded so
        // `brief_hash` cannot depend on when the run was spawned.
        store.runs.create(
            {
                story_id: 'story_0',
                work_item_ref: 'work_1',
                template_ref: 'reader-consistency',
                role: 'reader',
                session_ref: '',
                state: 'spawning',
                started_at: new Date().toISOString(),
                tokens: 0,
                kind: 'work',
                no_op: false,
                delegated: []
            },
            RUN
        );
        store.runs.update('run_0', { state: 'working' }, RUN);

        const item = itemFor();
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain('- update chapter_0: the Author changed the chapter summary by hand');
        expect(text.includes('run_0')).toBe(false);
        expect(text.includes('lease heartbeat')).toBe(false);
        // The unit-touching note outranks an unrelated one (E-3: the context of THIS job).
        expect(text.indexOf('- update chapter_0')).toBeLessThan(text.indexOf('- create story_0'));
    });

    it('trims the change notes and clips fields before it would ever drop the reading (E-3, E-0, D-13)', () => {
        // Forty drafts at 2k each: even the last rung of the ladder (400 characters per field) cannot
        // fit them, so the brief goes OVER budget with the Seed, the Digest, the criteria and the
        // artifact intact — E-0 forbids trading a rule for a number.
        const { store } = seedStore({ drafts: 40, draftLength: 2_000 });
        const item = itemFor({ kind: 'select' });
        const brief = buildBrief(store, item, resolveHarness(store, item));

        // Ten 40k drafts cannot fit; the ladder reaches its last rung and clips EVERY draft body,
        // which the clip marker makes countable — one marker per draft, so a section that quietly
        // disappeared instead of being clipped would fail here (S-2's trim must stay visible).
        expect(brief.text.match(/clipped for the brief/g)?.length).toBe(40);
        // The clip is exactly the last rung's 400 characters of body: the `DRAFT 1 — ` label is 10
        // characters, so 390 of the filler survive. Exact, because E-3 is a bound, not an estimate.
        expect(/DRAFT 1 — (x+)/.exec(brief.text)?.[1]).toHaveLength(390);
        // …and drops the change notes entirely, with the heading kept so the trim is visible (S-2).
        expect(brief.text).toContain('(trimmed for brief size — the journal holds the rest)');
        expect(brief.sections).toContain('WHAT CHANGED SINCE THE LAST PASS');
        // E-0 in code: the Seed, the Digest, the criteria and the artifact stay in, and the brief
        // goes over budget rather than trading a rule for a number.
        expect(brief.text).toContain('SEED — Author truth, read-only for you at every phase, forever');
        expect(brief.text).toContain('DIGEST rev 1 (derived by the engine, never a crew: D-12a)');
        expect(brief.text).toContain('C-7 · HARD · you judge it');
        expect(brief.text).toContain(
            'ARTIFACT UNDER REVIEW — chapter chapter_0 — The Return (order 1, state drafting)'
        );
        expect(brief.text.length > BRIEF_CHAR_BUDGET).toBe(true);
    });

    it('is a pure function of stored state, so brief_hash survives re-assembly and a spawned run (D-12a, §4.13, S-4a)', () => {
        const { store, chapter } = seedStore({ drafts: 2 });
        const item = itemFor({ kind: 'select' });
        const harness = resolveHarness(store, item);

        const first = buildBrief(store, item, harness);
        const second = buildBrief(store, item, harness);

        expect(second.text).toBe(first.text);
        expect(second.hash).toBe(first.hash);
        expect(second.hash).toBe(hashBrief(second.text));

        // Spawn bookkeeping changes the store without changing what a run would be TOLD.
        store.runs.create(
            {
                story_id: 'story_0',
                work_item_ref: 'work_1',
                template_ref: 'reader-consistency',
                role: 'reader',
                session_ref: '',
                state: 'spawning',
                started_at: new Date().toISOString(),
                tokens: 0,
                kind: 'work',
                no_op: false,
                delegated: []
            },
            RUN
        );
        store.runs.update('run_0', { state: 'working', session_ref: 'sess_run_0', brief_hash: first.hash }, RUN);

        const third = buildBrief(store, item, harness);

        expect(third.text).toBe(first.text);
        expect(third.hash).toBe(first.hash);

        // A real story fact DOES change it — the hash is a content key, not a constant.
        store.chapters.update(chapter.id, { title: 'The Ridge' }, { run_ref: null, author: true, why: 'rename' });
        const fourth = buildBrief(store, item, harness);

        expect(fourth.hash === first.hash).toBe(false);
        expect(
            fourth.text.includes('# ARTIFACT UNDER REVIEW — chapter chapter_0 — The Ridge (order 1, state drafting)')
        ).toBe(true);
    });

    it('hashes with sha256, so the key is the one an auditor can recompute (§4.13)', () => {
        // The published sha256 of the empty string — an independent value, so the test does not
        // merely restate the implementation.
        expect(hashBrief('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(hashBrief('the Seed and the map')).toBe(
            'c3b6bd988675c4f06dd302d0d026d3115f466cbb21e76d992f62fae90000d757'
        );
    });
});

// ---------------------------------------------------------------------------
// Phase 1's two shared inputs (§3.3, §5) and the two new tool kinds
// ---------------------------------------------------------------------------

describe('brief — the Seed Brief, the Knowledge, and the new Phase-1 kinds', () => {
    it('carries the derived Seed Brief and the critical/high Knowledge right after the Seed (§3.3, §5)', () => {
        const { store, story } = seedStore();

        store.seedBriefs.create(
            {
                story_id: story.id,
                seed_hash: 'abcd1234',
                logline: 'A cartographer finds her map is wrong.',
                protagonist: 'Maren',
                want: 'to prove the map',
                need: 'to accept the water',
                obstacle: 'the reservoir',
                stakes: 'her memory',
                setting: 'a drowned valley, 1963',
                world_rules: ['no magic', 'the reservoir is engineering'],
                promise: 'map and territory reconcile',
                tone_hints: 'cold, precise',
                constraints: ['no flashbacks'],
                open_questions: ['who flooded the valley?'],
                status: 'accepted'
            },
            AUTHOR_ATTR
        );

        // The compiler's filter and order, plus a `detail` the BRIEF must omit (E-3): the tool run
        // can `readKnowledge` for the rest, while the sampling prefix keeps it (§5).
        store.knowledge.create(
            {
                story_id: story.id,
                kind: 'place',
                topic: 'harbour',
                claim: 'The harbour freezes in January.',
                detail: 'A DETAIL THE BRIEF MUST NOT CARRY',
                importance: 'critical',
                sources: [{ url_or_title: 'Atlas', claim: 'freezes', accessed_at: '1963-01-01' }],
                fingerprint: 'K-aaa',
                seen_count: 1,
                author: 'researcher'
            },
            AUTHOR_ATTR
        );
        store.knowledge.create(
            {
                story_id: story.id,
                kind: 'period',
                topic: 'revolver',
                claim: '1880 revolvers hold six rounds.',
                importance: 'high',
                sources: [{ url_or_title: 'https://example.test/revolver', claim: 'six rounds', accessed_at: '1963-01-01' }],
                fingerprint: 'K-bbb',
                seen_count: 1,
                author: 'researcher'
            },
            AUTHOR_ATTR
        );
        // `normal` never enters a brief's Knowledge section either (the same filter, §5).
        store.knowledge.create(
            {
                story_id: story.id,
                kind: 'fact',
                topic: 'coin',
                claim: 'A shilling was twelve pence.',
                importance: 'normal',
                sources: [],
                fingerprint: 'K-ccc',
                seen_count: 1,
                author: 'researcher'
            },
            AUTHOR_ATTR
        );

        const item = itemFor();
        const early = buildBrief(store, item, resolveHarness(store, item)).sections;
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // P5 is stated IN the heading: the brief is derived, and the Seed above it stays law.
        expect(early.indexOf(`SEED BRIEF (structured from the Author's Seed — derived, the Seed itself stays law, P5)`)).toBe(
            early.indexOf('SEED — Author truth, read-only for you at every phase, forever') + 1
        );
        expect(early.indexOf('KNOWLEDGE — critical and high')).toBe(
            early.indexOf(`SEED BRIEF (structured from the Author's Seed — derived, the Seed itself stays law, P5)`) + 1
        );
        expect(early.indexOf(`DIGEST rev 1 (derived by the engine, never a crew: D-12a)`)).toBe(
            early.indexOf('KNOWLEDGE — critical and high') + 1
        );

        expect(text).toContain(
            `SEED BRIEF (structured from the Author's Seed — derived, the Seed itself stays law, P5)\n` +
                'seed_hash: abcd1234\n' +
                'logline: A cartographer finds her map is wrong.\n' +
                'protagonist: Maren\n' +
                'want: to prove the map\n' +
                'need: to accept the water\n' +
                'obstacle: the reservoir\n' +
                'stakes: her memory\n' +
                'setting: a drowned valley, 1963\n' +
                'world_rules:\n- no magic\n- the reservoir is engineering\n' +
                'promise: map and territory reconcile\n' +
                'tone_hints: cold, precise\n' +
                'constraints:\n- no flashbacks\n' +
                'open_questions:\n- who flooded the valley?'
        );
        expect(text).toContain(
            'KNOWLEDGE — critical and high\n' +
                '[K-aaa · critical · place] harbour: The harbour freezes in January. — source: Atlas\n' +
                '[K-bbb · high · period] revolver: 1880 revolvers hold six rounds. — source: https://example.test/revolver'
        );
        expect(text).not.toContain('A DETAIL THE BRIEF MUST NOT CARRY');
        expect(text).not.toContain('K-ccc');
    });

    it('omits both parts when the Story has no accepted brief and no prompt-worthy Knowledge (§5)', () => {
        const { store } = seedStore();
        const item = itemFor();
        const brief = buildBrief(store, item, resolveHarness(store, item));

        expect(brief.text).not.toContain('SEED BRIEF');
        expect(brief.text).not.toContain('KNOWLEDGE — critical and high');
        expect(brief.sections).not.toContain(`SEED BRIEF (structured from the Author's Seed — derived, the Seed itself stays law, P5)`);
    });

    it('gives the Researcher its own etiquette: Knowledge is the only write, every entry cites a source (P10, T-10)', () => {
        const { store } = seedStore();

        seedTemplate(store, {
            name: 'researcher-story',
            roles: [
                {
                    name: 'researcher',
                    kind: 'researcher',
                    web: true,
                    prompt: 'You research the period and the place, and you never write the book.'
                }
            ],
            serves_phase: ['summary', 'plotlines', 'chapters']
        });

        const item = itemFor({
            templateRef: 'researcher-story',
            roleName: 'researcher',
            kind: 'research',
            unit: { kind: 'summary', ref: 'summary_0' }
        });
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain(
            'You are the Researcher: never write a story artifact (P10) — no Summary, plotline, chapter, Idea, verdict or finding. Your writes are `writeKnowledge` and `retireKnowledge` only; `readKnowledge` is how you check what is already known before you research it again.'
        );
        expect(text).toContain(
            'Every entry cites a source you actually read, and the source backs the claim you attached it to (T-10). A claim you cannot source belongs in a task or in `requestAuthor`, not in Knowledge — escalate rather than guess (P7).'
        );
        // D-51: the research job is scoped to the Editor's questions, and the EMPTY answer has to be
        // taught as a report — a Researcher that finds nothing and says nothing is a no-op turn
        // counted against the Story (S-4), which is exactly the failure D-51 exists to prevent.
        expect(text).toContain('Work the questions this job names');
        expect(text).toContain('close the pass with `reportNoResearch` and one line saying why');
        // §7.2's permission row is still stated beside it (T-1a: refuse, teach, never silently allow).
        expect(text).toContain('You are the Researcher: you search the web and record what you find');
        // …and that row names the zero-write report too, so "may I end with nothing?" is answered by
        // the permission line as well as by the etiquette.
        expect(text).toContain('`reportNoResearch` closes it, writing nothing (D-51)');
    });

    it('names the two new Phase-1 artifacts in the artifact heading (§6.1)', () => {
        const { store } = seedStore();

        seedTemplate(store, {
            name: 'editor-seed-structure',
            roles: [{ name: 'editor', kind: 'editor', prompt: 'You structure the Seed.' }],
            serves_phase: ['summary']
        });
        seedTemplate(store, {
            name: 'researcher-story',
            roles: [{ name: 'researcher', kind: 'researcher', prompt: 'You research.' }],
            serves_phase: ['summary']
        });

        // `unit: undefined` is the whole-Story shape these two passes have: the structure pass reads
        // the Seed, and the research pass gathers facts for it — neither names a chapter.
        const structureItem = itemFor({
            templateRef: 'editor-seed-structure',
            roleName: 'editor',
            kind: 'structure_seed',
            unit: undefined
        });
        const researchItem = itemFor({
            templateRef: 'researcher-story',
            roleName: 'researcher',
            kind: 'research',
            unit: undefined
        });

        const structure = buildBrief(store, structureItem, resolveHarness(store, structureItem));
        const research = buildBrief(store, researchItem, resolveHarness(store, researchItem));

        expect(structure.sections).toContain(
            'ARTIFACT UNDER REVIEW — the Seed (structure pass — you derive the brief, never edit the Seed, P5)'
        );
        expect(research.sections).toContain("ARTIFACT UNDER REVIEW — the Story's knowledge (research pass)");
        // `seed_review` is gone, not aliased: the old heading must never render again.
        expect(structure.text).not.toContain('the Seed (Author truth, read-only for you — P5)');
        // D-51: the structuring job states the research decision it owes `structureSeed`, and says in
        // the same breath that an empty list is a complete answer — the waiver has to be a choice the
        // run can see it making, not a field it might happen to forget.
        expect(structure.text).toContain('`research_questions`: the facts a draft could NOT get from the Seed alone');
        expect(structure.text).toContain('`[]` is a complete answer, not a shortcut');
        expect(structure.text).toContain('Do not invent a research hook to fill the list');
    });

    // F1 — a phase-① RESEARCH PREREQUISITE pass is Summary-scoped. `work.ts:phase1FixPrerequisites`
    // hands the job `{ kind: 'summary', ref: summaryRef }`: `brief.ts:renderArtifact` branches on
    // `item.unit.kind` and `renderSelectedIdeas` scopes on `item.unit?.ref`, so a bare artifact id (the
    // first cut of this fix) matched no branch and the Researcher was dispatched with an EMPTY
    // ARTIFACT UNDER REVIEW section — asked to ground a fact about the Summary without ever being shown
    // the Summary — and its Ideas scoping silently widened to the whole Story.
    it('hands a Summary-scoped research pass the artifact it is grounding the fact about (F1)', () => {
        const { store, story } = seedStore();

        seedTemplate(store, {
            name: 'researcher-story',
            roles: [{ name: 'researcher', kind: 'researcher', prompt: 'You research.' }],
            serves_phase: ['summary']
        });
        const task = seedTask(store, story.id, {
            kind: 'fix',
            title: 'source the public-housing pet rule this Summary asserts',
            owner_role: 'researcher'
        });

        const prereq = itemFor({
            id: 'wi_research_fix_task_1_a1',
            templateRef: 'researcher-story',
            roleName: 'researcher',
            kind: 'research',
            unit: { kind: 'summary', ref: 'summary_0' },
            taskRefs: [task.id]
        });

        const brief = buildBrief(store, prereq, resolveHarness(store, prereq));

        // The heading a research pass carries, and the BODY the Summary unit is what unlocks.
        expect(brief.sections).toContain('ARTIFACT UNDER REVIEW — the Story\'s knowledge (research pass)');
        expect(brief.text).toContain('Summary:');
        expect(brief.text).toContain('A return to a mapped valley that no longer matches the map.');
        expect(brief.text).toContain('She floods the valley on purpose.');
        // The task the pass must settle is rendered into THE JOB (S-2), so the run knows the exact
        // question and its done condition.
        expect(brief.text).toContain('source the public-housing pet rule this Summary asserts');
    });
});

describe('SUMMARY PHRASE — the brief gives a phase-① pass the group ids it has to cite (R3)', () => {
    /**
     * The same group-managed book the group compilers use (`run/phase1-prompt.test.ts`): the Story moved
     * to `summary_mode: groups` and the five catalog groups with PINNED ids. The mirror text is the one
     * `run/mock.ts:seedStory` already writes, so the only new state is the switch and the rows.
     */
    function seedGroupStore() {
        const { store, story: seeded } = seedStore();
        const story = store.stories.update(
            seeded.id,
            { summary_mode: 'groups' },
            { ...AUTHOR_ATTR, why: 'seed: a group-managed Summary (R1)' },
            [{ id: seeded.id, rev: seeded.rev }]
        );
        let next = 100;
        const groups = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!.groups;

        return { store, story, groups };
    }

    /** A phase-① Reviewer pass over the Summary unit — the job whose findings must carry `group_refs`. */
    function reviewItem(): WorkItem {
        return {
            id: 'work_2',
            storyId: 'story_0',
            kind: 'check_unit',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: { kind: 'summary', ref: 'summary_0' }
        };
    }

    it('prints the book’s group ids beside their keys, so the Reviewer copies what it sees', () => {
        const group = seedGroupStore();
        const item = reviewItem();
        const { text } = buildBrief(group.store, item, resolveHarness(group.store, item));

        // The exact line, in catalog order, in the SAME `key=id` shape `reader.ts:raiseFinding` prints
        // in its R3 refusal — the pair the model copies has to be the pair the engine wrote.
        const pairs = group.groups.map((entry) => `${entry.key}=${entry.id}`).join(', ');

        expect(text).toContain(
            `phrase_groups: ${pairs} — a defect on this Summary names in group_refs the group or groups it is about (R3)`
        );
        // The job line says "the Summary block ABOVE", so the assembly order is part of the contract:
        // `assembleBrief` puts ARTIFACT UNDER REVIEW before THE JOB, and a reordering would make that
        // sentence a lie. Pinned positionally rather than by a range check.
        expect(text.indexOf("phrase_groups: ")).toBeLessThan(text.indexOf("# THE JOB"));
        // And the job says what to do with them, because the ids alone are not an instruction.
        expect(text).toContain('copy the `phrase_groups` pairs the Summary block above prints into `group_refs`');
        expect(text).toContain('the Summary in front of you is the OVERVIEW of five separately revised groups');
    });

    it('says nothing about groups on a whole-Summary book, where an unscoped finding still means the Overview', () => {
        const { store } = seedStore();
        const { text } = buildBrief(store, reviewItem(), resolveHarness(store, reviewItem()));

        expect(text).not.toContain('phrase_groups: ');
        expect(text).toContain('summary_id: summary_0');
    });

    it('teaches the Editor pass the scope a confirmed finding is closed by (R3)', () => {
        const { store, story } = seedStore();
        const item: WorkItem = {
            ...reviewItem(),
            id: 'work_3',
            kind: 'verify_findings',
            templateRef: 'editor-general',
            roleName: 'editor'
        };
        const { text } = buildBrief(store, item, resolveHarness(store, item));

        expect(text).toContain('dispute the scope rather than confirming it');
    });
});

// ---------------------------------------------------------------------------
// THE STRUCTURE SEAT — its closing sentence, and the one section a seat may be trimmed of
// (S-4, E-3, E-0, R7, T-W2)
//
// ONE Work Item kind serves both phrases' structuring passes (`structure_seed` — `loop/work.ts` arms
// Phrase ①'s Seed pass and Phrase ②'s chapter pass with it), and the seat is the CLAIM KEY
// (`phrase/controller.ts:phraseStructureSeatOf`). Two things follow, and both are pinned below rather
// than argued:
//   D-a — the sentence that closes the run names the tools THIS seat may end on. Phrase ②'s seat ends on
//     `structurePlotlines` and is never told about `structureSeed` (that call writes the OTHER phrase's
//     Seed Brief, and it SUCCEEDS doing it); Phrase ①'s seat keeps `structureSeed` and is never offered
//     the Phrase ② call. The union itself is untouched for every other crew, and the phase-① sentence is
//     byte-identical to what it said before `structurePlotlines` joined the catalogue.
//   D-b — the seat's own artifact section (`PHRASE SEED`) is untrimmable, so when the brief still will
//     not fit E-3 the section that goes is the phase-① `SEED BRIEF` — the derived projection of a Seed
//     this seat is not structuring, which the seat's own job sentence already calls "context only"
//     (`phrase/controllers/plotlines.ts:plotlinesStructureJob`). The rung is a TRIM: it fires only on an
//     over-budget seat brief, and a phase-① seat (whose `seedSection` is undefined) never meets it.
// ---------------------------------------------------------------------------

describe('THE STRUCTURE SEAT — the closing sentence and the seat-aware trim (S-4, E-3, E-0, R7)', () => {
    /** Phrase ②'s seed as the Author handed it to the phrase — short, so every length below is checkable by hand. */
    const PLOTLINE_SEED =
        '## Premise\nA lighthouse keeper owes a debt she cannot pay in money.\n\n## Ending\nShe pays it in the light.';

    /**
     * A book Phrase ② has been armed on: Story at `plotlines` + Summary + Goal + Digest, an ACCEPTED
     * phase-① Seed Brief, and the Plotlines Phrase carrying `PLOTLINE_SEED`.
     *
     * The accepted brief is the load-bearing part of the fixture: without that row the `SEED BRIEF`
     * section would be absent for want of data, and its absence from the seat's brief would prove
     * nothing about the trim rung. The role prompt's length is the knob that decides whether the seat
     * brief fits E-3 — the only condition the rung is allowed to act on.
     */
    function seatFixture(rolePrompt: string) {
        const { store, story } = seedStore({ phase: 'plotlines' });

        seedTemplate(store, {
            name: 'editor-plotlines-structure',
            roles: [{ name: 'editor', kind: 'editor', prompt: rolePrompt }],
            serves_phase: ['plotlines']
        });
        // The phase-① Seed Brief this book already accepted, in the state `structureSeed` leaves it.
        store.seedBriefs.create(
            {
                story_id: story.id,
                seed_hash: 'abcd1234',
                logline: 'A keeper owes a debt she cannot pay in money.',
                protagonist: 'the keeper',
                want: 'to keep the light',
                need: 'to give it up',
                obstacle: 'the debt',
                stakes: 'the ships',
                setting: 'a lighthouse, 1911',
                world_rules: ['no magic'],
                promise: 'the debt is paid in the light',
                tone_hints: 'cold',
                constraints: ['no flashbacks'],
                open_questions: ['who signed for the lamp?'],
                status: 'accepted'
            },
            AUTHOR_ATTR
        );
        const phrase = startPlotlinesPhrase(store, story, PLOTLINE_SEED, AUTHOR_ATTR).phrase;

        // The two structuring seats, same Story, same template — the ONLY difference is the claim-key
        // family, which is exactly what `phraseStructureSeatOf` routes on (R7).
        const plotlinesSeat: WorkItem = {
            id: 'wi_structure_plotlines_fac9695f',
            storyId: story.id,
            kind: 'structure_seed',
            templateRef: 'editor-plotlines-structure',
            roleName: 'editor',
            unit: undefined
        };
        const seedSeat: WorkItem = { ...plotlinesSeat, id: 'wi_structure_seed_abcd1234' };

        return { store, story, phrase, plotlinesSeat, seedSeat };
    }

    /** Over E-3: the role prompt is padded, so the seat brief reaches the trim ladder's last rung. */
    const LONG_PROMPT = 'You read the phrase seed once and decide the chapter set. '.repeat(120);
    /** Under E-3: the same seat, same rows, a brief that fits. */
    const SHORT_PROMPT = 'You read the phrase seed once and decide the chapter set.';

    /** The one `End the run ONLY after reporting…` etiquette line, without its list-marker. */
    const s4Line = (text: string): string =>
        text
            .split('\n')
            .find((line) => line.startsWith('- End the run ONLY after reporting'))
            ?.slice(2) ?? '(no S-4 line)';

    it('ends the Phrase ② seat on `structurePlotlines`, and never on `structureSeed` (S-4, R7)', () => {
        const { store, plotlinesSeat } = seatFixture(SHORT_PROMPT);
        const { text } = buildBrief(store, plotlinesSeat, resolveHarness(store, plotlinesSeat));

        // The exact sentence, for the seat whose only write is the Phrase ② structuring call: its own
        // tool is IN the closing list, and the phase-① tool it must not end on is OUT.
        expect(s4Line(text)).toBe(
            'End the run ONLY after reporting with one of: submitVerdict, raiseFinding, createTask, ' +
                'requestAuthor, proposeIdea, verifyIdea, verifyFinding, confirmFinding, reviewSeed, ' +
                'selectRevision, requestMerge, rejectAll, structurePlotlines, writeKnowledge, ' +
                'reportNoResearch (S-4). What costs the Story a turn is the missing REPORT, never an empty ' +
                'set of findings: a pass that files nothing and reports that the text holds has done its ' +
                'job, while a run that ends without one of these calls is a no-op turn counted against the ' +
                'Story — and a Writer run that wrote nothing and escalated nothing is a bug in its brief, ' +
                'not a cost.'
        );
        // The one `structureSeed` mention C1's probe found in this brief (`Temp/c1/probe-10-after.log`)
        // was THIS sentence. It is now zero, while the seat's own tool is still named by its job text.
        expect(text.split('structureSeed').length - 1).toBe(0);
        expect(text.includes('call `structurePlotlines` ONCE with `chapter_count`')).toBe(true);
    });

    it('keeps naming `structureSeed` to the Phase ① seat, and never offers it `structurePlotlines` (S-4, R7)', () => {
        const { store, seedSeat } = seatFixture(SHORT_PROMPT);
        const brief = buildBrief(store, seedSeat, resolveHarness(store, seedSeat));

        expect(s4Line(brief.text)).toBe(
            'End the run ONLY after reporting with one of: submitVerdict, raiseFinding, createTask, ' +
                'requestAuthor, proposeIdea, verifyIdea, verifyFinding, confirmFinding, reviewSeed, ' +
                'selectRevision, requestMerge, rejectAll, structureSeed, writeKnowledge, ' +
                'reportNoResearch (S-4). What costs the Story a turn is the missing REPORT, never an empty ' +
                'set of findings: a pass that files nothing and reports that the text holds has done its ' +
                'job, while a run that ends without one of these calls is a no-op turn counted against the ' +
                'Story — and a Writer run that wrote nothing and escalated nothing is a bug in its brief, ' +
                'not a cost.'
        );
        expect(brief.text.split('structurePlotlines').length - 1).toBe(0);
        // THE SENTENCE A PHASE-① BRIEF PRINTED BEFORE `structurePlotlines` JOINED THE CATALOGUE IS THE
        // SENTENCE IT PRINTS NOW, byte for byte: `reportToolsForStructureSeat(false)` is the old union
        // with the new name cut back out. This is the AC4 guarantee at the sentence level; the whole-brief
        // byte identity is carried by `brief_hash` (see `Temp/c6/probe-brief.ts`, 96999f0d… before and
        // after).
        expect(brief.text).toContain('End the run ONLY after reporting with one of: submitVerdict');
    });

    it('hands every run that is not a structure seat S-4’s whole union, both structuring writes included (S-4)', () => {
        const { store } = seatFixture(SHORT_PROMPT);
        // The ordinary `check_unit` job `seedStore` is shaped for (`brief.test.ts:itemFor`).
        const review = itemFor();
        const { text } = buildBrief(store, review, resolveHarness(store, review));

        // A run that is not a seat has no structuring write to be confused by, and the union is the
        // accounting answer it deserves: either name landing is work the loop must not re-dispatch.
        expect(s4Line(text)).toContain('rejectAll, structureSeed, structurePlotlines, writeKnowledge, reportNoResearch');
    });

    it('trims the phase-① SEED BRIEF out of an over-budget seat brief, and nothing else (E-3, E-0, D-b)', () => {
        const { store, plotlinesSeat } = seatFixture(LONG_PROMPT);
        const brief = buildBrief(store, plotlinesSeat, resolveHarness(store, plotlinesSeat));

        // The data is there — a non-seat brief over the SAME store renders the section, so what follows
        // is a trim, not a hole.
        const review = itemFor();
        const { sections: reviewerSections, text: reviewerText } = buildBrief(
            store,
            review,
            resolveHarness(store, review)
        );

        expect(reviewerSections).toContain(SEED_BRIEF_HEADING);
        expect(reviewerText).toContain('logline: A keeper owes a debt she cannot pay in money.');

        // The seat's section list, EXACTLY: eleven sections became ten, and the one that went is the
        // phase-① Seed Brief. Every other heading — the ROLE prompt, the criteria, the raw Seed, the
        // seat's own PHRASE SEED, the Digest, the artifact, the job, the notes, the Ideas and the
        // etiquette — is pinned in render order, so a future rung cannot quietly take a second one.
        expect(brief.sections).toEqual([
            'ROLE — editor (editor) of editor-plotlines-structure',
            `PHASE AND GOAL CRITERIA — ${store.stories.get('story_0')?.title ?? 'story_0'}`,
            'SEED — Author truth, read-only for you at every phase, forever',
            expect.stringMatching(/^PHRASE SEED — the text Phrase ② resolves into chapters .* · seed_hash=[0-9a-f]{8,}$/),
            'DIGEST rev 1 (derived by the engine, never a crew: D-12a)',
            expect.stringMatching(/^ARTIFACT UNDER REVIEW — the Phrase ② seed /),
            'THE JOB',
            'WHAT CHANGED SINCE THE LAST PASS',
            'SELECTED IDEAS THIS RUN MUST ABSORB (D-29 — selected, not yet written in)',
            'TOOLS AND HOW TO END'
        ]);
        expect(brief.sections).not.toContain(SEED_BRIEF_HEADING);
        expect(brief.text).not.toContain('logline: A keeper owes a debt she cannot pay in money.');
        // F3 — THE JOB SENTENCE HAS TO SURVIVE THE TRIM IT DESCRIBES. This is the render that proves the rung
        // fired (the heading is gone above), so it is also the only place the copy can be checked AGAINST the
        // trimmed brief: the seat is told the trade and told to read the headings actually on the page, and it is
        // NOT told the section sits "beside" anything. The sentence's exact bytes live in
        // `phrase/plotlines-structure-seat.test.ts`; what belongs here is the pairing — section dropped AND no
        // presence claim — because either half on its own passes the old wording.
        expect(brief.text).toContain(
            'and so is the derived `SEED BRIEF` — and that second heading is NOT one this brief guarantees you'
        );
        expect(brief.text).not.toContain('`SEED BRIEF` beside it');
        // The block the seat no longer pays for, measured on the SAME store: the reviewer's brief renders
        // the same accepted row through the same renderer, so what is in it and missing from the seat's
        // brief IS the trim — no fixture-local magic number involved.
        const blockOf = (text: string, heading: string): string => {
            const start = text.indexOf(`# ${heading}\n`);

            if (start === -1) return '';

            const next = text.indexOf('\n# ', start + 1);

            return text.slice(start, next === -1 ? text.length : next);
        };

        expect(blockOf(reviewerText, SEED_BRIEF_HEADING).length).toBeGreaterThan(0);
        expect(blockOf(brief.text, SEED_BRIEF_HEADING)).toBe('');
        // E-3 is STILL not met, and that is the honest outcome (E-0): the ladder's last rung and this one
        // are both spent, and what is left is the ROLE prompt, the criteria, the seat's own seed and the
        // job — the material E-0 refuses to trade for a character count. The measured before/after on the
        // real built-in template: `Temp/c1/probe-10-after.log` (15,438, the accepted pre-C6 state) →
        // `Temp/c6/probe-after-2.log` (14,878, 11 sections → 10, every other section byte-sized the same).
        expect(brief.text.length > BRIEF_CHAR_BUDGET).toBe(true);

        // AND THE SEED ITSELF IS UNTOUCHED (E-0, D-13): the section the trim exists to protect still
        // carries the phrase's whole text, byte for byte, with the hash the tool compares.
        const seedHeading = brief.sections.find((heading) => heading.startsWith('PHRASE SEED'))!;
        const seedBody = brief.text.slice(brief.text.indexOf(seedHeading) + seedHeading.length);

        expect(seedBody.trimStart().startsWith(`${PLOTLINE_SEED}\n\nseed_hash=`)).toBe(true);
        expect(brief.text.includes(PLOTLINE_SEED)).toBe(true);
        // The job text and the ROLE prompt — the two other sections a size fix could have raided — are
        // rendered whole: nothing was clipped out of the seat's own instruction.
        expect(brief.text.includes('You read the phrase seed once and decide the chapter set. '.repeat(120))).toBe(
            true
        );
        expect(brief.text.includes('call `structurePlotlines` ONCE with `chapter_count`')).toBe(true);
    });

    it('keeps the SEED BRIEF for a seat brief that FITS the budget — the rung is a trim, not a mounting rule (E-0)', () => {
        const { store, plotlinesSeat } = seatFixture(SHORT_PROMPT);
        const brief = buildBrief(store, plotlinesSeat, resolveHarness(store, plotlinesSeat));

        expect(brief.text.length <= BRIEF_CHAR_BUDGET).toBe(true);
        // Under budget, nothing is traded: the section is handed to the seat even though it belongs to
        // the other phrase, because E-0 refuses to spend a section on a number that was never exceeded.
        expect(brief.sections).toContain(SEED_BRIEF_HEADING);
        expect(brief.text).toContain('logline: A keeper owes a debt she cannot pay in money.');
        // F3 — THE OTHER ARM OF THE SAME SENTENCE. The job text is composed before this file knows whether the
        // rung will fire, so the seat that DOES receive the section is told the same non-promise: nothing about
        // presence, everything about the trade. If these two briefs ever print different wording, the copy has
        // become trim-aware by accident and one of the two arms is lying.
        expect(brief.text).toContain(
            'and so is the derived `SEED BRIEF` — and that second heading is NOT one this brief guarantees you'
        );
    });

    it('never trims the phase-① seat brief, whose artifact section already is the Seed (E-0, R7)', () => {
        const { store, seedSeat } = seatFixture(LONG_PROMPT);
        const brief = buildBrief(store, seedSeat, resolveHarness(store, seedSeat));

        // Over budget AND a structure seat — and the section STAYS, because Phrase ①'s `seedSection`
        // returns `undefined`: for this seat the Seed Brief is the artifact its own call writes, and the
        // rung is keyed on the seat declaring a section of its own, never on a phrase name.
        expect(brief.text.length > BRIEF_CHAR_BUDGET).toBe(true);
        expect(brief.sections).toContain(SEED_BRIEF_HEADING);
        expect(brief.sections.some((heading) => heading.startsWith('PHRASE SEED'))).toBe(false);
        expect(brief.sections).toContain(
            'ARTIFACT UNDER REVIEW — the Seed (structure pass — you derive the brief, never edit the Seed, P5)'
        );
    });
});
