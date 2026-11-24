// §4 acceptance — the enum value sets and the collection registry.
//
// These are cheap assertions that protect the wire format: a §4 enum value is stored as a
// plain string in `store.json` and matched by the loop's switches, so a renamed value is a
// silent data migration (P15 wants a phase model or role set replaceable WITHOUT rewriting the
// store, and the first step of that is the value set being explicit and tested).
import {
    CHAPTER_STATES,
    COLLECTION_NAMES,
    COLLECTION_SINGULARS,
    DEFAULT_AUTO_APPROVE_COSTS,
    DIRECTIVE_STATES,
    FINDING_COSTS,
    FINDING_STATES,
    IDEA_KINDS,
    IDEA_STATES,
    IDEA_VERDICTS,
    KNOWLEDGE_IMPORTANCE,
    KNOWLEDGE_KINDS,
    LEDGER_KINDS,
    LEDGER_STATUSES,
    PENDING_KINDS,
    PROPOSAL_STATES,
    REVISION_STATES,
    ROLE_AGGREGATIONS,
    ROLE_KINDS,
    RUN_STATES,
    SECTION_ORIGINS,
    SEED_BRIEF_STATES,
    STORY_PHASES,
    STORY_STATUSES,
    TASK_STATES,
    TRENDS,
    UID_ADDRESSED_COLLECTIONS,
    UNIT_KINDS,
    VERDICT_RECOMMENDATIONS,
    type CollectionName
} from './types';

describe('§4 enums', () => {
    it('the phase, status and pending_kind sets are exactly §4.1', () => {
        // `completed` is a STATUS and never a phase (§4.1: "There is no other value").
        expect(STORY_PHASES).toEqual(['summary', 'plotlines', 'chapters']);
        expect(STORY_STATUSES).toEqual(['ready', 'pending', 'completed', 'stopped']);
        expect(PENDING_KINDS).toEqual([
            'phase_signoff',
            'idea_selection',
            'finding_approval',
            'drained',
            'stalled',
            'none'
        ]);
        expect(TRENDS).toEqual(['improving', 'flat', 'regressing', 'unknown']);
    });

    // D-35's shipped default now includes `minor`: a fresh Story auto-approves the top three costs
    // and leaves only `taste` on the Author's desk.
    it('the cost scale is ordered and its default dial is critical + major + minor (D-35)', () => {
        expect(FINDING_COSTS).toEqual(['critical', 'major', 'minor', 'taste']);
        expect(DEFAULT_AUTO_APPROVE_COSTS).toEqual(['critical', 'major', 'minor']);
    });

    it('the crew kinds and their aggregation modes are §4.12/D-38', () => {
        // `researcher` is appended (research pipeline §3.1): the original four keep their §4 order,
        // so the permission matrix and the roster read the same prefix they always did.
        expect(ROLE_KINDS).toEqual(['writer', 'editor', 'reader', 'checker', 'researcher']);
        expect(ROLE_AGGREGATIONS).toEqual(['majority', 'merge', 'lead']);
    });

    it('the research pipeline enums are ordered as the compiler and the selector read them (§3.2, §3.3)', () => {
        // Importance is a RANK, not a set: the prompt filter and the dashboard badge both take a
        // prefix comparison against it, so `critical` must sort first and `low` last.
        expect(KNOWLEDGE_IMPORTANCE).toEqual(['critical', 'high', 'normal', 'low']);
        expect(KNOWLEDGE_KINDS).toEqual(['fact', 'world_rule', 'tech', 'period', 'place', 'person', 'other']);
        // A brief is `draft` until accepted; the sampling gate refuses anything but `accepted`.
        expect(SEED_BRIEF_STATES).toEqual(['draft', 'accepted']);
    });

    it('the state machines are exactly §4.4, §4.7, §4.10, §4.13, §4.14, §4.15, §4.16, §4.17', () => {
        expect(FINDING_STATES).toEqual(['unconfirmed', 'confirmed', 'approved', 'fixed', 'disputed', 'discarded']);
        expect(IDEA_STATES).toEqual([
            'proposed',
            'verified',
            'refuted',
            'unverifiable',
            'selected',
            'discarded',
            'deferred'
        ]);
        expect(CHAPTER_STATES).toEqual([
            'outlined',
            'drafting',
            'in_pass',
            'in_review',
            'needs_author',
            'done',
            'needs_recheck'
        ]);
        expect(TASK_STATES).toEqual(['open', 'claimed', 'blocked', 'done', 'wontfix']);
        expect(RUN_STATES).toEqual(['spawning', 'working', 'reporting', 'torn_down', 'failed', 'abandoned']);
        expect(DIRECTIVE_STATES).toEqual(['queued', 'propagating', 'done', 'rejected']);
        expect(REVISION_STATES).toEqual(['pending', 'drafted', 'competing', 'selected', 'merged_into', 'discarded']);
        expect(PROPOSAL_STATES).toEqual(['pending', 'accepted', 'rejected']);
    });

    it('the vocabulary a rule branches on: units, ledger, ideas, verdicts, sections (D-29, D-15, T-2)', () => {
        expect(UNIT_KINDS).toEqual(['summary', 'plotline', 'chapter']); // §14 item 1d: the divergence unit
        expect(LEDGER_KINDS).toEqual(['setup', 'payoff', 'fact', 'timeline', 'world_rule']);
        expect(LEDGER_STATUSES).toEqual(['open', 'paid', 'conflict', 'stale']);
        expect(IDEA_KINDS).toEqual(['direction', 'possibility', 'fact', 'warning']);
        expect(IDEA_VERDICTS).toEqual(['verified', 'refuted', 'unverifiable']);
        expect(VERDICT_RECOMMENDATIONS).toEqual(['advance', 'fix', 'stuck']);
        expect(SECTION_ORIGINS).toEqual(['writer', 'author']); // 'author' is the P9 propose-only marker
    });
});

describe('§4 collection registry', () => {
    it('lists the 23 collections in registry order', () => {
        // F2 — 20 §4 names, 3 the phase-① pipeline appended, and the 3 SUMMARY PHRASE records R1 adds.
        // Appending (never inserting) is the load-bearing half: every snapshot reader walks THIS list,
        // so an old `store.json` still loads and simply has no rows in the new collections.
        expect(COLLECTION_NAMES).toHaveLength(23);
        expect(COLLECTION_NAMES).toEqual([
            'stories',
            'summaries',
            'plotlines',
            'chapters',
            'cast',
            'ledger',
            'tasks',
            'digests',
            'verdicts',
            'findings',
            'goals',
            'templates',
            'runs',
            'directives',
            'revisions',
            'ideas',
            'proposals',
            // The Phase-1 research pipeline's three collections are APPENDED (§3.2-§3.4): the
            // first seventeen are pinned §4 names, and old snapshots were written in that order.
            'knowledge',
            'seed_briefs',
            'sample_reviews',
            // SUMMARY PHRASE (R1/R2), appended the same way. The ORDER of these three is not free:
            // `phrase_groups` follows `phrases` so `_resolveId` reports the most specific family (the
            // rule pinned in the next test).
            'phrases',
            'phrase_groups',
            'group_revisions'
        ]);
    });

    it('gives every collection an id singular (W1 mints `${singular}_${n}`)', () => {
        const names = Object.keys(COLLECTION_SINGULARS) as CollectionName[];

        expect(names.sort()).toEqual([...COLLECTION_NAMES].sort());

        for (const name of names) expect(COLLECTION_SINGULARS[name]).toMatch(/^[a-z]+(_[a-z]+)*$/);

        // F2 — the prefix rule, at the level the store actually depends on. `store.ts:_resolveId`
        // recognises a record's family by id PREFIX, so two collections whose MINTED ids nest
        // (`task_1` inside `task_group_1`) would make a cross-collection `expects` (T-4) compare the
        // wrong record's rev. That is a rule about COUNTER families, and the registry now contains two
        // families outside the counter by contract: `UID_ADDRESSED_COLLECTIONS` — `phrases` and
        // `phrase_groups`, whose rows carry a UUID minted by `persist.ts:newRecordUid` and preserved by
        // `store.ts:createWithId` (R1: a group id is an ADDRESS a route, a finding and a Run row all
        // quote). Neither ever mints `phrase_3`, so the two families cannot claim one id shape.
        const uidAddressed = UID_ADDRESSED_COLLECTIONS as readonly string[];
        const counterMinted = names.filter((name) => !uidAddressed.includes(name));

        for (const left of counterMinted) {
            for (const right of counterMinted) {
                if (left === right) continue;

                expect(`${COLLECTION_SINGULARS[right]}_1`.startsWith(`${COLLECTION_SINGULARS[left]}_`)).toBe(false);
            }
        }

        // The exemption is STATED rather than assumed: the only nested pair in the registry is the
        // phrase pair R1 added, so a third collection whose singular starts with `phrase_` cannot join
        // it without this assertion growing — and the ordering rule below then has to cover it too.
        const nested: Array<[CollectionName, CollectionName]> = names.flatMap((left) =>
            names
                .filter(
                    (right) =>
                        left !== right &&
                        `${COLLECTION_SINGULARS[right]}_1`.startsWith(`${COLLECTION_SINGULARS[left]}_`)
                )
                .map((right) => [left, right] as [CollectionName, CollectionName])
        );

        expect(nested).toEqual([['phrases', 'phrase_groups']]);

        // And when a family IS nested, `_resolveId`'s answer stays correct by construction: with no
        // record under either family it reports the LAST prefix match it walked — the most specific
        // family — and it walks COLLECTION_NAMES in order. So the longer singular must sit LATER in
        // the registry. Pinned here because the store's correctness depends on this order; the
        // behaviour itself is pinned in `src/server/store/record-identity.test.ts`.
        const registryOrder = (name: CollectionName) => COLLECTION_NAMES.indexOf(name);

        for (const [left, right] of nested) {
            expect(COLLECTION_SINGULARS[right].startsWith(`${COLLECTION_SINGULARS[left]}_`)).toBe(true);
            expect(registryOrder(right) > registryOrder(left)).toBe(true);
        }

        // The contract itself, pinned so the exemption above cannot quietly widen: exactly these two,
        // with these singulars, and `group_revisions` deliberately NOT among them (an Author reading a
        // group's history wants `group_revision_3`, not a UUID — `shared/types.ts` says why).
        expect(UID_ADDRESSED_COLLECTIONS).toEqual(['phrases', 'phrase_groups']);
        expect(COLLECTION_SINGULARS.phrases).toBe('phrase');
        expect(COLLECTION_SINGULARS.phrase_groups).toBe('phrase_group');
        expect(uidAddressed.includes('group_revisions')).toBe(false);
        expect(COLLECTION_SINGULARS.group_revisions).toBe('group_revision');

        // The names that are not plain de-pluralisations (a cast row is a character, a ledger row
        // is an entry, a knowledge row is an entry) — pinned because the store's ids are
        // user-visible in refs.
        expect(COLLECTION_SINGULARS.cast).toBe('cast_member');
        expect(COLLECTION_SINGULARS.ledger).toBe('ledger_entry');
        expect(COLLECTION_SINGULARS.knowledge).toBe('knowledge_entry');

        // The two research collections whose singular is a straight de-pluralisation, pinned so a
        // rename cannot slip past the generic loop above.
        expect(COLLECTION_SINGULARS.seed_briefs).toBe('seed_brief');
        expect(COLLECTION_SINGULARS.sample_reviews).toBe('sample_review');
    });
});
