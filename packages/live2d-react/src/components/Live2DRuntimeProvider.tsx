// 向一个 React 子树注入明确归属的 Live2D 舞台运行时。
import { createContext, useContext, type JSX, type ReactNode } from 'react';

import type { Live2DRuntime } from '../runtime.js';

const Live2DRuntimeContext = createContext<Live2DRuntime | null>(null);

export interface Live2DRuntimeProviderProps {
  runtime: Live2DRuntime;
  children: ReactNode;
}

export function Live2DRuntimeProvider({
  runtime,
  children,
}: Live2DRuntimeProviderProps): JSX.Element {
  return (
    <Live2DRuntimeContext.Provider value={runtime}>
      {children}
    </Live2DRuntimeContext.Provider>
  );
}

export function useLive2DRuntime(explicitRuntime?: Live2DRuntime): Live2DRuntime {
  const contextualRuntime = useContext(Live2DRuntimeContext);
  const runtime = explicitRuntime ?? contextualRuntime;
  if (!runtime) {
    throw new Error('Live2DStage must receive a runtime or be wrapped in Live2DRuntimeProvider');
  }
  return runtime;
}
