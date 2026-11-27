// Characters — the cast sheet the crew builds from the Summary, and NOT a numbered phrase since T-W4.
//
// WHY IT IS A SUPPLEMENT. The rail's numbering follows the loop's signed artifacts, and the loop has no Characters
// phase to sign off: the cast is a SHEET the Writer maintains from the Summary under §7's `cast` permission row, so
// the pane keeps its records and loses the "Phrase 2" heading. The rail reaches it through the supplements list with
// the same `{panel:'characters'}` selection it always used, and "start the cast" stays a directive to the Editor
// rather than a second write path — this pane never edits a cast member itself.
//
// WHY THIS READS THE BOOK AND NOT THE KNOWLEDGE ARTICLE: §4.5's cast is the tracked sheet a
// reviewer checks behaviour against (D-9, C-9), so the pane shows the records as they stand.
import type { CastMember } from '../../types';
import type { StoryActions, StoryViewData } from './story-contract';
import { castMembers, summaryReadyForReview } from './story-nav';

const START_CHARACTERS =
    'Build the Characters from the Summary: for each major figure, record name, want, need, arc, voice, traits, and the state they carry now (D-9).';

const UPDATE_CHARACTERS =
    'Update the Characters from the current Summary: keep every established want, need and arc that still holds, and revise state_now where the story has moved.';

function CastCard({ member }: { member: CastMember }) {
    return (
        <article className="char-card" data-cast-id={member.id}>
            <header className="char-card-head">
                <h4 className="char-card-name">{member.name || 'Unnamed character'}</h4>
                {member.gender ? <span className="char-card-gender">{member.gender}</span> : null}
            </header>

            <dl className="char-card-fields">
                <div className="char-card-field">
                    <dt>Wants</dt>
                    <dd>{member.want || '—'}</dd>
                </div>
                <div className="char-card-field">
                    <dt>Needs</dt>
                    <dd>{member.need || '—'}</dd>
                </div>
                <div className="char-card-field">
                    <dt>Arc</dt>
                    <dd>{member.arc || '—'}</dd>
                </div>
                <div className="char-card-field">
                    <dt>Voice</dt>
                    <dd>{member.voice || '—'}</dd>
                </div>
                <div className="char-card-field char-card-field--state">
                    <dt>State now</dt>
                    <dd>{member.state_now || '—'}</dd>
                </div>
                {member.traits ? (
                    <div className="char-card-field">
                        <dt>Traits</dt>
                        <dd>{member.traits}</dd>
                    </div>
                ) : null}
            </dl>
        </article>
    );
}

export interface CharactersPaneProps {
    view: StoryViewData;
    actions: StoryActions;
    /** The rail's selected cast member, when the Author clicked one name. */
    selectedRef?: string;
}

export function CharactersPane({ view, actions, selectedRef }: CharactersPaneProps) {
    const cast = castMembers(view);
    const shown = selectedRef ? cast.filter((member) => member.id === selectedRef) : cast;
    const summary = view.summary;
    const summaryHasText =
        summary !== null &&
        summary !== undefined &&
        [summary.premise, summary.promise, summary.theme, summary.tone, summary.ending, summary.world_rules].some(
            (field) => typeof field === 'string' && field.trim().length > 0
        );
    const canStart = summaryHasText && summaryReadyForReview(view) && cast.length === 0;
    const canUpdate = summaryHasText && summaryReadyForReview(view) && cast.length > 0;

    /** One directive, addressed to the Editor — the only route that can ask the crew to work. */
    const ask = (text: string): void => {
        void actions.sendDirective?.(view.story.id, text);
    };

    return (
        <section className="sv-pane sv-characters" aria-label="Characters">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Characters</h3>
                {/* T-W4 — the badge says what the sheet IS now that the number is gone: a supplement the crew keeps
                    from the Summary, not a step the Author signs off. */}
                <span className="sv-pane-badge">
                    the cast the story is written against (D-9) · a supplement, not a signed phrase
                </span>
            </header>

            {shown.length === 0 ? (
                <div className="char-empty">
                    <h4 className="char-empty-title">No characters yet</h4>
                    <p className="char-empty-hint">
                        The cast is built from the Summary: want, need, arc, voice, and the state each character carries
                        right now. Start it once the Summary says who the book is about.
                    </p>

                    <button
                        type="button"
                        className="char-start"
                        disabled={!canStart || !actions.sendDirective}
                        title={
                            !summaryHasText
                                ? 'Write the Summary first — the cast is built from it.'
                                : !summaryReadyForReview(view)
                                  ? 'Finish the Summary first: the cast is built from it.'
                                  : !actions.sendDirective
                                    ? 'The directive route has not landed yet.'
                                    : 'Ask the Editor to start Phrase 2 from the Summary.'
                        }
                        onClick={() => ask(START_CHARACTERS)}
                    >
                        Start Characters
                    </button>
                </div>
            ) : (
                <>
                    <div className="char-list">
                        {shown.map((member) => (
                            <CastCard key={member.id} member={member} />
                        ))}
                    </div>

                    <footer className="char-actions">
                        <button
                            type="button"
                            className="char-update"
                            disabled={!canUpdate || !actions.sendDirective}
                            title={
                                actions.sendDirective
                                    ? 'Ask the Editor to refresh the cast from the current Summary.'
                                    : 'The directive route has not landed yet.'
                            }
                            onClick={() => ask(UPDATE_CHARACTERS)}
                        >
                            Update from the Summary
                        </button>
                        <span className="char-actions-hint">
                            The crew keeps the sheet current as the story moves (D-9, C-9).
                        </span>
                    </footer>
                </>
            )}
        </section>
    );
}

export default CharactersPane;
