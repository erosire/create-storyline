// W5 acceptance for the brief (S-2, E-1, E-3, D-13, D-21, D-29, G-4, §4.13 `brief_hash`).
//
// Every assertion is an EXACT value, because the brief is an audit artifact: `runs.brief_hash`
// records what a run was told, and D-12a's "any past Digest is reconstructible" only holds if this
// text is a pure function of stored state. Fuzzy assertions here would hide the two failure modes
// the design actually has — a section silently missing (D-13: the run goes and reads the book), and
// a section whose wording moves between assemblies (which makes `brief_hash` useless as a key).
import { readFileSync } from 'node:fs';

import { Store, type Attribution } from '../store';
import { hashBrief, buildBrief, assembleBrief, BRIEF_CHAR_BUDGET, REVISIONS_HEADING } from './brief';
import { resolveHarness } from './harness';
import { ensurePhraseCatalog } from '../phrase/catalog';
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

/** The §4.13 attribution a run's own bookkeeping carries (P11). */
const RUN: Attribution = { run_ref: 'run_0', why: 'lease heartbeat (S-4a)' };

/**
 * A seeded Story in the state a `check_unit` job arrives at: Story + Summary + Goal + Digest +
 * plotline + two chapters, one of which carries prose nobody but this chapter's crew may see.
 *
 * Ids are the store's own minted values (`story_0`, `summary_0`, `chapter_0`, …), which is what
 * makes every assertion below an exact one.
 */
function seedStore(options: { digests?: number; drafts?: number; draftLength?: number; chapters?: number } = {}) {
    const store = Store.empty();
    const story = seedStory(store);
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
 * A long note is the whole point of the fixture — at ~1,530 characters the note is always clipped,
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
        expect(text).toContain('Done means: every critical and major issue you found is filed');
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

        // Pinned: the note is ~2.5× the clip, so the brief below carries a TRUNCATED note — the shape
        // that hid the verdict instruction in the shipped build (it named the right ref past char 600).
        // The number moved when T3 front-loaded the admissibility clause into the window (it had lived
        // at characters 950-1,320 of the shipped note, i.e. never sent at all). It moved again (+78) when
        // D-33b spelled the Issue/Proposal split into the sweep note — a deliberate lengthening, and the
        // window assertions below, not this number, are what the doctrine depends on: the two kinds and
        // the absence rule now sit at characters 0-240, so the rewording pushed nothing past the clip.
        expect(note.length).toBe(1_520);

        const item = itemFor({
            id: 'wi_review_revision_0_a1',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: { kind: 'summary', ref: 'summary_0' },
            revisionRef: revision.id,
            note
        });

        const { text } = buildBrief(store, item, resolveHarness(store, item));

        // -- R1: the JOB names both records and says which one the Goal reads ----------------------
        // `criteria/engine.ts:scopeTargets` yields the Summary id for every `summary`-level criterion
        // (C-14); `summaryDraftEvidenceRefs` admits ONLY the currently selected draft's line as that
        // row's evidence. The brief asks for both filings: the Summary line the Goal reads, and the
        // draft line U-13's per-draft panel needs (D-21, §6.2a).
        expect(text).toContain(
            'Report the verdict TWICE with `submitVerdict`, about the same text and reaching the same answer: ' +
                'first at `target_ref` `summary_0` — the Summary unit the Goal\u2019s criteria are graded against, and the line the Goal actually reads — ' +
                'then at `target_ref` `revision_0`, the draft this brief carries, which is the per-draft record the crew panel and the revision rail read (D-21, U-13).'
        );

        // -- R2: the pass's own done-definition names the SAME two targets -------------------------
        // (the template's proposal-style done-line is still replaced, not stacked, D-30).
        expect(text).toContain(
            'the goal verdict is filed with `submitVerdict` at `target_ref` `summary_0` AND at `target_ref` `revision_0`'
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
        expect(carriedNote).toContain('File TWO verdicts with submitVerdict');
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
        expect(note.length).toBe(1_528);

        const carried = note.slice(0, NOTE_CHAR_CLIP);

        expect(carried.length).toBe(NOTE_CHAR_CLIP);
        expect(carried).toContain('File TWO verdicts with submitVerdict');
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
        expect(text).toContain(
            'An absence is never an issue, but it may be a PROPOSAL: where the draft contradicts nothing and you can still name a change that would genuinely make the book better, file it with `kind: proposal`'
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
        // the crew otherwise discovers by spending a turn on it. The four open states are named because
        // `approved` is the state a crew reads as "handled" and it is not a resolution.
        expect(verifyText).toContain(
            'ISSUES COME FIRST, and they gate the approval as well as the verdict (D-33d): while any issue on this Story is unresolved'
        );
        expect(verifyText).toContain(
            '`fixed` or `discarded` is what closes one, so `unconfirmed`, `confirmed`, `approved` and `disputed` all still hold it'
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

        // No `revisionRef` in the job means no invented draft target: the single required filing is
        // stated, and the "TWICE" contract is not offered with one of its two refs missing.
        expect(text).toContain(
            'Report the goal verdict with `submitVerdict` at `target_ref` `summary_0` — the record the Goal\u2019s criteria are graded against. ' +
                'A verdict filed at the draft alone is display evidence for the crew panel, not the line the Goal is measured on.'
        );
        expect(text).toContain('the goal verdict is filed with `submitVerdict` at `target_ref` `summary_0`;');
        expect(text).not.toContain('Report the verdict TWICE');
        expect(text).not.toContain('against the revision named above');
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
            'Report the goal verdict with `submitVerdict` at the Summary unit this job names under ARTIFACT UNDER REVIEW above — this job carries no artifact ref of its own, so read the id from that heading'
        );
        expect(text).toContain(
            'the goal verdict is filed with `submitVerdict` at the Summary unit this job names under ARTIFACT UNDER REVIEW above;'
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
