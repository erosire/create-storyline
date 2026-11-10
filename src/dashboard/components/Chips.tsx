// The status-strip chips: one per plugin, each reading only its own state.
//
// The shell renders `storyline.status` contributions in slot order and knows nothing
// about them, so a chip that needs new information asks its own plugin for it — never
// the shell. Every chip is read-only except the theme chip, which runs its plugin's
// one command.
import {
    BRAND_CHIP,
    LAYOUT_BRAND_SERVICE,
    STATUS_SLOT,
    STREAM_STATE,
    THEME_MODE_STATE,
    THEME_TOGGLE_COMMAND,
    TITLE_CHIP,
    TITLES_ACTIVE_STATE,
    TITLES_STATE,
    type BrandSpec,
    type StreamState,
    type ThemeMode,
    type TitlesState
} from '../contract';
import { useDashboardCommand, useDashboardPair, useDashboardService, useDashboardValue } from '../state-hooks';

/**
 * The app version, pinned at build time by vite.config.ts's `__APP_VERSION__`
 * define. Read through `typeof` so a host that bundles this library without the
 * define degrades to an empty caption instead of a ReferenceError.
 */
const appVersion = (): string => (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '');

/** Wordmark + version. Rendered first in the strip. */
export function BrandChip() {
    const brand = useDashboardService<BrandSpec>(LAYOUT_BRAND_SERVICE);
    const version = appVersion();

    return (
        <span className="chip chip--brand" data-chip={BRAND_CHIP}>
            <strong>{brand.name}</strong>
            {version.length > 0 ? <em className="chip__version">v{version}</em> : null}
        </span>
    );
}

/**
 * The Title being worked on, which is the fact an operator actually wants in the
 * strip: which story is open, and how many are waiting. `useDashboardPair` folds the
 * two cells (the registry and the active id) into one cached snapshot, so the chip
 * never re-renders on an unrelated write — and so the phase it needs for the "no
 * Title" sentence comes from the SAME fold, never a second subscription.
 */
export function TitleChip() {
    const active = useDashboardPair<TitlesState, string, { label: string; count: number; phase: TitlesState['phase'] }>(
        TITLES_STATE,
        TITLES_ACTIVE_STATE,
        (titles, id) => ({
            label: titles.rows.find((row) => row.id === id)?.label ?? '',
            count: titles.rows.length,
            phase: titles.phase,
        }),
    );

    const label = active.label.length > 0 ? active.label : active.count > 0 ? 'no Title open' : titlesPhaseNote(active.phase);

    return (
        <span className="chip" data-chip={TITLE_CHIP} data-empty={active.label.length === 0 ? 'yes' : 'no'} title={active.label}>
            {label}
        </span>
    );
}

/** The one sentence the strip shows when no Title can be named, per registry phase. */
function titlesPhaseNote(phase: TitlesState['phase']): string {
    if (phase === 'loading') return 'loading Titles…';
    if (phase === 'error') return 'Titles unavailable';

    return 'no Titles yet';
}

/** The observation's lifecycle, plus the reason for the last resync. */
export function StreamChip() {
    const stream = useDashboardValue<StreamState>(STREAM_STATE);

    return (
        <span className="chip chip--stream" data-status={stream.status} title={stream.error.length > 0 ? stream.error : stream.status}>
            stream: {stream.error.length > 0 ? `${stream.status} — ${stream.error}` : stream.status}
        </span>
    );
}

/** The one styling switch the composition exposes. */
export function ThemeChip() {
    const mode = useDashboardValue<ThemeMode>(THEME_MODE_STATE);
    const toggle = useDashboardCommand<void, ThemeMode>(THEME_TOGGLE_COMMAND);

    return (
        <button className="chip chip--button" type="button" onClick={() => toggle()} aria-label="Toggle theme">
            {mode === 'ink' ? 'ink' : 'paper'}
        </button>
    );
}

/** The chip ids each plugin contributes, kept next to the components that render them. */
export const CHIP_SLOTS = STATUS_SLOT;
