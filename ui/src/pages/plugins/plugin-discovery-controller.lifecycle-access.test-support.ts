import type { PluginDiscoveryCategory, PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import type { PluginDiscoveryController } from "./plugin-discovery-controller.ts";

export const SECTION_NAMES = ["categories", "featured", "trending"] as const;
export type SectionName = (typeof SECTION_NAMES)[number];
type State = {
  items: readonly (PluginDiscoveryCategory | PluginDiscoveryEntry)[];
  error: string | null;
  loading: boolean | null;
};
type Access = {
  state: (controller: PluginDiscoveryController) => State;
  refresh: (controller: PluginDiscoveryController) => Promise<void>;
};

// Explicit candidate-source access only; category loading remains unobserved.
const access = {
  categories: {
    state: (c) => ({ items: c.categories.items, error: c.categories.error, loading: null }),
    refresh: (c) => c.categories.refresh(),
  },
  featured: {
    state: (c) => ({
      items: c.featured.items,
      error: c.featured.error,
      loading: c.featured.loading,
    }),
    refresh: (c) => c.featured.refresh(),
  },
  trending: {
    state: (c) => ({
      items: c.trending.items,
      error: c.trending.error,
      loading: c.trending.loading,
    }),
    refresh: (c) => c.trending.refresh(),
  },
} satisfies Record<SectionName, Access>;

export const sectionState = (controller: PluginDiscoveryController, name: SectionName): State =>
  access[name].state(controller);
export const refreshSection = (controller: PluginDiscoveryController, name: SectionName) =>
  access[name].refresh(controller);
