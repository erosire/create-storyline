/**
 * §8.5 — research and proposal tools: `searchWeb`, `fetchPage`, `proposeIdea`,
 * `markUnverifiable`.
 *
 * T-6b is the governing rule and it is a rule about EVIDENCE, not about permission: "Web tools
 * are available to every role... the constraint is not who may browse but what counts as
 * evidence: a claim that reaches a locked artifact needs an Editor's verdict (C-15), whoever
 * fetched it." So the two web tools write nothing and are refused by nobody, and the tool that
 * DOES write (`proposeIdea`) is governed by the §7 `ideas` row, which §7 labels
 * "**write** (`proposeIdea`)" for the checker/Reader column.
 *
 * T-10 fixes the citation shape: every `sources[]` entry records `url_or_title`, the specific
 * `claim` it supports, and when it was accessed. A page cited for a claim it does not make gets
 * the Idea `refuted`, not "mostly right" — which is why the tools return the excerpt rather than
 * a polished answer.
 *
 * Tests inject `fetchImpl` (D-37): nothing in this file may touch the network on its own.
 */
import type { Idea, IdeaKind, IdeaSource } from '../../shared/types';
import { decidedIdea, fingerprintIdea, mustResolveRef, resolvedIdea } from './artifacts';
import { IDEA_KIND_ENUM, PHASE_ENUM, arr, obj, str, whyArg } from './schema';
import {
    buildAttribution,
    clip,
    commitAs,
    excerptAround,
    getText,
    htmlToText,
    ok,
    okValue,
    postJson,
    readEnv,
    repeatResult,
    revOf,
    nowIso,
    summarize,
    ToolRefusal,
    whyOf
} from './utilities';
import type { ToolDefinition, ToolResult } from './types';

/** The largest page text a tool returns (T-7): a whole book must not enter the context. */
const MAX_PAGE_TEXT = 8000;

/** The largest snippet one search hit may carry (T-7). */
const MAX_SNIPPET = 600;

/** Search providers in priority order. Each names the env key it needs and how to call it. */
interface SearchProvider {
    name: 'exa' | 'tavily';
    envKeys: string[];
    call(fetchImpl: typeof fetch, key: string, query: string, maxResults: number): Promise<SearchHit[]>;
}

/** One normalised search result, whatever provider produced it. */
interface SearchHit {
    title: string;
    url: string;
    snippet: string;
    published_at?: string;
    score?: number;
    provider: 'exa' | 'tavily';
}

/** Exa's `/search` response, narrowed to the fields this layer returns. */
interface ExaResponse {
    results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string; score?: number }>;
}

/** Tavily's `/search` response, narrowed the same way. */
interface TavilyResponse {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string; score?: number }>;
}

/**
 * The two providers this build supports. Exa is first because it returns passage text, which is
 * what a citation needs (T-10); Tavily is the fallback many Authors already have a key for.
 */
const SEARCH_PROVIDERS: SearchProvider[] = [
    {
        name: 'exa',
        envKeys: ['EXA_API_KEY'],
        async call(fetchImpl, key, query, maxResults) {
            const body = await postJson<ExaResponse>(
                fetchImpl,
                'https://api.exa.ai/search',
                { query, numResults: maxResults, type: 'auto', text: true },
                { 'x-api-key': key }
            );
            return (body.results ?? []).map((hit) => ({
                title: hit.title ?? '',
                url: hit.url ?? '',
                snippet: clip(hit.text ?? '', MAX_SNIPPET),
                ...(hit.publishedDate ? { published_at: hit.publishedDate } : {}),
                ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
                provider: 'exa' as const
            }));
        }
    },
    {
        name: 'tavily',
        envKeys: ['TAVILY_API_KEY'],
        async call(fetchImpl, key, query, maxResults) {
            // Tavily's API takes the key in the body, so no header is added here.
            const body = await postJson<TavilyResponse>(fetchImpl, 'https://api.tavily.com/search', {
                query,
                max_results: maxResults,
                include_answer: false,
                search_depth: 'basic'
            });
            return (body.results ?? []).map((hit) => ({
                title: hit.title ?? '',
                url: hit.url ?? '',
                snippet: clip(hit.content ?? '', MAX_SNIPPET),
                ...(hit.published_date ? { published_at: hit.published_date } : {}),
                ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
                provider: 'tavily' as const
            }));
        }
    }
];

/** The first configured provider, or null when the process has no key for either. */
function pickProvider(): { provider: SearchProvider; key: string } | null {
    for (const provider of SEARCH_PROVIDERS) {
        for (const envKey of provider.envKeys) {
            const key = readEnv(envKey);
            if (key) return { provider, key };
        }
    }
    return null;
}

/** Browsing is a capability, not a §7 permission: it rides on the run's own row, which every kind may read (T-6b). */
const WEB_PERMISSION = { writes: 'runs', level: 'read', mutating: false } as const;

/**
 * The failure shape when no provider is configured. NOT a rule refusal (there is no rule being
 * enforced) and NOT an escalation: the honest answer is "this run has no search", which the
 * agent records as a thinner Idea (D-27) or reports through `reportGap` (T-12) when the brief
 * genuinely needs it.
 */
function noProviderResult(tool: string): ToolResult {
    return {
        ok: false,
        error: `${tool}: no web provider is configured, so this process cannot reach the web.`,
        message:
            'No EXA_API_KEY or TAVILY_API_KEY is set, so browsing is unavailable. That is a thinner Idea, not a story defect: form the Idea from the records you can read, or call reportGap if the brief really needs a lookup (T-12).',
        provider_missing: true,
        env_keys: SEARCH_PROVIDERS.flatMap((provider) => provider.envKeys)
    };
}

// ── searchWeb ───────────────────────────────────────────────────────────────

/**
 * §8.5 `searchWeb`: "leads, not facts" — the result set is untrusted excerpts, and the Reader
 * cites while the Editor judges (D-27). No answer synthesis is done here on purpose: an answer
 * without a URL is exactly the improvised claim T-10 exists to prevent.
 */
const searchWeb: ToolDefinition = {
    name: 'searchWeb',
    description:
        'Search the web for leads: titles, urls, and short excerpts. Results are untrusted — fetch the page you intend to cite, and put the url and the claim it supports into the Idea sources (T-10, D-27).',
    inputSchema: {
        type: 'object',
        properties: {
            query: str('What to look for, phrased as the question you need answered.'),
            maxResults: { type: 'number', description: 'How many leads to return (default 5, max 10).' }
        },
        required: ['query']
    },
    ...WEB_PERMISSION,
    primaryArg: 'query',
    requires: ['query'],
    async execute(ctx): Promise<ToolResult> {
        const configured = pickProvider();
        if (!configured) return noProviderResult('searchWeb');

        const query = String(ctx.args.query ?? '').trim();
        const requested = Number(ctx.args.maxResults ?? 5);
        const maxResults = Number.isFinite(requested) ? Math.max(1, Math.min(10, Math.trunc(requested))) : 5;

        let hits: SearchHit[];
        try {
            hits = await configured.provider.call(ctx.fetchImpl, configured.key, query, maxResults);
        } catch (error) {
            // The provider's own failure is data for the agent, not a rule: say what failed and
            // that the records remain the reliable source.
            const reason = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                error: `searchWeb: ${configured.provider.name} search failed — ${reason}`,
                message:
                    'The lookup failed. Work from the stored records, or reportGap if this brief depends on the web (T-12).',
                provider: configured.provider.name
            };
        }

        return okValue(
            {
                query,
                provider: configured.provider.name,
                results: hits.slice(0, maxResults).map((hit) => ({
                    title: hit.title,
                    url: hit.url,
                    snippet: hit.snippet,
                    published_at: hit.published_at ?? '',
                    score: hit.score
                })),
                total: hits.length,
                untrusted: true
            },
            {
                notes: [
                    'Leads only: cite the page you actually read with fetchPage before you make a claim of it (D-27, T-10).',
                    'A claim that reaches a locked artifact needs an Editor verdict, whoever fetched it (C-15).'
                ]
            }
        );
    }
};

// ── fetchPage ───────────────────────────────────────────────────────────────

/**
 * §8.5 `fetchPage`: `url, query?`. Returns text, not markup, bounded to {@link MAX_PAGE_TEXT}
 * (T-7); with a `query` it also returns the sentence around the match, because T-10 needs the
 * claim the page actually makes rather than the one the agent expected.
 */
const fetchPage: ToolDefinition = {
    name: 'fetchPage',
    description:
        'Fetch one page as plain text, bounded. Pass query to get the sentence that matches it — the citation needs the claim the page actually makes, not a paraphrase of the title (T-10).',
    inputSchema: {
        type: 'object',
        properties: {
            url: str('The absolute http(s) url to read.'),
            query: str('Optional: the phrase whose surrounding sentence you need as evidence.')
        },
        required: ['url']
    },
    ...WEB_PERMISSION,
    primaryArg: 'url',
    requires: ['url'],
    async execute(ctx): Promise<ToolResult> {
        const url = String(ctx.args.url ?? '').trim();
        // The scheme check is a T-11 refusal, not a permission rule: a run that sends "example.com"
        // made a malformed request, and a refusal naming the field is what fixes it in one turn.
        if (!/^https?:\/\//i.test(url))
            throw new ToolRefusal('T-11', 'url must be an absolute http(s) url.', {
                field: 'url',
                received: url,
                fix: 'send the full url including the scheme, exactly as searchWeb returned it'
            });

        let raw: string;
        try {
            raw = await getText(ctx.fetchImpl, url);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                error: `fetchPage: ${url} could not be read — ${reason}`,
                message:
                    'The page could not be read. Cite a source you can reach, or say the claim is unverifiable (markUnverifiable).',
                url
            };
        }

        const text = htmlToText(raw);
        if (!text)
            return {
                ok: false,
                error: `fetchPage: ${url} returned no readable text`,
                message: 'The page has no extractable text. Try another source, or markUnverifiable the claim.',
                url
            };

        // The `<title>` is pulled from the RAW markup, because htmlToText has already dropped it.
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? '';
        const query = typeof ctx.args.query === 'string' ? ctx.args.query.trim() : '';

        return okValue(
            {
                url,
                title,
                accessed_at: nowIso(),
                // T-7: bounded, with the truncation stated rather than hidden.
                text: clip(text, MAX_PAGE_TEXT),
                truncated: text.length > MAX_PAGE_TEXT,
                ...(query
                    ? { match: excerptAround(text, query), matched: text.toLowerCase().includes(query.toLowerCase()) }
                    : {})
            },
            {
                notes: query
                    ? [
                          'matched:false means this page does not say what you came for — a source cited for a claim it does not make refutes the Idea (T-10, C-15).'
                      ]
                    : [
                          'Record the citation as {url_or_title, claim} in proposeIdea sources; accessed_at is stamped here (T-10).'
                      ]
            }
        );
    }
};

// ── proposeIdea ─────────────────────────────────────────────────────────────

/**
 * §8.5 `proposeIdea`: "a Reader's only contribution mechanism (D-26). Never an edit." §7's
 * `ideas` row puts "**write** (`proposeIdea`)" in the Checker/Reader column, so a Writer or an
 * Editor that calls it is refused naming P10 — which is the correct outcome, not an oversight:
 * the Editor's move on an Idea is `verifyIdea`, and the Writer's is to read the decided list
 * (D-32).
 *
 * D-32's dedupe runs against DECIDED Ideas (selected/discarded/deferred): a repeat is reported
 * with the earlier decision instead of re-opening it. A repeat of an OPEN Idea bumps
 * `seen_count`, which is the same no-progress signal D-16 uses for findings.
 */
const proposeIdea: ToolDefinition = {
    name: 'proposeIdea',
    description:
        "Put forward an Idea without editing anything — the Reader's only contribution, and a checker's too (D-26, D-32). Cite what you read in sources; the Editor verifies a claim before it can be selected (C-15).",
    inputSchema: {
        type: 'object',
        properties: {
            phase: PHASE_ENUM,
            unit_ref: str('The summary, plotline or chapter the Idea is about (empty = the whole Story).'),
            body: str('The idea, as one actionable sentence.'),
            kind: IDEA_KIND_ENUM,
            sources: arr(
                'What this came from (T-10). accessed_at is stamped here if you leave it out.',
                obj(
                    'One citation.',
                    {
                        url_or_title: str('The page url, or the title of the source you read.'),
                        claim: str('The specific claim this source supports (T-10).'),
                        accessed_at: str('When you read it (ISO). Optional: stamped when omitted.')
                    },
                    ['url_or_title', 'claim']
                )
            ),
            why: whyArg('Why you are putting this forward (T-5).')
        },
        required: ['phase', 'body', 'kind', 'sources', 'why']
    },
    writes: 'ideas',
    level: 'write',
    mutating: true,
    expectsArg: false,
    primaryArg: 'unit_ref',
    requires: ['phase', 'body', 'kind', 'sources', 'why'],
    async execute(ctx): Promise<ToolResult> {
        const phase = String(ctx.args.phase) as Idea['phase'];
        const body = String(ctx.args.body ?? '').trim();
        if (!body)
            throw new ToolRefusal(
                'T-11',
                'body is required — an Idea with no content cannot be verified or selected.',
                {
                    field: 'body',
                    fix: 'one actionable sentence'
                }
            );

        // D-36: Ideas are phase-scoped, and the phase a run means is the phase the Story is in.
        if (phase !== ctx.story.phase && phase !== 'summary' && phase !== 'plotlines' && phase !== 'chapters')
            throw new ToolRefusal('T-11', `phase "${phase}" is not one of summary | plotlines | chapters.`, {
                field: 'phase',
                story_phase: ctx.story.phase,
                fix: 'propose against the phase the Story is in'
            });

        const unit =
            ctx.args.unit_ref === undefined
                ? undefined
                : await mustResolveRef(ctx, ctx.args.unit_ref, 'unit_ref', ['summaries', 'plotlines', 'chapters']);

        // T-10: a source without a claim is a bookmark, not a citation, so the shape is checked.
        const rawSources = Array.isArray(ctx.args.sources) ? (ctx.args.sources as unknown[]) : [];
        if (!Array.isArray(ctx.args.sources))
            throw new ToolRefusal('T-11', 'sources must be an array of {url_or_title, claim}.', {
                field: 'sources',
                received: ctx.args.sources,
                fix: 'send [] when the Idea comes from the records rather than the web'
            });
        const sources: IdeaSource[] = rawSources.map((raw, index) => {
            if (typeof raw !== 'object' || raw === null)
                throw new ToolRefusal('T-11', `sources[${index}] must be an object with url_or_title and claim.`, {
                    field: `sources[${index}]`,
                    expected: '{url_or_title, claim, accessed_at?}',
                    fix: 'one citation per source (T-10)'
                });
            const item = raw as Record<string, unknown>;
            const urlOrTitle = typeof item.url_or_title === 'string' ? item.url_or_title.trim() : '';
            const claim = typeof item.claim === 'string' ? item.claim.trim() : '';
            if (!urlOrTitle || !claim)
                throw new ToolRefusal(
                    'T-11',
                    `sources[${index}] needs both url_or_title and the specific claim it supports.`,
                    {
                        field: `sources[${index}]`,
                        rule: 'T-10',
                        fix: 'a page cited for a claim it does not make refutes the Idea (C-15), so name the claim'
                    }
                );
            return {
                url_or_title: urlOrTitle,
                claim,
                accessed_at:
                    typeof item.accessed_at === 'string' && item.accessed_at.trim() ? item.accessed_at.trim() : nowIso()
            };
        });

        const why = whyOf(ctx);
        const fingerprint = fingerprintIdea(body);

        // D-32, first half: an already-DECIDED Idea is reported, never re-opened.
        const decided = decidedIdea(ctx.store, ctx.storyId, body);
        if (decided)
            return repeatResult(
                `Idea already ${decided.state} as ${decided.id}`,
                {
                    idea_id: decided.id,
                    id: decided.id,
                    state: decided.state,
                    body: decided.body,
                    seen_count: decided.seen_count,
                    selection_note: decided.selection_note ?? ''
                },
                {
                    idea_id: decided.id,
                    notes: [
                        `Rule D-32: this was already ${decided.state}${decided.selection_note ? ` — "${clip(decided.selection_note, 200)}"` : ''}. A repeat is reported to the Author with the earlier decision, not re-opened.`
                    ]
                }
            );

        // D-32, second half + D-14: the same live Idea from another fresh context counts itself.
        const live = ctx.store.ideas
            .list()
            .find(
                (row) =>
                    row.story_id === ctx.storyId &&
                    row.fingerprint === fingerprint &&
                    !['selected', 'discarded', 'deferred'].includes(row.state)
            );

        const written = (await commitAs(
            ctx,
            'proposeIdea',
            () =>
                live
                    ? ctx.store.ideas.update(
                          live.id,
                          { seen_count: live.seen_count + 1 },
                          buildAttribution(ctx, `${why} (already proposed)`)
                      )
                    : ctx.store.ideas.create(
                          {
                              story_id: ctx.storyId,
                              phase,
                              unit_ref: unit?.id ?? '',
                              body,
                              kind: String(ctx.args.kind) as IdeaKind,
                              author: ctx.roleName || ctx.role,
                              sources,
                              fingerprint,
                              seen_count: 1,
                              state: 'proposed',
                              verification: null
                          },
                          buildAttribution(ctx, why)
                      ),
            []
        )) as Idea;

        if (live)
            return repeatResult(
                `Idea already open as ${written.id} (seen ${written.seen_count} times)`,
                {
                    idea_id: written.id,
                    id: written.id,
                    state: written.state,
                    seen_count: written.seen_count
                },
                { idea_id: written.id }
            );

        return ok(
            {
                id: written.id,
                idea_id: written.id,
                phase: written.phase,
                unit_ref: written.unit_ref ?? '',
                kind: written.kind,
                state: written.state,
                author: written.author,
                sources: written.sources,
                fingerprint: written.fingerprint,
                seen_count: written.seen_count,
                current_rev: written.rev
            },
            written.rev,
            `Idea ${written.id} proposed (${written.kind}${sources.length ? `, ${sources.length} source(s)` : ''})`,
            {
                idea_id: written.id,
                notes: [
                    // D-26: the write is a proposal, so nothing about the artifact changed here.
                    'Nothing was edited (D-26). An Editor checks it with verifyIdea before anything can select it.',
                    ...(sources.length
                        ? [
                              'It carries sources, so C-15 requires the Editor verdict before it reaches a locked artifact.'
                          ]
                        : [])
                ]
            }
        );
    }
};

// ── markUnverifiable ────────────────────────────────────────────────────────

/**
 * §8.5 `markUnverifiable`: "'cannot be checked from here' is an honest verdict, not a shrug; the
 * Idea reaches the Author marked unverified." The state carries that, and NO `verification`
 * object is written — `IdeaVerification` is the Editor's two answers (D-27/D-31), and inventing
 * one here would put words in a role that has not spoken.
 */
const markUnverifiable: ToolDefinition = {
    name: 'markUnverifiable',
    description:
        'Say an Idea cannot be checked from this position, and why. It is an honest verdict, not a shrug: the Idea reaches the Author marked unverified instead of pretending to a decision (D-32).',
    inputSchema: {
        type: 'object',
        properties: {
            idea_id: str('The Idea (its id).'),
            checked: str('What you did try, so the Author sees the attempt was real.'),
            why: whyArg('Why it cannot be checked from here (T-5).')
        },
        required: ['idea_id', 'why']
    },
    writes: 'ideas',
    level: 'write',
    mutating: true,
    expectsArg: false,
    primaryArg: 'idea_id',
    requires: ['idea_id', 'why'],
    async execute(ctx): Promise<ToolResult> {
        const resolved = await mustResolveRef(ctx, ctx.args.idea_id, 'idea_id', ['ideas']);
        const idea = resolvedIdea(resolved);
        if (['selected', 'discarded'].includes(idea.state))
            throw new ToolRefusal('T-11', `Idea ${idea.id} is already ${idea.state}, so it is not open to a verdict.`, {
                idea_id: idea.id,
                state: idea.state,
                fix: 'the Author reopens it, or a new Idea is proposed'
            });

        const why = whyOf(ctx);
        // The attempt is recorded in the Idea body's audit trail rather than in `verification`,
        // which is the Editor's field (D-31).
        const written = (await commitAs(
            ctx,
            'markUnverifiable',
            () =>
                ctx.store.ideas.update(
                    idea.id,
                    { state: 'unverifiable' },
                    buildAttribution(
                        ctx,
                        `${why}${ctx.args.checked ? ` (tried: ${summarize(String(ctx.args.checked), 200)})` : ''}`
                    )
                ),
            []
        )) as Idea;

        return ok(
            {
                id: written.id,
                idea_id: written.id,
                state: written.state,
                // D-27: the Editor's verification is still absent, and that is the honest state.
                verification: written.verification ?? null,
                current_rev: written.rev
            },
            written.rev,
            `Idea ${written.id} marked unverifiable`,
            {
                notes: [
                    'Unverified means exactly that: no verdict was invented, and the Idea goes to the Author rather than into the artifact (D-32).'
                ]
            }
        );
    }
};

/** §8.5's four tools. */
export const researchTools: ToolDefinition[] = [searchWeb, fetchPage, proposeIdea, markUnverifiable];

/** Exported so a test can pin the provider order without reading the file. */
export const SEARCH_PROVIDER_NAMES = SEARCH_PROVIDERS.map((provider) => provider.name);

/** Re-exported for the tests that assert the bounded payload sizes (T-7). */
export const RESEARCH_LIMITS = { MAX_PAGE_TEXT, MAX_SNIPPET };
