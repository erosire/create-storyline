// §10.1 — the four-region shell: STORIES | THE STORY | CREW + TEMPLATES, over a DIRECTIVE BAR.
//
// WHY THIS FILE IS ONLY A SHELL: §10.1 fixes the regions; the later waves fill them. Anything
// that reads a Story's contents (the Seed card, the Summary pane, the Ideas tray, the prose
// editor, the crew and template cards) is W10/W11's surface, so it is imported from the
// component that owns it and rendered into the region the layout names. The shell's own job is
// three things and nothing else: the store lifecycle, the home-vs-story switch (U-10: the queue
// IS the home view), and keeping the directive bar reachable from every region (U-9).
//
// THE RIGHT REGION, AND WHY IT MOVES (judgment call, stated in the report): `StoryView` (W10)
// renders the CREW rail and the TEMPLATES catalogue itself, because they are two halves of one
// readable tree — "the distance between the contract and its prose" (U-4) needs the harness
// that produced it beside it. So with a Story selected the centre region SPANS the story and
// crew columns and StoryView's own rail lands exactly in the third column of §10.1's grid
// (`data-open`). With no Story selected there is nothing for the rail to be about, so the shell
// renders the workspace CREW there itself and the catalogue waits for a Story (the pinned
// TemplatesPanel takes a `story`, and on the home view there is none).
//
// THE MODEL THE REGIONS SPEAK, in one place. Every story owns its own harness: its knowledge
// directory and its phrases are scoped to that story, and nothing crosses between stories. The
// agents are the one global thing — the right rail is the roster the Author configures once and
// every story's phrases run. A phrase is one session against the story's Goal, spinning threads
// to do a task. There is no main agent: the loop is fully autonomous from the Goal the Author
// types into the directive, and a phrase is dispatched because the Goal still has work.

import { useEffect } from 'react';

import { AuthorQueue } from './components/AuthorQueue';
import { CrewPanel } from './components/CrewPanel';
import { DirectiveBar } from './components/DirectiveBar';
import { AgentsPanel } from './components/AgentsPanel';
import { KnowledgeTree } from './components/KnowledgeTree';
import { NewStoryForm } from './components/NewStoryForm';
import { StoriesPanel } from './components/StoriesPanel';
import { StoryView } from './components/StoryView';
import { TopBar } from './components/TopBar';
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
    const { activeStoryId, stories, storyViews, runs, templates, knowledge, agents } = useDashboard();

    // The stream is the Dashboard's pulse: one subscription for the whole shell, torn down on
    // unmount (React StrictMode's double-mount is why the teardown has to be real).
    useEffect(() => store.start(), [store]);

    const story = activeStoryId ? stories.find((row) => row.id === activeStoryId) : undefined;
    const view = activeStoryId ? storyViews[activeStoryId] : undefined;
    const now = new Date().toISOString();

    return (
        <div className="station" data-theme="ink" data-testid="station">
            <TopBar />

            <div className="station__regions" data-open={activeStoryId ? 'true' : 'false'}>
                {/* Region 1 — STORIES: phase-first, then status, awaiting on top (U-1). Below the
                    list sits the selected Story's OWN harness — its knowledge directory, the
                    durable map of what that book is made of and nothing else. Phrase updates land
                    here while the story runs, so the listing the Author reads is the story they
                    picked. */}
                <aside className="region region--stories" data-region="stories" aria-label="Stories">
                    <div className="region__body region__body--stack">
                        <StoriesPanel />
                        {activeStoryId ? (
                            <KnowledgeTree tree={knowledge[activeStoryId]} loading={!knowledge[activeStoryId]} />
                        ) : null}
                    </div>
                </aside>

                {/* Region 2 — THE STORY, or the Author's queue when nothing is selected (U-10). */}
                <main className="region region--story" data-region="story" aria-label="The story">
                    {activeStoryId ? (
                        <>
                            <div className="region__head">
                                <h2 className="region__title">{story?.title ?? 'the story'}</h2>
                                <button
                                    type="button"
                                    className="button button--ghost"
                                    onClick={() => store.closeStory()}
                                >
                                    to the queue
                                </button>
                            </div>
                            <div className="region__body">
                                {view ? (
                                    /* W10: Seed card, ① Summary ② Plotlines ③ Chapters, the Ideas
                                       tray, revisions, the prose editor, the Goal panel — and the
                                       CREW/TEMPLATES rail this component renders (U-7, U-8).
                                       The cast is seam 1 of `shell-binding.ts`: the pinned payload
                                       carries the assigned template IDS, and the shell hands the
                                       rail the resolved records, which is what `CrewPanel` and
                                       `TemplatesPanel` take as their `templates` prop (U-8d needs
                                       each role's `agents` and `aggregate`, and the ids alone
                                       would draw an empty card). */
                                    <StoryView
                                        view={storyViewData(view, templates) as unknown as StoryViewData}
                                        actions={shellActions(store, activeStoryId)}
                                        railLead={<AgentsPanel agents={agents} />}
                                    />
                                ) : (
                                    /* U-11: no spinner while the first read is in flight. */
                                    <p className="panel__empty">reading the story…</p>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="region__body region__body--home">
                            <AuthorQueue />
                            <NewStoryForm />
                        </div>
                    )}
                </main>

                {/* Region 3 — the GLOBAL AGENTS, then the PHRASES still live (and, inside a
                    Story, the template catalogue that configures the roster). */}
                {activeStoryId ? null : (
                    <aside className="region region--crew" data-region="crew" aria-label="Agents and phrases">
                        <div className="region__body">
                            {/* The roster is global: every story's phrases run these agents.
                                Rank A is called out, before the phrases live right now. */}
                            <AgentsPanel agents={agents} />
                            {/* U-7 across every Story: with no Story selected the Author is on the
                                desk, and what is still running is the next thing that will land on it. */}
                            <CrewPanel
                                runs={runs}
                                templates={templates}
                                now={now}
                                onKillRun={(runId) => void store.killRun(runId)}
                            />
                            <p className="panel__hint">
                                the agents are global — open a Story to edit the roster its phrases run (U-8).
                            </p>
                        </div>
                    </aside>
                )}
            </div>

            {/* Region 4 — the DIRECTIVE BAR, full width, always in reach (U-9 / D-19). */}
            <DirectiveBar />
        </div>
    );
}

export default StorylineApp;
