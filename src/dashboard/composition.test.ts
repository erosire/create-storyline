// The composition test: does the eight-plugin graph assemble, publish what the contract
// names, and let ONE live Title drive every pane?
//
// WHY THIS SHAPE: the kernel validates the whole graph BEFORE any setup runs (duplicate
// ids, unknown dependencies and cycles are rejected up front), so a broken `requires` edge
// is a build failure rather than a half-mounted dashboard. Everything past that — services,
// state cells, slots, events, teardown — is asserted through the PUBLIC instance surface,
// which is exactly what WorkstationShell.tsx uses. The slot snapshot in particular IS the
// workstation: the shell is feature-blind, so a pane that is not contributed here is not on
// screen, and a pane contributed twice would show twice.
//
// The two network seams are doubled by ../testing/doubles.ts, so no server and no socket is
// involved; `stream()` is the captured event object, and it is how a test pushes a live frame
// through the titles plugin into the records, agents and turns plugins.
import { describe, expect, it } from 'vitest';
import type { StorylineApi } from '../api';
import {
    AGENTS_PANEL,
    AGENTS_ROSTER_SERVICE,
    AGENTS_STATE,
    API_SERVICE,
    BRAND_CHIP,
    CENTER_PANEL,
    COMPOSER_PANEL,
    CONTENT_DETAIL_STATE,
    CONTENT_SELECT_STATE,
    DEFAULT_CONTENT,
    EMPTY_AGENTS,
    EMPTY_CHAPTER_DETAIL,
    EMPTY_RECORDS,
    EMPTY_TITLES,
    LAYOUT_BRAND_SERVICE,
    LAYOUT_REGIONS_SERVICE,
    PANEL_SLOT,
    PLUGIN_ORDER,
    RECORDS_STATE,
    STATUS_ORDERS,
    STATUS_SLOT,
    STREAM_CHIP,
    STREAM_RECORDS_EVENT,
    STREAM_RESYNC_EVENT,
    STREAM_SECTION_EVENT,
    STREAM_STATE,
    STREAM_STATUS_EVENT,
    STREAM_TEXT_EVENT,
    STREAM_THREAD_EVENT,
    STREAM_TURN_EVENT,
    THEME_CHIP,
    THEME_MODE_STATE,
    THEME_PALETTE_SERVICE,
    THEME_TOGGLE_COMMAND,
    TITLE_CHIP,
    TITLES_ACTIVE_EVENT,
    TITLES_ACTIVE_STATE,
    TITLES_SERVICE,
    TITLES_STATE,
    TRANSCRIPT_PANEL,
    TREE_PANEL,
    TURNS_AGENT_STATE,
    TURNS_COMPOSER_STATE,
    TURNS_TRANSCRIPT_STATE,
    type BrandSpec,
    type ChapterDetailState,
    type ComposerDraft,
    type PanelValue,
    type RecordsState,
    type RegionSpec,
    type RosterService,
    type StreamRecordsEvent,
    type StreamResyncEvent,
    type StreamSectionEvent,
    type StreamState,
    type StreamStatusEvent,
    type StreamTextEvent,
    type StreamThreadEvent,
    type StreamTurnEvent,
    type StorylineAgent,
    type ThemeMode,
    type ThemePalette,
    type TitlesActiveEvent,
    type TitlesService,
    type TitlesState
} from './contract';
import { AgentsPanel } from './components/AgentsPanel';
import { BrandChip, StreamChip, ThemeChip, TitleChip } from './components/Chips';
import { ComposerPanel } from './components/ComposerPanel';
import { ContentPane } from './components/ContentPane';
import { StoryTree } from './components/StoryTree';
import { TranscriptPanel } from './components/TranscriptPanel';
import { buildStoryline, THREADS } from './testing/doubles';

describe('createStoryline', () => {
    it('assembles the eight plugins in the declared dependency order', () => {
        const { instance } = buildStoryline();

        // The order the kernel actually ran setup() in, and the order the contract documents:
        // a reordered or renamed plugin is a visible diff here, and a new built-in has to be
        // added to PLUGIN_ORDER to pass.
        expect(instance.plugins).toEqual(PLUGIN_ORDER);
        expect(instance.disposed).toBe(false);

        instance.dispose();
    });

    it('publishes every service the contract names', () => {
        const { instance, api } = buildStoryline();

        expect(instance.service<StorylineApi>(API_SERVICE)).toBe(api);
        expect(instance.service<BrandSpec>(LAYOUT_BRAND_SERVICE)).toEqual({
            name: 'Storyline',
            tagline: 'Titles on the left · the story in the middle · writer, reader and editor on the right',
            notice: 'Each Title is one story the three agents work on together. Pick one, or start a new one.'
        });
        // The four areas, in reading order — the grid in styles/workstation.css maps onto these.
        expect(instance.service<readonly RegionSpec[]>(LAYOUT_REGIONS_SERVICE)).toEqual([
            { id: 'tree', label: 'Title tree', order: 10 },
            { id: 'center', label: 'Story document', order: 20 },
            { id: 'agents', label: 'Agents', order: 30 },
            { id: 'composer', label: 'Composer', order: 40 }
        ]);
        expect(instance.service<ThemePalette>(THEME_PALETTE_SERVICE)).toEqual({
            ink: { accent: '#e8b45a' },
            paper: { accent: '#8a5a1e' }
        });

        // Nothing is known before the first read lands: no Title is invented, and no thread
        // is guessed at, which is what keeps every pane pointed at the same (empty) truth.
        expect(instance.service<TitlesService>(TITLES_SERVICE).activeId()).toBe('');
        expect(instance.service<RosterService>(AGENTS_ROSTER_SERVICE)()).toEqual({});

        instance.dispose();
    });

    it('registers every state cell with the initial value the contract describes', () => {
        const { instance } = buildStoryline({ agent: 'editor', theme: 'paper' });

        // Boot's list read has started but not landed, which is the only phase a fresh page
        // can honestly be in.
        expect(instance.state<TitlesState>(TITLES_STATE).get()).toEqual({ ...EMPTY_TITLES, phase: 'loading' });
        expect(instance.state<string>(TITLES_ACTIVE_STATE).get()).toBe('');
        expect(instance.state<StreamState>(STREAM_STATE).get()).toEqual({ status: 'idle', error: '' });
        expect(instance.state<RecordsState>(RECORDS_STATE).get()).toEqual({ phase: 'idle', error: '', data: EMPTY_RECORDS });
        // The center pane starts on the first document of the four, whole.
        expect(instance.state<typeof DEFAULT_CONTENT>(CONTENT_SELECT_STATE).get()).toEqual(DEFAULT_CONTENT);
        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual(EMPTY_CHAPTER_DETAIL);
        expect(instance.state<typeof EMPTY_AGENTS>(AGENTS_STATE).get()).toEqual(EMPTY_AGENTS);
        expect(instance.state<readonly unknown[]>(TURNS_TRANSCRIPT_STATE).get()).toEqual([]);
        // `agent` is the one option applied through a command after setup, so the composer
        // starts addressed at the agent the host asked for — one of three equals.
        expect(instance.state<StorylineAgent>(TURNS_AGENT_STATE).get()).toBe('editor');
        expect(instance.state<ComposerDraft>(TURNS_COMPOSER_STATE).get()).toEqual({ agent: 'editor', text: '' });
        // `theme` picks the skin; the toggle is the only way to change it afterwards.
        expect(instance.state<ThemeMode>(THEME_MODE_STATE).get()).toBe('paper');
        expect(instance.execute<undefined, ThemeMode>(THEME_TOGGLE_COMMAND)).toBe('ink');
        expect(instance.state<ThemeMode>(THEME_MODE_STATE).get()).toBe('ink');

        instance.dispose();
    });

    it('contributes the five panels and four chips the shell renders', () => {
        const { instance } = buildStoryline();

        // The shell is feature-blind: this snapshot IS the workstation. The kernel sorts by
        // `order` across the slot and breaks ties by registration order; the shell then
        // groups by `region`, so tree/agents/transcript (10) land first here and the bottom
        // strip still gets transcript over composer.
        expect(
            instance
                .slot<PanelValue>(PANEL_SLOT)
                .map((contribution) => ({ id: contribution.id, order: contribution.order, ...contribution.value })),
        ).toEqual([
            { id: TREE_PANEL, order: 10, title: 'Titles', region: 'tree', component: StoryTree },
            { id: AGENTS_PANEL, order: 10, title: 'Agents', region: 'agents', hint: 'writer · reader · editor', component: AgentsPanel },
            { id: TRANSCRIPT_PANEL, order: 10, title: 'Conversation', region: 'composer', hint: 'this Title only', component: TranscriptPanel },
            { id: CENTER_PANEL, order: 20, title: 'Story', region: 'center', hint: 'one document at a time', component: ContentPane },
            { id: COMPOSER_PANEL, order: 20, title: 'Composer', region: 'composer', component: ComposerPanel }
        ]);
        expect(
            instance
                .slot<{ label: string; component: unknown }>(STATUS_SLOT)
                .map((contribution) => ({ id: contribution.id, order: contribution.order, ...contribution.value })),
        ).toEqual([
            { id: BRAND_CHIP, order: STATUS_ORDERS.brand, label: 'Brand', component: BrandChip },
            { id: TITLE_CHIP, order: STATUS_ORDERS.title, label: 'Title', component: TitleChip },
            { id: STREAM_CHIP, order: STATUS_ORDERS.stream, label: 'Stream', component: StreamChip },
            { id: THEME_CHIP, order: STATUS_ORDERS.theme, label: 'Theme', component: ThemeChip }
        ]);
        // Every region the layout names has at least one pane — the assertion that no pane
        // was left behind when the harness-centric surfaces were replaced.
        const regions = instance.slot<PanelValue>(PANEL_SLOT).map((contribution) => contribution.value.region);

        expect(new Set(regions)).toEqual(new Set(['tree', 'center', 'agents', 'composer']));
        // An unknown channel is an empty snapshot, never a throw.
        expect(instance.slot('storyline.unknown')).toEqual([]);

        instance.dispose();
    });

    it('opens one observation for the Title boot picked and re-broadcasts every frame to the panes', async () => {
        const { instance, calls, handle, captured, flush, stream } = buildStoryline();

        await flush();

        expect(handle.connectCalls).toBe(1);
        expect(captured.sessionIds).toEqual(['ses-new']);

        const events: string[] = [];

        instance.on<StreamStatusEvent>(STREAM_STATUS_EVENT, ({ status, error }) => events.push(`status:${status}:${error ?? ''}`));
        instance.on<StreamTurnEvent>(STREAM_TURN_EVENT, ({ turn }) => events.push(`turn:${turn.id}:${turn.status}:${turn.threadId ?? ''}`));
        instance.on<StreamTextEvent>(STREAM_TEXT_EVENT, ({ turnId, text }) => events.push(`text:${turnId}:${text}`));
        instance.on<StreamThreadEvent>(STREAM_THREAD_EVENT, ({ thread }) => events.push(`thread:${thread.id}:${thread.agent}`));
        instance.on<StreamSectionEvent>(STREAM_SECTION_EVENT, ({ section }) => events.push(`section:${section.sectionId}:${section.state}`));
        instance.on<StreamRecordsEvent>(STREAM_RECORDS_EVENT, ({ storeRev, collectionsRev }) => events.push(`records:${storeRev}:${collectionsRev}`));
        instance.on<StreamResyncEvent>(STREAM_RESYNC_EVENT, ({ reason, turnId }) => events.push(`resync:${reason}:${turnId ?? ''}`));
        instance.on<TitlesActiveEvent>(TITLES_ACTIVE_EVENT, ({ sessionId, label }) => events.push(`active:${sessionId}:${label}`));

        stream().onStatus?.('open');
        stream().onTurn?.({ id: 'turn-9', index: 1, status: 'done', threadId: 'thread-writer', updatedAt: 3 });
        stream().onText?.('The night was dark.', 'turn-9');
        stream().onThread?.(THREADS[0]);
        stream().onSection?.({ turnId: 'turn-9', sectionId: 's-9', agent: 'writer', role: 'primary', state: 'streaming', threadId: 'thread-writer', startedAt: 1, endedAt: null });
        stream().onResync?.('frames_dropped', 'turn-9');

        // One socket, many listeners: every frame the titles plugin receives is re-broadcast
        // unchanged, and its own lifecycle sentence lands in the stream state the strip reads.
        expect(events).toEqual([
            'status:open:',
            'turn:turn-9:done:thread-writer',
            'text:turn-9:The night was dark.',
            'thread:thread-writer:writer',
            'section:s-9:streaming',
            'resync:frames_dropped:turn-9'
        ]);
        expect(instance.state<StreamState>(STREAM_STATE).get()).toEqual({ status: 'open', error: 'stream resync: frames_dropped' });

        stream().onRecords?.({ storeRev: 13, collectionsRev: 4 });
        await flush();

        // The watermark frame is answered by one bounded snapshot read — the panes never
        // guess at what the store holds. Four reads by here, each with its own reason: the
        // boot read, the `records.updated` signal the collection ensure sends, the resync
        // above (a dropped frame makes the watermark untrusted), and this frame at rev 13.
        expect(calls.filter((call) => call === 'readRecords:ses-new')).toEqual([
            'readRecords:ses-new',
            'readRecords:ses-new',
            'readRecords:ses-new',
            'readRecords:ses-new'
        ]);
        expect(events[6]).toBe('records:13:4');

        // A section state the wire does not define is dropped rather than folded, so a pane
        // can never render a phase the server did not send.
        stream().onSection?.({ turnId: 'turn-9', sectionId: 's-8', agent: 'writer', role: 'primary', state: 'teleported', threadId: 'thread-writer', startedAt: 1, endedAt: null });

        expect(events).toHaveLength(7);

        instance.dispose();
    });

    it('coalesces concurrent asks for an active Title onto one list read and one socket', async () => {
        const { instance, calls, handle, flush } = buildStoryline();
        const titles = instance.service<TitlesService>(TITLES_SERVICE);

        // The composer, the tree and a late-mounting pane all ask in the same tick.
        const ids = await Promise.all([titles.ensureActive(), titles.ensureActive(), titles.ensureActive()]);

        expect(ids).toEqual(['ses-new', 'ses-new', 'ses-new']);
        await flush();

        // Boot's own read is shared rather than repeated, and a Title activated twice dials
        // its socket once.
        expect(calls.filter((call) => call === 'listTitles')).toEqual(['listTitles']);
        expect(handle.connectCalls).toBe(1);

        // A second ask after the Title is active is a plain read of the answer.
        expect(await titles.ensureActive()).toBe('ses-new');
        expect(handle.connectCalls).toBe(1);

        instance.dispose();
    });

    it('closes the observation once and leaves nothing readable behind', async () => {
        const { instance, handle, flush } = buildStoryline();

        await flush();

        expect(handle.connectCalls).toBe(1);

        instance.dispose();
        instance.dispose();

        // Teardown is idempotent, and the socket goes first and quietly: a run the operator
        // started keeps executing server-side — this only stops watching it.
        expect(handle.closeReasons).toEqual(['title change']);
        expect(instance.disposed).toBe(true);
        // The plugin list survives disposal; every registry does not.
        expect(instance.plugins).toEqual(PLUGIN_ORDER);
        expect(() => instance.state(TITLES_STATE)).toThrow();
        expect(() => instance.service(API_SERVICE)).toThrow();
        expect(() => instance.slot(PANEL_SLOT)).toThrow();
        expect(() => instance.execute(THEME_TOGGLE_COMMAND)).toThrow();
    });
});
