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
    findingsVerifyStalled,
    // F3 — the shared-finding gate: a finding is only retired when its LAST open fix row settles.
    findingFixWorkSettled,
    isBlockingCost,
    isFullyScreened,
    isLiveRun,
    isResearchPrerequisiteFix,
    isReviewableDraft,
    lapsedRuns,
    last,
    liveRuns,
    liveRunsForTemplate,
    loopChapter,
    loopStory,
    loopAttr,
    // H2/R1: the round's closure closes the fix rows the WRITER owns. `openFixTasks` used to mean
    // "every open fix row", which is what let a Researcher prerequisite be closed by a passing draft.
    openPrerequisiteFixTasks,
    // D-33d: the issues-first gate. BOTH approval funnels read this one predicate — the dial's
    // auto-approve sweep and `approveFinding` here — so neither can approve a `proposal` over an
    // unresolved defect while `tools/editor.ts:approveFinding` refuses the same call (D-33c's
    // filing-side rule is the third reader of it, in `tools/reader.ts`).
    openIssueFindings,
    openUnserviceableFixTasks,
    openWriterFixTasks,
    pendingProposals,
    openTasks,
    researchPrerequisiteAnswered,
    requireStory,
    roleNameOf,
    // T6/round-3 fix #3 — the hill's ledger reads: the round's measured candidates, the one it may
    // INSTALL, the wave's derived budget, and the wave-scoped leg gate. `records.ts:roundSampleScores`
    // scores every drafted candidate against `acceptedSummaryRevision` internally, so the selection pass
    // never re-derives the base (and cannot disagree with the queue about what the base was).
    roundInstallableCandidate,
    roundRevisions,
    roundSampleScores,
    // T10/F7's live-read: a probe round is judged only once neither probe job has a live run. The
    // hill-climb rewrite of the selection pass must not drop it — `judgeProbeRound` reads it.
    runsForItem,
    // G1: the accepted-revision audit. The sweep writes the entry, the plateau gates the round (through
    // `samplingArmed`), and this is the reader that decides whether a cleared plateau row may bump the wave.
    deepReviewRoundOf,
    pendingRevisionReviewEntry,
    revisionReviewPlateau,
    revisionReviewProgressOf,
    samplingLegClosed,
    samplingProgressOf,
    samplingRoundOf,
    samplingSizeOf,
    samplingWaveOf,
    screensFor,
    screeningSizeOf,
    // H2/R1: the stall predicate the settlement re-derives inside its commit (a prerequisite whose
    // passes are spent and which recorded nothing) — the same read the queue and the drain probe use.
    stalledResearchPrerequisites,
    storyChapters,
    storyFindings,
    storyPlotlines,
    storySummary,
    summaryRevisions,
    tasksForFinding,
    templatesFor,
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
import {
    generateWork,
    openSamplingFailureTask,
    openScreeningExhaustionTask,
    openFindingVerifyStallTask,
    FINDING_VERIFY_STALL_PREFIX,
    // H2/R1: the two Author questions `settleFixPrerequisites` opens and closes (prefixes live in
    // work.ts, like every other escalation title here, so the reuse key and the row share one source).
    FIX_PREREQUISITE_STALL_PREFIX,
    FIX_TASK_OWNER_PREFIX,
    // SUMMARY PHRASE: the G1 plateau's Author row (`openRevisionPlateauTask` / `SAMPLING_PLATEAU_PREFIX`)
    // is GONE — the whole-Summary hill-climb it policed no longer runs for group-managed books (R5),
    // and `phase1RevisionPlateau`'s "ask the Author when samples stop improving" is replaced by the
    // per-group hill-climb, where a group that stops improving is the SAME group the next Writer batch
    // is pointed at. Only the sampling-failure family remains, for legacy `summary_mode:'sampling'`
    // books (`phrase/catalog.ts:isGroupManagedStory`).
    SAMPLING_FAILURE_PREFIX,
    samplingExhausted
} from './work';
import { carriedDelta, levelPairs, measureRound, recordRound, renderPairs } from './trend';
import { completeDirective, createDirectiveFallbackTasks, pendingDirectives, recordDirective } from './directives';
// SUMMARY PHRASE (R1-R6) — the group domain rules the sweep enforces. Every one of these is the ONE
// place its rule lives (`../phrase/**` is the owner; the engine only sequences the calls): the catalog
// ensure + the group-managed predicate (`catalog.ts`), the batch install with its per-group revisions
// and legacy mirror (`revisions.ts`), the answer validators that refuse a batch whole
// (`parseGroupDraftAnswer` / `parseGroupReviewAnswer`), and R3's closure (`closeFindingWhenGroupsResolved`).
import {
    closeFindingAnsweredByInstalls,
    closeFindingWhenGroupsResolved,
    ensurePhraseCatalog,
    installGroupRevisions,
    isGroupManagedStory,
    parseGroupDraftAnswer,
    parseGroupReviewAnswer,
    // READER SCORING (D-65): the answer validator (refuses an incomplete run whole) and the claim-key
    // read that stamps the rows with the vector the pass was dispatched against.
    parseSectionScoreAnswer,
    sectionScoreVectorHashOf,
    // SUMMARY PHRASE D-67: the Clean stamp a closed cross-group pass leaves behind, and the seat-family
    // reader that decides which `check_unit` close may stamp at all.
    groupCheckVectorHashOf,
    stampCleanRevisions,
    // HARDENING (D-25a group reset): the Seed edit resets these rows too — see `editSeed`.
    phraseGroupsOf,
    // GROUP LOCK (R3/T6b): the domain operation the Editor's judgement seat ends with, and the refusal
    // type its settle catches (`phrase/locks.ts` — the WRITE stays there, the JUDGEMENT is in
    // `loop/editor-lock.ts`). The refusal is thrown before any write and rolls its commit back, so
    // catching it here means "the state moved while the Editor deliberated: nothing happened".
    lockPhraseGroup,
    isPhraseLockRefusal,
    storyPhrase
} from '../phrase';
// R3/T6b — the Editor's lock seat: the answer validator (contract-only, result union like the group
// passes) and the settle guard (the domain state re-read inside the commit). Both live in one module so
// the generator, the prompt compiler and the settle cannot disagree about what is lockable.
import { editorLockMayLock, parseGroupLockAnswer } from './editor-lock';
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
    CLOSED_FINDING_STATES,
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
    type LoopCeiling,
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
import { missingSummaryBlocksOf } from '../../shared/summary';
import { DEFAULT_AUTO_APPROVE_COSTS } from '../../shared/types';
import type {
    Chapter,
    Cost,
    Finding,
    Story,
    StoryPhase,
    Summary,
    Task
} from '../../shared/types';
import type { IssueList } from '../../shared/schemas';
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
    /**
     * S-RUNTIME: the cross-Story fan-out ceiling, when this engine is one of several under a
     * coordinator. Undefined is the pre-registry shape — one Store holding every Story, where
     * `liveRuns(store)` IS the whole workspace and `config.globalMaxConcurrent` is the whole rule.
     */
    private readonly ceiling?: LoopCeiling;
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
        this.ceiling = deps.ceiling;
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
    // S-5's ceiling
    // -----------------------------------------------------------------------

    /**
     * S-5's global fan-out ceiling, moved while the loop runs. The sweep reads it fresh on every
     * dispatch (`dispatch` counts `liveRuns` against `config.globalMaxConcurrent`), so the NEXT sweep
     * after this call already fills the new capacity — and raising it does not need a Story to be
     * stopped, because the ceiling was never a per-Story setting (S-5: it is one number across all of
     * them).
     *
     * LOWERING it cancels nothing: the runs already in flight finish their pass, and the loop simply
     * stops claiming new ones until the live count falls under the new ceiling. That is the same
     * behaviour a Story stop has (L-10: the Author's cut never mid-cuts a run), and it is why a
     * too-small value is safe to type.
     *
     * This is a PROCESS setting, not a §4 record, and the route that calls this also remembers it in
     * the store's `settings` section (`loop/ceiling.ts`), so the Author's number is still there after a
     * restart — the same seam the roster's model choices use (U-8). `STORYLINE_GLOBAL_MAX_CONCURRENT`
     * outranks it at boot when an operator set one (`api/server.ts`), and an explicit injected
     * `engineConfig` outranks it for a test or an embed.
     *
     * The CALLER validates (the route answers 400 with the product sentence, as every other route
     * does); this setter trusts a whole number at least 1.
     */
    setGlobalMaxConcurrent(limit: number): void {
        this.config.globalMaxConcurrent = limit;

        // S-RUNTIME: under a coordinator, the config number this engine reads is the VIEW's number, so
        // the write has to move the shared one — otherwise a rail write would change one book's limit and
        // leave every other book on the old one, which is the bug the shared ceiling exists to close.
        // Both are written: the config stays correct for an engine whose view is detached, and the view
        // stays correct for every engine attached to it.
        this.ceiling?.setLimit?.(limit);
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
                this.executor.kill(run.id, 'stop');
                killed.push(run.id);
            }
        }

        // S-4a / D-36: a run row nobody has touched for `leaseIdleMs` has a dead owner. The Work Item
        // returns to the queue (its claim key is unclaimed once the row closes) and the run is torn
        // down. No clock on the run itself — S-4a forbids a timeout, and a lease is the only honest way
        // to tell "slow" from "hung".
        for (const run of lapsedRuns(store, Date.parse(at), this.config.leaseIdleMs)) {
            if (run.story_id !== story.id) continue;

            this.executor.kill(run.id, 'lease');
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

            // D-33d — issues are in focus before anything else can be approved, INCLUDING the dial.
            // Read ONCE for the sweep, from the same predicate every other funnel uses
            // (`records.ts:openIssueFindings`), so the dial cannot approve into work what the Editor's
            // `approveFinding` refuses to approve and the Critic's tool refuses to file (D-33c).
            //
            // A dial that skipped this spent Writer rounds on suggestions while confirmed defects sat
            // in the queue: the sweep approved whatever cost the dial covered, kind-blind, and a
            // `proposal` at `major` looked exactly like an `issue` at `major` from here.
            const openIssues = openIssueFindings(store, story.id);

            for (const finding of storyFindings(store, story.id)) {
                if (finding.state !== 'confirmed') continue;
                // D-33d: a PROPOSAL waits for the issues, and a skip is the right shape here rather than
                // a throw — this loop is one commit over every confirmed row of the Story, and a refusal
                // on one proposal would abort the sweep and strand the ISSUES that are the very work the
                // rule wants done first. The row stays `confirmed` (nothing is lost), the Author still
                // sees it in the queue, and the next sweep approves it the moment the last issue closes.
                // `auto_approved` reports what the sweep DID, so a skipped row is simply absent from it.
                if (finding.kind === 'proposal' && openIssues.length > 0) continue;
                // Phase ①'s bar is the deep review: the Editor's verification of a tool-using
                // Critic's finding IS the acceptance that arms the next sampling round, and only the
                // blocking costs travel back — a taste note is recorded, never a Writer round (D-30,
                // D-34). Which costs block is ONE predicate (`records.ts:isBlockingCost`), read the same
                // way by the Editor's `approveFinding`, the arming rule, the sign-off and the drain:
                // critical and major always, and `minor` exactly when the Author's dial covers it. A dial
                // that includes minor turns a confirmed Summary minor into fix work; a dial that leaves
                // it out records the note and lets the round stop. Later phases are unchanged.
                const summaryRevision = story.phase === 'summary';
                if (!isBlockingCost(story, finding.cost)) continue;
                // The Author's dial still wins, even in phase ①: a narrowed dial parks a major
                // finding for the Author's approval instead of silently authorising it.
                if (!story.auto_approve.includes(finding.cost)) continue;
                if (finding.approved_by !== null && finding.approved_by !== undefined) continue;

                store.findings.update(
                    finding.id,
                    { state: 'approved', approved_by: AUTO_APPROVED_BY },
                    {
                        run_ref: null,
                        why: summaryRevision
                            ? `the Editor confirmed ${finding.id} in phase ①; the valid critique goes back to the Writer`
                            : `the Story's dial covers ${finding.cost}; approved on the spot (D-35)`
                    },
                    [{ id: finding.id, rev: finding.rev }]
                );

                this.createWorkForFinding(finding, story);
                ids.push(finding.id);
            }

            autoApproved = ids;
        });

        // SUMMARY PHRASE R3 — the close the STATE GATE deferred, re-checked once per sweep.
        //
        // `settleJob` closes a group finding at the moment its install lands, and
        // `phrase/findings.ts:closeFindingWhenGroupsResolved` refuses anything but an `approved` row
        // (D-34's gate: the loop may not mark a defect `fixed` while the Author is looking at an
        // approval row). The problem is ordering: the group planner cuts a Writer batch off an OPEN
        // finding — `loop/work.ts:groupWorkTargets` accepts D-33's `unconfirmed`/`confirmed` rows on
        // purpose — so a pass can install the answer BEFORE the Editor's `approveFinding`, the dial's
        // auto-approve, or the Author's tap makes the row `approved`. The install-time close then
        // correctly declines, and with no other caller the finding sits `approved` with every targeted
        // group already rewritten to resolve it, plus a fix task the planner will never dispatch again
        // (`findingGroupsStillOwed` is empty for it). That is R3's promise broken by sequencing, so the
        // sweep re-runs the read every round: the same records, the same rule, one sweep later.
        //
        // WHY A SWEEP STEP AND NOT A WRITE AT EACH APPROVAL: there are three approval funnels —
        // `tools/editor.ts:approveFinding`, `approveFinding` here, and the auto-approve commit above —
        // and a crash between any of them and the close has to self-heal anyway. One idempotent sweep
        // step covers all three and survives a restart with no new bookkeeping, which is L-3's rule for
        // anything the loop is allowed to finish late.
        //
        // GROUP BOOKS ONLY: the rule reads `group_revisions.finding_refs`, and only a group install ever
        // writes one, so a single-Summary book has nothing to reconcile — and `findingResolution` answers
        // `resolved_all: true` vacuously for a Story with no phrase rows, which must not close anything.
        if (isGroupManagedStory(story)) {
            await store.commit('loop_reconcile_findings', () => {
                for (const finding of storyFindings(store, story.id)) {
                    if (finding.state !== 'approved') continue;

                    const closed = closeFindingAnsweredByInstalls(
                        store,
                        story,
                        finding,
                        loopAttr(
                            `the sweep re-checked ${finding.id} after its approval landed, and every group it names already has an installed revision answering it`
                        )
                    );

                    if (closed === undefined) continue;

                    // R3 — THE TASKS FOLLOW THE FINDINGS, the same evidence rule `settleJob` applies
                    // beside an install: a row that named a now-`fixed` finding is consumed rather than
                    // dispatched. Leaving it open would hold L-37's drain hostage over a defect the book
                    // can already show as answered, and the task can never run: no group still owes it.
                    for (const task of openTasks(store, story.id)) {
                        if (task.finding_ref !== closed.id) continue;

                        store.tasks.update(
                            task.id,
                            { state: 'done' },
                            {
                                run_ref: null,
                                why: `${closed.id} closed on the evidence that every group it targets has a revision written to resolve it, so the fix task that named it is consumed (R3, D-11, D-34)`
                            },
                            [{ id: task.id, rev: task.rev }]
                        );
                    }
                }
            });
        }

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

        // D-19: a directive the Editor did not finish reviewing before a crash. A propagating
        // directive with NO review thread is normal — the sweep dispatches it below — so only a
        // directive whose review run has CLOSED is recovered here, from the tasks that run queued
        // (or the deterministic fallback when it queued none).
        const directives = pendingDirectives(store, story.id);
        const interrupted = directives.filter((directive) =>
            store.runs
                .list()
                .some(
                    (run) =>
                        run.work_item_ref === `wi_directive_${directive.id}` &&
                        run.state !== 'spawning' &&
                        run.state !== 'working' &&
                        run.state !== 'reporting'
                )
        );

        if (interrupted.length > 0) {
            await store.commit('loop_directive_recovery', () => {
                for (const directive of interrupted) {
                    const runIds = store.runs
                        .list()
                        .filter((run) => run.work_item_ref === `wi_directive_${directive.id}`)
                        .map((run) => run.id);
                    const tasks = this.tasksQueuedBy(runIds);
                    const tasksCreated =
                        tasks.length > 0
                            ? tasks.length
                            : createDirectiveFallbackTasks(store, requireStory(store, story.id), directive);

                    completeDirective(
                        store,
                        directive.id,
                        { tasks_created: tasksCreated },
                        `the loop recovered ${directive.id} after its Editor review closed (D-19)`
                    );
                }
            });
        }

        // The drain probe's round: when its two runs have both closed, the round is judged and stored
        // BEFORE the decision, because the decision is what asks the question it answers (L-37.3).
        const probeRound = await this.judgeProbeRound(story, at);

        story = probeRound.story;

        // §4.15: settle any `pending` draft whose Writer is gone before the sweep measures the book.
        // The normal path is `settleJob` closing the run; this is the same gate for a draft written
        // after its run closed (a context-compaction continuation) or recovered after a restart.
        await this.reconcileDrafts(story.id);

        // §6.5's selection is also a SWEEP question, not only a settlement one: a process that died
        // between the last screening answer and the selection left a finished round with no winner,
        // and the rows are the whole state a restarted engine has (L-3).
        await this.trySelectSample(story.id);

        // T12/E: the failure escalation promises a recovery, and this is it. The Author clears the
        // row (clear-pending → `wontfix`, or an answered directive → `done`); the recorded wave in
        // its detail is the guard that makes the bump happen ONCE per cleared escalation, so a
        // sweep loop cannot climb the wave every interval. The bump lands BEFORE the exhaustion
        // check below, because a fresh wave is exactly what makes that check false and re-arms
        // generation with `wi_sample_<summary>_<round>_w<wave>_1`.
        await this.rearmSamplingWave(story.id);

        story = requireStory(store, story.id);

        // §6.4 step 3's one unrecoverable failure: a sampling round that spent its retry allowance
        // with no draft at all is a provider problem, and only the Author can change it. The row is
        // opened here (the sweep owns writes — `generateWork` is a pure read) and reused by title on
        // every later sweep, so the queue shows ONE question rather than a new one per interval.
        if (samplingExhausted(store, story)) {
            await store.commit('loop_sampling_escalation', () => {
                openSamplingFailureTask(store, requireStory(store, story.id));
            });
        }

        // G1 — the accepted-revision audit, and the plateau the audit proves. This is the loop's OTHER
        // no-progress stop: `samplingProgressOf` bounds the CANDIDATE ATTEMPTS of one round, while this
        // bounds the ROUNDS themselves, by counting what each accepted revision's own deep review raised
        // (F1's adversarial path — every candidate certifies the old fix and introduces nothing, so the
        // hill never reports a stall, while each accepted revision files a fresh blocking finding with new
        // wording). The write happens HERE, before the candidate list is built below, so the sweep that
        // proves the plateau is the sweep that stops buying samples — the guard is not a status line the
        // queue may ignore, and it lands before any sampler the settled verification would otherwise arm.
        await this.trackRevisionProgress(story.id, at);

        story = requireStory(store, story.id);

        // T6/R2d: the other phase-① failure the loop cannot work around by itself — an Editor
        // verification pass that closes without ever confirming or disputing the finding. The queue
        // stops buying passes once the budget is spent (`work.ts`'s verify loop), and this is the row
        // that tells the Author, so a silent run becomes a question instead of an endless sweep.
        // The same pass closes the row when the finding is decided (the Author's approve/dispute, or
        // the Editor finally answering), because a question must not outlive its answer.
        await this.escalateVerifyStall(story.id);

        // H2/R1 — the settlement half of the phase-① fix owners. A Researcher-owned `fix` task closes
        // when the Knowledge its grounding pass wrote lands on the ledger, and an exhausted one (or a
        // row whose owner has no phase-① job) becomes an Author question here. The opening half lives
        // in `work.ts:phase1FixPrerequisites`, which generation calls; this is the sweep's half, so a
        // late journal write or an Author edit closes the row without waiting for a job.
        await this.settleFixPrerequisites(story.id);

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
            probe.critic_item_id === null ||
            probe.reader_item_id === null
        ) {
            return { story, judged: false };
        }

        const stillRunning = [probe.critic_item_id, probe.reader_item_id].some((id) =>
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

    /**
     * Writes one decision as one commit: status, kind, reason, what it is blocked on, probe, completion.
     *
     * A decision that changed nothing writes NOTHING. This is not an optimisation: the Digest is
     * derived from the Story's journal events (D-12a/D-14), so a no-op `loop_decision` every sweep
     * made the Digest permanently stale and rebuilt it once a second even on a stopped Story. The
     * sweep is a timer, not a story change.
     */
    private async applyDecision(storyIn: Story, decision: StoryDecision, at: string): Promise<Story> {
        const story = requireStory(this.store, storyIn.id);
        const patch: Record<string, unknown> = {
            status: decision.status,
            pending_kind: decision.pending_kind,
            status_reason: decision.status_reason,
            blocked_on: decision.blocked_on,
            // §4.1's one-line human summary the loop maintains, in the shape the spec's example
            // gives ("7 chapters · act 2 has a hole · 3 setups unpaid").
            progress: this.progressLine(story),
            ...(decision.probe === undefined ? {} : { probe: decision.probe })
        };
        const current = story as unknown as Record<string, unknown>;
        const changed = Object.entries(patch).some(
            ([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value)
        );

        if (!changed && decision.completion === undefined) return story;

        await this.store.commit('loop_decision', () => {
            const fresh = requireStory(this.store, storyIn.id);

            if (changed) {
                this.store.stories.update(
                    fresh.id,
                    patch as Partial<Story>,
                    { run_ref: null, why: `sweep decision: ${decision.why} (L-1 step 3, D-2a)` },
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }

            // L-25: the proposal is the loop TELLING the Author the book is finished by its own
            // standards. Nothing closes until the Author accepts (L-26), and U-14's prompt needs the
            // counts, which the proposal carries.
            if (decision.completion !== undefined) {
                const latest = requireStory(this.store, story.id);

                this.store.stories.update(
                    latest.id,
                    { completion: decision.completion },
                    {
                        run_ref: null,
                        why: `the loop proposes completion (L-25); ${decision.completion.leftovers.findings} findings and ${decision.completion.leftovers.ideas} Ideas will be discarded (L-25b)`
                    },
                    [{ id: latest.id, rev: latest.rev }]
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

        // S-RUNTIME: the ceiling comparison, in the two shapes it now has.
        //
        // No view attached (a single-store server, every loop unit test): the book IS the workspace, so
        // this is exactly S-5's rule as written — this store's live rows against its own config.
        //
        // With a view (one engine per Story book): the limit comes from the one number the coordinator
        // owns, and the live count is the LARGER of this book's rows and the cross-book total the view
        // answers. The `max` is not decoration — the view counts what the books hold, and a row this
        // sweep has not seen yet (a commit two statements ago) is still a row, so undercounting here is
        // the direction that oversubscribes. The rows are created synchronously by the executor
        // (D-18), so a sweep of another book that launched after this one is already visible.
        const limit = this.ceiling?.limit() ?? this.config.globalMaxConcurrent;

        let used = Math.max(liveRuns(store).length, this.ceiling?.liveRuns() ?? 0);

        for (const entry of sorted) {
            if (used >= limit) break;
            if (isClaimedHere(store, entry.candidate.key, entry.story.id) || this.inflight.has(entry.candidate.key))
                continue;

            const perTemplate = liveRunsForTemplate(store, entry.story.id, entry.candidate.item.templateRef);

            if (perTemplate >= entry.candidate.max_concurrent) continue;

            // L-5: two loops must not EDIT the same artifact at once. Any live job already naming
            // this unit holds it, so the second one waits for the lease rather than racing the
            // compare-and-swap. Phase ①'s three non-editing kinds are the exception:
            //   * a `check_unit` critic pass only reads its draft and writes findings/verdicts;
            //   * a `sample_unit` run writes NOTHING (the engine persists its answer, §2 decision 2);
            //   * a `screen_samples` run writes nothing either (its review row is the engine's).
            // Every one of them names the same Summary unit, so without this exception a wider
            // capacity would serialize the whole sampling round behind its first sample.
            const unitRef = entry.candidate.item.unit?.ref;
            const criticPass = entry.candidate.item.kind === 'check_unit' && entry.candidate.item.roleName === 'critic';
            // SUMMARY PHRASE: `draft_groups` and `review_groups` join the non-editing exception (R4 —
            // disjoint group batches run CONCURRENTLY, and N reviewers read one Overview at once). A
            // group pass never races a group pass on the same GROUP: that is excluded from persisted Run
            // rows (`phrase/exclusion.ts:liveGroupRefs`), and the Summary unit it names is written through
            // the install, which re-reads its rows inside the commit rather than editing a cached copy.
            const structuredPass =
                entry.candidate.item.kind === 'sample_unit' ||
                entry.candidate.item.kind === 'screen_samples' ||
                entry.candidate.item.kind === 'draft_groups' ||
                entry.candidate.item.kind === 'review_groups' ||
                // READER SCORING (D-65): a scoring pass names the Summary unit and writes no artifact at
                // all — only `summary_scores` rows — so it neither races an editor nor may be queued
                // behind one. Same argument as the two group passes above.
                entry.candidate.item.kind === 'score_sections' ||
                // GROUP LOCK (R3/T6b): a judgement seat names the Summary unit and the ONE section it may
                // freeze, and the only row it writes is that section's lock flag. It writes no text, so it
                // cannot race an editing run over the Summary; and N seats on one clean vector (one per
                // section) are the point of the feature, so they must be dispatchable together. What keeps
                // two passes from freezing the same group is NOT the unit id — it is the guard
                // (`editor-lock.ts:editorLockGuardReason`, "already locked at revision …") and
                // `locks.ts:lockPhraseGroup`'s own `already_locked` refusal, both re-read in the commit.
                entry.candidate.item.kind === 'group_lock';

            if (unitRef !== undefined && unitRef.length > 0 && unitRef !== entry.story.id && !criticPass && !structuredPass) {
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
                { run_ref: null, why: `a reader is on chapter ${chapter.order} (§6.2's review crew)` },
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
     *     closure (L-16a); if the defect is actually still there, the next reader round re-files the same
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
        // H2/R1 — is this a grounding pass for a Researcher-owned `fix` task? Its product is Knowledge,
        // not an artifact, so completing it must NOT close the row it names: the row closes on the
        // EVIDENCE its run left on the journal (`settleFixPrerequisites`, and the answer check
        // `researchPrerequisiteAnswered` that gates it). A crew rule the live round proved the
        // difference with: when a run closing was the settlement, an exhausted prerequisite was
        // marked done by a pass that recorded nothing, and the round reported a fix it never made.
        // The attempt is still counted below, so the pass budget stays honest.
        const isGroundingPass = item.kind === 'research';
        // §6.4 steps 3-4: a no-tool run's product is its VALIDATED structured answer, and the engine
        // is what persists it (§2 decision 2 — the named exception D-12a makes for the Digest; the
        // Writer authored it, no tool wrote it). A failed run persists nothing, which is exactly
        // what re-arms the generation counter in work.ts (the attempt, not the revision, is spent).
        const persistedSample =
            item.kind === 'sample_unit' && closed && result.structured !== undefined ? result.structured : undefined;
        const persistedScreens =
            item.kind === 'screen_samples' && closed && result.structured !== undefined
                ? (result.structured as IssueList)
                : undefined;
        // ---------------------------------------------------------------------
        // SUMMARY PHRASE (R2/R3/R5) — the group passes, parsed BEFORE the commit.
        //
        // WHY BEFORE: a `GroupDraft` answer is validated against the JOB (the exact group set the batch
        // named), and the validator is a pure read. Deciding the outcome first means a refusal writes
        // only the task attempts below — never a half-installed batch — which is R2's atomicity rule
        // expressed as sequencing rather than as rollback.
        //
        // WHY `item.groupRefs` IS THE SOURCE OF THE EXPECTED SET: the same list the executor copied onto
        // the Run row (`run/executor.ts`) and the same list R4's exclusion reads from the live rows. A
        // restart settles the answer against the job that asked for it, not against whatever the book
        // looks like now (L-3).
        const isGroupPass = item.kind === 'draft_groups' || item.kind === 'review_groups';
        const groupDraft =
            item.kind === 'draft_groups' && closed && result.structured !== undefined
                ? parseGroupDraftAnswer(store, item.storyId, item.groupRefs ?? [], result.structured)
                : undefined;
        const groupReview =
            item.kind === 'review_groups' && closed && result.structured !== undefined
                ? parseGroupReviewAnswer(store, item.storyId, result.structured)
                : undefined;
        // ---------------------------------------------------------------------
        // READER SCORING (D-65) — the section-score answer, parsed BEFORE the commit for the same
        // reason the two group passes above are: the validator is a pure read, so a half answer or an
        // invented `group_ref` writes NOTHING rather than three rows of a five-section Summary.
        //
        // This is the whole state change the kind makes. A scoring pass files no finding, opens no task,
        // submits no verdict and touches no counter, so the only thing that can come out of it is the
        // five `summary_scores` rows below — which is what keeps P6 and G-2 intact: no score reaches the
        // criteria engine, the drain probe, the hill-climb or the sign-off gate.
        const sectionScores =
            item.kind === 'score_sections' && closed && result.structured !== undefined
                ? parseSectionScoreAnswer(store, item.storyId, result.structured)
                : undefined;
        // ---------------------------------------------------------------------
        // GROUP LOCK (R3/T6b) — the Editor's judgement, parsed BEFORE the commit for the same reason the
        // three passes above are: `parseGroupLockAnswer` is a pure read, so an answer that names a section
        // this seat was never shown, or gives no reason, writes NOTHING.
        //
        // THE SPLIT IS NOT ARBITRARY. This call answers only "is this a decision about the section the
        // seat was claimed for, and did the Editor give a reason?" — the contract
        // (`shared/schemas/group-lock.ts`) plus the seat's own identity, which the in-process validator
        // cannot see. Whether the book still allows the freeze (Setting, vector, clean revision, Writer
        // hold, unlocked) is answered a second later INSIDE the commit by
        // `editor-lock.ts:editorLockGuardReason`, because that state can move while an Editor thread sits
        // in the queue. Contract first, state second, one sentence each.
        const groupLock =
            item.kind === 'group_lock' && closed && result.structured !== undefined
                ? parseGroupLockAnswer(store, item.storyId, item.groupRefs?.[0] ?? '', result.structured)
                : undefined;
        // The sentence a HELD task reports, so the row says what it is waiting for instead of going
        // quietly. Computed once: an invalid answer and a refused batch are different refusals, and the
        // Author reads this string in the task's history.
        const groupHold =
            groupDraft !== undefined && !groupDraft.ok
                ? `its Writer answer was refused whole (${groupDraft.refusal})`
                : groupReview !== undefined && !groupReview.ok
                  ? `its Critic answer was refused whole (${groupReview.refusal})`
                  : closed
                    ? 'a revision was written, but the evidence that closes the row is the FINDING being resolved group by group (R3)'
                    : `run ${result.runId} ended ${result.ended}`;

        await store.commit('loop_job_result', () => {
            for (const ref of item.taskRefs ?? []) {
                const task = store.tasks.get(ref);

                if (task === undefined) continue;

                // H2/R1: a grounding pass spends its attempt and leaves the row `open`. The
                // prerequisite settles on the Knowledge its pass recorded — `settleFixPrerequisites`
                // below, gated by `researchPrerequisiteAnswered` — never because a run completed. The
                // row's own `attempts` is only the mirror of the journal-derived pass counter.
                // SUMMARY PHRASE (R3): a group pass holds EVERY task it was handed. The generic write
                // below closes a row because a run finished, and for this family "a run finished" is not
                // the done condition — the done condition is the FINDING the row names being resolved in
                // every group it targets, which only becomes true after the install and the closure pass
                // further down. So the attempt is spent here, and the row itself is consumed (or left
                // open with the reason) after the install, where the post-write state is visible.
                if (isGroupPass) {
                    store.tasks.update(
                        task.id,
                        { attempts: (task.attempts ?? 0) + 1 },
                        {
                            run_ref: item.id,
                            why: `run ${item.id} spent a group pass on ${task.id}; the row stays open until ${groupHold} (R2, R3)`
                        },
                        [{ id: task.id, rev: task.rev }]
                    );

                    continue;
                }

                const settledByEvidence = isGroundingPass && isResearchPrerequisiteFix(task);

                store.tasks.update(
                    task.id,
                    settledByEvidence
                        ? { attempts: (task.attempts ?? 0) + 1 }
                        : { state: closed ? 'done' : 'open', attempts: (task.attempts ?? 0) + 1 },
                    {
                        run_ref: item.id,
                        why: settledByEvidence
                            ? `run ${item.id} spent a grounding pass on ${task.id}; the row stays open until a pass records the fact (T-10, H2/R1)`
                            : closed
                              ? `run ${item.id} finished the work this task named; the queue consumed it (D-11, L-2)`
                              : `run ${item.id} ended ${result.ended}; the task is open again with one more attempt (L-15, L-3)`
                    },
                    [{ id: task.id, rev: task.rev }]
                );
            }

            if (isFixPass) {
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
            }

            // §4.15, the draft gate: a revision exists as `pending` while its Writer is working on
            // it. The run is closed now, so the draft is either complete enough to review
            // (`drafted`) or it stays `pending` for `reconcileDrafts`/a later Writer pass. PHASE ①'s
            // `write_unit` no longer exists (its samples are persisted `drafted` by the branch
            // below), so this gate serves phases ②/③ only. Only `drafted` rows reach Critics,
            // Readers and the Editor — a reviewer never reads a half-written artifact.
            if (item.kind === 'write_unit') {
                // The run's own draft (`run_ref`) or the draft its unit names: a completion run
                // extends an older `pending` row, so it keeps that row's original `run_ref` while
                // its Work Item names the summary it is finishing.
                const unitRef = item.unit?.ref ?? '';

                for (const revision of store.revisions.list()) {
                    if (revision.story_id !== item.storyId) continue;
                    if (revision.unit_ref !== unitRef && revision.run_ref !== result.runId) continue;
                    if (revision.state !== 'pending') continue;

                    const missing =
                        revision.unit_kind === 'summary' ? missingSummaryBlocksOf(revision) : ([] as string[]);

                    if (missing.length > 0) continue;

                    store.revisions.update(
                        revision.id,
                        { state: 'drafted' },
                        {
                            run_ref: result.runId,
                            why: `the Writer run ${result.runId} closed and its ${revision.unit_kind} draft is complete, so it is handed to the review crew (§4.15)`
                        },
                        [{ id: revision.id, rev: revision.rev }]
                    );
                }
            }

            // §6.4 step 3: the sample becomes a `drafted` revision in the SAME commit that closes the
            // run, so a restart sees either both or neither (P1). `round`/`origin` are what the
            // selector and the compiled prompt read: round 1 is the First Revision's round.
            if (persistedSample !== undefined && item.unit !== undefined) {
                const round = item.round ?? 1;

                store.revisions.create(
                    {
                        story_id: item.storyId,
                        unit_kind: 'summary',
                        unit_ref: item.unit.ref,
                        // A Summary revision's body is a field set (§4.15 leaves `body` open, and
                        // `renderSummaryBody` reads `{fields}` — the one shape the compiler and the
                        // selector both understand).
                        body: { fields: persistedSample },
                        run_ref: result.runId,
                        template_ref: item.templateRef,
                        ...(result.promptHash === undefined ? {} : { prompt_hash: result.promptHash }),
                        state: 'drafted',
                        round,
                        origin: round === 1 ? 'sampled' : 'refined',
                        verdict_refs: []
                    },
                    loopAttr(
                        `run ${result.runId} answered sampling round ${round} (sample ${item.sampleIndex ?? 1}) with a schema-valid SummarySample; the engine persisted it as a draft (§2 decision 2, §6.4 step 3)`
                    )
                );
            }

            // §6.4 step 4: one screening answer becomes one `sample_reviews` row. These are NOT
            // findings (they never enter D-33/D-34 and cannot block a Writer): they rank the round's
            // samples and seed the deep review's brief.
            if (persistedScreens !== undefined && item.revisionRef !== undefined) {
                // H1: the row also carries the fix certificate — the ids this Worker was handed
                // (`fix_refs`, from the Work Item rather than from the answer, so a partial answer
                // cannot silently drop a demand) and the per-fix statuses it actually answered.
                // `sampleFixDemand` uses the first to tell "no pass carried this fix" from "this pass
                // carried it and said nothing", and grades an incomplete answer as `unknown`.
                // Pre-H1 rows carry neither field, which grades as legacy (unverified).
                store.sampleReviews.create(
                    {
                        story_id: item.storyId,
                        revision_ref: item.revisionRef,
                        critic: item.roleName,
                        issues: persistedScreens.issues ?? [],
                        valid: true,
                        fix_refs: [...(item.fixRefs ?? [])],
                        ...(persistedScreens.fix_verifications === undefined
                            ? {}
                            : { fix_verifications: persistedScreens.fix_verifications })
                    },
                    loopAttr(
                        `run ${result.runId} answered with a schema-valid IssueList for ${item.revisionRef}; the engine persisted it as a screening review (§2 decision 2, §6.4 step 4)`
                    )
                );
            }

            // -----------------------------------------------------------------
            // SUMMARY PHRASE R2 + R5 + R6 — the group install, in the SAME commit that closes the run.
            //
            // One accepted Writer answer becomes: one new `latest` row PER GROUP it wrote (numbered from
            // that group's own line), the rows it replaces flipped to `archived` and retained, the
            // Overview recomposed from the rows as they now are, and the legacy `summaries` prose fields
            // rewritten from the same texts (R6's mirror). A group the batch did not name keeps its text
            // and its number untouched — that is R2's "one group's work never revises another's", and it
            // is why the batch, not the Story, is the unit of the commit.
            //
            // There is no selection step: R5 removed whole-Summary sampling from this path, so an accepted
            // result installs immediately and the previous text becomes history in the same write.
            if (groupDraft !== undefined && groupDraft.ok) {
                const fresh = requireStory(store, item.storyId);
                const install = installGroupRevisions(
                    store,
                    fresh,
                    groupDraft.contents,
                    loopAttr(
                        `run ${result.runId} answered the group draft job for ${groupDraft.contents.length} group(s); the engine installed each text as that group's next revision and archived the text it replaces (R2, R5)`
                    ),
                    {
                        runRef: result.runId,
                        workItemRef: item.id,
                        taskRefs: [...(item.taskRefs ?? [])],
                        findingRefs: [...(item.findingRefs ?? [])],
                        knowledgeUsed: groupDraft.knowledgeUsed,
                        ...(result.promptHash === undefined ? {} : { promptHash: result.promptHash })
                    }
                );

                // R3 — CLOSURE ON EVIDENCE. A finding closes only when EVERY group it targets has a
                // revision written to answer it (`phrase/findings.ts:findingResolution`), and only an
                // `approved` row can close at all, so a finding still sitting behind D-34's sign-off is
                // left where the Author put it. A multi-group finding whose batch covered three of five
                // targeted groups therefore stays `approved` with three groups resolved, and the next
                // batch is pointed at the two it still owes.
                const closedFindings = new Set<string>();

                for (const ref of item.findingRefs ?? []) {
                    const finding = store.findings.get(ref);

                    if (finding === undefined) continue;

                    const outcome = closeFindingWhenGroupsResolved(
                        store,
                        finding,
                        loopAttr(
                            `the group install of run ${result.runId} left every group this finding targets with a revision written to resolve it (R3, D-34)`
                        )
                    );

                    if (outcome.closed) closedFindings.add(finding.id);
                }

                // R3 — THE TASKS FOLLOW THE FINDINGS, in the same settlement. The rows were held above;
                // each one closes here only on evidence the book can now show: either the finding it
                // names is `fixed`, or it names no finding at all (a hand-armed row) and a revision row
                // exists that was written in answer to it. A row whose finding is still open stays open
                // with its attempt spent, which is what makes "the Writer tried and the defect survived"
                // a visible streak rather than a silent loop.
                const answeredTasks = new Set(install.installed.flatMap((revision) => revision.task_refs ?? []));

                for (const ref of item.taskRefs ?? []) {
                    const task = store.tasks.get(ref);

                    if (task === undefined || task.state === 'done') continue;

                    const finding = task.finding_ref === undefined ? undefined : store.findings.get(task.finding_ref);
                    const evidence =
                        finding !== undefined
                            ? finding.state === 'fixed'
                            : answeredTasks.has(task.id) && closedFindings.size === 0;

                    if (!evidence) continue;

                    store.tasks.update(
                        task.id,
                        { state: 'done' },
                        {
                            run_ref: item.id,
                            why:
                                finding === undefined
                                    ? `the group revision installed by run ${item.id} names ${task.id}, and no finding is left unresolved by the batch — the queue consumed it (R2, R3, D-11)`
                                    : `the group install of run ${item.id} resolved ${finding.id} in every group it targets, so the task that named it is consumed (R3, D-11, D-34)`
                        },
                        [{ id: task.id, rev: task.rev }]
                    );
                }

                // R6's mirror can be SKIPPED, and both reasons are the Author's, not the loop's: the
                // Summary is `locked` (L-7a/P5 — prose the Author signed is not rewritten under them) or
                // the Story has no `summaries` row at all. Neither is a fault, so nothing is written here;
                // the projection reports `mirror.written: false` with the reason, and the group rows stay
                // the truth either way.
            }

            // -----------------------------------------------------------------
            // SUMMARY PHRASE R3/R5 — the group review's answer. A structured Critic pass has no tools, so
            // its product is the review ROW, exactly as a legacy screen's was; the difference is that the
            // artifact in front of the Critic is the INSTALLED Overview (there is no draft set to rank),
            // so `revision_ref` names the Phrase row rather than a Summary revision. Each issue carries
            // the `group_refs` the Critic was shown, which is what makes a later finding attributable to
            // the groups it is actually about.
            if (groupReview !== undefined && groupReview.ok) {
                const phrase = storyPhrase(store, item.storyId);

                store.sampleReviews.create(
                    {
                        story_id: item.storyId,
                        revision_ref: phrase?.id ?? (item.groupRefs ?? [])[0] ?? item.storyId,
                        critic: item.roleName,
                        issues: groupReview.review.issues ?? [],
                        valid: true,
                        fix_refs: [...(item.fixRefs ?? [])],
                        ...(groupReview.review.fix_verifications === undefined
                            ? {}
                            : { fix_verifications: groupReview.review.fix_verifications })
                    },
                    loopAttr(
                        `run ${result.runId} answered with a schema-valid GroupReview over ${item.groupRefs?.length ?? 0} group(s); the engine persisted it as a review of the installed Overview (§2 decision 2, R3, R5)`
                    )
                );
            }

            // -----------------------------------------------------------------
            // SUMMARY PHRASE D-67 — the CLEAN STAMP, in the same commit that closes the deep pass.
            //
            // WHY THIS SEAT AND THIS MOMENT: `check_unit` under a `wi_group_check_<vectorHash>_<pass>`
            // claim is the group model's tool-carrying cross-group Critic (§6.4 step 6, R5) — the only
            // group-model review that files real Findings, through `tools/reader.ts:raiseFinding`. Its
            // close is therefore the first instant at which "this Critic read this combination of five
            // texts and found no defect on this group" is a fact the book can show, and the finding
            // rows it filed are already committed (a tool writes in its own commit, before the settle).
            // The tool-less `review_groups` seat is NOT a stamper: its answer is a list of notes, and
            // reading "no note" as a clean verdict would certify text nothing ever tried to break.
            //
            // WHY IN THIS COMMIT: the stamp is the pass's product. Writing it after the commit would let
            // a crash between the two leave a closed review that reported nothing, and the seat's claim
            // key is spent (`runsForItem` counts closed runs), so the vector would never be reviewable
            // again. One commit means a restart either sees the verdict or owes the pass.
            //
            // `phrase/reviewed.ts:stampCleanRevisions` owns the rules (per-group open-issue check, the
            // vector-moved guard, idempotence); this call site only decides WHICH run's close counts,
            // and it reads the seat family off the claim key so a legacy `'sampling'` deep review
            // (`wi_review_<revision>_a<pass>`, §16) stamps nothing — the hash reader answers `''`.
            if (item.kind === 'check_unit' && closed && groupCheckVectorHashOf(item.id) !== '') {
                const stampedFor = requireStory(store, item.storyId);

                if (isGroupManagedStory(stampedFor)) {
                    stampCleanRevisions(
                        store,
                        stampedFor,
                        { seatKey: item.id, runRef: result.runId },
                        loopAttr(
                            `run ${result.runId} closed the cross-group review claimed on ${item.id}; every group of that vector whose read came back with no unresolved defect is stamped Clean (D-67)`
                        )
                    );
                }
            }

            // -----------------------------------------------------------------
            // READER SCORING (D-65) — the five rows, in THIS ONE commit.
            //
            // ONE COMMIT, NOT FIVE, because the rail reads the set: a partial write would show a Summary
            // with four scores and a missing section, which is the exact state the parse exists to refuse.
            // Nothing else moves here — no verdict, no task, no finding, no counter. A refused answer
            // writes NO rows and its closed run spends the claim (`loop/work.ts:runsForItem` counts CLOSED
            // runs whatever the outcome), so that vector stays unscored until the next install re-arms it.
            //
            // `vector_hash` comes off the CLAIM KEY, not from the rows read now: the score describes the
            // Overview the Reader was shown, and a Writer install during the pass would otherwise re-stamp
            // an old judgement onto a new book (`phrase/exclusion.ts:sectionScoreVectorHashOf`).
            if (sectionScores !== undefined && sectionScores.ok) {
                const phrase = storyPhrase(store, item.storyId);
                const vectorHash = sectionScoreVectorHashOf(item.id);

                for (const scored of sectionScores.scores) {
                    store.summaryScores.create(
                        {
                            story_id: item.storyId,
                            phrase_id: phrase?.id ?? scored.group.phrase_id,
                            vector_hash: vectorHash,
                            group_id: scored.group.id,
                            group_key: scored.group.key,
                            score: scored.score,
                            rationale: scored.rationale,
                            evidence: scored.evidence,
                            run_ref: result.runId,
                            work_item_ref: item.id
                        },
                        loopAttr(
                            `run ${result.runId} scored ${scored.group.key} ${scored.score}/100 at vector ${vectorHash}; the engine persisted the Reader's answer (D-65, display-only)`
                        )
                    );
                }
            }

            // -----------------------------------------------------------------
            // GROUP LOCK (R3/T6b) — the Editor's freeze, applied in THIS ONE commit.
            //
            // WHAT MOVES: exactly one row — the section's `locked` / `locked_revision` / `locked_by` /
            // `locked_at` — plus the open-claim closure `phrase/locks.ts` performs when a lock retires the
            // claims that asked for this text to change. No verdict, no task, no counter, no draft, no
            // finding: the seat is a judgement, and the flag it leaves is the whole product. That is what
            // keeps P6 and G-2 intact: the lock is not a criterion signal, and it never enters the drain
            // probe, the sign-off gate or the hill-climb.
            //
            // WHY THE GUARD IS RE-RUN HERE, one line above the write: `item` was queued whenever the
            // generator ran, and an Editor pass is a thread that may sit in the queue for a whole capacity
            // window. In that window the Author may flip `editor_group_locking` off, lock or rewrite the
            // section by hand, or have a Writer install land under the pass — and a lock fixes a REVISION,
            // so executing a judgement about a book that no longer exists would freeze words nobody judged.
            // The guard is the cheap, sentence-returning half; `lockPhraseGroup` re-checks the same state
            // and throws `PhraseLockRefusal` before writing, so the pair cannot leave a half-applied lock.
            //
            // WHY EVERY REFUSAL WRITES NOTHING AND CORRUPTS NOTHING: the answer was refused (a contract
            // problem), the guard refused (the state moved), or the domain refused (its own CAS sees a
            // newer row). None of them throws out of the settle: the run is already CLOSED, so the seat's
            // one-per-vector claim is spent and the section simply stays unlocked — the generator re-arms a
            // seat for the NEXT clean selection, because the key IS that selection's hash. The record is
            // the Run row itself (its persisted answer carries `lock` and the rationale), exactly as a
            // refused score row is recorded by the pass that asked for it (D-65's rule).
            if (groupLock !== undefined && groupLock.ok && groupLock.decision.lock) {
                const locking = requireStory(store, item.storyId);
                const refused = editorLockMayLock(store, locking, item.id, groupLock.decision);

                if (refused === undefined) {
                    try {
                        // `phrase/locks.ts` takes the ATTRIBUTION and the ACTOR separately (the attribution
                        // is the journal sentence the Author reads, the actor is who the flag records), and
                        // it re-validates the whole state itself before writing — which is why the guard
                        // above is a fast, sentence-returning read rather than the enforcement.
                        lockPhraseGroup(
                            store,
                            locking,
                            groupLock.decision.group_ref,
                            // D-15/§4.17: the journal line carries the Editor's own reason first, so the
                            // Author reads the judgement — not a generic "locked by the loop".
                            loopAttr(`run ${result.runId}: ${groupLock.decision.rationale}; the Editor's judgement pass closed ${groupLock.decision.group_ref} as finished text (R3)`),
                            { actor: 'editor' }
                        );
                    } catch (error) {
                        // A `PhraseLockRefusal` is a ROUTINE outcome of racing the Author or a Writer, it
                        // threw before writing, and its commit rolled back; anything else — a store CAS
                        // conflict above all — must keep carrying the retry's stack and frame.
                        if (!isPhraseLockRefusal(error)) throw error;
                    }
                }
            }
        });

        if (item.kind === 'directive_work') await this.settleDirectiveReview(item, result);

        // §6.5/§6.6: a sample or a screen landing may be the last thing the in-flight round owed.
        // The check runs AFTER the settle commit, so the selector reads the row this run produced.
        if (item.kind === 'sample_unit' || item.kind === 'screen_samples') await this.trySelectSample(item.storyId);
    }

    /**
     * §6.5/§6.6 — the deterministic sample selection, committed as ONE record write per row.
     *
     * WHEN IT RUNS: after every `sample_unit`/`screen_samples` settlement, and once per sweep (so a
     * restart that died between the last screen and the selection still finishes the round — L-3's
     * "the rows are the state"). Every clause below is a store question:
     *
     *   * the in-flight round `R = (sampling_round ?? 0) + 1` has at least one revision;
     *   * no revision of R is already `selected` (a selection is idempotent, never repeated);
     *   * at least one DRAFTED revision exists (zero => total sampling failure, which the generation
     *     escalation covers; selecting nothing is not selecting the best of nothing);
     *   * the round is COMPLETE or its sampling is spent (T12/D): `roundRevisions(R).length >=
     *     samplingSizeOf` OR the round's SAMPLE attempts (current wave) reached `samplingCapOf`.
     *     Without the second half, one failed sample bought a selection over the survivors while
     *     the round still owed samples the sweep had not dispatched yet;
     *   * every drafted revision is SCREENED (T12/C): its review set is full, OR its screening
     *     attempts reached `screeningCapOf` — the degrade path that keeps a broken screening provider
     *     from dead-stalling the Story;
     *   * no live `wi_sample_*`/`wi_screen_*` run remains — a round still growing must not be
     *     truncated under a draft nobody screened.
     *
     * WHAT THE COMMIT DOES, in §6.6's order: when any drafted revision was screened only PARTIALLY,
     * open ONE Author escalation saying so (T12/C — the selection proceeds, and the Author is told; a
     * silent degrade would hide a provider fault), install the winner's six prose fields on the
     * Summary (NEVER `chapter_count` — Author truth, D-3b), mark the winner `selected` with its issue
     * counts, append the `sampling_history` line (the P11 audit, written before the deletes),
     * hard-delete every other revision of the round and every review pointing at one (P13/D-22's
     * truncation as the request asks), consume the open `fix` tasks the round's prompt carried, and
     * advance `sampling_round`.
     */
    private async trySelectSample(storyId: string): Promise<void> {
        const store = this.store;
        const story = requireStory(store, storyId);

        if (story.phase !== 'summary') return;

        // SUMMARY PHRASE R5: a group-managed book has no draft SET to select from. Its Writer result is
        // installed the moment it is accepted (`phrase/revisions.ts:installGroupRevisions`) and the
        // previous text is archived in the same commit, so "pick the best of N" has nothing to rank and a
        // selection here would install a `revisions` row that does not exist.
        if (isGroupManagedStory(story)) return;

        const summary = storySummary(store, story.id);

        if (summary === undefined) return;

        const round = (story.sampling_round ?? 0) + 1;
        const revisions = roundRevisions(store, story.id, round);

        if (revisions.length === 0) return;
        if (revisions.some((revision) => revision.state === 'selected')) return;

        const drafted = revisions.filter((revision) => revision.state === 'drafted');

        if (drafted.length === 0) return;

        // T12/D: the round may not select while it still OWES samples. `samplingSizeOf` is what the
        // Author asked for; the wave's budget is the only honest way to give up on the rest, and
        // T6/R2b's third way a round stops owing samples (`records.ts:samplingLegClosed`) now reads that
        // SAME budget, so the selection gate, the work queue and the drain probe cannot disagree.
        //
        // T6/round-3 fix #3, and requirement 9 — the attempt count is no longer read off a `pending`
        // sampling job (that row is deleted the moment the sample's run closes, so an exhausted wave
        // re-bought samples forever), and it is no longer guessed. `records.ts:samplingProgressOf`
        // derives the whole hill state from the ledger on EVERY read — the wave's attempts through the
        // sample runs' wave-scoped claim keys (`Revision.run_ref` → `work_item_ref`), the lowest
        // unresolved-blocking count any regression-free candidate proved as the BASELINE, one extra
        // attempt per measured improvement, and `SAMPLING_NO_PROGRESS_STREAK` consecutive attempts that
        // failed to lower it (requirements 5 and 6). The engine keeps no memory, so a restart recomputes
        // exactly these numbers and a wave that spent its budget stays spent.
        const size = samplingSizeOf(story);
        const progress = samplingProgressOf(store, story, round);

        if (revisions.length < size && !progress.spent && !samplingLegClosed(store, story, round)) return;

        const critics = screeningSizeOf(story);

        // T12/C: a draft is screened when it carries its full review set OR its screening attempts are
        // exhausted (`records.ts:isFullyScreened`). The second clause is the degrade path: the round
        // still selects, on the reviews it has, instead of waiting forever on a provider that will
        // not answer the schema — and the commit below reports the partial set to the Author.
        if (drafted.some((revision) => !isFullyScreened(store, story, revision.id))) return;

        // A round still growing must not be truncated under a draft nobody screened (§6.4 step 4).
        if (liveRuns(store, story.id).some((run) => PHASE1_PIPELINE_RUN.test(run.work_item_ref ?? ''))) return;

        // The drafts whose review set is short of `critics` but whose attempts are spent — named in
        // the escalation the commit opens, so the Author can see WHICH samples went in partially
        // screened (the ids still exist at that point; the truncation below deletes the losers).
        const partiallyScreened = drafted
            .filter((revision) => screensFor(store, revision.id).length < critics)
            .map((revision) => revision.id);

        // ----------------------------------------------------------------------------------------------
        // The hill, stated once in `records.ts` so the queue and the selection cannot disagree (R3).
        //
        // Requirements 2, 3, 5, 6, 7. An accepted Summary Revision is a STATE, never an issue list to
        // out-score: every candidate of a refinement round is scored against THE TEXT THE AUTHOR SIGNED
        // (`roundSampleScores` → `acceptedSummaryRevision`), and the only questions about it are whether
        // it fixed what was demanded of it and whether it introduced a new critical/major OF ITS OWN.
        // Issues the accepted draft already carried are `inherited` and cost the candidate nothing; an
        // item that claims `inherited` with no base to inherit from — or states no origin at all — counts
        // as introduced, so an unclassified defect fails CLOSED (`sample-select.ts:scoreSample`).
        //
        // `roundInstallableCandidate` is the whole install rule, and it is the ratchet this change
        // removes:
        //   * WITH an accepted base, the round selects from the ELIGIBLE set or from NOTHING. §6.5's
        //     least-bad path used to install the least-bad draft of a failed round over the Author's
        //     signed text AND close the fix tasks that draft failed — the loop running backwards. Now the
        //     incumbent keeps the Summary, every demanded fix task keeps its demand, and nothing closes.
        //   * WITHOUT a base (round 1) the least-bad path stays, with the T12/C degrade it leans on (R5):
        //     nothing exists yet to be worse than, so the First Revision is the best of what the seed
        //     produced. A refinement round whose fix tasks the Author has since settled (H1-C1/F1) does
        //     NOT need least-bad either — its candidates are eligible once nothing is demanded of them.
        //
        // So `installable === undefined` is a normal answer, not a stall to work around here: the
        // screening rows stay, `work.ts` offers another Sampling unit while the wave keeps proving a
        // LOWER unresolved count (requirement 6), and a spent wave — ceiling or streak — is reported by
        // the sweep's exhaustion path above (`samplingExhausted` → `openSamplingFailureTask`), which
        // counts the attempts the wave ACTUALLY spent. There is no automatic re-arm: only the Author
        // clearing that escalation bumps `sampling_wave`, and because every number above is wave-scoped,
        // a fresh wave IS a fresh baseline (requirement 8).
        // ----------------------------------------------------------------------------------------------
        const scored = roundSampleScores(store, story.id, round);
        const installable = roundInstallableCandidate(store, story.id, round);

        if (installable === undefined) return;

        // The install attribution says which rule installed it: a certified step of the climb, or §6.5's
        // least-bad choice in the one round that had no state to protect.
        const winner = installable.eligible ? installable : undefined;

        await store.commit('loop_sample_selection', () => {
            // Re-read everything the commit rewrites: the settle commit that led here may have moved
            // rows, and T-4's compare-and-set is what makes the writes an honest transaction.
            const fresh = requireStory(store, story.id);
            const freshSummary = storySummary(store, fresh.id);
            // The STATE this round installs. When `winner` is set it is a candidate that certified every
            // fix demanded of it and introduced no new critical/major of its own — a step up the hill.
            // When it is not, this is §6.5's least-bad pick, which requirement 7 allows ONLY in a round
            // with no accepted state to protect. Nothing here is cached: the budget that led to this
            // commit is re-derived from the ledger every pass (`records.ts:samplingProgressOf`), so a
            // restart cannot buy an attempt the wave already spent.
            const current = store.revisions.get(installable.revision.id);

            if (freshSummary === undefined) return;
            if (current === undefined || current.state !== 'drafted') return;

            // T12/C: the round went in on a partially screened set. ONE escalation row for the
            // Author (reused by round+prefix, so a re-run cannot stack a second), stating what
            // happened and that the selection proceeded — the Story keeps moving, and the provider
            // fault is still reported rather than hidden.
            if (partiallyScreened.length > 0) openScreeningExhaustionTask(store, fresh, round, partiallyScreened);

            const at = new Date().toISOString();
            const fields = summaryFieldsOf(current.body);
            const patch: Partial<Summary> = {};

            // §4.2's six prose blocks, and NOTHING else: `chapter_count` is the Author's declaration
            // (D-3b) and a sample never carries it (the schema omits it on purpose).
            for (const key of SUMMARY_PROSE_KEYS) {
                const value = fields[key];

                if (typeof value === 'string' && value.trim().length > 0) patch[key] = value;
            }

            if (Object.keys(patch).length > 0) {
                store.summaries.update(
                    freshSummary.id,
                    patch,
                    loopAttr(
                        `sampling round ${round} installed ${current.id}'s fields on ${freshSummary.id} (${
                            winner
                                ? 'the state that certified every fix demanded of it and introduced no new critical/major over the accepted Summary — the hill climbed one step (D-34, §6.5)'
                                : "round 1: no accepted state existed, so §6.5's least-bad ranking chose the First Revision (requirement 7 keeps this path only there)"
                        })`
                    ),
                    [{ id: freshSummary.id, rev: freshSummary.rev }]
                );
            }

            store.revisions.update(
                current.id,
                { state: 'selected', issue_counts: { critical: installable.critical, high: installable.high } },
                loopAttr(
                    installable.refinement
                        ? `sampling round ${round}'s winner: ${installable.fixesCleared.length} of ${installable.fixRefs.length} demanded fix task(s) certified by every pass handed them, ${installable.blockingIntroduced} new critical/major on the accepted draft (it inherited ${installable.inheritedCritical + installable.inheritedHigh}), ${installable.minimality.changedFields} field(s) and ${installable.minimality.changedCharacters} character(s) changed (the hill: fewest unresolved fixes → no new critical/major → smallest change → earliest candidate; §6.5, §6.6)`
                        : `sampling round ${round}'s winner: ${installable.critical} critical, ${installable.high} high, ${installable.total} total (§6.5: fewest critical → fewest high → fewest total → earliest)`
                ),
                [{ id: current.id, rev: current.rev }]
            );

            // §6.6's audit line, built BEFORE the losers are deleted so it can name them.
            //
            // H1/R4 adds `unresolved_fixes` to every sample line, and the hill adds the REST of the
            // candidate's outcome: whether it was accepted, eligible-but-not-chosen, or rejected, the
            // reason, the blocking issues it introduced vs inherited, and how much of the accepted text
            // it changed. The selection truncates every losing draft AND its screening reviews, so
            // without these fields the reason a candidate was refused — the evidence, not a score — is
            // deleted with it, and a REJECTED attempt, which closed no task and advanced no round, would
            // leave no trace that the attempt happened at all.
            // Requirement 4: the audit names EVERY attempt the wave made — the drafts that came with the
            // round AND the ones the retry allowance bought — because `roundSampleScores` scores every
            // `drafted` Revision of the round, gradeable or not. A rejected or ungradeable attempt closed
            // no task and advanced no round, so after the truncation below deletes its draft and its
            // screening rows, this line is the only trace that the attempt happened at all. The hill's
            // numbers ride with it: the wave, the attempts it spent, the improvements it proved, the
            // ceiling that bounded it, and the unresolved-blocking bar this install leaves behind
            // (requirement 2 — only a strictly lower count buys another attempt).
            const history = [
                ...(fresh.sampling_history ?? []),
                {
                    round,
                    at,
                    wave: progress.wave,
                    attempts: progress.attempts,
                    improvements: progress.improvements,
                    ceiling: progress.ceiling,
                    unresolved_blocking: installable.fixesUnresolved.length,
                    samples: scored.map((sample) => ({
                        revision_id: sample.revision.id,
                        critical: sample.critical,
                        high: sample.high,
                        valid: sample.screenedValid,
                        unresolved_fixes: sample.fixesUnresolved,
                        outcome:
                            sample.revision.id === current.id
                                ? ('accepted' as const)
                                : sample.eligible
                                  ? ('eligible' as const)
                                  : ('rejected' as const),
                        ...(sample.rejectReason === undefined ? {} : { reject_reason: sample.rejectReason }),
                        ...(sample.refinement
                            ? {
                                  introduced_critical: sample.introducedCritical,
                                  introduced_high: sample.introducedHigh,
                                  inherited_critical: sample.inheritedCritical,
                                  inherited_high: sample.inheritedHigh,
                                  changed_fields: sample.minimality.changedFields,
                                  changed_characters: sample.minimality.changedCharacters
                              }
                            : {})
                    })),
                    selected: current.id
                }
            ];

            // Truncation is HARD (P13/D-22 as the request asks): the losers and their reviews are
            // deleted, and the history line above is the only surviving record of what competed.
            //
            // T6/R2c widens the set to the older rounds' leftovers. A draft that was still being
            // screened when an EARLIER selection ran escaped that commit's truncation — it was not in
            // that round's candidate set — and nothing else ever removes it, so it sat in the ledger as
            // a `drafted` orphan: owed screening nobody could answer, and the owner of every finding
            // raised against it. `isReviewableDraft` keeps a `pending` draft (a Writer still writing,
            // §4.15) out of the set, and the newest `selected` row (`current.id`) is never retired.
            const retired = summaryRevisions(store, fresh.id).filter(
                (revision) =>
                    revision.id !== current.id && isReviewableDraft(revision) && (revision.round ?? 1) <= round
            );
            const retiredIds = new Set(retired.map((revision) => revision.id));
            // Every summary revision that survives this commit. A finding is retired by a deleted draft
            // only when it names NO surviving draft — otherwise it is also a statement about a text the
            // Summary still holds, and L-11a's whole-Summary findings (no refs at all, or a ref that is
            // not a draft) are nobody's property and must never be dropped silently.
            const survivingIds = new Set(
                summaryRevisions(store, fresh.id)
                    .filter((revision) => !retiredIds.has(revision.id))
                    .map((revision) => revision.id)
            );
            const ownedByRetired = (finding: Finding) => {
                const named = finding.related_refs ?? [];

                return named.some((ref) => retiredIds.has(ref)) && !named.some((ref) => survivingIds.has(ref));
            };

            for (const loser of retired) {
                for (const review of screensFor(store, loser.id)) {
                    store.sampleReviews.delete(
                        review.id,
                        loopAttr(`sampling round ${round} truncated ${loser.id}; its screening review goes with it (§6.6)`)
                    );
                }

                store.revisions.delete(
                    loser.id,
                    loopAttr(
                        `sampling round ${round} selected ${current.id}; ${loser.id} was a draft no round would pick up again, so it is truncated with the losers, not kept (§6.6, P13)`
                    )
                );
            }

            // T6/R2c, the second half: the DEFECTS those drafts carried. A confirmed or approved
            // finding that named only a retired draft is a claim about a text the Summary no longer
            // holds, and the open fix task it raised promises work on that same text. Left alone, the
            // task alone holds the phase sign-off forever (`status.ts:phaseWorkQueued` counts every
            // dispatchable task), so the loop would judge the defect, act on it, and stop before
            // finishing it — the L-37 condition 1 hold with nothing behind it.
            //
            // `discarded` is §4.10's word for a defect that will not be acted on and the idiom
            // `acceptCompletion` already uses; the finding row stays (the audit keeps it), and the
            // task's `why` says which draft carried it. A finding that also names a surviving draft,
            // or names no draft at all, keeps its state untouched.
            for (const finding of storyFindings(store, fresh.id)) {
                if (!ownedByRetired(finding)) continue;
                if (CLOSED_FINDING_STATES.includes(finding.state)) continue;

                for (const task of tasksForFinding(store, fresh.id, finding.id)) {
                    store.tasks.update(
                        task.id,
                        { state: 'wontfix' },
                        loopAttr(
                            `sampling round ${round} retired the Summary draft ${finding.related_refs?.join(', ')} that ${finding.id} described; the fix work it queued has no text to act on (§6.6, §4.7)`
                        ),
                        [{ id: task.id, rev: task.rev }]
                    );
                }

                store.findings.update(
                    finding.id,
                    { state: 'discarded' },
                    loopAttr(
                        `sampling round ${round} truncated every Summary draft ${finding.id} named (${finding.related_refs?.join(', ')}); the defect was written about a text the Summary no longer holds (§6.6, D-36)`
                    ),
                    [{ id: finding.id, rev: finding.rev }]
                );
            }

            // §6.8, as H1 changed it: the round's prompt CARRIED these fix tasks, and the winner is now
            // chosen FROM THE CANDIDATES THAT PROVED THEM ANSWERED. Closure is per task and evidence
            // gated (R4):
            //
            //   * `fixesCleared` = the tasks every screening pass that was handed them marked `resolved`
            //     with a quotation from THIS winner (`sample-select.ts:scoreSample`). Those tasks go
            //     `done`, and the finding they carry closes, exactly as a classic fix pass closes its
            //     findings (`settleJob`'s D-34 branch).
            //   * every other open fix task stays OPEN with its finding untouched. Before H1 this loop
            //     closed whatever the prompt had listed, so a selection was its own proof and a round
            //     could "fix" a defect by rewriting past it. A task the winner was never screened
            //     against (confirmed after the round's screens went out) is likewise still open, and it
            //     is what arms the next round (`records.ts:samplingArmed`) — the climb continues.
            //
            // `verified` is read from the WINNER's own certificate, which was computed above from rows
            // this commit does not touch: the screening rows are only ever deleted for the LOSERS, and
            // the compare-and-set below is what makes the writes an honest transaction if a run moved a
            // task while this commit was being built.
            const verified = new Set(installable.fixesCleared);

            // H2/R1: WRITER-owned rows only. A Researcher prerequisite is closed by the Knowledge its
            // own pass recorded (`settleFixPrerequisites`), never as a side effect of a draft winning;
            // an Author-owned row is a question, not a target the winner settled.
            for (const task of openWriterFixTasks(store, fresh.id)) {
                if (!verified.has(task.id)) continue;

                store.tasks.update(
                    task.id,
                    { state: 'done' },
                    loopAttr(
                        `certified by sampling round ${round}'s ${current.id} — every screening pass handed ${task.id} marked it resolved with evidence, so the resample answered it rather than hand-fixing it (§6.8, D-34, H1/R4)`
                    ),
                    [{ id: task.id, rev: task.rev }]
                );

                const findingRef = task.finding_ref;
                const finding = findingRef === undefined ? undefined : store.findings.get(findingRef);

                if (finding === undefined) continue;
                if (finding.state !== 'confirmed' && finding.state !== 'approved') continue;

                // F3 — the same last-open-row invariant as `settleFixPrerequisites`: selection certifies
                // the tasks it was handed, and one certified Writer row does NOT retire a finding another
                // open fix row still owns (a Researcher prerequisite, or an owner phase ① cannot serve).
                // Without this gate, store ordering let the winner close a shared finding out from under
                // work that was still owed.
                if (!findingFixWorkSettled(store, fresh.id, finding.id, task.id)) continue;

                store.findings.update(
                    finding.id,
                    { state: 'fixed' },
                    loopAttr(
                        `sampling round ${round} resampled in answer to ${finding.id}, and ${current.id} was certified against the last open task naming it; a re-raised fingerprint reads as a regression (D-34, §6.8, H1/R4, F3)`
                    ),
                    [{ id: finding.id, rev: finding.rev }]
                );
            }

            store.stories.update(
                fresh.id,
                { sampling_round: round, sampling_history: history },
                loopAttr(
                    `sampling round ${round} selected ${current.id} (${installable.critical} critical, ${installable.high} high) and advanced sampling_round (§6.5, §6.6)`
                ),
                [{ id: fresh.id, rev: fresh.rev }]
            );
        });
    }

    /**
     * T12/E — the sampling-failure escalation's promised recovery: a fresh sampling WAVE.
     *
     * The row `openSamplingFailureTask` writes says "clear this row … and the sweep re-arms a fresh
     * wave of samples", and this is the sweep half of that sentence. The attempt counter is the count
     * of run rows under a claim prefix (`records.ts:sampleAttempts`), and nothing can un-run them, so
     * the only way to reset it honestly is a NEW GENERATION in the key — `stories.sampling_wave`.
     *
     * SUMMARY PHRASE: G1's plateau row used to be re-armed here too. It is gone (R5): the audit write
     * in `trackRevisionProgress` stays for legacy books, but the plateau's Author question and its
     * wave bump go with the whole-Summary hill-climb they policed.
     *
     * The guards, and why each one is load-bearing:
     *   * the escalation row must exist and must no longer be `open` — the Author cleared it
     *     (`clearPending` → `wontfix`, L-36/U-1b) or answered it (`done`);
     *   * the wave recorded in its `detail` must equal the Story's current wave — that is the
     *     once-per-cleared-escalation guard: after the bump the recorded wave is stale, so a later
     *     sweep cannot climb the wave again on the same row;
     *   * the loop must still be stuck THE WAY THAT ROW SAID IT WAS. A sampling-failure row is answered
     *     by a cap that is still spent (`samplingExhausted`): if the Author widened `summary_sampling`
     *     instead, the cap moved and generation already re-arms under the same wave, and bumping then
     *     would silently discard a round of retries.
     */
    private async rearmSamplingWave(storyId: string): Promise<void> {
        const store = this.store;
        const story = requireStory(store, storyId);

        if (story.phase !== 'summary') return;

        // SUMMARY PHRASE: a group-managed book has no sampling wave to re-arm — its retries are the
        // per-group claim keys, and R4's exclusion (not a cap) is what defers its work.
        if (isGroupManagedStory(story)) return;

        // The NEWEST sampling row, closed or not: one escalation per stuck state, and a later wave
        // raises its own row (its detail names the new wave).
        const escalation = last(
            store.tasks
                .list()
                .filter(
                    (task) =>
                        task.story_id === story.id &&
                        task.kind === 'escalation' &&
                        task.title.startsWith(SAMPLING_FAILURE_PREFIX)
                )
                .sort(
                    (left, right) =>
                        left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
                )
        );

        if (escalation === undefined || escalation.state === 'open') return;

        const recorded = /wave:\s*(\d+)/.exec(escalation.detail ?? '');

        if (recorded === null) return;
        if (Number(recorded[1]) !== samplingWaveOf(story)) return;

        if (!samplingExhausted(store, story)) return;

        await store.commit('loop_sampling_wave', () => {
            const fresh = requireStory(store, story.id);
            const wave = samplingWaveOf(fresh) + 1;

            store.stories.update(
                fresh.id,
                { sampling_wave: wave },
                loopAttr(
                    `the Author cleared ${escalation.id}; sampling round ${samplingRoundOf(fresh)} re-arms as wave ${wave} — the accepted-revision audit is partitioned by wave, so this is a fresh baseline (§6.4 step 3, §6.8, T12/E, G1)`
                ),
                [{ id: fresh.id, rev: fresh.rev }]
            );
        });
    }

    /**
     * G1 — the accepted-revision audit: record what one accepted revision's deep review raised, then ask
     * the Author when the wave's revisions stop getting better.
     *
     * THE WRITE (requirement 1) is the audit row on `stories.summary_review_history`: `{round, wave,
     * revision_id, at, blocking_found, finding_refs}`, appended once per revision and keyed by the
     * revision id, so a restart or a re-run of the same sweep cannot count a revision twice (the audit
     * IS the persistent state the plateau policy needs — see `records.ts:revisionReviewProgressOf` for
     * why it is stored rather than re-derived from live finding rows). `blocking_found` counts FINDING
     * ROWS by the dial-aware Summary bar, never a fingerprint or a title, so re-wording the same defect
     * is not progress and one defect described twice is not two regressions.
     *
     * THE TIMING (requirement 5) is the sweep position above: the entry is only owed once the review has
     * fully closed AND every blocking suspicion the Critics filed has been decided by the Editor, so a
     * suspicion the Editor later disputes or re-costs below the bar never becomes a permanent number —
     * and the wait costs the loop nothing, because those same unconfirmed rows already refuse the
     * sampler. This step sits BEFORE the sweep builds its candidate list, which is what makes the guard
     * land ahead of the next sampler in the adversarial scenario instead of racing it.
     *
     * THE QUESTION (requirement 2/3) used to be opened in the same commit as the entry that proves the
     * streak. SUMMARY PHRASE removed it (R5): a group-managed book's "this stopped getting better"
     * question is the per-group hill-climb — the next Writer batch is pointed at the SAME group whose
     * revision the review criticised (`phrase/findings.ts:findingGroupsStillOwed` routes those groups),
     * so no Author row is needed and none is raised. The audit row itself stays, because a legacy
     * `summary_mode:'sampling'` book still runs the whole-Summary loop and its history keeps being
     * written.
     */
    private async trackRevisionProgress(storyId: string, at: string): Promise<void> {
        const store = this.store;
        const story = requireStory(store, storyId);

        if (story.phase !== 'summary') return;

        // SUMMARY PHRASE: a group-managed book's accepted state is the GROUP VECTOR, not one selected
        // Summary revision, so `pendingRevisionReviewEntry` (a whole-Summary read) has nothing to
        // report here — skipping keeps the audit free of rows about a revision that never existed.
        if (isGroupManagedStory(story)) return;

        const owed = pendingRevisionReviewEntry(store, story);

        // The common case: nothing reviewed since the last sweep. Two reads, no commit — a sweep must
        // not touch the journal to say nothing happened.
        if (owed === undefined) return;

        await store.commit('loop_revision_review', () => {
            const fresh = requireStory(store, storyId);
            // Re-derived INSIDE the commit (T-4's discipline): the row the selection installed and the
            // verification the Editor settled may both have moved between the pre-read and this write.
            const entry = pendingRevisionReviewEntry(store, fresh);

            if (entry !== undefined) {
                store.stories.update(
                    fresh.id,
                    {
                        summary_review_history: [
                            ...(fresh.summary_review_history ?? []),
                            {
                                round: deepReviewRoundOf(fresh),
                                wave: samplingWaveOf(fresh),
                                revision_id: entry.revision.id,
                                at,
                                blocking_found: entry.blocking.length,
                                finding_refs: entry.blocking.map((finding) => finding.id)
                            }
                        ]
                    },
                    loopAttr(
                        `the deep review of ${entry.revision.id} closed and its suspicions were decided: ${entry.blocking.length} blocking finding(s) on the accepted revision — the accepted-revision audit (§3.6, §6.8, G1)`
                    ),
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }
            // SUMMARY PHRASE: the plateau escalation (`openRevisionPlateauTask`) that used to follow
            // this write is gone (R5) — the per-group hill-climb is the retry policy now, so a streak
            // of revisions that do not improve the review's numbers routes work instead of asking.
        });
    }

    /**
     * H2/R1 — the settlement half of the phase-① fix owners (`work.ts:phase1FixPrerequisites` is the
     * opening half, which generation calls).
     *
     * A `fix` task owned by a RESEARCHER is a grounding job, and its done condition is a recorded
     * fact. So the row closes the moment one of its passes writes Knowledge
     * (`records.ts:researchPrerequisiteAnswered` — a journal read of that family's runs, which is why
     * it survives a restart and why `reportNoResearch`, which writes nothing, can never settle it).
     * The finding it names goes `fixed` with it, exactly as the sampler's certified closure does: the
     * complaint was "a reference I cannot resolve", and the crew has now resolved it.
     *
     * The two Author questions this family opens — an exhausted prerequisite, and a row whose owner
     * has no phase-① job — CLOSE here when the task leaves the set that opened them (the Author
     * re-owned it, restated it, closed it, or a late pass answered it). Opening is generation's job,
     * so outside that condition this sweep only ever writes `done`, and a question never outlives its
     * answer.
     */
    private async settleFixPrerequisites(storyId: string): Promise<void> {
        const store = this.store;
        const story = requireStory(store, storyId);

        // The common case — no prerequisite and no open question — costs two list scans and no commit.
        const prereqs = openPrerequisiteFixTasks(store, story.id);
        const rows = store.tasks
            .list()
            .filter(
                (task) =>
                    task.story_id === story.id &&
                    task.kind === 'escalation' &&
                    task.state !== 'done' &&
                    ((task.title ?? '').startsWith(FIX_PREREQUISITE_STALL_PREFIX) ||
                        (task.title ?? '').startsWith(FIX_TASK_OWNER_PREFIX))
            );

        if (prereqs.length === 0 && rows.length === 0) return;

        await store.commit('loop_fix_prerequisites', () => {
            const fresh = requireStory(store, story.id);
            // Re-derived INSIDE the commit: the opened and closed sets must reflect the rows this
            // transaction sees, not the ones the pre-read saw (T-4's compare-and-set discipline).
            const stillStalled = new Set(stalledResearchPrerequisites(store, fresh.id).map((task) => task.id));
            const stillUnserviceable = new Set(
                openUnserviceableFixTasks(store, fresh.id).map((task) => task.id)
            );

            for (const task of openPrerequisiteFixTasks(store, fresh.id)) {
                if (!isResearchPrerequisiteFix(task)) continue;
                if (!researchPrerequisiteAnswered(store, fresh.id, task)) continue;

                store.tasks.update(
                    task.id,
                    { state: 'done' },
                    loopAttr(
                        `a grounding pass recorded the fact ${task.id} asked for — Knowledge attributed to its own run family is the completion evidence, never the run ending (T-10, H2/R1)`
                    ),
                    [{ id: task.id, rev: task.rev }]
                );

                const findingRef = task.finding_ref;
                const finding = findingRef === undefined ? undefined : store.findings.get(findingRef);

                if (finding === undefined) continue;
                if (finding.state !== 'confirmed' && finding.state !== 'approved') continue;

                // F3 — a finding's fix work can be split across owners (`finding_332` carried BOTH the
                // Researcher's grounding row and the Writer's repair row). The grounding pass settles
                // the FACT; the prose repair may still be owed, so the finding stays in its prior
                // state until the LAST open row naming it settles. Marking it `fixed` early dropped a
                // major out of the blocking set and wrote an unrecoverable entry into the closed-
                // fingerprint history the trend reads (L-16a).
                if (!findingFixWorkSettled(store, fresh.id, finding.id, task.id)) continue;

                store.findings.update(
                    finding.id,
                    { state: 'fixed' },
                    loopAttr(
                        `the Researcher pass for ${task.id} grounded it, and no other open fix row names ${finding.id}: the reference the finding could not resolve is now a recorded fact and its fix work is settled (D-34, H2/R1, F3)`
                    ),
                    [{ id: finding.id, rev: finding.rev }]
                );
            }

            for (const row of rows) {
                // The task the question names is the id between the prefix and the ` — ` separator the
                // reuse key puts there (anchored so `task_18` can never match `task_187`).
                const stalled = (row.title ?? '').startsWith(FIX_PREREQUISITE_STALL_PREFIX);
                const prefix = stalled ? FIX_PREREQUISITE_STALL_PREFIX : FIX_TASK_OWNER_PREFIX;
                const taskId = (row.title ?? '').slice(prefix.length).trim().split(' ')[0] ?? '';

                if (stalled ? stillStalled.has(taskId) : stillUnserviceable.has(taskId)) continue;

                store.tasks.update(
                    row.id,
                    { state: 'done' },
                    loopAttr(
                        `${taskId} is no longer a prerequisite the loop cannot ground (T-10, P7) — the row closed with its question, so the round can arm again`
                    ),
                    [{ id: row.id, rev: row.rev }]
                );
            }
        });
    }

    /**
     * T6/R2d — the sweep's answer to a verification pass that never decided the finding.
     *
     * Phase ①'s verify queue is bounded (`records.ts:FINDING_VERIFY_CAP`): once the budget is spent
     * `work.ts` offers no further pass, and without this row the Story would sit with an unconfirmed
     * finding, no dispatchable work, and no explanation — the drain can never be met (D-33), the sign
     * off is refused for the same reason, and the dashboard shows "ready" next to a phase that will not
     * advance. The row is `blocked`, which is the shape the decision tree reads as the Author's turn
     * (`status.ts` step 4: "the crew asked you").
     *
     * Closing is symmetric: the row is the finding's, and the sweep retires it (`done`) as soon as the
     * finding is not stalled any more — the Editor answered it in a later pass, the Author approved or
     * disputed it, or the draft that carried it was retired with the round (T6/R2c). A question that
     * outlives its answer would hold the "the crew asked you" state forever.
     *
     * T10/F4 — opening stays Phase-1-only, closing is not. `records.ts:findingsVerifyStalled` answers
     * `[]` outside phase ①, so in a later phase this sweep can only ever CLOSE: that is the half that
     * must still run. A row the Author resolved while the Story was in phase ① would otherwise sit
     * `blocked` forever once the phase moved on, and `decideStory`'s step 4 reads a blocked escalation as
     * "the crew asked you" — every later phase would drain-fail on a Phase-① question nobody is asking.
     */
    private async escalateVerifyStall(storyId: string): Promise<void> {
        const store = this.store;
        const story = requireStory(store, storyId);

        const rows = store.tasks
            .list()
            .filter(
                (task) =>
                    task.story_id === story.id &&
                    task.kind === 'escalation' &&
                    (task.title ?? '').startsWith(FINDING_VERIFY_STALL_PREFIX)
            );

        // `findingsVerifyStalled` is phase-scoped, so outside phase ① `stalled` is empty by definition:
        // nothing to open, and the guard below is the cheap exit for a Story that has neither.
        const stalled = findingsVerifyStalled(store, story);

        // Nothing to open and nothing to close: the common case, and the reason this is cheap enough
        // to run on every sweep next to the sampling escalation.
        if (stalled.length === 0 && !rows.some((task) => task.state === 'blocked')) return;

        await store.commit('loop_verify_stall', () => {
            const fresh = requireStory(store, story.id);
            // Re-derived INSIDE the commit: the opened/closed sets must reflect the rows this
            // transaction sees, not the ones the pre-read saw (T-4's compare-and-set discipline).
            const stillStalled = new Set(findingsVerifyStalled(store, fresh).map((finding) => finding.id));

            // Phase ① only, because `findingsVerifyStalled` is: in a later phase this loop is empty and
            // only the close pass below can write (T10/F4).
            for (const finding of findingsVerifyStalled(store, fresh)) openFindingVerifyStallTask(store, fresh, finding);

            for (const task of rows) {
                if (task.state !== 'blocked') continue;

                const findingRef = task.finding_ref;

                if (findingRef !== undefined && stillStalled.has(findingRef)) continue;

                store.tasks.update(
                    task.id,
                    { state: 'done' },
                    loopAttr(
                        `finding ${findingRef ?? task.finding_ref ?? task.id} is no longer waiting on a verification pass — the Editor, the Author, or the round that retired its draft answered it (D-33, P7)`
                    ),
                    [{ id: task.id, rev: task.rev }]
                );
            }
        });
    }

    /**
     * D-19's closing half, after the Editor's review thread: the directive is `done` once its tasks
     * exist. The Editor's own `createTask` calls are found through the journal's `run_ref` (the row
     * carries no second identity), so this reads exactly the work that thread queued.
     *
     * If the review queued nothing — or the thread failed before it could — the deterministic
     * fallback keeps the directive's promise: one fix task per artifact the directive resolved to.
     * The Author's direction is never silently dropped because a model had a bad turn.
     */
    private async settleDirectiveReview(item: WorkItem, result: RunResult): Promise<void> {
        if (item.directiveRef === undefined) return;

        const directive = this.store.directives.get(item.directiveRef);

        if (directive === undefined) return;

        const queued = this.tasksQueuedBy([result.runId]);
        const tasksCreated =
            queued.length > 0
                ? queued.length
                : createDirectiveFallbackTasks(this.store, requireStory(this.store, directive.story_id), directive);

        completeDirective(
            this.store,
            directive.id,
            { tasks_created: tasksCreated },
            result.ended === 'completed'
                ? `the Editor queued ${tasksCreated} task${tasksCreated === 1 ? '' : 's'} for ${directive.id} (D-19)`
                : `the Editor review of ${directive.id} ended ${result.ended}; ${tasksCreated} task${tasksCreated === 1 ? '' : 's'} queued instead (D-19)`
        );
    }

    /**
     * §4.15's reconciliation: a draft is reviewable when no Writer is on it and it is complete.
     * A Summary short of a block stays `pending` — nothing finishes it now: the classic completion
     * job (`wi_complete_*`) was removed and phase ①'s samples are persisted whole by the engine, so
     * a partial Summary draft is simply never reviewable. Every other unit's draft becomes `drafted`
     * once its run is no longer live, which is the same rule `settleJob` applies when the run closes
     * normally.
     */
    private async reconcileDrafts(storyId: string): Promise<void> {
        const pending = this.store.revisions
            .list()
            .filter((revision) => revision.story_id === storyId && revision.state === 'pending');

        if (pending.length === 0) return;

        const live = liveRuns(this.store, storyId);
        const promote = pending.filter((revision) => {
            const run = revision.run_ref === undefined ? undefined : this.store.runs.get(revision.run_ref);

            if (run !== undefined && isLiveRun(run)) return false;
            // A completion run keeps the draft's original `run_ref`, so the Work Item's unit ref is
            // what says a Writer is still on it (L-5: one writer per unit at a time).
            if (
                revision.unit_ref.length > 0 &&
                live.some((candidate) => (candidate.work_item_ref ?? '').includes(revision.unit_ref))
            ) {
                return false;
            }

            return revision.unit_kind !== 'summary' || missingSummaryBlocksOf(revision).length === 0;
        });

        if (promote.length === 0) return;

        await this.store.commit('loop_draft_gate', () => {
            for (const revision of promote) {
                if (this.store.revisions.get(revision.id)?.state !== 'pending') continue;

                this.store.revisions.update(
                    revision.id,
                    { state: 'drafted' },
                    {
                        run_ref: revision.run_ref ?? null,
                        why: `no Writer is on ${revision.id} any more and its draft is complete, so it is handed to the review crew (§4.15)`
                    },
                    [{ id: revision.id, rev: revision.rev }]
                );
            }
        });
    }

    /** The task rows one or more runs created, read from the journal's attribution (P11). */
    private tasksQueuedBy(runIds: string[]): Task[] {
        const runs = new Set(runIds);
        const ids = new Set(
            this.store.journal
                .filter(
                    (event) =>
                        event.collection === 'tasks' &&
                        event.op === 'create' &&
                        typeof event.attribution.run_ref === 'string' &&
                        runs.has(event.attribution.run_ref)
                )
                .map((event) => event.id)
        );

        return this.store.tasks.list().filter((task) => ids.has(task.id));
    }

    /**
     * Stores the probe's Work Item ids on the round, so its completion is a store question.
     *
     * Only the jobs that ACTUALLY launched are recorded. Capacity 1 means the Critic and the Reader
     * launch on different sweeps, and stamping both ids on the first launch made the round look "over"
     * the moment the Reader closed — the Critic round (L-37 condition 3, D-30's fresh eyes) never ran
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
            const critic = probes.find((candidate) => candidate.key.startsWith('wi_probe_critic_'))?.key;
            const reader = probes.find((candidate) => candidate.key.startsWith('wi_probe_reader_'))?.key;
            const probe: ProbeState = {
                ...(running ? current : startProbe(this.store, story, story.phase, new Date().toISOString())),
                ...(critic === undefined ? {} : { critic_item_id: critic }),
                ...(reader === undefined ? {} : { reader_item_id: reader })
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
                    // D-35's default dial (critical, major, minor); spread so the row never shares the
                    // module-level array with the constant the tools and the UI also read.
                    auto_approve: input.auto_approve ?? [...DEFAULT_AUTO_APPROVE_COSTS],
                    author_stop: false,
                    digest_rev: 0,
                    // D-17b: write permission comes from a template ASSIGNED to the Story.
                    template_refs: refs,
                    chapter_deps: {},
                    // The Author's phase-① pipeline dials (D-17d/D-38a: counts are settings).
                    ...(input.summary_sampling === undefined ? {} : { summary_sampling: input.summary_sampling }),
                    ...(input.summary_critics === undefined ? {} : { summary_critics: input.summary_critics }),
                    // SUMMARY PHRASE R1/R6: a NEW book is group-managed unless the caller asks for the
                    // legacy sampler. This is the ONLY place `'groups'` is chosen automatically — an
                    // existing Story opts in by the Author's explicit import (`POST /stories/:id/phrases/import`),
                    // and a row with no `summary_mode` reads as `'sampling'` (R6: old books are readable,
                    // not migrated).
                    summary_mode: input.summary_mode ?? 'groups'
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

            // SUMMARY PHRASE R1: the catalog exists IN THE BOOK from the first moment the Story does —
            // one Phrase row and one row per ENABLED group (today: premise, promise, theme, tone,
            // ending), each at `revision: 0` with empty content, which is the state generation reads as
            // "never written". It rides THIS commit, so a crash cannot leave a group-managed Story
            // without groups (P1); `ensurePhraseCatalog` is idempotent, so an api layer that creates a
            // Story twice over a restored store adds nothing.
            //
            // The legacy import is NOT part of this: new books have no prose to import, and a legacy
            // book's prose moves into group history only when the Author asks (R6).
            if (isGroupManagedStory(created)) {
                ensurePhraseCatalog(store, created, authorAttr(`the Summary Phrase catalog (R1) was created with the Story — its Summary is written group by group`));
            }

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
        for (const run of liveRuns(this.store, storyId)) this.executor.kill(run.id, 'stop');

        await this.settle();
    }

    /**
     * §10 / P1 — delete a Story and everything it owns. The Author's cord first (a phrase must not
     * outlive the book it was writing), then ONE commit removes every story-scoped §4 row, the three
     * phase-① research collections (`seed_briefs`, `knowledge`, `sample_reviews` — T12/A), the three
     * Summary Phrase collections (`phrases`, `phrase_groups`, `group_revisions` — P1 hardening) and
     * the Story itself; finally the Story's harness is disposed, which tears down its sessions and
     * threads. The knowledge FILES are a projection outside §4, so the route deletes that directory
     * alongside this call; the `knowledge` COLLECTION is a store row and goes in this commit.
     */
    async deleteStory(storyId: string): Promise<void> {
        const story = requireStory(this.store, storyId);

        // The in-flight phrases stop first: a run that outlives its Story would teardown into rows
        // this method is about to delete, and S-3's unconditional close would then be a lost update.
        for (const run of liveRuns(this.store, storyId)) this.executor.kill(run.id, 'delete');

        await this.settle();

        await this.store.commit('delete_story', () => {
            const attribution = authorAttr(
                `the Author deleted ${story.id}; the book, every artifact it owned, and every run go with it (P1, §10)`
            );

            // Every §4 collection that can name a story. `templates` stays: it is the global
            // catalogue, not this book's property, and a duplicate remains the Author's to reuse.
            //
            // T12/A: the three phase-① research collections are story-scoped exactly like §4's, so
            // they go in the SAME deletion commit (P1). Leaving them behind orphaned a deleted
            // Story's brief, its sourced facts and its screening reviews — rows whose `story_id`
            // names a Story the store no longer holds.
            this.store.summaries.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.seedBriefs.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.knowledge.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.sampleReviews.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.plotlines.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.chapters.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.cast.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.ledger.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.tasks.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.digests.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.verdicts.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.findings.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.goals.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.runs.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.directives.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.revisions.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.ideas.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.proposals.deleteWhere((row) => row.story_id === story.id, attribution);

            // SUMMARY PHRASE (P1 hardening) — the three Summary Phrase collections are story-scoped
            // exactly like the §4 rows, and T4's probe measured `phrases=1 phrase_groups=5`
            // surviving the delete: the Phrase row, its five groups (Author-imported or loop-
            // ensured, locked or not) and every archived/active group revision outlived the book,
            // each still naming a `story_id` the store no longer held. Phrase findings and fix
            // tasks ride the `findings`/`tasks` deletes above and group-review verdicts the
            // `verdicts` delete — but these three collections needed their own lines. P1 gives
            // the Author's delete no lock exemption: the whole book goes.
            this.store.phrases.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.phraseGroups.deleteWhere((row) => row.story_id === story.id, attribution);
            this.store.groupRevisions.deleteWhere((row) => row.story_id === story.id, attribution);

            this.store.stories.delete(story.id, attribution);
        });

        this.lastClosedRuns.delete(story.id);
        this.executor.harness.forget(story.id);
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
     * Phase ① — "not final yet": the Author asks for another three-draft round. This is a queue
     * entry, not a backtrack: the selected Summary stays the base, every discarded draft stays as
     * history, and the next sweep sees the `rewrite` task and dispatches three fresh Writers.
     */
    async requestSummaryRevision(storyId: string, note = ''): Promise<void> {
        await this.store.commit('request_summary_revision', () => {
            const store = this.store;
            const story = requireStory(store, storyId);

            if (story.phase !== 'summary') {
                throw new Error(
                    `another Summary revision is phase ① only: ${story.id} is in phase ${story.phase}`
                );
            }

            if (story.summary_locked) {
                throw new Error(
                    `the Summary is locked (P5, L-30); backtrack to phase ① before asking for another revision`
                );
            }

            const summary = storySummary(store, story.id);

            if (summary === undefined) throw new Error(`no Summary exists yet for ${story.id}`);

            const title = 'Author requested a fresh Summary round';
            const existing = openTasks(store, story.id).find(
                (task) => task.kind === TASK_KINDS.rewrite && task.title === title
            );

            if (existing === undefined) {
                store.tasks.create(
                    {
                        story_id: story.id,
                        kind: TASK_KINDS.rewrite,
                        title,
                        detail: `The Author asked for another three-draft Summary round.${note.trim() ? ` Note: ${note.trim()}` : ''} · ${summary.id}`,
                        owner_role: 'writer',
                        state: 'open',
                        priority: 0,
                        attempts: 0
                    },
                    authorAttr(`the Author asked for another Summary round for ${story.id} (D-24, U-13)`)
                );
            }

            // A paused Story stays paused (P8); a pending sign-off becomes dispatchable again.
            if (!story.author_stop && (story.status === 'pending' || story.status === 'completed')) {
                const fresh = requireStory(store, story.id);

                store.stories.update(
                    fresh.id,
                    {
                        status: 'ready',
                        pending_kind: 'none',
                        status_reason: 'the Author asked for another Summary round',
                        blocked_on: ''
                    },
                    authorAttr('the Author asked for another Summary round (D-24)'),
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }
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
     *
     * On a group-managed book the reopened phase's group TEXTS and numbers survive as the base for
     * another round (L-31), and a lock that still names a live revision row survives with them. A lock
     * whose `group_revisions` backing this scrap deleted does NOT: `scrapPhasesAfter` clears those four
     * fields, because a flag naming a dead row blocks the reviewed rebuild and every install that names
     * the group (D-69, T8 finding 1) — see that function's block for the full reasoning.
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
                // §6.6: `scrapPhasesAfter(…, 'summary')` deletes every revision, so the round counter
                // and its audit restart with the artifact. Without this the reopened phase would
                // sample "round N+1" against a base revision that no longer exists (§6.8's prompt).
                // The sampling WAVE restarts with them (T12/E): it is a retry generation of a round
                // that no longer exists, and wave 0 is the key shape a fresh round samples under.
                patch.sampling_round = 0;
                patch.sampling_history = [];
                patch.sampling_wave = 0;
                // G1: the accepted-revision audit describes revisions `scrapPhasesAfter` just deleted, and
                // a plateau computed from revisions that no longer exist would stop a fresh phase ① before
                // it sampled once. Wave 0 restarts the audit's partition too (§3.6, G1).
                patch.summary_review_history = [];

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
                    completion: undefined,
                    // §6.6's counters describe samples `scrapPhasesAfter` just deleted: the new Seed
                    // starts at round 1 (origin `sampled`), and the audit lines named revisions that
                    // no longer exist — keeping them would claim a history the store cannot show.
                    // The retry WAVE goes with them (T12/E): a new Seed starts at wave 0.
                    sampling_round: 0,
                    sampling_history: [],
                    sampling_wave: 0,
                    // G1: a new Seed has no accepted revisions to audit, so the plateau's ledger goes with
                    // the sampling counters — the new Seed gets its own baseline, not the old wave's streak.
                    summary_review_history: []
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

            // SUMMARY PHRASE (hardening, D-25a/D-5/R2): on a group-managed book the CURRENT text is
            // not the mirror above — it is the `phrase_groups` rows and the Overview the `phrases`
            // row composes from them. Clearing only the mirror would leave the OLD Seed's group
            // prose driving everything: `groupWorkTargets` would see five written groups and offer
            // no first draft, the review seats would stay keyed to the stale vector, and the rail
            // would show an Overview the new Seed never wrote. The rows are RESET in place — same
            // ids (R1's addresses outlive the text; the catalog is not deleted and re-minted),
            // content empty, number back to 0 — which is EXACTLY the fresh-catalog state
            // `phrase/catalog.ts` creates, so the next install lands at revision 1 and a
            // re-pressed `ensurePhraseCatalog` is a no-op. The `group_revisions` history is already
            // gone with the legacy revisions (`scrapPhasesAfter`, same commit): no stale `latest`
            // row keeps its claim on the attempt baseline (`writeBaselineOf`) or the vector hash,
            // and R3's closure cannot fire off a scrapped Seed's install. The mirror stays cleared:
            // it re-derives from the new texts inside the next install (R6).
            if (isGroupManagedStory(fresh)) {
                for (const group of phraseGroupsOf(store, storyId)) {
                    store.phraseGroups.update(
                        group.id,
                        // The fresh-row triple `catalog.ts` mints: unwritten is `''` + `0` + null
                        // authorship (the projection reads exactly that as "never written").
                        //
                        // R3/T6b + D-69 (T8 finding 1) — a Seed reset also LIFTS every group lock, which
                        // is the same four-field clear `phrase/locks.ts:unlockPhraseGroup` writes (line
                        // 331): `undefined` would DELETE the field and `null` is what this store's clear
                        // convention uses. It is spelled HERE as well as in the scrap because the Seed
                        // reset is the one flow that rolls a group back to `revision: 0` with NO content,
                        // so a lock standing on empty text would freeze a section nobody ever judged — a
                        // dangling lock. A plain `backtrack` clears the flag too, for the other half of
                        // the same reason: `scrapPhasesAfter` (same commit, above) deletes the
                        // `group_revisions` rows the flag names, and a lock is a fact ABOUT one of them —
                        // `phrase/reviewed.ts:cleanSelectionOf` can only compose a locked group's Overview
                        // entry from its `latest` row, and `revisions.ts:installGroupRevisions` refuses a
                        // whole batch naming any locked group, so a stale flag would strand this section
                        // AND the four that could still be rewritten. What clears NOTHING is a scrap that
                        // deletes no revision backing (a backtrack to `chapters`): there the lock still
                        // anchors a live `latest` row, real content, and its one-per-vector seat stays spent.
                        {
                            content: '',
                            revision: 0,
                            updated_by: null,
                            locked: false,
                            locked_revision: null,
                            locked_by: null,
                            locked_at: null
                        },
                        authorAttr('the Author rewrote the Seed; the groups re-grow from the new one (D-25a, R2)'),
                        [{ id: group.id, rev: group.rev }]
                    );
                }

                const phrase = storyPhrase(store, storyId);

                if (phrase !== undefined) {
                    store.phrases.update(
                        phrase.id,
                        // Nothing composed yet — the same `''` a fresh catalog row carries; a
                        // placeholder sentence would be quoted back by a review as Author prose.
                        { content: '', revision: 0 },
                        authorAttr('the Overview recomposes when the first new group lands (D-25a, R2)'),
                        [{ id: phrase.id, rev: phrase.rev }]
                    );
                }
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

            // D-33d — the Author's approve passes through the SAME issues-first gate the Editor's
            // `approveFinding` tool runs (`tools/editor.ts`), on the SAME predicate
            // (`records.ts:openIssueFindings`). Without it this funnel was the hole in the rule: the
            // Author's queue row (U-10a) and the dashboard's approve-all button both land here, and a
            // proposal approved from the Author's desk would spend a Writer round over unresolved
            // defects while the tool path refused the identical approval.
            //
            // An `Error`, not a new error type, because that is this engine's whole refusal convention
            // and `api/routes.ts:refusal` turns it into the 409 whose body is the sentence the Author
            // reads (L-13) — the rule id rides in the message so the pane can show which rule it hit.
            if (finding.kind === 'proposal') {
                const openIssues = openIssueFindings(store, finding.story_id);

                if (openIssues.length > 0) {
                    const named = openIssues
                        .slice(0, 3)
                        .map((issue) => `${issue.id} (${issue.cost}, ${issue.state})`)
                        .join(', ');

                    throw new Error(
                        `proposal ${findingId} cannot be approved while ${openIssues.length} ${openIssues.length === 1 ? 'issue is' : 'issues are'} unresolved — ${named}${openIssues.length > 3 ? `, and ${openIssues.length - 3} more` : ''} — because issues are in focus before anything else can be done. Resolve them, or discard the proposal (D-33d).`
                    );
                }
            }

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
     * decided list and D-32's repeat detection is what the next fresh Critic reads — so the caller's words
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
            applied = recordDirective(this.store, requireStory(this.store, storyId), {
                text,
                refs,
                at: new Date().toISOString(),
                killRun: (runId) => this.executor.kill(runId, 'directive')
            });

            // L-27: a directive returns the Story to `ready`. A completed book is re-opened; a
            // pending one (a sign-off, a tray, a drain) stops waiting on the Author's other decision
            // because the Author just made one. A stopped Story keeps its cord: P8 has no exception
            // for a directive, and the Editor's review waits for the resume.
            if (applied.impact.completed_reopened || story.status === 'pending') {
                const fresh = requireStory(this.store, storyId);
                const reopened = applied.impact.completed_reopened;

                this.store.stories.update(
                    fresh.id,
                    {
                        status: 'ready',
                        pending_kind: 'none',
                        status_reason: reopened
                            ? `a directive re-opened the finished book (L-27): ${text.slice(0, 80)}`
                            : `a directive re-armed the Story for the Editor's review: ${text.slice(0, 80)}`,
                        blocked_on: ''
                    },
                    authorAttr(
                        reopened
                            ? 'the Author kept writing the book, so the loop polices it again (L-27)'
                            : 'the Author issued a directive; the Editor reviews it before the sweep re-pends (L-27)'
                    ),
                    [{ id: fresh.id, rev: fresh.rev }]
                );
            }

            // A roster with no Editor assigned has no one to review the directive. Do not strand it
            // as a propagating row forever: the loop queues the deterministic fallback and closes it.
            if (templatesFor(this.store, requireStory(this.store, storyId), 'editor').length === 0) {
                const fresh = requireStory(this.store, storyId);
                const directive = this.store.directives.require(applied.directive_id);
                const tasksCreated = createDirectiveFallbackTasks(this.store, fresh, directive);

                completeDirective(
                    this.store,
                    directive.id,
                    { tasks_created: tasksCreated },
                    `no Editor is assigned; the loop queued ${directive.id}'s work itself (D-19)`
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

/**
 * Is this claim key already claimed, in this process or in the store? (L-2's two halves.)
 *
 * S-RUNTIME: scoped to the candidate's Story. The claim is a STRING comparison, and the id-less families
 * (`wi_verify_ideas`, `wi_whole_check`, a probe round's `wi_probe_critic_chapters_1`) are the same
 * string for every Story, so in a book holding more than one Story an unscoped read lets Story A's live
 * run answer "claimed" for Story B's job and Story B goes unswept. One Store per Story
 * (`store/story-stores.ts`) is what makes the scope a no-op; the scope is what makes a shared book honest.
 */
function isClaimedHere(store: Store, key: string, storyId?: string): boolean {
    return store.runs.list().some(
        (run) => isLiveRun(run) && run.work_item_ref === key && (storyId === undefined || run.story_id === storyId)
    );
}

/**
 * Phase ①'s two pipeline run families (§6.4 steps 3-4). A live one means the round is still being
 * written or screened, so the selection commit must wait — truncating under a run that has not
 * yet answered would delete a sample nobody judged.
 */
const PHASE1_PIPELINE_RUN = /^wi_(sample|screen)_/;

/**
 * §4.2's prose blocks a sample installs. `chapter_count` is deliberately absent: it is AUTHOR truth
 * (D-3b), declared once, and the `SummarySample` schema omits it so a Writer cannot even propose one.
 */
const SUMMARY_PROSE_KEYS = ['premise', 'promise', 'theme', 'tone', 'ending', 'world_rules'] as const;

/**
 * The `{fields: {...}}` of a Summary revision's body, read defensively (§4.15 leaves `body` open by
 * unit kind; `run/phase1-prompt.renderSummaryBody` reads the same shape). An unknown body is an
 * empty field set — the selection still installs nothing rather than guessing prose.
 */
function summaryFieldsOf(body: unknown): Record<string, unknown> {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};

    const fields = (body as Record<string, unknown>).fields;

    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return {};

    return fields as Record<string, unknown>;
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
