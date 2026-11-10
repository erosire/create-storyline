// The server seam as a plugin: publishes `storyline.api`, nothing else.
//
// One service holding the whole client is what lets every other plugin stay
// network-blind and the whole composition run against an injected fake (the
// composition test asserts the graph without a fetch). The api object itself
// lives in src/api/storyline.ts; this file is only the registration, which is
// where the kernel wants it — services are declared during setup, and a consumer
// that reads one during its own setup must declare the `requires` edge.
import type { DashboardPlugin } from '@underload/dashboard';
import type { StorylineApi } from '../../api';
import { API_SERVICE, PLUGIN_IDS, type StorylineApiService } from '../contract';

export function createApiPlugin(client: StorylineApi): DashboardPlugin {
    return {
        id: PLUGIN_IDS.api,
        setup(api) {
            api.service<StorylineApiService>(API_SERVICE, client);
        }
    };
}
