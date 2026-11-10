// The composition root: one `dashboard()` call, eight plugins.
//
// The kernel validates the WHOLE graph before any setup runs (duplicate ids,
// unknown dependencies and cycles are rejected up front), then runs setup in
// dependency order and reports that order as `instance.plugins`. The list below is
// written in an already-valid order, so the schedule is the same whether the core
// topologically sorts or merely verifies — and `requires` still carries the
// information, because a consumer that reads a service during its own setup MUST
// declare the edge (README: "`requires` orders plugins; it does not validate
// providers").
//
// The dependency story, in one line each:
//
//   layout, theme    — no dependencies: chrome and skin only
//   api              — no dependencies: publishes the `storyline.api` server seam
//   titles           — api: the Title registry, the active Title, the one live stream
//   records          — api, titles: one normalized read of the store, woken by the stream
//   content          — api, titles, records: selection, chapter body read, status write
//   agents           — api, titles: what writer, reader and editor are doing right now
//   turns            — api, titles, agents: the transcript and the composer
//
// EVERY OPTION IS A TEST SEAM. `api` and `streamFactory` are the two places this
// app touches the network; injecting doubles here means the composition test, the
// pane tests and the stream wiring all run without a server, and a host that wants
// the real thing passes nothing.
import { dashboard, type Dashboard, type DashboardPlugin } from '@underload/dashboard';
import type { StorylineAgent, StorylineApi } from '../api';
import { storylineApi } from '../api';
import { TURNS_SELECT_AGENT_COMMAND, type ThemeMode } from './contract';
import type { StreamFactory, TitlesPluginOptions } from './plugins/titles';
import { createApiPlugin } from './plugins/api';
import { createContentPlugin } from './plugins/content';
import { createAgentsPlugin } from './plugins/agents';
import { createLayoutPlugin } from './plugins/layout';
import { createRecordsPlugin } from './plugins/records';
import { createThemePlugin } from './plugins/theme';
import { createTitlesPlugin } from './plugins/titles';
import { createTurnsPlugin } from './plugins/turns';

export type StorylineOptions = {
    /** The server seam. Defaults to the `/v1/storyline` client in src/api/storyline.ts. */
    api?: StorylineApi;
    /** Stream factory (default: this package's own stream client). */
    streamFactory?: StreamFactory;
    /** Active-Title persistence key; '' disables resume. */
    storageKey?: TitlesPluginOptions['storageKey'];
    /** Initial skin. Defaults to 'ink'. */
    theme?: ThemeMode;
    /** The agent the composer starts on (contract: all three are equal targets). */
    agent?: StorylineAgent;
    /**
     * Capability add-ons, appended after the built-ins: they may depend on every
     * built-in, and no built-in may depend on them.
     */
    extraPlugins?: readonly DashboardPlugin[];
};

export function createStoryline(options: StorylineOptions = {}): Dashboard {
    const api = options.api ?? storylineApi;

    const plugins: DashboardPlugin[] = [
        createLayoutPlugin(),
        createThemePlugin(options.theme ?? 'ink'),
        createApiPlugin(api),
        createTitlesPlugin({ streamFactory: options.streamFactory, storageKey: options.storageKey }),
        createRecordsPlugin(),
        createContentPlugin(),
        createAgentsPlugin(),
        createTurnsPlugin(),
        ...(options.extraPlugins ?? [])
    ];

    const instance = dashboard({ plugins });

    // The one option that is not plugin construction. A command is the only legal
    // way to write another plugin's state after setup — registration is scoped,
    // runtime writing is not (README: "Runtime is not scoped").
    if (options.agent !== undefined) instance.execute<StorylineAgent, StorylineAgent>(TURNS_SELECT_AGENT_COMMAND, options.agent);

    return instance;
}
