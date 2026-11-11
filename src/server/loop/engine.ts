// The loop engine: L-1's sweep, L-2's claim with lease, §6.3a's sign-off gates, and the verbs the
// dashboard and the MCP server call (`EngineApi` in ./types).
//
// Three rules shape everything below, and they are worth naming because the rest of the file is their
// consequence:
//
//   * **The store is the only memory (P1, L-3).** The engine keeps exactly one piece of state that is
//     not in the store: the promises of the runs this process started. On construction it adopts
//     nothing — every live run row it finds belongs to a dead process, so it abandons them (L-3's
//     "re-adopt or abandon") and releases the tasks they had claimed. A restarted engine then
//     re-derives its whole plan from the records, which is why the claim key, the level history, the
//     round counter, the fingerprint ledger and the drain probe all live on the Story row.
//   * **A decision and its consequences land in one commit (P1).** Every verb wraps its writes in a
//     single `store.commit`, and every read-modify-write takes the store's compare-and-set. So an
//     interrupted verb cannot leave a locked Summary with an un-empty tray (D-36), or a lock with the
//     phase unmoved (L-7), or a directive with tasks and no propagation (L-11a).
//   * **The sweep never blocks on a run (L-1, S-4a).** A run is dispatched and awaited in the
//     background; the next sweep sees the live run row and treats the job as claimed. `settle()` is
//     the only place that waits, and it exists for tests and for shutdown.
import {
    taskById,
    attemptsOf,
    authorAttr,
    closedFingerprints,
    competingRevisions,
    confirmedOpenFingerprints,
    dispatchableTasks,
    isLiveRun,
    lapsedRuns,
    last,
    liveRuns,
    liveRunsForTemplate,
    loopChapter,
    loopStory,
    pendingProposals,
    openTasks,
    requireStory,
    roleNameOf,
    runsForItem,
    storyChapters,
    storyFindings,
    storyPlotlines,
    storySummary,
    undecidedIdeas,
    wholePassClosed,
    wontfixTasks
} from './records';
import {
    DISCARDABLE_FINDING_STATES,
    DISCARDABLE_IDEA_STATES,
    decideStory,
    dialKeyOf,
    drainPreconditions,
    judgeProbe,
    probeIsLive,
    raiseCompletion,
    startProbe,
    type StoryDecision
} from './status';
import { generateWork } from './work';
import { carriedDelta, levelPairs, measureRound, recordRound, renderPairs } from './trend';
import { applyDirective, pendingDirectives } from './directives';
import {
    applySectionEdit,
    createFixTask,
    lockWrites,
    materialiseChapters,
    markChapterDone,
    markNeedsRecheck,
    dependents,
    pickFixTarget,
    popUndo,
    pushUndo,
    scrapPhasesAfter,
    phaseRank
} from './invalidation';
import {
    AUTHOR_APPROVED_BY,
    AUTO_APPROVED_BY,
    OPEN_FINDING_STATES,
    DEFAULT_GLOBAL_MAX_CONCURRENT,
    DEFAULT_LEASE_IDLE_MS,
    DEFAULT_SWEEP_INTERVAL_MS,
    TASK_KINDS,
    type AssignTemplatesResult,
    type ChapterCountResult,
    type CreateStoryInput,
    type DirectiveReport,
    type EngineApi,
    type GoalPatch,
    type LoopEngineDeps,
    type LoopStory,
    type ProbeState,
    type ResolvedEngineConfig,
    type StorySweepReport,
    type SweepReport,
    type WorkCandidate
} from './types';
import { BUILT_IN_TEMPLATES, DEFAULT_ASSIGNMENT, validateAssignment } from '../templates';
import { defaultGoal } from '../../shared/criteria';
import type { Chapter, Cost, Finding, Story, StoryPhase } from '../../shared/types';
import type { RunResult, WorkItem } from '../run/types';
import type { Store } from '../store';

/** §4.1's `phase` order, for the L-33 precondition checks and the D-3c reopen rule. */
const PHASE_ORDER: StoryPhase[] = ['summary', 'plotlines', 'chapters'];

const nextPhase = (phase: StoryPhase): StoryPhase | null => {
    const index = PHASE_ORDER.indexOf(phase);

    return index >= 0 && index < PHASE_ORDER.length - 1 ? PHASE_ORDER[index + 1] : null;
};

export class LoopEngine implements EngineApi {
    private readonly store: Store;
    private readonly executor: LoopEngineDeps['executor'];
    private readonly criteria: LoopEngineDeps['criteria'];
    private readonly digest: LoopEngineDeps['digest'];
    readonly config: ResolvedEngineConfig;

    /** L-1's switch. The engine is built stopped so a restart can recover before it moves (L-3). */
    private running = false;

    /** The only non-store state in the engine: the runs THIS process started, by Work Item id. */
    private readonly inflight = new Map<string, Promise<RunResult>>();

    /**
     * Closed-run count seen per Story at its last scan, so the next scan can tell whether the loop
     * actually finished work (L-15's round boundary (b)). Run rows are never deleted, so the number
     * only ever grows and the difference is exact — no clock involved, which matters because two
     * sweeps in a test can land in the same millisecond.
     */
    private readonly lastClosedRuns = new Map<string, number>();

    private timer: ReturnType<typeof setInterval> | undefined;

    /** Re-entrancy guard: L-1's sweep is idempotent, but two overlapping sweeps would still double-claim. */
    private sweeping: Promise<SweepReport> | undefined;

    constructor(deps: LoopEngineDeps) {
        this.store = deps.store;
        this.executor = deps.executor;
        this.criteria = deps.criteria;
        this.digest = deps.digest;
        this.config = {
            globalMaxConcurrent: deps.config?.globalMaxConcurrent ?? DEFAULT_GLOBAL_MAX_CONCURRENT,
            sweepIntervalMs: deps.config?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
            leaseIdleMs: deps.config?.leaseIdleMs ?? DEFAULT_LEASE_IDLE_MS,
            autoSweep: deps.config?.autoSweep ?? false
        };

        this.recover();
    }

    // -----------------------------------------------------------------------
    // L-1's switch
    // -----------------------------------------------------------------------

    /** L-1: start sweeping. Any live run rows a previous process left behind were already abandoned. */
    start(): void {
        this.running = true;

        if (!this.config.autoSweep) return;

        this.timer = setInterval(() => {
            void this.sweep();
        }, this.config.sweepIntervalMs);

        // A sweep timer must not keep the process alive (the store's debounced persist does the same).
        (this.timer as unknown as { unref?: () => void })?.unref?.();
    }

    /** L-1/L-2: stop scheduling. In-flight runs are left alone; the next sweep re-adopts or abandons them. */
    stop(): void {
        this.running = false;

        if (this.timer === undefined) return;

        clearInterval(this.timer);
        this.timer = undefined;
    }

    /** L-1: the same switch, named as the API names it. */
    setStopped(stopped: boolean): void {
        if (stopped) this.stop();
        else this.start();
    }

    /** True while the loop schedules work (L-1). */
    get started(): boolean {
        return this.running;
    }

    // -----------------------------------------------------------------------
    // Restart recovery (L-3, S-4a)
    // -----------------------------------------------------------------------

    /**
     * A run row that is live at construction has no owner in THIS process (the executor's controller
     * map is empty), so the crew that owned it is gone. L-3's choice is "re-adopt or abandon", and
     * abandoning is the honest half: the session died with the process, and S-3's teardown never ran.
     *
     * The tasks those runs had claimed go back to `open`, because L-2's claim has expired with them —
     * leaving them `claimed` is how a restarted loop quietly loses work, which is the failure W5's
     * acceptance row is written against ("kill the server mid-pass; on restart the loop resumes and no
     * job runs twice"). No job runs twice because the CLAIM key is derived from stored record ids and
     * generations, so the same job maps to the same key, and the fresh run's work is visible in the
     * records it wrote (a draft, a verdict) rather than in memory.
     */
    private recover(): void {
        const now = new Date().toISOString();

        for (const run of this.store.runs.list()) {
            if (!isLiveRun(run)) continue;

            this.store.runs.update(
                run.id,
                {
                    state: 'abandoned',
                    ended_at: now,
                    // S-3: the row says why it ended, and the reason is the restart, not the work.
                    end_reason: 'the engine restarted and this run had no owner in this process (L-3, S-4a)'
                },
                { run_ref: run.id, why: 'restart recovery abandoned an orphaned run (L-3)' },
                [{ id: run.id, rev: run.rev }]
            );
        }

        for (const task of this.store.tasks.list()) {
            if (task.state !== 'claimed') continue;

            this.store.tasks.update(
                task.id,
                { state: 'open' },
                { run_ref: null, why: 'the crew that claimed this task is gone; the queue released it (L-2, L-3)' },
                [{ id: task.id, rev: task.rev }]
            );
        }
    }

    // -----------------------------------------------------------------------
    // The sweep (L-1)
    // -----------------------------------------------------------------------

    /**
     * One sweep over every Story (L-1). Returns what was decided and started, per Story, so a test or a
     * dashboard can read the outcome without parsing logs.
     *
     * Two sweeps cannot run at once: the second joins the first's promise. L-2's idempotence would
     * survive an overlap, but the second sweep would compute its decisions against records the first is
     * mid-commit on, and its report would be noise.
     */
    sweep(): Promise<SweepReport> {
        if (this.sweeping !== undefined) return this.sweeping;

        this.sweeping = this.runSweep().finally(() => {
            this.sweeping = undefined;
        });

        return this.sweeping;
    }

    private async runSweep(): Promise<SweepReport> {
        const at = new Date().toISOString();

        // L-1's switch: a stopped loop does not scan, does not dispatch, and does not move any Story's
        // status — the records stay exactly as the Author left them (D-2b).
        if (!this.running) {
            return { at, stories: [], runs_started: 0, runs_finished: 0, leases_lapsed: [], skipped: true };
        }

        const finished = this.inflight.size;
        const leasesLapsed: string[] = [];
        const reports: StorySweepReport[] = [];

        // S-5: capacity is filled ACROSS Stories, so the candidate lists are collected first and the
        // dispatch pass is shared. Deciding per Story and dispatching per Story would let the first
        // Story in the list take every slot.
        const wantDispatch: { story: Story; candidate: WorkCandidate }[] = [];

        for (const story of this.store.stories.list()) {
            const report = await this.scanStory(story, at, leasesLapsed, wantDispatch);

            reports.push(report);
        }

        // The per-Story reports were written BEFORE the shared capacity fill (S-5), so their `started`
        // and `deferred` columns are only correct once the launch is known: a candidate that launched is
        // not deferred, and one that did not keeps the reason the scan recorded.
        const launched = await this.dispatch(wantDispatch);
        const startedKeys = new Set(launched.map((candidate) => candidate.key));

        for (const report of reports) {
            report.started = wantDispatch
                .filter((entry) => entry.story.id === report.story_id && startedKeys.has(entry.candidate.key))
                .map((entry) => entry.candidate.key);
            report.deferred = Object.fromEntries(
                Object.entries(report.deferred).filter(([key]) => !startedKeys.has(key))
            );
        }

        return {
            at,
            stories: reports,
            runs_started: launched.length,
            runs_finished: finished,
            leases_lapsed: leasesLapsed,
            skipped: false
        };
    }

    /** One Story's half of the sweep: L-1's steps 1–4 and 6, with the candidates queued for step 5. */
    private async scanStory(
        storyIn: Story,
        at: string,
        leasesLapsed: string[],
        wantDispatch: { story: Story; candidate: WorkCandidate }[]
    ): Promise<StorySweepReport> {
        const store = this.store;
        let story = requireStory(store, storyIn.id);

        const killed: string[] = [];

        // P8 / D-37: a Story the Author stopped or paused has no in-flight crew. "Immediate: no new
        // dispatch, in-flight runs killed" — the kill is enforced here rather than in a UI action so it
        // holds however the stop was written (the Author owns `status`, D-2a).
        if (story.status === 'stopped' || story.author_stop) {
            for (const run of liveRuns(store, story.id)) {
                this.executor.kill(run.id);
                killed.push(run.id);
            }
        }

        // S-4a / D-36: a run row nobody has touched for `leaseIdleMs` has a dead owner. The Work Item
        // returns to the queue (its claim key is unclaimed once the row closes) and the run is torn
        // down. No clock on the run itself — S-4a forbids a timeout, and a lease is the only honest way
        // to tell "slow" from "hung".
        for (const run of lapsedRuns(store, Date.parse(at), this.config.leaseIdleMs)) {
            if (run.story_id !== story.id) continue;

            this.executor.kill(run.id);
            killed.push(run.id);
            leasesLapsed.push(run.work_item_ref ?? run.id);

            if (!isLiveRun(store.runs.require(run.id))) continue;

            store.runs.update(
                run.id,
                {
                    state: 'abandoned',
                    ended_at: at,
                    end_reason: `the lease lapsed after ${this.config.leaseIdleMs}ms of silence (S-4a, D-36)`
                },
                { run_ref: run.id, why: 'lease expiry returned the Work Item to the queue (S-4a)' },
                [{ id: run.id, rev: store.runs.require(run.id).rev }]
            );
        }

        // L-1 step 2 (D-35): the dial approves on the spot, and the approval is what creates the fix
        // work (D-34). One commit per Story so a crash cannot leave an approved finding with no task.
        // `commit` resolves to void — the write IS the result — so what the transaction computed is
        // hoisted into a local and read back once the commit settles.
        let autoApproved: string[] = [];

        await store.commit('loop_auto_approve', () => {
            const ids: string[] = [];

            for (const finding of storyFindings(store, story.id)) {
                if (finding.state !== 'confirmed') continue;
                if (!story.auto_approve.includes(finding.cost)) continue;
                if (finding.approved_by !== null && finding.approved_by !== undefined) continue;

                store.findings.update(
                    finding.id,
                    { state: 'approved', approved_by: AUTO_APPROVED_BY },
                    { run_ref: null, why: `the Story's dial covers ${finding.cost}; approved on the spot (D-35)` },
                    [{ id: finding.id, rev: finding.rev }]
                );

                this.createWorkForFinding(finding, story);
                ids.push(finding.id);
            }

            autoApproved = ids;
        });

        // D-12/D-12a/D-14: the Digest is derived by the engine, and a stale Digest blocks a REVIEW but
        // not a fix — so the refresh happens here, before any candidate is generated, which is what
        // "refresh, then re-dispatch" means in code.
        if (this.digest.isStale(store, story)) {
            await store.commit('rebuild_digest', () => {
                this.digest.rebuild(store, story.id);
            });

            story = requireStory(store, story.id);
        }

        // L-11a: a confirmed finding that names more than one artifact invalidates BOTH sides in the
        // same commit. `markNeedsRecheck` is idempotent, so re-running it on every sweep is harmless
        // and keeps the propagation recoverable after a restart with no extra bookkeeping.
        let rechecks: string[] = [];

        await store.commit('loop_propagate', () => {
            const touched: string[] = [];

            for (const finding of storyFindings(store, story.id)) {
                if (finding.state !== 'confirmed' && finding.state !== 'approved') continue;

                const refs = [finding.target_ref, ...(finding.related_refs ?? [])];

                if (refs.length < 2) continue;

                touched.push(
                    ...markNeedsRecheck(
                        store,
                        story,
                        dependents(store, story, refs),
                        `${finding.id} is confirmed on ${refs.length} artifacts; both sides are re-judged (L-11a, D-33)`
                    )
                );
            }

            // L-11a's propagation is a SET: the same chapter can be named by several findings, and the
            // report says which chapters moved, not how many times.
            rechecks = [...new Set(touched)];
        });

        // L-10 + W4c: a chapter whose Goal passes and whose open work is gone is done. The dial is the
        // Author's standing acceptance (see `chapterIsDone`), which is what lets phase ③ finish with no
        // Author action at all (L-35, §15 step 3).
        story = await this.evaluateChapters(story);

        // D-19: a directive the loop never finished propagating (a crash between the create and the
        // report) is completed before anything else is decided, so the queue it owns is visible.
        const directives = pendingDirectives(store, story.id);

        if (directives.length > 0) {
            await store.commit('loop_directive_recovery', () => {
                for (const directive of directives) {
                    store.directives.update(
                        directive.id,
                        { state: 'done' },
                        { run_ref: null, why: `the loop finished propagating ${directive.id} (D-19)` },
                        [{ id: directive.id, rev: directive.rev }]
                    );
                }
            });
        }

        // The drain probe's round: when its two runs have both closed, the round is judged and stored
        // BEFORE the decision, because the decision is what asks the question it answers (L-37.3).
        const probeRound = await this.judgeProbeRound(story, at);

        story = probeRound.story;

        // L-1 steps 1 and 6: the levels, the trend, and the round. The measurement runs before the
        // decision because L-37a's precedence requires the stall to be computable, and the stall needs
        // the trend that this step produces.
        const goal = this.criteria.resolveGoal(store, story);
        const levels = this.criteria.levelStatus(store, story);
        const goalStatus = this.criteria.phaseGoalStatus(store, story);
        const pairs = levelPairs(levels);

        // L-15's ROUND BOUNDARY, in two cases:
        //
        //  (a) the drain probe's round closes. That is the one place the loop has looked at the whole
        //      book at once (L-37.3), so it is the boundary L-37's "fresh round" and L-15's "level
        //      history, retained per round" are written about;
        //  (b) the loop FINISHED work this sweep (a run closed), the drain preconditions do NOT hold,
        //      and the loop has already looked at the whole book once. This is L-22's "failed for 11
        //      rounds" case: a contradiction the crew keeps working around never lets the preconditions
        //      hold, so if rounds were only counted at probe rounds the counter would never move and the
        //      Story would burn runs forever instead of going `stalled` — the one thing §6.8 exists to
        //      prevent. The whole-pass condition is what keeps that honest: before the first pass there
        //      is no baseline for "unchanged", and flat rounds counted in that window are exactly the
        //      L-37a inversion (a Story on its way to being drained read as stuck).
        //
        // While the preconditions DO hold and no probe has run, no round is counted either: the Story is
        // one clean probe round away from `drained`. And a sweep that closes no run is not a round — a
        // four-hour run in flight changes nothing between sweeps, and S-4a's lease, not a clock, owns
        // that case.
        const closedCount = closedRunCount(store, story.id);
        const closedSince = closedCount - (this.lastClosedRuns.get(story.id) ?? 0);

        this.lastClosedRuns.set(story.id, closedCount);

        const pre = drainPreconditions(store, story);
        const measuredRound = probeRound.judged || (closedSince > 0 && !pre.met && wholePassClosed(store, story.id));
        const delta = measuredRound
            ? measureRound(
                  story,
                  pairs,
                  closedFingerprints(store, story.id),
                  confirmedOpenFingerprints(store, story.id)
              )
            : carriedDelta(story);

        if (measuredRound) {
            // L-15: the level history is retained PER ROUND, and this is the only place it is written.
            recordRound(store, story, {
                levels: pairs,
                closedFingerprints: closedFingerprints(store, story.id),
                phase: story.phase,
                at,
                delta,
                closedRunCount: closedCount
            });
            story = requireStory(store, story.id);
        }

        // L-1 step 4 computes the candidates BEFORE the decision: L-36's Author waits only begin "when
        // nothing else is dispatchable", so the decision needs the candidate list, not the other way
        // round. The claim check happens at dispatch, so a non-`ready` Story's list is only a count.
        const candidates =
            story.status === 'ready' || story.status === 'pending'
                ? generateWork(store, story, { at, phase: story.phase })
                : [];

        const decision = decideStory(
            store,
            story,
            { goal, goalStatus, levels, levelPairs: pairs, delta, dispatchable: candidates.length },
            { at }
        );

        story = await this.applyDecision(story, decision, at);

        if (decision.dispatch) wantDispatch.push(...candidates.map((candidate) => ({ story, candidate })));

        const wanted = candidates.map((candidate) => candidate.key);

        return {
            story_id: story.id,
            phase: story.phase,
            status: story.status,
            pending_kind: story.pending_kind,
            status_reason: decision.status_reason,
            consistency: renderPairs(pairs),
            goal: goalStatus,
            trend: delta.trend,
            // The probe's state after this sweep: `clean` means the round is over and nothing at the
            // dial threshold turned up (L-37.3); `running` means the round is in flight.
            probe: loopStory(story).probe?.status ?? 'idle',
            completion_proposed: decision.completion !== undefined,
            wanted: candidates,
            started: [],
            deferred: Object.fromEntries(
                wanted.map((key) => [
                    key,
                    decision.dispatch ? 'queued for the capacity fill' : `not dispatched: ${decision.why}`
                ])
            ),
            auto_approved: autoApproved,
            killed_runs: killed,
            rechecks
        };
    }

    /**
     * L-10, made concrete. A chapter is done when its Goal passes AND nothing is open at or above the
     * dial's threshold touching it AND no draft of it is still competing (L-20/D-23: an unchosen draft
     * means the unit is not finished with, whatever its verdicts say).
     *
     * The dial-as-acceptance reading is the reconciliation of two rules that pull opposite ways: L-10
     * wants the Author's accept, and L-35/§15 step 3 say phase ③ finishes "with no Author action at
     * all". The dial is the Author's standing answer about which costs they care about (D-35, D-35b), so
     * a chapter whose remaining findings are all below it is a chapter the Author has already said they
     * do not want worked. A `disputed` finding never holds a chapter open either (D-33: the Editor
     * already said it is not a defect).
     */
    private async evaluateChapters(storyIn: Story): Promise<Story> {
        // The fresh row is hoisted out of the transaction because `commit` resolves to void.
        let story = storyIn;

        await this.store.commit('loop_chapter_state', () => {
            story = requireStory(this.store, storyIn.id);
            const open = this.store.findings
                .list()
                .filter((finding) => finding.story_id === story.id && OPEN_FINDING_STATES.includes(finding.state));
            const tasks = dispatchableTasks(this.store, story.id);

            for (const chapter of storyChapters(this.store, story.id)) {
                if (chapter.state === 'outlined' || chapter.sections.length === 0) continue;

                const status = this.criteria.chapterGoalStatus(this.store, story, chapter.id);
                const touches = (finding: Finding) =>
                    finding.target_ref === chapter.id || (finding.related_refs ?? []).includes(chapter.id);

                // A sub-threshold finding holds a chapter open only if the dial does not cover it (the
                // Author has not pre-accepted it); the dial covering it means work is INCOMING, not that
                // the chapter is fine, so an open above-threshold finding also blocks `done`.
                const blocking = open.filter(
                    (finding) =>
                        touches(finding) && (story.auto_approve.includes(finding.cost) || finding.state === 'confirmed')
                );
                const blockingTasks = tasks.filter(
                    (task) => task.detail?.includes(chapter.id) === true || task.title.includes(chapter.id) === true
                );

                // T-5's discipline: a write the record already says is a write nobody asked for, and the
                // chapter's `rev` moving every sweep would make "did anything change?" unanswerable.
                if (chapter.last_score !== status.progress) {
                    this.store.chapters.update(
                        chapter.id,
                        { last_score: status.progress },
                        { run_ref: null, why: `the chapter's rendered score (G-1: ${status.progress})` },
                        [{ id: chapter.id, rev: chapter.rev }]
                    );
                }

                if (chapter.state === 'done') continue;

                if (
                    status.passed &&
                    blocking.length === 0 &&
                    blockingTasks.length === 0 &&
                    competingRevisions(this.store, story.id, chapter.id).length === 0
                ) {
                    // The row is re-read because the score write above may have moved its `rev` (T-4).
                    markChapterDone(
                        this.store,
                        this.store.chapters.require(chapter.id),
                        `chapter ${chapter.order}'s Goal passes with nothing at or above the dial open on it (L-10, L-35)`
                    );
                }
            }
        });

        return story;
    }

    /**
     * L-37's condition 3, judged once the round's two runs are closed.
     *
     * A round is over when neither probe job has a live run (S-3's teardown closes the row, so "closed
     * run rows exist and none is live" is the durable signal — no in-memory latch, no clock).
     */
    private async judgeProbeRound(storyIn: Story, at: string): Promise<{ story: Story; judged: boolean }> {
        const store = this.store;
        const story = requireStory(store, storyIn.id);
        const probe = loopStory(story).probe;

        if (
            probe === undefined ||
            probe.status !== 'running' ||
            probe.reader_item_id === null ||
            probe.checker_item_id === null
        ) {
            return { story, judged: false };
        }

        const stillRunning = [probe.reader_item_id, probe.checker_item_id].some((id) =>
            runsForItem(store, id).some(isLiveRun)
        );

        if (stillRunning) return { story, judged: false };

        const judged = judgeProbe(store, story, probe, at);

        await store.commit('loop_probe_round', () => {
            store.stories.update(
                story.id,
                { probe: judged },
                { run_ref: null, why: `drain probe round judged ${judged.status} (L-37 condition 3)` },
                [{ id: story.id, rev: story.rev }]
            );
        });

        // The round closing is the pass boundary L-15 measures at, so the caller needs the fact and not
        // just the row.
        return { story: requireStory(store, story.id), judged: true };
    }

    /** Writes one decision as one commit: status, kind, reason, what it is blocked on, probe, completion. */
    private async applyDecision(storyIn: Story, decision: StoryDecision, at: string): Promise<Story> {
        await this.store.commit('loop_decision', () => {
            const story = requireStory(this.store, storyIn.id);

            this.store.stories.update(
                story.id,
                {
                    status: decision.status,
                    pending_kind: decision.pending_kind,
                    status_reason: decision.status_reason,
                    blocked_on: decision.blocked_on,
                    // §4.1's one-line human summary the loop maintains, in the shape the spec's example
                    // gives ("7 chapters · act 2 has a hole · 3 setups unpaid").
                    progress: this.progressLine(story),
                    ...(decision.probe === undefined ? {} : { probe: decision.probe })
                },
                { run_ref: null, why: `sweep decision: ${decision.why} (L-1 step 3, D-2a)` },
                [{ id: story.id, rev: story.rev }]
            );

            // L-25: the proposal is the loop TELLING the Author the book is finished by its own
            // standards. Nothing closes until the Author accepts (L-26), and U-14's prompt needs the
            // counts, which the proposal carries.
            if (decision.completion !== undefined) {
                const fresh = requireStory(this.store, story.id);

                this.store.stories.update(
                    fresh.id,
                    { completion: decision.completion },
                    {
                        run_ref: null,
                        why: `the loop proposes completion (L-25); ${decision.completion.leftovers.findings} findings and ${decision.completion.leftovers.ideas} Ideas will be discarded (L-25b)`
                    },
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }
        });

        return requireStory(this.store, storyIn.id);
    }

    /** §4.1's `progress` sentence: chapter count, done count, the hole the criteria engine named. */
    private progressLine(story: Story): string {
        const chapters = storyChapters(this.store, story.id);
        const done = chapters.filter((chapter) => chapter.state === 'done').length;
        const unpaid = this.store.ledger
            .list()
            .filter((entry) => entry.story_id === story.id && entry.kind === 'setup' && entry.status === 'open').length;
        const open = storyFindings(this.store, story.id).filter((finding) =>
            OPEN_FINDING_STATES.includes(finding.state)
        ).length;
        const failing = this.criteria.levelStatus(this.store, story).failing;

        const parts = [`${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`, `${done} done`];

        if (unpaid > 0) parts.push(`${unpaid} setup${unpaid === 1 ? '' : 's'} unpaid`);
        if (open > 0) parts.push(`${open} finding${open === 1 ? '' : 's'} open`);
        if (failing.length > 0) parts.push(`failing: ${[...new Set(failing)].join(', ')}`);

        return parts.join(' · ');
    }

    // -----------------------------------------------------------------------
    // L-1 step 5: the capacity fill (S-5)
    // -----------------------------------------------------------------------

    /**
     * Fills capacity across every Story until the global ceiling is full (S-5), respecting each
     * template's own per-Story cap (D-38a) and never claiming a job that already has a live run (L-2).
     *
     * The order is the spec's urgency (see `generateWork`): an Editor's choice, then a verification,
     * then unblocked fix work, then drafts, then the whole-Story pass, then the drain probe. Ties break
     * on the candidate's within-class `rank` and then the claim key, so the same store state always
     * produces the same dispatch order — which is what makes a restarted engine's first sweep predictable
     * (L-3). The rank exists because the priority CLASS does not always decide: three competing drafts
     * are all "judge a draft" work, and only the rotation in `generateWork` says which one is owed next.
     */
    private async dispatch(want: { story: Story; candidate: WorkCandidate }[]): Promise<WorkCandidate[]> {
        const store = this.store;
        const sorted = [...want].sort(
            (left, right) =>
                left.candidate.priority - right.candidate.priority ||
                (left.candidate.rank ?? 0) - (right.candidate.rank ?? 0) ||
                left.candidate.key.localeCompare(right.candidate.key)
        );
        const launched: WorkCandidate[] = [];

        let used = liveRuns(store).length;

        for (const entry of sorted) {
            if (used >= this.config.globalMaxConcurrent) break;
            if (isClaimedHere(store, entry.candidate.key) || this.inflight.has(entry.candidate.key)) continue;

            const perTemplate = liveRunsForTemplate(store, entry.story.id, entry.candidate.item.templateRef);

            if (perTemplate >= entry.candidate.max_concurrent) continue;

            // L-5: two loops must not edit the same artifact at once. Any live job already naming this
            // unit holds it, so the second one waits for the lease rather than racing the compare-and-swap.
            const unitRef = entry.candidate.item.unit?.ref;

            if (unitRef !== undefined && unitRef.length > 0 && unitRef !== entry.story.id) {
                const busy = liveRuns(store, entry.story.id).some((run) => (run.work_item_ref ?? '').includes(unitRef));

                if (busy) continue;
            }

            launched.push(entry.candidate);
            used += 1;
        }

        if (launched.length === 0) return launched;

        // The unit-state transitions land BEFORE the runs start, so nothing reads a Story mid-dispatch
        // and sees a job in flight against an artifact whose state has not moved (L-8's `in_pass`,
        // §4.4's `in_review`). One commit for the whole batch: the dispatch either happened or it did.
        await store.commit('loop_dispatch', () => {
            for (const candidate of launched) this.noteDispatch(candidate);
        });

        for (const candidate of launched) {
            // S-3's teardown already closed the run row, so what is left to do is the loop's half of the
            // handshake: release the claim by consuming the queue entry the job was built from. Chained
            // into the stored promise, so `settle()` waits for the bookkeeping too and a test that calls
            // `sweep(); await settle()` never sees a half-applied result.
            const settled = this.executor.execute(candidate.item).then(async (result) => {
                await this.settleJob(candidate.item, result);

                return result;
            });

            this.inflight.set(candidate.item.id, settled);

            void settled.finally(() => {
                this.inflight.delete(candidate.item.id);
            });
        }

        // The probe's job ids are recorded on the round so a later sweep can tell when the round is over
        // (L-37.3). Written after launch, because a launch that failed must not mark a round running.
        await this.recordProbeLaunch(launched);

        return launched;
    }

    /** The per-unit state a dispatch implies (L-8's all-chapters-together bookkeeping). */
    private noteDispatch(candidate: WorkCandidate): void {
        const store = this.store;
        const unit = candidate.item.unit;

        if (unit === undefined || unit.kind !== 'chapter') return;

        const chapter = store.chapters.get(unit.ref);

        if (chapter === undefined) return;

        if (candidate.item.kind === 'write_unit') {
            store.chapters.update(
                chapter.id,
                { state: 'in_pass', round: chapter.round + 1 },
                {
                    run_ref: null,
                    why: `a Writer is on chapter ${chapter.order} (L-8: the whole set is in flight together)`
                },
                [{ id: chapter.id, rev: chapter.rev }]
            );

            return;
        }

        if (candidate.item.kind === 'check_unit' || candidate.item.kind === 'whole_story_check') {
            store.chapters.update(
                chapter.id,
                { state: 'in_review' },
                { run_ref: null, why: `a checker is on chapter ${chapter.order} (§6.2's review crew)` },
                [{ id: chapter.id, rev: chapter.rev }]
            );
        }
    }

    /**
     * The loop's half of a finished run: the queue entry the job was built from is consumed.
     *
     * WHY THE ENGINE DOES THIS AND NOT THE AGENT: §8's catalogue (and the W2 double in `run/mock.ts`)
     * gives a Writer `editChapter`, `editSummary` and `markChapterDone`, and gives it no way to close the
     * task it was dispatched for. If the loop waited for the run to close its own queue row, a claimed
     * task would stay `claimed` forever and the Story would never drain. D-11 says the QUEUE holds the
     * plan, so the loop that read the plan is the thing that consumes it when the harness is torn down
     * (S-3); §4.7's `attempts` is L-15's progress counter and lands in the same commit.
     *
     * The three cases:
     *   * `completed` — the named tasks are `done`: the job that was built from them ran to its end.
     *   * `killed` / `failed` — the task goes back to `open` with `attempts` up by one, so the next sweep
     *     re-dispatches it (L-2's claim has expired with the run) and L-22's "what the crews tried"
     *     counts the attempt.
     *   * a fix job's findings — a `write_unit` job that NAMED findings (`wi_fix_*`) is the D-34 fix pass,
     *     and completing it is what makes the defect `fixed`. The fingerprint ledger then reads the
     *     closure (L-16a); if the defect is actually still there, the next checker round re-files the same
     *     fingerprint and L-16a reads that as a regression rather than trusting this write.
     *
     * A `verify_findings` job is deliberately absent from the finding branch: there the Editor's
     * `verifyFinding` call already moved the state (D-33), and the engine closing it would erase the
     * difference between "checked" and "fixed".
     */
    private async settleJob(item: WorkItem, result: RunResult): Promise<void> {
        const store = this.store;
        const closed = result.ended === 'completed';
        const isFixPass = item.kind === 'write_unit' && (item.findingRefs ?? []).length > 0;

        await store.commit('loop_job_result', () => {
            for (const ref of item.taskRefs ?? []) {
                const task = store.tasks.get(ref);

                if (task === undefined) continue;

                store.tasks.update(
                    task.id,
                    { state: closed ? 'done' : 'open', attempts: (task.attempts ?? 0) + 1 },
                    {
                        run_ref: item.id,
                        why: closed
                            ? `run ${item.id} finished the work this task named; the queue consumed it (D-11, L-2)`
                            : `run ${item.id} ended ${result.ended}; the task is open again with one more attempt (L-15, L-3)`
                    },
                    [{ id: task.id, rev: task.rev }]
                );
            }

            if (!isFixPass) return;

            for (const ref of item.findingRefs ?? []) {
                const finding = store.findings.get(ref);

                if (finding === undefined || finding.state === 'fixed' || finding.state === 'discarded') continue;

                if (!closed) continue;

                store.findings.update(
                    finding.id,
                    { state: 'fixed' },
                    {
                        run_ref: item.id,
                        why: `the fix pass run ${item.id} closed it (D-34); a re-raised fingerprint reads as a regression (L-16a)`
                    },
                    [{ id: finding.id, rev: finding.rev }]
                );
            }
        });
    }

    /**
     * Stores the probe's Work Item ids on the round, so its completion is a store question.
     *
     * Only the jobs that ACTUALLY launched are recorded. Capacity 1 means the Reader and the Checker
     * launch on different sweeps, and stamping both ids on the first launch made the round look "over"
     * the moment the Checker closed — the Reader round (L-37 condition 3, D-30's fresh eyes) never ran
     * and the Story reported `drained` on half the evidence.
     *
     * A round already in flight keeps its own journal watermark and dial: the watermark is what decides
     * which findings belong to the round (D-14), and restarting it when the second job launches would
     * move the goalposts past the first job's findings.
     */
    private async recordProbeLaunch(launched: WorkCandidate[]): Promise<void> {
        const probes = launched.filter((candidate) => candidate.key.startsWith('wi_probe_'));

        if (probes.length === 0) return;

        const storyId = probes[0].item.storyId;

        await this.store.commit('loop_probe_launch', () => {
            const story = requireStory(this.store, storyId);
            const current = loopStory(story).probe;
            const running = current !== undefined && current.status === 'running' && current.phase === story.phase;
            // The launched keys ARE the round's ids: each half keeps whichever of them actually ran,
            // and `judgeProbeRound` waits on both (L-37.3). Recomputing them from a counter here would
            // read the count AFTER these runs landed and name a job that was never dispatched.
            const reader = probes.find((candidate) => candidate.key.startsWith('wi_probe_reader_'))?.key;
            const checker = probes.find((candidate) => candidate.key.startsWith('wi_probe_checker_'))?.key;
            const probe: ProbeState = {
                ...(running ? current : startProbe(this.store, story, story.phase, new Date().toISOString())),
                ...(reader === undefined ? {} : { reader_item_id: reader }),
                ...(checker === undefined ? {} : { checker_item_id: checker })
            };

            this.store.stories.update(
                story.id,
                { probe },
                {
                    run_ref: null,
                    why: `drain probe round dispatched: ${probes.map((candidate) => candidate.key).join(' + ')} (L-37 condition 3)`
                },
                [{ id: story.id, rev: story.rev }]
            );
        });
    }

    /** Awaits every run this process started; the only place the engine waits, for tests and shutdown. */
    async settle(): Promise<void> {
        let guard = 0;

        while (this.inflight.size > 0) {
            if (guard++ > 1000)
                throw new Error('settle() did not converge — a run is dispatching faster than it closes');

            await Promise.allSettled([...this.inflight.values()]);
        }
    }

    // -----------------------------------------------------------------------
    // The verbs (`EngineApi`)
    // -----------------------------------------------------------------------

    /** §15 step 0: the Seed, the declared count, the assignment, and phase `summary`. */
    async createStory(input: CreateStoryInput = {}): Promise<{ story_id: string }> {
        const store = this.store;
        const idea =
            input.idea ??
            'A cartographer returns to the valley she mapped as a girl and finds it redrawn by a reservoir.';
        const refs = input.template_refs ?? DEFAULT_ASSIGNMENT;

        let createdStory: Story | undefined;

        await store.commit('create_story', () => {
            // The crews have to be ROWS before the executor can resolve them (D-17a). Seeding is
            // idempotent by slug, so an api layer that seeds the catalogue first is unaffected.
            const catalogue = BUILT_IN_TEMPLATES;

            for (const template of catalogue) {
                if (store.templates.list().some((row) => row.name === template.name)) continue;

                store.templates.create(
                    {
                        name: template.name,
                        title: template.title,
                        description: template.description,
                        roles: template.roles,
                        serves_phase: template.serves_phase,
                        done_definition: template.done_definition,
                        selection_rules: template.selection_rules,
                        attempts: template.attempts,
                        delegation: template.delegation,
                        escalation_rule: template.escalation_rule,
                        next_phase: template.next_phase,
                        max_concurrent: template.max_concurrent,
                        builtin: true,
                        editable: false
                    },
                    { run_ref: null, why: `the built-in crew ${template.name} is available to Stories (D-17)` }
                );
            }

            const created = store.stories.create(
                {
                    title: input.title ?? firstLine(idea),
                    phase: 'summary',
                    idea,
                    summary_locked: false,
                    plotlines_locked: false,
                    pending_kind: 'none',
                    status: 'ready',
                    status_reason: 'phase summary is open: the Seed is being expanded (L-29 stops it at the lock)',
                    trend: 'unknown',
                    auto_approve: input.auto_approve ?? (['critical', 'major'] as Cost[]),
                    author_stop: false,
                    digest_rev: 0,
                    // D-17b: write permission comes from a template ASSIGNED to the Story.
                    template_refs: refs,
                    chapter_deps: {}
                },
                authorAttr(`the Author opened a Story from a Seed (D-2a: it starts ready)`)
            );

            store.summaries.create(
                {
                    story_id: created.id,
                    // D-3b: the count is AUTHOR truth — declared here, never chosen by a Writer.
                    chapter_count: input.chapter_count ?? 1,
                    locked: false
                },
                authorAttr(`the Author declared chapter_count for ${created.id} (D-3b)`)
            );

            // G-4: every crew is briefed against the SAME target. A Story with no Goal row is a Story
            // whose brief says "(no Goal row for this Story)" and whose phase Goal is answered from the
            // built-in roster with no thresholds, so the loop always creates one; the Author's patch (G-1)
            // lands on top of the built-in Goal rather than replacing it.
            const goal = defaultGoal(created.id);

            const createdGoal = store.goals.create(
                {
                    story_id: created.id,
                    title: input.goal?.title ?? goal.title,
                    threshold_soft: input.goal?.threshold_soft ?? goal.threshold_soft,
                    criteria: input.goal?.criteria ?? goal.criteria,
                    flat_rounds: input.goal?.flat_rounds ?? goal.flat_rounds,
                    regress_tolerance: input.goal?.regress_tolerance ?? goal.regress_tolerance
                },
                authorAttr(`the Author set the Goal for ${created.id} (G-1, G-4: one target, every crew)`)
            );

            // §4.1's `goal_ref` names the row from the Story, so a reader (the brief builder, U-3, the
            // api layer) does not have to scan the collection by `story_id` to find the Goal in force.
            store.stories.update(
                created.id,
                { goal_ref: createdGoal.id },
                authorAttr('the Story measures against the Goal it was created with (G-4)'),
                [{ id: created.id, rev: created.rev }]
            );

            createdStory = created;
        });

        if (createdStory === undefined) throw new Error('create_story committed without creating a Story row');

        return { story_id: createdStory.id };
    }

    /**
     * D-37's **Pause & edit**, in one move: write the Story's own cord (§4.1's `author_stop`, which is
     * P8's mechanism) and kill the crew that is in flight. The kill is part of the verb rather than left
     * to the next sweep because the prose pane is only honest once no run can still race the Author's
     * write: T-4's compare-and-swap makes a lost write DETECTABLE, not resolved, and D-37 exists exactly
     * to keep the Author from losing that race.
     *
     * It is the Story's cord and not `stop()`, because pausing one book must not idle the loop — the
     * other Stories on the shelf keep their crew (P8, D-37b).
     */
    async pauseStory(storyId: string): Promise<void> {
        await this.store.commit('pause_story', () => {
            const story = requireStory(this.store, storyId);

            this.store.stories.update(
                story.id,
                {
                    status: 'stopped',
                    author_stop: true,
                    pending_kind: 'none',
                    status_reason: 'the Author paused to edit the prose (D-37)',
                    blocked_on: 'the Author'
                },
                authorAttr('the Author paused the Story so they could edit it (D-37, P8)'),
                [{ id: story.id, rev: story.rev }]
            );
        });

        // The cord is written first: a run closed before the row says `stopped` would read as a crew that
        // finished on its own, and the journal would tell the wrong story about why the pass ended.
        for (const run of liveRuns(this.store, storyId)) this.executor.kill(run.id);

        await this.settle();
    }

    /**
     * D-2a/D-37b: the Author's clear. Nothing about a paused Story is special on resume — the crew picks
     * the book up where it stands, which is the same thing that happens after any other pause.
     *
     * D-37a's re-derivation is done here rather than left to the next sweep so the Resume action can
     * report honestly what it costs: the Digest comes from the Author's edit, and the dependents of an
     * edited chapter were already marked `needs_recheck` when the edit landed (see `applyAuthorEdit`).
     */
    async resumeStory(storyId: string): Promise<void> {
        await this.store.commit('resume_story', () => {
            const story = requireStory(this.store, storyId);

            this.store.stories.update(
                story.id,
                {
                    status: 'ready',
                    author_stop: false,
                    pending_kind: 'none',
                    status_reason: '',
                    blocked_on: ''
                },
                authorAttr('the Author resumed the Story (D-2a, D-37b: no special case for a pause)'),
                [{ id: story.id, rev: story.rev }]
            );

            // D-12a: the Digest is re-derived from the records as they now read, which after an Author
            // edit means the edit is in it (D-37a's first named consequence).
            this.digest.rebuild(this.store, story.id);
        });
    }

    /** U-1b: empty the queue. The findings behind it stay where the Author left them (L-36). */
    async clearPending(storyId: string): Promise<void> {
        await this.store.commit('clear_pending', () => {
            wontfixTasks(this.store, storyId);
        });
    }

    /**
     * L-6a/L-7/L-7a: the sign-off, in one commit — the flag, its mirrors, the emptied tray (D-36), and
     * the phase movement. L-7a's precondition is enforced here because the lock is the gate the rule
     * protects: an artifact cannot be signed off with unjudged alternatives still in the tray.
     */
    async lockPhase(storyId: string, phase: StoryPhase): Promise<void> {
        const store = this.store;

        await store.commit('lock_phase', () => {
            const story = requireStory(store, storyId);

            if (phaseRank(phase) > phaseRank(story.phase)) {
                throw new Error(
                    `cannot lock ${phase}: the Story is in phase ${story.phase} (L-33: a phase is locked by the work that reaches it)`
                );
            }

            if (phase === 'plotlines' && !story.summary_locked) {
                throw new Error(
                    `cannot lock the plotlines while the Summary is unlocked (L-33: phase ${phase} may not be entered)`
                );
            }

            // L-7a / U-15: the gate is the TRAY, and the tray is every Idea of this phase the Author has
            // not decided (records.ts:undecidedIdeas) — `verified`, `refuted` and `unverifiable` rows are
            // still the Author's call (T-3b), so an Editor verdict does not let the lock go over them.
            const tray = undecidedIdeas(store, storyId, phase);

            if (tray.length > 0) {
                throw new Error(
                    `cannot lock ${phase}: ${tray.length} Idea${tray.length === 1 ? '' : 's'} still in the tray — each must be selected, discarded, or deferred first (L-7a, D-29)`
                );
            }

            const at = new Date().toISOString();
            const result = lockWrites(store, story, phase, at);

            if (result.next_phase !== null) {
                const fresh = requireStory(store, storyId);

                // D-2a's `pending (phase_signoff) → ready`: the lock both signs the phase off and hands
                // the next one its work, in the same action the Author took.
                store.stories.update(
                    fresh.id,
                    {
                        phase: result.next_phase,
                        status: 'ready',
                        pending_kind: 'none',
                        status_reason: `phase ${phase} locked by the Author at ${at}; phase ${result.next_phase} is open (L-7)`,
                        blocked_on: '',
                        // The drain round is per phase, so a lock retires it (L-37).
                        probe: undefined
                    },
                    authorAttr(`phase ${phase} signed off; phase ${result.next_phase} opened (L-7, L-29)`),
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }
        });
    }

    /**
     * L-31/D-25: the only way a lock opens. Unlocks phase N, scraps every later artifact, and resets the
     * phase with no memory of the scrapped pass — while the verdicts, findings and `selection_note`s of
     * that pass stay readable as provenance (P11).
     */
    async backtrack(storyId: string, phase: StoryPhase): Promise<void> {
        await this.store.commit('backtrack_to_phase', () => {
            const story = requireStory(this.store, storyId);
            const why = `the Author backtracked to ${phase}; the later phases' artifacts are scrapped (L-31, D-25)`;

            const counts = scrapPhasesAfter(this.store, story, phase, why);

            const patch: Record<string, unknown> = {
                phase,
                status: 'ready',
                pending_kind: 'none',
                status_reason: `backtracked to ${phase}: ${counts.chapters} chapters and ${counts.plotlines} plotlines scrapped, verdicts kept as provenance (D-25)`,
                blocked_on: '',
                trend: 'unknown',
                flat_streak: 0,
                level_history: [],
                probe: undefined,
                completion: undefined
            };

            // L-31 unlocks exactly the phase being reopened, and the artifacts above it are gone, so
            // their locks go with them (a locked artifact with no rows behind it is a lock on nothing).
            if (phase === 'summary') {
                patch.summary_locked = false;
                patch.plotlines_locked = false;

                const summary = storySummary(this.store, storyId);

                if (summary !== undefined) {
                    this.store.summaries.update(
                        summary.id,
                        { locked: false },
                        authorAttr('a backtrack to summary reopens the Summary draft (D-25)'),
                        [{ id: summary.id, rev: summary.rev }]
                    );
                }
            } else if (phase === 'plotlines') {
                patch.plotlines_locked = false;
            }

            this.store.stories.update(story.id, patch as never, authorAttr(why), [{ id: story.id, rev: story.rev }]);
        });
    }

    /**
     * D-3c: change the declared count.
     *
     * Grow: added chapters enter the queue as `outlined`. Shrink: the surplus chapters are DELETED, and
     * because that is the destructive direction the caller must confirm first — the first call reports
     * what would go rather than doing it, which is the same confirmation discipline L-32 demands of a
     * backtrack.
     *
     * When the plotlines are already locked, ANY count change reopens phase ② by backtrack (D-3c), so
     * the same confirmation covers the scrapped chapters: chapters written against a count the Author
     * has just changed are the "chapters carried forward against a rejected plotline" P2 warns about.
     */
    async changeChapterCount(
        storyId: string,
        count: number,
        opts: { confirm?: boolean } = {}
    ): Promise<ChapterCountResult> {
        const store = this.store;
        const story = requireStory(store, storyId);
        const current = store.summaries.list().find((row) => row.story_id === storyId)?.chapter_count ?? 0;
        const chapters = storyChapters(store, storyId);

        if (count === current) return {};

        const removes = count < current;
        const mustConfirm = removes || story.plotlines_locked;

        if (mustConfirm && opts.confirm !== true) {
            const doomed = removes
                ? chapters.slice(count).map((chapter) => chapter.id)
                : chapters.map((chapter) => chapter.id);

            return { pending_confirm: true, removed: doomed };
        }

        const result: ChapterCountResult = {};

        await store.commit('change_chapter_count', () => {
            const fresh = requireStory(store, storyId);
            const summary = store.summaries.list().find((row) => row.story_id === storyId);

            if (summary !== undefined) {
                store.summaries.update(
                    summary.id,
                    { chapter_count: count },
                    authorAttr(`the Author changed chapter_count to ${count} (D-3b, D-3c)`),
                    [{ id: summary.id, rev: summary.rev }]
                );
            }

            if (removes) {
                const doomed = storyChapters(store, storyId).slice(count);

                for (const chapter of doomed) {
                    for (const revision of store.revisions.list().filter((row) => row.unit_ref === chapter.id)) {
                        store.revisions.delete(
                            revision.id,
                            authorAttr('the chapter it was drafted against was removed (D-3c)')
                        );
                    }

                    store.chapters.delete(
                        chapter.id,
                        authorAttr(`chapter ${chapter.order} removed by the Author's count change (D-3c)`)
                    );
                }

                result.removed = doomed.map((chapter) => chapter.id);
            }

            // D-3c: after the plotlines lock, the count change reopens phase ②. The chapters were
            // written against the old count, so they go with the plotlines' lock.
            if (fresh.plotlines_locked) {
                scrapPhasesAfter(
                    store,
                    fresh,
                    'plotlines',
                    `chapter_count changed to ${count}; phase ② reopens by backtrack (D-3c, D-25)`
                );

                store.stories.update(
                    fresh.id,
                    {
                        phase: 'plotlines',
                        plotlines_locked: false,
                        status: 'ready',
                        pending_kind: 'none',
                        trend: 'unknown',
                        flat_streak: 0,
                        probe: undefined
                    },
                    authorAttr(`D-3c: chapter_count changed after the lock, so phase ② reopened`),
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }

            if (!removes) {
                const reopened = requireStory(store, storyId);

                result.created = materialiseChaptersFor(store, reopened, count);
            }

            const after = requireStory(store, storyId);
            const touched = storyChapters(store, after.id);

            // D-3c's last clause: every dependent chapter is rechecked, because the sequence moved.
            result.needs_recheck = markNeedsRecheck(
                store,
                after,
                dependents(
                    store,
                    after,
                    touched.slice(count).map((chapter) => chapter.id)
                ),
                `chapter_count moved to ${count}; the sequence changed (D-3c, L-11)`
            );
        });

        return result;
    }

    /**
     * D-25a: editing the Seed is a full backtrack to phase ①, in one commit. The confirmation is the
     * UI's, so an unconfirmed call throws with the destructive list named — a silent clear of the whole
     * book would be the worst possible default, and the return type is `void` by the pinned API.
     */
    async editSeed(storyId: string, text: string, opts: { confirm?: boolean } = {}): Promise<void> {
        const store = this.store;
        const story = requireStory(store, storyId);
        const derived = storyChapters(store, storyId).length + storyPlotlines(store, storyId).length;

        if (derived > 0 && opts.confirm !== true) {
            throw new Error(
                `editing the Seed scraps ${derived} derived artifact${derived === 1 ? '' : 's'} plus every plotline, chapter, revision and Digest (D-25a) — resend with confirm: true`
            );
        }

        await store.commit('edit_seed', () => {
            const fresh = requireStory(store, storyId);
            const counts = scrapPhasesAfter(
                store,
                fresh,
                'summary',
                `the Author edited the Seed; everything grown from it is scrapped (D-25a)`
            );

            store.stories.update(
                fresh.id,
                {
                    idea: text,
                    phase: 'summary',
                    summary_locked: false,
                    plotlines_locked: false,
                    status: 'ready',
                    pending_kind: 'none',
                    status_reason: `the Seed changed: ${counts.chapters} chapters and ${counts.plotlines} plotlines were scrapped (D-25a)`,
                    blocked_on: '',
                    trend: 'unknown',
                    flat_streak: 0,
                    level_history: [],
                    probe: undefined,
                    completion: undefined
                },
                authorAttr('the Author rewrote the Seed; the Story starts again from scratch (D-25a, P5)'),
                [{ id: fresh.id, rev: fresh.rev }]
            );

            const summary = storySummary(store, storyId);

            if (summary !== undefined) {
                store.summaries.update(
                    summary.id,
                    { locked: false, premise: '', promise: '', theme: '', tone: '', ending: '', world_rules: '' },
                    authorAttr('the Summary is the artifact the new Seed has to re-grow (D-25a, D-5)'),
                    [{ id: summary.id, rev: summary.rev }]
                );
            }
        });
    }

    /**
     * D-34: the approval that starts Writer work. The task is created HERE, not by the finding's author,
     * because the chain the spec fixes is raise → verify → APPROVE → task (L-1 step 2, §9's diagram), and
     * an unapproved finding generates no Writer work however confident the reviewer sounded.
     *
     * L-11a's fix target is chosen by the plotline that owns the fact (see `pickFixTarget`), which is
     * how §15 step 3b's cross-chapter fix lands on chapter 1 rather than on the chapter where the
     * contradiction was noticed.
     *
     * D-2a: approving a leftover on a drained Story returns it to `ready` — that is one of the two moves
     * L-37 says the Author has.
     */
    async approveFinding(findingId: string, opts: { cost?: Cost; by?: string; note?: string } = {}): Promise<void> {
        await this.store.commit('approve_finding', () => {
            const store = this.store;
            const finding = store.findings.get(findingId);

            if (finding === undefined) throw new Error(`no finding named ${findingId}`);

            const story = requireStory(store, finding.story_id);
            const by = opts.by ?? AUTHOR_APPROVED_BY;

            store.findings.update(
                findingId,
                {
                    state: 'approved',
                    approved_by: by,
                    // D-34a makes the Editor's triage final, so the cost is applied only when the caller
                    // re-states it (U-10a's approve-and-recost row); an approval that silently re-costs
                    // everything would undo the Editor's judgement forty times a day.
                    ...(opts.cost === undefined ? {} : { cost: opts.cost })
                },
                authorAttr(
                    `the Author approved ${finding.cost} ${finding.fingerprint}${opts.note === undefined ? '' : `: ${opts.note}`} (D-34)`
                ),
                [{ id: findingId, rev: finding.rev }]
            );

            this.createWorkForFinding({ ...finding, state: 'approved' }, story);

            if (story.status === 'pending' || story.status === 'completed') {
                const fresh = requireStory(store, story.id);

                store.stories.update(
                    fresh.id,
                    {
                        status: 'ready',
                        pending_kind: 'none',
                        status_reason: `approval of ${finding.fingerprint} re-opened work (D-2a: drained → ready)`,
                        blocked_on: ''
                    },
                    authorAttr('an approved finding is authorised work again (L-37, D-34)'),
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }
        });
    }

    /**
     * D-29/D-28/L-7a: the Author's pick, recorded as a decision.
     *
     * The signature resolves the whole tray in one call (`picked` is what the Author wants from it),
     * because L-7a's lock precondition is a tray with nothing undecided left: a partial decision would
     * leave the lock still blocked and the Author clicking twice for no reason. Everything not picked
     * becomes `discarded` — a decision, never a deletion, and readable for the rest of the phase (D-28).
     *
     * `note` is the Author's reason for the pick (D-29: "the Author's selection of an Idea is a recorded
     * decision, not a chat message"). §4.17's `selection_note` IS that record — U-15 renders it in the
     * decided list and D-32's repeat detection is what the next fresh Reader reads — so the caller's words
     * are stored verbatim and only a call with no note falls back to the generic sentence.
     *
     * Each selected Idea spawns the absorb work the next Writer's brief names (D-29's other half).
     */
    async decideIdea(ideaId: string, picked: string[] = [], note = ''): Promise<void> {
        await this.store.commit('decide_idea', () => {
            const store = this.store;
            const idea = store.ideas.get(ideaId);

            if (idea === undefined) throw new Error(`no idea named ${ideaId}`);

            const story = requireStory(store, idea.story_id);
            const chosen = new Set(picked.length > 0 ? picked : [ideaId]);
            // D-29: the Author's own words are the record. A blank/whitespace note is not a reason, so it
            // falls back to the default sentence rather than storing an empty note.
            const selectionNote = note.trim().length > 0 ? note.trim() : 'the Author selected this Idea (D-29)';

            for (const row of store.ideas.list()) {
                if (row.story_id !== story.id) continue;
                if (row.phase !== idea.phase) continue;
                if ((row.unit_ref ?? '') !== (idea.unit_ref ?? '')) continue;
                if (row.state === 'selected' || row.state === 'discarded' || row.state === 'deferred') continue;

                const isChosen = chosen.has(row.id);

                store.ideas.update(
                    row.id,
                    {
                        state: isChosen ? 'selected' : 'discarded',
                        selection_note: isChosen ? selectionNote : 'not selected when the tray was decided (D-28)'
                    },
                    authorAttr(
                        isChosen
                            ? `the Author selected ${row.id}: ${selectionNote} (D-29)`
                            : `the tray was decided; ${row.id} was discarded (D-28)`
                    ),
                    [{ id: row.id, rev: row.rev }]
                );

                if (!isChosen) continue;

                store.tasks.create(
                    {
                        story_id: story.id,
                        kind: TASK_KINDS.absorb,
                        title: `absorb the selected Idea: ${row.body.slice(0, 120)}`,
                        // The unit ref rides in `detail` because that is where `generateWork` looks for
                        // it, and because the Writer's brief names the Idea it must absorb (D-29, S-2).
                        detail: `${row.id} · ${row.unit_ref ?? story.id}`,
                        owner_role: 'writer',
                        state: 'open',
                        priority: 1,
                        attempts: 0
                    },
                    authorAttr('a selected Idea becomes Writer work (D-29, D-26: only the Writer writes it)')
                );
            }
        });
    }

    /**
     * D-37: the Author's own prose edit, allowed only while the Story is stopped.
     *
     * Refused while running, naming D-37, because the Author would otherwise lose writes to a machine
     * that retries instantly: T-4's compare-and-swap makes a lost race detectable, not resolved, and a
     * paragraph half-replaced by each side is exactly the corruption the pause exists to prevent.
     *
     * The edit lands as a direct write (D-20a), the span becomes Author-written so the crew may only
     * propose against it (P9, D-20), an undo snapshot is pushed (L-17a), and the dependents are marked
     * `needs_recheck` by the ordinary propagation rules (D-37a, L-11a) — the loop does not treat the
     * edit as a defect and does not try to restore what it replaced (D-37b).
     */
    async applyAuthorEdit(
        chapterId: string,
        sectionId: string,
        text: string,
        opts: { undoable?: boolean } = {}
    ): Promise<void> {
        await this.store.commit('author_edit', () => {
            const store = this.store;
            const chapter = loopChapter(store, chapterId);

            if (chapter === undefined) throw new Error(`no chapter named ${chapterId}`);

            const story = requireStory(store, chapter.story_id);

            if (story.status !== 'stopped' && !story.author_stop) {
                throw new Error(
                    `the prose pane is editable only while the Story is stopped — pause it first (D-37): ${story.id} is ${story.status}`
                );
            }

            if (opts.undoable !== false) {
                pushUndo(store, chapter, {
                    at: new Date().toISOString(),
                    verb: 'applyAuthorEdit',
                    section_id: sectionId,
                    summary: `the Author replaced ${sectionId}'s text (${chapterTitle(chapter)})`,
                    snapshot: { ...chapter, undo_stack: undefined } as Chapter
                });
            }

            applySectionEdit(store, chapter, sectionId, text);

            const touched = markNeedsRecheck(
                store,
                story,
                dependents(store, story, [chapterId]),
                `the Author rewrote ${sectionId}; the chapters that depend on it are re-read (D-37a, L-11a)`
            );

            void touched;
        });
    }

    /** L-10: the Author's word outranks the criteria in both directions — this is the re-open. */
    async unapproveChapter(chapterId: string): Promise<void> {
        await this.store.commit('unapprove_chapter', () => {
            const store = this.store;
            const chapter = store.chapters.get(chapterId);

            if (chapter === undefined) throw new Error(`no chapter named ${chapterId}`);

            const story = requireStory(store, chapter.story_id);

            store.chapters.update(
                chapterId,
                // §4.4's `needs_recheck` is the state that means "this goes back through the loop", and
                // L-12 makes that re-entry automatic rather than something the Author has to trigger.
                { state: 'needs_recheck', author_locked: false },
                authorAttr(`the Author re-opened chapter ${chapter.order} (L-10)`),
                [{ id: chapterId, rev: chapter.rev }]
            );

            if (story.status === 'pending' || story.status === 'completed') {
                const fresh = requireStory(store, story.id);

                store.stories.update(
                    fresh.id,
                    {
                        status: 'ready',
                        pending_kind: 'none',
                        status_reason: `chapter ${chapter.order} was re-opened by the Author (L-10)`,
                        blocked_on: ''
                    },
                    authorAttr('a re-opened chapter is work again (L-12)'),
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }
        });
    }

    /**
     * D-20: the propose-only tray. §4.16's states are `pending | accepted | rejected`, so `deferred`
     * leaves the row pending and records the reason in `why` — the tray keeps showing it, which is what
     * "deferred" means for a proposal (an Idea has its own `deferred` state; a proposal does not).
     */
    async decideProposal(
        proposalId: string,
        verdict: 'accepted' | 'rejected' | 'deferred',
        reason?: string
    ): Promise<void> {
        await this.store.commit('decide_proposal', () => {
            const store = this.store;
            const proposal = store.proposals.get(proposalId);

            if (proposal === undefined) throw new Error(`no proposal named ${proposalId}`);

            if (verdict === 'accepted') {
                const resolved = store._resolveId(proposal.target_ref);

                if (resolved?.record === undefined)
                    throw new Error(
                        `proposal ${proposalId} targets ${proposal.target_ref}, which is gone (T-4: re-read before applying)`
                    );

                // Every collection exposes the same `update(id, patch, attribution, expects)` shape.
                const collection = (
                    store as unknown as Record<
                        string,
                        {
                            update(
                                id: string,
                                patch: Record<string, unknown>,
                                attribution: { run_ref: string | null; why: string },
                                expects?: { id: string; rev: number }[]
                            ): unknown;
                        }
                    >
                )[resolved.collection];
                const patch = normaliseProposalPatch(proposal.target_field, proposal.patch);

                collection.update(
                    proposal.target_ref,
                    patch,
                    {
                        run_ref: proposal.run_ref ?? null,
                        why: `the Author accepted ${proposalId}${reason === undefined ? '' : `: ${reason}`} (D-20)`
                    },
                    [{ id: proposal.target_ref, rev: (resolved.record as { rev: number }).rev }]
                );

                store.proposals.update(
                    proposalId,
                    { state: 'accepted' },
                    authorAttr(`the Author accepted ${proposalId}${reason === undefined ? '' : `: ${reason}`} (D-20)`),
                    [{ id: proposalId, rev: proposal.rev }]
                );

                return;
            }

            if (verdict === 'rejected') {
                store.proposals.update(
                    proposalId,
                    { state: 'rejected' },
                    authorAttr(`the Author rejected ${proposalId}${reason === undefined ? '' : `: ${reason}`}`),
                    [{ id: proposalId, rev: proposal.rev }]
                );

                return;
            }

            store.proposals.update(
                proposalId,
                { why: `${proposal.why}${reason === undefined ? '' : ` · deferred: ${reason}`}` },
                authorAttr(`the Author deferred ${proposalId} — it stays in the tray (§4.16 has no deferred state)`),
                [{ id: proposalId, rev: proposal.rev }]
            );
        });
    }

    /** L-17a: restore the most recent change to one chapter. */
    async undoLast(chapterId: string): Promise<void> {
        const store = this.store;

        await store.commit('undo_last', () => {
            const chapter = store.chapters.get(chapterId);

            if (chapter === undefined) throw new Error(`no chapter named ${chapterId}`);

            const entry = popUndo(store, chapter);

            if (entry === undefined)
                throw new Error(`nothing to undo on ${chapterId} — the chapter has no undo stack (L-17a)`);

            // Popping the stack is only half the verb. L-17a's promise is that the chapter goes BACK to
            // how it stood, and the entry's `snapshot` is that state — a pop alone would leave the prose
            // changed and the history claiming otherwise. `undo_stack` is deliberately not restored: the
            // stack the pop just wrote is the truth (an undo must not resurrect the change it undid).
            const fresh = store.chapters.require(chapterId);

            store.chapters.update(
                chapterId,
                {
                    sections: entry.snapshot.sections,
                    title: entry.snapshot.title,
                    summary: entry.snapshot.summary,
                    state: entry.snapshot.state,
                    current_revision: entry.snapshot.current_revision
                },
                authorAttr(
                    `the Author undid ${entry.verb} on ${chapterId}; the chapter is back as it stood (${entry.at}) (L-17a)`
                ),
                [{ id: chapterId, rev: fresh.rev }]
            );
        });
    }

    /** D-19/L-24/L-27: answer an escalation, or steer the crew, and get back what it touched. */
    async processDirective(
        storyId: string,
        text: string,
        refs: string[] = []
    ): Promise<{ directive_id: string; impact: DirectiveReport }> {
        const story = requireStory(this.store, storyId);

        // The report is hoisted out of the transaction (`commit` resolves to void), so the caller still
        // gets W12's "what did it touch" answer.
        let applied: { directive_id: string; impact: DirectiveReport; targets: string[] } | undefined;

        await this.store.commit('process_directive', () => {
            applied = applyDirective(this.store, requireStory(this.store, storyId), {
                text,
                refs,
                at: new Date().toISOString(),
                killRun: (runId) => this.executor.kill(runId)
            });

            if (applied.impact.completed_reopened) {
                const fresh = requireStory(this.store, storyId);

                // L-27: a directive returns a completed Story to `ready`.
                this.store.stories.update(
                    fresh.id,
                    {
                        status: 'ready',
                        pending_kind: 'none',
                        status_reason: `a directive re-opened the finished book (L-27): ${text.slice(0, 80)}`,
                        blocked_on: ''
                    },
                    authorAttr('the Author kept writing the book, so the loop polices it again (L-27)'),
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }
        });

        void story;

        if (applied === undefined) throw new Error('process_directive committed without a report');

        return { directive_id: applied.directive_id, impact: applied.impact };
    }

    /**
     * L-25/L-26/L-25b/L-30: the last sign-off.
     *
     * Accepting is what closes the leftovers (L-26: "the acceptance is what closes the remaining
     * findings and Ideas"), and the COUNT is recorded against the Story so the Author can see what they
     * waved away (L-25b, U-14). `completed` is phase ③'s lock (L-25a), so the chapters are locked exactly
     * as the Summary and plotlines are, and the sweep stops touching the Story (L-0).
     *
     * Discarding keeps the crew working (L-30) and retires the drain round, so a fresh full pass is
     * required before the loop proposes again — otherwise the same proposal would re-page the Author on
     * every sweep of an unchanged Story.
     */
    async acceptCompletion(storyId: string, accept: boolean): Promise<void> {
        await this.store.commit(accept ? 'accept_completion' : 'discard_completion', () => {
            const store = this.store;
            const story = requireStory(store, storyId);
            const loop = loopStory(story);
            const open = store.findings
                .list()
                .filter(
                    (finding) => finding.story_id === storyId && DISCARDABLE_FINDING_STATES.includes(finding.state)
                );
            const ideas = store.ideas
                .list()
                .filter((idea) => idea.story_id === storyId && DISCARDABLE_IDEA_STATES.includes(idea.state));

            if (!accept) {
                store.stories.update(
                    story.id,
                    {
                        completion: {
                            proposed_at: loop.completion?.proposed_at ?? new Date().toISOString(),
                            phase: story.phase,
                            leftovers: loop.completion?.leftovers ?? { findings: open.length, ideas: ideas.length },
                            accepted: false,
                            // L-30: the discard count survives the proposal being cleared.
                            discarded: (loop.completion?.discarded ?? 0) + 1
                        },
                        status: 'ready',
                        pending_kind: 'none',
                        status_reason: `the Author declined completion; the crew keeps working (L-30)`,
                        blocked_on: '',
                        probe:
                            loop.probe === undefined ? undefined : { ...loop.probe, status: 'idle', clean_since: null }
                    },
                    authorAttr('completion discarded — the loop is not done with the book (L-30)'),
                    [{ id: story.id, rev: story.rev }]
                );

                return;
            }

            for (const finding of open) {
                store.findings.update(
                    finding.id,
                    { state: 'discarded' },
                    { run_ref: null, why: `the Author accepted completion, which discards what is still open (L-25b)` },
                    [{ id: finding.id, rev: finding.rev }]
                );
            }

            for (const idea of ideas) {
                store.ideas.update(
                    idea.id,
                    { state: 'discarded' },
                    { run_ref: null, why: 'completion discards the Ideas the phase did not absorb (L-25b, D-36)' },
                    [{ id: idea.id, rev: idea.rev }]
                );
            }

            for (const chapter of storyChapters(store, storyId)) {
                // L-25a: `completed` IS the chapter lock, and it works exactly like the other two.
                store.chapters.update(
                    chapter.id,
                    { author_locked: true, state: 'done' },
                    authorAttr('completion locks the chapters (L-25a)'),
                    [{ id: chapter.id, rev: chapter.rev }]
                );
            }

            store.stories.update(
                story.id,
                {
                    status: 'completed',
                    pending_kind: 'none',
                    status_reason: `the Author accepted completion: ${open.length} findings and ${ideas.length} Ideas were discarded (L-25b)`,
                    blocked_on: '',
                    completion: {
                        proposed_at: loop.completion?.proposed_at ?? new Date().toISOString(),
                        phase: story.phase,
                        leftovers: { findings: open.length, ideas: ideas.length },
                        accepted: true,
                        discarded: loop.completion?.discarded ?? 0
                    }
                },
                authorAttr('the Author accepted completion; the book is done (L-26, L-25a)'),
                [{ id: story.id, rev: story.rev }]
            );
        });
    }

    /** G-1/L-16b: edit the Goal. Everything the criteria read is re-evaluated on the next sweep. */
    async setGoal(storyId: string, patch: GoalPatch): Promise<void> {
        await this.store.commit('set_goal', () => {
            const store = this.store;
            const story = requireStory(store, storyId);
            const existing =
                store.goals.get(story.goal_ref ?? '') ?? store.goals.list().find((goal) => goal.story_id === storyId);
            const base = existing ?? defaultGoal(storyId);

            // G-1 replaces the criterion list wholesale, and §5's ladder is built by filtering
            // `goal.criteria` on `criterion.id` (server/criteria/engine.ts:900). A caller crossing a JSON
            // boundary can easily hand over bare ids — the api layer's Goal panel is a list of checkboxes
            // — and storing those would leave the ladder with NOTHING to place: `placementOf(undefined)`
            // matches no level, so every criterion would read as neither passing nor failing and a Story
            // would look green with an empty bar. The catalogue's own records are what the row holds, so
            // an id is expanded from the built-in roster the Story was created with.
            const roster = defaultGoal(storyId).criteria;
            const criteria =
                patch.criteria === undefined
                    ? base.criteria
                    : patch.criteria
                          .map((entry) =>
                              typeof entry === 'string' ? roster.find((criterion) => criterion.id === entry) : entry
                          )
                          .filter((entry) => entry !== undefined);

            const merged = {
                title: patch.title ?? base.title,
                threshold_soft: patch.threshold_soft ?? base.threshold_soft,
                criteria,
                flat_rounds: patch.flat_rounds ?? base.flat_rounds,
                regress_tolerance: patch.regress_tolerance ?? base.regress_tolerance
            };

            if (existing === undefined) {
                const row = store.goals.create(
                    { story_id: storyId, ...merged },
                    authorAttr(`the Author set the Goal for ${storyId} (G-1)`)
                );

                store.stories.update(
                    story.id,
                    { goal_ref: row.id },
                    authorAttr('the Story now measures against its own Goal row (§4.1 `goal_ref`)'),
                    [{ id: story.id, rev: story.rev }]
                );

                return;
            }

            store.goals.update(
                existing.id,
                merged,
                authorAttr(
                    'the Author edited the Goal; the next sweep re-derives levels, sign-offs, and stall detection (L-16b, G-1)'
                ),
                [{ id: existing.id, rev: existing.rev }]
            );
        });
    }

    /**
     * G-1 / §14 item 2: the per-chapter bar, rendered into §4.4's `bar_override` TEXT.
     *
     * §4.4 stores the bar as one text field, and the criteria engine parses it as `-C-<id>` drops and
     * `±n` threshold deltas (criteria/engine.ts's `parseBarOverride`), so the list is rendered into
     * exactly that grammar: bare criterion ids become drops, numeric entries become deltas, and anything
     * else is passed through so the engine's own warning surfaces on the row rather than being lost here.
     */
    async setChapterBar(storyId: string, chapterId: string, criteria: string[]): Promise<void> {
        await this.store.commit('set_chapter_bar', () => {
            const store = this.store;
            const chapter = store.chapters.get(chapterId);

            if (chapter === undefined) throw new Error(`no chapter named ${chapterId}`);
            if (chapter.story_id !== storyId)
                throw new Error(`chapter ${chapterId} belongs to ${chapter.story_id}, not ${storyId} (T-3)`);

            const tokens = criteria.map((entry) => {
                const trimmed = entry.trim();

                if (/^-?[cC]-?\d+/.test(trimmed)) return `-${trimmed.replace(/^-/, '').toUpperCase()}`;
                if (/^[+-]?\d+$/.test(trimmed)) return trimmed;

                return trimmed;
            });

            store.chapters.update(
                chapterId,
                { bar_override: tokens.join(' ') },
                authorAttr(`the Author set this chapter's bar to "${tokens.join(' ')}" (G-1)`),
                [{ id: chapterId, rev: chapter.rev }]
            );
        });
    }

    /**
     * D-17b/D-38a/L-4: the crew assignment.
     *
     * §4.1's `template_refs` is a flat list — the phase matching comes from each template's
     * `serves_phase` (L-4's three loops, three template sets) — so a phase-keyed assignment is
     * flattened. An assignment that does not validate (T-0: no Writer for the phase, or divergence
     * without an Editor) is REFUSED with the reasons returned rather than thrown, because U-8's editor
     * validates as the Author types and needs the messages, not a stack.
     */
    async assignTemplates(
        storyId: string,
        assignments: Record<string, string[]> | string[],
        opts: { confirm?: boolean } = {}
    ): Promise<AssignTemplatesResult> {
        const store = this.store;
        const refs = Array.isArray(assignments) ? assignments : Object.values(assignments).flat();
        const unique = [...new Set(refs.map((ref) => ref.trim()).filter((ref) => ref.length > 0))];
        const story = requireStory(store, storyId);
        const catalogue = [...BUILT_IN_TEMPLATES, ...store.templates.list()];
        const errors = validateAssignment(story, unique, catalogue);

        if (errors.length > 0) return { errors, assigned: story.template_refs };

        const live = liveRuns(store, storyId).length;

        if (live > 0 && opts.confirm !== true)
            return { confirm_required: true, changed_live_runs: live, assigned: story.template_refs };

        await store.commit('assign_templates', () => {
            const fresh = requireStory(store, storyId);

            store.stories.update(
                fresh.id,
                { template_refs: unique },
                authorAttr(
                    `the Author assigned ${unique.join(', ')}; the next sweep dispatches with these crews (D-17b, D-38a)`
                ),
                [{ id: fresh.id, rev: fresh.rev }]
            );
        });

        return { assigned: unique, changed_live_runs: live };
    }

    // -----------------------------------------------------------------------
    // Shared verb plumbing
    // -----------------------------------------------------------------------

    /**
     * Where D-35's "a regression reopens the same row" is settled, and why this file does not reopen rows.
     *
     * §8's `raiseFinding` owns the ledger of repeat sightings, and its dedupe deliberately matches only
     * rows that are NOT `fixed`/`discarded` (server/tools/tools/artifacts.ts:708-712). So one re-claim of
     * an OPEN defect bumps that row's `seen_count` (D-16), while a re-claim of a DEFECT THE CREW ALREADY
     * FIXED opens a fresh row whose fingerprint the loop's closed-fingerprint ledger recognises
     * (L-16a: `trend.ts` reads `confirmedOpen ∩ closedLedger` as `regressing`, and the stall sentence in
     * L-22 names it). The loop cannot also flip the closed row back to `confirmed` — the two mechanisms
     * fight, and a probe that re-files a fixed defect ends up with two rows and two fix tasks for one
     * defect (measured: chapter_1 carrying `finding_4` fixed and `finding_5` seen 3 off the same
     * fingerprint). The ledger is the loop's; the row states are the tool's.
     */
    /**
     * D-34's second half: an approval creates the Writer work, aimed at the artifact that OWNS the fact
     * (L-11a's "fix the side the plotline says is wrong") rather than at wherever it was noticed.
     *
     * No task is created when one already exists for the finding, because D-16's dedupe can re-open the
     * same defect on a later sweep and a second task would buy two Writer passes for one defect.
     */
    private createWorkForFinding(finding: Finding, story: Story): void {
        const store = this.store;

        if (openTasks(store, story.id).some((task) => task.finding_ref === finding.id)) return;

        const refs = [finding.target_ref, ...(finding.related_refs ?? [])];
        const target = pickFixTarget(store, story, refs, `${finding.criterion_ref} ${finding.title}`);
        // A defect filed against the Story row with no chapter or plotline named has nowhere to land: the
        // whole-level criteria are scoped to the story (criteria/engine.ts:scopeTargets), but a Writer
        // edits an artifact. The task is still created — an approved finding must not vanish — but it is
        // created `blocked`, because per T-12 a job with no reachable tool is a gap for the Author, not a
        // run that improvises. `OPEN_TASK_STATES` excludes `blocked`, so a task nobody can run cannot
        // hold `drained` hostage (L-37 condition 1).
        const unlocalisable = target === undefined || target === story.id;

        createFixTask(store, story, {
            findingId: finding.id,
            unitRef: target ?? finding.target_ref,
            title: `fix ${finding.cost}: ${finding.title.slice(0, 120)}`,
            detail: unlocalisable
                ? `${finding.criterion_ref} on ${refs.join(', ')} · nothing on the finding names an artifact a Writer can edit (T-12)`
                : `${finding.criterion_ref} on ${refs.join(', ')}`,
            priority: finding.cost === 'critical' || finding.cost === 'major' ? 1 : 2,
            criterionRef: finding.criterion_ref,
            blocked: unlocalisable
        });
    }
}

// ---------------------------------------------------------------------------
// Small module-level helpers
// ---------------------------------------------------------------------------

/** The Story's own Summary prose field for the title fallback (a Story row needs a title, §4.1). */
function firstLine(idea: string): string {
    const line = idea.split('\n')[0]?.trim() ?? 'Untitled';

    return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

const chapterTitle = (chapter: Chapter): string => chapter.title || `chapter ${chapter.order}`;

/** §4.16's `patch` is `unknown`; a text field is the common case and an object patch is the general one. */
function normaliseProposalPatch(field: string, patch: unknown): Record<string, unknown> {
    if (typeof patch === 'string' || typeof patch === 'number' || typeof patch === 'boolean') return { [field]: patch };

    if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
        const entries = patch as Record<string, unknown>;

        // `{ <field>: value }` is the shape `proposeChange` sends; anything else is applied as-is so an
        // Author who approved a multi-field patch gets exactly the patch they read.
        return field in entries ? entries : { [field]: patch };
    }

    return {};
}

/** Is this claim key already claimed, in this process or in the store? (L-2's two halves.) */
function isClaimedHere(store: Store, key: string): boolean {
    return store.runs.list().some((run) => isLiveRun(run) && run.work_item_ref === key);
}

/** Closed runs for one Story — the round counter's input (L-15: the level history is per ROUND). */
function closedRunCount(store: Store, storyId: string): number {
    return store.runs.list().filter((run) => run.story_id === storyId && !isLiveRun(run)).length;
}

/** D-3c's grow path, kept separate so `changeChapterCount`'s commit body stays readable. */
function materialiseChaptersFor(store: Store, story: Story, count: number): string[] {
    // `materialiseChapters` lives in ./invalidation and is imported here through the small wrapper so
    // the commit body reads as one decision rather than as a page of writes.
    return materialiseChapters(store, story, count);
}

/** The task kinds the queue uses, re-exported for the dashboard's queue rows (D-11, P15). */
export const LOOP_TASK_KINDS = TASK_KINDS;

// L-1's cadence is exported from ./types (DEFAULT_SWEEP_INTERVAL_MS); re-declaring it here would put a
// second copy of the pinned default in the package.
