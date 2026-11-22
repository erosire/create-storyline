// §10.2 U-10 / U-12 — the home desk, in two tabs.
//
// THE REQUEST TAB is the Author's queue: only decisions only the Author can make. The Editor
// auto-approves what its dial covers; what is left here is a finding the dial does not cover, an
// Idea to pick, an escalation the crew asked, or a missing capability the Author must configure.
//
// THE CREATE NEW STORY TAB is the entry point: the Author can write the title/Seed/chapter count
// and submit. The directive bar at the foot of the content is the prompt path — one sentence can
// open a Story and send it to that Story's Editor, which queues the work and can ask a question
// through `requestAuthor` (P7) — the question lands in Requests.
//
// WHY TABS RATHER THAN TWO STACKED PANELS: the queue is a list of decisions, the create form is a
// draft the Author is writing. Showing both at once made the home screen read as one long
// dashboard; the tabs keep the front page one job at a time.

import { useDashboard } from '../state';
import { AuthorQueue } from './AuthorQueue';
import { NewStoryForm } from './NewStoryForm';

/** The home desk's tab. The shell owns it because the input bar sits outside the scroll area. */
export type HomeTab = 'requests' | 'create';

export interface HomeDeskProps {
    tab: HomeTab;
    onTab: (tab: HomeTab) => void;
}

export function HomeDesk({ tab, onTab }: HomeDeskProps) {
    const { queue } = useDashboard();
    const requestStories = new Set(queue.map((item) => item.story_id)).size;

    return (
        <section className="home" data-testid="home-desk">
            <div className="home__tabs" role="tablist" aria-label="Dashboard">
                <button
                    type="button"
                    className="home__tab"
                    role="tab"
                    id="home-tab-requests"
                    aria-selected={tab === 'requests'}
                    aria-controls="home-panel-requests"
                    data-active={tab === 'requests' ? 'true' : 'false'}
                    onClick={() => onTab('requests')}
                >
                    Requests
                    {requestStories > 0 ? <span className="home__tab-count">{requestStories}</span> : null}
                </button>
                <button
                    type="button"
                    className="home__tab"
                    role="tab"
                    id="home-tab-create"
                    aria-selected={tab === 'create'}
                    aria-controls="home-panel-create"
                    data-active={tab === 'create' ? 'true' : 'false'}
                    onClick={() => onTab('create')}
                >
                    Create New Story
                </button>
            </div>

            {tab === 'requests' ? (
                <div
                    className="home__panel"
                    role="tabpanel"
                    id="home-panel-requests"
                    aria-labelledby="home-tab-requests"
                    data-testid="home-requests"
                >
                    <AuthorQueue />
                </div>
            ) : (
                <div
                    className="home__panel home__panel--create"
                    role="tabpanel"
                    id="home-panel-create"
                    aria-labelledby="home-tab-create"
                    data-testid="home-create"
                >
                    <NewStoryForm />
                </div>
            )}
        </section>
    );
}

export default HomeDesk;
