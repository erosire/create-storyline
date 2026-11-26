// W8 acceptance — the built-in catalogue is coherent, the T-0 structural rules refuse the
// assignments that would break the loop, and a built-in can be DUPLICATED into the Author's own
// crew without the built-in moving (D-17, P12).
import {
    BUILT_IN_TEMPLATES,
    DEFAULT_ASSIGNMENT,
    duplicateTemplate,
    validateAssignment,
    validateTemplate
} from './templates';
import type { Story, StoryPhase, Template, TemplateRole } from '../../shared/types';

const byName = (name: string): Template => {
    const found = BUILT_IN_TEMPLATES.find((template) => template.name === name);

    if (!found) throw new Error(`the built-in roster no longer contains "${name}"`);

    return found;
};

/** A Story carrying only the field `validateAssignment` reads (the phase), typed as §4.1. */
function storyAt(phase: StoryPhase): Story {
    return {
        id: 'story_1',
        rev: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        title: 'Cold Mountain',
        phase,
        idea: 'A cartographer returns to the valley she mapped as a girl.',
        summary_locked: phase !== 'summary',
        plotlines_locked: phase === 'chapters',
        pending_kind: 'none',
        status: 'ready',
        trend: 'unknown',
        auto_approve: ['critical', 'major'],
        author_stop: false,
        digest_rev: 0,
        template_refs: [],
        chapter_deps: {}
    };
}

/** A minimal harness for the assignment rules — one role, one phase, the attempts under test. */
function harness(name: string, kind: TemplateRole['kind'], serves: StoryPhase[], attempts = 1): Template {
    return {
        id: name,
        rev: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        name,
        title: name,
        roles: [{ name: kind, kind, prompt: `the ${kind} brief` }],
        serves_phase: serves,
        done_definition: `${kind} work is finished`,
        attempts,
        builtin: false,
        editable: true,
        // D-17c: an Editor without selection_rules is invalid, so the fixture carries one.
        ...(kind === 'editor' ? { selection_rules: 'prefer the colder draft' } : {})
    } as Template;
}

describe('W8 — the built-in catalogue (§4.12)', () => {
    it('every built-in template validates', () => {
        // The roster's own errors, printed rather than hidden, because a failure here is a
        // prompt or role the Author would otherwise first meet as a runtime refusal.
        const failures = BUILT_IN_TEMPLATES.map((template) => [template.name, validateTemplate(template)]).filter(
            ([, errors]) => (errors as string[]).length > 0
        );

        expect(failures).toEqual([]);
    });

    it('the roster is the crews the Phase-1 pipeline, §6.2 and §14 item 10 name, and every one is duplicate-only (D-17)', () => {
        // T-W2 appends Phrase ②'s two crews at the END of the roster (the structure gate and the
        // contract sampler). They are last on purpose: `records.ts:templatesFor` keeps catalogue
        // order, and `work.ts:candidate` takes `pool[0]` for an UNBOUND seat — a row inserted before
        // `writer-plotlines` would become the phase-② `write_unit` crew and change what a
        // classic-mode Story's run looks like.
        expect(BUILT_IN_TEMPLATES.map((template) => template.name)).toEqual([
            'editor-seed-structure',
            'researcher-story',
            'writer-summary-sampler',
            'writer-plotlines',
            'writer-chapters',
            'editor-general',
            'critic-screening',
            // Phrase ②'s tool-less review voice (bound by `run/phase1-prompt.ts:PLOTLINES_SCREEN_TEMPLATE_SLUG`).
            // It is a separate row because `critic-screening`'s C-14/C-15 criteria and Summary calibration are
            // wrong for chapter contracts, and R7 keeps the binding sentences engine-owned either way.
            'critic-screening-plotlines',
            'editor-group-lock',
            'critic-genre',
            'critic-plausibility',
            'critic-audience',
            'critic-mystery',
            'reader-consistency',
            // D-65's score-only reader (`run/phase1-prompt.ts:SCORE_TEMPLATE_SLUG`): the seat the scoring pass
            // compiles from, which files nothing (P6).
            'reader-score',
            'reader-prose',
            'writer-plotlines-sampler',
            'editor-plotlines-structure'
        ]);

        for (const template of BUILT_IN_TEMPLATES) {
            expect([template.builtin, template.editable]).toEqual([true, false]);
        }

        // One Writer per loop (L-4: separate templates and separate done-definitions).
        expect(byName('writer-summary-sampler').serves_phase).toEqual(['summary']);
        expect(byName('writer-plotlines').serves_phase).toEqual(['plotlines']);
        expect(byName('writer-chapters').serves_phase).toEqual(['chapters']);

        // The Seed-structuring Editor, the group-lock Editor, the four deep-review Critic angles and the
        // screening Critic, plus the two readers.
        expect(byName('editor-seed-structure').roles.map((role) => role.kind)).toEqual(['editor']);
        expect(byName('editor-general').roles.map((role) => role.kind)).toEqual(['editor']);
        // R-lock: the lock review is an EDITOR seat (`loop/work.ts` candidate 2c dispatches it with
        // roleKind `editor`), and the slug is the one `run/phase1-prompt.ts:GROUP_LOCK_TEMPLATE_SLUG`
        // compiles its system turn from. The catalogue carrying the row is what replaces the
        // `fallbackRolePrompt` stand-in, so the slug must be pinned here rather than only in the prompt
        // tests — a rename on either side silently changes which copy the seat runs on.
        expect(byName('editor-group-lock').roles.map((role) => role.kind)).toEqual(['editor']);
        expect(
            [
                'critic-screening',
                'critic-screening-plotlines',
                'critic-genre',
                'critic-plausibility',
                'critic-audience',
                'critic-mystery'
            ].map((name) => byName(name).roles[0].kind)
        ).toEqual(['critic', 'critic', 'critic', 'critic', 'critic', 'critic']);
        expect(byName('reader-consistency').roles[0].kind).toBe('reader');
        expect(byName('reader-score').roles[0].kind).toBe('reader');
        expect(byName('reader-prose').roles[0].kind).toBe('reader');
    });

    it('the old tool-writing Summary Writer is gone: the Sampler is the only Phase-1 Writer', () => {
        // The Phase-1 redesign replaced `writer-summary` with the sample → screen → select
        // pipeline. No backward compatibility is kept, so the slug must not survive anywhere in
        // the roster — a leftover would be a second, differently-behaved Phase-1 Writer.
        expect(BUILT_IN_TEMPLATES.map((template) => template.name)).not.toContain('writer-summary');
        expect(DEFAULT_ASSIGNMENT).not.toContain('writer-summary');
    });

    it('§8: the four Phase-1 pipeline crews carry the fixed slugs, phases, kinds and single turns', () => {
        // `editor-seed-structure` — the Seed-structuring Editor. Its selection_rules exist
        // because D-17c demands them of every Editor template, and they state the structuring
        // checklist rather than a taste in drafts.
        const structure = byName('editor-seed-structure');

        expect([
            structure.title,
            structure.serves_phase,
            structure.attempts,
            structure.delegation,
            structure.max_concurrent
        ]).toEqual(['Editor — Seed structure', ['summary'], 1, [], 1]);
        expect(structure.roles.map((role) => [role.name, role.kind, role.web, role.agents])).toEqual([
            ['editor', 'editor', false, 1]
        ]);
        expect(structure.selection_rules).toContain('STRUCTURING CHECKLIST');
        // P5/P10 and the one-write contract live in the prompt, because the tool list cannot say
        // what a role must NOT do (D-17a).
        expect(structure.roles[0].prompt).toContain('structureSeed');
        expect(structure.roles[0].prompt).toContain('open_questions');
        expect(structure.roles[0].prompt).toContain('never edit');
        // D-51: the research decision is part of THIS one call, and the prompt has to teach both halves
        // of it — that the field must be stated, and that an empty list is a legitimate answer rather
        // than a gap to be filled with an invented question.
        expect(structure.roles[0].prompt).toContain('research_questions');
        expect(structure.roles[0].prompt).toContain('[] is a complete answer');
        expect(structure.roles[0].prompt).toContain('Do not invent research hooks');
        expect(structure.selection_rules).toContain('research_questions');
        expect(structure.done_definition).toBe(
            'An accepted Seed Brief whose seed_hash matches the current Seed, every non-optional field present, and a stated research decision: research_questions holds the facts the Researcher must establish, or [] when the premise needs nothing outside itself (D-51).'
        );
        expect(structure.escalation_rule).toBe(
            'requestAuthor when the Seed is internally contradictory; never edit the Seed.'
        );

        // `researcher-story` — the only Knowledge writer, dispatched for every phase.
        const researcher = byName('researcher-story');

        expect([
            researcher.title,
            researcher.serves_phase,
            researcher.attempts,
            researcher.delegation,
            researcher.max_concurrent
        ]).toEqual(['Researcher — Story knowledge', ['summary', 'plotlines', 'chapters'], 1, [], 1]);
        expect(researcher.roles.map((role) => [role.name, role.kind, role.web, role.agents])).toEqual([
            ['researcher', 'researcher', true, 1]
        ]);
        // T-10: leads from searchWeb, evidence from fetchPage, and one entry per claim.
        expect(researcher.roles[0].prompt).toContain('searchWeb');
        expect(researcher.roles[0].prompt).toContain('fetchPage');
        expect(researcher.roles[0].prompt).toContain('writeKnowledge');
        expect(researcher.roles[0].prompt).toContain('readKnowledge');
        // D-51: the pass is scoped to the questions the job names, and the empty answer is a REPORT —
        // both belong in the role prompt, because the tool list cannot say "you may stop with nothing".
        expect(researcher.roles[0].prompt).toContain('reportNoResearch');
        expect(researcher.roles[0].prompt).toContain('Work the questions this job names');
        expect(researcher.done_definition).toBe(
            'The facts the Seed Brief\u2019s world_rules/setting depend on are covered, every critical/high entry cites at least one source, and no entry duplicates an open one — OR the pass closed with reportNoResearch, having reported that nothing in this premise needs a fact from outside the book (D-51).'
        );

        // `writer-summary-sampler` — no tools, one turn, one `SummarySample`.
        const sampler = byName('writer-summary-sampler');

        expect([
            sampler.title,
            sampler.serves_phase,
            sampler.attempts,
            sampler.delegation,
            sampler.max_concurrent
        ]).toEqual(['Summary Writer (sampler)', ['summary'], 1, [], 6]);
        expect(sampler.roles.map((role) => [role.name, role.kind, role.web, role.agents])).toEqual([
            ['writer', 'writer', false, 1]
        ]);
        expect(sampler.roles[0].prompt).toContain('NO tools');
        expect(sampler.roles[0].prompt).toContain('SummarySample');
        expect(sampler.roles[0].prompt).toContain('chapter_count');
        expect(sampler.roles[0].prompt).toContain('knowledge_used');
        // H1/R1 — the sampler is also the REVISER, and the role prompt is the only place a tool-less
        // run can learn that a refinement round edits the base draft instead of redrawing it. The
        // compiled prompt says it again next to the draft; this is the half that survives a template
        // swap, because an Author's custom sampler replaces the compiled system turn entirely.
        expect(sampler.roles[0].prompt).toContain('BASE REVISION and FIX TASKS');
        expect(sampler.roles[0].prompt).toContain('this is hill-climbing repair, not another attempt at the brief');
        expect(sampler.roles[0].prompt).toContain('A rewrite from scratch throws away');
        expect(sampler.roles[0].prompt).toContain('Restating the same commitment in different words answers none of the tasks');
        expect(sampler.done_definition).toBe(
            "A schema-valid answer delivered in one turn with no tool calls: on a group-managed book, one entry for every group the job named, none for a group it did not name, and none twice (R2); on a legacy sampled book, one SummarySample."
        );
        // A tool-less run holds nothing that could escalate, so no escalation rule is claimed.
        expect(sampler.escalation_rule).toBeUndefined();

        // `critic-screening` — no tools, one turn, one `IssueList` of critical/high only.
        const screening = byName('critic-screening');

        expect([
            screening.title,
            screening.serves_phase,
            screening.attempts,
            screening.delegation,
            screening.max_concurrent
        ]).toEqual(['Critic (screening)', ['summary'], 1, [], 6]);
        expect(screening.roles.map((role) => [role.name, role.kind, role.web, role.agents])).toEqual([
            ['critic', 'critic', false, 1]
        ]);
        expect(screening.roles[0].prompt).toContain('IssueList');
        expect(screening.roles[0].prompt).toContain('{"issues":[]}');
        expect(screening.roles[0].prompt).toContain('C-14');
        expect(screening.roles[0].prompt).toContain('C-15');
        // H1/R2 — the same pass now also certifies the repair, by task id, with a quotation.
        expect(screening.roles[0].prompt).toContain('fix_verifications');
        expect(screening.roles[0].prompt).toContain('SELECTED DRAFT');
        expect(screening.roles[0].prompt).toContain('A different phrasing of the same commitment is not a resolved fix');
        // H1/R6 — the calibration lives HERE, in the Summary-phase role prompt, because the schema
        // cannot say what `critical` means at this phase. Wording is named as non-reportable, which
        // is what stops a round being spent on a comma (and resampling forever over a taste).
        expect(screening.roles[0].prompt).toContain('Word choice, sentence structure, grammar');
        expect(screening.roles[0].prompt).toContain('are NOT issues at this phase');
        expect(screening.done_definition).toBe(
            "A schema-valid review delivered in one turn with no tool calls: critical and high issues only, every issue carrying the `group_refs` it is about on a group-managed book (R3), one `fix_verifications` entry for every FIX TASKS id the prompt named, and an empty issues list when the text holds."
        );
        expect(screening.escalation_rule).toBeUndefined();
    });

    // PHRASE ②'s STRUCTURED REVIEW VOICE — the row `run/phase1-prompt.ts:PLOTLINES_SCREEN_TEMPLATE_SLUG`
    // compiles its system turn from, the twin of `critic-screening` for the chapter lane. It exists because
    // the Summary row's criteria (C-14/C-15) and its "a Summary is a set of facts" calibration are simply
    // false for chapter contracts, and because the phase-② seat is tool-less: its prompt is the whole
    // contract, so the chapter rules have to be HERE (D-17a) while the binding sentences stay engine-owned
    // (`run/phase1-prompt.ts:CONTRACT_SCREEN_INSTRUCTION`, R7).
    it('Phrase ② has its own tool-less review voice, and it produces review notes rather than findings', () => {
        const screening = byName('critic-screening-plotlines');
        const role = screening.roles[0];

        // The row's shape mirrors `critic-screening`: a tool-less, one-turn, structured-answer seat, scoped to
        // the ONE phase it judges (L-4), with the same `max_concurrent: 6` ceiling as a review seat that
        // writes nothing (`work.ts:candidate` reads it for the S-5 limit).
        expect([
            screening.title,
            screening.serves_phase,
            screening.attempts,
            screening.delegation,
            screening.max_concurrent
        ]).toEqual(['Critic (chapter contracts, screening)', ['plotlines'], 1, [], 6]);
        expect(screening.roles.map((entry) => [entry.name, entry.kind, entry.web, entry.agents])).toEqual([
            ['critic', 'critic', false, 1]
        ]);
        // A run with no tools holds no tool that could escalate (the same absence `critic-screening` pins).
        expect(screening.next_phase).toBe('');
        expect(screening.escalation_rule).toBeUndefined();
        expect(screening.description).toBe(
            'One turn, no tools: answers the compiled Phrase ② review prompt with one structured GroupReview object of critical and high chapter-contract defects only. Every issue names the chapter group_refs it is about and quotes each named chapter; the pass produces review notes, not findings.'
        );
        // The done-line states the schema-shaped answer AND the quote-every-named-chapter rule, because that
        // scope is what the deep review routes the repair by (R3's join, chapter edition).
        expect(screening.done_definition).toBe(
            'A schema-valid review delivered in one turn with no tool calls: critical and high chapter-contract issues only, every issue carrying the `group_refs` it is about and a quote for each named chapter, one `fix_verifications` entry for every FIX TASKS id, and an empty issues list when the contracts hold.'
        );

        // ONE turn, ONE `GroupReview`, every issue scoped, and the fix certificate by task id.
        expect(role.prompt).toContain(
            'You have NO tools in this run and exactly one turn: answer with ONE JSON object matching the `GroupReview` schema — an `issues` array in which EVERY issue names its `group_refs`, plus a `fix_verifications` entry for every task the FIX TASKS section names — and nothing else (no prose frame, no tool call, no question back).'
        );
        expect(role.prompt).toContain('Report ONLY critical and high problems.');
        // The artifact is the chapter set against the PHRASE seed, and a sparse contract is a valid contract
        // — the calibration the Summary row cannot carry.
        expect(role.prompt).toContain(
            'What is in front of you is the CHAPTER CONTRACTS as the book now holds them, and the PHRASE SEED.'
        );
        expect(role.prompt).toContain(
            'A contract may be SPARSE and still correct: judge it as a contract, not as a scene nobody wrote, and never report a note because you would have staged the chapter differently — phase ③ writes the sentences.'
        );
        // The criteria: the chapter contract's own ladder, never the Summary's C-14/C-15.
        expect(role.prompt).toContain(
            'Cite the criterion in `criterion`: `C-7`, `C-8` or `C-9` for a chapter contract, `C-0` through `C-6` for the plotline contract the chapter fails, or `seed` for a direct breach of the phrase seed.'
        );
        expect(role.prompt).toContain('Never cite `C-14` or `C-15` here: those are the Summary’s criteria.');
        // R3, chapter edition: the primary quote's chapter is FIRST, and every OTHER named chapter carries
        // its own `group_quotes` entry — a named-but-unquoted chapter would be rewritten for a sentence
        // nobody read (`phrase/findings.ts:findingGroupScope` closes on every id the note names).
        expect(role.prompt).toContain(
            'Put the chapter your `quote` came from FIRST in `group_refs`, then every other chapter the defect crosses.'
        );
        // THE SCHEMA'S REQUIRED `detail` IS NAMED HERE NOW (2026-11-27), in the same sentence as the
        // per-chapter evidence rule: `shared/schemas/group-review.ts` puts `detail` in `required` with
        // `minLength: 1`, and this seat answers in `json_object` mode when the provider downgrades (§4.2),
        // where the schema is not on the wire — the copy is the only thing that tells it the field exists.
        expect(role.prompt).toContain(
            'Put the primary quote in `quote`; for every OTHER chapter you name, add a `group_quotes` entry with that chapter’s `group_ref`, its `quote` and its `location` — do not name a chapter you have not quoted from. `detail` is what is wrong and where (chapter and section), and it is required.'
        );
        expect(role.prompt.match(/`detail`/g)).toHaveLength(1);
        // THE ONE-REPORT CONTRACT, from the other side: this seat files nothing at all, so a tool sentence
        // pasted into its copy would be an instruction it cannot obey (D-30).
        expect(role.prompt).toContain(
            'This pass produces REVIEW NOTES for the deep review; it does not file findings, open tasks, or submit a verdict.'
        );
        expect(role.prompt).not.toContain('raiseFinding');
        expect(role.prompt).not.toContain('submitVerdict');
        expect(role.prompt).toContain('Return {"issues":[]} when the contracts hold.');
    });

    // D-65's SCORE-ONLY VOICE — the row `run/phase1-prompt.ts:SCORE_TEMPLATE_SLUG` compiles from. The number
    // is a display surface the loop never reads (P6), so this row's whole job is to hold no filing copy at
    // all: the tool-carrying review voice stays `reader-consistency`.
    it('D-65 — the score-only reader scores every section once and holds no filing copy', () => {
        const scorer = byName('reader-score');
        const role = scorer.roles[0];

        // It serves every phase (the score seat re-arms wherever the crew installs text), one turn, one
        // concurrent seat, and it delegates nothing: a structured turn has no sub-context to hand work to.
        expect([scorer.title, scorer.serves_phase, scorer.attempts, scorer.delegation, scorer.max_concurrent]).toEqual([
            'Reader — section scoring',
            ['summary', 'plotlines', 'chapters'],
            1,
            [],
            1
        ]);
        expect(scorer.roles.map((entry) => [entry.name, entry.kind, entry.web, entry.agents])).toEqual([
            ['reader', 'reader', false, 1]
        ]);
        // No web: the score is a reading of the reviewed text plus the Seed and Knowledge the prompt carries.
        expect(scorer.next_phase).toBe('');
        expect(scorer.escalation_rule).toBeUndefined();
        expect(scorer.description).toBe(
            'One turn, no tools: scores every section of the reviewed Overview 0–100 with one rationale and one quoted line per section. It files no finding, opens no task and submits no verdict (D-65).'
        );
        expect(scorer.done_definition).toBe(
            'Every section is scored exactly once with a rationale and one quoted evidence line, and the pass files no finding, task or verdict (D-65, P6).'
        );

        // The answer shape: one entry per section, a whole number 0–100, ONE rationale, ONE evidence quote.
        expect(role.prompt).toContain(
            'Your whole output is ONE JSON object matching the `SectionScores` schema: one entry per section, each naming its `group_ref`, a whole number 0–100, one `rationale`, and one `evidence` quote.'
        );
        expect(role.prompt).toContain('You have NO tools in this run and exactly one turn.');
        // The scale, not the cost ladder — a reader that silently switched to critical/major/minor would put
        // a triage where the Author reads a progress number.
        expect(role.prompt).toContain(
            'Use the 0–100 anchors exactly as the instruction states; do not substitute a critical/major/minor triage for the scale.'
        );
        // Evidence per section, quoted from the section it is about, and every section named exactly once.
        expect(role.prompt).toContain(
            'Quote one line verbatim in `evidence` for every section, taken from the section you scored, or — for a cross-section fault — from the section it contradicts; say in `rationale` which section the line came from when it is not the scored one.'
        );
        expect(role.prompt).toContain('Name every section exactly once and no section twice.');
        // THE ABSENCE THAT DEFINES THE ROW (D-65, P6): nothing in this copy may name a tool the seat does not
        // hold, and the number may not be sold as a decision the loop takes.
        for (const tool of ['raiseFinding', 'submitVerdict', 'createTask', 'readLedger', 'proposeIdea'])
            expect(role.prompt).not.toContain(tool);
        expect(role.prompt).toContain('the number is a progress surface for the Author and display work the loop never reads (P6, D-65)');
    });

    it('H1/R6 — the calibration is Summary-only: the deep review keeps the minor/taste ladder', () => {
        // The screening Critic is phase ①'s one-turn judge. The tool-using Critics rate artifacts in
        // every phase (§6.4 step 6, phase ② and ③), and there minor and taste notes ARE part of the
        // answer — re-calibrating them would silently stop the prose review from reporting prose
        // problems, which is the opposite of what H1 asked for.
        for (const name of ['critic-genre', 'critic-plausibility', 'critic-audience', 'critic-mystery']) {
            // Each of the four states its own minor/taste line in its own words; what the assertion
            // pins is that the ladder is still there, and that phase ①'s wording rule did not leak
            // into a template that serves the prose phases.
            expect(byName(name).roles[0].prompt).toMatch(/minor/i);
            expect(byName(name).roles[0].prompt).not.toContain('are NOT issues at this phase');
        }

        // Phase ③'s prose reader is the other half: wording is somebody's job, and it is not the
        // screening pass's (C-13).
        expect(byName('reader-prose').roles[0].prompt).not.toContain('are NOT issues at this phase');
    });

    it('T3 — the Writer is licensed to invent compatible specifics, not merely implications', () => {
        // The Author's rule: "Writer has liberty to fill in details not in the Seed. That is fine, and it
        // is not an issue." The sampler's prompt used to say the opposite — "an implication is legitimate,
        // a new setting rule or technology is not" — which is narrower than the licence and reads as a
        // warning against exactly the invention the Critics then complained about.
        const sampler = byName('writer-summary-sampler').roles[0];

        expect(sampler.prompt).not.toContain('an implication is legitimate');
        expect(sampler.prompt).toContain('an invented specific that does not contradict the brief is legitimate');
        expect(sampler.prompt).toContain('you are not confined to what strictly follows from it');
        // The constraints that stay (R2): the Knowledge still bounds facts, the brief still rules out what
        // it rules out, and a world_rule may not quietly replace the brief's own — the world_rules are the
        // contract every later chapter is graded against.
        expect(sampler.prompt).toContain('Do not invent a fact the Knowledge does not support');
        expect(sampler.prompt).toContain('any rule you write that contradicts or quietly replaces the brief’s own world rules');
        expect(sampler.prompt).toContain('Carry every commitment the brief states explicitly (C-14)');
        // And the Seed is still law: invention never licenses editing it (P5).
        expect(sampler.prompt).toContain('The Seed itself is Author truth and is never edited (P5)');
    });

    it('T3 — the screening Critic may not report Seed silence, and keeps every contradiction gate', () => {
        const screening = byName('critic-screening').roles[0];

        // The two absence classes from the Author's screenshots, named in the words the role would use.
        expect(screening.prompt).toContain('stakes or consequences the Seed never stated');
        expect(screening.prompt).toContain('setup the Summary did not promise are NOT issues and never a C-14 issue');
        expect(screening.prompt).toContain('the Writer may invent any specific that does not contradict it');
        // A C-14 citation must be earned, and the quote is the test that earns it.
        expect(screening.prompt).toContain('Never cite C-14 for something the Seed simply does not say');
        expect(screening.prompt).toContain('quote only an absence');
        // R2 — what is NOT relaxed: the two severities are still defined, a high is still an unpaid
        // EXPLICIT commitment, and the phrasing rule (H1/R6) still holds.
        expect(screening.prompt).toContain('A high leaves unpaid a commitment the Seed Brief states EXPLICITLY');
        expect(screening.prompt).toContain('A critical is a contradiction the text under review cannot live with');
        expect(screening.prompt).toContain('are NOT issues at this phase');
    });

    it('T3 — the four deep-review angles scope the Summary restriction and keep the later-phase checks', () => {
        // THE PHASE-ISOLATION PIN. These four templates serve phases ② and ③ as well as ①, so the rule
        // that stands down "unplanted setup" is written as `When the artifact under review is a SUMMARY`
        // and says in the same breath that the chapter/plotline setup-and-payoff review continues. This
        // is why the clause is asserted per role rather than once: a role whose scoping sentence is
        // deleted would stop reporting real phase-②/③ defects (C-4, C-5, C-6, C-10) or would keep filing
        // the Author's screenshot complaint against every Summary.
        //
        // BOTH HALVES ARE PINNED AS EXACT STRINGS, each role in its own phrasing, because a regex that
        // accepts "any reasonable wording" is what let the clause be clipped out of the shipped brief
        // while its test still passed. If one of these sentences moves, the edit below has to move with
        // it deliberately — that is the point of the pin.
        const scoping: Record<string, { silence: string; laterPhases: string; improvement: string }> = {
            'critic-genre': {
                silence:
                    'When the artifact under review is a SUMMARY (phase \u2460): the Seed is general, not an outline, and the Writer may invent any detail it does not contradict \u2014 so an added detail, a Seed question left open, stakes the Seed never stated, and a payoff that arrives without earlier planting are not genre defects at this phase.',
                laterPhases:
                    'The same setup-and-payoff checks stay in force in phases \u2461 and \u2462, where the plotlines and chapters do make those commitments.',
                // D-33b + W1: the angle's own improvement outlet — convention can be satisfied AND
                // outdone, and the second half is a proposal, not the defect this prompt spends its
                // standing on. The cost clause is still part of the pin (D-33b's ladder gives a
                // proposal `major`/`minor` and refuses `critical`, and
                // `tools/reader.ts:raiseFinding` rejects a cost outside it); the sentence no longer
                // carries the D-33c refusal, which is now stated once for all four angles.
                improvement:
                    'Convention satisfied is not the same as convention outdone: when the Summary promises what the genre asks and you can still name the better version of it, that observation is a proposal, not a defect \u2014 `kind: proposal` at cost `major` or `minor`, titled as a proposal, quoting the passage it would improve and saying what changes and why the pass is worth it.'
            },
            'critic-plausibility': {
                silence:
                    'This is a plotline and chapter check: when the artifact under review is a SUMMARY (phase \u2460) there is no ledger and no earlier chapter yet, so "nothing established it" is not a factual doubt there, and the Writer is free to establish a fact the Seed never named as long as it contradicts nothing.',
                laterPhases:
                    'Phases \u2461 and \u2462 keep every check above unchanged: there the ledger and the earlier chapters DO make those promises, and a setup that never arrives is a defect again.',
                // D-33b + W1: this angle is the one carrying a source, so its proposal is worth
                // citing — and the outlet says so once, without the refusal that used to follow it.
                improvement:
                    'And when the fact checks out but you can cite a better one \u2014 the truer detail the book could carry instead \u2014 that is a proposal, not a defect, because a text that is merely improvable has broken nothing: put it in the `findings[]` array of the one terminal `submitVerdict` as `kind: proposal`, quoting the passage it would improve, naming the source that supports the better version, and saying why the pass is worth taking.'
            },
            'critic-audience': {
                silence:
                    'When the artifact under review is a SUMMARY (phase \u2460), none of those complaints has a page to stand on unless the Summary itself promises the setup and then breaks it: the Seed is general, the Writer may invent any detail the Seed does not rule out, and an unpaid setup, an unstated stake or a consequence the Seed left open is not a reader complaint at this phase.',
                laterPhases: 'Phases \u2461 and \u2462 keep the full list \u2014 there the book has made the promise and owes the payoff.',
                // D-33b + W1: this angle's signature complaint IS an absence ("the payoff arrived
                // without the setup"). Stood down at phase ① it had nowhere to go; it routes to the
                // proposal kind, and the sentence says only that — the gating rule is shared.
                improvement:
                    'And when the unpaid setup is not a promise the Summary broke but a change its readers would thank it for, that is the audience speaking as an editor would, and it belongs in the report as a proposal: put it in the `findings[]` array of the one terminal `submitVerdict` as `kind: proposal`, quoting the passage it would improve and saying in `detail` why the payoff lands better if the setup moves.'
            },
            'critic-mystery': {
                silence:
                    'When the artifact under review is a SUMMARY (phase \u2460): there is no ledger and no chapter order yet, so do not file "it was never planted" or "the answer arrives without its setup" against one \u2014 the Writer is allowed to bring in what the Seed never stated, and the Summary\u2019s own ending is not owed an earlier hint.',
                laterPhases: 'Phases \u2461 and \u2462 keep every setup-and-payoff check in this prompt unchanged.',
                // D-33b + W1: "this came too early" was the SUSPICION framing; at phase ① there is
                // no planting to jump, so the sentence is a reorder request — the angle's outlet,
                // minus the D-33c refusal that used to be stapled to its end.
                improvement:
                    'Where the artifact under review is a SUMMARY there is no planting to jump, so the same observation is a PROPOSAL rather than a suspicion: put it in the `findings[]` array of the one terminal `submitVerdict` as `kind: proposal`, quoting the passage that gives the game away and saying in `detail` which move would earn the reveal, and the Editor weighs whether the book is better for the reorder rather than whether the Seed ever promised one.'
            }
        };

        for (const [name, clauses] of Object.entries(scoping)) {
            const prompt = byName(name).roles[0].prompt;

            // The scoping marker itself: the rule is phase-①-only, written as a condition, not a
            // blanket "absences are free" that would travel into the chapter phases. `critic-plausibility`
            // spells it mid-sentence after a colon, so the marker is matched case-insensitively — the
            // role's FULL sentence is pinned exactly below, which is where the wording is actually held.
            expect(prompt).toMatch(/when the artifact under review is a summary/i);
            expect(prompt).toContain(clauses.silence);
            // The later-phase half of the same breath — the reason deleting the clause is a regression
            // in phases ② and ③ and not just a relief in ①.
            expect(prompt).toContain(clauses.laterPhases);
            // D-33b — the outlet, stated per angle in the angle's own terms, and each one carries the
            // literal marker the Editor's two evaluation modes branch on. A role missing it can only
            // report the observation as a defect or hold it back.
            expect(prompt).toContain(clauses.improvement);
            // And the Ideas ban survives the new permission: `proposeIdea` is still the job-asked path.
            expect(prompt).toMatch(/review pass unless the job says otherwise/i);
            expect(prompt).toContain('proposeIdea');
        }

        // The ledger machinery this angle is built on is still there for the phases that have a ledger.
        expect(byName('critic-mystery').roles[0].prompt).toContain('Read the ledger');
        expect(byName('critic-plausibility').roles[0].prompt).toContain('C-5, C-6');
        expect(byName('critic-audience').roles[0].prompt).toContain('payoff that arrived without the setup');
    });

    it('D-33c/D-33d — the critic convergence rule: issues first, effort-then-value, one report', () => {
        // WHY THE SHAPE OF THIS PIN CHANGED (2026-11-26, W1). The rule used to be pinned as TWO
        // hand-copied paragraphs per angle — an `outlet` sentence that invited the improvement and
        // refused it in the same breath, and a `review` sentence that refused it again. The shipped
        // prose said the same D-33c refusal two or three times per angle, and each copy ended with a
        // retry invitation ("bring the genre move in a pass that has none left"), which is the loop
        // the owner measured: critics at 95.8% of the agent time and ten records naming a D-33c
        // refusal (`tools/reader.ts:raiseFinding`, the 2026-11-26 note on the gate). The prose now
        // states the rule ONCE, as four shared constants in `templates.ts` — `CRITIC_EFFORT_RULE`,
        // `CRITIC_PRIORITY`, `CRITIC_TERMINAL_REPORT` and `CRITIC_DISMISSAL` — with the angle's own
        // tail bolted onto the dismissal. These assertions moved with the prose, and each one still
        // tests a RULE rather than echoing a string:
        //   .effort    — the effort-then-value rule / nit-pick ban governs the pass (the owner's "a very
        //                hidden problem could take ages to find", so it is not worth a Writer round)
        //   .priority  — issues outrank proposals, and the critic reports as soon as it is CERTAIN
        //   .terminal  — one closing call carries every verdict and finding, and a two-step report is
        //                forbidden (the owner's "one tool call... that should be the end of it")
        //   .dismissal — a proposal filed while issues are open is DISMISSED, not deferred: no row, no
        //                work armed, no second hearing, and no invitation to try again
        // Each is asserted of ALL FOUR angles, which is the property four hand-copies could not give:
        // with one copy, deleting a rule breaks four angles at once and this test names it.
        const CONVERGENCE = {
            effort:
                'The rule that governs this whole pass: effort is not value, and a defect that is hard to find is not worth filing. Report the issues that surface as soon as you read for them \u2014 the contradiction in front of you, the promise the text plainly does not keep, the fact that fails one question. A filing you had to DIG for is not worth a Writer round: something you must cross-reference several times, go looking for, or build a case around before it becomes a defect was not found by this pass, and a pass spent hunting it spends the round the book needed for the defects that were easy to see. Nit-picking is not a service here: each filing costs a Writer round and every round spent on a buried blemish is a round not spent on an open break. Report what this pass surfaced, at the cost you actually believe \u2014 do not ration a defect you can already name, and do not dig for one you cannot.',
            priority:
                'Issues before proposals, always, and stop when you are certain \u2014 not when you feel you have looked enough. Writer time is finite and a broken commitment outranks a nicer alternative, so a pass that found an issue files only issues: every one you are certain of, each filed once, all of them in the same report, however many there turn out to be. A proposal is worth your turn only when the pass found no issue at all. Certainty is the trigger: the moment you can quote the defect and name its cost, it is reported \u2014 the next line you read is already spent.',
            terminal:
                'One terminal report ends the pass. When you report, you report ONCE: the single closing call — `submitVerdict` — carries every verdict the pass owes together with everything else it is certain of: every issue it found, and the one proposal the rule above allows if there is one. Do not report in two steps, and do not leave anything for the next call: it is not a summary filed after the findings, it is the report they all ride in, filed the moment you are certain. The thread is over the moment it fires: nothing after it is read, so there is no second call to make and nothing to keep hunting.',
            dismissal:
                'And while issues are open, a proposal is out of the question — not deferred, not parked for a better pass: a `kind: proposal` finding filed by a pass that also has issues to report is dismissed on sight, with no row, no work armed and no second hearing — one line of boilerplate saying the round belongs to the defects, which is not an invitation and not an answer worth a turn. So do not spend a turn naming the improvement you did not file: if the pass found no issue, the one improvement worth naming rides in that same report.'
        };

        // What stays per angle, in the angle's own voice: its improvement outlet (D-33b), the tail it
        // appends to the shared dismissal, the sentence that carries its EXPERTISE (so the rewrite for
        // convergence cannot flatten the four angles into one critic), and the sentence that binds its
        // own over-research habit (T-10), which is the angle-local half of the stop rule.
        const gating: Record<string, { outlet: string; tail: string; expertise: string; stop: string }> = {
            'critic-genre': {
                outlet:
                    'Convention satisfied is not the same as convention outdone: when the Summary promises what the genre asks and you can still name the better version of it, that observation is a proposal, not a defect \u2014 `kind: proposal` at cost `major` or `minor`, titled as a proposal, quoting the passage it would improve and saying what changes and why the pass is worth it.',
                tail:
                    'For this angle that means the convention the book could outdo, not the one it broke: name the better version of the genre move only in a pass that found no break to report.',
                expertise:
                    'Ask what a reader of this genre was promised by the premise, whether this Overview delivers it, and whether it delivers it the way the genre does — the beat, the convention, the amount of distance the reader is allowed to keep.',
                stop:
                    'Use searchWeb and fetchPage only when a specific claim needs the convention rather than your memory: one source you can cite settles it, you cite it, and the research is over.'
            },
            'critic-plausibility': {
                outlet:
                    'And when the fact checks out but you can cite a better one \u2014 the truer detail the book could carry instead \u2014 that is a proposal, not a defect, because a text that is merely improvable has broken nothing: put it in the `findings[]` array of the one terminal `submitVerdict` as `kind: proposal`, quoting the passage it would improve, naming the source that supports the better version, and saying why the pass is worth taking.',
                tail:
                    'For this angle, the improvement that waits is the truer, better-sourced detail the book could carry instead of one that is merely true.',
                expertise:
                    'Your job is the sentence that makes a reader put the book down because it is not true: a technology that does not exist in the chapter\u2019s year, a medical claim that does not hold, a motive that would not survive one question, a reference to something this Story never established.',
                stop:
                    'State the minor or taste doubts that are already obvious and no others, and when the last issue you are certain of is filed, stop \u2014 report, and the pass is over.'
            },
            'critic-audience': {
                outlet:
                    'And when the unpaid setup is not a promise the Summary broke but a change its readers would thank it for, that is the audience speaking as an editor would, and it belongs in the report as a proposal: put it in the `findings[]` array of the one terminal `submitVerdict` as `kind: proposal`, quoting the passage it would improve and saying in `detail` why the payoff lands better if the setup moves.',
                tail:
                    'For this angle, the improvement that waits is the added beat or the reorder its readers would thank the book for and which its Seed never promised.',
                expertise:
                    'Read the Summary as the book now holds it — its five groups, or one whole-Summary draft on a legacy book — and report the complaints THIS Author\u2019s own audience would file, in their words: the pacing that sags where it used to, the character who stopped being likeable for no reason the reader was given, the payoff that arrived without the setup, the line of dialogue nobody speaks, the twist that arrived too early for the reader who is two chapters ahead.',
                stop:
                    'It is not a mandate to go looking: a complaint you have to search the shelf for is not worth a Writer round.'
            },
            'critic-mystery': {
                outlet:
                    'Where the artifact under review is a SUMMARY there is no planting to jump, so the same observation is a PROPOSAL rather than a suspicion: put it in the `findings[]` array of the one terminal `submitVerdict` as `kind: proposal`, quoting the passage that gives the game away and saying in `detail` which move would earn the reveal, and the Editor weighs whether the book is better for the reorder rather than whether the Seed ever promised one.',
                tail:
                    'For this angle, the improvement that waits is the withheld reveal or the moved planting: name it in a pass that found no break, never beside one.',
                expertise:
                    'Report where the answer is spent before it is earned: a reveal that lands too early, a suspense the prose dissolves by explaining it, a setup paid off too far from its planting, a chapter doing a job its neighbour already did (C-11).',
                stop:
                    'File the critical and major issues; a minor pacing note is reportable when it is already obvious, and it is never worth a re-read of the sequence.'
            }
        };

        for (const [name, clauses] of Object.entries(gating)) {
            const prompt = byName(name).roles[0].prompt;

            // The four shared rules, verbatim, in every angle (D1, D2, D3, D4).
            expect([name, prompt.includes(CONVERGENCE.effort)]).toEqual([name, true]);
            expect([name, prompt.includes(CONVERGENCE.priority)]).toEqual([name, true]);
            expect([name, prompt.includes(CONVERGENCE.terminal)]).toEqual([name, true]);
            expect([name, prompt.includes(CONVERGENCE.dismissal)]).toEqual([name, true]);

            // The stop is IMPERATIVE ("stop when you are certain"), and the permissive wording the
            // owner objected to is gone rather than merely de-emphasised (D2). The engine-owned sweep
            // notes still carry "an empty pass is valid" — that is `loop/work.ts`, not the seat's copy.
            expect(prompt).toContain('and stop when you are certain');
            expect(prompt).not.toMatch(/you may stop|an empty pass is valid|stop once the issues/);
            // ...and each angle still binds its OWN research habit, in its own words.
            expect(prompt).toContain(clauses.stop);

            // D-33b's outlet survives the de-duplication, in the angle's own terms, and the Ideas ban
            // with it (the `review pass unless the job says otherwise` line and `proposeIdea` are
            // pinned in the phase-scoping test above).
            expect(prompt).toContain(clauses.outlet);

            // The dismissal paragraph: the shared rule and the angle's tail are ONE paragraph, joined
            // by the single space the constant ends with. That is how the rule stays one sentence while
            // still being spoken in the angle's voice (D6).
            expect(prompt).toContain(CONVERGENCE.dismissal + ' ' + clauses.tail);

            // D3 — the wasted-proposal trap is gone: the refusal sentence that invited the retry, the
            // retry itself, and the retired mirror rule cannot come back. A proposal now costs the critic
            // nothing to learn about, because the copy tells it up front that the claim is dismissed.
            expect(prompt).not.toContain('File Proposals only when no issue is open');
            expect(prompt).not.toContain('in a pass that has none left');
            expect(prompt).not.toContain('never share a pass');

            // D4 — the terminal report, and the ONE payload field this copy names. `submitVerdict`'s shape is
            // still owned by `tools/reader.ts` (its `findings[]` is the `raiseFinding` body lifted UNCHANGED),
            // so the role copy names the array the findings ride in and nothing else: which record each
            // verdict line targets (`target_ref`) belongs to the engine-owned brief (`run/brief.ts`), and a
            // call-syntax form would freeze an argument list the prompt cannot check.
            expect(prompt).toContain('`findings[]`');
            expect(prompt).not.toContain('target_ref');
            expect(prompt).not.toMatch(/submitVerdict\(|submitVerdict with /);
            // THE RETIRED ROUTE (2026-11-27): the four angles used to be told to file the claim with
            // `raiseFinding` AND report with `submitVerdict` — two endpoints, and the second one filed
            // nothing, because the first had already closed the thread. A finding now has exactly ONE home in
            // this copy: the `findings[]` array of the call that ends the pass.
            expect(prompt).not.toContain('raiseFinding');
        }

        // D6 — four critics, not one. Each angle's expertise sentence is its own, appears in its own
        // prompt, and appears in NONE of the other three: the convergence rewrite is allowed to share
        // the rules, not the judgement those rules are applied with.
        for (const [name, clauses] of Object.entries(gating)) {
            const prompt = byName(name).roles[0].prompt;

            expect([name, prompt.includes(clauses.expertise)]).toEqual([name, true]);

            for (const [other, otherClauses] of Object.entries(gating)) {
                if (other !== name) expect(prompt).not.toContain(otherClauses.expertise);
            }
        }

        // The Consistency reader files Proposals too (D-33b moved its "preference" there), so the same
        // gate is written where its cost ladder is written.
        expect(byName('reader-consistency').roles[0].prompt).toContain(
            'A Proposal is also the LAST thing you file, not a side order: while this Story has an unresolved issue, `raiseFinding` DISMISSES a `kind: proposal` call — no row, no work armed and no retry to spend — so an issue is always filable and a Preference belongs in a pass that found no issue (D-33c).'
        );

        // …AND THE RETIRED WORDING MUST STAY OUT OF IT (2026-11-26 reconciliation). This is the one place
        // outside the four critic angles that ever spelled D-33c out in an Author-editable prompt, and it
        // is the one place the convergence pass left the mirror rule and the old refusal standing — the
        // `not.toContain` bans above loop over the ANGLES only, so this reader needed its own. A dismissed
        // proposal writes no row and offers no retry, so neither the pass-pairing rule nor a sentence
        // inviting the claim back can be true here.
        for (const retired of ['never share a pass', 'refuses a `kind: proposal`', 'in a pass that has none left']) {
            expect(byName('reader-consistency').roles[0].prompt.toLowerCase()).not.toContain(retired);
        }

        // The Editor is the OTHER half: a Critic told not to file is a saved round, an Editor not told is
        // a turn spent calling a tool that refuses. This paragraph is the Author-editable twin of the
        // engine-owned `run/brief.ts:jobStatement('verify_findings')` sentence, and the convention that
        // rules appearing in both places stay in sync (`knowledge.md`) is what this pin holds. The
        // holding set is stated, not implied: `disputed` RELEASES a proposal (D-33c/D-33d), so an Author
        // who rewrites this paragraph cannot accidentally re-teach the old four-state doctrine.
        expect(byName('editor-general').roles[0].prompt).toContain(
            'ISSUES IN FOCUS (D-33d). Issues before anything else: while this Story has an unresolved issue — only `unconfirmed`, `confirmed` and `approved` hold one open, and one the Editor marks `disputed` releases it — `approveFinding` REFUSES a row marked `proposal`, and the auto-approve dial skips it too. Nothing else outranks a defect the crew has already agreed to: verify and decide the issues first, and the proposals queue behind them. A proposal you cannot approve yet stays `confirmed` rather than being forced through, and discarding a proposal is always allowed, because declining a change is not an approval. An ISSUE row is never held by this rule — working the defects is exactly what releases the proposals.'
        );

        // D-17c/P12: `selection_rules` is the Author's own rulebook — the one prompt they are invited to
        // rewrite — so the priority order the rule encodes lives here as well. An Author who strips rule
        // 10 loses the INTENT while the code still refuses, which is exactly the drift a pin catches.
        expect(byName('editor-general').selection_rules ?? '').toContain(
            '10. Issues before proposals: while the book has an unresolved defect, the round belongs to the defects (D-33d). Approve and route the issues first, and let a Proposal wait its pass — approving a suggestion over an open break spends the Writer round on the wrong question. Discarding a Proposal you will not take is always the right move; holding an issue open to block one is not.'
        );

        // And the one phase-① pass that gets NO note: the screening pass runs with no tools at all, so it
        // cannot file a Proposal and has nothing to sequence. Pinning its absence keeps a future edit from
        // pasting a tool sentence into a tool-less prompt (D-30's no-tools contract).
        expect(byName('critic-screening').roles[0].prompt).not.toContain('D-33c');
        expect(byName('critic-screening').roles[0].prompt).not.toContain('raiseFinding');
    });

    it('D-33c — all four angles end their done-definition at the one terminal report', () => {
        // WHY THIS LINE MATTERS AT ALL: `run/brief.ts:jobStatement` prints `done_definition` as the
        // "Done means: …" line for a Critic job that is NOT a `check_unit` review (a review seat gets the
        // engine-owned `criticReviewDone` line instead, which is why the gap survived). So on those jobs
        // this is the ONLY ending the angle is given, and an angle whose done-line stops at "the issues are
        // filed" is an angle with no stop rule — the loop the owner measured ("it should file as soon as it
        // is certain of its findings"). All four now close on the SAME clause, pinned exactly; what stays
        // per angle is its own filing rule, in its own words.
        const TERMINAL = 'one terminal report that carries the verdict and every issue together (D-33c).';

        for (const name of ['critic-genre', 'critic-plausibility', 'critic-audience', 'critic-mystery']) {
            const done = byName(name).done_definition ?? '';

            expect([name, done.endsWith(TERMINAL)]).toEqual([name, true]);
            // The non-terminal shapes this pin bans: a done-line that stops at the filing, or that leaves
            // the minor/taste notes "optional" (an option is a reason to keep reading), describes an ending
            // the loop does not honour. `critic-genre` was the one left behind with both.
            expect([name, /(?:is|are) filed\.$|are optional/.test(done)]).toEqual([name, false]);
            // And a done-line may not quietly become a digging licence either: what it may permit is a note
            // that is ALREADY there, never a search for one.
            expect(done).toMatch(/only when (?:they are already obvious|it is already in front of the reader)/);
        }

        // `critic-genre` pinned WHOLE, because it is the angle this pass fixed (2026-11-26 reconciliation):
        // the sentence must keep the two rules its old copy carried — the taste note stays optional only in
        // the "already obvious" sense (T-10: never a search), and the Ideas tray stays shut in a review pass
        // (T-9, D-26) — while closing on the shared terminal clause. A rewrite that drops either rule, or
        // drops the ending, fails here rather than in a run.
        expect(byName('critic-genre').done_definition).toBe(
            'Every critical or major genre break is filed with its passage and evidence, rated against the promise and the convention this book’s premise invokes; a taste note rides along only when it is already in front of the reader, never because the shelf was searched, and no Idea is proposed in a review pass. The pass closes on one terminal report that carries the verdict and every issue together (D-33c).'
        );
    });

    it('T3 — the Editor disputes an omission-only finding instead of confirming the absence', () => {
        const editor = byName('editor-general').roles[0];

        // The Editor is the gate the screenshots show working AGAINST the Author: one absence-only finding
        // came back `APPROVED`, so the role prompt has to say what makes a finding admissible before it
        // asks whether the claim is factually true (an absence is always factually true).
        expect(editor.prompt).toContain('ADMISSIBILITY comes before accuracy');
        expect(editor.prompt).toContain('quotes a commitment and shows the artifact breaking it');
        expect(editor.prompt).toContain('is an invalid finding however true the absence is');
        expect(editor.prompt).toContain('rather than confirming that something is missing');
        // The controls that stay: evidence quoting, the real-contradiction grounds, and the speed rule that
        // keeps D-33's verification cheap.
        expect(editor.prompt).toContain('a contradiction of the Seed, of critical Knowledge, or of the artifact');
        expect(editor.prompt).toContain('verifyFinding is a QUICK validity check');
        expect(editor.prompt).toContain('The phase waits on these verdicts, so be fast');
        // D-33b — the template's mirror of the engine rule (the job line and the tool description carry the
        // same two modes). Without it an Author reading only the template still believes every absence is
        // a dispute, and the copy the loop runs on is the one the Author edits.
        expect(editor.prompt).toContain(
            'A finding marked `proposal` is the one claim this test does NOT judge: the Critic is proposing a change the Seed never had to promise, so weigh it on merit \u2014 `confirm` it when the change genuinely strengthens the story the Seed promises and is worth a Writer pass, `dispute` it when it is not worth the pass or would contradict the installed text, never merely because the Seed never promised it.'
        );
    });

    it('T3 — the Seed-structuring Editor records a silent field as open, not as an invented blank', () => {
        // A required scalar the Seed says nothing about has to be recorded as open (empty string +
        // `open_questions`), because the prompts now render an empty field as an open choice. Left unsaid,
        // the Editor invents a stake to fill the box — and a Critic later reports the invented absence.
        const structure = byName('editor-seed-structure').roles[0];

        expect(structure.prompt).toContain('a field the Seed leaves silent goes to open_questions');
        expect(structure.prompt).toContain('leave a silent one an empty string');
        // WHY the empty string is the right recording: the prompts render a blank required field as the
        // Seed leaving the choice OPEN, and this sentence is what tells the Editor that downstream
        // reading is intended rather than a promise the Summary is expected to pay.
        expect(structure.prompt).toContain(
            'the prompts render an empty field as the Seed leaving it OPEN, which is what tells the Writer and the Critics that filling it compatibly is allowed and not a broken promise'
        );

        expect(byName('editor-seed-structure').selection_rules).toContain(
            'an empty string is how a silent required field is recorded'
        );
    });

    it('D-17d / E-4 / §14 item 9: divergence is the sampler count, and the later Writers keep theirs', () => {
        // Phase 1's divergence moved from a template's `attempts` to the round's sample count
        // (§6.4: `sample_unit` × `summary_sampling`), so each sample is one deterministic turn.
        expect(byName('writer-summary-sampler').attempts).toBe(1);
        expect(byName('writer-plotlines').attempts).toBe(2);
        expect(byName('writer-chapters').attempts).toBe(2);

        // A reader or Editor that reported once per unit; `attempts` is the divergence dial, and
        // on these two it is the Author's setting rather than an engine constant (D-38a).
        expect(byName('editor-general').attempts).toBe(1);
        expect(byName('reader-consistency').attempts).toBe(1);
    });

    it('D-30 / T-6b: the deep-review Critics are defined by their instructions and hold web research', () => {
        for (const name of ['critic-genre', 'critic-plausibility', 'critic-audience', 'critic-mystery']) {
            const role = byName(name).roles[0];

            expect(role.web).toBe(true);
            // D-30: the brief says what it reads for and that it may propose, and T-9 says it may
            // not write — the prompt is where that lives, because the tool list does not (D-17a).
            expect(role.prompt).toContain('proposeIdea');
            expect(role.prompt).toMatch(/never write|do not write|You never write/i);
        }

        // The plausibility angle is the one whose value IS research, so it is told to fetch the
        // source it cites rather than trusting a snippet (D-27, T-10).
        expect(byName('critic-plausibility').roles[0].prompt).toContain('fetchPage');
    });

    it('the screening Critic is the exception: no tools, one turn, defects only', () => {
        // `toolMode: 'none'` (§6.2): a screening pass holds no `proposeIdea` and no web, because
        // its answer is one schema-validated JSON object and its issues are ranked, not debated.
        const screening = byName('critic-screening').roles[0];

        expect(screening.web).toBe(false);
        expect(screening.prompt).not.toContain('proposeIdea');
        expect(screening.prompt).toContain('Do not propose improvements, only defects');
    });

    it('P12 / U-8b: the Editor template carries the Author\u2019s selection_rules as editable starter text', () => {
        const rules = byName('editor-general').selection_rules ?? '';

        // C-13's evidence is this text (G-3a), so it must exist and must read as an instruction
        // the Author can rewrite — the marker is the product's core tuning affordance.
        expect(rules.length).toBeGreaterThan(200);
        expect(rules).toContain('Edit me');
        expect(byName('reader-prose').roles[0].prompt).toContain('selection_rules');
    });

    it('G-3a: the prose reader\u2019s whole standard is inside the book, so it does not browse', () => {
        expect(byName('reader-prose').serves_phase).toEqual(['chapters']);
        expect(byName('reader-prose').roles[0].web).toBe(false);

        // The consistency reader reads the whole chain at every phase (C-2…C-9, L-8a).
        expect(byName('reader-consistency').serves_phase).toEqual(['summary', 'plotlines', 'chapters']);
    });

    it('D-17e: only the Writer and the selection Editor templates declare in-run delegation, and every target is a role', () => {
        const delegation = Object.fromEntries(
            BUILT_IN_TEMPLATES.map((template) => [template.name, template.delegation ?? []])
        );

        expect(delegation).toEqual({
            'editor-seed-structure': [],
            'researcher-story': [],
            'writer-summary-sampler': [],
            'writer-plotlines': ['reader'],
            'writer-chapters': ['reader'],
            'editor-general': ['critic', 'reader'],
            'critic-screening': [],
            // Phrase ②'s review seat is a single structured turn: it writes nothing and has no sub-context
            // to hand a reading to, so a delegation would be a role the run cannot spawn.
            'critic-screening-plotlines': [],
            'editor-group-lock': [],
            'critic-genre': [],
            'critic-plausibility': [],
            'critic-audience': [],
            'critic-mystery': [],
            'reader-consistency': [],
            // D-65's score seat: one structured turn, no tools, nothing to delegate.
            'reader-score': [],
            'reader-prose': [],
            // T-W2: Phrase ②'s two crews delegate nothing. The chapter draft is ONE structured turn
            // whose whole answer the engine installs or discards (`installGroupRevisions`), so a
            // delegated sub-role inside it could not be attributed to an entry; the structure gate is
            // a single judgement turn (`structurePlotlines`).
            'writer-plotlines-sampler': [],
            'editor-plotlines-structure': []
        });
    });

    // R-LOCK — the Editor's lock review (`Story.editor_group_locking`). The seat itself is
    // `loop/work.ts` candidate 2c and its contract lives in `loop/editor-lock.ts`; what the CATALOGUE
    // owes the feature is a row whose slug the seat names and whose copy states the judgement. Before
    // this row existed the seat ran on `run/phase1-prompt.ts:fallbackRolePrompt`, which is a stated
    // absence (§8) rather than a crew the Author can read, duplicate and rewrite (D-17).
    it('R-lock — the catalogue carries the Editor\'s lock review, and its copy states a judgement rather than a cutoff', () => {
        const lock = byName('editor-group-lock');
        const role = lock.roles[0];

        // The row's shape mirrors `critic-screening`: a tool-less, one-turn, structured-answer seat at
        // phase ①. `attempts: 1` because there is nothing to diverge (one section, one answer), and
        // `max_concurrent: 1` because the vector's five seats share the sweep's ceiling and five locks
        // racing five reviews buys nothing (`work.ts:candidate` reads this for the S-5 ceiling).
        expect([lock.title, lock.serves_phase, lock.attempts, lock.delegation, lock.max_concurrent]).toEqual([
            'Editor — group lock review',
            ['summary'],
            1,
            [],
            1
        ]);
        expect(lock.roles.map((entry) => [entry.name, entry.kind, entry.web, entry.agents])).toEqual([
            ['editor', 'editor', false, 1]
        ]);
        // A tool-less run cannot ask the Author anything, so there is no escalation rule — the
        // escalation IS the section staying unlocked (`loop/editor-lock.ts` re-arms on the next clean
        // selection, and the settle's refusals all write nothing).
        expect(lock.next_phase).toBe('');
        expect(lock.escalation_rule).toBeUndefined();

        // D-17c: every Editor template owes the Author's taste in their own words. This seat selects
        // nothing, so the field carries the taste the LOCK is measured against — and it is the only
        // place in the row an Author is invited to rewrite the standard.
        expect((lock.selection_rules ?? '').trim().length).toBeGreaterThan(0);
        expect(lock.selection_rules ?? '').toContain('Settled means the section carries its own commitments in its own words, not that it reads well.');
        expect(lock.selection_rules ?? '').toContain(
            "A lock is the Author's to undo and the crew's to respect: never lock a section to end an argument you have not settled."
        );

        // The evidence the seat is actually shown (`loop/editor-lock.ts:editorLockEvidenceOf`), named in
        // the copy so an Editor reading the brief weighs the right blocks: the Critic's open claims and
        // Proposals, and the Reader's number WITH its reason (a bare number is exactly the input the
        // Author refused to make a rule out of — D-65's exception stops at display).
        expect(role.prompt).toContain(
            "the open Critic claims and Proposals that name it, the claims about it that already closed, and the neighbouring sections that already stand LOCKED beside it"
        );
        expect(role.prompt).toContain("the Reader's reading of that text (the number AND its reason and the line it quotes)");
        expect(role.prompt).toContain('Weigh the Reader\'s REASON.');

        // THE ABSENCE THAT MATTERS MOST (D-69 amends the D-65 boundary, it does not move it): this seat
        // must carry no NUMBER anywhere, because a number in the copy of a seat that decides a lock is a
        // score cutoff arriving through prose an Author edits. Pinning "no digit at all" is the exact,
        // checkable form of "there is no threshold here" — `0–100`, a percentage, `88`, a `C-14` criterion
        // id would all fail it, and the engine-owned `GROUP_LOCK_INSTRUCTION` is where the two halves of
        // `lock: true` are actually binding.
        for (const prose of [role.prompt, lock.selection_rules ?? '', lock.done_definition, lock.description ?? '']) {
            expect(prose).not.toMatch(/\d/);
        }

        // A NEGATIVE decision is a first-class answer, not a shrug: it must be permitted, it must be
        // described as ordinary (the seat re-arms on the next clean vector, so refusing costs one pass),
        // and it must carry a reason like every other verdict in this product (D-15).
        expect(role.prompt).toContain('`lock: false` is the ordinary answer, and it is a complete one.');
        expect(role.prompt).toContain('There is no quota of locks this round has to produce');
        expect(role.prompt).toContain('Whichever way you answer, `rationale` must be non-blank');

        // What the flag COSTS, because a seat that feels weightless locks things by accident: the crew
        // stops rewriting the section, the claims against it stop being work, and only the Author can
        // undo it (`phrase/locks.ts:unlockPhraseGroup` refuses any other actor).
        expect(role.prompt).toContain(
            "no Writer pass may rewrite it again, every claim still open against it stops being work, and every other section is then revised to agree with it"
        );
        expect(role.prompt).toContain('Only the Author can undo it.');

        // One section per seat, five seats per clean vector: a pass that graded the whole Overview would
        // spend five seats on one judgement and collapse five decisions into one.
        expect(role.prompt).toContain('This pass decides ONE section.');

        // And the tool-less contract, held the same way `critic-screening` holds it: nothing in this copy
        // may tell the seat to call a tool it does not have.
        expect(role.prompt).toContain('You have NO tools in this run and exactly one turn');
        expect(role.prompt).not.toContain('raiseFinding');
        expect(role.prompt).not.toContain('approveFinding');
    });
});

describe('W8 — T-0 structural assignment rules', () => {
    it('the default assignment is legal at every phase', () => {
        // `createStory` applies this set to a Story that starts in `summary`, and the same rows
        // carry the Story through phases ② and ③, so it has to validate in all three.
        for (const phase of ['summary', 'plotlines', 'chapters'] as StoryPhase[]) {
            expect(validateAssignment(storyAt(phase), DEFAULT_ASSIGNMENT)).toEqual([]);
        }

        // §6.4's four Phase-1 pipeline crews, the two later-phase Writers, §14 item 10's four
        // deep-review angles and the one selection Editor are all in it; the prose reader is the
        // opt-in crew, which is why U-8 (not the default) assigns it.
        //
        // `editor-general` leads the Editor pair on purpose: an unbound Editor job (`verify_findings`,
        // `verify_ideas`, `directive_work`, `select`) binds the FIRST assigned editor template
        // (`work.ts:candidate` → `records.ts:templatesFor` order). The structure pass binds its
        // template explicitly, so it is unaffected by the order.
        expect(DEFAULT_ASSIGNMENT).toEqual([
            'editor-general',
            'editor-seed-structure',
            'researcher-story',
            'writer-summary-sampler',
            'critic-screening',
            // R-lock: the lock review rides along so the Author can see and duplicate the crew (its
            // position is free — the seat binds its slug explicitly and the prompt resolves from the
            // catalogue), and it sits after `editor-general` so the unbound-Editor pick is unchanged.
            'editor-group-lock',
            'writer-plotlines',
            'writer-chapters',
            'critic-genre',
            'critic-plausibility',
            'critic-audience',
            'critic-mystery',
            'reader-consistency',
            // D-65's score-only reader sits IMMEDIATELY AFTER `reader-consistency` on purpose: an unbound
            // `check_unit` reader job binds the FIRST assigned reader row (`records.ts:templatesFor` order →
            // `work.ts:candidate`'s `pool[0]`), and that seat must keep the tool-carrying consistency reader —
            // the score seat holds no tools and files nothing, so it could not answer a review job.
            'reader-score',
            // T-W2: Phrase ②'s structure gate and its contract Writer ride along for the same reason
            // `editor-group-lock` does — each seat binds its crew BY SLUG
            // (`loop/work.ts:phase2GroupCandidates` sets `templateRef`) and the prompt resolves from
            // the catalogue, so their position is not a pool pick. They come LAST because a Writer
            // listed before `writer-plotlines` would become the unbound phase-② write crew and move
            // what a classic-mode Story's `write_unit` run looks like.
            'editor-plotlines-structure',
            'writer-plotlines-sampler',
            // Phrase ②'s structured review voice, LAST for the same reason: the `review_groups` seat binds
            // `critic-screening-plotlines` by slug (`run/phase1-prompt.ts:PLOTLINES_SCREEN_TEMPLATE_SLUG`)
            // and resolves its copy from the catalogue, so staying behind the four angles keeps
            // `templatesFor(..., 'critic')[0]` on `critic-screening`.
            'critic-screening-plotlines'
        ]);

        // THE POOL PICKS, stated rather than implied by the list above. The reader pair is the pair the new
        // row could have moved: `reader-consistency` stays the review crew because the score row follows it,
        // and `critic-screening-plotlines` cannot displace `critic-screening` because it is last.
        expect(
            DEFAULT_ASSIGNMENT.filter((name) => byName(name).roles.some((role) => role.kind === 'reader'))
        ).toEqual(['reader-consistency', 'reader-score']);
        expect(
            DEFAULT_ASSIGNMENT.filter((name) => byName(name).roles.some((role) => role.kind === 'critic'))
        ).toEqual([
            'critic-screening',
            'critic-genre',
            'critic-plausibility',
            'critic-audience',
            'critic-mystery',
            'critic-screening-plotlines'
        ]);
    });

    it('each Writer serves exactly one phase, so every phase has exactly one writer pool', () => {
        // The default carries one Writer per phase and the pools must not overlap: a phase-② job
        // resolved against this set finds `writer-plotlines` and nothing else (D-17b, L-4).
        //
        // PHRASE ② (T-W2) is the one phase with TWO Writer rows, and it stays legal under D-38a
        // ("a second Writer template is legal and means two voices") because neither group seat picks
        // from the pool: the draft job binds `writer-plotlines-sampler` and the structure job binds
        // `editor-plotlines-structure` by slug. The unbound phase-② write crew is still
        // `writer-plotlines` alone, because it is the only phase-② Writer listed ahead of the sampler
        // in `DEFAULT_ASSIGNMENT` (`records.ts:templatesFor` order → `work.ts:candidate`'s `pool[0]`).
        const writers = BUILT_IN_TEMPLATES.filter((template) =>
            template.roles.some((role) => role.kind === 'writer')
        );

        expect(
            (['summary', 'plotlines', 'chapters'] as StoryPhase[]).map((phase) => [
                phase,
                writers.filter((template) => template.serves_phase.includes(phase)).map((template) => template.name)
            ])
        ).toEqual([
            ['summary', ['writer-summary-sampler']],
            ['plotlines', ['writer-plotlines', 'writer-plotlines-sampler']],
            ['chapters', ['writer-chapters']]
        ]);

        // And the pool pick itself, stated rather than implied: the classic path's crew is FIRST.
        expect(
            DEFAULT_ASSIGNMENT.filter(
                (name) =>
                    byName(name).roles.some((role) => role.kind === 'writer') &&
                    byName(name).serves_phase.includes('plotlines')
            )
        ).toEqual(['writer-plotlines', 'writer-plotlines-sampler']);
    });

    it('T-0 / D-17b: an assignment with no Writer is refused', () => {
        expect(validateAssignment(storyAt('summary'), ['editor-general'])).toEqual([
            'assignment has no Writer template — write permission comes only from a template assigned as a Writer (D-17b, P10)'
        ]);
    });

    it('T-0 / D-33: a Critic or reader assigned without an Editor is refused', () => {
        // Someone is about to file findings the loop would act on unverified.
        expect(validateAssignment(storyAt('summary'), ['writer-summary-sampler', 'critic-genre'])).toEqual([
            'assignment needs an Editor template: drafts compete once attempts > 1 (D-23) and every Critic or reader finding must be verified before the loop acts on it (D-33, T-0)'
        ]);

        expect(validateAssignment(storyAt('summary'), ['writer-summary-sampler', 'reader-consistency'])).toHaveLength(
            1
        );

        // The screening Critic is a Critic too — its issues rank samples, but the rule that a
        // non-Writer crew needs an Editor does not care which Critic flavour it is.
        expect(validateAssignment(storyAt('summary'), ['writer-summary-sampler', 'critic-screening'])).toEqual([
            'assignment needs an Editor template: drafts compete once attempts > 1 (D-23) and every Critic or reader finding must be verified before the loop acts on it (D-33, T-0)'
        ]);
    });

    it('T-0 / D-23: attempts > 1 without an Editor is refused — nobody would choose between the drafts', () => {
        // `writer-chapters` alone: attempts 2, and no Editor anywhere.
        expect(validateAssignment(storyAt('chapters'), ['writer-chapters'])).toEqual([
            'assignment needs an Editor template: drafts compete once attempts > 1 (D-23) and every Critic or reader finding must be verified before the loop acts on it (D-33, T-0)'
        ]);

        // The same crew with the Editor present is legal (D-38a: the count is the Author's call).
        expect(validateAssignment(storyAt('chapters'), ['writer-chapters', 'editor-general'])).toEqual([]);
    });

    it('D-38a: a second Writer template is legal and means two voices', () => {
        const catalogue = [
            harness('writer-a', 'writer', ['chapters']),
            harness('writer-b', 'writer', ['chapters']),
            harness('editor-x', 'editor', ['chapters'])
        ];

        expect(validateAssignment(storyAt('chapters'), ['writer-a', 'writer-b', 'editor-x'], catalogue)).toEqual([]);
    });

    it('a Writer that does not serve the Story\u2019s phase cannot write it (L-4, serves_phase)', () => {
        const catalogue = [
            harness('writer-structure', 'writer', ['summary']),
            harness('editor-x', 'editor', ['chapters'])
        ];

        // The Writer monopoly has a holder, but that holder is not dispatchable in this phase —
        // the assignment would leave the loop with nothing to spawn (L-4).
        expect(validateAssignment(storyAt('chapters'), ['writer-structure', 'editor-x'], catalogue)).toEqual([
            'no assigned Writer serves phase "chapters", so nothing can write artifacts in this phase (serves_phase, L-4)'
        ]);
    });

    it('an assignment naming a template that is not in the catalogue is refused by name', () => {
        expect(validateAssignment(storyAt('summary'), ['ghost-writer', 'editor-general'])).toEqual(
            expect.arrayContaining([
                `assignment names "ghost-writer", which is not a template in the catalogue (D-17b)`,
                expect.stringContaining('no Writer template')
            ])
        );
    });
});

describe('D-17 — built-ins are duplicated, never edited in place', () => {
    it('the duplicate is editable, renamed, and independent in every nested field', () => {
        const source = byName('editor-general');
        const duplicate = duplicateTemplate(source, 'my-editor');

        expect(duplicate.name).toBe('my-editor');
        expect([duplicate.builtin, duplicate.editable]).toEqual([false, true]);
        expect(duplicate.selection_rules).toBe(source.selection_rules);
        expect(duplicate.roles).toEqual(source.roles);
        expect(validateTemplate(duplicate)).toEqual([]);

        // P12 in one assertion: editing the copy into the Author's likeness must not edit the
        // built-in everybody else starts from.
        duplicate.roles[0].prompt = 'edited into the Author\u2019s voice';
        duplicate.serves_phase.push('chapters');
        (duplicate.delegation as string[]).push('writer');

        expect(source.roles[0].prompt).not.toBe('edited into the Author\u2019s voice');
        expect(source.serves_phase).toEqual(['summary', 'plotlines', 'chapters']);
        expect(source.delegation).toEqual(['critic', 'reader']);
    });

    it('a duplicate whose name is not a slug is refused rather than written into the catalogue', () => {
        expect(() => duplicateTemplate(byName('writer-chapters'), 'My New Writer')).toThrow(/slug/);
    });

    it('a Writer duplicated from a built-in is still assignable, so D-38a\u2019s "two voices" is one click away', () => {
        const duplicate = duplicateTemplate(byName('writer-chapters'), 'writer-colder');
        const catalogue = [...BUILT_IN_TEMPLATES, duplicate];

        expect(validateAssignment(storyAt('chapters'), [...DEFAULT_ASSIGNMENT, 'writer-colder'], catalogue)).toEqual(
            []
        );
    });
});

describe('W8 — validateTemplate refuses the harnesses that cannot run', () => {
    it('an Editor template with no selection_rules is guessing at the Author (D-17c, P12)', () => {
        const editor = { ...byName('editor-general'), selection_rules: '   ' };

        expect(validateTemplate(editor)).toEqual([
            'template editor-general.selection_rules is required for an Editor template — it is the Author\u2019s taste in their own words (D-17c, P12)'
        ]);
    });

    it('D-38: agents > 1 needs an aggregate, and an aggregate needs agents > 1', () => {
        const panel = duplicateTemplate(byName('editor-general'), 'editor-panel');

        panel.roles[0].agents = 3;

        expect(validateTemplate(panel)).toEqual([
            'template editor-panel.roles[0].aggregate is required when agents > 1 — the panel must answer once, so the loop never sees a vote (D-38, D-34a)'
        ]);

        panel.roles[0].aggregate = 'majority';
        expect(validateTemplate(panel)).toEqual([]);

        // §15 step 8a's shape: three editor agents, one selection, one selection_note.
        panel.roles[0].agents = 1;

        expect(validateTemplate(panel)).toEqual([
            'template editor-panel.roles[0].aggregate needs agents > 1 — one agent has nothing to aggregate (D-38)'
        ]);
    });

    it('a role with no prompt is the failure D-17a names: it will improvise with whatever tool it holds', () => {
        const broken = duplicateTemplate(byName('writer-chapters'), 'writer-silent');

        broken.roles[0].prompt = '';

        expect(validateTemplate(broken)).toEqual([
            'template writer-silent.roles[0].prompt is required — a kind with no instructions is the failure D-17a names'
        ]);
    });

    it('attempts 0, an empty serves_phase, an unknown phase and an unknown delegation target are all refused', () => {
        const zero = duplicateTemplate(byName('writer-chapters'), 'writer-zero');

        zero.attempts = 0;
        expect(validateTemplate(zero)).toEqual([
            'template writer-zero.attempts must be an integer >= 1 — how many parallel revisions one unit spawns (D-17d)'
        ]);

        const noPhase = duplicateTemplate(byName('writer-chapters'), 'writer-nophase');

        noPhase.serves_phase = [];
        expect(validateTemplate(noPhase)).toEqual([
            'template writer-nophase.serves_phase must name at least one phase — the sweep matches it against the Story\u2019s phase (L-4)'
        ]);

        const ghostPhase = duplicateTemplate(byName('writer-chapters'), 'writer-ghostphase');

        ghostPhase.serves_phase = ['epilogue' as StoryPhase];
        expect(validateTemplate(ghostPhase)).toEqual([
            'template writer-ghostphase.serves_phase has "epilogue", which is not one of summary, plotlines, chapters'
        ]);

        const ghostDelegate = duplicateTemplate(byName('editor-general'), 'editor-ghost');

        ghostDelegate.delegation = ['poet'];
        expect(validateTemplate(ghostDelegate)).toEqual([
            'template editor-ghost.delegation names "poet", which is neither a role kind (writer, editor, critic, reader, researcher) nor one of this template\u2019s roles (D-17e)'
        ]);
    });

    it('a duplicate of a duplicated crew keeps being editable (D-17 chains, and the copy stays independent)', () => {
        const first = duplicateTemplate(byName('reader-prose'), 'prose-cold');
        const second = duplicateTemplate(first, 'prose-colder');

        expect([second.builtin, second.editable]).toEqual([false, true]);
        expect(second.roles[0].web).toBe(false);

        second.roles[0].prompt = 'third voice';

        expect(byName('reader-prose').roles[0].prompt).not.toBe('third voice');
        expect(first.roles[0].prompt).not.toBe('third voice');
    });
});

describe('SUMMARY PHRASE — the built-in crews are taught the five-group contract (R1/R2/R3/R5)', () => {
    const promptOf = (name: string): string => byName(name).roles[0].prompt;

    it('the Summary Writer is taught the five group purposes, the exact batch set, and no World rules group', () => {
        const prompt = promptOf('writer-summary-sampler');

        // The purposes are the catalog's own words (`shared/phrase.ts:PHRASE_GROUP_DEFINITIONS`). A
        // Writer that is not told what a group is FOR writes the whole Overview inside the one it was asked for.
        for (const purpose of [
            'PREMISE — what the story is',
            'PROMISE — what the story commits the reader to',
            'THEME — what the story is about underneath',
            'TONE — voice, point of view, tense and register',
            'ENDING — where the story lands and what resolves'
        ])
            expect(prompt).toContain(purpose);

        // R1: `summaries.world_rules` is a deprecated field of the legacy schema, so no sixth group is taught.
        expect(prompt).toContain('There is NO World rules group');
        expect(prompt).toContain('nothing you write mints a new one');

        // R2: the batch set is exact — one group, several, or all five — and the install is atomic.
        expect(prompt).toContain('The GROUPS section names the ONLY groups this job may write');
        expect(prompt).toContain('A batch naming ONE group is a one-group answer');
        expect(prompt).toContain('the engine installs an answer for all the named groups or for none');

        // R5 + the hill climb: an accepted answer IS the installed text, and the N-samples/selector are
        // kept only as the LEGACY clause, so a group Writer is never taught a winner-takes-it round.
        expect(prompt).toContain('A group-managed book has no such competition');
        expect(prompt).toContain('On a book still sampled whole you are one of N independent samples');
        expect(prompt).toContain('a selector — never you — chooses between committed alternatives');

        // H1/R2: the Writer does not certify its own cure, and a multi-group defect is answered in full.
        expect(prompt).toContain('a finding that names several groups closes only when every one of them carries it');
    });

    it('the screening Reviewer is taught both modes, the scope it owes, and the closure join', () => {
        const prompt = promptOf('critic-screening');

        // One row serves both phase-① Critic modes (`compileGroupReviewPrompt` / `compileScreenPrompt`).
        expect(prompt).toContain('`GroupReview` on a group-managed book');
        expect(prompt).toContain('`IssueList` on a book still sampled whole');
        expect(prompt).toContain('the OVERVIEW: the five Summary groups as the book now holds them');
        expect(prompt).toContain('A group-managed book has no competing samples and nothing to rank (R5)');

        // R3 attribution: one group, several, or all five; one defect is one issue; the quote names its
        // group, because a five-group scope on a one-group complaint rewrites four groups for a sentence.
        expect(prompt).toContain('Name the ONE group the defect is in; name several, or all five');
        expect(prompt).toContain('ONE issue naming three groups');
        expect(prompt).toContain('Name in `location` the group the quote came from');
        expect(prompt).toContain('do not name a group you have not quoted from');

        // THE `group_quotes` LANE (2026-11-27). This seat answers with a schema object rather than with a
        // Finding, so unlike the tool-carrying angles it CAN carry one quote per named group — and it MUST,
        // because R3 closes the issue only once every group it names has been revised
        // (`phrase/findings.ts:findingGroupScope`), and an unevidenced group cannot be dragged into the scope
        // of a defect it was never evidence for. The primary group goes FIRST in `group_refs`, which is what
        // keeps `quote` and `location` pointed at the same text.
        expect(prompt).toContain(
            'EVERY issue names its `group_refs`: the group ids printed in the OVERVIEW headings.'
        );
        expect(prompt).toContain(
            'Put the group you are reporting FIRST in `group_refs`, then every other group the defect crosses; for every other group you name, add a `group_quotes` entry with that group’s `group_ref`, its `quote` and its `location` — every named group has to be evidenced.'
        );
        // THE SCHEMA'S REQUIRED `detail` IS NAMED HERE NOW (2026-11-27), in the same breath as the evidence
        // rule: `GroupReviewSchema` puts `detail` in `required` with `minLength: 1`, and a seat answering in
        // `json_object` mode (§4.2's fallback, schema not on the wire) has only this copy to tell it so.
        expect(prompt).toContain('`detail` is what is wrong and where (section, paragraph or lines), and it is required.');
        expect(prompt.match(/`detail`/g)).toHaveLength(1);
        // Once, and only in the lane that has the field: a second copy is what D-33c's de-duplication removed.
        expect(prompt.match(/group_quotes/g)).toHaveLength(1);

        // H1/R2 with R3: the certificate is per-group, and a review never spends the rewrite allowance.
        expect(prompt).toContain('`resolved` only when EVERY one of those groups now carries the repair');
        expect(prompt).toContain('costs the Story no Writer attempt');

        // D-33c COHERENCE (F4) — the effort sentence this seat is briefed with, pinned as ONE sentence so
        // both halves are held: the anti-silence licence (the seat is a read, so an issue it saw must not be
        // rationed away — the reported failure was Critics staying quiet or hedging) AND the bound that
        // closes it in the same breath ("and report nothing when the text holds. Effort is not value here
        // either"), which is what stops the licence reading as a licence to dig for a break the Overview
        // never showed. Pinning the pair is the point: either half alone is the defect the other prevents.
        expect(prompt).toContain(
            'so report what you find without rationing, and report nothing when the text holds. Effort is not value here either'
        );
        // And the same seat may not be told twice: the bound lives here, in the role copy, while the
        // engine-owned user-turn block (`run/phase1-prompt.ts:GROUP_REVIEW_INSTRUCTION`) carries its own
        // once — a second copy of the rule in one prompt is what D-33c's de-duplication removed.
        expect(prompt.match(/without rationing/g)).toHaveLength(1);

        // The earlier T3 gates (Seed silence, the style ladder) are still in force beside the group text.
        expect(prompt).toContain('A critical is a contradiction the text under review cannot live with');
        expect(prompt).toContain('are NOT issues at this phase');
    });

    it('every tool-carrying review angle scopes a Summary defect to its groups, inside the ONE terminal report (R3, D-33c)', () => {
        // The refusal is still the reason for the SCOPE: `tools/reader.ts:raiseFinding` refuses an unscoped
        // Summary finding on a group-managed book, so a role that is not told this burns the pass on a
        // refusal. WHAT MOVED (2026-11-27) is the ROUTE: a finding no longer rides on its own
        // `raiseFinding` call — every finding is an entry of the one `submitVerdict` that ends the pass, so
        // the copy has to name the array AND the tool that carries it, or the seat files into a call its own
        // terminal report then repeats.
        const FILING = 'the `findings[]` array of the one terminal `submitVerdict`';

        for (const name of ['critic-genre', 'critic-plausibility', 'critic-audience', 'critic-mystery']) {
            const prompt = promptOf(name);

            expect(prompt).toContain('group_refs');
            expect(prompt).toContain('the group ids the brief prints');
            expect(prompt).toContain(FILING);
        }

        // THE QUOTE RULE, per angle, in the angle's own words. A Finding holds ONE evidence string
        // (`shared/types.ts:Finding.evidence`), so the retired demand — "quote every group you name" — asks
        // for a field the schema does not have. The quote belongs to the group named in `location`; the other
        // groups the defect crosses are named in `group_refs`.
        const quoting: Record<string, string> = {
            'critic-genre':
                'Quote the line from the group you name in `location`; name the other groups the defect crosses in `group_refs`, and never name a group you did not read.',
            'critic-plausibility':
                'Quote the line from the group you name in `location`, and name the other groups the defect crosses in `group_refs`; one factual defect crossing three groups is ONE finding naming three groups, never three findings.',
            'critic-audience':
                'Quote the line from the group you name in `location`, and keep it ONE finding however many groups it names: three findings for one reader sentence buy three Writer rounds for one complaint.',
            'critic-mystery':
                'Quote the line from the group you name in `location`, and name the other groups the defect crosses in `group_refs`; never name a group you did not read: a five-group scope on a two-group complaint rewrites three groups to answer one sentence (D-33).'
        };

        for (const [name, sentence] of Object.entries(quoting)) expect([name, promptOf(name).includes(sentence)]).toEqual([name, true]);

        // …AND NONE OF THEM MAY ASK FOR `group_quotes`: that field belongs to the structured `GroupReview`
        // answer (`critic-screening`, `critic-screening-plotlines`), and a tool-carrying angle told to fill it
        // is told to fill a field `raiseFinding` has nowhere to put.
        for (const name of ['critic-genre', 'critic-plausibility', 'critic-audience', 'critic-mystery'])
            expect([name, promptOf(name).includes('group_quotes')]).toEqual([name, false]);

        // Each angle states the one-finding rule in its own terms (and the genre angle in the cross-group
        // judgement this pass exists for).
        expect(promptOf('critic-genre')).toContain('ONE finding naming three groups');
        expect(promptOf('critic-genre')).toContain('judge the groups AGAINST EACH OTHER');
        expect(promptOf('critic-audience')).toContain('keep it ONE finding however many groups it names');

        // And the sentence that says what ENDS the run, in the two angles that carry it verbatim: the findings
        // ride in the report, they do not precede it in a separate call.
        expect(promptOf('critic-genre')).toContain(
            'You never write the book — your output is ONE terminal `submitVerdict` report carrying your findings in `findings[]`; `proposeIdea` is for jobs that explicitly ask for Ideas (T-9, D-26).'
        );
        expect(promptOf('critic-audience')).toContain(
            'You never write the book — your output is ONE terminal `submitVerdict` report carrying your findings in `findings[]`, plus `proposeIdea` when the job asks for it (T-9, D-26).'
        );

        // The Consistency reader is the OTHER tool-carrying reviewer and its route is unchanged: it still
        // files with `raiseFinding`, scopes a Summary defect by group with the same one-quote rule, and
        // scopes every later defect by its own artifact.
        expect(promptOf('reader-consistency')).toContain('group_refs');
        expect(promptOf('reader-consistency')).toContain(
            'and quote the line from the group you name in `location`; name the other groups in `group_refs`'
        );
        expect(promptOf('reader-consistency')).toContain('needs no group ids');
        expect(promptOf('reader-consistency')).toContain('raiseFinding');
    });

    it('the Researcher feeds whichever phase-① prompt exists, so it is not taught "the sampler"', () => {
        const prompt = promptOf('researcher-story');

        expect(prompt).toContain('the phase-① drafters can build on');
        expect(prompt).toContain('Only critical and high reach the phase-① prompt, group batch or legacy sample alike');
        expect(prompt).toContain('the loop goes straight to the phase-① draft');
        // D-51's two pinned sentences (the no-research report and the question-scoped pass) survive.
        expect(prompt).toContain('reportNoResearch');
        expect(prompt).toContain('Work the questions this job names');
    });

    it('the Editor is told what there is to select on a group book — and what its verdicts trigger', () => {
        const prompt = promptOf('editor-general');

        // R2/R5: no competing Summary round; five contradicting groups are arbitrated, not selected.
        expect(prompt).toContain('GROUP BOOKS.');
        expect(prompt).toContain('there is no Summary selection to make');
        expect(prompt).toContain('arbitrated, not selected');
        // R3: the scope it confirms is the scope the repair is routed and closed by.
        expect(prompt).toContain('closes only once EVERY group it names has been revised to answer it');
        // D-34/D-35: approval is what creates the work, and the cost dial decides who is asked.
        expect(prompt).toContain('Approving it is what turns it into a Writer task (D-34)');
        expect(prompt).toContain('`auto` follows this Story’s `auto_approve` dial for that cost (D-35)');

        // The pinned admissibility gates, the speed rule and the editable rules are untouched.
        expect(prompt).toContain('ADMISSIBILITY comes before accuracy');
        expect(prompt).toContain('The phase waits on these verdicts, so be fast');
        expect(byName('editor-general').selection_rules).toContain('Edit me');
    });
});
