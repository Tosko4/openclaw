// Plain-Node diagnostic implementation; keep its raw callback contract explicit
// for the strict core program, which does not enable allowJs.
type CliComponentObserver = (event: string, data?: object) => void;

export let observeCliComponentProbe: CliComponentObserver | undefined;

export function startCliComponentProbe(): {
  observe: CliComponentObserver;
  finish(): void;
};
