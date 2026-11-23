// The Seed hash — the value `seed_briefs.seed_hash` carries so the pipeline can tell whether an
// accepted brief still describes the Author's CURRENT Seed (documents/phase-1-research-pipeline.md
// §3.3: "A Seed edit re-arms the structuring").
//
// WHY A LOCAL HASH AND NOT `node:crypto`: this module is imported by `shared/**`, which is
// browser-bundled (the dashboard reads the same contract), so a Node builtin is not available and
// an async Web Crypto digest would make the store's write path async for no benefit. FNV-1a is
// enough for the job because the hash is a CHANGE DETECTOR over one Story's own Seed text, never
// a security primitive or a cross-corpus key.
//
// NO IMPORTS AND NO BEHAVIOUR BEYOND THIS FUNCTION, by the same rule as `./types`: shared modules
// stay pullable into both a browser bundle and a Node process.

/** FNV-1a's 32-bit offset basis (the hash of the empty string). */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a's 32-bit prime. `Math.imul` is what makes the multiply 32-bit-exact in JS. */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit over the text, rendered as 8 lowercase hex chars.
 *
 * The walk is over UTF-16 code units (`charCodeAt`), which is deterministic for every JS string
 * — including the non-ASCII text a Story's Seed may contain — without requiring a TextEncoder.
 * An astral character hashes as its two surrogate code units; that is stable across runs and
 * platforms, which is all `seed_hash` needs. `>>> 0` reinterprets the signed 32-bit multiply as
 * unsigned, and `padStart(8, '0')` keeps the output a fixed width so two different Seeds can
 * never render to hashes of different lengths.
 */
export const seedHashOf = (text: string): string => {
    let hash = FNV_OFFSET_BASIS;

    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }

    return hash.toString(16).padStart(8, '0');
};
