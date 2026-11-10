// Workstation smoke tests: the composition's values reach the DOM, through the shell.
//
// WHY THIS FILE EXISTS AT ALL (and why it stays at seven tests): the plugin suites prove the
// graph, the state cells and the commands; nothing there proves a cell's value is ON SCREEN.
// So these tests mount the WHOLE shell — the same tree StorylineApp renders — against the
// doubled seams and assert what a story-first workstation must show: the four areas, the
// Titles, the three equal agents, the transcript of THIS Title, the prose a CHAINED turn
// leaves, the sentence a write the engine REFUSED produces, and the sentences a failure makes.
// Each test asserts the exact rendered content of one known payload; broad interaction coverage
// lives in the plugin suites, not here.
//
// HOW THE DATA ARRIVES: through the real plugin path. `buildStoryline` runs the boot read
// against a doubled api (see ../testing/doubles.ts), so the Titles, the store and the roster
// land in their cells the way a live server would put them there.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { StorylineThreadMessage } from '../../api';
import { buildStoryline, THREADS, threadMessagesFor } from '../testing/doubles';
import { WorkstationShell } from '../WorkstationShell';

/** One area, panel or strip, queried as its own scope — 'Reader' and 'Storyline' each appear twice. */
type Scope = (selector: string) => ReturnType<typeof within>;

/** One conversation entry, as the conversation read returns it (src/api/storyline.ts). */
const entry = (position: number, role: StorylineThreadMessage['role'], text: string): StorylineThreadMessage => ({
    position,
    messageId: `m-${position}`,
    role,
    text
});

/**
 * Mounts the whole workstation and lets the boot reads land INSIDE `act`, so the renders
 * React owes those writes happen before the first assertion instead of as a warning later.
 */
async function renderStation(options: Parameters<typeof buildStoryline>[0] = {}) {
    const built = buildStoryline(options);
    const view = render(<WorkstationShell instance={built.instance} />);

    await act(async () => {
        await built.flush();
    });

    const scope: Scope = (selector) => within(view.container.querySelector(selector) as HTMLElement);

    /**
     * Tears the station down in the order the kernel needs: unmount FIRST, then dispose.
     * Disposing while the tree is still mounted makes a still-subscribed view read a
     * detached cell, which throws `DashboardError('disposed')` — the same ordering rule
     * StorylineApp.tsx defers a microtask to keep.
     */
    const teardown = (): void => {
        view.unmount();
        built.instance.dispose();
    };

    return { ...built, ...view, scope, teardown };
}

/** Every test unmounts its tree, so two stations never share the document. */
afterEach(() => cleanup());

describe('the workstation shell', () => {
    it('paints the four areas, five panels and four chips the composition contributes', async () => {
        const { container, scope, teardown } = await renderStation();

        // The areas come from the layout service, not from a list written in the shell. The
        // panel cards are labelled too, so the regions are read by element, not by query.
        expect([...container.querySelectorAll<HTMLElement>('section[aria-label]')].map((node) => node.getAttribute('aria-label'))).toEqual([
            'Title tree',
            'Story document',
            'Agents',
            'Composer'
        ]);

        // The panels come from the slot: the shell groups by `region` in slot order, so this
        // list is the placement the plugins declared, in the order the operator reads it.
        expect([...container.querySelectorAll<HTMLElement>('.panel__title')].map((node) => node.textContent)).toEqual([
            'Titles',
            'Story',
            'Agents',
            'Conversation',
            'Composer'
        ]);

        // The strip is the chip slot: brand, the Title being worked on, the observation, skin.
        const strip = scope('.station__chips');

        expect(container.querySelectorAll('.chip')).toHaveLength(4);
        expect(strip.getByText('Storyline')).toBeTruthy();
        expect(strip.getByText('Fog on the water')).toBeTruthy();
        // The stream chip's sentence is JSX text split across nodes, so the whole element is
        // compared rather than one fragment of it.
        expect(container.querySelector('.chip--stream')?.textContent).toBe('stream: idle');
        expect(strip.getByRole('button', { name: 'Toggle theme' })).toHaveProperty('textContent', 'ink');

        // Story-first copy, and no harness vocabulary anywhere an operator reads it.
        expect(screen.getByText('Titles on the left · the story in the middle · writer, reader and editor on the right')).toBeTruthy();

        for (const word of ['harness', 'preset', 'primary', 'subagent', 'session']) {
            expect((container.textContent ?? '').toLowerCase()).not.toContain(word);
        }

        teardown();
    });

    it('lists the Titles with the open one expanded into the four story documents', async () => {
        const { container, scope, teardown } = await renderStation();
        const tree = scope('.tree__titles');

        // Both Titles, newest first, and only the open one is marked active.
        const rows = [...container.querySelectorAll<HTMLElement>('.tree__title')];

        expect(rows.map((row) => row.dataset.active)).toEqual(['yes', 'no']);
        expect(tree.getByText('Fog on the water')).toBeTruthy();
        expect(tree.getByText('Untitled 2')).toBeTruthy();

        // The open Title expands with its outlines showing — the document the center pane
        // starts on — and every other group is opened by clicking its header.
        const groups = [...container.querySelectorAll<HTMLElement>('.tree__group')];

        expect(groups.map((group) => group.dataset.kind)).toEqual(['outlines', 'chapters', 'profiles', 'storyline']);
        // Each header carries the snapshot's own count for that collection: one row each.
        expect([...container.querySelectorAll<HTMLElement>('.tree__group-name')].map((node) => node.textContent)).toEqual([
            'Outlines1',
            // The document an operator reads is the PLOTLINES document; the wire collection
            // name (`chapters`) never reaches the tree, the tabs or the document title
            // (`CONTENT_LABELS`, one label for all three).
            'Plotlines1',
            'Profiles1',
            'Storyline1'
        ]);
        // Only the outlines group starts expanded, because that is the document the center
        // pane opens on; the rest are one click away.
        expect([...container.querySelectorAll<HTMLElement>('.tree__group-name[aria-expanded="true"]')].map((node) => node.textContent)).toEqual([
            'Outlines1'
        ]);

        // A group header is also a selection: it opens that document in the center pane, so
        // the tree is one click from every document.
        for (const kind of ['chapters', 'profiles']) {
            fireEvent.click(container.querySelector(`.tree__group[data-kind="${kind}"] .tree__group-name`) as HTMLButtonElement);
        }

        await waitFor(() => expect(container.querySelectorAll('.tree__group[data-kind="profiles"] .tree__item')).toHaveLength(1));

        // The character row carries the `(F)` its trait says — the api's rule, rendered here.
        expect(within(container.querySelector('.tree__group[data-kind="profiles"]') as HTMLElement).getByText('Ada (F)')).toBeTruthy();
        expect(within(container.querySelector('.tree__group[data-kind="outlines"]') as HTMLElement).getByText('Opening')).toBeTruthy();

        // The chapter's status chips are the workstation's one write into the story, and the
        // status it already has is the pressed one.
        const tags = [...container.querySelectorAll<HTMLButtonElement>('.tags .tag')];

        expect(tags.map((tag) => tag.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);

        teardown();
    });

    it('shows writer, reader and editor as three equal cards with the phase the roster backs', async () => {
        const { container, scope, teardown } = await renderStation();

        const cards = () => [...container.querySelectorAll<HTMLElement>('.card')];

        // Three targets, in the contract's order, with no ranking anywhere in the markup.
        expect(cards().map((card) => card.dataset.agent)).toEqual(['writer', 'reader', 'editor']);
        expect([...container.querySelectorAll<HTMLElement>('.badge[data-phase]')].map((badge) => badge.dataset.phase)).toEqual([
            'running',
            'idle',
            'idle'
        ]);
        // The conversation each agent answers on, named the way the server names it.
        expect([...container.querySelectorAll<HTMLElement>('.card__label')].map((node) => node.textContent)).toEqual([
            'storyline:writer',
            'storyline:reader',
            'storyline:editor'
        ]);
        // The composer starts on one of them, and that card is the marked one.
        expect(cards()[0]?.dataset.target).toBe('yes');
        expect(cards()[1]?.dataset.target).toBe('no');

        // Following an agent is one gesture: the card moves the composer's target, and the
        // composer's own picker agrees with it.
        fireEvent.click(scope('.cards').getByText('Reader'));

        await waitFor(() => expect(cards()[1]?.dataset.target).toBe('yes'));
        expect(scope('.composer__agents').getByRole('button', { name: 'Reader' }).getAttribute('aria-pressed')).toBe('true');

        teardown();
    });

    it('sends from the composer into the Title it is looking at, and keeps each Title transcript separate', async () => {
        const { calls, container, scope, teardown } = await renderStation();
        const input = () => container.querySelector('.composer__input') as HTMLTextAreaElement;

        expect(input().value).toBe('');
        expect(input().disabled).toBe(false);

        fireEvent.change(input(), { target: { value: 'Write the opening scene.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        // The submit goes to the writer's conversation — the harness routes by thread, so the
        // composer's pick IS the targeting, and the Title was already open (no create).
        await waitFor(() => expect(calls).toContain('submit:thread-writer:Write the opening scene.'));
        expect(calls).toContain('openThread:ses-new:writer');
        expect(calls.filter((call) => call.startsWith('createTitle'))).toEqual([]);

        const transcript = () => scope('.transcript');

        expect((container.querySelector('.transcript') as HTMLOListElement).dataset.session).toBe('ses-new');
        expect(transcript().getByText('you')).toBeTruthy();
        expect(transcript().getByText('Write the opening scene.')).toBeTruthy();

        // The draft is spent, and a run is open, so Send is locked and Stop is offered.
        await waitFor(() => expect(input().value).toBe(''));
        expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
        expect(screen.getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', false);

        // The other Title, reached by clicking it in the tree: its transcript is empty, and
        // its own send never shows the first Title's line. This is per-Title isolation where
        // an operator actually sees it.
        fireEvent.click(scope('.tree__titles').getByText('Untitled 2'));

        await waitFor(() => expect(screen.getByText('No conversation yet for “Untitled 2”.')).toBeTruthy());

        fireEvent.change(input(), { target: { value: 'Read chapter one.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(calls).toContain('submit:thread-writer:Read chapter one.'));
        expect((container.querySelector('.transcript') as HTMLOListElement).dataset.session).toBe('ses-old');
        expect(transcript().queryByText('Write the opening scene.')).toBeNull();
        expect(transcript().getAllByRole('listitem')).toHaveLength(2);
        // The other Title's conversation was opened, not the one still on screen.
        expect(calls).toContain('openThread:ses-old:writer');

        teardown();
    });

    it('shows the prose a chained turn leaves, in the order its two live cues actually arrive', async () => {
        // A CHAINED RUN HAS NO TURN ROW. It posts its task into a conversation with
        // `sendThreadInput` (src/server/orchestrator.ts), so no `turn.upsert`, no display
        // document and no stream delta ever arrives for it — the conversation read is the only
        // place its prose exists (plugins/agents.ts). Two frames bring it on screen, and the T13
        // defect was that only ONE of them was wired:
        //   • `records.updated` is published SYNCHRONRONOUSLY inside the committed tool call
        //     (harness src/server/sessions.ts:2262-2296), so it lands BEFORE the run's answer is
        //     appended (src/harness.ts:9811). It is what shows the chained TASK.
        //   • the roster row's `message_count` moving under `thread.upsert` is the only frame
        //     that says the conversation itself grew — which is what shows the ANSWER, and the
        //     only cue at all for the last hop of the shipped chain (the reader, told to change
        //     nothing, src/server/presets.ts) that writes no record.
        // The rounds below walk that ordering, cue by cue, and assert the rows are ON SCREEN.
        let round = 0;

        /** One conversation read: the same threads, growing entry by entry as each cue lands. */
        const conversation = (sessionId: string, threadId: string) => {
            const history = [entry(7, 'agent', 'Chapter four holds.')];

            if (threadId === 'thread-writer') {
                if (round >= 1) history.push(entry(8, 'user', 'You were called because the editor finished a turn.'));
                if (round >= 2) history.push(entry(9, 'agent', 'The opening still holds; chapter five is the problem.'));
            }

            if (threadId === 'thread-reader' && round >= 3) {
                history.push(entry(8, 'user', 'You were called because the writer finished a turn.'));
                history.push(entry(9, 'agent', 'Chapter five is the problem: the middle has no stake.'));
            }

            return threadMessagesFor(sessionId, threadId, history);
        };

        /** The roster as the server reports it: the counts move when a conversation grows. */
        const roster = () =>
            THREADS.map((row) => {
                if (row.agent === 'writer') return { ...row, messageCount: round >= 2 ? 11 : round >= 1 ? 10 : 9 };
                if (row.agent === 'reader') return { ...row, messageCount: round >= 3 ? 4 : 2 };

                return row;
            });

        const { calls, container, flush, stream, teardown } = await renderStation({
            api: { listThreads: async () => roster(), readThreadMessages: async (sessionId, threadId) => conversation(sessionId, threadId) }
        });

        const activity = () => [...container.querySelectorAll<HTMLElement>('.card__activity')];
        const rows = () => [...container.querySelectorAll<HTMLElement>('.transcript .turn')];
        const reads = () => calls.filter((call) => call.startsWith('readThreadMessages:'));

        // The card answers "what is this agent holding?" for a page that opened mid-story: the
        // newest line of its conversation, read from the conversation. The history itself is NOT
        // in the transcript yet — a page that opens on a running story has nothing to announce,
        // and replaying it would put the operator's own prompts back as chain traffic.
        expect(activity().map((node) => node.dataset.author)).toEqual(['agent', 'agent', 'agent']);
        expect(within(activity()[0] as HTMLElement).getByText('Chapter four holds.')).toBeTruthy();
        expect(container.querySelector('.transcript')).toBeNull();

        // CUE 1 — the editor's tool call commits. The frame arrives inside the call, so this is
        // the moment the chained TASK is on screen; the writer has not answered yet.
        round = 1;

        await act(async () => {
            stream().onRecords?.({ storeRev: 14, collectionsRev: 2 });
            await flush();
        });

        expect(rows().map((row) => row.dataset.role)).toEqual(['system']);
        expect(rows().map((row) => row.dataset.triggered)).toEqual(['yes']);
        expect(within(rows()[0] as HTMLElement).getByText('story chain')).toBeTruthy();
        expect(within(rows()[0] as HTMLElement).getByText('started by the story')).toBeTruthy();
        expect(within(rows()[0] as HTMLElement).getByText('You were called because the editor finished a turn.')).toBeTruthy();

        // CUE 2 — the writer answers, and the answer is PROSE: no record write, so no
        // `records.updated` frame follows it. The roster row carrying `message_count: 11` is the
        // frame this page can act on — and the defect threw it away, so the sentence stayed off
        // screen until some later record write anywhere in the session.
        const beforeAnswer = reads().length;

        round = 2;

        await act(async () => {
            stream().onThread?.({ ...THREADS[0], status: 'idle', sequence: 8, messageCount: 11 });
            await flush();
        });

        expect(reads().length).toBe(beforeAnswer + 1);
        expect(within(activity()[0] as HTMLElement).getByText('The opening still holds; chapter five is the problem.')).toBeTruthy();

        // The transcript holds the handoff: the task nobody typed, then the answer it produced.
        // The prompt is `system` — an operator never wrote it — and both rows say the story
        // started them, which is the fact a chained turn would otherwise hide.
        expect(rows().map((row) => row.dataset.role)).toEqual(['system', 'agent']);
        expect(rows().map((row) => (row.querySelector('.turn__text') as HTMLElement).textContent)).toEqual([
            'You were called because the editor finished a turn.',
            'The opening still holds; chapter five is the problem.'
        ]);

        // CUE 3 — the last hop of the shipped chain, the reader, instructed to change NOTHING
        // (src/server/presets.ts). The whole step happens with no record frame at all, which is
        // exactly the case that used to leave its critique invisible until the operator acted.
        const beforeReaderHop = reads().length;

        round = 3;

        await act(async () => {
            stream().onThread?.({ ...THREADS[1], status: 'idle', sequence: 9, messageCount: 4 });
            await flush();
        });

        expect(reads().length).toBeGreaterThan(beforeReaderHop);
        expect(within(activity()[1] as HTMLElement).getByText('Chapter five is the problem: the middle has no stake.')).toBeTruthy();
        expect(rows().map((row) => row.dataset.role)).toEqual(['system', 'agent', 'system', 'agent']);
        expect(rows().map((row) => (row.querySelector('.turn__text') as HTMLElement).textContent)).toEqual([
            'You were called because the editor finished a turn.',
            'The opening still holds; chapter five is the problem.',
            'You were called because the writer finished a turn.',
            'Chapter five is the problem: the middle has no stake.'
        ]);

        teardown();
    });

    it('refuses a chapter status the engine refused, in the row the operator clicked', async () => {
        // The workstation's one write into the story is a chapter's status, and a stale CAS token
        // is answered with the CURRENT record rather than an HTTP error (harness
        // src/core/records.ts `staleRecordError`). The T13 defect swallowed that sentence in a
        // rejection nobody was holding, so the symptom was a chip that simply would not move.
        const sentence = 'stale-record: chapters #ch-1 is at rev 7 (edited by writer); expected rev 4';
        const { calls, container, scope, teardown } = await renderStation({
            api: { setChapterStatus: async () => Promise.reject(new Error(sentence)) }
        });

        // The chapters group, opened to the row the snapshot carries.
        fireEvent.click(container.querySelector('.tree__group[data-kind="chapters"] .tree__group-name') as HTMLButtonElement);

        await waitFor(() => expect(container.querySelectorAll('.tree__group[data-kind="chapters"] .tag')).toHaveLength(3));

        // Nothing is claimed before the click: no notice anywhere on the page.
        expect(container.querySelector('.tree__write')).toBeNull();

        const chapter = () => within(container.querySelector('.tree__group[data-kind="chapters"]') as HTMLElement);

        fireEvent.click(chapter().getByRole('button', { name: 'draft' }));

        await waitFor(() => expect(calls).toContain('setChapterStatus:ch-1:4:draft'));
        await waitFor(() => expect(container.querySelector('.tree__write')?.textContent).toBe(sentence));

        // It is an error line, and it sits under the chapter it names: the row that was clicked
        // is its parent, so the sentence cannot wander to another Title's row.
        const notice = container.querySelector('.tree__write') as HTMLElement;

        expect(notice.className).toContain('notice--error');
        expect(notice.closest('.tree__item')?.querySelector('.row__title')?.textContent).toBe('The crossing');

        teardown();
    });

    it('says plainly when no Title can be read, and keeps the composer locked', async () => {
        const { container, scope, teardown } = await renderStation({ api: { listTitles: async () => Promise.reject(new Error('gateway down')) } });

        expect(screen.getByText('Titles could not be read: gateway down')).toBeTruthy();
        expect(scope('.station__chips').getByText('Titles unavailable')).toBeTruthy();

        // Nothing is invented: no document, no conversation, and a composer that cannot send.
        expect(screen.getByText('Pick a Title in the tree, or start a new one.')).toBeTruthy();
        expect(screen.getByText('No Title open.')).toBeTruthy();

        const input = container.querySelector('.composer__input') as HTMLTextAreaElement;

        expect(input.disabled).toBe(true);
        expect(input.placeholder).toBe('Pick a Title first');
        expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);

        teardown();
    });
});
