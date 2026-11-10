// Layout plugin: the workstation's shape, as configuration rather than state.
//
// It owns no state at all — the operator never mutates the layout at runtime — and
// publishes two services the shell reads (`storyline.layout.brand`,
// `storyline.layout.regions`) plus one status-strip chip. This is what keeps the
// shell feature-blind: it maps over the slot snapshot and renders, and a new
// capability never edits this file.
//
// Pattern source: packages/underload/dashboard/example/src/plugins/layout.ts.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    BRAND_CHIP,
    LAYOUT_BRAND_SERVICE,
    LAYOUT_REGIONS_SERVICE,
    PLUGIN_IDS,
    STATUS_ORDERS,
    STATUS_SLOT,
    type BrandSpec,
    type RegionSpec,
    type StatusValue
} from '../contract';
import { BrandChip } from '../components/Chips';

// The three panes plus the strip under them. `order` is the reading order on a wide
// screen; styles/workstation.css turns it into a grid and collapses it into one
// column on a narrow one, so this declaration stays about meaning, not pixels.
const REGIONS: readonly RegionSpec[] = [
    { id: 'tree', label: 'Title tree', order: 10 },
    { id: 'center', label: 'Story document', order: 20 },
    { id: 'agents', label: 'Agents', order: 30 },
    { id: 'composer', label: 'Composer', order: 40 }
];

// Story-first copy: the product is a stack of Titles being written, never a harness
// console. Nothing here mentions sessions, presets or harnesses.
const BRAND: BrandSpec = {
    name: 'Storyline',
    tagline: 'Titles on the left · the story in the middle · writer, reader and editor on the right',
    notice: 'Each Title is one story the three agents work on together. Pick one, or start a new one.'
};

export function createLayoutPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.layout,
        setup(api) {
            api.service<BrandSpec>(LAYOUT_BRAND_SERVICE, BRAND);
            api.service<readonly RegionSpec[]>(LAYOUT_REGIONS_SERVICE, REGIONS);
            api.slot<StatusValue>(STATUS_SLOT, {
                id: BRAND_CHIP,
                order: STATUS_ORDERS.brand,
                value: { label: 'Brand', component: BrandChip }
            });
        }
    };
}
