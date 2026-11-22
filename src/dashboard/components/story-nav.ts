// The Story's navigation model: four PHRASES plus the folders that support them.
//
// WHY THIS IS A SEPARATE PURE MODULE: the rail, the pane header and the Summary's review badge all
// read the same handful of rules ("is the Summary ready for review", "which overview did the
// Editor's verdict recommend"), and a rule that lives in a component would be a second copy the
// moment another surface needs it. The server still owns every record; this file only names the
// sections and derives the two UI-facing readouts (a tick and a recommendation) from them.
//
// THE PHRASES AND THE LOOP'S PHASES ARE NOT THE SAME NUMBERING ANY MORE. The Author's pipeline is
// four reading phrases — Summary, Characters, Plotlines, Chapters. The loop's `story.phase` still
// moves through its three locked artifacts; Characters is a supporting sheet the crew builds from
// the Summary, so it has no `StoryPhase` of its own yet (the "Phrase 2 can be started" step).
import type { Chapter, Plotline, Verdict } from '../../shared/types';
import { buildRevisionUnits, isDecidedIdea } from './story-contract';
import type { RevisionUnit, StoryViewData } from './story-contract';

/** The four reading phrases, in the Author's order. */
export type StoryPhraseKey = 'summary' | 'characters' | 'plotlines' | 'chapters';

/** The supporting folders under the phrases. */
export type StoryFolderKey = 'continuity' | 'goal' | 'ideas' | 'findings' | 'digest' | 'settings';

/** The one legacy leaf the rail still offers: the Seed is pinned truth, not a phrase. */
export type StoryPanelKey = StoryPhraseKey | StoryFolderKey | 'seed';

/**
 * What the content area is showing. `ref` names one entry inside a phrase (a cast member, a
 * plotline, a chapter); absent means the phrase's own overview. A folder never carries a ref.
 */
export interface StorySelection {
    panel: StoryPanelKey;
    ref?: string;
}

export const DEFAULT_STORY_SELECTION: StorySelection = { panel: 'summary' };

export interface StoryPhraseSpec {
    key: StoryPhraseKey;
    number: number;
    title: string;
}

/** Phrase order is the reading order; the number is what the rail paints. */
export const STORY_PHRASES: readonly StoryPhraseSpec[] = [
    { key: 'summary', number: 1, title: 'Summary' },
    { key: 'characters', number: 2, title: 'Characters' },
    { key: 'plotlines', number: 3, title: 'Plotlines' },
    { key: 'chapters', number: 4, title: 'Chapters' }
];

export interface StoryFolderSpec {
    key: StoryFolderKey;
    title: string;
}

export const STORY_FOLDERS: readonly StoryFolderSpec[] = [
    { key: 'continuity', title: 'Continuity' },
    { key: 'goal', title: 'Goal' },
    { key: 'ideas', title: 'Ideas' },
    { key: 'findings', title: 'Findings' },
    { key: 'digest', title: 'Digest' },
    { key: 'settings', title: 'Settings' }
];

/** The rail's heading for a phrase: "Phrase 1 — Summary". */
export function phraseLabel(spec: StoryPhraseSpec): string {
    return `Phrase ${spec.number} — ${spec.title}`;
}

// ---------------------------------------------------------------------------
// Summary readiness and the Editor's recommendation
// ---------------------------------------------------------------------------

/**
 * U-4's review step: the Summary is reviewable when its goal has passed (the loop has nothing
 * left to improve) or when the Author has already signed it. A locked Summary keeps its tick —
 * the rail should not make a signed artifact look unfinished.
 */
export function summaryReadyForReview(view: StoryViewData): boolean {
    if (view.story.summary_locked) {
        return true;
    }

    const summary = view.summary;
    const prose =
        summary !== null &&
        summary !== undefined &&
        [summary.premise, summary.promise, summary.theme, summary.tone, summary.ending, summary.world_rules].some(
            (field) => typeof field === 'string' && field.trim().length > 0
        );

    return storyInSummaryPhase(view) && prose && view.goal.failing.length === 0;
}

function storyInSummaryPhase(view: StoryViewData): boolean {
    return view.story.phase === 'summary';
}

/**
 * The standalone Summary review unit U-13 renders. Only COMPETING drafts are offered: a revision
 * that is already `selected` is the Summary on record, and re-presenting it as a choice would
 * ask the Author to decide something twice. `undefined` when no draft is waiting.
 */
export function summaryRevisionUnit(view: StoryViewData): RevisionUnit | undefined {
    const unit = buildRevisionUnits(view).find((candidate) => candidate.unitKind === 'summary');

    if (!unit) {
        return undefined;
    }

    const competing = unit.revisions.filter((revision) => revision.state === 'competing');

    return competing.length === 0 ? undefined : { ...unit, revisions: competing };
}

/**
 * The draft the last verdict on THAT DRAFT advanced. The book records a recommendation, not an
 * author, on §4.9; `advance` on a hard pass is the only combination that reads as "take this one".
 * A verdict filed against the unit is deliberately NOT used here: it judges the set, not one
 * overview, and picking a column from it would invent a preference nobody stated.
 */
export function recommendedRevisionId(unit: RevisionUnit | undefined): string | undefined {
    if (!unit) {
        return undefined;
    }

    let best: { id: string; at: string } | undefined;

    for (const revision of unit.revisions) {
        const own = unit.verdictsByRevision[revision.id] ?? [];
        const latest = newestAdvancingVerdict(own);

        if (latest === undefined) {
            continue;
        }

        if (best === undefined || latest.updated_at > best.at) {
            best = { id: revision.id, at: latest.updated_at };
        }
    }

    return best?.id;
}

function newestAdvancingVerdict(verdicts: Verdict[]): Verdict | undefined {
    const advancing = verdicts
        .filter((verdict) => verdict.hard_pass && verdict.recommendation === 'advance')
        .sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id));

    return advancing[advancing.length - 1];
}

// ---------------------------------------------------------------------------
// The phrases' entries
// ---------------------------------------------------------------------------

/** The cast in the order the crew created it (the sheet is stable; sorting by name would jump). */
export function castMembers(view: StoryViewData) {
    return [...view.cast].sort(
        (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
    );
}

export function plotlinesInOrder(view: StoryViewData): Plotline[] {
    return [...view.plotlines].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function chaptersInOrder(view: StoryViewData): Chapter[] {
    return [...view.chapters].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** A phrase has been started when the artifact behind it exists. */
export function phraseStarted(view: StoryViewData, phrase: StoryPhraseKey): boolean {
    if (phrase === 'summary') {
        return view.summary !== null;
    }
    if (phrase === 'characters') {
        return view.cast.length > 0;
    }
    if (phrase === 'plotlines') {
        return view.plotlines.length > 0;
    }
    return view.chapters.length > 0;
}

/** U-4's title for the content area, resolved from the selection and the records. */
export function selectionTitle(view: StoryViewData, selection: StorySelection): string {
    if (selection.panel === 'seed') {
        return 'Seed';
    }

    const phrase = STORY_PHRASES.find((candidate) => candidate.key === selection.panel);

    if (phrase) {
        const entry = selection.ref ? phraseEntryTitle(view, phrase.key, selection.ref) : undefined;
        return entry ? `${phraseLabel(phrase)} · ${entry}` : phraseLabel(phrase);
    }

    const folder = STORY_FOLDERS.find((candidate) => candidate.key === selection.panel);
    return folder?.title ?? 'The story';
}

function phraseEntryTitle(view: StoryViewData, phrase: StoryPhraseKey, ref: string): string | undefined {
    if (phrase === 'summary') {
        return ref === 'overview' ? 'Overview' : undefined;
    }
    if (phrase === 'characters') {
        return view.cast.find((member) => member.id === ref)?.name;
    }
    if (phrase === 'plotlines') {
        const plotline = view.plotlines.find((candidate) => candidate.id === ref);
        return plotline ? `Plotline ${plotline.order}${plotline.heading ? ` — ${plotline.heading}` : ''}` : undefined;
    }
    const chapter = view.chapters.find((candidate) => candidate.id === ref);
    return chapter ? `Chapter ${chapter.order} — ${chapter.title}` : undefined;
}

/** Whether the small entry point named by the selection still exists (a deletion falls back). */
export function selectionExists(view: StoryViewData, selection: StorySelection): boolean {
    if (selection.ref === undefined) {
        return true;
    }

    if (selection.panel === 'summary') {
        return selection.ref === 'overview';
    }
    if (selection.panel === 'characters') {
        return view.cast.some((member) => member.id === selection.ref);
    }
    if (selection.panel === 'plotlines') {
        return view.plotlines.some((plotline) => plotline.id === selection.ref);
    }
    if (selection.panel === 'chapters') {
        return view.chapters.some((chapter) => chapter.id === selection.ref);
    }

    return true;
}

// ---------------------------------------------------------------------------
// Attention — what the rail highlights, and what the directive bar addresses
// ---------------------------------------------------------------------------

/** The tone a rail highlight uses: a wait is calm, a stall is urgent, leftovers are finished. */
export type StoryAttentionTone = 'awaiting' | 'stalled' | 'finished';

/** One place in the rail that needs the Author. */
export interface StoryAttention {
    panel: StoryPanelKey;
    ref?: string;
    label: string;
    tone: StoryAttentionTone;
}

/** The phrase the loop is currently in, as the rail's own key. */
function currentPhrase(story: StoryViewData['story']): StoryPhraseKey {
    return story.phase;
}

/**
 * Everything the rail should highlight. This is the inverse of the old Stories-panel row: the
 * row now says only "needs you", and the detail of *where* lives on the rail the Author is about
 * to use. A record can add attention even when `pending_kind` names a different hold — an open
 * finding is still open while the Story waits on a sign-off.
 */
export function storyAttention(view: StoryViewData): StoryAttention[] {
    const { story } = view;
    const items: StoryAttention[] = [];
    const add = (item: StoryAttention): void => {
        if (!items.some((existing) => existing.panel === item.panel && (existing.ref ?? '') === (item.ref ?? ''))) {
            items.push(item);
        }
    };

    if (story.pending_kind === 'stalled') {
        add({ panel: currentPhrase(story), label: 'stuck', tone: 'stalled' });
    } else if (story.pending_kind === 'phase_signoff') {
        add({ panel: currentPhrase(story), label: 'sign off', tone: 'awaiting' });
    } else if (story.pending_kind === 'idea_selection') {
        add({ panel: 'ideas', label: 'pick an Idea', tone: 'awaiting' });
    } else if (story.pending_kind === 'finding_approval') {
        add({ panel: 'findings', label: 'approve findings', tone: 'awaiting' });
    } else if (story.pending_kind === 'drained') {
        add({ panel: 'findings', label: 'leftovers', tone: 'finished' });
    }

    const findings = view.findings.filter(
        (finding) => finding.state === 'confirmed' && !(story.auto_approve ?? []).includes(finding.cost)
    );
    if (findings.length > 0) {
        add({
            panel: 'findings',
            label: `${findings.length} finding${findings.length === 1 ? '' : 's'} to approve`,
            tone: 'awaiting'
        });

        // The chapters the findings point at are the ones the Author will have to reopen; mark
        // them in the rail too, so "where" is visible without opening the Findings folder.
        for (const finding of findings) {
            for (const ref of [finding.target_ref, ...(finding.related_refs ?? [])]) {
                if (view.chapters.some((chapter) => chapter.id === ref)) {
                    add({ panel: 'chapters', ref, label: 'open finding', tone: 'awaiting' });
                }
            }
        }
    }

    const ideas = view.ideas.filter((idea) => idea.phase === story.phase && !isDecidedIdea(idea));
    if (ideas.length > 0) {
        add({
            panel: 'ideas',
            label: `${ideas.length} Idea${ideas.length === 1 ? '' : 's'} to decide`,
            tone: 'awaiting'
        });

        for (const idea of ideas) {
            if (idea.unit_ref && view.chapters.some((chapter) => chapter.id === idea.unit_ref)) {
                add({ panel: 'chapters', ref: idea.unit_ref, label: 'Idea for this chapter', tone: 'awaiting' });
            }
            if (idea.unit_ref && view.plotlines.some((plotline) => plotline.id === idea.unit_ref)) {
                add({ panel: 'plotlines', ref: idea.unit_ref, label: 'Idea for this plotline', tone: 'awaiting' });
            }
        }
    }

    const summaryDrafts = view.revisions.filter(
        (revision) => revision.unit_kind === 'summary' && revision.state === 'competing'
    );
    if (summaryDrafts.length > 0) {
        add({ panel: 'summary', label: 'choose a draft', tone: 'awaiting' });
    }

    if (view.completion_preview && story.status !== 'completed') {
        add({ panel: 'chapters', label: 'completion proposed', tone: 'finished' });
    }

    return items;
}

/** The attention item, if any, that belongs to one rail entry. */
export function attentionFor(
    view: StoryViewData,
    panel: StorySelection['panel'],
    ref?: string
): StoryAttention | undefined {
    return storyAttention(view).find((item) => item.panel === panel && (item.ref ?? undefined) === ref);
}

// ---------------------------------------------------------------------------
// The directive bar's focus
// ---------------------------------------------------------------------------

/**
 * What the Author is looking at, in the terms the Editor's brief needs. `refs` are the artifact
 * rows the direction is about; the server resolves them one hop wider (dependents), so the Editor
 * receives the focused Summary/chapter/plotline even when the sentence itself never names it.
 */
export interface DirectiveFocus {
    /** The bar's label, e.g. "Summary → Editor" or "Chapter 3 — The Water Line → Editor". */
    label: string;
    /** The sentence it is talking about, e.g. "the Summary" or "this chapter". */
    target: string;
    placeholder: string;
    refs: string[];
}

/** The slices the directive bar reads; the raw `getStory` payload satisfies it too. */
export type DirectiveFocusView = Pick<StoryViewData, 'story' | 'summary' | 'cast' | 'plotlines' | 'chapters'>;

/** The focus the directive bar should show for the rail's current selection. */
export function directiveFocus(view: DirectiveFocusView, selection: StorySelection): DirectiveFocus {
    if (selection.panel === 'seed') {
        return {
            label: 'Seed → Editor',
            target: 'the Seed (read-only for every agent — P5)',
            placeholder: 'what should the Editor do with this Seed?',
            refs: []
        };
    }

    if (selection.panel === 'summary') {
        return {
            label: 'Summary → Editor',
            target: 'the Summary',
            placeholder: 'e.g. tighten the premise · keep the ending',
            refs: view.summary ? [view.summary.id] : []
        };
    }

    if (selection.panel === 'characters') {
        const member = selection.ref ? view.cast.find((candidate) => candidate.id === selection.ref) : undefined;
        return {
            label: member ? `${member.name || member.id} → Editor` : 'Characters → Editor',
            target: member ? `${member.name || member.id}'s sheet` : 'the cast sheet',
            placeholder: 'e.g. give Hale a want that fights her need',
            refs: member ? [member.id] : []
        };
    }

    if (selection.panel === 'plotlines') {
        const plotline = selection.ref ? view.plotlines.find((candidate) => candidate.id === selection.ref) : undefined;
        return {
            label: plotline
                ? `Plotline ${plotline.order}${plotline.heading ? ` — ${plotline.heading}` : ''} → Editor`
                : 'Plotlines → Editor',
            target: plotline ? 'this plotline' : 'the plotline set',
            placeholder: 'e.g. make this plotline pay off the set-up · keep the order',
            refs: plotline
                ? [plotline.id]
                : [...view.plotlines].sort((left, right) => left.order - right.order).map((row) => row.id)
        };
    }

    if (selection.panel === 'chapters') {
        const chapter = selection.ref ? view.chapters.find((candidate) => candidate.id === selection.ref) : undefined;
        return {
            label: chapter ? `Chapter ${chapter.order} — ${chapter.title} → Editor` : 'Chapters → Editor',
            target: chapter ? 'this chapter' : 'the chapter set',
            placeholder: 'e.g. kill the mentor here · make it colder',
            refs: chapter
                ? [chapter.id]
                : [...view.chapters].sort((left, right) => left.order - right.order).map((row) => row.id)
        };
    }

    const folder = STORY_FOLDERS.find((candidate) => candidate.key === selection.panel);
    const placeholders: Partial<Record<StoryPanelKey, string>> = {
        continuity: 'e.g. make the ledger agree on the drowned road',
        goal: 'e.g. add a hard criterion for point of view',
        ideas: 'e.g. take the hum idea · discard the repeat',
        findings: 'e.g. approve the C-14 finding · discard the minor ones',
        digest: 'e.g. re-derive the Digest from the current Summary',
        settings: 'e.g. auto-approve minor findings for this Story'
    };

    return {
        label: `${folder?.title ?? 'Story'} → Editor`,
        target: `the ${folder?.title ?? 'Story'} folder`,
        placeholder: placeholders[selection.panel] ?? 'what should change here?',
        refs: []
    };
}
