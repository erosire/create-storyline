// U-8 / U-8a / U-8b / U-8c / U-8d / D-17 / D-17b / D-38 — the template catalogue.
//
// P12 is why every dial here is reachable: a template is the Author's judgment externalised, so the
// panel must let them create one, duplicate a built-in (never edit one in place, D-17), edit the
// role prompts, `agents` + `aggregate` (D-38), `selection_rules` IN PLACE (U-8b, D-17c), `attempts`
// (U-8c — the divergence dial), and assign it to the Story as a Writer (D-17b, D-38a).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TemplatesPanel } from './TemplatesPanel';
import { click, type } from '../testing/shell-fakes';
import { fixtureActions, fixtureStory, fixtureTemplates } from './story-fixtures';

function renderTemplates(handlers: Partial<Parameters<typeof TemplatesPanel>[0]> = {}) {
    return render(<TemplatesPanel templates={fixtureTemplates()} story={fixtureStory()} {...handlers} />);
}

/** One template card, addressed by its record id. */
function card(templateId: string): HTMLElement {
    const found = Array.from(document.querySelectorAll<HTMLElement>('.sv-template')).find(
        (element) =>
            // The `t-` ids are not printed, so the card is addressed through its crew's name instead.
            element.querySelector('.sv-template-name')?.textContent ===
            (templateId === 't-chapters' ? 'chapters' : 'core-reader')
    );
    if (!found) {
        throw new Error(`no template card for ${templateId}`);
    }
    return found;
}

describe('TemplatesPanel — the Author\u2019s crews (U-8, D-17, D-38)', () => {
    it('draws each card with the dials on its face: phases, done-definition, attempts, and role kinds', () => {
        renderTemplates();

        expect(card('t-chapters').className).toContain('sv-template');
        expect(within(card('t-chapters')).getByText('Chapter crew')).toBeTruthy();
        expect(within(card('t-chapters')).getByText('serves: ③ Chapters')).toBeTruthy();
        expect(
            within(card('t-chapters')).getByText(
                'done when: every criterion the plotline names is answerable from the prose'
            )
        ).toBeTruthy();
        expect(
            within(card('t-chapters')).getByText('escalates when: two flat rounds on the same criterion (L-18)')
        ).toBeTruthy();

        // U-8c: the divergence dial is stated on the card, because it is what turns divergence on.
        expect(
            within(card('t-chapters')).getByText(
                'attempts: 2 competing drafts per unit — the dial that turns divergence on and off (D-17d, U-8c)'
            )
        ).toBeTruthy();

        // U-8a: the writer is visually distinct from the crew that only judges.
        const kinds = Array.from(card('t-chapters').querySelectorAll('.sv-role-kind')).map((node) => node.textContent);
        expect(kinds).toEqual(['writer', 'editor', 'reader']);
        expect(card('t-chapters').querySelector('.sv-kind-writer')!.className).toContain('sv-kind-writer');
        expect(card('t-chapters').querySelector('.sv-role-writer')).toBeTruthy();

        // U-8d: N agents answering once is invisible unless the row says so.
        const panelLines = Array.from(card('t-chapters').querySelectorAll('.sv-role-panel')).map(
            (node) => node.textContent
        );
        expect(panelLines).toEqual([
            'agents: 3 · aggregate: merge — one answer, one report (D-38)',
            'agents: 2 · aggregate: majority — one answer, one report (D-38)'
        ]);
        // T-6b: `web` is an instruction hint, not a permission.
        expect(within(card('t-chapters')).getByText('web — its brief tells it to research (T-6b)')).toBeTruthy();
    });

    it('locks a built-in against in-place editing and offers Duplicate as its only mutation (D-17)', async () => {
        const { actions, calls } = fixtureActions();
        renderTemplates({ onCreate: (input) => void actions.createTemplate?.(input) });

        const builtin = card('t-builtin');
        expect(builtin.className).toContain('sv-template-builtin');
        expect(builtin.className).toContain('sv-template-locked');
        expect(within(builtin).getByText('built-in — duplicate it, never edit in place (D-17)')).toBeTruthy();
        // A built-in has no editable dials at all: no agents input, no attempts setter.
        expect(builtin.querySelector('.sv-role-agents')).toBeNull();
        expect(builtin.querySelector('.sv-template-attempts-set')).toBeNull();
        // And its prompt is read-only in place.
        expect((builtin.querySelector('.sv-role-prompt-text') as HTMLTextAreaElement).readOnly).toBe(true);

        await click(within(builtin).getByRole('button', { name: 'Duplicate' }));
        // The route's own duplicate verb: the server copies the row, so the id stays allocated there.
        expect(calls.createTemplate).toEqual([[{ duplicate_of: 't-builtin' }]]);
    });

    it('creates an Author crew from scratch, editable and never a built-in (D-17, P12)', async () => {
        const creations: Array<{ template?: { name: string; builtin: boolean; editable: boolean } }> = [];
        renderTemplates({ onCreate: (input) => void creations.push(input) });

        await click(screen.getByRole('button', { name: 'New' }));
        expect(creations.length).toBe(1);
        expect(creations[0].template).toMatchObject({
            id: 'template_new',
            name: 'author-crew',
            title: 'Author crew',
            builtin: false,
            editable: true,
            serves_phase: ['chapters'],
            attempts: 1,
            roles: [{ name: 'writer', kind: 'writer', prompt: '' }]
        });
    });

    it('edits selection_rules, agents and attempts in place on an Author template (U-8b, U-8c, D-38)', async () => {
        const { actions, calls } = fixtureActions();
        renderTemplates({ onPatch: (templateId, patch) => void actions.patchTemplate?.(templateId, patch) });

        // U-8b / D-17c: the selection rules are the Author's automated taste, edited where they are read.
        const rules = card('t-chapters').querySelector('#sv-rules-t-chapters') as HTMLTextAreaElement;
        expect(rules.value).toBe('Prefers the draft that changes who speaks; refuses a draft that only reads better.');
        await type(rules, 'Refuse any draft that only reads better.');
        await click(within(card('t-chapters')).getByRole('button', { name: 'Save selection_rules' }));
        expect(calls.patchTemplate).toEqual([
            ['t-chapters', { selection_rules: 'Refuse any draft that only reads better.' }]
        ]);

        // D-38: agents per role, with `merge` as the least-lossy default once a role is a panel.
        // Every role row carries its own 'Set agents' button, so the writer row is the scope —
        // the assertion is about the writer dial, not the editor's or the reader's.
        const writerRow = card('t-chapters').querySelector('.sv-role-writer') as HTMLElement;
        const writerAgents = writerRow.querySelector('#sv-agents-t-chapters\\:0') as HTMLInputElement;
        expect(writerAgents.value).toBe('3');
        await type(writerAgents, '4');
        await click(within(writerRow).getByRole('button', { name: 'Set agents' }));
        expect(calls.patchTemplate[1]).toEqual([
            't-chapters',
            {
                roles: [
                    {
                        name: 'writer',
                        kind: 'writer',
                        prompt: 'Write the chapter to the plotline contract.',
                        model: 'local-large',
                        agents: 4,
                        aggregate: 'merge'
                    },
                    {
                        name: 'editor',
                        kind: 'editor',
                        prompt: 'Select one draft and write the selection note.',
                        agents: 1
                    },
                    {
                        name: 'reader',
                        kind: 'reader',
                        prompt: 'Read for the Goal criteria.',
                        web: true,
                        agents: 2,
                        aggregate: 'majority'
                    }
                ]
            }
        ]);

        // U-8c: attempts is the divergence dial, settable on the card.
        await type(card('t-chapters').querySelector('#sv-attempts-t-chapters') as HTMLInputElement, '3');
        await click(within(card('t-chapters')).getByRole('button', { name: 'Set attempts' }));
        expect(calls.patchTemplate[2]).toEqual(['t-chapters', { attempts: 3 }]);
    });

    it('assigns templates additively, and only a crew with a writer may write the prose (D-17b, D-38a)', async () => {
        const { actions, calls } = fixtureActions();
        renderTemplates({ onAssign: (storyId, refs) => void actions.assignTemplates?.(storyId, refs) });

        // D-17b: the assignment list is the crew; this one is already assigned.
        expect(within(card('t-chapters')).getByText('assigned to this story')).toBeTruthy();
        await click(within(card('t-chapters')).getByRole('button', { name: 'Assign as Writer of this story' }));
        expect(calls.assignTemplates).toEqual([['s1', ['t-chapters']]]);

        // D-38a: assigning a second writer is two voices, so the verb is repeatable and additive.
        await click(within(card('t-builtin')).getByRole('button', { name: 'Assign to phase' }));
        expect(calls.assignTemplates[1]).toEqual(['s1', ['t-chapters', 't-builtin']]);

        // A crew with no writer role cannot write prose, and says so by staying disabled (U-8a).
        expect(
            (
                within(card('t-builtin')).getByRole('button', {
                    name: 'Assign as Writer of this story'
                }) as HTMLButtonElement
            ).disabled
        ).toBe(true);
        // The phase the assignment lands on is chosen on the card (L-4: the loops are separate).
        expect((card('t-builtin').querySelector('#sv-phase-t-builtin') as HTMLSelectElement).value).toBe('summary');
    });

    it('disables every mutation when the template endpoints have not landed (U-16)', () => {
        renderTemplates();

        expect((screen.getByRole('button', { name: 'New' }) as HTMLButtonElement).disabled).toBe(true);
        const duplicates = Array.from(document.querySelectorAll<HTMLButtonElement>('.sv-template-duplicate'));
        expect(duplicates.length).toBe(2);
        expect(duplicates.every((button) => button.disabled)).toBe(true);
        expect((card('t-chapters').querySelector('.sv-template-rules-save') as HTMLButtonElement).disabled).toBe(true);
        expect((card('t-chapters').querySelector('.sv-template-assign-writer') as HTMLButtonElement).disabled).toBe(
            true
        );
    });
});
