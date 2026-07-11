import { describe, expect, it } from 'vitest';
import { buildContainerRunArgs } from './container';

describe('buildContainerRunArgs', () => {
  it('forwards an NVIDIA device selection as a Docker --gpus argument', () => {
    expect(
      buildContainerRunArgs({
        image: 'nvidia/cuda:latest',
        mounts: [],
        devices: [],
        gpus: 'device=0,1',
        extraArgs: [],
        command: ['sleep', 'infinity'],
      }),
    ).toEqual(['run', '-d', '--gpus', 'device=0,1', 'nvidia/cuda:latest', 'sleep', 'infinity']);
  });
});
