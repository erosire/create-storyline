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
            'editor-group-lock',
            'critic-genre',
            'critic-plausibility',
            'critic-audience',
            'critic-mystery',
            'reader-consistency',
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
            ['critic-screening', 'critic-genre', 'critic-plausibility', 'critic-audience', 'critic-mystery'].map(
                (name) => byName(name).roles[0].kind
            )
        ).toEqual(['critic', 'critic', 'critic', 'critic', 'critic']);
        expect(byName('reader-consistency').roles[0].kind).toBe('reader');
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
                // D-33b: the angle's own improvement outlet. Convention can be satisfied AND outdone, and
                // the second half is a proposal, not the defect this prompt spends its standing on. The
                // cost clause is part of the pin: D-33b's ladder gives a proposal `major`/`minor`/`taste`
                // and refuses `critical`, so an angle that names the kind without naming the ladder sends
                // the Critic to a cost the tool will reject (`tools/reader.ts:raiseFinding`).
                improvement:
                    'Convention satisfied is not the same as convention outdone: when the Summary promises what the genre asks and you can still name the better version of it, file that with raiseFinding as `kind: proposal` at cost `major` or `minor` (title it as a proposal, quote the passage it would improve, and say what changes and why the pass is worth it), because it is a proposal about a book that breaks nothing, not a defect.'
            },
            'critic-plausibility': {
                silence:
                    'This is a plotline and chapter check: when the artifact under review is a SUMMARY (phase \u2460) there is no ledger and no earlier chapter yet, so "nothing established it" is not a factual doubt there, and the Writer is free to establish a fact the Seed never named as long as it contradicts nothing.',
                laterPhases:
                    'Phases \u2461 and \u2462 keep every check above unchanged: there the ledger and the earlier chapters DO make those promises, and a setup that never arrives is a defect again.',
                // D-33b: this angle is the one carrying a source, so its proposal is worth citing.
                improvement:
                    'And when the fact checks out but you can cite a better one, the truer detail the book could carry instead, say so with raiseFinding as `kind: proposal`: quote the passage it would improve, name the source that supports the better version, and keep it a proposal rather than a defect, because a text that is merely improvable has broken nothing.'
            },
            'critic-audience': {
                silence:
                    'When the artifact under review is a SUMMARY (phase \u2460), none of those complaints has a page to stand on unless the Summary itself promises the setup and then breaks it: the Seed is general, the Writer may invent any detail the Seed does not rule out, and an unpaid setup, an unstated stake or a consequence the Seed left open is not a reader complaint at this phase.',
                laterPhases: 'Phases \u2461 and \u2462 keep the full list \u2014 there the book has made the promise and owes the payoff.',
                // D-33b: this angle's signature complaint IS an absence ("the payoff arrived without the
                // setup"). Stood down at phase ① it had nowhere to go; it now routes to the proposal kind.
                improvement:
                    'file it with raiseFinding as `kind: proposal`, quoting the passage it would improve and saying in `detail` why the payoff lands better if the setup moves.'
            },
            'critic-mystery': {
                silence:
                    'When the artifact under review is a SUMMARY (phase \u2460): there is no ledger and no chapter order yet, so do not file "it was never planted" or "the answer arrives without its setup" against one \u2014 the Writer is allowed to bring in what the Seed never stated, and the Summary\u2019s own ending is not owed an earlier hint.',
                laterPhases: 'Phases \u2461 and \u2462 keep every setup-and-payoff check in this prompt unchanged.',
                // D-33b: "this came too early" was the SUSPICION framing; at phase ① there is no planting
                // to jump, so the sentence is really a reorder request.
                improvement:
                    'Where the artifact under review is a SUMMARY there is no planting to jump, so the same observation is a PROPOSAL rather than a suspicion: file it with raiseFinding as `kind: proposal`, quoting the passage that gives the game away and saying in `detail` which move would earn the reveal, and the Editor weighs whether the book is better for the reorder rather than whether the Seed ever promised one.'
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

    it('D-33c/D-33d — every role that is invited to propose is told, in its own words, that issues come first', () => {
        // WHY THIS IS PINNED PER ROLE, IN FULL SENTENCES, AND NOT ONCE GLOBALLY: the filing rule and the
        // approval rule are enforced in CODE (`tools/reader.ts:raiseFinding`, `tools/editor.ts:approveFinding`)
        // and stated in the engine-owned brief (`run/brief.ts`), and neither of those is Author-editable.
        // What IS editable is the role prompt — and the sentence that invites each angle to file a
        // proposal is the sentence the model actually acts on. An angle whose invitation says "file the
        // improvement" and nothing else sends the Critic into a refusal it has to spend a turn decoding,
        // which is the same failure T3 pinned for the absence rule. So the gating note is pinned for each
        // angle that has an outlet, in that angle's own wording: deleting one is a regression in one
        // angle's behaviour, and a regex would let three of the four silently disappear.
        const gating: Record<string, { outlet: string; review: string }> = {
            'critic-genre': {
                outlet:
                    'File Proposals only when no issue is open: while this Story has an unresolved issue, `raiseFinding` refuses a `kind: proposal` call and the Editor cannot approve one either (D-33c, D-33d) — report the defect in this pass and bring the genre move in a pass that has none left.',
                review:
                    'This is a review pass unless the job says otherwise: report defects, and file a genuine improvement as a `kind: proposal` finding rather than an Idea — do not restock the Ideas tray. File Proposals only when no issue is open, and never beside one: while an issue is unresolved the tool refuses a `kind: proposal` call, and an issue and a proposal never share a pass (D-33c). When the job explicitly asks for proposals, file genre moves with proposeIdea and read the decided Ideas first (readIdeas, D-28, D-32).'
            },
            'critic-plausibility': {
                outlet:
                    'File Proposals only when no issue is open: while this Story has an unresolved issue, `raiseFinding` refuses a `kind: proposal` call and the Editor cannot approve one either (D-33c, D-33d) — report the defect in this pass and bring the sourced improvement in a pass that has none left.',
                review:
                    'This is a review pass unless the job says otherwise: report findings, and file a genuine improvement as a `kind: proposal` finding rather than an Idea. File Proposals only when no issue is open, and never beside one: while an issue is unresolved the tool refuses a `kind: proposal` call, and an issue and a proposal never share a pass (D-33c). When the job explicitly asks for proposals, file the sourced possibility with proposeIdea (D-26, D-27).'
            },
            'critic-audience': {
                outlet:
                    'File Proposals only when no issue is open: while this Story has an unresolved issue, `raiseFinding` refuses a `kind: proposal` call and the Editor cannot approve one either (D-33c, D-33d) — report the defect in this pass and bring what readers deserve in a pass that has none left.',
                review:
                    'This is a review pass unless the job says otherwise: report findings only — a genuine improvement is filed as a `kind: proposal` finding, not restocked in the Ideas tray. File Proposals only when no issue is open, and never beside one: while an issue is unresolved the tool refuses a `kind: proposal` call, and an issue and a proposal never share a pass (D-33c). When the job explicitly asks for proposals, propose the fix as an Idea (proposeIdea) — you are expected to be wrong often, and that is what makes proposing cheap (D-28); consult the decided Ideas first (readIdeas, D-32).'
            },
            'critic-mystery': {
                outlet:
                    'File Proposals only when no issue is open: while this Story has an unresolved issue, `raiseFinding` refuses a `kind: proposal` call and the Editor cannot approve one either (D-33c, D-33d) — report the pacing defect in this pass and bring the reorder in a pass that has none left.',
                review:
                    'This is a review pass unless the job says otherwise: report findings, and file a genuine improvement as a `kind: proposal` finding rather than an Idea. File Proposals only when no issue is open, and never beside one: while an issue is unresolved the tool refuses a `kind: proposal` call, and an issue and a proposal never share a pass (D-33c). When the job explicitly asks for proposals, file reorderings, withheld reveals and moved plantings with their reasoning (proposeIdea), checking what is already decided first (readIdeas, D-32). Never write the book, and never propose removing the mystery altogether — the Author kept it for a reason you can read in the Seed (P5).'
            }
        };

        for (const [name, clauses] of Object.entries(gating)) {
            const prompt = byName(name).roles[0].prompt;

            // The outlet sentence: the invitation and its gate, in the same breath.
            expect(prompt).toContain(clauses.outlet);
            // The standing "this is a review pass" line, which is the sentence a pass with no Summary
            // defect still reads — and the one that used to end at "do not restock the Ideas tray".
            expect(prompt).toContain(clauses.review);
        }

        // The Consistency reader files Proposals too (D-33b moved its "preference" there), so the same
        // gate is written where its cost ladder is written.
        expect(byName('reader-consistency').roles[0].prompt).toContain(
            'A Proposal is also the LAST thing you file, not a side order: while this Story has an unresolved issue, `raiseFinding` refuses a `kind: proposal` call, and an issue and a Proposal never share a pass (D-33c) — report the contradictions and bring the preference once the book has no defect left to answer.'
        );

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
            'editor-group-lock': [],
            'critic-genre': [],
            'critic-plausibility': [],
            'critic-audience': [],
            'critic-mystery': [],
            'reader-consistency': [],
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
            // T-W2: Phrase ②'s structure gate and its contract Writer ride along for the same reason
            // `editor-group-lock` does — each seat binds its crew BY SLUG
            // (`loop/work.ts:phase2GroupCandidates` sets `templateRef`) and the prompt resolves from
            // the catalogue, so their position is not a pool pick. They come LAST because a Writer
            // listed before `writer-plotlines` would become the unbound phase-② write crew and move
            // what a classic-mode Story's `write_unit` run looks like.
            'editor-plotlines-structure',
            'writer-plotlines-sampler'
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

        // H1/R2 with R3: the certificate is per-group, and a review never spends the rewrite allowance.
        expect(prompt).toContain('`resolved` only when EVERY one of those groups now carries the repair');
        expect(prompt).toContain('costs the Story no Writer attempt');

        // The earlier T3 gates (Seed silence, the style ladder) are still in force beside the group text.
        expect(prompt).toContain('A critical is a contradiction the text under review cannot live with');
        expect(prompt).toContain('are NOT issues at this phase');
    });

    it('every tool-carrying review angle scopes a Summary defect to its groups (R3)', () => {
        // The refusal is the reason: `tools/reader.ts:raiseFinding` refuses an unscoped Summary finding
        // on a group-managed book, so a role that is not told this burns the pass on a refusal.
        for (const name of ['critic-genre', 'critic-plausibility', 'critic-audience', 'critic-mystery']) {
            const prompt = promptOf(name);

            expect(prompt).toContain('raiseFinding');
            expect(prompt).toContain('group_refs');
            expect(prompt).toContain('the group ids the brief prints');
        }

        // Each angle states the one-finding rule in its own terms (and the mystery angle in BOTH groups').
        expect(promptOf('critic-genre')).toContain('ONE finding naming three groups');
        expect(promptOf('critic-genre')).toContain('judge the groups AGAINST EACH OTHER');
        expect(promptOf('critic-plausibility')).toContain('ONE finding naming three groups, never three findings');
        expect(promptOf('critic-audience')).toContain('keep it ONE finding however many groups it names');
        expect(promptOf('critic-mystery')).toContain('never name one you have not quoted from');

        // The Consistency reader scopes a Summary defect by group and every later defect by its artifact.
        expect(promptOf('reader-consistency')).toContain('group_refs');
        expect(promptOf('reader-consistency')).toContain('needs no group ids');
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
