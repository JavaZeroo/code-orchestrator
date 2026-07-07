/** 当前项目上下文（design-v2 #36）：切项目 = 切全局上下文，选择持久化到 localStorage。 */

import { createContext, useContext, useState, type ReactNode } from 'react';

const KEY = 'co:currentProjectId';

interface Ctx {
  projectId: string | null;
  setProjectId: (id: string | null) => void;
}

const ProjectCtx = createContext<Ctx>({ projectId: null, setProjectId: () => {} });

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projectId, setId] = useState<string | null>(() => localStorage.getItem(KEY));
  const setProjectId = (id: string | null) => {
    setId(id);
    if (id) {
      localStorage.setItem(KEY, id);
    } else {
      localStorage.removeItem(KEY);
    }
  };
  return <ProjectCtx.Provider value={{ projectId, setProjectId }}>{children}</ProjectCtx.Provider>;
}

export const useCurrentProject = () => useContext(ProjectCtx);

/** 作用域助手：当前项目 + 判断某实体是否属于它（projectId 为空/未选时放行，兼容加载中） */
export function useProjectScope() {
  const { projectId } = useCurrentProject();
  return {
    projectId,
    inScope: (pid: string | null | undefined) => !projectId || pid === projectId,
  };
}
