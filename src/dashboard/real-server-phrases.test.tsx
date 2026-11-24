// The GROUPED Summary Phrase over the real server: routes and payloads, not fixtures.
//
// `components/SummaryOverviewPane.test.tsx` and `components/SummaryGroupPane.test.tsx` feed the panes
// `story-fixtures`' mid-review book. THIS file has no fixtures for the phrase: every byte comes from a
// booted Storyline server (`../server/integration/harness`) — `GET /stories/:id/phrases`,
// `POST /stories/:id/phrases/groups/:groupId/revise`, `POST /stories/:id/summary/revise` — so the
// contract the dashboard's `api.ts` models is checked against the thing that answers it. The `ApiClient`
// double only carries those payloads; it invent nothing.
//
// WHY THE ASSERTIONS ARE STRUCTURAL WHERE THE IDS ARE NOT: a grouped book's five `phrase_groups.id`s are
// UUIDs issued per boot (the store is the memory, P1), so no UUID is hardcoded below. What IS pinned
// exactly is everything the dashboard depends on: the number of rows, their catalog keys, titles and
// order, the shape of every row, the composed Overview, the review block, and the full text of every
// refusal. `expect(id).toMatch(UUID)` is the assertion that the id is an OPAQUE uuid the rail must carry
// verbatim — the same assertion the group pane's route test makes about the URL.
//
// THE REFUSALS ARE THE POINT (U4, R4, R6). `writer_busy` in the read and the revise route's 409 are one
// read; the two refusals a legacy book answers (409, and 409 for the whole-Summary verb on a grouped
// book) are what R6's upgrade notice is built from; and a group id the book does not hold is a 404, so a
// stale selection can never write into someone else's group.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    bootStoryline,
    createSliceStory,
    type StorylineFixture
} from '../server/integration/harness';
import type { PhraseView } from './api';

/** A store-issued uuid: 8-4-4-4-12 hex, which is what the rail must carry verbatim. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The five Summary groups, in the order the catalog fixes and the rail draws (R1). */
const GROUP_KEYS = ['premise', 'promise', 'theme', 'tone', 'ending'];
const GROUP_TITLES = ['Premise', 'Promise', 'Theme', 'Tone', 'Ending'];

/** A uuid that is well formed and belongs to no Story in this workspace. */
const STRAY_GROUP_ID = '00000000-0000-4000-8000-000000000000';

/** The hand-written text one test installs into the Premise group. */
const HAND_TEXT = 'A premise the Author wrote by hand.';

describe('the grouped Summary Phrase on the wire', () => {
    let fixture: StorylineFixture;
    /** A book on the group pipeline: five UUID-addressed rows from the catalog. */
    let groupedId = '';
    /** A book still written as one text — the legacy shape R6 keeps readable (R5). */
    let samplingId = '';
    /** `GET /stories/:id/phrases` for the grouped book, exactly as it arrived at creation. */
    let phrase!: PhraseView;
    /** `GET /stories/:id/phrases` for the sampling book. */
    let samplingPhrase!: PhraseView;

    beforeAll(async () => {
        fixture = await bootStoryline();
        groupedId = await createSliceStory(fixture, 3, { mode: 'groups' });
        samplingId = await createSliceStory(fixture, 3);
        phrase = (await fixture.api<PhraseView>('GET', `/stories/${groupedId}/phrases`)).body;
        samplingPhrase = (await fixture.api<PhraseView>('GET', `/stories/${samplingId}/phrases`)).body;
    });

    afterAll(async () => {
        await fixture?.close();
    });

    describe('GET /stories/:id/phrases', () => {
        it('answers a grouped book with the catalog rows, each addressed by a uuid', () => {
            // The scalars: `mode` echoes `story.summary_mode` (the switch is a Setting, not a derived
            // fact), and an untouched book has no Overview of its own to show.
            expect(phrase.story_id).toBe(groupedId);
            expect(phrase.mode).toBe('groups');
            expect(phrase.phrase_id).toMatch(UUID);
            expect(phrase.revision).toBe(0);
            expect(phrase.overview).toBe('');

            // R1: exactly five rows, in catalog order, carrying the catalog's own names. The rail draws
            // these as the Summary phrase's children, so these titles ARE the children's accessible names.
            expect(phrase.groups.length).toBe(5);
            expect(phrase.groups.map((group) => group.key)).toEqual(GROUP_KEYS);
            expect(phrase.groups.map((group) => group.title)).toEqual(GROUP_TITLES);
            expect(phrase.groups.map((group) => group.order)).toEqual([1, 2, 3, 4, 5]);

            // Every row is uuid-addressed and the id is the ONLY identity: the same uuid appears in
            // `review.vector`, which is what reviews and deferrals are keyed by.
            const ids = phrase.groups.map((group) => group.id);
            for (const id of ids) expect(id).toMatch(UUID);
            expect(new Set(ids).size).toBe(5);
            expect(phrase.review.vector).toEqual(Object.fromEntries(ids.map((id) => [id, 0])));

            // An unwritten row: no text, no revision, no history, nobody holding it, nothing owed.
            for (const group of phrase.groups) {
                expect(group).toEqual({
                    id: group.id,
                    key: group.key,
                    title: group.title,
                    description: group.description,
                    order: group.order,
                    content: '',
                    revision: 0,
                    updated_by: null,
                    previous_content: '',
                    history: [],
                    owed_by_findings: [],
                    writer_busy: false
                });
            }

            // The Premise group's description is the catalog's own sentence, verbatim — the pane prints it
            // as the group's description, so this is the string the Author reads.
            expect(phrase.groups[0].description.startsWith('What the story is:')).toBe(true);

            // Nothing has been reviewed yet, so there is no finding and no task to show.
            expect(phrase.findings).toEqual([]);
            expect(phrase.tasks).toEqual([]);
        });

        it('reports the book as unwritten, with the mirror agreeing', () => {
            // The review block is the whole basis of the overview's state lines and of the sign-off gate,
            // so it is pinned as one object. `vector_hash` is a digest over the uuid→revision map and so
            // varies per boot; everything else is exact.
            const { vector_hash: vectorHash, ...review } = phrase.review;

            expect(review).toEqual({
                mode: 'groups',
                unwritten_groups: GROUP_KEYS,
                written_groups: 0,
                vector: Object.fromEntries(phrase.groups.map((group) => [group.id, 0])),
                review_seats: 1,
                reviews_on_current_vector: 0,
                deep_reviews_on_current_vector: 0,
                open_findings: 0,
                blocking_findings: 0,
                open_tasks: 0,
                mirror: {
                    summary_id: 'summary_0',
                    in_sync: true,
                    locked: false,
                    fields: GROUP_KEYS
                }
            });
            expect(vectorHash).toMatch(/^[0-9a-f]{16}$/);

            // The unwritten keys are catalog KEYS, not titles: the pane turns them into the display names
            // through the catalog (`titleOfPhraseGroupKey`), which is why the overview says `Ending`.
            expect(review.unwritten_groups).toEqual(GROUP_KEYS);
        });

        it('answers a legacy book with the same route and no rows — never a 404', async () => {
            // R6: this is the echo the shell must not mistake for a grouped book, and the reason the
            // phrase read may not 404: a legacy Story would otherwise raise an error on every poll.
            expect(samplingPhrase.story_id).toBe(samplingId);
            expect(samplingPhrase.mode).toBe('sampling');
            expect(samplingPhrase.phrase_id).toBeNull();
            expect(samplingPhrase.revision).toBe(0);
            expect(samplingPhrase.overview).toBe('');
            expect(samplingPhrase.groups).toEqual([]);
            expect(samplingPhrase.findings).toEqual([]);
            expect(samplingPhrase.tasks).toEqual([]);
            expect(samplingPhrase.review.mode).toBe('sampling');
            expect(samplingPhrase.review.written_groups).toBe(0);
            expect(samplingPhrase.review.unwritten_groups).toEqual([]);
        });
    });

    describe('POST /stories/:id/phrases/groups/:groupId/revise', () => {
        it("installs one group's text, recomposes the Overview, and leaves the uuid alone", async () => {
            const premise = phrase.groups[0];
            const res = await fixture.api<{
                story_id: string;
                phrase_id: string;
                revision: number;
                installed: unknown[];
                archived: unknown[];
                mirror: unknown;
                view: PhraseView;
            }>('POST', `/stories/${groupedId}/phrases/groups/${premise.id}/revise`, {
                content: HAND_TEXT,
                note: 'hand edit'
            });

            expect(res.status).toBe(200);
            // R5: a hand install is immediate — no candidate round, no selection — and it reports the
            // revision it installed, the superseded rows it archived, and the mirror fields it rewrote.
            expect({
                story_id: res.body.story_id,
                phrase_id: res.body.phrase_id,
                revision: res.body.revision,
                installed: res.body.installed,
                archived: res.body.archived,
                mirror: res.body.mirror
            }).toEqual({
                story_id: groupedId,
                phrase_id: phrase.phrase_id,
                revision: 1,
                installed: [
                    {
                        group_id: premise.id,
                        group_key: 'premise',
                        revision_id: 'group_revision_0',
                        number: 1
                    }
                ],
                archived: [],
                mirror: { summary_id: 'summary_0', fields: ['premise'], written: true }
            });

            // R2: the Overview is a READ. One group written means an Overview of exactly that group, and
            // the pane prints the composition rather than asking the Author to assemble it.
            expect(res.body.view.overview).toBe(`## Premise\n${HAND_TEXT}`);
            expect(res.body.view.revision).toBe(1);

            // The row keeps the id it was addressed by: the rail's selection survives the write because
            // nothing re-issues the group's identity.
            const written = res.body.view.groups.find((group) => group.key === 'premise')!;

            expect(written.id).toBe(premise.id);
            expect(written).toMatchObject({
                content: HAND_TEXT,
                revision: 1,
                owed_by_findings: [],
                writer_busy: false
            });
            expect(written.history.length).toBe(1);
            expect(written.history[0]).toEqual({
                id: 'group_revision_0',
                number: 1,
                state: 'latest',
                at: written.history[0]!.at,
                run_ref: null,
                finding_refs: [],
                task_refs: [],
                chars: HAND_TEXT.length
            });

            // The review moves with the write: one group written, four still named by catalog key.
            expect(res.body.view.review.written_groups).toBe(1);
            expect(res.body.view.review.unwritten_groups).toEqual(['promise', 'theme', 'tone', 'ending']);
            expect(res.body.view.review.vector[premise.id]).toBe(1);
        });

        it('the refetch after a write answers the same five uuid-addressed rows', async () => {
            const after = await fixture.api<PhraseView>('GET', `/stories/${groupedId}/phrases`);

            expect(after.status).toBe(200);
            expect(after.body.groups.map((group) => group.id)).toEqual(phrase.groups.map((group) => group.id));
            expect(after.body.groups.map((group) => group.title)).toEqual(GROUP_TITLES);
            expect(after.body.groups.map((group) => group.revision)).toEqual([1, 0, 0, 0, 0]);
            expect(after.body.overview).toBe(`## Premise\n${HAND_TEXT}`);
            expect(after.body.review.written_groups).toBe(1);
            expect(after.body.review.unwritten_groups).toEqual(['promise', 'theme', 'tone', 'ending']);
        });

        it('refuses an empty group text rather than blanking the group', async () => {
            const res = await fixture.api<{ error: string }>(
                'POST',
                `/stories/${groupedId}/phrases/groups/${phrase.groups[0]!.id}/revise`,
                { content: '   ', note: 'x' }
            );

            expect(res.status).toBe(400);
            expect(res.body.error).toBe(
                '`content` is the group\'s new text and must be a non-empty string (R2: an empty group text is a refusal, not a revision).'
            );
        });

        it('refuses a uuid the book does not hold, so a stale selection cannot write blind', async () => {
            // U5: the pane keeps the last good group while a read fails, and a group that has gone away
            // answers 404 — the write cannot land in a group the rail no longer lists.
            const res = await fixture.api<{ error: string }>(
                'POST',
                `/stories/${groupedId}/phrases/groups/${STRAY_GROUP_ID}/revise`,
                { content: 'text for a group that is not here', note: 'stale selection' }
            );

            expect(res.status).toBe(404);
            expect(res.body.error).toBe(
                `no phrase group named ${STRAY_GROUP_ID} is in the book (P1: the store is the memory)`
            );
        });

        it('refuses to revise a group on a book still written as one text, and names the upgrade', async () => {
            // R6: this is the sentence the upgrade notice is built from — the legacy book has no group
            // catalog, and the route says which verb turns it into one.
            const res = await fixture.api<{ error: string }>(
                'POST',
                `/stories/${samplingId}/phrases/groups/${STRAY_GROUP_ID}/revise`,
                { content: 'text for a group this book does not have', note: 'x' }
            );

            expect(res.status).toBe(409);
            expect(res.body.error).toBe(
                `this Story's Summary is still written as one text (no group catalog); ` +
                    `POST /stories/${samplingId}/phrases/import turns the flat Summary into groups first (R6).`
            );
        });

        it('refuses the whole-Summary round on a grouped book, so the two paths cannot both be asked', async () => {
            // R2/R5: there is no whole-Summary revision to request on a group book, and the route says
            // which verb replaces it. The pane's Overview therefore offers no `Request another revision
            // round` control — the refusal is not a UI promise the server would break.
            const res = await fixture.api<{ error: string }>(
                'POST',
                `/stories/${groupedId}/summary/revise`,
                { text: 'A whole Summary on a book that has groups.', reason: 'x' }
            );

            expect(res.status).toBe(409);
            expect(res.body.error).toBe(
                `this Story's Summary is written group by group, so there is no whole-Summary round to ask for — ` +
                    `a Writer result installs when it is accepted, and one group is rewritten with ` +
                    `POST /stories/${groupedId}/phrases/groups/:groupId/revise (R2, R5).`
            );
        });
    });
});
