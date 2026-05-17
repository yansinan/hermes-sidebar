import { useEffect, useState } from "react";
import type { AppController, AppState } from "../shared/types";

export function useAppState(controller: AppController): AppState {
  const [state, setState] = useState<AppState>(() => controller.getState());
  useEffect(() => controller.subscribe(setState), [controller]);
  return state;
}
