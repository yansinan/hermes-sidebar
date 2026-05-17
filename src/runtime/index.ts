// runtime 统一出口：对上层隐藏内部文件拆分，便于后续重构与替换实现。
export {
  buildController,
  createRealController,
  type BuildControllerOptions,
} from "./controller";
export { toProfile, normalizeBaseUrl } from "./profile";
export {
  buildSelectionSummaryDraft,
  type SelectionSummaryDeps,
} from "./selection-summary-action";
export {
  buildPageBodySummaryDraft,
  type PageBodySummaryDeps,
} from "./page-body-summary-action";
