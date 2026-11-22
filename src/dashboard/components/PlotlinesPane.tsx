// Phrase 3 — Plotlines. One contract per chapter, without the prose.
//
// WHY IT STOPS AT THE CONTRACT: U-4's side-by-side reading is the Chapters phrase's job. On the
// Plotlines pane the Author is reviewing the promises themselves — what must happen, what must
// change, whose eyes it is seen through — so showing the prose here would repeat the next phrase
// and blur the question the screen is asking.
import type { Plotline } from '../../shared/types';
import { plotlinesInOrder } from './story-nav';
import type { StoryViewData } from './story-contract';

function PlotlineCard({ plotline }: { plotline: Plotline }) {
    return (
        <article className="plot-card" data-plotline-id={plotline.id}>
            <header className="plot-card-head">
                <span className="plot-card-order">Plotline {plotline.order}</span>
                <h4 className="plot-card-title">{plotline.heading || 'Untitled contract'}</h4>
                <div className="plot-card-badges">
                    {plotline.contract_locked ? (
                        <span className="sv-badge sv-badge-lock">locked — agents propose (D-6)</span>
                    ) : (
                        <span className="sv-badge">editable</span>
                    )}
                    {!plotline.aligned ? (
                        <span className="sv-badge sv-badge-warn">not aligned to the Summary (C-2)</span>
                    ) : null}
                    {plotline.needs_recheck ? (
                        <span className="sv-badge sv-badge-warn">needs recheck (L-11)</span>
                    ) : null}
                </div>
            </header>

            <dl className="plot-card-fields">
                <div className="plot-card-field">
                    <dt>Must happen (C-7)</dt>
                    <dd>{plotline.must_happen || '—'}</dd>
                </div>
                <div className="plot-card-field">
                    <dt>Must change (C-8)</dt>
                    <dd>{plotline.must_change || '—'}</dd>
                </div>
                <div className="plot-card-field">
                    <dt>POV</dt>
                    <dd>{plotline.pov || '—'}</dd>
                </div>
                <div className="plot-card-field">
                    <dt>Setups (C-5)</dt>
                    <dd>{plotline.setups || '—'}</dd>
                </div>
                <div className="plot-card-field">
                    <dt>Payoffs (C-5)</dt>
                    <dd>{plotline.payoffs || '—'}</dd>
                </div>
            </dl>
        </article>
    );
}

export interface PlotlinesPaneProps {
    view: StoryViewData;
    /** The rail's selected plotline, when the Author clicked one. */
    selectedRef?: string;
}

export function PlotlinesPane({ view, selectedRef }: PlotlinesPaneProps) {
    const plotlines = plotlinesInOrder(view);
    const shown = selectedRef ? plotlines.filter((plotline) => plotline.id === selectedRef) : plotlines;

    return (
        <section className="sv-pane sv-plotlines" aria-label="Plotlines">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Plotlines — Phrase 3</h3>
                <span className="sv-pane-badge">one contract per chapter, measured against the Summary</span>
            </header>

            {shown.length === 0 ? (
                <p className="sv-chapters-none">
                    No plotlines yet — Phrase 3 locks one contract per chapter once the Summary is signed.
                </p>
            ) : (
                <div className="plot-list">
                    {shown.map((plotline) => (
                        <PlotlineCard key={plotline.id} plotline={plotline} />
                    ))}
                </div>
            )}
        </section>
    );
}

export default PlotlinesPane;
