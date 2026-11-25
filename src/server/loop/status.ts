// The decision machine: what one Story's status becomes after one sweep, and why (D-2a, §6.6, §9).
//
// The order below IS the precedence the spec fixes, and most of the acceptance rows are about it:
//   1. the Author's own switch wins over everything (`author_stop`, `status: stopped` — P8, D-37b);
//   2. a phase whose Goal passes stops at the sign-off (L-29) — except phase `chapters`, which never
//      waits on a sign-off (L-35: phase ③ ends when it DRAINS, and the Story ends when the Author
//      accepts, L-26);
//   3. `drained` is tested before `stalled` and wins (L-37a) — a Story that has run out of authorised
//      work has exactly the flat signature L-21 reads as "stuck", and calling it stuck is the exact
//      defect L-37a names;
//   4. the by-design Author waits (`idea_selection`, `finding_approval`) begin only when NOTHING ELSE
//      is dispatchable (L-36: an unapproved finding is a pending decision, not a blocked Story);
//   5. `stalled` (L-21) — the only `pending` that means trouble (L-34);
//   6. otherwise `ready`, and the sweep dispatches.
//
// `status_reason` is written to L-22's standard on every branch: name the artifact, the level, the
// criteria, the fingerprint, the chapters. The row the Author reads IS this string, so a vague string
// here is a spec violation rather than a style problem.
import {
    currentSeedBrief,
    deepReviewPassesOwed,
    dialCovers,
    dialKey,
    dispatchableTasks,
    findingsAwaitingAuthor,
    findingsCreatedSince,
    ideasToVerify,
    isSupersededSummaryDraft,
    last,
    latestJournalSeq,
    liveRuns,
    loopStory,
    repeatIdeas,
    researchGate,
    roundRevisions,
    // G1 — the drain probe names the plateau the moment the accepted-revision audit says the hill has
    // stopped moving, so the `unmet` list the Author sees matches the queue row and the arming rule.
    revisionReviewProgressOf,
    samplingArmed,
    // T12/P3 + HILL CLIMB: the drain's sampling clause reads the ACTIVE wave's attempt count against the
    // wave's own budget — the static cap, extended by proven improvements and cut short by the
    // no-progress streak — so the drain, `./work`'s queue and `./records`' leg gate cannot disagree
    // about whether the round still owes samples.
    samplingProgressOf,
    samplingRoundOf,
    samplingSizeOf,
    screensFor,
    // T-10 / the G-9 fix: the drain probe has to name the stage the round is actually waiting on. A
    // Researcher-owned `fix` row is invisible to the Writer-side reads (it is not in the prompt, the
    // demand or the certificate), so without this line the Story can read `drained` while the work
    // that would arm the round is still in front of it — the same contradiction D-27 removed for
    // unverified Ideas.
    openResearchFixPrerequisites,
    RESEARCH_PREREQUISITE_CAP,
    researchPrerequisiteAttempts,
    screeningSizeOf,
    selectedSummaryRevision,
    storyIdeas,
    storySummary,
    summaryBlockingFindings,
    summaryRevisions,
    undecidedIdeas,
    storyFindings,
    unconfirmedBlockingFindings,
    unitsWithCompetingRevisions,
    unitsWithPendingRevisions
} from './records';
// SUMMARY PHRASE (hardening, drain/sign-off parity): the group pipeline's owed-work read lives on the
// phrase surface (`phrase/exclusion.ts:groupPipelineOwed`) — the SAME rules `work.ts` builds its
// candidates from — because a grouped book has no sampling rows for §6.4's clauses to describe, and
// the rail (`api/projections.ts`) already answers "what still owes a review?" with these reads.
import { groupPipelineOwed, isGroupManagedStory, isGroupPipelineRun, SECTION_SCORE_ITEM_PREFIX } from '../phrase';
import { pendingDirectives } from './directives';
import { isStalled, renderPairs, stalledReason, type RoundDelta } from './trend';
import type { CompletionProposal, LoopStory, ProbeState } from './types';
import type { GoalStatus, LevelReport } from '../criteria/engine';
import type { Cost, Finding, Goal, Idea, PendingKind, Story, StoryPhase, StoryStatus } from '../../shared/types';
import type { Store } from '../store';

/** What `decideStory` concluded, in the form the sweep writes and the report renders. */
export interface StoryDecision {
    status: StoryStatus;
    pending_kind: PendingKind;
    status_reason: string;
    /** §4.1's `blocked_on`: the short thing the tree renders; empty when nothing is held up. */
    blocked_on: string;
    /** L-0: may this Story receive work this sweep? */
    dispatch: boolean;
    /** The probe state to persist, or `undefined` to leave the stored one alone. */
    probe?: ProbeState;
    /** Set when this sweep raises the completion proposal (L-25). */
    completion?: CompletionProposal;
    /** The branch taken, for the sweep report and for a test that wants the reason without the prose. */
    why: string;
}

/** The inputs the decision needs, gathered once per Story per sweep so nothing is read twice. */
export interface DecisionInput {
    goal: Goal;
    goalStatus: GoalStatus;
    levels: LevelReport;
    levelPairs: Record<string, string>;
    delta: RoundDelta;
    /**
     * How many jobs the loop WOULD dispatch. L-36's wait only begins "when nothing else is
     * dispatchable", so the candidate list has to be computed before the decision is — this number is
     * that list's length, and it is the only reason `work.ts` runs first.
     */
    dispatchable: number;
}

// ---------------------------------------------------------------------------
// L-37's four conditions, and the probe that answers condition 3
// ---------------------------------------------------------------------------

/**
 * D-27: a sourced Idea still awaiting the Editor is the Ideas-tray twin of D-33's unconfirmed finding —
 * an Editor run the crew can start right now, and a precondition on the Author ever being able to pick
 * the Idea (C-15 refuses an unverified one). Counting it here is what stops the sweep reporting
 * `drained` (and refusing to start a probe round) while verification work is still in front of it: the
 * loop has NOT run out of authorised work, it has just not done this part yet.
 */
export const ideasAwaitingVerification = (store: Store, story: Story): Idea[] =>
    ideasToVerify(store, story.id, story.phase);

/**
 * L-37's conditions 1, 2 and 4 — everything except the fresh round, which is the probe's job.
 *
 * Condition 1 reads `open`/`claimed` tasks of a dispatchable kind ("no `approved` or `open` task
 * remains for a Writer"). A `blocked` task is the crew asking the Author something, which is what
 * `drained` MEANS — the loop cannot act without them — so it does not block drained. That reading is
 * what keeps an escalation from needing a `pending_kind` §4.1's enum does not have.
 */
export function drainPreconditions(store: Store, story: Story): { met: boolean; unmet: string[] } {
    const tasks = dispatchableTasks(store, story.id);
    const unconfirmed = unconfirmedBlockingFindings(store, story);
    const competing = unitsWithCompetingRevisions(store, story);
    const pendingDrafts = unitsWithPendingRevisions(store, story.id);
    const unverified = ideasAwaitingVerification(store, story);
    // A Writer that has not filed a revision yet is invisible to `unitsWithPendingRevisions`: the
    // first Writer of phase ① works on the EMPTY Summary row `createStory` opened, and its run is
    // the only record that the draft exists. Counting it is what stops the drain probe from reading
    // (and filing on) an artifact the Writer is still writing (L-37's "single full pass").
    const liveWriters = liveRuns(store, story.id).filter((run) => run.role === 'writer');
    const unmet: string[] = [];

    if (tasks.length > 0) unmet.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} still queued`);
    if (liveWriters.length > 0)
        unmet.push(
            `${liveWriters.length} Writer${liveWriters.length === 1 ? '' : 's'} still running (§4.15: no draft has been filed yet)`
        );
    if (pendingDrafts.length > 0)
        unmet.push(`${pendingDrafts.length} unit${pendingDrafts.length === 1 ? '' : 's'} still being drafted (§4.15)`);
    if (unconfirmed.length > 0)
        unmet.push(`${unconfirmed.length} finding${unconfirmed.length === 1 ? '' : 's'} still unconfirmed (D-33)`);
    if (competing.length > 0)
        unmet.push(
            `${competing.length} unit${competing.length === 1 ? '' : 's'} with competing drafts awaiting an Editor (D-23)`
        );
    if (unverified.length > 0)
        unmet.push(
            `${unverified.length} sourced Idea${unverified.length === 1 ? '' : 's'} still awaiting the Editor's verdict (D-27)`
        );

    // Phase ①'s research pipeline (§6.4, §6.7): the phase is not drained while a stage is still
    // owed. Each line is one of the gates the sweep actually enforces, in the same plain sentence
    // shape as the conditions above, so the Author's drain row says WHICH stage is unfinished.
    if (story.phase === 'summary') unmet.push(...phase1Unmet(store, story));

    return { met: unmet.length === 0, unmet };
}

/** Phase ①'s two pipeline families — a live one means a sample is being written or screened. */
const PHASE1_PIPELINE_RUN = /^wi_(sample|screen)_/;

/**
 * H2/R1's drain sentence — one copy for BOTH pipelines.
 *
 * These rows are not in `phase1Unmet`'s writer reads (no draft is asked to resolve them, and
 * `run/phase1-prompt.ts` keeps them out of the Writer's block), so the only way the drain probe can
 * tell the truth about a round held behind one is to read the prerequisite set itself. The cap is
 * named too: at the cap the row is no longer work the crew can do, and the Author question the queue
 * opens is what the decision machine then reads (H2/R2).
 */
function pushResearchPrerequisites(store: Store, story: Story, unmet: string[]): void {
    const prerequisites = openResearchFixPrerequisites(store, story.id);

    if (prerequisites.length > 0) {
        unmet.push(
            `${prerequisites.length} open fix task${prerequisites.length === 1 ? '' : 's'} a Researcher must ground (${prerequisites
                .slice(0, 3)
                .map((task) => `${task.id}, pass ${researchPrerequisiteAttempts(store, task.id)}/${RESEARCH_PREREQUISITE_CAP}`)
                .join(', ')}): a draft cannot resolve an external fact, so the round waits for the pass (§6.4 step 2, T-10)`
        );
    }
}

/**
 * Phase ①'s stage-by-stage drain reasons (documents/phase-1-research-pipeline.md §6.7):
 *
 *   1. no accepted Seed Brief for the CURRENT Seed (`seed_hash` mismatch counts as none);
 *   2. the brief's research pass has no closed run — and D-51: a brief whose `research_questions`
 *      list is EMPTY WAIVES that pass, so a waived Story owes no research row and never reports this;
 *   3. the in-flight sampling round is unfinished — a live sample/screen, a drafted sample short of
 *      its screening passes, or fewer samples than the size while the retry allowance remains.
 *
 * Clause 3 only speaks when the round is ARMED (`records.ts:samplingArmed`): after a clean deep
 * review with no open fix task the next round is deliberately not owed, and reporting "0 of 3
 * samples exist" there would keep the Story from ever reading as drained (§6.8's stop rule).
 *
 * HARDENING: for a GROUP-managed book the clauses below are replaced by the group pipeline's own
 * reads (see the branch inside), which answer the same §6.4 stages for a book that has no samples.
 */
function phase1Unmet(store: Store, story: Story): string[] {
    const brief = currentSeedBrief(store, story);
    const unmet: string[] = [];

    if (brief === undefined) {
        unmet.push(
            'no accepted Seed Brief describes the current Seed — the Editor has not structured it yet (§6.4 step 1)'
        );

        return unmet;
    }

    // D-51: only a brief that OWES a research pass can hold the drain here. `records.ts:researchGate`
    // answers `waived` when the Editor's `research_questions` list is empty, and a waived Story must
    // read as drained with no research row at all — this is the same predicate `work.ts`'s gates 2 and
    // 3 read, which is what keeps generation and this probe (§6.7) telling one story.
    if (researchGate(store, story, brief) === 'needed') {
        unmet.push(
            "the Seed Brief has no closed research pass — the Researcher has not recorded the Knowledge it depends on (§6.4 step 2)"
        );

        return unmet;
    }

    const summary = storySummary(store, story.id);

    if (summary === undefined) return unmet;

    // SUMMARY PHRASE (hardening) — a group-managed book has none of the sampling machinery clauses
    // 3-6 below describe: no sample drafts, no screening set, no round to arm, and no accepted-
    // revision audit to plateau. What phase ① still OWES there — and therefore what this probe has
    // to name before the Story may read `drained` (L-37: "out of authorised work") — is the group
    // pipeline: live runs, the groups that owe a draft or a fix pass, and the review seats of the
    // CURRENT vector that have not reported yet. Every line comes from
    // `phrase/exclusion.ts:groupPipelineOwed`, which is built from `work.ts:phase1GroupCandidates`'
    // own gates, so the probe and the queue cannot tell two stories about the same book — the same
    // shared-predicate discipline `researchGate` above enforces for the sampling pipeline. The
    // phase-① sign-off gate (`decideStory`) holds on these same reads.
    if (isGroupManagedStory(story)) {
        // Step 0 of the pipeline is SHARED (`work.ts:phase1FixPrerequisites` runs before the mode
        // switch), so the Researcher-owned rows hold a grouped round's drain with the same sentence.
        pushResearchPrerequisites(store, story, unmet);

        const groupLive = liveRuns(store, story.id).filter((run) => isGroupPipelineRun(run));

        if (groupLive.length > 0) {
            // READER SCORING (D-65): a live scoring pass is named in the same line, in the Author's
            // words, because the row it holds up is a `%` the rail is waiting for and not a repair. The
            // clause is additive text on an existing sentence — a scoring run counts in flight exactly as
            // a review run does, and no SCORE affects the drain, only the run's existence.
            const scoring = groupLive.filter((run) =>
                (run.work_item_ref ?? '').startsWith(`${SECTION_SCORE_ITEM_PREFIX}_`)
            ).length;

            unmet.push(
                `${groupLive.length} group-pipeline run${groupLive.length === 1 ? '' : 's'} still in flight${
                    scoring > 0 ? ` (${scoring} scoring the installed Overview)` : ''
                } (R5, §6.4 steps 3-6)`
            );
        }

        const owedGroups = groupPipelineOwed(store, story);

        if (owedGroups.drafts > 0)
            unmet.push(
                `${owedGroups.drafts} group${owedGroups.drafts === 1 ? '' : 's'} still owe the Overview a draft or a fix pass (R2, §6.4 step 3)`
            );

        if (owedGroups.structuredReviews > 0)
            unmet.push(
                `${owedGroups.structuredReviews} Critic pass${owedGroups.structuredReviews === 1 ? '' : 'es'} still owed on the installed group Overview (R3, R5, §6.4 step 4)`
            );

        if (owedGroups.deepReviews > 0)
            unmet.push(
                `${owedGroups.deepReviews} deep-review pass${owedGroups.deepReviews === 1 ? '' : 'es'} still owed for the installed group Overview (§6.4 step 6, R5)`
            );

        return unmet;
    }

    const live = liveRuns(store, story.id).filter((run) => PHASE1_PIPELINE_RUN.test(run.work_item_ref ?? ''));

    if (live.length > 0)
        unmet.push(
            `${live.length} sampling/screening run${live.length === 1 ? '' : 's'} still in flight (§6.4 steps 3-4)`
        );

    // T6/R2b: a draft the loop has already set aside is not owed screening either — the screening job
    // is not offered for it (`work.ts:phase1PipelineCandidates` gate 4), so counting it here would put
    // the drain probe and the work queue back into the contradiction this pass is fixing.
    const owed = summaryRevisions(store, story.id).filter(
        (revision) =>
            revision.state === 'drafted' &&
            screensFor(store, revision.id).length < screeningSizeOf(story) &&
            !isSupersededSummaryDraft(store, story, revision)
    ).length;

    if (owed > 0)
        unmet.push(
            `${owed} sample${owed === 1 ? '' : 's'} still owe screening passes (${screeningSizeOf(story)} per sample, §6.4 step 4)`
        );

    // H2/R1 — the round's RESEARCHER-owned targets (one sentence, both pipelines: step 0 of the
    // generator is shared, so the grouped book holds its drain on the same rows).
    pushResearchPrerequisites(store, story, unmet);

    const round = samplingRoundOf(story);
    const have = roundRevisions(store, story.id, round).length;
    const size = samplingSizeOf(story);
    // T12/P3 — the count has to be the one the ENGINE spends its budget by: the ACTIVE wave's attempts
    // (`work.ts` and `records.ts:samplingLegClosed` both read `samplingWaveOf(story)`, because the
    // Author's clear of a sampling escalation re-arms the round in a NEW wave, T12/E). Read without the
    // wave, `sampleAttempts` returns the whole round family — every wave's spent runs — so a round the
    // Author just re-armed looked spent and this sentence went silent over samples the sweep is about to
    // dispatch, while a round whose NEW wave has spent its cap looked the same as one that had not.
    //
    // HILL CLIMB — and the budget is the wave's, not the constant: it grows while an attempt proves a
    // lower unresolved-blocking-fix count and closes early when the no-progress streak stops the round.
    // Naming the constant here would keep the drain blocking on samples the loop has stopped buying.
    const progress = samplingProgressOf(store, story, round);

    if (samplingArmed(store, story, round) && have < size && progress.attempts < progress.ceiling && !progress.stalledForProgress)
        unmet.push(
            `${have} of ${size} sample${size === 1 ? '' : 's'} exist for round ${round} and retries remain (§6.4 step 3)`
        );

    // §6.4 step 6: the cheap deep review the pipeline buys is owed work, not a detail — a probe
    // reporting "nothing at the dial" over a half-read draft would be judging a book nobody reviewed.
    const owedReview = deepReviewPassesOwed(store, story, selectedSummaryRevision(store, story.id));

    if (owedReview > 0)
        unmet.push(
            `${owedReview} deep-review pass${owedReview === 1 ? '' : 'es'} still owed for the selected Summary revision (§6.4 step 6)`
        );

    // G1 — the ACCEPTED-REVISION plateau (the gap §6.8's drain leaves open). Three accepted revisions in
    // a row that did not lower the blocking bar are the same "the hill is not moving" signal the
    // candidate-level streak answers, one level up: the loop keeps paying for full rounds that buy
    // nothing. The sampling legs are closed (`records.ts:samplingArmed`) so clause 3 above went silent,
    // and this line is what stops the Story from reading `drained` — the crew is NOT out of authorised
    // work, it is out of authorised work THAT HELPS, and only the Author's clear re-arms the wave
    // (`engine.ts:rearmSamplingWave`). It names the number the escalation row carries, so a pane and a
    // queue row cannot disagree.
    const plateau = revisionReviewProgressOf(store, story);

    if (plateau.plateaued)
        unmet.push(
            `${plateau.noImprovement} accepted Summary revision${
                plateau.noImprovement === 1 ? '' : 's'
            } in a row left the blocking count at ${plateau.bestBlockingFound ?? 0} or worse, so sampling has stopped — clear the Author question to re-arm the wave (G1)`
        );

    return unmet;
}

/** The dial as prose, for the drained reason (§15 step 11's "no critical or major left"). */
export function dialPhrase(story: Story): string {
    const order: Cost[] = ['critical', 'major', 'minor', 'taste'];
    const covered = order.filter((cost) => dialCovers(story, cost));

    if (covered.length === 0) return 'nothing';
    if (covered.length === 1) return covered[0];

    return `${covered.slice(0, -1).join(', ')} or ${last(covered)}`;
}

/** The dial as the sorted list `ProbeState.dial` stores, so a widened dial invalidates a round. */
export const dialKeyOf = (story: Story): string[] =>
    dialKey(story)
        .split(',')
        .filter((cost) => cost.length > 0)
        .sort();

/**
 * Does the stored probe still describe the current situation?
 *
 * It stops describing it when the phase moves (L-37's pass is per phase), when the dial is WIDENED
 * (D-35b: costs the crew was not previously allowed to work on are now work, so a round that found
 * none of them proves nothing), or when the preconditions broke after the round (new work appeared, so
 * the round was no longer "a single full pass over the Story" — L-37's own words).
 *
 * NARROWING the dial deliberately does not invalidate a clean round: a round that found nothing at
 * {critical, major} has by construction found nothing at {critical} alone. That is why §15 step 11a's
 * "raise the dial to `critical` only and watch the same Story drain sooner" resolves immediately
 * instead of costing a fresh round.
 */
export function probeIsLive(story: Story, phase: StoryPhase, dial: string[], preconditionsMet: boolean): boolean {
    const probe = loopStory(story).probe;

    if (probe === undefined || !preconditionsMet) return false;
    if (probe.phase !== phase) return false;
    if (probe.status !== 'clean') return false;
    if ([...probe.dial].sort().join(',') === [...dial].sort().join(',')) return true;

    // True only when the stored dial is a SUBSET of the current one — i.e. nothing was removed, so the
    // round's evidence still covers the threshold now in force.
    return probe.dial.every((cost) => dial.includes(cost));
}

/** Starts a fresh round (L-37's condition 3): the watermark is the journal's high-water mark. */
export function startProbe(store: Store, story: Story, phase: StoryPhase, at: string): ProbeState {
    return {
        status: 'running',
        phase,
        reader_item_id: null,
        critic_item_id: null,
        // The watermark is the journal's `seq` and not a timestamp: one sweep commits dozens of times
        // and two commits can share a millisecond, so a clock comparison would silently assign a
        // finding to the wrong round. D-14 anchors staleness on the same number for the same reason,
        // and `seq` is the only ordering that survives a restart (L-3).
        journal_seq: latestJournalSeq(store),
        dial: dialKeyOf(story),
        started_at: at,
        clean_since: null
    };
}

/**
 * The round's verdict, once both probe runs have closed (the sweep calls this with the closed runs).
 *
 * L-37's condition 3 is about the DIAL, not about findings in general: a `minor` finding turned up by
 * a fresh Critic while the dial covers `critical`+`major` does NOT dirty the round — §15 step 11's
 * whole point is that the Story drains with 12 `minor` and 4 `taste` findings sitting open. Ideas
 * never dirty it either: an Idea is a proposal for the Author (D-26), not authorised work.
 */
export function judgeProbe(store: Store, story: Story, probe: ProbeState, at: string): ProbeState {
    const covered = findingsCreatedSince(store, story.id, probe.journal_seq).filter((finding) =>
        dialCovers(story, finding.cost)
    );

    if (covered.length > 0) return { ...probe, status: 'idle', clean_since: null };

    return { ...probe, status: 'clean', clean_since: at };
}

/** What the Author is being handed, for L-37's reason sentence and U-1c's exactly-two-moves. */
export interface Leftovers {
    findings: number;
    ideas: number;
    /** Confirmed findings the dial does not cover: approving one is the move that returns the Story to `ready`. */
    awaiting: number;
}

export function leftovers(store: Store, story: Story): Leftovers {
    const open = storyFindings(store, story.id).filter(
        (finding) => finding.state !== 'fixed' && finding.state !== 'discarded'
    );
    // U-14's "the Author accepts with their eyes open" only works when this is the number the accept
    // really throws away, so it reads the SAME set `acceptCompletion` iterates (below:
    // `DISCARDABLE_IDEA_STATES`, story-wide like the accept) rather than the strict `proposed` rows. A
    // `verified` / `refuted` / `unverifiable` Idea is still undecided — the Editor answered "is the claim
    // true?", never "is it in the book?" (T-3b) — and the accept discards it exactly as it discards a
    // `proposed` one, so counting only `proposed` under-stated the discard by every row the loop had
    // fact-checked. Same set `api/projections.ts:completionPreview` renders, so the drained row and the
    // Story view cannot disagree. `api/routes.ts`' lock gate and the queue read the phase's tray
    // (`records.ts:undecidedIdeas`); a locked phase never has an undecided row of its own left (L-7a,
    // D-36), so story-wide and per-phase agree for every reachable drained Story.
    const ideas = storyIdeas(store, story.id).filter((idea) => DISCARDABLE_IDEA_STATES.includes(idea.state));

    return {
        findings: open.length,
        ideas: ideas.length,
        // The same reader the decision machine uses, so phase ①'s minor/taste notes are never
        // reported as "awaiting you" when the Author's bar is critical/major.
        awaiting: findingsAwaitingAuthor(store, story).length
    };
}

// ---------------------------------------------------------------------------
// L-25's completion test
// ---------------------------------------------------------------------------

/**
 * L-25: drained PLUS every hard criterion passing at every reached level, no ledger `conflict` and no
 * setup left unpaid past its point, and the soft count at or above `threshold_soft`.
 *
 * L-25b is why this does NOT ask for an empty finding list: "a bar of zero open findings is a bar no
 * book clears". The Goal can pass with 16 findings open; what closes them is the Author's acceptance
 * (L-26), and the count is recorded so the Author can see what they waved away (U-14).
 *
 * `goalStatus.passed` already encodes "every hard passes AND soft >= threshold" (criteria/engine.ts's
 * `tally`), so the extra tests here are the two L-25 clauses the phase Goal does not consult: the
 * ledger's `conflict` flag and its unpaid setups (D-10, C-5).
 */
export function completionReady(store: Store, story: Story, goalStatus: GoalStatus): { met: boolean; unmet: string[] } {
    const unmet: string[] = [];

    if (!goalStatus.passed) unmet.push(`the phase Goal is ${goalStatus.progress}`);

    const conflicts = store.ledger.list().filter((entry) => entry.story_id === story.id && entry.status === 'conflict');

    if (conflicts.length > 0) unmet.push(`${conflicts.length} ledger entries in conflict (D-10)`);

    const unpaid = store.ledger
        .list()
        .filter((entry) => entry.story_id === story.id && entry.kind === 'setup' && entry.status === 'open');

    if (unpaid.length > 0) unmet.push(`${unpaid.length} setup${unpaid.length === 1 ? '' : 's'} with no payoff (C-5)`);

    return { met: unmet.length === 0, unmet };
}

/**
 * L-25's proposal, carrying L-25b's counts so U-14's prompt can state what accepting will discard.
 *
 * Idempotent per drain: the original `proposed_at` survives a re-raise so the row does not look
 * freshly proposed on every sweep, and nothing is raised again while the same counts are already
 * pending (a proposal that churned every sweep would re-page the Author for the same decision).
 */
export function raiseCompletion(store: Store, story: Story, at: string): CompletionProposal | undefined {
    const loop = loopStory(story);

    if (loop.completion?.accepted === true) return undefined;

    const left = leftovers(store, story);
    const pending = { findings: left.findings, ideas: left.ideas };

    if (
        loop.completion !== undefined &&
        loop.completion.leftovers.findings === pending.findings &&
        loop.completion.leftovers.ideas === pending.ideas
    ) {
        return undefined;
    }

    return {
        proposed_at: loop.completion?.proposed_at ?? at,
        phase: story.phase,
        leftovers: pending,
        accepted: false,
        // L-30: a discard survives the proposal being cleared, so the count carries forward.
        discarded: loop.completion?.discarded ?? 0
    };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * The one function that decides a Story's status, pure over the store plus what the sweep already
 * measured. It never writes: the sweep applies the result in a single commit, so a Story's status and
 * its reason always land together (P1).
 */
export function decideStory(store: Store, story: Story, input: DecisionInput, ctx: { at: string }): StoryDecision {
    const loop = loopStory(story);

    // 1. The Author's cord. P8: a stopped Story never auto-resumes, and D-37b says a pause is not a
    // mode the Story enters permanently — so the sweep reports the state and changes nothing.
    if (story.author_stop || story.status === 'stopped') {
        return {
            status: story.status,
            pending_kind: story.pending_kind,
            status_reason: story.status_reason || 'the Author has it stopped (P8, D-37)',
            blocked_on: 'the Author',
            dispatch: false,
            why: 'author_stop'
        };
    }

    // 2. A completed Story stays closed until the Author edits, a `needs_recheck` lands, or a directive
    // arrives (L-27) — all of which are verbs, not sweep decisions.
    if (story.status === 'completed') {
        return {
            status: 'completed',
            pending_kind: story.pending_kind,
            status_reason: story.status_reason || 'the Author accepted completion (L-26)',
            blocked_on: '',
            dispatch: false,
            why: 'completed'
        };
    }

    // L-33: a phase may not be entered unless every earlier phase is locked. The sweep reports the
    // breach instead of dispatching into it, and only the Author's lock can fix it (D-25, D-1).
    if (!phasesUnlockedOk(story)) {
        return {
            status: 'pending',
            pending_kind: 'phase_signoff',
            status_reason: `phase ${story.phase} is open while an earlier phase is unlocked (L-33) — lock ${earlierUnlockedPhase(story)} first`,
            blocked_on: 'an earlier lock',
            dispatch: false,
            why: 'phase_precondition'
        };
    }

    // D-19: a directive is the Author talking to the Editor, so the review is DISPATCHABLE work, not
    // a wait. It must outrank a sign-off, a tray or a drain — the Author just made a decision, and
    // making them clear another hold first would lose the direction. The Editor's run is the next
    // thread the sweep opens; once its tasks exist, the ordinary status logic takes over.
    if (pendingDirectives(store, story.id).length > 0) {
        return {
            status: 'ready',
            pending_kind: 'none',
            status_reason: "the Editor is reviewing the Author's directive and setting its tasks (D-19)",
            blocked_on: '',
            dispatch: true,
            why: 'directive_review'
        };
    }

    // L-29's one suppression (documented judgment call): while a unit's drafts are still competing,
    // the phase is not eligible to advance at all (L-20, D-23), so the lock is not offered yet and the
    // Editor's job keeps the Story `ready`. Signing off over unchosen drafts would put the choice in
    // the Author's hands by default rather than by decision.
    const competing = unitsWithCompetingRevisions(store, story);
    // A draft whose Writer run closed short of a block is not competition yet: it is work the loop
    // still owes (§4.15), so a phase sign-off over it would park the Writer's own correction.
    const pendingDrafts = unitsWithPendingRevisions(store, story.id);

    // D-27 / L-36: a sourced Idea the Editor has not verified is an EDITOR job the crew can start now,
    // not a decision only the Author can make. Offering the lock (or the Idea pick) over one would put
    // the Author in front of an Idea they are not allowed to select — the select gate refuses an
    // unverified sourced Idea (api/routes.ts, C-15) — so the wait is suppressed while verification is
    // owed and the sweep dispatches `verify_ideas` instead. The sign-off and the pick are unchanged as
    // the fallback: they fire on the next sweep, over a tray the Editor has actually answered.
    const verificationOwed = ideasAwaitingVerification(store, story).length;
    // A suspicion nobody has confirmed or disputed is still work (D-33/L-37.2); a sign-off
    // before the Editor has answered it would take the choice on an unread critique.
    const findingsUnconfirmed = unconfirmedBlockingFindings(store, story).length;

    // Phase ①'s Editor sends a valid critique back to the Writer as a queued FIX task. Signing the
    // phase off while that task is still open would park the correction forever — the loop would
    // have judged the draft, marked the defect valid, and then stopped before acting on it. Only
    // `fix` work blocks the stop: an `absorb` row for a selected Idea is next phase's brief (D-29),
    // not a correction to the draft the Author is about to sign.
    const queued = dispatchableTasks(store, story.id);
    const fixesQueued = queued.filter((task) => task.kind === 'fix').length;

    // Phase ① is not done because the two Goal criteria pass. Its own bar is the Summary round:
    // another three drafts are owed while the selected Summary still carries a critical/major
    // finding, or while the Author asked for another revision. Minor/taste notes never hold it.
    const summary = story.phase === 'summary' ? storySummary(store, story.id) : undefined;
    const summaryBlocking =
        summary === undefined ? [] : summaryBlockingFindings(store, story, summary.id);
    // §6.4 step 6: the deep review of the selected revision is the phase's evidence. Signing off
    // after one pass of five would lock a Summary nobody finished reviewing, so the owed passes hold
    // the stop exactly like an open fix task does.
    //
    // HARDENING (sign-off/projection parity): a group-managed book has NO selected Summary revision
    // — the legacy read above answers "nothing owed" unconditionally there — so on that book the
    // phase's evidence is the CURRENT vector's review seats, structured passes and deep cross-group
    // passes alike, counted by the same closed-run rule the Author's rail shows
    // (`api/projections.ts:phraseView`'s `reviews_on_current_vector` / `deep_reviews_on_current_vector`
    // and `loop/work.ts`'s seat gates). The gate gets tighter to match the rail; it is never loosened
    // to let a lock through over an unread Overview.
    const groupOwedForSignoff =
        story.phase === 'summary' && isGroupManagedStory(story) ? groupPipelineOwed(store, story) : undefined;
    const reviewOwed =
        story.phase === 'summary'
            ? groupOwedForSignoff !== undefined
                ? groupOwedForSignoff.structuredReviews + groupOwedForSignoff.deepReviews > 0
                : deepReviewPassesOwed(store, story, selectedSummaryRevision(store, story.id)) > 0
            : false;
    const summaryRoundQueued =
        story.phase === 'summary'
            ? queued.filter((task) => task.kind === 'fix' || task.kind === 'rewrite' || task.kind === 'merge')
                  .length
            : 0;
    const phaseWorkQueued = story.phase === 'summary' ? summaryRoundQueued : fixesQueued;

    if (
        input.goalStatus.passed &&
        competing.length === 0 &&
        pendingDrafts.length === 0 &&
        verificationOwed === 0 &&
        findingsUnconfirmed === 0 &&
        phaseWorkQueued === 0 &&
        summaryBlocking.length === 0 &&
        !reviewOwed &&
        story.phase !== 'chapters' &&
        !phaseIsLocked(story)
    ) {
        const tray = undecidedIdeas(store, story.id, story.phase);

        // L-7a: the lock is not offered while the tray still holds an UNDECIDED Idea — "a locked artifact
        // with unjudged alternatives still in the tray is a decision the machine made by silence". The
        // Editor's verdict does not settle an Idea (T-3b): `verified`, `refuted` and `unverifiable` rows are
        // still the Author's to select, discard, or defer, so they hold the lock exactly as `proposed` ones
        // do. The wait is the Author's pick, not the lock.
        if (tray.length > 0) {
            return {
                status: 'pending',
                pending_kind: 'idea_selection',
                status_reason: `phase ${story.phase}'s Goal passes (${input.goalStatus.progress}) · ${tray.length} undecided Idea${tray.length === 1 ? '' : 's'} must be selected, discarded, or deferred before the lock (L-7a, D-29)`,
                blocked_on: `${tray.length} Idea${tray.length === 1 ? '' : 's'} in the tray`,
                dispatch: false,
                why: 'idea_selection'
            };
        }

        return {
            status: 'pending',
            pending_kind: 'phase_signoff',
            status_reason: signoffReason(story, input),
            blocked_on: lockLabel(story),
            dispatch: false,
            why: 'phase_signoff'
        };
    }

    // 3. Drained — tested before stalled, and it wins (L-37a).
    const pre = drainPreconditions(store, story);
    const dial = dialKeyOf(story);

    if (pre.met && probeIsLive(story, story.phase, dial, true)) {
        const left = leftovers(store, story);
        const completion = completionReady(store, story, input.goalStatus);

        return {
            status: 'pending',
            pending_kind: 'drained',
            status_reason: drainedReason(story, left, completion),
            blocked_on:
                left.awaiting > 0
                    ? `${left.awaiting} finding${left.awaiting === 1 ? '' : 's'} awaiting you`
                    : 'the Author: work the leftovers or accept completion',
            dispatch: false,
            completion: completion.met ? raiseCompletion(store, story, ctx.at) : undefined,
            why: 'drained'
        };
    }

    // 4. The by-design Author waits, and only when nothing else is dispatchable (L-36).
    if (input.dispatchable === 0) {
        // L-36's wait names the whole tray, not just the rows nobody has fact-checked yet: a `verified`
        // or `refuted` Idea is still an open Author decision, and calling the Story drained with one
        // sitting there would report "out of authorised work" while the lock stays refused (L-7a).
        const tray = undecidedIdeas(store, story.id, story.phase);
        const awaiting = findingsAwaitingAuthor(store, story);

        if (tray.length > 0 && awaiting.length === 0) {
            return {
                status: 'pending',
                pending_kind: 'idea_selection',
                status_reason: `${tray.length} undecided Idea${tray.length === 1 ? '' : 's'} in the tray and nothing else to dispatch · select or discard them (D-29, L-7a)`,
                blocked_on: `${tray.length} Idea${tray.length === 1 ? '' : 's'}`,
                dispatch: false,
                why: 'idea_selection'
            };
        }

        if (awaiting.length > 0) {
            const named = awaiting
                .slice(0, 3)
                .map((finding) => `${finding.cost} ${finding.fingerprint}`)
                .join(', ');

            return {
                status: 'pending',
                pending_kind: 'finding_approval',
                status_reason: `${awaiting.length} confirmed finding${awaiting.length === 1 ? '' : 's'} the dial (${dialPhrase(story)}) does not cover, and nothing else to dispatch: ${named} (D-34, L-36)`,
                blocked_on: `${awaiting.length} finding${awaiting.length === 1 ? '' : 's'} awaiting approval`,
                dispatch: false,
                why: 'finding_approval'
            };
        }

        // An escalation the crew asked for (P7) with nothing else to run. §4.1's enum has no
        // "question" kind and L-37's condition 1 does not count a `blocked` task as work, so the
        // honest reading is `drained` with the question named: the loop is out of authorised work and
        // only the Author can give it more.
        //
        // Two row shapes reach that reading, and BOTH need to be found here. A crew escalation is
        // `blocked` (an Editor or Writer genuinely needs an answer). A phase-① SAMPLING escalation —
        // the cap row `work.ts:phase1SamplingEscalation` and its stall/ownership siblings — is opened
        // `open` on purpose: it asks the Author to change a setting or answer an option, it does not
        // block a crew job, and it must stay readable by `engine.ts:rearmSamplingWave` and
        // `work.ts:phase1SamplingEscalation` after the Author answers (reuse, drain-hold,
        // clear-on-pass), which a `blocked` row would break. Reading only `blocked` rows is what made
        // a story whose round ended on an open question claim `ready` — the Working pill in the
        // dashboard's TopBar — while nothing could be dispatched. So: the `blocked` row first, then an
        // OPEN row owned by the Author, and only when no run is live (`liveRuns` empty) so an answer
        // arriving between the candidate count and the sweep is never cut in front of.
        const question =
            store.tasks.list().find((task) => task.story_id === story.id && task.state === 'blocked') ??
            (input.dispatchable === 0 && liveRuns(store, story.id).length === 0
                ? store.tasks.list().find(
                      (task) =>
                          task.story_id === story.id &&
                          task.kind === 'escalation' &&
                          task.state === 'open' &&
                          (task.owner_role ?? '').trim().toLowerCase() === 'author',
                  )
                : undefined);

        if (question !== undefined) {
            return {
                status: 'pending',
                pending_kind: 'drained',
                status_reason: `the crew asked you: "${question.title}" (P7) · nothing else is dispatchable (L-37)`,
                blocked_on: 'the Author: an open question',
                dispatch: false,
                why: 'escalation'
            };
        }
    }

    // 5. Stalled — the only `pending` that means trouble (L-21, L-34). Checked after drained, always
    // (L-37a), and it stops dispatch even though jobs may remain: that is the point of the state.
    if (isStalled(story, input.goal, input.delta)) {
        return {
            status: 'pending',
            pending_kind: 'stalled',
            status_reason: stalledReason(store, story, input.levels, input.goal),
            blocked_on: `${input.delta.trend} past the Goal's loop-detection limits`,
            dispatch: false,
            why: 'stalled'
        };
    }

    // 6. Ready. The reason line still carries the Goal's render (G-2) so the row is never blank, and
    // `blocked_on` names what is failing while the crew is merely busy rather than waiting.
    const staleClean = loop.probe !== undefined && loop.probe.status === 'clean' && !pre.met;
    const repeats = repeatIdeas(store, story.id, story.phase);

    return {
        status: 'ready',
        pending_kind: 'none',
        status_reason: input.goalStatus.passed
            ? `phase ${story.phase}'s Goal passes (${input.goalStatus.progress}) — the crew keeps working until it drains (L-35, L-36)${
                  verificationOwed > 0
                      ? ` · ${verificationOwed} sourced Idea${verificationOwed === 1 ? '' : 's'} first need the Editor's verdict (D-27)`
                      : ''
              }`
            : input.goalStatus.progress,
        blocked_on:
            repeats.length > 0
                ? `${repeats.length} repeat Idea${repeats.length === 1 ? '' : 's'} (D-32)`
                : input.levels.failing.length > 0
                  ? `failing: ${[...new Set(input.levels.failing)].join(', ')}`
                  : '',
        dispatch: true,
        // A clean round whose preconditions broke no longer describes this Story, so it is dropped
        // here and a fresh full pass is required before `drained` may be claimed again (L-37).
        probe:
            staleClean && loop.probe !== undefined ? { ...loop.probe, status: 'idle', clean_since: null } : undefined,
        why: 'ready'
    };
}

/** L-29's reason: name the artifact awaiting the lock, and the empty tray that makes it lockable. */
function signoffReason(story: Story, input: DecisionInput): string {
    return `phase ${story.phase}'s Goal passes (${input.goalStatus.progress}) · ${lockLabel(story)} awaits your lock · the Ideas tray is empty · the crew is stopped until you act (L-29)`;
}

function lockLabel(story: Story): string {
    return story.phase === 'summary' ? 'the Summary' : story.phase === 'plotlines' ? 'the plotlines' : 'the chapters';
}

/** §4.1's two lock flags, read against the phase the Story is standing in (L-33). */
function phasesUnlockedOk(story: Story): boolean {
    if (story.phase === 'plotlines') return story.summary_locked;
    if (story.phase === 'chapters') return story.summary_locked && story.plotlines_locked;

    return true;
}

function earlierUnlockedPhase(story: Story): string {
    return story.summary_locked ? 'the plotlines (L-7)' : 'the Summary (L-7a)';
}

/** An already-locked phase needs no sign-off, so the Goal-passing branch must not re-offer one. */
function phaseIsLocked(story: Story): boolean {
    return story.phase === 'summary'
        ? story.summary_locked
        : story.phase === 'plotlines'
          ? story.plotlines_locked
          : false;
}

/**
 * L-37's reason sentence in §15 step 11's shape: what stopped ("no critical or major left") and what
 * is left to the Author ("16 findings awaiting you"). U-1c asks that a drained row read as FINISHED
 * rather than idle, which is why it names the threshold the crew ran out of instead of a queue length.
 */
function drainedReason(story: Story, left: Leftovers, completion: { met: boolean; unmet: string[] }): string {
    const parts = [
        `no ${dialPhrase(story)} left to work on (D-35b)`,
        'a fresh round of Critics and readers found nothing at that threshold (L-37)'
    ];

    if (left.awaiting > 0) parts.push(`${left.awaiting} finding${left.awaiting === 1 ? '' : 's'} awaiting you`);
    else if (left.findings > 0)
        parts.push(`${left.findings} finding${left.findings === 1 ? '' : 's'} below the threshold, left open`);

    // U-14's number, and it is the honest one: `leftovers` counts every row the accept will discard, so
    // an Idea the loop verified but the Author never picked is named here instead of vanishing from the
    // sentence the Author reads before clicking "Complete".
    if (left.ideas > 0)
        parts.push(
            `${left.ideas} undecided Idea${left.ideas === 1 ? '' : 's'} in the tray, which accepting discards (L-25b, U-14)`
        );

    parts.push(
        completion.met
            ? 'every hard criterion passes at every reached level — the loop proposes completion (L-25)'
            : `completion not proposed: ${completion.unmet.join(' · ')}`
    );

    return parts.join(' · ');
}

/** The finding states that count as "still open" for L-25b's discard sweep and U-14's count. */
export const DISCARDABLE_FINDING_STATES: Finding['state'][] = ['unconfirmed', 'confirmed', 'approved', 'disputed'];

/**
 * The Idea states L-25b discards on completion — everything not already absorbed by an artifact,
 * including the rows that only carry an Editor verdict (T-3b: `verified`/`refuted`/`unverifiable` are
 * still the Author's undecided tray). THE SINGLE SOURCE for the discard count: `engine.acceptCompletion`
 * moves exactly these rows, and `status.ts:leftovers` (the drained reason line and
 * `completion.leftovers`) and `api/projections.ts:completionPreview` (U-14's prompt) both count these,
 * so the number the Author is told is the number that gets thrown away.
 */
export const DISCARDABLE_IDEA_STATES: Idea['state'][] = ['proposed', 'verified', 'refuted', 'unverifiable'];

export { renderPairs };
