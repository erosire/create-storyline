// `seedHashOf` — the FNV-1a 32-bit value `seed_briefs.seed_hash` carries (§3.3).
//
// The expected values are not captured from the implementation: each was computed independently
// (FNV-1a over UTF-16 code units, rendered as 8 lowercase hex digits) and cross-checked against
// the implementation's output, so the test pins the ALGORITHM, not today's output. `811c9dc5` is
// FNV's published offset basis, which is also why the empty string is the first assertion.
import { seedHashOf } from './seed-hash';

describe('seedHashOf', () => {
    it('hashes the empty string to the FNV-1a offset basis', () => {
        expect(seedHashOf('')).toBe('811c9dc5');
    });

    it('renders a known Seed as exactly 8 lowercase hex chars', () => {
        expect(seedHashOf('Cold Mountain')).toBe('428748ea');
        expect(seedHashOf('A cartographer returns to the valley she mapped as a girl.')).toBe('05d24840');

        // Fixed width is load-bearing: a short hash would break any prefix comparison the store's
        // `seed_hash` readers do, so the contract is the exact string, not merely the value.
        expect(seedHashOf('Cold Mountain')).toHaveLength(8);
        expect(seedHashOf('Cold Mountain')).toMatch(/^[0-9a-f]{8}$/);
    });

    it('walks UTF-16 code units, so non-ASCII Seed text is hashed deterministically', () => {
        // 雪の山 hashes as the code units 0x96ea, 0x306e, 0x5c71 — the same walk a browser and a
        // Node process perform, which is what lets the dashboard verify a stored hash.
        expect(seedHashOf('雪の山')).toBe('f766c0c8');
    });

    it('is a change detector: any Seed edit changes the hash', () => {
        // One character of difference must be enough to re-arm the structuring (§3.3).
        expect(seedHashOf('Cold Mountain')).not.toBe(seedHashOf('Cold Mountain.'));
        expect(seedHashOf('cold mountain')).not.toBe(seedHashOf('Cold Mountain'));
    });
});
