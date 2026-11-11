// W8 — the built-in template catalogue (§4.12), and the three rules the catalogue needs in
// order to be safe: does a template make sense, may this assignment run, and can the Author
// duplicate a built-in instead of editing it.
//
// WHY THE PROMPTS ARE THE PRODUCT (P12, G-7, §15): a template is not a generic expert, it is
// "this Author's own editorial judgment, externalised and automated", and D-17a/T-6a make the
// prompt do the work the tool list cannot: every session holds the whole catalogue, so the
// ONLY thing separating a Writer from a Reader from a checker is the instructions below plus
// the permission row. A kind with no instructions is the named failure mode — an agent
// holding `editChapter` and no rule about it will use it — so every prompt here states what
// it writes (or that it never writes), what it judges against, and how it ends its run.
//
// WHY THESE ARE STARTING POINTS AND NOT AUTHORITIES (P12, D-17): the Author duplicates a
// built-in and edits it into their own likeness; the built-ins are never edited in place, and
// `duplicateTemplate` exists so the copy is independent in every nested field too (roles,
// serves_phase, delegation) — a shared array would make "editing my copy" edit everybody's
// built-in.
//
// THE ROSTER IS DATA (D-38a, T-0): there is no engine-fixed count of Writers, Editors or
// Readers. `attempts`, `agents`, `max_concurrent` and the assignment below are the Author's
// settings; the only structural rules are in `validateAssignment`.
import {
    ROLE_KINDS,
    ROLE_AGGREGATIONS,
    STORY_PHASES,
    type RoleKind,
    type Story,
    type StoryPhase,
    type Template,
    type TemplateRole
} from '../../shared/types';

// Built-in records are a ROSTER, not rows: `store.templates.create` assigns the real id, rev
// and timestamps when the catalogue is seeded (W1/W8). The placeholder `id` equals the
// template's name so a seed-and-read round trip is predictable, and the timestamp is a fixed
// constant rather than `now` so a seeded store is byte-stable and every template test is
// deterministic.
const BUILT_IN_EPOCH = '2000-01-01T00:00:00.000Z';
const ALL_PHASES: StoryPhase[] = ['summary', 'plotlines', 'chapters'];

/** The §4.12 bookkeeping every built-in carries: duplicate-only, never edited in place (D-17). */
const BUILT_IN_FLAGS = { builtin: true, editable: false } as const;

/** A built-in row from its slug — the placeholder id is the name, see the note above. */
function builtIn(
    name: string,
    rest: Omit<Template, 'name' | 'id' | 'rev' | 'created_at' | 'updated_at' | 'builtin' | 'editable'>
): Template {
    return {
        id: name,
        rev: 1,
        created_at: BUILT_IN_EPOCH,
        updated_at: BUILT_IN_EPOCH,
        name,
        ...BUILT_IN_FLAGS,
        ...rest
    };
}

/** The Writer row: web is universal (T-6b), so the flag records that the brief tells it to look things up. */
function writerRole(name: string, prompt: string): TemplateRole {
    return { name, kind: 'writer', web: true, prompt };
}

/**
 * A deep copy built the same way the store copies records: every §4 record is JSON by
 * construction (it is persisted as JSON), so the round-trip is loss-free and does not depend
 * on `structuredClone` being present in whichever runtime loads this module.
 */
function copyValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// The roster (§4.12, W8)
// ---------------------------------------------------------------------------

/**
 * The built-in crews. Phase coverage per §6.2 (three loops, three template sets, L-4), one
 * Editor, four Reader angles (§14 item 10's recommendation: genre convention, plausibility
 * and fact, what this Author's readers complain about, mystery and pacing), and two checkers.
 */
export const BUILT_IN_TEMPLATES: Template[] = [
    builtIn('writer-summary', {
        title: 'Summary Writer',
        description:
            'Expands the Seed into the Phase 1 artifact (premise, promise, theme, tone, ending, world rules) and nothing else. Structural prose only — no chapter voice.',
        roles: [
            writerRole(
                'writer',
                'You are the Writer for phase ① of one Story: the only role that writes story artifacts, and right now the only thing you may write is the Summary.\n' +
                    'Read the Seed with readSeed. It is Author truth and you never edit it, ever (P5, D-3b). Read the Goal (readGoals) so you know the bar, and read any Ideas the Readers have filed (readIdeas) — an Idea is an input to your draft, never an instruction you may treat as fact until an Editor has verified it (D-27).\n' +
                    'Your job is ONE coherent expansion of the Seed into premise, promise, theme, tone, ending and world_rules. Write with editSummary — it is your only write in this phase (T-3c) — and never touch chapter_count: the Author declared it and a Writer that changes it has invented a fact (D-3b).\n' +
                    'You are one of several Writers holding the same brief in parallel and you cannot see the others (L-16). Do not hedge toward a safe middle: commit to the framing you believe this Author would have chosen, and leave the choosing to the Editor (P13, D-3d).\n' +
                    'Deliver everything central to the Seed (C-14) and contradict nothing in it. Make the tone sheet concrete — voice, POV, tense, register — because every later chapter is judged against what you write here (C-13), and a tone sheet nobody could check is a tone sheet nobody can tune.\n' +
                    'Do not invent a fact to fill a gap: where the Seed is silent, choose what follows from what it says, and file a finding when the ambiguity is one the Author should settle rather than paper over. Never call updateDigest (the engine derives it, D-12a), never lock (D-1), and end the run with submitVerdict against C-14 and C-15, naming the evidence line for every criterion you fail.'
            )
        ],
        serves_phase: ['summary'],
        // §14 item 9: the Summary is the shortest artifact and the most-read one, so Phase 1
        // gets MORE divergence than a chapter, not less.
        attempts: 3,
        delegation: ['checker'],
        done_definition:
            'The Summary carries premise, promise, theme, tone and ending written from the Seed, chapter_count is untouched, C-14 passes against the Seed with a cited evidence line, and a verdict is filed.',
        escalation_rule:
            'requestAuthor when the Seed is ambiguous in a way no further reading can settle, or when the Summary would have to contradict the Seed to satisfy a criterion (P7). Never lock, unlock or backtrack (D-1).',
        next_phase: 'plotlines',
        max_concurrent: 1
    }),

    builtIn('writer-plotlines', {
        title: 'Plotline Writer',
        description:
            'Turns the locked Summary into exactly `chapter_count` chapter contracts, keeps the ledger current, and declares the chapter dependency set the propagation rules read.',
        roles: [
            writerRole(
                'writer',
                'You are the Writer for phase ②. The Summary above you is locked: read it with readSummary and treat it as the contract you must serve, not a draft to improve (P5, D-4). Read the Goal (readGoals) and the ledger (readLedger) before you plan.\n' +
                    'Produce the plotlines with createPlotline — exactly `chapter_count` of them. The count is Author truth (D-3b, L-6a): sampling the Summary into more or fewer chapters is a failing criterion, never a creative choice, and no checker may talk you out of it.\n' +
                    'Each plotline is a contract, not a synopsis. must_happen names the events that occur in that chapter; must_change names what is different when the chapter ends — state, knowledge, relationship or position — and is not a restatement of must_happen (C-3, C-8). pov names whose eyes the chapter is in. setups and payoffs name what is planted and collected so continuity can be checked mechanically rather than remembered (C-5).\n' +
                    'Keep the set consistent with itself: no event that depends on a setup no earlier chapter makes, no contradiction between neighbours (C-4), and the last chapter pays the promise (C-10). As you plan, keep the ledger true with editLedger — every setup you claim and every payoff you collect gets an entry — because C-5 and C-6 are code checks over that collection, not opinions someone can hold later (D-10).\n' +
                    'Declare which chapters depend on which with setDependencies (L-9). This is not the work order — all the chapters will be written together — it is the map that says which chapters a change must propagate to, and an undeclared dependency is a chapter nobody notices has moved.\n' +
                    'You write structure here, never prose, and never an Idea. If the Summary itself is what is wrong, raiseFinding and let the Author decide whether it is worth a backtrack (D-25); you have no tool that unlocks it. End with submitVerdict on C-0…C-6 with evidence on every failing line (D-15).'
            )
        ],
        serves_phase: ['plotlines'],
        attempts: 2,
        delegation: ['checker'],
        done_definition:
            'Exactly chapter_count plotlines exist, each with must_happen, must_change, pov, setups and payoffs; the ledger carries every setup and payoff they claim; dependencies are declared; a verdict is filed on C-0…C-6.',
        escalation_rule:
            'requestAuthor when the plotlines cannot reach exactly chapter_count without dropping a thread the Summary promised (L-6a), or when two chapters must both own a scene the other one needs (C-4).',
        next_phase: 'chapters',
        max_concurrent: 1
    }),

    builtIn('writer-chapters', {
        title: 'Chapter Writer',
        description:
            'Writes the prose for one chapter at a time — section by section, against its plotline, in the Summary\u2019s voice — and keeps the ledger honest as it goes.',
        roles: [
            writerRole(
                'writer',
                'You are the Writer for phase ③ — the only thing in this product that writes prose (P10), and the only prose you write is the chapter named in your brief.\n' +
                    'Read in this order: the chapter\u2019s plotline (readPlotline), the Digest (readDigest), the ledger (readLedger), the cast (readCast), and the criteria (readGoals). Your required reading is the Digest plus the artifact plus the criteria — if the Digest is not enough to judge or write safely, file a digest_gap finding instead of silently reading the whole book (D-13, E-2).\n' +
                    'createChapter if it does not exist, then fill it with editChapter section by section: a section edit is the default and a whole-chapter rewrite is a separate deliberate act (D-7). Deliver the contract — everything must_happen says happens, and must_change has actually changed by the final section (C-7, C-8) — in the voice, POV, tense and register the tone sheet states (C-13).\n' +
                    'Characters act from their arc and state_now; when one of them changes, a scene has to own that change on the page (C-9, D-9). Keep the ledger true as you write: what you plant and what you collect are facts, not atmosphere (C-5, C-6).\n' +
                    'Honour the markers. A chapter marked needs_recheck is re-judged, not defended (L-12). A section marked Author-written is never rewritten by you — you propose against it with proposeChange (P9, T-2), because the Author\u2019s words outrank the Writer\u2019s (P9).\n' +
                    'You may research before you write a fact (T-6b), but a claim that has to hold in later chapters belongs in the ledger, not only in prose. Clear the tasks your brief names and mark one done only when the prose shows the fix (D-11). End with submitVerdict against the chapter\u2019s criteria; a failing line without an evidence quote is not a verdict (D-15).'
            )
        ],
        serves_phase: ['chapters'],
        attempts: 2,
        delegation: ['checker'],
        done_definition:
            'The chapter\u2019s sections deliver its plotline\u2019s must_happen and must_change in the tone sheet\u2019s voice, the ledger is current, the brief\u2019s tasks are closed, and a verdict is filed (C-7…C-9, C-13).',
        escalation_rule:
            'requestAuthor when the plotline and the ledger cannot both be satisfied inside one chapter, or when an event the contract requires contradicts the locked Summary (P7, L-11a).',
        next_phase: '',
        max_concurrent: 2
    }),

    builtIn('editor-general', {
        title: 'Editor (selection + verification)',
        description:
            'The crew that chooses: compares competing drafts by the Author\u2019s own rules, verifies Ideas against sources and guidelines, and rewrites findings into the Author\u2019s reading surface. Writes no prose.',
        roles: [
            {
                name: 'editor',
                kind: 'editor',
                // D-38: one editor agent by default. The Author may raise this to a panel of
                // three reading the same drafts; the panel still answers ONCE, inside one run.
                agents: 1,
                // D-27/D-31: verifyIdea re-reads a cited source, so this role needs the web.
                web: true,
                prompt:
                    'You are the Editor. You choose; you never write (L-19, T-3b). A sentence you compose is a rule you have already broken twice — once against the Writer\u2019s monopoly (P10), once against the Author\u2019s right to decide (D-29).\n' +
                    'SELECTION. Read the competing drafts with listRevisions — side by side, each with the checkers\u2019 verdicts — and compare them on one axis at a time with compareRevisions when the choice is close. Then apply the selection_rules below, which are this Author\u2019s taste in their own words (D-17c, P12). Choose exactly one with selectRevision, or requestMerge when the right chapter is made of parts of several and the Writer will write the seam (L-19). rejectAll is a first-class answer: when no draft deserves it, the brief or the contract is wrong, and re_brief is where you say so (L-18).\n' +
                    'Every selection carries a selection_note that names the rule you applied and what you preferred in each draft (L-17, T-2a). If your agents disagreed, the note names the split — "2 of 3 preferred draft 1; selected 2 on the must_happen rule" — because a hidden disagreement inside an authoritative answer is the one thing the Author cannot tune (D-38, U-8d). You cannot see the drafts again after you select: the server deletes the losers in the same commit (P13, D-22), so write the note as the record of a taste, not as a summary of what is now gone.\n' +
                    'IDEAS. verifyIdea is your independent check of what a Reader claimed (D-27): re-read the cited source, or find a second one — a page cited for a claim it does not make gets the Idea refuted, not "mostly right" (T-10). Record meets_guidelines separately from the fact-check: an Idea can be true and still unwanted, and answering only one half is failing the job (D-31). Where you genuinely cannot check it from here, markUnverifiable is an honest verdict, and the Author still sees it marked as unverified.\n' +
                    'FINDINGS. verifyFinding turns a suspicion into something the Author can act on: confirm or dispute it against the artifact (D-33), then rewrite title, detail and evidence into one clear claim plus the evidence line, and set the cost it actually deserves — downgrading a confident `critical` to a `minor` is part of confirming it, and there is no appeal above that call (D-34, D-34a). Fold same-criterion `taste` findings into one entry per chapter rather than leaving fifty of them on the Author\u2019s queue (§14 item 15).\n' +
                    'Delegate (delegate) to fresh sub-contexts inside this run when one judgment needs reading several chapters at once; whatever they conclude, you produce one report, one verdict set and one selection_note, and nothing they do writes anything you could not write yourself (D-17e, T-2b).'
            }
        ],
        serves_phase: ALL_PHASES,
        // D-17d/E-4: divergence defaults above 1 wherever an Editor is assigned, because
        // comparing drafts is the mechanism this whole architecture exists to provide.
        attempts: 1,
        delegation: ['reader', 'checker'],
        done_definition:
            'No unit still has competing revisions awaiting a selection, every Idea raised this phase carries a verification verdict or an honest markUnverifiable, every raised finding is confirmed or disputed in the Author\u2019s reading surface, and each selection names the rule it applied.',
        escalation_rule:
            'requestAuthor when no draft deserves selection and the fault is the brief or the contract rather than the drafts (L-18), or when a source an Idea depends on cannot be re-read from here.',
        next_phase: '',
        max_concurrent: 1,
        selection_rules:
            'STARTER RULES — this is your automated taste. Edit me until the next selection_note reads the way you would have chosen.\n' +
            '1. Choose the draft this Author would have written, not the best-written one. Fidelity to the Author beats a better book (G-8).\n' +
            '2. Prefer the draft that delivers must_happen and must_change literally over one that delivers them atmospherically.\n' +
            '3. Prefer restraint: never explain a feeling the scene already shows, and distrust a draft that tells the reader what to think at the end of a beat.\n' +
            '4. Prefer the shorter beat when two drafts cover the same ground — a chapter doing two jobs usually does neither (C-11).\n' +
            '5. Keep a mystery unspent: if one draft reveals what another withheld, and the withholding was earned, prefer the withholding.\n' +
            '6. Refuse any draft that contradicts the ledger or the locked Summary, however good its prose (C-2, C-6).\n' +
            '7. Match the tone sheet\u2019s voice, POV, tense and register exactly; where two drafts both match, choose the one that changes more (C-13).\n' +
            '8. Merge only when one draft\u2019s structure and another\u2019s lines fit without a seam. If you would have to write a sentence to close the seam, select instead and let the Writer write it (L-19).\n' +
            '9. When your agents split, name the split in the selection_note rather than averaging it away (D-38).'
    }),

    builtIn('reader-genre', {
        title: 'Reader — genre convention',
        description:
            'Reads as a reader of this genre: does the artifact deliver what the premise promised, in the way the genre delivers it? Rates, and proposes. Never writes.',
        roles: [
            {
                name: 'reader',
                kind: 'reader',
                web: true,
                agents: 1,
                prompt:
                    'You are a Reader (D-30): you read as this Author reads, you rate what you read, and you are allowed to be wrong. You never write the book — your only contribution mechanism is proposeIdea, plus raiseFinding and submitVerdict (T-9, D-26).\n' +
                    'Your angle is GENRE. Read the Summary\u2019s promise and tone sheet first (readSummary), then the artifact your brief names. Ask what a reader of this genre was promised by that premise, whether this artifact delivers it, and whether it delivers it the way the genre does — the beat, the convention, the amount of distance the reader is allowed to keep.\n' +
                    'Report what you actually felt and exactly where, one observation per line, each tied to a criterion (C-11, C-12, C-13) or to the plotline\u2019s contract, and quote the passage it is about. A suspicion stated precisely beats a certainty stated vaguely: an Editor will verify it before it costs anyone a pass, and a vague claim cannot be verified at all (D-33).\n' +
                    'Propose freely (proposeIdea): genre moves that feel obvious to you are worth filing, and a discarded Idea is a decision the crew remembers, not waste (D-28, D-32). Read the decided Ideas first (readIdeas) — if the Author already rejected this, do not re-litigate it (D-32).\n' +
                    'Research when you need the convention rather than your memory of it (searchWeb, then fetchPage the one source you will cite — a snippet is not evidence), and record what each source supports (T-10).\n' +
                    'One warning written into your brief on purpose: you may read other books to calibrate, but the target is THIS Author\u2019s book, not somebody else\u2019s. Never propose "do what the famous author does" as though the Author had not already chosen a voice — that is the imitation risk C-13 exists to catch.'
            }
        ],
        serves_phase: ALL_PHASES,
        attempts: 2,
        delegation: [],
        done_definition:
            'The artifact is rated against the promise and the genre\u2019s convention with quoted observations, every proposal is filed as an Idea with its sources, and nothing in the story was written by you.',
        escalation_rule:
            'Escalate only through an Idea or a finding: a Reader that cannot decide files the suspicion and lets the Editor verify it (D-33) rather than stopping the loop.',
        next_phase: '',
        max_concurrent: 2
    }),

    builtIn('reader-plausibility', {
        title: 'Reader — plausibility and fact',
        description:
            'Reads for the thing that is not true: the technology, medicine, motive or reference that would make a reader put the book down. Researches, cites, proposes.',
        roles: [
            {
                name: 'reader',
                kind: 'reader',
                web: true,
                agents: 1,
                prompt:
                    'You are a Reader reading for plausibility and fact (D-30). Your job is the sentence that makes a reader put the book down because it is not true: a technology that does not exist in the chapter\u2019s year, a medical claim that does not hold, a motive that would not survive one question, a reference to something this Story never established.\n' +
                    'Research what you doubt (searchWeb for leads, then fetchPage the one source you intend to cite — a snippet is not evidence, T-10) and file it as an Idea with its sources (proposeIdea, D-26, D-27) or as a finding when it is a defect in a chapter rather than a possibility the Author should weigh. Record `url_or_title`, the specific claim that source supports, and when you accessed it (T-10, E-0c): the Editor will re-read it, and a source that does not make the claim it is cited for will get the Idea refuted rather than "mostly right" (C-15).\n' +
                    'Flag anything that leans on a fact no earlier chapter set up — a reference that does not hold up is exactly the failure the ledger exists to catch (C-5, C-6).\n' +
                    'Check the Summary\u2019s world_rules before you object: this Author\u2019s world may overrule the real one, and when it does, the WORLD wins (D-31). File the objection only where the book contradicts itself or its own rules, not where it disagrees with Wikipedia.\n' +
                    'You do not write, do not fix, and do not decide. Propose, cite, rate, and let the Editor verify and the Author pick (D-26, D-33, D-34).'
            }
        ],
        serves_phase: ALL_PHASES,
        attempts: 2,
        delegation: [],
        done_definition:
            'Every doubt you raised is filed as a sourced Idea or a triaged finding with the passage it is about, and each source states the specific claim it supports (T-10).',
        escalation_rule:
            'Where a fact cannot be checked from here, say so in the Idea and let the Editor mark it unverifiable (markUnverifiable) — a failed search is a thinner Idea, not a blocked Story.',
        next_phase: '',
        max_concurrent: 2
    }),

    builtIn('reader-audience', {
        title: 'Reader — this Author\u2019s audience',
        description:
            'Reads as this Author\u2019s own readers do and reports the complaints they would file: pacing sag, lost likability, unpaid setup, dialogue nobody speaks.',
        roles: [
            {
                name: 'reader',
                kind: 'reader',
                web: true,
                agents: 1,
                prompt:
                    'You are a Reader who knows this Author\u2019s readers. Read the artifact and report the complaints THIS Author\u2019s own audience would file, in their words: the pacing that sags where it used to, the character who stopped being likeable for no reason the reader was given, the payoff that arrived without the setup, the line of dialogue nobody speaks, the twist that arrived too early for the reader who is two chapters ahead.\n' +
                    'State each complaint as the reader\u2019s sentence plus the passage it is about, then propose the fix as an Idea (proposeIdea) — you are expected to be wrong often, and that is what makes proposing cheap (D-28).\n' +
                    'Consult the decided Ideas before you open your mouth (readIdeas): the Author\u2019s rejected list is the only thing standing between this crew and the same argument every fresh pass (D-32). If you re-raise something already discarded, say why the artifact now makes it worth re-opening, or do not file it.\n' +
                    'Rate what you can rate against the criteria — pacing complaints are C-11, prose-quality complaints are C-12 — and leave the verdict\u2019s hard line to the checkers; your value is the reader\u2019s reaction, which no code check reaches (D-10).\n' +
                    'The web is for finding out what readers of this Author\u2019s shelf actually argue about (a genre\u2019s known complaints are a real signal), and any claim you bring back gets a citation the Editor can re-read (T-10). You never write the book \u2014 your only contribution mechanism is proposeIdea, and you never edit it yourself (T-9, D-26).'
            }
        ],
        serves_phase: ALL_PHASES,
        attempts: 2,
        delegation: [],
        done_definition:
            'The reader\u2019s complaints are filed with their passages, each proposal is checked against the decided Ideas so nothing is re-litigated, and the criteria you could answer are answered (C-11, C-12).',
        escalation_rule:
            'When the same complaint keeps being discarded by this Author, stop filing it and say so — the pattern is a template to edit, not a finding to repeat (G-7, D-32).',
        next_phase: '',
        max_concurrent: 2
    }),

    builtIn('reader-mystery', {
        title: 'Reader — mystery and pacing',
        description:
            'Reads two chapters ahead: where the answer is spent before it is earned, where suspense is dissolved by explaining it, where a chapter does a job its neighbour already did.',
        roles: [
            {
                name: 'reader',
                kind: 'reader',
                web: true,
                agents: 1,
                prompt:
                    'You are a Reader reading for mystery and pacing — the reader who is two chapters ahead and puts the book down early (D-30).\n' +
                    'Report where the answer is spent before it is earned: a reveal that lands too early, a suspense the prose dissolves by explaining it, a setup paid off too far from its planting, a chapter doing a job its neighbour already did (C-11). Name the chapter and the section every observation is about, or a Writer cannot act on it (D-7).\n' +
                    'Read the ledger\u2019s open setups before you judge a payoff (readLedger): an unpaid setup is a promise the current pass may be about to spend carelessly (C-5), and a payoff with no setup is the same defect seen from the other end (C-6).\n' +
                    'Propose reorderings, withheld reveals and moved plantings as Ideas with the reasoning attached (proposeIdea), and check what is already decided first (readIdeas, D-32).\n' +
                    'A "this came too early" claim is a SUSPICION, not a verdict: file it as a finding with the cost you actually believe and the chapters involved, and let the Editor confirm or dispute it (D-33, T-11). Never write the book, and never propose removing the mystery altogether — the Author kept it for a reason you can read in the Seed (P5).'
            }
        ],
        serves_phase: ALL_PHASES,
        attempts: 2,
        delegation: [],
        done_definition:
            'Every spend-too-early and pacing observation is filed with its chapter and section, open setups are consulted before any payoff is judged, and each proposal is a sourced or reasoned Idea rather than an edit.',
        escalation_rule:
            'requestAuthor through a finding only: if a reveal the plotline schedules feels spent two chapters early, that is a contract question for the Author, not something a Reader may re-plot (D-26).',
        next_phase: '',
        max_concurrent: 2
    }),

    builtIn('checker-consistency', {
        title: 'Checker — contract and continuity',
        description:
            'Judges the whole contract chain: plotlines against the Summary, plotlines against each other, chapters against their contracts, behaviour against the cast record. Reports; never writes.',
        roles: [
            {
                name: 'checker',
                kind: 'checker',
                web: true,
                agents: 1,
                prompt:
                    'You are the Consistency checker. You read the contract chain and report where it does not hold; you never write a word of it (P10, §13). Your output is a verdict, triaged findings, and the tasks that would fix them.\n' +
                    'Judge plotlines against the locked Summary (C-2), plotlines against each other (C-4), chapters against their plotline\u2019s must_happen and must_change (C-7, C-8), and behaviour against the cast record\u2019s arc + state_now (C-9). Read the decided Ideas and the last verdicts first (readIdeas, readVerdicts) so a fresh context does not re-open what the Author already settled (D-32, D-16).\n' +
                    'Read the ledger before you claim a contradiction (readLedger): mechanical continuity is checked there by code (C-5, C-6, D-10) and the server already knows it. Your value is the contradiction the ledger cannot express — the motive that no longer fits, the fact that quietly changed between chapters, the timeline that skips a step the reader will count.\n' +
                    'Every claim needs an evidence line quoting the artifact (D-15) and a cost you actually triaged (T-11): `critical` only for a contradiction that breaks the book\u2019s contract, `major` for one a reader will feel, `minor` for a seam, `taste` when it is a preference. Your cost is a RECOMMENDATION — the Editor sets the real one and will downgrade a confident one it cannot verify (D-34, D-34a).\n' +
                    'File the task that would fix it (createTask, D-11) and do not fix it yourself. A cross-chapter defect marks both sides: say which chapters are involved so the loop propagates it in both directions in time (L-8a, L-11a). If your brief asks for a judgment no tool can reach, call reportGap rather than improvising one (T-12).'
            }
        ],
        serves_phase: ALL_PHASES,
        attempts: 1,
        delegation: [],
        done_definition:
            'The chain your brief assigned is judged with a verdict, every defect is a finding with quoted evidence and a triaged cost, every fix has a task, and anything mechanical was checked against the ledger first (C-2, C-4, C-5, C-6, C-7, C-8, C-9).',
        escalation_rule:
            'Escalate only when a contradiction has no side the plotline says is wrong (L-11a) — that is an Author decision; everything else is a finding and a task.',
        next_phase: '',
        max_concurrent: 2
    }),

    builtIn('checker-prose', {
        title: 'Checker — prose quality and voice',
        description:
            'Per-chapter C-12 and C-13 only: does the prose reach the tone sheet\u2019s level, and does it read as though this Author wrote it. Folds taste notes into one readable entry per chapter.',
        roles: [
            {
                name: 'checker',
                kind: 'checker',
                // No web: this checker\u2019s entire standard lives in the store — the tone sheet
                // and the Editor templates\u2019 selection_rules (G-3a). Nothing outside the book
                // is evidence for whether it sounds like this Author.
                web: false,
                agents: 1,
                prompt:
                    'You are the Prose checker for phase ③, one chapter at a time. You judge two things and nothing else: whether the prose reaches the quality the Summary\u2019s tone sheet demands (C-12), and whether it reads as though this Author wrote it — voice, POV, tense and register against the tone sheet and the Editor templates\u2019 selection_rules (C-13).\n' +
                    'Read the tone sheet and the selection_rules EVERY run (readSummary, and the templates the Story has assigned). They are the standard, not your taste (P12, G-6). Never ask "is this good?" — ask "does this match what the sheet says", and answer with the line of the sheet you measured against.\n' +
                    'Quote the offending sentence as evidence and name the line of the sheet it violates (D-15); a verdict with no quotation is not evidence, and G-6 forbids a criterion whose evidence is taste rather than citation.\n' +
                    'Cost honestly (T-11): C-13 is a hard criterion, but a single clumsy sentence is `minor` or `taste`, not `major`. Fold your same-criterion notes into ONE entry per chapter rather than fifty "the prose felt flat here" lines — the Editor already rewrites findings for the Author\u2019s eye, and an unreadable pile of them is a defect in you, not in the book (§14 item 15).\n' +
                    'File the fix as a task for the Writer (D-11) and never write it: a checker that improves a sentence has taken the Writer\u2019s monopoly (P10), and a hundred fresh reviewers each improving one sentence is a hundred different prose styles, which is the exact failure this role exists to prevent.'
            }
        ],
        serves_phase: ['chapters'],
        attempts: 1,
        delegation: [],
        done_definition:
            'The chapter carries a C-12/C-13 verdict quoting the tone sheet and the selection_rules it was measured against, and every defect is one folded, triaged finding plus a task for the Writer.',
        escalation_rule:
            'requestAuthor when the tone sheet and the Editor\u2019s selection_rules contradict each other: only the Author can settle which one is their voice (P12, G-7).',
        next_phase: '',
        max_concurrent: 2
    })
];

// ---------------------------------------------------------------------------
// The default assignment
// ---------------------------------------------------------------------------

/**
 * The assignment a new Story starts with: one Writer per phase (the loop picks the one whose
 * `serves_phase` matches — D-17b), the Editor that every finding-verification and selection
 * path depends on (T-0, D-33), all four Reader angles (§14 item 10), and the consistency
 * checker.
 *
 * `checker-prose` is deliberately NOT in it: C-12 is soft and C-13 is the criterion the
 * Author is expected to tune by hand, so the prose crew is an opt-in rather than a default
 * voice in every chapter pass (U-8 assigns it).
 */
export const DEFAULT_ASSIGNMENT: string[] = [
    'writer-summary',
    'writer-plotlines',
    'writer-chapters',
    'editor-general',
    'reader-genre',
    'reader-plausibility',
    'reader-audience',
    'reader-mystery',
    'checker-consistency'
];

// ---------------------------------------------------------------------------
// validateTemplate — does this harness make sense at all?
// ---------------------------------------------------------------------------

/** A template's slug: what `template_refs`, `DEFAULT_ASSIGNMENT` and the U-8 cards name. */
const TEMPLATE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Every rule returns a message rather than throwing, because U-8's editor validates as the Author types. */
export function validateTemplate(template: Template): string[] {
    const errors: string[] = [];
    const at = (field: string): string => `template ${template?.name || '(unnamed)'}.${field}`;

    if (typeof template.name !== 'string' || template.name.trim().length === 0) {
        errors.push(`${at('name')} is required — it is the ref a Story assigns (D-17b)`);
    } else if (!TEMPLATE_NAME_PATTERN.test(template.name)) {
        errors.push(`${at('name')} must be a lowercase slug of letters, digits and dashes (got "${template.name}")`);
    }

    if (typeof template.title !== 'string' || template.title.trim().length === 0) {
        errors.push(`${at('title')} is required — the U-8 card has nothing else to show`);
    }

    // §4.12 roles is the harness's shape; an empty roster is a card, not a crew.
    if (!Array.isArray(template.roles) || template.roles.length === 0) {
        errors.push(`${at('roles')} must declare at least one role — a template is a harness, not an agent (D-38)`);
    }

    const roleNames = new Set<string>();
    let hasEditor = false;

    (Array.isArray(template.roles) ? template.roles : []).forEach((role, index) => {
        const where = `${at('roles')}[${index}]`;

        if (typeof role?.name !== 'string' || role.name.trim().length === 0) {
            errors.push(`${where}.name is required — the brief and the crew panel name roles, not positions`);
        } else if (roleNames.has(role.name)) {
            errors.push(`${where}.name "${role.name}" is declared twice — role names must be unique`);
        } else {
            roleNames.add(role.name);
        }

        // D-17a: `kind` selects the brief AND the permission row, so an unknown kind has no row.
        if (!ROLE_KINDS.includes(role?.kind as RoleKind)) {
            errors.push(
                `${where}.kind must be one of ${ROLE_KINDS.join(', ')} — the permission row follows from it (D-17a, T-0)`
            );
        }

        if (role?.kind === 'editor') hasEditor = true;

        // D-17a's named failure mode: a kind with no instructions improvises with whatever tool
        // it happens to hold, so an empty prompt is a build defect, not a default.
        if (typeof role?.prompt !== 'string' || role.prompt.trim().length === 0) {
            errors.push(`${where}.prompt is required — a kind with no instructions is the failure D-17a names`);
        }

        // D-38: `agents: N` runs N fresh agents of that kind inside ONE run, and `aggregate` is
        // how they collapse into the single answer the loop is entitled to receive.
        if (role?.agents !== undefined) {
            if (!Number.isInteger(role.agents) || role.agents < 1) {
                errors.push(`${where}.agents must be an integer >= 1 (got ${role.agents}) — D-38`);
            } else if (role.agents > 1 && !role.aggregate) {
                errors.push(
                    `${where}.aggregate is required when agents > 1 — the panel must answer once, so the loop never sees a vote (D-38, D-34a)`
                );
            } else if (role.agents === 1 && role.aggregate) {
                errors.push(`${where}.aggregate needs agents > 1 — one agent has nothing to aggregate (D-38)`);
            }
        }

        if (role?.aggregate !== undefined && !ROLE_AGGREGATIONS.includes(role.aggregate)) {
            errors.push(`${where}.aggregate must be one of ${ROLE_AGGREGATIONS.join(', ')}`);
        }
    });

    // §4.12 `serves_phase`: L-4 requires separate templates per loop, and an empty list means
    // the harness can never be dispatched for anything.
    if (!Array.isArray(template.serves_phase) || template.serves_phase.length === 0) {
        errors.push(
            `${at('serves_phase')} must name at least one phase — the sweep matches it against the Story\u2019s phase (L-4)`
        );
    } else {
        for (const phase of template.serves_phase) {
            if (!STORY_PHASES.includes(phase)) {
                errors.push(`${at('serves_phase')} has "${phase}", which is not one of ${STORY_PHASES.join(', ')}`);
            }
        }
    }

    if (typeof template.done_definition !== 'string' || template.done_definition.trim().length === 0) {
        errors.push(`${at('done_definition')} is required — each loop has its own done-definition (L-4)`);
    }

    // D-17c: an Editor with no selection_rules is guessing at the Author's taste, which is the
    // one thing P12 says the system must not do.
    if (hasEditor && (typeof template.selection_rules !== 'string' || template.selection_rules.trim().length === 0)) {
        errors.push(
            `${at('selection_rules')} is required for an Editor template — it is the Author\u2019s taste in their own words (D-17c, P12)`
        );
    }

    if (
        template.next_phase !== undefined &&
        template.next_phase !== '' &&
        !STORY_PHASES.includes(template.next_phase)
    ) {
        errors.push(`${at('next_phase')} must be a phase or empty (got "${template.next_phase}")`);
    }

    // D-17d/E-4: divergence is the mechanism, and `attempts: 0` would spawn no draft at all.
    if (!Number.isInteger(template.attempts) || template.attempts < 1) {
        errors.push(`${at('attempts')} must be an integer >= 1 — how many parallel revisions one unit spawns (D-17d)`);
    }

    if (
        template.max_concurrent !== undefined &&
        (!Number.isInteger(template.max_concurrent) || template.max_concurrent < 1)
    ) {
        errors.push(
            `${at('max_concurrent')} must be an integer >= 1 — it is the Author's setting, not an engine constant (D-38a, S-5)`
        );
    }

    // D-17e: delegation is inside this run only. Entries may name a role kind or one of this
    // template's own role names; anything else is a delegation to a role that cannot exist.
    if (template.delegation !== undefined) {
        if (!Array.isArray(template.delegation)) {
            errors.push(`${at('delegation')} must be a list of role names (D-17e)`);
        } else {
            for (const target of template.delegation) {
                const known = ROLE_KINDS.includes(target as RoleKind) || roleNames.has(target);

                if (typeof target !== 'string' || target.trim().length === 0 || !known) {
                    errors.push(
                        `${at('delegation')} names "${target}", which is neither a role kind (${ROLE_KINDS.join(', ')}) nor one of this template\u2019s roles (D-17e)`
                    );
                }
            }
        }
    }

    return errors;
}

// ---------------------------------------------------------------------------
// validateAssignment — may this set of crews run this Story?
// ---------------------------------------------------------------------------

/** Resolves an assignment ref against the catalogue. */
function resolveTemplate(ref: string, catalogue: readonly Template[]): Template | undefined {
    return catalogue.find((template) => template.id === ref || template.name === ref);
}

/** Does any of these templates hold a role of `kind`? */
function hasRoleKind(templates: readonly Template[], kind: RoleKind): boolean {
    return templates.some((template) => (template.roles ?? []).some((role) => role.kind === kind));
}

/** Is any of these templates assignable to `phase`? */
function servesPhase(templates: readonly Template[], phase: StoryPhase): boolean {
    return templates.some((template) => (template.serves_phase ?? []).includes(phase));
}

/**
 * T-0 — the only structural requirements the spec makes on an assignment.
 *
 * "How many of each kind a Story has is the Author's choice" (D-38a), so this refuses three
 * things and nothing else:
 *   1. no Writer at all — then nothing can write the artifacts, and P10's monopoly has no
 *      holder (D-17b). A second or third Writer is legal and simply means more voices;
 *      the divergence between them surfaces as an ordinary `taste` finding, not an error.
 *   2. no Editor once somebody else can trigger selection or findings work — `attempts > 1`
 *      means there is more than one draft to choose between (D-23), and any Reader or checker
 *      means findings are about to be filed that the loop would act on without verification
 *      (D-33). T-0 names both cases exactly.
 *   3. no Writer serving the Story's current phase — the assignment would leave the loop with
 *      a monopoly-holder who cannot be dispatched for the phase the Story is actually in.
 *
 * `catalogue` defaults to the built-ins and accepts the Story's own template rows, so a wave
 * that validates an Author's duplicated crew can pass its own registry (P15).
 */
export function validateAssignment(
    story: Story,
    templateRefs: string[],
    catalogue: readonly Template[] = BUILT_IN_TEMPLATES
): string[] {
    const errors: string[] = [];
    const assigned: Template[] = [];

    for (const ref of templateRefs ?? []) {
        const template = resolveTemplate(ref, catalogue);

        if (!template) {
            errors.push(`assignment names "${ref}", which is not a template in the catalogue (D-17b)`);

            continue;
        }

        // A template assigned twice is a mistake, not two voices — that is what a second entry
        // in the catalogue would be (D-38a).
        if (!assigned.some((existing) => existing.id === template.id || existing.name === template.name)) {
            assigned.push(template);
        }
    }

    const writers = assigned.filter((template) => (template.roles ?? []).some((role) => role.kind === 'writer'));

    if (writers.length === 0) {
        errors.push(
            `assignment has no Writer template — write permission comes only from a template assigned as a Writer (D-17b, P10)`
        );
    } else if (!servesPhase(writers, story.phase)) {
        errors.push(
            `no assigned Writer serves phase "${story.phase}", so nothing can write artifacts in this phase (serves_phase, L-4)`
        );
    }

    // T-0's Editor rule, stated as the spec states it.
    const needsEditor =
        assigned.some((template) => (template.attempts ?? 1) > 1) ||
        hasRoleKind(assigned, 'reader') ||
        hasRoleKind(assigned, 'checker');

    if (needsEditor && !hasRoleKind(assigned, 'editor')) {
        errors.push(
            `assignment needs an Editor template: drafts compete once attempts > 1 (D-23) and every Reader or checker finding must be verified before the loop acts on it (D-33, T-0)`
        );
    }

    return errors;
}

// ---------------------------------------------------------------------------
// duplicateTemplate — D-17's "duplicated, never edited in place"
// ---------------------------------------------------------------------------

/**
 * D-17 — the Author duplicates an existing crew and edits the copy.
 *
 * Every nested field is COPIED (roles, `serves_phase`, `delegation`), not shared: the point of
 * the duplicate is that the Author edits it into their own likeness (P12), and a shared
 * `roles` array would mean editing my Writer also edits everybody's built-in Writer. The copy
 * is `builtin: false, editable: true` — the built-in itself keeps `editable: false`, which is
 * what the U-8 card uses to offer Duplicate instead of Edit.
 *
 * `id`/`rev`/timestamps are placeholders the store replaces on `create` (W1), so a duplicate
 * is a payload a test can compare in full. Throws when the result would not validate — a
 * malformed name here is a programming error, and refusing it beats writing a template row the
 * catalogue then cannot render.
 */
export function duplicateTemplate(source: Template, newName: string): Template {
    const duplicate: Template = {
        ...copyValue(source),
        id: newName,
        name: newName,
        title: source.title,
        rev: 1,
        created_at: source.created_at,
        updated_at: source.updated_at,
        builtin: false,
        editable: true
    };

    const errors = validateTemplate(duplicate);

    if (errors.length > 0) throw new Error(`cannot duplicate "${source.name}": ${errors.join('; ')}`);

    return duplicate;
}
