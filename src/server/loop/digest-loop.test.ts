// A sweep is a timer, not a story change.
//
// D-14 makes a stale Digest block a review, so the sweep refreshes it. The old `applyDecision`
// wrote status/progress on every pass — even when nothing had changed — and the next sweep read
// that write as story state, rebuilt the Digest again, and repeated forever on a paused Story.
// This regression pins the no-op rule: two sweeps over an unchanged paused Story add no Digest.
import { describe, expect, it } from 'vitest';

import { createRig } from './mock';

describe('the sweep does not rebuild a Digest nobody changed (D-12a / D-14)', () => {
    it('leaves the Digest and its revision alone across no-op sweeps', async () => {
        const rig = await createRig();

        // Stop the Story, then let its one stop-decision land and the Digest catch up.
        await rig.engine.pauseStory(rig.storyId);
        await rig.run();

        const digestRev = rig.story().digest_rev;
        const digestRows = rig.store.digests.list().length;

        await rig.step();
        await rig.step();

        expect(rig.story().status).toBe('stopped');
        expect(rig.story().digest_rev).toBe(digestRev);
        expect(rig.store.digests.list()).toHaveLength(digestRows);
    });
});
