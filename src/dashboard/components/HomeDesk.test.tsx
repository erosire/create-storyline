// U-10 / U-12 — the home desk is tabbed: requests first, then the create form.
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { HomeDesk, type HomeTab } from './HomeDesk';
import { click, queueItem, renderShell } from '../testing/shell-fakes';

/** The shell owns the tab; this harness gives the standalone desk the same controlled prop. */
function Desk() {
    const [tab, setTab] = useState<HomeTab>('requests');
    return <HomeDesk tab={tab} onTab={setTab} />;
}

describe('HomeDesk — Requests and Create New Story (U-10 / U-12)', () => {
    it('opens on Requests, with the queue, and keeps the create form on its own tab', async () => {
        await renderShell(<Desk />, [], [queueItem('finding_1')]);

        expect(screen.getByTestId('author-queue')).toBeTruthy();
        expect(screen.queryByTestId('new-story-form')).toBeNull();
        expect(screen.getByRole('tab', { name: /Requests/ }).getAttribute('aria-selected')).toBe('true');

        await click(screen.getByRole('tab', { name: 'Create New Story' }));

        expect(screen.getByTestId('new-story-form')).toBeTruthy();
        expect(screen.getByText('Start a Story')).toBeTruthy();
        expect(screen.queryByTestId('author-queue')).toBeNull();
    });
});
