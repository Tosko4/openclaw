import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Keep this suffix together so host composition preserves translation alias order.
const enBoardWidgets = {
  board: {
    widget: {
      kindWebsite: "Website",
      websiteOpen: "Open website",
      websiteEmbedHint: "If this site does not load here, open it in a new tab.",
      websiteSameOrigin:
        "Open this website in a new tab. Gateway and Control UI pages cannot be embedded in a website widget.",
      pluginLoading: "Loading plugin widget…",
      disabledPlugin: "Widget from disabled plugin {pluginId}",
    },
  },
} satisfies TranslationMap;

export const registerBoardWidgetsEnglish = Object.assign(
  () => {
    Object.assign(en.board.widget, enBoardWidgets.board.widget);
  },
  { catalog: enBoardWidgets },
);
