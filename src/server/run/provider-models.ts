// U-8 — the provider's model catalog, as the roster's dropdown offers it.
//
// WHY A SERVER ROUTE AND NOT A BROWSER FETCH: the dashboard is a CLIENT of the Storyline server
// (U-12), and the provider root is the one the harness engine dials (`STORYLINE_PROVIDER_BASE_URL`,
// default `http://localhost:8800/providers/private/v1`). Asking the server keeps the browser on one
// origin — no CORS hole — and turns a provider that is down into one sentence the Author can read
// (L-13) instead of a failed request in a console.
//
// THE SHAPE IS THE OPENAI-COMPATIBLE ONE the harness engine already speaks: `GET {base}/models`
// answers `{ object: 'list', data: [{ id, ... }] }`, and `id` is exactly the `model` routing key a
// completion sends back. A bad body is a fault with a sentence, never an empty list pretending the
// provider offers no models.
//
// The endpoint is derived from the SAME base URL the transport uses, so the dropdown can never list
// a catalog the runs do not ask. Model ids keep the provider's order and are deduplicated; entries
// without a usable `id` are skipped (nothing can be selected for them).

/** The catalog the roster's dropdown renders, plus the root it came from (the tile names it). */
export interface ProviderModelCatalog {
    /** The provider root the harness engine dials, trailing slashes collapsed. */
    base_url: string;
    /** Model ids in the provider's order. */
    models: string[];
}

export interface ProviderModelOptions {
    /** The provider root, e.g. `http://localhost:8800/providers/private/v1`. */
    baseUrl: string;
    /** The same optional bearer the transport sends; a key-free local relay gets no header. */
    apiKey?: string;
    /** Test seam; defaults to `globalThis.fetch`. */
    fetchImpl?: typeof fetch;
}

/** An error body is clipped so a relay's HTML page cannot become the whole response sentence. */
const MAX_ERROR_BODY = 400;

/** `${baseUrl}/models`, with trailing slashes collapsed (`.../v1/` must not become `.../v1//models`). */
export const providerModelsUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, '')}/models`;

/** The `data` array of an OpenAI-compatible catalog, or `undefined` when the envelope is wrong. */
const catalogEntries = (parsed: unknown): unknown[] | undefined => {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

    const data = (parsed as Record<string, unknown>).data;

    return Array.isArray(data) ? data : undefined;
};

/** One entry's `id`, trimmed, or `undefined` when the entry is not something the roster can run. */
const entryId = (entry: unknown): string | undefined => {
    if (typeof entry !== 'object' || entry === null) return undefined;

    const id = (entry as Record<string, unknown>).id;

    if (typeof id !== 'string') return undefined;

    const trimmed = id.trim();

    return trimmed.length === 0 ? undefined : trimmed;
};

const clip = (text: string): string => (text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text);

/**
 * Reads `GET {baseUrl}/models` and normalises it to the list the dropdown can offer. Every failure
 * throws an `Error` whose message is the product sentence; the route turns that into a 502.
 */
export async function listProviderModels(options: ProviderModelOptions): Promise<ProviderModelCatalog> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const url = providerModelsUrl(baseUrl);
    const headers: Record<string, string> = { accept: 'application/json' };
    const apiKey = options.apiKey?.trim() ?? '';

    if (apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;

    let response: Response;

    try {
        response = await fetchImpl(url, { method: 'GET', headers });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new Error(`the provider's model catalog at ${url} could not be reached — ${reason}`);
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        const detail = clip(body.trim());

        throw new Error(
            `the provider's model catalog at ${url} answered ${response.status}${detail.length === 0 ? '' : ` — ${detail}`}`
        );
    }

    let parsed: unknown;

    try {
        parsed = await response.json();
    } catch {
        throw new Error(`the provider's model catalog at ${url} was not JSON.`);
    }

    const entries = catalogEntries(parsed);

    if (entries === undefined) {
        throw new Error(`the provider's model catalog at ${url} did not include a data list.`);
    }

    const models: string[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
        const id = entryId(entry);

        if (id === undefined || seen.has(id)) continue;

        seen.add(id);
        models.push(id);
    }

    return { base_url: baseUrl, models };
}
