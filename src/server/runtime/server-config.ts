// S-RUNTIME — the app book: the story-independent configuration one server owns.
//
// WHY THIS EXISTS AT ALL (D-1/D-2). Since P1 a Story's book is a directory that holds EVERYTHING the
// Story owns (`<root>/stories/<uuid>/`), and a Story-bound `Store` refuses a record whose `story_id` is
// not its own (`store/store.ts:_assertStoryScope`). That is exactly why the loop cannot keep reading its
// configuration out of a Story book: the crew catalogue is not a fact about one book — the built-in crews
// and whatever the Author forked configure every book on the machine — and the employee roster and the
// fan-out ceiling are one setting for the process, not one per Story. A Story book therefore has no
// catalogue to answer `/templates` from and no host settings either. This module owns the book that does:
// `<root>/server/`, the app-config-only directory P1 reserved (persist.ts exports `SERVER_DIRECTORY`
// precisely so nobody builds that path by hand).
//
// IT IS A COPY, NOT A LOOKUP. Every engine seam takes ONE `Store` and reads `store.templates` from it:
// `loop/engine.ts:createStory` seeds the catalogue into its own store, `loop/engine.ts:assignTemplates`
// resolves crew rows out of it (`BUILT_IN_TEMPLATES` plus `store.templates.list()`), and the executor
// resolves the crew a run dispatches under the same store. Threading a second store through all three
// would move the Story boundary into modules that never needed to know about it, and would change the
// loop's types and tests for a storage decision. So the catalogue is COPIED into each Story book when the
// book is built, and every read stays the trivially-correct "read my own store".
//
// WHY THE COPY IS SAFE. A `Template` row carries no `story_id`, so it passes the store's scope fence
// untouched (`store/store.ts:_assertStoryScope` only fences records that declare one), and the copy keeps
// the APP ROW'S id verbatim — which is what lets `assignTemplates` report the ids the Author sees in the
// app catalogue, and what makes a re-copy idempotent rather than a fork with a new number.
//
// WHY THE WRITE IS NOT JOURNALED. The Digest's derivation reads a `template_*` event as story work
// (`digest/digest.ts`), so a journaled config copy would (a) litter a Story's audit thread with
// bookkeeping the Author never performed and (b) make every Story's Digest look stale after every boot.
// `Collection._state()`/`_restore()` is the seam the loader itself uses (`store.ts:_hydrate`'s neighbours):
// the rows land in the snapshot with no event, no journal line, and no digest bump.
//
// THE ONE CEILING IS ONE VALUE FOR THE PROCESS. Its persistence stays the store-setting seam
// `loop/ceiling.ts` defines — same key, same sanitising, still never journaled. What changes is WHICH book
// holds it: the app book, because N Story books each holding a copy of a process-wide number is N numbers.
// The value mirrored into a Story book is a convenience for a book opened outside the coordinator; the
// live number is the app book's, read once through `runtime/ceiling.ts`.
import path from 'node:path';
import { dataClone, jsonStringify } from '@presource/core';
import { LOOP_CEILING_SETTING, rememberGlobalMaxConcurrent, storedGlobalMaxConcurrent } from '../loop/ceiling';
import { AGENT_MODELS_SETTING } from '../run/agent-models';
import { BUILT_IN_TEMPLATES } from '../templates';
import { Store, SERVER_DIRECTORY } from '../store';
import type { Template } from '../../shared/types';

/**
 * The setting keys that are HOST configuration and therefore belong to the app book rather than to any one
 * Story book. Both are read through `store.setting` and written through `store.setSetting`, never through
 * `store.commit`, so the journal stays free of them (`store/store.ts:setting`). The ceiling is
 * `loop/ceiling.ts`'s and the roster is `run/agent-models.ts`'s; a third host setting joins this list and
 * `applyTo` mirrors it into every new book with no other change.
 */
export const SERVER_SETTINGS = [AGENT_MODELS_SETTING, LOOP_CEILING_SETTING] as const;

/**
 * Two host settings compared by value. The values are small JSON maps (a roster of model names, a number),
 * and a book only ever receives them as `dataClone`s of the app's value, so key order is stable and a
 * serialised comparison is both exact and cheaper than a structural walk.
 */
const isEqualSetting = (left: unknown, right: unknown): boolean => jsonStringify(left) === jsonStringify(right);

/** A catalogue row as the store keeps it: `Template` plus the store's identity fields. */
export type AppTemplateRow = Template & { id: string; rev: number; created_at?: string; updated_at?: string };

/**
 * The app book: a `Store` over `<root>/server/`, or over memory (`Store.empty()`) for tests and for a
 * server with no data directory, which still needs the built-in catalogue to create a Story at all.
 */
export class ServerConfig {
    private constructor(
        private readonly store: Store,
        /** The app book's directory, or `null` when the book is in memory. */
        private readonly dir: string | null
    ) {}

    /** The app book beside a Story registry: `<root>/server/` (P1's app-config-only directory). */
    static open = async (base: string): Promise<ServerConfig> => {
        const dir = path.join(path.resolve(base), SERVER_DIRECTORY);

        return new ServerConfig(await Store.load(dir), dir);
    };

    /** An in-memory app book: a server with no data directory still has the built-in crews. */
    static inMemory = (): ServerConfig => new ServerConfig(Store.empty(), null);

    /** Wraps a book the caller already opened — a test that wants its own rows in the catalogue. */
    static over = (store: Store, dir: string | null = null): ServerConfig => new ServerConfig(store, dir);

    /** The book itself: `/templates` create/update/delete writes here, not into a Story. */
    get book(): Store {
        return this.store;
    }

    /** `<root>/server/`, or `null` for an in-memory book. */
    directory = (): string | null => this.dir;

    // -----------------------------------------------------------------------
    // The crew catalogue
    // -----------------------------------------------------------------------

    /** Every crew the app knows: the built-ins plus whatever the Author forked or wrote. */
    templates = (): AppTemplateRow[] => this.store.templates.list() as unknown as AppTemplateRow[];

    /**
     * Seeds the built-in catalogue into the app book, idempotently BY NAME — the same rule
     * `loop/engine.ts:createStory` applies to its own store, so a book that already carries a crew (a
     * restart, an embed that seeded it first, a fork the Author renamed over the built-in) is left alone
     * rather than duplicated.
     *
     * The rows are created WITHOUT `builtin: true` only when the built-in says so; everything else is
     * copied through, so a crew card here reads exactly as the engine would have seeded it.
     */
    seedCatalogue = (): void => {
        const names = new Set(this.templates().map((row) => row.name));

        for (const template of BUILT_IN_TEMPLATES) {
            if (names.has(template.name)) continue;

            // The clone carries the built-in's own fields; `Collection.create` mints the row id itself, and
            // `RecordInit<Template>` is `Template` without the managed columns, so the clone is assignable
            // as-is (the managed columns it does carry are simply ignored).
            this.store.templates.create(dataClone(template), {
                run_ref: null,
                author: true,
                why: 'the built-in crews are app configuration, so every Story starts able to assign them (D-17, D-1)'
            });
        }
    };

    /** A crew is addressed by `name` as well as by id (`run/harness.ts:findTemplate` resolves both). */
    hasTemplateNamed = (name: string): boolean => this.templates().some((row) => row.name === name);

    // -----------------------------------------------------------------------
    // The host settings
    // -----------------------------------------------------------------------

    /** The fan-out ceiling the Author last chose, sanitised (`loop/ceiling.ts:storedGlobalMaxConcurrent`). */
    getGlobalMaxConcurrent = (): number | undefined => storedGlobalMaxConcurrent(this.store);

    /** Remembers the Author's ceiling choice, in the app book (`loop/ceiling.ts:rememberGlobalMaxConcurrent`). */
    setGlobalMaxConcurrent = (limit: number): void => rememberGlobalMaxConcurrent(this.store, limit);

    /**
     * The global employee roster as the app chose it (`run/agent-models.ts:agentModelChoices` reads a
     * Story book the same way; here it is read from the book that owns host settings).
     */
    getAgentModels = (): Record<string, string> =>
        this.store.setting<Record<string, string>>(AGENT_MODELS_SETTING) ?? {};

    /**
     * Writes one roster choice in the app book (`run/agent-models.ts:setAgentModel`'s shape, applied to the
     * app book rather than to a Story). `null` clears the choice, which puts the crew card back in charge.
     */
    setAgentModel = (kind: string, model: string | null): void => {
        const choices = { ...this.getAgentModels() };

        if (model === null) delete choices[kind];
        else choices[kind] = model;

        this.store.setSetting(AGENT_MODELS_SETTING, choices);
    };

    /** A host setting the app holds, whatever the key (`SERVER_SETTINGS`). */
    getSetting = <T,>(key: string): T | undefined => this.store.setting<T>(key);

    /** Writes a host setting. The coordinator mirrors it into every open book (`syncSettings`). */
    setSetting = (key: string, value: unknown): void => this.store.setSetting(key, value);

    // -----------------------------------------------------------------------
    // Materialising the configuration into a Story book
    // -----------------------------------------------------------------------

    /**
     * Copies the app configuration into one Story book: non-journaled and idempotent, and ADDITIVE for crews
     * but REPLACING for host settings.
     *
     * CREWS: every app row whose `name` is not already in the Story book is added under the APP ROW'S id. A
     * row with the APP'S id that sits behind the app's rev is a copy that has not caught up — the Author
     * edited the crew after this book was made — so the copy is refreshed; that is what keeps a Story's brief
     * reading the crew card the Author last tuned. A row with the app's id at the app's rev is current, and a
     * row with a DIFFERENT id (or a name the app does not have) is the Story's own fork: forks stay, because
     * the catalogue is what a Story starts a crew with, not a force-sync that overwrites what it changed.
     *
     * SETTINGS: the app's value always wins. `AGENT_MODELS_SETTING` and `LOOP_CEILING_SETTING` are host-wide
     * by definition (U-8's one roster, S-5's one ceiling), and a per-book copy that outranked the app would
     * be a second source of the same number — which is the bug the shared ceiling exists to close.
     */
    applyTo = (store: Store): void => {
        // `_state()` returns a copy of the collection's map and `_restore()` swaps it back in, which is how
        // the loader hydrates: no event, no journal line, no Digest staleness (see this file's header).
        const state = store.templates._state();
        const names = new Set<string>();

        for (const row of state.records.values()) names.add((row as unknown as AppTemplateRow).name);

        let changed = false;

        for (const row of this.templates()) {
            const copy = state.records.get(row.id) as unknown as AppTemplateRow | undefined;

            if (copy !== undefined) {
                // A stale copy of THIS app row takes the app's edit; anything else in the book is the Story's.
                if (copy.rev >= row.rev) continue;

                state.records.set(row.id, this.copyFields(row) as never);
                changed = true;

                continue;
            }

            if (names.has(row.name)) continue;

            state.records.set(row.id, this.copyFields(row) as never);
            changed = true;
        }

        if (changed) store.templates._restore(state);

        for (const key of SERVER_SETTINGS) {
            const value = this.store.setting<unknown>(key);

            if (value === undefined || isEqualSetting(store.setting<unknown>(key), value)) continue;

            store.setSetting(key, dataClone(value));
            changed = true;
        }

        // The snapshot write is what makes the copy durable. `persist()` is the explicit flush (the
        // debounced timer would also get there), and one per book at boot is the whole cost.
        if (changed) void store.persist().catch(() => undefined);
    };

    /**
     * True when a Story book still carries the app configuration as it is NOW: every crew name the catalogue
     * has (or the app's own row, at the app's rev), and every host setting at the app's value.
     *
     * Both halves matter for `StoryRuntimes.syncConfig`, which skips a book this says is current: a check on
     * names alone would let a crew the Author renamed-in-place, or a ceiling the Author moved, sit stale in
     * every open book until the next restart.
     */
    matches = (store: Store): boolean => {
        // A single book IS the configuration; there is nothing to be out of date about (the shape a host that
        // owns one Story uses, and what `StoryRuntimes.adopt` leaves in place).
        if (this.store === store) return true;

        const rows = store.templates.list() as unknown as AppTemplateRow[];
        const byId = new Map<string, AppTemplateRow>();
        const names = new Set<string>();

        for (const row of rows) {
            byId.set(row.id, row);
            names.add(row.name);
        }

        for (const row of this.templates()) {
            const copy = byId.get(row.id);

            // A crew the book holds under a different id is that Story's own fork, and a fork's name counts
            // as coverage: that is exactly what `applyTo` reconciles, and an extra name is not a mismatch.
            if (copy === undefined ? !names.has(row.name) : copy.rev < row.rev) return false;
        }

        for (const key of SERVER_SETTINGS) {
            const host = this.store.setting<unknown>(key);

            if (host === undefined || isEqualSetting(store.setting<unknown>(key), host)) continue;

            return false;
        }

        return true;
    };

    /** Flushes the app book, so a config route can answer 200 only once the file is on disk. */
    persist = async (): Promise<void> => {
        await this.store.persist();
    };

    /** Flushes and releases the app book's debounced persist timer. */
    close = async (): Promise<void> => {
        await this.store.close();
    };

    /**
     * An app row as a Story book stores it: the id verbatim (`assignTemplates` reports the ids the Author
     * sees in the app catalogue, and a re-copy stays idempotent), the rev kept so a book's row does not
     * claim to be newer than the catalogue's, and everything else deep-cloned so the two books never share
     * a mutable role list. `created_at`/`updated_at` are dropped: they are this book's clock, not a copy's.
     */
    private copyFields = (row: AppTemplateRow): Record<string, unknown> => {
        const { rev: _rev, created_at: _created, updated_at: _updated, ...rest } = row;

        return { ...dataClone(rest), id: row.id, rev: row.rev };
    };
}
