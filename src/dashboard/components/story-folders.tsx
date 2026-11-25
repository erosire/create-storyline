// The supporting folders under the phrases: Seed, Continuity, Goal, Ideas, Findings, Digest, Settings.
//
// WHY THEY ARE PANES AND NOT A STACK: each one answers a different question (what the book is
// measured against, what facts it must respect, what the bar is, what decisions are owed, what is
// broken, what the engine sees, how the machine is allowed to act). Putting them in the rail keeps
// the content area to the one question the Author is asking.
import { CostDistributionPanel } from './story-cost-distribution';
import {
    EDITOR_GROUP_LOCKING_LABEL,
    EDITOR_GROUP_LOCKING_NOTE,
    findingKindLabel,
    findingKindToken,
    isEditorGroupLockingEnabled,
    isOpenFinding
} from './story-contract';
import { FINDING_COSTS } from '../../shared/types';
import type { Cost, LedgerEntry } from '../../shared/types';
import type { StoryActions, StoryViewData } from './story-contract';

export function SeedPane({ view }: { view: StoryViewData }) {
    return (
        <section className="sv-pane sv-seed-pane" aria-label="Seed">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Seed — the Author&apos;s idea</h3>
                <span className="sv-pane-badge">
                    Author-written · read-only for every agent, every phrase, forever (P5)
                </span>
            </header>

            <p className="sv-seed-body">{view.story.idea}</p>
            {/* §10 / §3.3 — the Editor's ACCEPTED Seed Brief is a derived record, never an edit of
                the Seed (P5). The pane shows its logline only: the brief is an input, not the
                contract (phase ②/③ measure against the locked Summary and the raw Seed, C-14). */}
            {view.seed_brief ? (
                <p className="sv-seed-brief">
                    The Editor&apos;s brief: {view.seed_brief.logline}
                </p>
            ) : null}
            {view.summary ? (
                <p className="sv-seed-measure">
                    The book&apos;s measure: {view.summary.chapter_count} chapters (D-3b).
                </p>
            ) : null}
        </section>
    );
}

export interface SettingsPaneProps {
    view: StoryViewData;
    actions: StoryActions;
}

/**
 * The Settings folder: D-35 / D-35b's auto-approve dial, and R2's Editor-locking switch.
 *
 * Both are one decision each — which findings skip the approval gate (and where the drain threshold sits, since
 * D-35b fused them), and whether the Editor may commit one Summary group — and both are the Author's to make, so
 * they live on the one pane that answers "how may the machine act on my behalf?".
 */
export function SettingsPane({ view, actions }: SettingsPaneProps) {
    const { story } = view;

    return (
        <section className="sv-pane sv-settings" aria-label="Settings">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Settings — how the machine may act</h3>
                {/* The two dials named in one line, so the pane's own header says what is switchable here before
                    the Author scrolls it. R2 added the second: the auto-approve dial still sets the gate AND the
                    drain threshold, and the new switch says who may lock a phrase group. */}
                <span className="sv-pane-badge">
                    the approval gate and the drain threshold (D-35, D-35b) · who may lock a phrase group (R2)
                </span>
            </header>

            <div className="sv-dial" aria-label="Auto-approve dial">
                <span className="sv-dial-title">
                    auto-approve dial (D-35) — the same switch sets when the crew stops looking (D-35b)
                </span>
                <ul className="sv-dial-costs">
                    {FINDING_COSTS.map((cost) => {
                        const covered = story.auto_approve.includes(cost);
                        const nextSet = FINDING_COSTS.filter((candidate) =>
                            candidate === cost ? !covered : story.auto_approve.includes(candidate)
                        );

                        return (
                            <li className={`sv-dial-cost${covered ? ' sv-dial-on' : ' sv-dial-off'}`} key={cost}>
                                <input
                                    type="checkbox"
                                    checked={covered}
                                    disabled={!actions.setAutoApprove}
                                    title={
                                        actions.setAutoApprove
                                            ? covered
                                                ? `Stop auto-approving ${cost}: the crew raises it and waits for you`
                                                : `Let ${cost} findings start work without asking (D-35). This also moves when the crew stops looking (D-35b).`
                                            : 'The dial endpoint has not landed yet (D-35)'
                                    }
                                    aria-label={`${cost} auto-approve`}
                                    onChange={() => void actions.setAutoApprove?.(story.id, nextSet as Cost[])}
                                />
                                <span className="sv-dial-cost-name">{cost}</span>
                                <span className="sv-dial-cost-note">
                                    {covered
                                        ? 'starts work without asking · counts as work when draining'
                                        : 'waits for you · the crew raises it and stops'}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            </div>

            <div className="sv-setting" data-testid="setting-editor-group-locking">
                {/* R2 — THE EDITOR-LOCKING DIAL, and it is off until the Author says otherwise.
  
                    WHY IT SITS ON THIS PANE. Everything else here answers "how may the machine act on my
                    behalf?" (D-35's dial is the same shape for the same reason): this one answers whether the
                    Editor may commit ONE group of the Summary — a smaller decision than locking a phase, and a
                    bigger one than approving a finding, because a locked group stops being editable and rewrites
                    what the other four groups have to live with. Absent means OFF (`story-contract.
                    isEditorGroupLockingEnabled`), so a Story written before the Setting exists — or a `PATCH` body
                    that never mentioned it — keeps the rule the Author has always had.
  
                    THE SENTENCE IS THE DECISION. An Editor locking a group on its own judgement is easy to
                    under-read from a label, so the note under the control says what the Editor weighs (the Critic
                    findings open on that group NOW, and the Reader's score and rationale beside them — the same
                    two facts this pane prints, which is why the Author can audit a lock after the fact) and who
                    can undo it (only the Author — the Editor never lifts its own lock).
  
                    `checked` is the Setting's state rather than local state, and the write is an explicit boolean,
                    so the box shows what the server echoed after `mutate` re-read the Story — not what was
                    clicked (P1: the durable store is the only memory). With no verb bound, the box is disabled and
                    says so (U-16), and the pane still tells the Author which way the Story currently stands. */}
                <label className="sv-setting-row" data-testid="setting-editor-group-locking-row">
                    <input
                        type="checkbox"
                        checked={isEditorGroupLockingEnabled(story)}
                        disabled={!actions.setEditorGroupLocking}
                        aria-label={EDITOR_GROUP_LOCKING_LABEL}
                        data-testid="editor-group-locking"
                        title={
                            actions.setEditorGroupLocking
                                ? isEditorGroupLockingEnabled(story)
                                    ? 'Stop letting the Editor lock phrase groups: only you would commit a group again.'
                                    : 'Let the Editor lock a phrase group in, on its own judgement over the Critic findings and the Reader score for it. Only you can unlock one.'
                                : 'The Story settings route is not available in this shell, so the Setting cannot be changed.'
                        }
                        onChange={(event) =>
                            void actions.setEditorGroupLocking?.(story.id, event.currentTarget.checked)
                        }
                    />
                    <span className="sv-setting-name">{EDITOR_GROUP_LOCKING_LABEL}</span>
                </label>
                <p className="sv-setting-note" data-testid="editor-group-locking-note">
                    {EDITOR_GROUP_LOCKING_NOTE}
                </p>
            </div>

            <CostDistributionPanel distribution={view.cost_distribution} />
        </section>
    );
}

export function ContinuityPane({ view }: { view: StoryViewData }) {
    return (
        <section className="sv-pane sv-continuity" aria-label="Continuity">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Continuity — the facts the story must respect</h3>
                <span className="sv-pane-badge">setups, payoffs, and the facts a change must respect (D-10)</span>
            </header>

            {view.ledger.length === 0 ? (
                <p className="sv-chapters-none">No continuity facts yet — the crew records them as it writes.</p>
            ) : (
                <ul className="cont-list">
                    {view.ledger.map((entry: LedgerEntry) => (
                        <li className={`cont-row cont-row--${entry.status}`} key={entry.id}>
                            <div className="cont-row-head">
                                <span className="cont-kind">{entry.kind}</span>
                                <span className="cont-subject">{entry.subject}</span>
                                <span className={`cont-status cont-status--${entry.status}`}>{entry.status}</span>
                                {entry.chapter_ref ? <span className="cont-chapter">{entry.chapter_ref}</span> : null}
                            </div>
                            {entry.detail ? <p className="cont-detail">{entry.detail}</p> : null}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

export function FindingsPane({ view }: { view: StoryViewData }) {
    const open = view.findings.filter(isOpenFinding);
    const closed = view.findings.filter((finding) => !isOpenFinding(finding));

    return (
        <section className="sv-pane sv-findings" aria-label="Findings">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Findings — what is broken, and what was fixed</h3>
                <span className="sv-pane-badge">a finding is raised, verified, approved, then fixed (D-33, D-34)</span>
            </header>

            {open.length === 0 ? (
                <p className="sv-chapters-none">No open findings on this story.</p>
            ) : (
                <ul className="find-list">
                    {open.map((finding) => (
                        <li className={`find-row find-row--${finding.cost}`} key={finding.id}>
                            <div className="find-head">
                                {/* T3 — WHAT the row claims, ahead of what it costs. This folder is the desk's whole
                                    findings list, so it is where the two types are read side by side: an Issue is a
                                    contradiction the text has to repair, a Proposal is a change worth weighing. The
                                    heading already says "what is broken, and what was fixed", and until now an
                                    improvement was indistinguishable from a defect in here. */}
                                <span
                                    className={`sv-finding-kind sv-finding-kind--${findingKindToken(finding.kind)}`}
                                    data-testid={`finding-${finding.id}-kind`}
                                >
                                    {findingKindLabel(finding.kind)}
                                </span>
                                {' '}
                                <span className="find-tags">
                                    <span className={`sv-finding-cost sv-cost-${finding.cost}`}>{finding.cost}</span>
                                    <span className={`find-state find-state--${finding.state}`}>{finding.state}</span>
                                </span>
                                <span className="find-title">{finding.title}</span>
                                {finding.seen_count > 1 ? (
                                    <span className="find-seen">{finding.seen_count}× seen</span>
                                ) : null}
                            </div>
                            <p className="find-meta">
                                {finding.criterion_ref} · on {finding.target_ref}
                            </p>
                            {finding.detail ? <p className="find-detail">{finding.detail}</p> : null}
                            <p className="find-evidence">evidence — {finding.evidence}</p>
                        </li>
                    ))}
                </ul>
            )}

            {closed.length > 0 ? (
                <details className="find-closed">
                    <summary>{closed.length} closed findings</summary>
                    <ul className="find-list">
                        {closed.map((finding) => (
                            <li className={`find-row find-row--closed`} key={finding.id}>
                                <div className="find-head">
                                    {/* T3 — the closed list keeps its kind too: "fixed proposal" and "discarded
                                        issue" are the two readings that tell the Author what the loop actually
                                        did with the claim. */}
                                    <span
                                        className={`sv-finding-kind sv-finding-kind--${findingKindToken(finding.kind)}`}
                                        data-testid={`finding-${finding.id}-kind`}
                                    >
                                        {findingKindLabel(finding.kind)}
                                    </span>
                                    {' '}
                                    <span className="find-tags">
                                        <span className={`sv-finding-cost sv-cost-${finding.cost}`}>{finding.cost}</span>
                                        <span className={`find-state find-state--${finding.state}`}>{finding.state}</span>
                                    </span>
                                    <span className="find-title">{finding.title}</span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
        </section>
    );
}

export function DigestPane({ view }: { view: StoryViewData }) {
    const digest = view.digest;

    return (
        <section className="sv-pane sv-digest" aria-label="Digest">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Digest — the standing view a fresh crew is briefed with</h3>
                <span className="sv-pane-badge">engine-derived, no agent wrote it (D-12a)</span>
            </header>

            {digest ? (
                <>
                    <p className="sv-digest-meta">
                        rev {digest.rev}
                        {digest.stale ? ' · stale — it blocks a review, never a fix (D-14)' : ''}
                    </p>
                    <pre className="sv-digest-body">{digest.body}</pre>
                </>
            ) : (
                <p className="sv-chapters-none">The engine has not derived a Digest yet.</p>
            )}
        </section>
    );
}
