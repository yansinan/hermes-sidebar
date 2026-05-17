// Build metadata injected by Vite at bundle time so the UI can show which dist artifact is loaded in Chrome.
declare const __HERMES_BUILD_SHA__: string;
declare const __HERMES_BUILD_AT__: string;
declare const __HERMES_BUILD_LABEL__: string;

export interface BuildInfo {
  sha: string;
  builtAt: string;
  label: string;
}

export const BUILD_INFO: BuildInfo = {
  sha: __HERMES_BUILD_SHA__,
  builtAt: __HERMES_BUILD_AT__,
  label: __HERMES_BUILD_LABEL__,
};
