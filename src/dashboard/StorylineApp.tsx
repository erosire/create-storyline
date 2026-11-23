// §10.1 — the four-region shell: STORIES | THE STORY | EMPLOYEES, with the DIRECTIVE bar at the
// foot of the content column (it belongs to the Story/desk, not to the whole window).
//
// WHY THIS FILE IS ONLY A SHELL: §10.1 fixes the regions; the later waves fill them. Anything
// that reads a Story's contents (the Seed card, the Summary pane, the Ideas tray, the prose
// editor, the crew cards) is W10/W11's surface, so it is imported from the
// component that owns it and rendered into the region the layout names. The shell's own job is
// three things and nothing else: the store lifecycle, the home-vs-story switch (U-10: the queue
// IS the home view), and keeping the directive bar at the bottom of the content (U-9) — fixed to
// the viewport on a phone, where the content column is the whole screen (like the harness composer).
//
// THE RIGHT REGION IS ALWAYS THE EMPLOYEE ROSTER: the shell keeps all three columns in place
// whether it is showing the home desk, a Story, or an employee's threads. The centre changes with
// the Author's selection; the roster does not move into the content column.
//
// THE MODEL THE REGIONS SPEAK, in one place (V-1). Every Story owns its own harness: its
// knowledge directory and its phase sessions are scoped to that Story, and nothing crosses
// between stories. The EMPLOYEES are the one global thing — the right rail is the roster the
// server defines once and every Story's threads run as agents under. A phrase (P1/P3/P4) is
// one phase session against the Story's Goal; each Run it dispatches is one thread inside that
// session. The phrase/thread history is NOT a rail panel: clicking an employee tile replaces the
// centre with that employee's threads, grouped by Story then phrase. There is no main agent: the
// loop is fully autonomous from the Goal the Author types into the directive, and a thread is
// dispatched because the Goal still has work.

import { useEffect, useState } from 'react';

import { AgentThreadsView } from './components/AgentThreadsView';
import { DirectiveBar } from './components/DirectiveBar';
import { AgentsPanel } from './components/AgentsPanel';
import { HomeDesk } from './components/HomeDesk';
import type { HomeTab } from './components/HomeDesk';
import { StoriesPanel } from './components/StoriesPanel';
import { StoryOutline } from './components/StoryOutline';
import { StoryView } from './components/StoryView';
import { TopBar } from './components/TopBar';
import { DEFAULT_STORY_SELECTION } from './components/story-nav';
import type { StorySelection } from './components/story-nav';
import { DashboardContext, defaultDashboardStore, useDashboard, useDashboardStore, type DashboardStore } from './state';
import { shellActions, storyViewData } from './shell-binding';
import type { StoryViewData } from './components/story-contract';

export function StorylineApp(props: { store?: DashboardStore }) {
    const store = props.store ?? defaultDashboardStore();
    return (
        // The app-wide store by default; a test passes one built on a fake client.
        <DashboardContext.Provider value={store}>
            <Shell />
        </DashboardContext.Provider>
    );
}

/** The regions themselves, split out so the store injection above stays one line. */
function Shell() {
    const store = useDashboardStore();
    const { activeStoryId, stories, storyViews, templates, agents, selectedAgent, agentThreads, agentModels } =
        useDashboard();

    // The stream is the Dashboard's pulse: one subscription for the whole shell, torn down on
    // unmount (React StrictMode's double-mount is why the teardown has to be real).
    useEffect(() => store.start(), [store]);

    /** Which phrase or folder the content area is showing (the rail's one piece of UI state). */
    const [selection, setSelection] = useState<StorySelection>(DEFAULT_STORY_SELECTION);
    /** The home desk's tab: it labels the input when no Story is open. */
    const [homeTab, setHomeTab] = useState<HomeTab>('requests');

    // A Story opens on its Summary; a different book must not keep the last one's pane.
    useEffect(() => {
        setSelection(DEFAULT_STORY_SELECTION);
    }, [activeStoryId]);

    const story = activeStoryId ? stories.find((row) => row.id === activeStoryId) : undefined;
    const view = activeStoryId ? storyViews[activeStoryId] : undefined;
    const storyData = view ? (storyViewData(view, templates) as unknown as StoryViewData) : undefined;
    const now = new Date().toISOString();
    const selectedAgentRow = selectedAgent ? agents.find((row) => row.kind === selectedAgent) : undefined;
    const selectedAgentTitle = selectedAgentRow?.title ?? selectedAgent;

    /** The tile's one verb: the centre becomes that employee's retained threads. */
    const openAgent = (kind: string): void => {
        void store.selectAgent(selectedAgent === kind ? null : kind);
    };

    /**
     * The left rail is navigation too: opening a phrase or folder changes the centre, so an
     * employee's thread surface must stop being the selected thing at the same moment.
     */
    const selectPanel = (next: StorySelection): void => {
        void store.selectAgent(null);
        setSelection(next);
    };

    return (
        <div className="station" data-theme="ink" data-testid="station">
            <TopBar />

            <div className="station__regions">
                {/* Region 1 — STORIES: phase-first, then status, awaiting on top (U-1). Below the
                    list sits the selected Story's own phrase rail — the four phrases and the
                    folders the content area can open, and nothing else. */}
                <aside className="region region--stories" data-region="stories" aria-label="Stories">
                    <div className="region__body region__body--stack">
                        <StoriesPanel />
                        {activeStoryId ? (
                            <StoryOutline view={storyData} selection={selection} onSelect={selectPanel} />
                        ) : null}
                    </div>
                </aside>

                {/* Region 2 — THE STORY, the Author's queue (U-10), or the employee whose tile was
                    clicked (U-8). The thread surface REPLACES the centre: a thread belongs to a
                    Story's phrase, not to the rail that names the employee. */}
                <main
                    className="region region--story"
                    data-region="story"
                    aria-label={selectedAgent ? `${selectedAgentTitle} threads` : 'The story'}
                >
                    {selectedAgent ? (
                        <>
                            <div className="region__head">
                                {/* R7 — the centre is the selected employee's thread surface: the region's
                                    own accessible name already says "Writer threads" (above) and the tile
                                    is lit in the rail, so the heading printing "Writer — threads" again
                                    only repeats it. One word for the content, one sentence for the region. */}
                                <h2 className="region__title">Threads</h2>
                                <button
                                    type="button"
                                    className="button button--ghost"
                                    onClick={() => void store.selectAgent(null)}
                                >
                                    Dismiss
                                </button>
                            </div>
                            <div className="region__body">
                                {/* U-8: every thread the employee ran, across every Story and every
                                    phrase session, oldest first. A closed bar's detail is its request
                                    and its answer; a running bar adds the live steps below the
                                    collapsed request, so the Author sees what is happening now.
                                    The `key` is the employee kind: it remounts the surface when the
                                    Author clicks a different tile, so one employee's expanded bars
                                    and explicit Archived choice never leak into the next one (R7). */}
                                <AgentThreadsView
                                    key={selectedAgent}
                                    kind={selectedAgent}
                                    threads={agentThreads[selectedAgent] ?? []}
                                    now={now}
                                    onKillRun={(runId) => void store.killRun(runId)}
                                />
                            </div>
                            <DirectiveBar selection={selection} />
                        </>
                    ) : activeStoryId ? (
                        <>
                            <div className="region__head">
                                <h2 className="region__title">{story?.title ?? 'the story'}</h2>
                                <button
                                    type="button"
                                    className="button button--ghost"
                                    onClick={() => store.closeStory()}
                                >
                                    Dismiss
                                </button>
                            </div>
                            <div className="region__body">
                                {view ? (
                                    /* W10: the rail chooses the pane; the content area renders
                                       exactly that phrase or folder. */
                                    <StoryView
                                        view={storyData as StoryViewData}
                                        selection={selection}
                                        actions={shellActions(store, activeStoryId)}
                                    />
                                ) : (
                                    /* U-11: no spinner while the first read is in flight. */
                                    <p className="panel__empty">reading the story…</p>
                                )}
                            </div>
                            <DirectiveBar selection={selection} homeTab={homeTab} />
                        </>
                    ) : (
                        <>
                            <div className="region__body region__body--home">
                                <HomeDesk tab={homeTab} onTab={setHomeTab} />
                            </div>
                            <DirectiveBar homeTab={homeTab} />
                        </>
                    )}
                </main>

                {/* Region 3 — the GLOBAL AGENTS. The phrase/thread history is not a rail panel:
                    the tile opens it in the centre. */}
                <aside className="region region--crew" data-region="crew" aria-label="Employees">
                    <div className="region__body">
                        {/* The roster is global: every Story's phase sessions run threads under
                            these employees, and an employee is an agent only while its thread
                            lives. Clicking a tile shows that employee's retained threads in the
                            centre. */}
                        <AgentsPanel
                            agents={agents}
                            models={agentModels}
                            onSetModel={(kind, model) => store.setAgentModel(kind, model)}
                            onSelectAgent={openAgent}
                            selectedAgent={selectedAgent}
                        />
                    </div>
                </aside>
            </div>
        </div>
    );
}

export default StorylineApp;
