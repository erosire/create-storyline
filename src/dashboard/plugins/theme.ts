// Theme plugin: the one styling switch the shell touches.
//
// Two modes only (ink / paper), one state cell, and a palette service so a panel
// that needs a colour reads it instead of inventing one. The shell projects the
// mode onto `data-theme` and styles/workstation.css owns every colour — the same
// split the kernel example uses, kept this small on purpose: the brief asks for a
// functional workstation, not a design system.
import type { DashboardPlugin } from '@underload/dashboard';
import {
    PLUGIN_IDS,
    STATUS_SLOT,
    THEME_CHIP,
    THEME_MODE_STATE,
    THEME_PALETTE_SERVICE,
    THEME_TOGGLE_COMMAND,
    type StatusValue,
    type ThemeMode,
    type ThemePalette
} from '../contract';
import { ThemeChip } from '../components/Chips';

// The accent each mode paints. Everything else lives in CSS custom properties.
const PALETTE: ThemePalette = {
    ink: { accent: '#e8b45a' },
    paper: { accent: '#8a5a1e' }
};

export function createThemePlugin(initial: ThemeMode = 'ink'): DashboardPlugin {
    return {
        id: PLUGIN_IDS.theme,
        setup(api) {
            const mode = api.state<ThemeMode>(THEME_MODE_STATE, initial);

            api.service<ThemePalette>(THEME_PALETTE_SERVICE, PALETTE);

            api.command<void, ThemeMode>(THEME_TOGGLE_COMMAND, () => {
                // Written through the updater form: an equal write is a no-op to the
                // kernel (SameValueZero), and this one always differs.
                mode.set((previous) => (previous === 'ink' ? 'paper' : 'ink'));

                return mode.get();
            });

            api.slot<StatusValue>(STATUS_SLOT, {
                id: THEME_CHIP,
                order: 90,
                value: { label: 'Theme', component: ThemeChip }
            });
        }
    };
}
