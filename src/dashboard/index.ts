// Dashboard barrel — the public surface of the UI half of this package.
//
// Everything here is plugin-composed: the app component, the composition factory
// (so a host can build its own instance and drive commands directly), the shell, the
// React bridge, the center-pane fold, and the reserved id vocabulary the plugins
// speak. No server code is re-exported — the barrel stays importable from a browser
// bundle.
export * from './content-view';
export * from './contract';
export * from './composition';
export * from './state-hooks';
export * from './StorylineApp';
export * from './WorkstationShell';
export * from './workbench';
