/**
 * src/index.ts — minimal strictly-typed entry point for the generated project.
 *
 * Build with `npm run build` (tsc → dist/) and run with `npm start`
 * (node dist/index.js). Cross-ref: template/package.json scripts,
 * template/tsconfig.json (strict, ES2022, NodeNext, outDir dist, rootDir src).
 */

// A tiny typed shape so `strict` mode has something meaningful to verify.
type ProjectStatus = {
    name: string;
    tasks: readonly string[];
};

/**
 * Renders one status line per task. Pure (data in → lines out) so it can be
 * unit-tested without touching the console or the filesystem.
 */
const renderStatus = ({ name, tasks }: ProjectStatus): string[] => tasks.map((task) => `${name}: ${task}`);

/**
 * Project name comes from argv (`node dist/index.js my-app`); with
 * noUncheckedIndexedAccess enabled, argv[2] is `string | undefined`, so the
 * fallback is explicit instead of an assertion.
 */
const resolveProjectName = (): string => process.argv[2] ?? 'storyline-project';

const main = (): void => {
    const status: ProjectStatus = {
        name: resolveProjectName(),
        // No trailing comma: matches the Prettier conventions this template is
        // formatted with (root .prettierrc sets trailingComma: "none"); reformat
        // freely once this project has its own config.
        tasks: ['scaffolded', 'run `npm install`, then `npm run build` && `npm start`']
    };

    for (const line of renderStatus(status)) {
        console.log(line);
    }
};

main();
