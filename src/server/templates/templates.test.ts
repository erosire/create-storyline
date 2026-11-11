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

    it('the roster is the crews §6.2 and §14 item 10 name, and every one is duplicate-only (D-17)', () => {
        expect(BUILT_IN_TEMPLATES.map((template) => template.name)).toEqual([
            'writer-summary',
            'writer-plotlines',
            'writer-chapters',
            'editor-general',
            'reader-genre',
            'reader-plausibility',
            'reader-audience',
            'reader-mystery',
            'checker-consistency',
            'checker-prose'
        ]);

        for (const template of BUILT_IN_TEMPLATES) {
            expect([template.builtin, template.editable]).toEqual([true, false]);
        }

        // One Writer per loop (L-4: separate templates and separate done-definitions).
        expect(byName('writer-summary').serves_phase).toEqual(['summary']);
        expect(byName('writer-plotlines').serves_phase).toEqual(['plotlines']);
        expect(byName('writer-chapters').serves_phase).toEqual(['chapters']);

        // The Editor and the four Reader angles, plus the two checkers.
        expect(byName('editor-general').roles.map((role) => role.kind)).toEqual(['editor']);
        expect(
            ['reader-genre', 'reader-plausibility', 'reader-audience', 'reader-mystery'].map(
                (name) => byName(name).roles[0].kind
            )
        ).toEqual(['reader', 'reader', 'reader', 'reader']);
        expect(byName('checker-consistency').roles[0].kind).toBe('checker');
        expect(byName('checker-prose').roles[0].kind).toBe('checker');
    });

    it('D-17d / E-4 / §14 item 9: divergence defaults ABOVE one, and Phase 1 gets most', () => {
        expect(byName('writer-summary').attempts).toBe(3);
        expect(byName('writer-plotlines').attempts).toBe(2);
        expect(byName('writer-chapters').attempts).toBe(2);

        // A checker or Editor that reported once per unit; `attempts` is the divergence dial, and
        // on these two it is the Author's setting rather than an engine constant (D-38a).
        expect(byName('editor-general').attempts).toBe(1);
        expect(byName('checker-consistency').attempts).toBe(1);
    });

    it('D-30 / T-6b: the Readers are defined by their instructions and hold web research', () => {
        for (const name of ['reader-genre', 'reader-plausibility', 'reader-audience', 'reader-mystery']) {
            const role = byName(name).roles[0];

            expect(role.web).toBe(true);
            // D-30: the brief says what it reads for and that it may propose, and T-9 says it may
            // not write — the prompt is where that lives, because the tool list does not (D-17a).
            expect(role.prompt).toContain('proposeIdea');
            expect(role.prompt).toMatch(/never write|do not write|You never write/i);
        }

        // The plausibility angle is the one whose value IS research, so it is told to fetch the
        // source it cites rather than trusting a snippet (D-27, T-10).
        expect(byName('reader-plausibility').roles[0].prompt).toContain('fetchPage');
    });

    it('P12 / U-8b: the Editor template carries the Author\u2019s selection_rules as editable starter text', () => {
        const rules = byName('editor-general').selection_rules ?? '';

        // C-13's evidence is this text (G-3a), so it must exist and must read as an instruction
        // the Author can rewrite — the marker is the product's core tuning affordance.
        expect(rules.length).toBeGreaterThan(200);
        expect(rules).toContain('Edit me');
        expect(byName('checker-prose').roles[0].prompt).toContain('selection_rules');
    });

    it('G-3a: the prose checker\u2019s whole standard is inside the book, so it does not browse', () => {
        expect(byName('checker-prose').serves_phase).toEqual(['chapters']);
        expect(byName('checker-prose').roles[0].web).toBe(false);

        // The consistency checker reads the whole chain at every phase (C-2…C-9, L-8a).
        expect(byName('checker-consistency').serves_phase).toEqual(['summary', 'plotlines', 'chapters']);
    });

    it('D-17e: only the Writer and the Editor templates declare in-run delegation, and every target is a role', () => {
        const delegation = Object.fromEntries(
            BUILT_IN_TEMPLATES.map((template) => [template.name, template.delegation ?? []])
        );

        expect(delegation).toEqual({
            'writer-summary': ['checker'],
            'writer-plotlines': ['checker'],
            'writer-chapters': ['checker'],
            'editor-general': ['reader', 'checker'],
            'reader-genre': [],
            'reader-plausibility': [],
            'reader-audience': [],
            'reader-mystery': [],
            'checker-consistency': [],
            'checker-prose': []
        });
    });
});

describe('W8 — T-0 structural assignment rules', () => {
    it('the default assignment is legal at every phase', () => {
        for (const phase of ['summary', 'plotlines', 'chapters'] as StoryPhase[]) {
            expect(validateAssignment(storyAt(phase), DEFAULT_ASSIGNMENT)).toEqual([]);
        }

        // §14 item 10's four angles and the one Editor are all in it; the prose checker is the
        // opt-in crew, which is why U-8 (not the default) assigns it.
        expect(DEFAULT_ASSIGNMENT).toEqual([
            'writer-summary',
            'writer-plotlines',
            'writer-chapters',
            'editor-general',
            'reader-genre',
            'reader-plausibility',
            'reader-audience',
            'reader-mystery',
            'checker-consistency'
        ]);
    });

    it('T-0 / D-17b: an assignment with no Writer is refused', () => {
        expect(validateAssignment(storyAt('summary'), ['editor-general'])).toEqual([
            'assignment has no Writer template — write permission comes only from a template assigned as a Writer (D-17b, P10)'
        ]);
    });

    it('T-0 / D-33: a Reader or checker assigned without an Editor is refused', () => {
        // Someone is about to file findings the loop would act on unverified.
        expect(validateAssignment(storyAt('summary'), ['writer-summary', 'reader-genre'])).toEqual([
            'assignment needs an Editor template: drafts compete once attempts > 1 (D-23) and every Reader or checker finding must be verified before the loop acts on it (D-33, T-0)'
        ]);

        expect(validateAssignment(storyAt('summary'), ['writer-summary', 'checker-consistency'])).toHaveLength(1);
    });

    it('T-0 / D-23: attempts > 1 without an Editor is refused — nobody would choose between the drafts', () => {
        // `writer-chapters` alone: attempts 2, and no Editor anywhere.
        expect(validateAssignment(storyAt('chapters'), ['writer-chapters'])).toEqual([
            'assignment needs an Editor template: drafts compete once attempts > 1 (D-23) and every Reader or checker finding must be verified before the loop acts on it (D-33, T-0)'
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
        expect(source.delegation).toEqual(['reader', 'checker']);
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
            'template editor-ghost.delegation names "poet", which is neither a role kind (writer, editor, reader, checker) nor one of this template\u2019s roles (D-17e)'
        ]);
    });

    it('a duplicate of a duplicated crew keeps being editable (D-17 chains, and the copy stays independent)', () => {
        const first = duplicateTemplate(byName('checker-prose'), 'prose-cold');
        const second = duplicateTemplate(first, 'prose-colder');

        expect([second.builtin, second.editable]).toEqual([false, true]);
        expect(second.roles[0].web).toBe(false);

        second.roles[0].prompt = 'third voice';

        expect(byName('checker-prose').roles[0].prompt).not.toBe('third voice');
        expect(first.roles[0].prompt).not.toBe('third voice');
    });
});
