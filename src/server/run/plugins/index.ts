// Storyline's own harness plugins — the policy a Story's engine run needs and the engine package
// cannot know about.
//
// `./critic-termination` is the one that ships today: C2-AD3's rule that a Critic review pass ENDS
// once its terminal report has FILED (a tool-layer refusal leaves the model its correction turn),
// with a soft nudge before the hard cap and an honest end state after either. Storyline supplies it
// through `HarnessConfiguration.plugins` (server/run/story-engine.ts), because `turn.before` is the
// only hook whose return value the engine honours and a plugin is the only critic-scoped mechanism
// the harness exposes. The engine also feeds it every tool RESULT, which is the only place a
// Storyline refusal is visible.
export * from './critic-termination';
