# storyline-project

A minimal TypeScript starter project, scaffolded by [`@erosire/create-storyline`](https://www.npmjs.com/package/@erosire/create-storyline).

## Requirements

- Node.js >= 20

## Getting started

```bash
npm install
npm run build # tsc → dist/
npm start # node dist/index.js
```

Pass a project name to the demo entry:

```bash
npm start -- my-app
```

Other scripts:

```bash
npm run typecheck # tsc --noEmit
```

## Layout

```
src/index.ts    entry point (strictly typed)
tsconfig.json   strict ES2022 + NodeNext, rootDir src → outDir dist
```

Rename the project by editing the `name` field in `package.json`.
