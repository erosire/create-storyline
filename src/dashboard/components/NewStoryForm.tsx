// §10.2 U-12 + P5 — the New Story form: a title and a Seed.
//
// WHY IT SITS ON THE HOME VIEW: U-12 requires the Dashboard to work with zero harnesses
// running, and the first thing that is true of a brand-new Story is that nothing runs on it
// yet. So the entry point to the whole product is the Author writing the one artifact every
// later crew is measured against (P5: the Seed is read-only for every agent, forever).
//
// WHY THE CHAPTER COUNT IS NOT HERE: phase ① samples the Summary from the Seed. The chapter
// count binds phase ②'s plotline set (C-0), so it is declared when the Author is actually
// planning chapters — not on the screen that opens a Story.

import { useState } from 'react';
import { useDashboardStore } from '../state';

export function NewStoryForm() {
    const store = useDashboardStore();
    const [title, setTitle] = useState('');
    const [idea, setIdea] = useState('');
    const [busy, setBusy] = useState(false);

    // The Seed and a title are the only hard requirements: phase ①'s crews expand the Seed
    // (D-4), so an empty Seed gives them nothing to measure against.
    const canCreate = title.trim().length > 0 && idea.trim().length > 0;

    const submit = async () => {
        if (!canCreate || busy) {
            return;
        }
        setBusy(true);
        const row = await store.createStory({ title: title.trim(), idea: idea.trim() });
        setBusy(false);
        // Only cleared when the write landed — a refused create keeps the Author's draft.
        if (row) {
            setTitle('');
            setIdea('');
        }
    };

    return (
        <form
            className="new-story"
            data-testid="new-story-form"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <h2 className="panel__title">Start a Story</h2>
            <p className="panel__hint">the Seed is yours and read-only for every crew, forever (P5).</p>

            <label className="field">
                <span className="field__label">Title</span>
                <input
                    className="field__input"
                    name="title"
                    data-testid="field-title"
                    value={title}
                    autoComplete="off"
                    placeholder="the mentor's second death"
                    onChange={(event) => setTitle(event.target.value)}
                />
            </label>

            <label className="field">
                <span className="field__label">Seed</span>
                <textarea
                    className="field__input field__input--seed"
                    name="idea"
                    data-testid="field-seed"
                    rows={5}
                    value={idea}
                    placeholder="a disgraced cartographer must map the sea that ate her fleet, and the sea remembers her name"
                    onChange={(event) => setIdea(event.target.value)}
                />
            </label>

            <button
                type="submit"
                className="button button--primary"
                data-testid="field-create"
                disabled={!canCreate || busy}
            >
                Write the Summary
            </button>
        </form>
    );
}

export default NewStoryForm;
