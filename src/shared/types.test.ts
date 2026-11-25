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
    FINDING_KINDS,
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

    // D-33b: the claim type. `issue` is FIRST because it is the default in both directions — the reading
    // of a row raised before the field existed, and of a `raiseFinding` call that names no `kind` — and
    // that default is what keeps D-16's fingerprint byte-compatible for every open finding.
    //
    // The two words are `issue` and `proposal` (the Author's own vocabulary: Issues are the things that
    // break the story's logic, Proposals are the things that make it better). The kinds are NOT
    // unconstrained against `FINDING_COSTS` — `tools/reader.ts:raiseFinding` refuses `proposal` at
    // `critical` and `issue` at `taste`, and both refusals are pinned in `tools/runtime.test.ts` — but
    // the SCALE itself stays four values, because persisted rows, `costDistribution` and the D-35b dial
    // all key on it (the test above).
    it('a finding names which kind of claim it is, and issue is the default (D-33b)', () => {
        expect(FINDING_KINDS).toEqual(['issue', 'proposal']);
    });

    it('the crew kinds and their aggregation modes are §4.12/D-38', () => {
        // `researcher` is appended (research pipeline §3.1): the original four keep their §4 order,
        // so the permission matrix and the roster read the same prefix they always did.
        expect(ROLE_KINDS).toEqual(['writer', 'editor', 'critic', 'reader', 'researcher']);
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
    it('lists the 25 collections in registry order', () => {
        // F2 — 20 §4 names, 3 the phase-① pipeline appended, the 3 SUMMARY PHRASE records R1 adds, the
        // Reader's score rows D-65 appends, and Phrase ②'s structure pass appends last.
        // Appending (never inserting) is the load-bearing half: every snapshot reader walks THIS list,
        // so an old `store.json` still loads and simply has no rows in the new collections.
        expect(COLLECTION_NAMES).toHaveLength(25);
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
            'group_revisions',
            // READER SCORING (D-65), appended last for the same reason: a score row is a read surface,
            // and no existing collection may shift position in the registry.
            'summary_scores',
            // PHRASE ② PLOTLINES — the Editor's structure pass over the phrase's COPIED seed. Appended
            // last again, and it sits AFTER `plotlines` on purpose: its singular (`plotline_brief`) nests
            // inside the `plotline` id family, and the store resolves a nested family by the LAST prefix
            // match it walks (the pair, and the ordering rule, are pinned below).
            'plotline_briefs'
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
        //
        // NESTED PAIRS ARE DECLARED, not inferred, because two rules below read the SAME list: the
        // counter-family rule (a nested pair is allowed only when it is declared) and the registry-order
        // rule (the store resolves a prefix by the LAST match it walks, so a nested family must be
        // registered after the family it nests in). Two pairs today: the phrase pair R1 added, and Phrase
        // ②'s `plotline_brief` inside the `plotline` family — which is why `plotline_briefs` is appended
        // after `plotlines` in `COLLECTION_NAMES`, not inserted beside it.
        const nested: Array<[CollectionName, CollectionName]> = [
            ['phrases', 'phrase_groups'],
            ['plotlines', 'plotline_briefs']
        ];
        const isDeclaredNested = (left: CollectionName, right: CollectionName) =>
            nested.some(([pairLeft, pairRight]) => pairLeft === left && pairRight === right);
        const uidAddressed = UID_ADDRESSED_COLLECTIONS as readonly string[];
        const counterMinted = names.filter((name) => !uidAddressed.includes(name));

        for (const left of counterMinted) {
            for (const right of counterMinted) {
                if (left === right) continue;
                if (isDeclaredNested(left, right)) continue;

                expect(`${COLLECTION_SINGULARS[right]}_1`.startsWith(`${COLLECTION_SINGULARS[left]}_`)).toBe(false);
            }
        }

        // The declaration above is STATED rather than assumed: this recomputes the nesting from the
        // registry and requires it to be exactly the declared pairs, so a third collection whose singular
        // starts with `phrase_` or `plotline_` cannot join without growing the declaration — and the
        // ordering rule below then has to cover it too.
        const computedNested: Array<[CollectionName, CollectionName]> = names.flatMap((left) =>
            names
                .filter(
                    (right) =>
                        left !== right &&
                        `${COLLECTION_SINGULARS[right]}_1`.startsWith(`${COLLECTION_SINGULARS[left]}_`)
                )
                .map((right) => [left, right] as [CollectionName, CollectionName])
        );

        expect(computedNested).toEqual(nested);

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
