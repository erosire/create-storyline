// W6 — the Digest: §4.8's standing view, DERIVED by the engine and never authored.
//
// WHY THIS MODULE IS A LIBRARY AND NOT A SERVICE (D-12a): "the Digest is derived, not authored —
// the loop engine rebuilds it deterministically from the committed change history, never a crew,
// never the Writer". The reason is stated in the spec and is the whole point of W6: the Digest is
// the one artifact every fresh run trusts without checking, so the agent that wrote chapter 9 must
// not be the one that summarised it. Everything below is therefore a pure function of (records,
// journal), reached only from the engine/loop side: no agent calls it, and no agent may write the
// collection at all (`updateDigest` is refused for every role — §7's `digests` row is read-only for
// Writer, Editor, checker and Reader alike). The loop (W4/W5) calls `rebuild` on its commit and
// consults `isStale` before dispatching a review (D-14).
//
// DETERMINISM IS AN ACCEPTANCE PROPERTY, NOT A nicety: the same committed state must produce the
// same body, because D-12a's promise is that "any past Digest is reconstructible — the Author can
// see what a reviewer was actually told when it judged chapter 20". So nothing here reads `Date`,
// `Math.random`, or insertion order that is not pinned by a field; every list is sorted by a stored
// key, and the change notes come from the journal's `seq`.
//
// BUDGET (T-7, E-2): the body is bounded. A Digest every run reads has to stay cheaper than the
// book, or the product has simply moved the reading around. When it overflows, the OLDEST change
// notes go first — recap, contracts, open threads and cast state are what a reviewer cannot judge
// without; "what changed recently" is the least load-bearing section.
import { type Chapter, type Cost, type Digest, type FindingState, type Plotline, type Story } from '../../shared/types';
// Type-only: the derivation must be reachable from the loop side without dragging the store's
// runtime (or the model client) into it, and it never writes through anything but the accessors.
import type { Attribution, CommitEvent, Store } from '../store';
import { normalizeKey, clampLine } from '../criteria/engine';

// ---------------------------------------------------------------------------
// The knobs, stated as constants so a change is visible (and testable) in one place
// ---------------------------------------------------------------------------

/** Total ceiling for one Digest body (T-7's spirit: the brief must stay cheaper than the book). */
export const DIGEST_CHAR_BUDGET = 6000;

/** §4.2's prose fields are recapped, not reproduced: a bible section a run can hold in its head. */
const RECAP_FIELD_LIMIT = 300;

/** §4.8 says "per-chapter one-line summary" — one line, not a synopsis. */
const CHAPTER_LINE_LIMIT = 160;

/** D-12a's "last change notes": enough for a run to see the direction of travel, not a changelog. */
const CHANGE_NOTE_LIMIT = 12;

/** D-13's criterion id: the ONLY move a crew has against the Digest (W6 acceptance). */
export const DIGEST_GAP_CRITERION = 'digest_gap';

/**
 * §4.10's definition of an OPEN finding ("any of `unconfirmed`, `confirmed`, `approved` that is not
 * yet `fixed`") — open threads count these, and `digest_gap` is only live while one is open.
 */
const OPEN_FINDING_STATES: FindingState[] = ['unconfirmed', 'confirmed', 'approved'];

/** §4.10's cost order — the count line reads in triage order, not alphabetically. */
const COST_ORDER: Cost[] = ['critical', 'major', 'minor', 'taste'];

/**
 * The engine's attribution shape. D-12a says the Digest "carries no `why` because no one chose it",
 * while T-5/D-8/P11 make a `why` mandatory on every write — the reconciliation is one fixed,
 * mechanical string: the reason is always "the engine re-derived it", never a decision, so the
 * audit line cannot mislead anyone into thinking a crew chose this wording.
 */
function engineAttribution(why: string): Attribution {
    return { run_ref: null, why: `engine-derived: ${why}` };
}

// ---------------------------------------------------------------------------
// Scoped, sorted reads (T-3: one Story per read; L-8: chapters are ordered, not sequenced)
// ---------------------------------------------------------------------------

function storyOf(store: Store, storyId: string): Story {
    return store.stories.require(storyId);
}

function storyPlotlines(store: Store, storyId: string): Plotline[] {
    return store.plotlines
        .list()
        .filter((plotline) => plotline.story_id === storyId)
        .sort((left, right) =>
            left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order
        );
}

function storyChapters(store: Store, storyId: string): Chapter[] {
    return store.chapters
        .list()
        .filter((chapter) => chapter.story_id === storyId)
        .sort((left, right) =>
            left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order
        );
}

/**
 * Does one journaled event belong to this Story?
 *
 * The record is still live: ask it (§4 collections all carry `story_id`; `stories` is keyed by the
 * Story id itself). The record has been deleted (a D-22 selection, a D-25 backtrack, a D-36 tray
 * clear — all of which change story state and MUST make the Digest stale): the event's `patch`
 * carries the deleted record, so ask that.
 *
 * Anything still unattributable counts as story state. The cost model decides it, and it is
 * asymmetric (D-14): a Digest wrongly called stale costs one rebuild and a re-dispatch; a Digest
 * wrongly called fresh costs a crew judging the book on a stale bible.
 */
function eventTouchesStory(store: Store, storyId: string, event: CommitEvent): boolean {
    if (event.collection === 'stories') return event.id === storyId;

    const resolved = store._resolveId(event.id);

    if (resolved?.record) return (resolved.record as { story_id?: string }).story_id === storyId;

    const patch = event.patch as { story_id?: string } | undefined;

    if (patch && typeof patch.story_id === 'string') return patch.story_id === storyId;

    return resolved !== undefined;
}

/**
 * True for the one write that is the Digest's own bookkeeping rather than story state: the
 * `stories.digest_rev` bump the rebuild makes. §4.1 defines that field as "revision of the current
 * Digest", so moving it cannot move the book — and without this exclusion every rebuild would
 * re-arm D-14's staleness with its own write, blocking the very review it was derived for.
 *
 * The test is exact (the patch carries that key and nothing else) so a genuine story edit that also
 * touches `digest_rev` still counts.
 */
function isDigestBookkeeping(event: CommitEvent): boolean {
    if (event.collection !== 'stories' || event.op !== 'update') return false;

    const patch = event.patch as Record<string, unknown> | undefined;

    if (!patch || typeof patch !== 'object') return false;

    const keys = Object.keys(patch);

    return keys.length === 1 && keys[0] === 'digest_rev';
}

/** Every event that changed this Story's state, oldest first, excluding the Digest's own writes. */
function storyEvents(store: Store, storyId: string): CommitEvent[] {
    // D-12a: the Digest is derived FROM story state, so writing it back is not story state — counting
    // its own create/update would make every rebuild instantly stale (D-14 would fire forever).
    return store.journal.filter(
        (event) =>
            event.collection !== 'digests' && !isDigestBookkeeping(event) && eventTouchesStory(store, storyId, event)
    );
}

// ---------------------------------------------------------------------------
// DigestBuilder
// ---------------------------------------------------------------------------

/**
 * Derives §4.8's Digest and answers D-14's staleness question. Stateless: the store handed to each
 * method is the whole input, which is what makes the derivation reproducible for any past commit
 * (D-12a) and what lets the loop call it from anywhere (commit hook, resume path, D-37a re-derive).
 */
export class DigestBuilder {
    // -- D-13: the crew's only move against the Digest ------------------------------------------

    /**
     * True while an OPEN `digest_gap` finding exists (D-13: "if the Digest is insufficient for a
     * judgment, the run files a `digest_gap` finding and the loop repairs the Digest").
     *
     * The repair this build performs is detail, not magic: the expanded body carries each chapter's
     * own synopsis plus the events and the change its plotline contracts for, which is exactly the
     * reading a run that had to open the book was missing. Closing the finding stays the loop's job
     * (W4e/W7) — the Digest does not adjudicate its own findings.
     */
    isExpanded(store: Store, storyId: string): boolean {
        return store.findings
            .list()
            .some(
                (finding) =>
                    finding.story_id === storyId &&
                    finding.criterion_ref === DIGEST_GAP_CRITERION &&
                    OPEN_FINDING_STATES.includes(finding.state)
            );
    }

    // -- the current row and its history --------------------------------------------------------

    /**
     * The row a fresh run would be briefed with (§4.8: "one current record per Story, plus history").
     *
     * `current === true` is the marker. If nothing is flagged — a store hand-edited, or a crash
     * between the archive write and the create — the newest row is taken by `rev`, which is exactly
     * the fallback W6 needs to stay readable rather than throw during a sweep.
     */
    currentDigest(store: Store, storyId: string): Digest | undefined {
        const rows = store.digests.list().filter((digest) => digest.story_id === storyId);
        const flagged = rows.filter((digest) => digest.current === true);

        if (flagged.length > 0) return flagged.reduce((newest, row) => (row.rev > newest.rev ? row : newest));

        return rows.reduce<Digest | undefined>(
            (newest, row) => (newest === undefined || row.rev > newest.rev ? row : newest),
            undefined
        );
    }

    // -- D-14: staleness ------------------------------------------------------------------------

    /**
     * True when the Story has changed since the current Digest was derived.
     *
     * The anchor is the digest row's `journal_seq` — the commit it read through — because that is
     * the only comparison that is exact: timestamps collide inside one sweep (a pass commits dozens
     * of times) and a missed millisecond would silently let a crew judge the book on a stale bible,
     * which is the one failure D-14 exists to prevent.
     *
     * A Story with no Digest is stale by definition: D-14's rule is "refresh, then re-dispatch", so
     * "nothing derived yet" must not read as "nothing to do".
     */
    isStale(store: Store, story: Story): boolean {
        const current = this.currentDigest(store, story.id);

        if (!current) return true;

        // Captured in a local so the `typeof` narrow survives into the closure below.
        const anchor = current.journal_seq;

        if (typeof anchor !== 'number') return true;

        return storyEvents(store, story.id).some((event) => event.seq > anchor);
    }

    // -- D-12a: the rebuild ---------------------------------------------------------------------

    /**
     * Re-derives the Digest: writes the new current row, archives the previous one, and advances
     * `stories.digest_rev` (which is §4.8's `rev` — §4.1 names that field "revision of the current
     * Digest", and the store owns a record's own `rev` as the T-4 CAS token, so the derived revision
     * lives there rather than on the row).
     *
     * THREE WRITES, ONE DECISION: wrap the call in `store.commit('rebuild_digest', …)` when the
     * loop needs the archive, the create and the `digest_rev` bump to land as one journal group —
     * the store buffers every write made inside an open commit and rolls all of them back together
     * (D-22's mechanism), which is what keeps a failed rebuild from leaving two current rows.
     * Called outside a commit they still land, as three attributed events.
     *
     * No agent reaches this method: the §7 permission row makes `digests` read-only for every role
     * (the W2 tool layer refuses `updateDigest` outright, D-12a), and the attribution below carries
     * no `run_ref` and no `author` flag precisely so the audit can tell an engine derivation from a
     * run's write (P11).
     */
    rebuild(store: Store, storyId: string): Digest {
        const story = storyOf(store, storyId);
        const revision = story.digest_rev + 1;

        // The anchor is taken BEFORE the writes: the digest's own create event must not count as
        // story state that arrived after it (see `storyEvents`).
        const anchor = storyEvents(store, storyId).reduce((highest, event) => Math.max(highest, event.seq), 0);

        const body = this.buildBody(store, storyId, revision);

        for (const previous of store.digests
            .list()
            .filter((digest) => digest.story_id === storyId && digest.current === true)) {
            store.digests.update(
                previous.id,
                { current: false },
                engineAttribution(`digest rev ${revision} supersedes rev ${previous.id} (D-12a history)`),
                [{ id: previous.id, rev: previous.rev }]
            );
        }

        const digest = store.digests.create(
            { story_id: storyId, body, stale: false, current: true, journal_seq: anchor },
            engineAttribution(`derived digest rev ${revision} from journal through seq ${anchor} (D-12a)`)
        );

        store.stories.update(
            story.id,
            { digest_rev: revision },
            engineAttribution(`digest rev ${revision} derived (D-12a)`),
            [{ id: story.id, rev: story.rev }]
        );

        return digest;
    }

    // -- the body (the pure half: records + journal in, text out) --------------------------------

    /**
     * Composes the body from the store alone: bible recap → per-chapter one-liners → open threads →
     * cast state → last change notes (§4.8's list, in the order a run needs it: what the book is,
     * what has happened, what is still owed, who is where now, what moved last).
     *
     * `revision` is a parameter rather than a read of `story.digest_rev` so the function stays
     * referentially transparent for a given store: the loop passes `digest_rev + 1` for the row it is
     * about to write, and a caller (or a test) can render any past revision of the same state without
     * the store having moved (D-12a's reconstructibility).
     *
     * WHEN THE BOOK IS BIGGER THAN THE BUDGET (T-7, D-13): every line is already clamped, so
     * overflow means there are too MANY lines, and the ladder decides which ones go:
     *
     *   1. the OLDEST change notes, always first — recency is their entire value, the journal still
     *      holds them, and `readVerdicts`/the audit trail are one call away;
     *   2. then, one line at a time, whichever remaining block currently costs the most characters:
     *      the long book sheds the block its own length created, so 40 chapters thin while the cast
     *      and the open threads survive whole, and 40 cast members thin while the spine survives
     *      whole. The chapter block thins from the MIDDLE OUT (the first chapter and the last one are
     *      the shape of the book and where the book now stands); the other blocks thin from the end.
     *
     * That order is not a taste call: W6's acceptance is "a reviewer judges chapter 20 without reading
     * chapters 1–19", so the per-chapter one-liners are the last thing to lose, not the first — while
     * the change notes are the only section the store can hand back on request.
     *
     * Nothing is dropped silently: an elided block carries a line naming how many went, so a run can
     * tell a thin Digest from a thin book — that distinction is exactly what D-13 asks it to judge
     * before it files `digest_gap`. The cut at the ceiling is insurance after every floor is reached;
     * with every line clamped the ladder converges below the ceiling, so it should never be seen.
     */
    buildBody(store: Store, storyId: string, revision: number): string {
        const expanded = this.isExpanded(store, storyId);
        const head = `digest · ${storyId} · rev ${revision}${expanded ? ' · expanded detail (open digest_gap, D-13)' : ''}`;

        // The recap is not thinnable: it is bounded by its own per-field clamp, and D-13's brief is
        // meaningless without it (a run that cannot see what the book is cannot judge a chapter).
        const bible = recapBlock(store, storyId);

        // Derived once each; `keep` starts at the block's full size and is decremented by the ladder.
        const spine = chapterLines(store, storyId, expanded);
        const threads = threadLines(store, storyId);
        const cast = castLines(store, storyId);
        const notes = changeNotes(store, storyId);

        // `priority` is the THIN order, not the reading order: notes go before cast, cast before
        // threads, threads before the chapter spine (the ladder is documented on `buildBody`).
        const blocks: ThinnableBlock[] = [
            {
                header: '## chapters',
                full: spine,
                keep: spine.length,
                strategy: 'ends',
                elides: 'chapter(s)',
                priority: 3
            },
            {
                header: '## open threads',
                full: threads,
                keep: threads.length,
                strategy: 'first',
                elides: 'thread line(s)',
                priority: 2
            },
            {
                header: '## cast',
                full: cast,
                keep: cast.length,
                strategy: 'first',
                elides: 'cast line(s)',
                priority: 1
            },
            {
                header: '## last changes',
                full: notes,
                keep: notes.length,
                strategy: 'newest',
                elides: 'change note(s)',
                priority: 0
            }
        ];

        const compose = (): string => {
            const sections = [head, bible];

            for (const block of blocks) {
                const lines = renderBlock(block);

                if (lines.length > 0) sections.push(`${block.header}\n${lines.join('\n')}`);
            }

            return sections.join('\n\n');
        };

        for (let round = 0; round <= MAX_THIN_ROUNDS; round += 1) {
            const body = compose();

            if (body.length <= DIGEST_CHAR_BUDGET) return body;

            if (!thinOne(blocks)) {
                // Every block is at its floor and the book still does not fit. Cut rather than ship an
                // unbounded brief that charges the difference to every run that follows (T-7).
                return `${body.slice(0, DIGEST_CHAR_BUDGET - 1)}…`;
            }
        }

        return `${compose().slice(0, DIGEST_CHAR_BUDGET - 1)}…`;
    }
}

// ---------------------------------------------------------------------------
// The bounded blocks
// ---------------------------------------------------------------------------

/** How a block gives up lines when the budget is tight (see `buildBody`'s ladder). */
type ThinStrategy =
    /** Keep the first `keep` lines — the block's own order is meaningful (alphabetical, grouped). */
    | 'first'
    /** Keep the LAST `keep` lines — recency is the value (the change notes). */
    | 'newest'
    /** Keep the first k and the last k, eliding the middle — the block describes a sequence. */
    | 'ends';

interface ThinnableBlock {
    header: string;
    /** Every line the block would carry with unlimited room. */
    full: string[];
    /** How many lines the block may still show; decremented one at a time by `thinOne`. */
    keep: number;
    strategy: ThinStrategy;
    /** Wording of the elision line, so the run knows what it is missing. */
    elides: string;
    /** Lower goes first. */
    priority: number;
}

/** The ladder cannot run away: one line per round, and every block has a floor of one line. */
const MAX_THIN_ROUNDS = 400;

/** The elision marker — D-13 depends on it: a run must be able to tell a thin Digest from a thin book. */
function elisionLine(dropped: number, what: string): string {
    return `… ${dropped} ${what} elided to hold the Digest budget (T-7)`;
}

function renderBlock(block: ThinnableBlock): string[] {
    if (block.keep >= block.full.length) return [...block.full];

    if (block.strategy === 'newest') {
        const kept = block.full.slice(-Math.max(1, block.keep));

        return [...kept, elisionLine(block.full.length - kept.length, block.elides)];
    }

    if (block.strategy === 'first') {
        const kept = block.full.slice(0, Math.max(1, block.keep));

        return [...kept, elisionLine(block.full.length - kept.length, block.elides)];
    }

    // 'ends': the sequence survives at both ends and the middle is what goes.
    const k = Math.max(1, Math.floor(block.keep / 2));
    const head = block.full.slice(0, k);
    const tail = k * 2 >= block.full.length ? [] : block.full.slice(-k);
    const dropped = block.full.length - head.length - tail.length;
    const lines = [...head];

    if (dropped > 0) lines.push(elisionLine(dropped, block.elides));

    lines.push(...tail);

    return lines;
}

/**
 * Gives up one line. The change notes go first at their own floor; after that the widest block
 * above its floor loses a line, which is what makes the thinning proportional to the book's shape
 * instead of arbitrary (see `buildBody`). `priority` is only the tie-break between equal blocks.
 *
 * Returns false when every block is at its floor of one line — the caller's signal to cut at the
 * ceiling rather than ship an unbounded brief.
 */
function thinOne(blocks: ThinnableBlock[]): boolean {
    const notes = blocks.find((block) => block.priority === 0);

    if (notes && notes.full.length > 1 && notes.keep > 1) {
        notes.keep -= 1;

        return true;
    }

    let widest: ThinnableBlock | undefined;
    let chars = -1;

    for (const block of blocks) {
        if (block.priority === 0) continue;

        if (block.full.length <= 1 || block.keep <= 1) continue;

        const size = renderBlock(block).join('\n').length;

        if (size > chars || (size === chars && widest !== undefined && block.priority < widest.priority)) {
            widest = block;
            chars = size;
        }
    }

    if (!widest) return false;

    widest.keep -= 1;

    return true;
}

/**
 * Bible recap (§4.2's prose fields), one bounded line each. A run reading the Digest is not reading
 * the Summary, and the Summary is still a `readSummary` away when it needs the full text (D-13's
 * brief is Digest + artifact + criteria, never the whole book).
 */
function recapBlock(store: Store, storyId: string): string {
    const summary = store.summaries.list().find((record) => record.story_id === storyId);

    if (!summary) return '## bible\nno Summary record yet — this Story is still pre-Phase-1';

    const fields: [string, string | undefined][] = [
        ['premise', summary.premise],
        ['promise', summary.promise],
        ['theme', summary.theme],
        ['tone', summary.tone],
        ['ending', summary.ending],
        ['world_rules', summary.world_rules]
    ];

    // `chapter_count` is Author truth (D-3b) and the number C-0 enforces, so it leads the recap: a
    // crew must know the declared shape of the book before it proposes another one.
    const lines = [
        `declared chapters: ${summary.chapter_count}${summary.locked ? ' · Summary locked (P5: read-only, backtrack only)' : ''}`
    ];

    for (const [name, value] of fields) {
        if (!value || value.trim().length === 0) continue;

        lines.push(`${name}: ${clampLine(value, RECAP_FIELD_LIMIT)}`);
    }

    return `## bible\n${lines.join('\n')}`;
}

/**
 * Per-chapter one-liners (§4.8), in `order`: L-8 keeps the chapter set in flight together, but the
 * book is still ordered and every reviewer needs the sequence.
 *
 * The line is the chapter's own `summary` when it has one and the opening of its first section
 * otherwise — the fallback matters because a drafted chapter usually carries no synopsis, and a
 * Digest that skipped it would leave a hole exactly where the reviewer is working.
 *
 * EXPANDED (D-13): the chapter's contract as well — `must_happen` / `must_change` from the plotline
 * that governs it. That is the pair C-7/C-8 are judged against, so a crew that filed `digest_gap`
 * because it had to open the plotline is not being told to file it again.
 */
function chapterLines(store: Store, storyId: string, expanded: boolean): string[] {
    const chapters = storyChapters(store, storyId);

    if (chapters.length === 0) return ['no chapters written yet'];

    const plotlineById = new Map(storyPlotlines(store, storyId).map((plotline) => [plotline.id, plotline] as const));
    const lines: string[] = [];

    for (const chapter of chapters) {
        const gist = chapter.summary?.trim() || chapter.sections[0]?.text || '(no prose yet)';

        lines.push(
            `${chapter.order} · ${clampLine(chapter.title, CHAPTER_LINE_LIMIT)} — ${clampLine(gist, CHAPTER_LINE_LIMIT)} [${chapter.sections.length} section(s), ${chapter.state}${chapter.author_locked ? ', author-locked' : ''}]`
        );

        if (!expanded) continue;

        const plotline = chapter.plotline_ref ? plotlineById.get(chapter.plotline_ref) : undefined;

        if (!plotline) {
            lines.push('  contract: none bound — this chapter has no plotline to judge it against (C-1)');
            continue;
        }

        lines.push(`  must_happen: ${clampLine(plotline.must_happen ?? '(undeclared)', RECAP_FIELD_LIMIT)}`);
        lines.push(`  must_change: ${clampLine(plotline.must_change ?? '(undeclared)', RECAP_FIELD_LIMIT)}`);
    }

    return lines;
}

/**
 * Open threads (§4.8): what is still owed, in what the reviewer will actually use it for.
 *
 * Order inside the block is deliberate — the finding count first (it is what drained and completion
 * read, L-37/L-25), then the ledger's contradictions (the one ledger state that blocks completion),
 * then the setup lines themselves. A thin cut takes the last lines (see `thinOne`), so the counts
 * survive and the detail is what thins.
 *
 * Setups group on the SAME normalised key the C-5 checker uses (D-10, `normalizeKey`): grouping one
 * way in the Digest and another way in the criteria engine would let the Author read "no open
 * threads" beside a failing C-5, and a fresh run cannot referee that.
 */
function threadLines(store: Store, storyId: string): string[] {
    const lines: string[] = [`open findings: ${openFindingCounts(store, storyId)}`];

    const conflicts = store.ledger.list().filter((entry) => entry.story_id === storyId && entry.status === 'conflict');

    lines.push(
        conflicts.length === 0
            ? 'ledger conflicts: none'
            : `ledger conflicts: ${conflicts.map((entry) => `${entry.id} "${clampLine(entry.subject, 60)}"`).join(', ')}`
    );

    const open = store.ledger
        .list()
        .filter((entry) => entry.story_id === storyId && entry.kind === 'setup' && entry.status === 'open')
        .sort((left, right) => {
            const keyLeft = normalizeKey(left.subject);
            const keyRight = normalizeKey(right.subject);

            return keyLeft === keyRight ? left.id.localeCompare(right.id) : keyLeft.localeCompare(keyRight);
        });

    if (open.length === 0) {
        lines.push('open setups: none');

        return lines;
    }

    const grouped = new Map<string, { display: string; entries: string[] }>();

    for (const entry of open) {
        const key = normalizeKey(entry.subject);
        const group = grouped.get(key) ?? { display: entry.subject.trim(), entries: [] };

        group.entries.push(`${entry.id}${entry.chapter_ref ? `@${entry.chapter_ref}` : ''}`);
        grouped.set(key, group);
    }

    for (const group of grouped.values())
        lines.push(`open setup · ${clampLine(group.display, 120)}: ${group.entries.join(', ')}`);

    return lines;
}

/** Open findings counted by cost, in triage order — the same classes the auto-approve dial moves (D-35, D-35b). */
function openFindingCounts(store: Store, storyId: string): string {
    const open = store.findings
        .list()
        .filter((finding) => finding.story_id === storyId && OPEN_FINDING_STATES.includes(finding.state));

    if (open.length === 0) return 'none';

    const parts = COST_ORDER.filter((cost) => open.some((finding) => finding.cost === cost)).map(
        (cost) => `${open.filter((finding) => finding.cost === cost).length} ${cost}`
    );

    // A cost outside §4.10's enum cannot arrive through the tools, but a hand-edited store must not
    // lose its count silently — this line is the Author's summary of what is still owed.
    const untriaged = open.filter((finding) => !COST_ORDER.includes(finding.cost)).length;

    if (untriaged > 0) parts.push(`${untriaged} untriaged`);

    return parts.join(', ');
}

/**
 * Cast state (§4.5, D-9): who is where NOW, and the arc a reviewer measures behaviour against for
 * C-9. Ordered by name — a stable, human-legible key — so the same store always derives the same
 * text (D-12a), rather than the insertion order the rows happened to arrive in.
 */
function castLines(store: Store, storyId: string): string[] {
    const members = store.cast
        .list()
        .filter((member) => member.story_id === storyId)
        .sort((left, right) =>
            left.name === right.name ? left.id.localeCompare(right.id) : left.name.localeCompare(right.name)
        );

    if (members.length === 0) return ['no cast recorded'];

    return members.map(
        (member) =>
            `${clampLine(member.name, 120)} — now: ${clampLine(member.state_now ?? '(not recorded)', RECAP_FIELD_LIMIT)}${
                member.arc ? ` | arc: ${clampLine(member.arc, RECAP_FIELD_LIMIT)}` : ''
            }`
    );
}

/**
 * Last change notes (§4.8, D-12a's "commits and the records they touched"), rendered
 * `seq · op recordId — why (by whom)`, newest last so a run reads the direction of travel.
 *
 * This is P11/D-8 delivered inside the brief: a fresh run sees not only what the book says but which
 * run last moved it and for what stated reason — the audit line that lets it tell a deliberate beat
 * from a drift. Digest writes and the `digest_rev` bump are excluded (derived state, not story
 * state), and an engine write is attributed as the engine rather than dressed up as an author.
 */
function changeNotes(store: Store, storyId: string): string[] {
    const events = storyEvents(store, storyId).slice(-CHANGE_NOTE_LIMIT);

    return events.map((event) => {
        const attribution = event.attribution;

        // The flag order is the store's own writer taxonomy (src/server/store/store.ts:63-81), read
        // from the most specific kind to the least: an Author-invoked assistant (§8.6) sets
        // `assistant: true` AND its `run_ref` (and inherits the Author's rights, so `author` may be
        // set too), and the one fact the audit must not lose is that the machine moved the book ON
        // THE AUTHOR'S INSTRUCTION (D-8). Labelling that write by its run alone would make the
        // assistant indistinguishable from a dispatched crew run, which is exactly the distinction
        // store.ts:69-70 exists to keep. An engine derivation sets none of the flags and reads as
        // the engine (D-12a: no one chose this text).
        const by = attribution.assistant
            ? 'assistant'
            : attribution.author
              ? 'author'
              : attribution.run_ref
                ? `run ${attribution.run_ref}`
                : 'engine';

        return `${event.seq} · ${event.op} ${event.id} — ${clampLine(attribution.why, 160)} (by ${by})`;
    });
}
