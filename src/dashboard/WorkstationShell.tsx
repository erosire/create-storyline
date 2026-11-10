// The workstation shell: the only React that knows what a storyline workspace
// looks like, and it contains no feature list.
//
// Everything on screen comes out of the composed instance — brand from
// `storyline.layout.brand`, columns from `storyline.layout.regions`, cards from the
// `storyline.panels` slot, chips from `storyline.status`, skin from
// `storyline.theme.mode`. Registering a capability (a locations rail, a continuity
// checker) adds a panel with NO edit to this file, which is the property the
// dashboard kernel exists to provide.
//
// Structure follows the kernel's own worked example
// (packages/underload/dashboard/example/src/app/WorkstationShell.tsx); the layout
// vocabulary is this app's (chapters rail · agent stage · story library).
import type { Dashboard } from '@underload/dashboard';
// The stylesheet lives beside this shell (src/dashboard/styles/), which is the only
// place the workstation's colours are declared.
import './styles/workstation.css';
import {
    LAYOUT_BRAND_SERVICE,
    LAYOUT_REGIONS_SERVICE,
    PANEL_SLOT,
    STATUS_SLOT,
    THEME_MODE_STATE,
    type BrandSpec,
    type PanelValue,
    type RegionId,
    type RegionSpec,
    type StatusValue,
    type ThemeMode
} from './contract';
import { useDashboardService, useDashboardSlot, useDashboardValue } from './state-hooks';
import { WorkbenchProvider } from './workbench';

export function WorkstationShell({ instance }: { instance: Dashboard }) {
    return (
        <WorkbenchProvider instance={instance}>
            <ShellFrame />
        </WorkbenchProvider>
    );
}

function ShellFrame() {
    const brand = useDashboardService<BrandSpec>(LAYOUT_BRAND_SERVICE);
    const regions = useDashboardService<readonly RegionSpec[]>(LAYOUT_REGIONS_SERVICE);
    const panels = useDashboardSlot<PanelValue>(PANEL_SLOT);
    const statuses = useDashboardSlot<StatusValue>(STATUS_SLOT);
    const mode = useDashboardValue<ThemeMode>(THEME_MODE_STATE);

    // Slot order is already (order, registration index) stable, so grouping by
    // region preserves it: the plugins alone decide placement.
    const grouped = new Map<RegionId, typeof panels>();

    for (const contribution of panels) {
        const existing = grouped.get(contribution.value.region) ?? [];
        grouped.set(contribution.value.region, [...existing, contribution]);
    }

    const declared = [...regions].sort((left, right) => left.order - right.order);
    const declaredIds: readonly RegionId[] = declared.map((spec) => spec.id);

    // A plugin may name a region the layout never declared. It still renders, at
    // the end, instead of vanishing: a typo becomes visible rather than silent.
    const overflow: readonly RegionId[] = [...grouped.keys()].filter((id) => !declaredIds.includes(id));
    const columns: readonly { id: RegionId; label: string }[] = [
        ...declared.map((spec) => ({ id: spec.id, label: spec.label })),
        ...overflow.map((id) => ({ id, label: `${id} overflow` }))
    ];

    return (
        <div className="station" data-theme={mode}>
            <header className="station__bar">
                <h1 className="station__brand">{brand.name}</h1>
                <p className="station__tagline">{brand.tagline}</p>
                <div className="station__chips" role="group" aria-label="Workstation status">
                    {statuses.map((contribution) => {
                        const Chip = contribution.value.component;

                        return <Chip key={contribution.id} />;
                    })}
                </div>
            </header>

            <div className="station__grid">
                {columns.map((column) => {
                    const columnPanels = grouped.get(column.id) ?? [];

                    return (
                        <section key={column.id} className={`station__region station__region--${column.id}`} aria-label={column.label}>
                            {columnPanels.map((contribution) => {
                                const Panel = contribution.value.component;
                                const titleId = `panel-${contribution.id}-title`;

                                return (
                                    <article key={contribution.id} className="panel" data-panel={contribution.id} aria-labelledby={titleId}>
                                        <header className="panel__head">
                                            <h2 className="panel__title" id={titleId}>
                                                {contribution.value.title}
                                            </h2>
                                            {contribution.value.hint ? <span className="panel__hint">{contribution.value.hint}</span> : null}
                                        </header>
                                        <div className="panel__body">
                                            <Panel />
                                        </div>
                                    </article>
                                );
                            })}
                        </section>
                    );
                })}
            </div>

            <footer className="station__note">{brand.notice}</footer>
        </div>
    );
}
