// U-8 — the global agent roster's model choices.
//
// WHY THIS IS A SETTING, NOT A TEMPLATE FIELD: a template is a crew definition (D-38) and its
// roles may name their own model (T-6b), but the four agents themselves — Writer, Editor, Reader,
// Checker — are global and shared by every Story. The Agents panel configures THAT identity, so
// its model choice is one host-level fact rather than a value copied onto every template card.
//
// PRECEDENCE (T-6b, stated once here so both the executor and the panel agree):
//   1. the Author's explicit choice for this agent kind on the global roster;
//   2. the run's template role model — the crew's own setting (T-6b);
//   3. the process model (`STORYLINE_PROVIDER_MODEL` / `--model`'s resolved default).
// Choosing a model in the Agents panel is therefore an override with visible effect; until then the
// template card still governs its crew. The projection below carries both the agent's choice and
// every template-role model, so a tile never claims a model a role is about to override.
// The executor asks the same function at spawn time, so the tile and the dispatched run cannot drift.
//
// WHY IT LIVES IN `store`: the choice has to survive a restart (L-3) and the store's atomic
// snapshot is the one durable file the server already owns. Settings are NOT journaled — a model
// name is host configuration, not a story fact, and must never enter the Digest's derivation.
import { ROLE_KINDS, type RoleKind } from '../../shared/types';
import type { Store } from '../store';

/** The key under the store snapshot's `settings` section. */
export const AGENT_MODELS_SETTING = 'agent_models';

/** Where an agent's model came from: the Author's roster choice, or the process default. */
export type AgentModelSource = 'agent' | 'default';

/** The model a kind will use, and why — the two fields the agents projection carries. */
export interface AgentModelChoice {
    model: string;
    source: AgentModelSource;
}

/** One template role that names a model for a kind, so the tile can disclose what would override it. */
export interface AgentTemplateModel {
    /** The template slug (§4.12 `name`) the role belongs to. */
    template: string;
    /** The role's own name inside that template. */
    role: string;
    model: string;
}

/** True for one of the four Storyline agent kinds, so a bad path parameter cannot reach the store. */
export const isAgentKind = (value: string): value is RoleKind => (ROLE_KINDS as readonly string[]).includes(value);

/**
 * The Author's explicit choices, sanitised. A malformed setting (a hand-edited snapshot, an old
 * shape) reads as no choice rather than crashing every run; an unknown key is ignored.
 */
export function agentModelChoices(store: Store): Partial<Record<RoleKind, string>> {
    const raw = store.setting<unknown>(AGENT_MODELS_SETTING);

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }

    const choices: Partial<Record<RoleKind, string>> = {};

    for (const kind of ROLE_KINDS) {
        const model = (raw as Record<string, unknown>)[kind];

        if (typeof model === 'string' && model.trim().length > 0) {
            choices[kind] = model.trim();
        }
    }

    return choices;
}

/** The roster's model for one agent kind, or the process model when the Author has not set one. */
export function agentModelFor(store: Store, defaultModel: string, kind: RoleKind): AgentModelChoice {
    const model = agentModelChoices(store)[kind];

    return model === undefined ? { model: defaultModel, source: 'default' } : { model, source: 'agent' };
}

/**
 * Every template role of one kind that names its own model, in catalogue order. The Agents tile
 * lists these so an Author who set nothing on the roster still knows which card governs the crew.
 */
export function templateRoleModels(store: Store, kind: RoleKind): AgentTemplateModel[] {
    const found: AgentTemplateModel[] = [];

    for (const template of store.templates.list()) {
        for (const role of template.roles ?? []) {
            if (role.kind !== kind) continue;

            const model = role.model?.trim();

            if (model !== undefined && model.length > 0) {
                found.push({ template: template.name, role: role.name, model });
            }
        }
    }

    return found;
}

/**
 * The model a dispatched run should ask for (T-6b, with U-8's roster choice at the top of the
 * order): the agent's explicit choice, else the template role's own model, else the process model.
 */
export function runModelFor(store: Store, defaultModel: string, kind: RoleKind, roleModel?: string): string {
    const choice = agentModelFor(store, defaultModel, kind);

    return choice.source === 'agent' ? choice.model : (roleModel ?? choice.model);
}

/**
 * Records the Author's model for one agent kind. `null` (or a blank string) clears the choice,
 * returning the agent to its template role's model, else the process default; the store's
 * snapshot then writes the absence.
 */
export function setAgentModel(store: Store, kind: RoleKind, model: string | null): void {
    const choices = { ...agentModelChoices(store) };
    const next = model === null ? '' : model.trim();

    if (next.length === 0) {
        delete choices[kind];
    } else {
        choices[kind] = next;
    }

    if (Object.keys(choices).length === 0) {
        store.deleteSetting(AGENT_MODELS_SETTING);

        return;
    }

    store.setSetting(AGENT_MODELS_SETTING, choices);
}
