// U-8 / U-8a / U-8b / U-8c / U-8d / D-17 / D-38 — the template panel: the harness catalogue.
//
// P12 is the reason this panel exists: a template is not a generic expert, it is THIS Author's
// judgment externalised, so every dial that shapes the crew has to be reachable from the UI.
//   - U-8a: the Writer must be visually distinct from the crew that only judges (U-8a, D-17b).
//   - U-8b: an Editor's `selection_rules` is editable IN PLACE, because that text IS the Author's
//     automated taste (D-17c) — editing it and watching the next `selection_note` change is the
//     product's core tuning loop.
//   - U-8c: `attempts` is on the card because it is the dial that turns divergence on and off (D-17d).
//   - U-8d: each role row states `agents: N` and its `aggregate` mode, since "this Editor is three
//     agents that argue and return one answer" (D-38) is otherwise invisible.
//
// D-17 closes the set of verbs: create from scratch, duplicate, then edit roles/prompts, agents
// and aggregate, selection_rules, attempts, and done-definition. Built-ins are duplicated, NEVER
// edited in place — so their edit controls are disabled and Duplicate is the only mutation.
//
// D-17b/D-38a: write permission comes from a template ASSIGNED to the Story as a Writer, and the
// count is the Author's call, so "Assign as Writer" is repeatable and assigning a second Writer is
// two voices, not a configuration error (the loop reports their divergence as a `taste` finding).
import { useState } from 'react';
import { blankTemplatePayload, hasEditorRole, isPanelRole } from './story-contract';
import { PHASE_LABELS, PHASE_ORDER } from './story-contract';
import type { Story, StoryPhase, Template, TemplateRole } from '../../shared/types';

/** U-8a: the kind badge is where the writer/judge distinction is made legible. */
function kindClass(role: TemplateRole): string {
    return `sv-role-kind sv-kind-${role.kind}${role.kind === 'writer' ? ' sv-kind-writer' : ''}`;
}

/** Replacing one role inside the template record (the roles array is the whole payload). */
function withRole(template: Template, index: number, next: TemplateRole): TemplateRole[] {
    return template.roles.map((role, position) => (position === index ? next : role));
}

export interface TemplatesPanelProps {
    templates: Template[];
    story: Story;
    /**
     * D-17's two create verbs, in the route's shape: `template` for **New** (the Author's own crew
     * body) and `duplicate_of` for **Duplicate** (the server copies the row, so the id and the name
     * of the copy stay allocated in one place — P3).
     */
    onCreate?: (input: { template?: Template; duplicate_of?: string }) => void;
    onPatch?: (templateId: string, patch: Partial<Template>) => void;
    onAssign?: (storyId: string, templateRefs: string[]) => void;
}

export function TemplatesPanel({ templates, story, onCreate, onPatch, onAssign }: TemplatesPanelProps) {
    // Drafts are keyed by template (and by role index inside a template) so editing one card never
    // bleeds into another card's inputs.
    const [rules, setRules] = useState<Record<string, string>>({});
    const [prompts, setPrompts] = useState<Record<string, string>>({});
    const [agents, setAgents] = useState<Record<string, string>>({});
    const [attempts, setAttempts] = useState<Record<string, string>>({});
    const [phase, setPhase] = useState<Record<string, StoryPhase>>({});

    /** Assigning is additive: the Story's template set is the crew, never a single replacement. */
    const assign = (templateId: string): void => {
        const current = story.template_refs.includes(templateId)
            ? story.template_refs
            : [...story.template_refs, templateId];
        onAssign?.(story.id, current);
    };

    return (
        <aside className="sv-pane sv-templates" aria-label="Templates">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Templates — the harness catalogue (U-8)</h3>
                <span className="sv-pane-badge">the Author&apos;s own judgment, automated (P12)</span>
            </header>

            {/* U-8: New is the from-scratch verb D-17 requires alongside Duplicate. */}
            <button
                type="button"
                className="sv-template-new"
                disabled={!onCreate}
                title="Create a crew from scratch (D-17)"
                onClick={() => onCreate?.({ template: blankTemplatePayload() })}
            >
                New
            </button>

            {templates.map((template) => {
                // D-17: a built-in is a starting point to be duplicated into the Author's likeness.
                const locked = !template.editable || template.builtin;
                const assigned = story.template_refs.includes(template.id);
                const editor = hasEditorRole(template);

                return (
                    <article
                        className={`sv-template${template.builtin ? ' sv-template-builtin' : ''}${locked ? ' sv-template-locked' : ''}`}
                        key={template.id}
                    >
                        <div className="sv-template-head">
                            <h4 className="sv-template-title">{template.title}</h4>
                            <code className="sv-template-name">{template.name}</code>
                            {template.builtin ? (
                                // D-17 stated on the card, so the disabled controls are never a mystery.
                                <span className="sv-badge sv-badge-lock">
                                    built-in — duplicate it, never edit in place (D-17)
                                </span>
                            ) : null}
                            {assigned ? (
                                <span className="sv-badge sv-badge-assigned">assigned to this story</span>
                            ) : null}
                        </div>

                        <p className="sv-template-phases">
                            {/* L-4: the three loops are separate templates, so which phases this one serves is load-bearing. */}
                            serves:{' '}
                            {template.serves_phase.map((serves) => PHASE_LABELS[serves]).join(' · ') || 'no phase'}
                        </p>
                        <p className="sv-template-done">done when: {template.done_definition || 'not defined'}</p>
                        {template.escalation_rule ? (
                            <p className="sv-template-escalation">escalates when: {template.escalation_rule}</p>
                        ) : null}

                        {/* U-8c: attempts is the divergence dial, so it is on the face of the card. */}
                        <p className={`sv-template-attempts${template.attempts > 1 ? ' sv-template-divergent' : ''}`}>
                            attempts: {template.attempts} competing draft{template.attempts === 1 ? '' : 's'} per unit —
                            the dial that turns divergence on and off (D-17d, U-8c)
                        </p>

                        <ul className="sv-template-roles">
                            {template.roles.map((role, index) => {
                                const draftKey = `${template.id}:${index}`;

                                return (
                                    <li
                                        className={`sv-role${role.kind === 'writer' ? ' sv-role-writer' : ''}`}
                                        key={`${template.id}-${role.name}`}
                                    >
                                        <span className={kindClass(role)}>{role.kind}</span>
                                        <span className="sv-role-name">{role.name}</span>
                                        {/* T-6b: web is an instruction hint, not a permission — everyone may browse. */}
                                        {role.web ? (
                                            <span className="sv-role-web">
                                                web — its brief tells it to research (T-6b)
                                            </span>
                                        ) : null}
                                        {/* U-8d: N agents answering once is otherwise invisible on the card. */}
                                        {isPanelRole(role) ? (
                                            <span className="sv-role-panel">
                                                agents: {role.agents} · aggregate: {role.aggregate ?? 'merge'} — one
                                                answer, one report (D-38)
                                            </span>
                                        ) : null}

                                        <details className="sv-role-prompt">
                                            <summary>
                                                prompt — the instructions that make it this Author&apos;s crew (D-17a)
                                            </summary>
                                            <textarea
                                                className="sv-role-prompt-text"
                                                rows={4}
                                                readOnly={locked}
                                                value={prompts[draftKey] ?? role.prompt}
                                                onChange={(event) =>
                                                    setPrompts((current) => ({
                                                        ...current,
                                                        [draftKey]: event.target.value
                                                    }))
                                                }
                                            />
                                            {role.model ? <p className="sv-role-model">model: {role.model}</p> : null}
                                        </details>

                                        {!locked ? (
                                            <div className="sv-role-agents">
                                                <label htmlFor={`sv-agents-${draftKey}`}>agents per role (D-38)</label>
                                                <input
                                                    id={`sv-agents-${draftKey}`}
                                                    type="number"
                                                    min={1}
                                                    className="sv-role-agents-input"
                                                    value={agents[draftKey] ?? String(role.agents ?? 1)}
                                                    onChange={(event) =>
                                                        setAgents((current) => ({
                                                            ...current,
                                                            [draftKey]: event.target.value
                                                        }))
                                                    }
                                                />
                                                <button
                                                    type="button"
                                                    className="sv-role-agents-save"
                                                    disabled={!onPatch}
                                                    onClick={() =>
                                                        onPatch?.(template.id, {
                                                            // D-38: `aggregate` is required once a role is a panel; `merge` is the
                                                            // least-lossy default for prose-producing roles.
                                                            roles: withRole(template, index, {
                                                                ...role,
                                                                agents: Number(
                                                                    agents[draftKey] ?? String(role.agents ?? 1)
                                                                ),
                                                                aggregate: (Number(
                                                                    agents[draftKey] ?? String(role.agents ?? 1)
                                                                ) > 1
                                                                    ? (role.aggregate ?? 'merge')
                                                                    : role.aggregate) as TemplateRole['aggregate']
                                                            })
                                                        })
                                                    }
                                                >
                                                    Set agents
                                                </button>
                                            </div>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>

                        {editor ? (
                            // U-8b: the rules are edited IN PLACE because reading them elsewhere breaks the
                            // tuning loop the whole product runs on (D-17c, G-3a).
                            <div className="sv-template-rules">
                                <label htmlFor={`sv-rules-${template.id}`}>
                                    selection_rules — your taste, in your words (U-8b, D-17c)
                                </label>
                                <textarea
                                    id={`sv-rules-${template.id}`}
                                    className="sv-template-rules-text"
                                    rows={5}
                                    readOnly={locked}
                                    value={rules[template.id] ?? template.selection_rules ?? ''}
                                    placeholder="what it prefers, what it weighs, what it refuses, how it merges"
                                    onChange={(event) =>
                                        setRules((current) => ({ ...current, [template.id]: event.target.value }))
                                    }
                                />
                                <button
                                    type="button"
                                    className="sv-template-rules-save"
                                    // D-17: the built-in's rules are read here and edited on the duplicate.
                                    disabled={!onPatch || locked}
                                    title={
                                        locked
                                            ? 'Built-ins are duplicated, never edited in place (D-17)'
                                            : 'Save — the next selection_note should read differently'
                                    }
                                    onClick={() =>
                                        onPatch?.(template.id, { selection_rules: rules[template.id] ?? '' })
                                    }
                                >
                                    Save selection_rules
                                </button>
                            </div>
                        ) : null}

                        <div className="sv-template-actions">
                            <button
                                type="button"
                                className="sv-template-duplicate"
                                disabled={!onCreate}
                                title="Copy this crew and edit the copy (D-17)"
                                onClick={() => onCreate?.({ duplicate_of: template.id })}
                            >
                                Duplicate
                            </button>

                            {!locked ? (
                                <div className="sv-template-attempts-set">
                                    <label htmlFor={`sv-attempts-${template.id}`}>attempts (U-8c)</label>
                                    <input
                                        id={`sv-attempts-${template.id}`}
                                        type="number"
                                        min={1}
                                        className="sv-template-attempts-input"
                                        value={attempts[template.id] ?? String(template.attempts)}
                                        onChange={(event) =>
                                            setAttempts((current) => ({
                                                ...current,
                                                [template.id]: event.target.value
                                            }))
                                        }
                                    />
                                    <button
                                        type="button"
                                        className="sv-template-attempts-save"
                                        disabled={!onPatch}
                                        onClick={() =>
                                            onPatch?.(template.id, {
                                                attempts: Number(attempts[template.id] ?? String(template.attempts))
                                            })
                                        }
                                    >
                                        Set attempts
                                    </button>
                                </div>
                            ) : null}

                            <div className="sv-template-assign">
                                <label htmlFor={`sv-phase-${template.id}`}>assign to phase</label>
                                <select
                                    id={`sv-phase-${template.id}`}
                                    className="sv-template-phase"
                                    value={phase[template.id] ?? template.serves_phase[0] ?? 'chapters'}
                                    disabled={!onAssign}
                                    onChange={(event) =>
                                        setPhase((current) => ({
                                            ...current,
                                            [template.id]: event.target.value as StoryPhase
                                        }))
                                    }
                                >
                                    {PHASE_ORDER.map((candidate) => (
                                        <option key={candidate} value={candidate}>
                                            {PHASE_LABELS[candidate]}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    className="sv-template-assign-phase"
                                    disabled={!onAssign}
                                    title="Adds this template to the story's crew for the chosen phase (D-17b)"
                                    onClick={() => assign(template.id)}
                                >
                                    Assign to phase
                                </button>

                                {/* D-17b / D-38a: repeatable, and the only route to write permission. */}
                                <button
                                    type="button"
                                    className="sv-template-assign-writer"
                                    disabled={!onAssign || !template.roles.some((role) => role.kind === 'writer')}
                                    title="Assign as a Writer of this story. Repeatable: two Writer templates are two voices, and their divergence surfaces as a taste finding (D-17b, D-38a)."
                                    onClick={() => assign(template.id)}
                                >
                                    Assign as Writer of this story
                                </button>
                            </div>
                        </div>
                    </article>
                );
            })}
        </aside>
    );
}
