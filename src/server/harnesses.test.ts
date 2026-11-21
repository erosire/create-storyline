// The harness listing: the shipped sessions and their rank-A agents, projected from the
// runtime package rather than re-typed here.
import { describe, expect, it } from 'vitest';
import { harnessListings } from './harnesses';

describe('harnessListings', () => {
    it('lists every shipped harness with its entry agent and tool count', () => {
        const listings = harnessListings();

        expect(listings.length).toBeGreaterThan(0);
        expect(listings.map((listing) => listing.name)).toEqual(expect.arrayContaining(['general', 'reviewer']));

        for (const listing of listings) {
            expect(listing.title.length).toBeGreaterThan(0);
            expect(listing.agents.length).toBeGreaterThan(0);
            expect(listing.agents.some((agent) => agent.name === listing.entry)).toBe(true);
            expect(listing.rank_a.length).toBeGreaterThan(0);
            expect(listing.tool_count).toBeGreaterThanOrEqual(0);
        }
    });

    it('states the rank that gates delegation, and marks the entry agent as routing only', () => {
        const general = harnessListings().find((listing) => listing.name === 'general');

        expect(general).toBeDefined();
        expect(general?.agents[0]?.rank).toBe('A');
        expect(general?.agents[0]?.entry).toBe(true);
        expect(general?.rank_a).toEqual(
            general?.agents.filter((agent) => agent.rank === 'A').map((agent) => agent.name)
        );
    });
});
