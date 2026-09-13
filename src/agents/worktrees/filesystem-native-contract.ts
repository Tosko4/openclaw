import type { CloneFileMetadata, TreeCloneBackend } from "@openclaw/fs-safe/copy";

export type WorktreeFilesystemRead =
  | { type: "probe"; parent: string }
  | { type: "metadata"; paths: string[] };

export type WorktreeFilesystemWrite =
  | { type: "create"; destination: string }
  | { type: "copy"; source: string; destination: string };

export type WorktreeFilesystemReply =
  | { type: "probe"; backend: TreeCloneBackend | undefined }
  | { type: "metadata"; entries: (CloneFileMetadata | undefined)[] }
  | { type: "written" }
  | { type: "failed"; message: string; code?: string };
