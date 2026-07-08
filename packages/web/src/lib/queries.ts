import { QueryClient, useQuery } from '@tanstack/react-query';
import { api } from '../api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 },
  },
});

export const useSessions = () =>
  useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 8_000 });

export const useMachines = () =>
  useQuery({ queryKey: ['machines'], queryFn: api.machines, refetchInterval: 15_000 });

export const useAllMachines = () =>
  useQuery({ queryKey: ['machines-all'], queryFn: api.allMachines, refetchInterval: 15_000 });

export const useWorkflows = () =>
  useQuery({ queryKey: ['workflows'], queryFn: api.workflows, refetchInterval: 10_000 });

export const useRuns = () => useQuery({ queryKey: ['runs'], queryFn: api.runs, refetchInterval: 8_000 });

export const useTriggers = () =>
  useQuery({ queryKey: ['triggers'], queryFn: api.triggers, refetchInterval: 15_000 });

export const useRequirements = () =>
  useQuery({ queryKey: ['requirements'], queryFn: api.requirements, refetchInterval: 10_000 });

export const useApprovals = () =>
  useQuery({ queryKey: ['approvals'], queryFn: api.pendingApprovals, refetchInterval: 8_000 });

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 20_000 });

export const useWork = (projectId?: string | null) =>
  useQuery({ queryKey: ['work', projectId], queryFn: () => api.work(projectId), refetchInterval: 8_000 });

export const useLlmProviders = () =>
  useQuery({ queryKey: ['llm-providers'], queryFn: api.listProviders, refetchInterval: 30_000 });

export const useProjectMaterializations = (projectId?: string | null) =>
  useQuery({
    queryKey: ['materializations', projectId],
    queryFn: () => (projectId ? api.projectMaterializations(projectId) : Promise.resolve([])),
    enabled: !!projectId,
  });

export const invalidate = (key: string) => void queryClient.invalidateQueries({ queryKey: [key] });
