// The process entry of the storyline gateway (`yarn workspace
// @erosire/create-storyline start`).
//
// WHY THIS FILE IS TWO LINES: `vite-node` consumes the script path it is handed, so a
// module cannot tell from `process.argv` whether it is the entry or an import (the
// runner puts its own binary in argv[1] and drops the script). The only reliable
// "run the CLI" signal is being the FILE the runner was told to execute, so the
// factory and the CLI body live in ./main.ts, import-safe, and this file is the one
// place that runs.
//
// Nothing else in the package may start a listener at import time — the same rule
// `@underload/harness` documents for its own barrels and the reason the gateway can
// import our route modules before it binds a port.
import { runCli } from './main';

await runCli();
