// Harness resolution — turning a Work Item's `templateRef` + `roleName` into the two things
// the brief and the permission row need: the role's PROMPT and its KIND.
//
// WHY THIS LIVES APART FROM THE BRIEF: three layers need the same resolution — the assembled
// brief (S-2), the D-38 panel (which re-runs that role's prompt N times), and the D-17e
// delegate hook (which needs the prompt of a role named at call time, inside the SAME
// template). One resolver, one set of fallbacks, one place to reconcile when T3's session
// shape lands.
//
// WHY A MISSING ROLE IS A WARNING IN THE BRIEF RATHER THAN A FAILURE: the catalogue is the
// Author's (D-17, D-38a) and an assignment can legitimately name a role a duplicate renamed.
// Failing the run on a name mismatch would strand a Work Item; running with the job text and
// the permission row, and TELLING the agent its instructions are missing, is the honest
// version — D-17a names "a kind with no instructions" as the actual failure mode, and a silent
// one is worse than a stated one.
import { ROLE_KINDS, type RoleKind, type Template, type TemplateRole } from '../../shared/types';
import type { Store } from '../store';
import type { WorkItem } from './types';

/** A resolved harness: the template row (maybe absent), the role (maybe absent), and the kind that selects the permission row. */
export interface ResolvedHarness {
    template?: Template;
    role?: TemplateRole;
    /** D-17a/T-0: kind selects the brief AND the permission row, never the tool list (T-6a). */
    kind: RoleKind;
    /** The role name to attribute and to show on the crew panel (U-7). */
    roleName: string;
    /** Set when the template or role could not be found — rendered into the brief, not swallowed. */
    warning?: string;
}

/** A template is addressable by row id OR by slug, because `template_refs` and the catalogue both use the slug. */
export const findTemplate = (store: Store, ref: string): Template | undefined =>
    store.templates.list().find((template) => template.id === ref || template.name === ref);

/**
 * Resolves the harness a Work Item runs as. `roleName` may be a role NAME (§4.12
 * `roles[].name`) or a role KIND — the sweep has both, and a Story assigned `editor-general`
 * with `roleName: 'editor'` must not fail because the Author renamed nothing.
 */
export function resolveHarness(store: Store, item: WorkItem): ResolvedHarness {
    const template = findTemplate(store, item.templateRef);

    if (template === undefined) {
        // No template row: the kind is still knowable when the role name IS a kind, and the
        // permission row is what actually matters (T-1a refuses the writes the kind may not make).
        const kind: RoleKind = (ROLE_KINDS as readonly string[]).includes(item.roleName)
            ? (item.roleName as RoleKind)
            : 'checker';

        return {
            kind,
            roleName: item.roleName,
            warning: `no template named "${item.templateRef}" is in the catalogue, so this run has no role prompt and no selection_rules — the job text is the only instruction it holds (D-17a)`
        };
    }

    const roles = template.roles ?? [];
    const byName = roles.find((candidate) => candidate.name === item.roleName);
    const role = byName ?? roles.find((candidate) => candidate.kind === item.roleName);

    if (role === undefined) {
        const kind: RoleKind = (ROLE_KINDS as readonly string[]).includes(item.roleName)
            ? (item.roleName as RoleKind)
            : 'checker';

        return {
            template,
            kind,
            roleName: item.roleName,
            warning: `template "${template.name}" has no role named "${item.roleName}" — running with no role prompt (D-17a names a kind with no instructions as the failure mode)`
        };
    }

    return { template, role, kind: role.kind, roleName: role.name };
}

/**
 * The permission line S-2's brief carries so a fresh context knows what its kind may do
 * BEFORE it is refused (T-1a: "the refusal is a teaching message inside the run" — cheaper
 * still when the rule is in the brief; the refusal still lands either way, T-6a).
 */
export function permissionLine(kind: RoleKind): string {
    switch (kind) {
        case 'writer':
            return 'You are the Writer: you are the only thing that writes story artifacts — the Summary in phase ①, the plotlines in ②, the chapters and prose in ③ (P10, D-17b) — and a locked artifact is read-only for you (P5, D-3, D-6). Never `updateDigest`: the engine derives it (D-12a).';
        case 'editor':
            return 'You are the Editor: you may select, merge and verify, and you may never write prose (L-19, T-3b). Your writes land through `selectRevision`, `requestMerge`, `rejectAll`, `verifyIdea` and `verifyFinding` only (D-33, D-22).';
        case 'reader':
            return 'You are a Reader: your contribution is `proposeIdea`, `raiseFinding` and `submitVerdict` (D-26, T-9). Any write to a story artifact is refused naming P10 — propose, never edit.';
        default:
            return 'You are a checker: you read and report — `submitVerdict`, `raiseFinding`, `createTask`, `editTask`, `requestAuthor` (T-1b). Any write to a story artifact is refused naming P10: file the task and let the Writer write it.';
    }
}

/**
 * The generic reasoner prompt for a delegated sub-context whose named role is not in this
 * template (D-17e). It states the two limits T-2b pins: the sub-context holds the parent's
 * permission row and can write nothing the parent could not, and it is amnesiac like every
 * other fresh context (P2), so the task text plus the tools is all it has.
 */
export const genericReasonerPrompt = (role: string, task: string): string =>
    'You are a fresh reasoning sub-context inside ONE run (D-17e, T-2b). You are not a Work Item and you report to nobody but the run that called you: your final text is its only result.\n' +
    'You hold the same tool catalogue as the run that called you and the same permission row, so you can write nothing it could not write (T-2b). You have no memory of any other run (P2) — everything you know is in the task below and in what you read with the tools.\n' +
    'Work the task with tools, then answer in plain prose: the finding or the answer, the evidence line it rests on, and what you could not check from here. Do not editorialise about the run itself.\n\n' +
    `Calling role: ${role}\nTask: ${task}`;

/**
 * The kickoff turn. The brief is the system message (it IS the memory, P1/S-2); this line is
 * the one thing the model is asked to DO, and it restates S-4's closing rule because a run
 * that ends without reporting is a bug in the harness, not a cost.
 */
export const kickoffLine = (reportTools: readonly string[]): string =>
    'Carry out THE JOB in the brief above, using the tools. Write only what your kind may write. ' +
    `End the run by reporting with one of: ${reportTools.join(', ')} — a run that reports nothing is a no-op turn and counts against the Story (S-4).`;

/**
 * The D-38 panel preamble. It says the one thing an agent must know about its own writes
 * (they are proposals; the run applies one winning set) and nothing about the other agents'
 * content, so the blindness P2/L-16 asks for is preserved — knowing the panel EXISTS does not
 * tell an agent what to write, which is what "divergence that knows it is being compared
 * diverges differently" is about.
 */
export const panelPreamble = (index: number, count: number, aggregate: string): string =>
    `\n\n# PANEL MODE (D-38)\n` +
    `You are agent ${index} of ${count} fresh agents answering this job independently. You cannot see the others and must not hedge toward what you guess they would say (P2, L-16).\n` +
    `Your writes are recorded as PROPOSALS: the run aggregates the panel by \`${aggregate}\` and executes only the winning set, so state your position with a plain, decisive call rather than a cautious compromise. ` +
    `End with the report tool that expresses your answer, and put anything the others might disagree with in the note or detail field, where the aggregation will read it.`;
