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
    LEDGER_KINDS,
    LEDGER_STATUSES,
    PENDING_KINDS,
    PROPOSAL_STATES,
    REVISION_STATES,
    ROLE_AGGREGATIONS,
    ROLE_KINDS,
    RUN_STATES,
    SECTION_ORIGINS,
    STORY_PHASES,
    STORY_STATUSES,
    TASK_STATES,
    TRENDS,
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

    it('the cost scale is ordered and its default dial is critical + major (D-35)', () => {
        expect(FINDING_COSTS).toEqual(['critical', 'major', 'minor', 'taste']);
        expect(DEFAULT_AUTO_APPROVE_COSTS).toEqual(['critical', 'major']);
    });

    it('the crew kinds and their aggregation modes are §4.12/D-38', () => {
        expect(ROLE_KINDS).toEqual(['writer', 'editor', 'reader', 'checker']);
        expect(ROLE_AGGREGATIONS).toEqual(['majority', 'merge', 'lead']);
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
        expect(REVISION_STATES).toEqual(['competing', 'selected', 'merged_into', 'discarded']);
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
    it('lists the 17 collections in §4 order', () => {
        expect(COLLECTION_NAMES).toHaveLength(17);
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
            'proposals'
        ]);
    });

    it('gives every collection an id singular (W1 mints `${singular}_${n}`)', () => {
        const names = Object.keys(COLLECTION_SINGULARS) as CollectionName[];

        expect(names.sort()).toEqual([...COLLECTION_NAMES].sort());

        for (const name of names) expect(COLLECTION_SINGULARS[name]).toMatch(/^[a-z]+(_[a-z]+)*$/);

        // No singular may be a strict id-prefix of another collection's ids: the store resolves
        // a bare id to its collection by prefix (T-4's cross-collection `expects`), and an
        // ambiguous prefix would silently check the wrong record's rev.
        for (const left of names) {
            for (const right of names) {
                if (left === right) continue;

                expect(`${COLLECTION_SINGULARS[right]}_1`.startsWith(`${COLLECTION_SINGULARS[left]}_`)).toBe(false);
            }
        }

        // The two names that are not plain de-pluralisations (a cast row is a character, a
        // ledger row is an entry) — pinned because the store's ids are user-visible in refs.
        expect(COLLECTION_SINGULARS.cast).toBe('cast_member');
        expect(COLLECTION_SINGULARS.ledger).toBe('ledger_entry');
    });
});
