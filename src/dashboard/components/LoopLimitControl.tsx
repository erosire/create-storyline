// S-5 — THE LOOP'S CEILING, as the one control the Author moves it with.
//
// WHY IT SITS ON THE EMPLOYEE RAIL, BESIDE THE ROSTER'S NAME: the number is the count of THREADS the
// crew may run at once, and a thread is an employee becoming an agent (V-1). Every other control in
// this column belongs to one employee — its rank, its model, its live threads — and this one belongs
// to all five together. It is not Story-scoped: S-5 makes it ONE ceiling across every Story, the sweep
// filling capacity across all of them, so the rail that is itself global is the only honest place for
// it. A Story pane would imply a per-book setting that does not exist.
//
// WHY A DROPDOWN AND NOT A NUMBER FIELD: the ceiling is a throttle, not a measurement, so the Author
// picks a stance ("four at a time", "twelve at a time") rather than types a value. A free field would
// also let a mid-edit "1" of "12" reach the server as its own write. The list is a stance set, and the
// number actually in effect is always shown — a ceiling set by `STORYLINE_GLOBAL_MAX_CONCURRENT` to
// something off the list (7, 64) is PREPENDED rather than silently replaced, because the control must
// never misreport what the engine is doing (the same rule the model dropdown follows).
//
// WHY THE LIVE COUNT IS HOVER-ONLY: the rail's header deliberately carries no panel-wide "N threads
// running" line — each tile's own badge already answers that question. So the ceiling is the only
// thing printed here, and what the ceiling currently MEANS ("6 live") is the sentence on hover and to
// a screen reader, where it costs no line.
//
// WHY NO SAVE BUTTON: the dropdown's change IS the write, exactly as the model picker's is. The value
// that renders afterwards is the one `GET /loop` re-read, so a refused or raced write shows up as the
// number going back, not as a field that lies.
import type { LoopSettings } from '../api';

/**
 * The stances offered. Every one is a whole number of threads, and the set brackets the shipped
 * default (`DEFAULT_GLOBAL_MAX_CONCURRENT` = 4) on both sides without pretending a provider can serve
 * sixty completions at once — the ceiling protects the Author's attention (E-0a) and the relay, and
 * anything past 32 is an operator decision made in an env var, not a click.
 */
const LIMIT_CHOICES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const;

/**
 * The dropdown's face: the stance set, plus the ceiling actually in effect when it is off the list.
 * The current value goes FIRST so a select with no explicit choice still opens on what the Author
 * is about to change.
 */
const limitChoices = (current: number | undefined): number[] => {
    const choices: number[] = [...LIMIT_CHOICES];

    if (current !== undefined && Number.isInteger(current) && current >= 1 && !choices.includes(current)) {
        choices.unshift(current);
    }

    return choices;
};

export interface LoopLimitControlProps {
    /**
     * The ceiling and its live count (`GET /loop`). `null` is "not read yet": the control shows an
     * uneditable `—` rather than the engine's default, which is a guess about a setting the Author is
     * looking at.
     */
    loop?: LoopSettings | null;
    /**
     * The control's one verb. Absent means the rail is rendered read-only (a Story-less shell, a
     * fixture), and the dropdown stays disabled instead of pretending a change saved something — the
     * convention every other picker on this rail follows.
     */
    onSetLimit?: (limit: number) => void | Promise<unknown>;
}

export function LoopLimitControl({ loop, onSetLimit }: LoopLimitControlProps) {
    const limit = loop?.global_max_concurrent;
    const live = loop?.live_runs ?? 0;
    const choices = limitChoices(limit);
    const selected = limit !== undefined && choices.includes(limit) ? limit : (choices[0] ?? 1);
    // Nothing read means nothing to show: the face stays an em-dash rather than the engine's default,
    // which would be a guess about the very setting the Author is looking at.
    const reported = loop !== undefined && loop !== null;
    const editable = reported && onSetLimit !== undefined;

    const apply = (value: string): void => {
        const next = Number(value);

        if (!Number.isInteger(next) || next < 1) return;

        void onSetLimit?.(next);
    };

    return (
        <span className="sv-loop-limit" data-testid="loop-limit-control" data-live={live}>
            {/* The label says what the number counts, because "4" alone on a roster rail could be
                threads, employees, or attempts at a draft. */}
            <span className="sv-loop-limit__label">Max threads</span>
            <select
                className="sv-loop-limit__select"
                value={reported ? String(selected) : ''}
                autoComplete="off"
                disabled={!editable}
                aria-label="maximum threads the loop runs at once, across every Story"
                title={
                    !reported
                        ? 'the loop’s ceiling has not been read yet'
                        : `${selected} thread${selected === 1 ? '' : 's'} at once across EVERY Story (S-5) — ${live} live now, and the next sweep fills up to the ceiling. Lowering it cancels nothing: the threads in flight finish their pass. The number is remembered with the roster’s model choices, so it is still here after a restart — unless an operator pinned STORYLINE_GLOBAL_MAX_CONCURRENT, which wins at boot.`
                }
                onChange={(event) => apply(event.target.value)}
            >
                {reported ? (
                    choices.map((choice) => (
                        <option key={choice} value={String(choice)}>
                            {choice}
                        </option>
                    ))
                ) : (
                    <option value="">—</option>
                )}
            </select>
        </span>
    );
}

export default LoopLimitControl;
