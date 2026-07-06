/**
 * 加速器适配器（design-v2 Q4/Q8）：把「分到哪些卡」翻译成 docker run 的设备/环境。
 * 可插拔——加一种加速器 = 加一个适配器，调度器/容器逻辑一行不改（照 Forge 适配器那套）。
 * v1 只实现 Ascend；NVIDIA 留 v2（且宿主机 Docker 18.09 早于 --gpus，届时走 --runtime=nvidia）。
 */

export interface BindFlags {
  /** docker run --device 列表 */
  devices: string[];
  /** 注入容器的环境变量（可见卡等） */
  env: Record<string, string>;
  /** NVIDIA 专用 --gpus 值（Ascend 不用） */
  gpus?: string;
}

export interface AcceleratorAdapter {
  kind: string;
  /** 把分到的卡 index 翻成 docker 绑定；卡在建容器时静态绑定（Q3：容器活着=卡被占） */
  bindFlags(indices: number[]): BindFlags;
}

/** 昇腾 NPU：每卡 /dev/davinci{i} + 共享管理设备，ASCEND_RT_VISIBLE_DEVICES 标可见卡 */
const ascend: AcceleratorAdapter = {
  kind: 'ascend-npu',
  bindFlags(indices) {
    const shared = ['/dev/davinci_manager', '/dev/devmm_svm', '/dev/hisi_hdc'];
    const perCard = indices.map((i) => `/dev/davinci${i}`);
    return {
      devices: [...shared, ...perCard],
      env: { ASCEND_RT_VISIBLE_DEVICES: indices.join(',') },
    };
  },
};

const registry: Record<string, AcceleratorAdapter> = {
  [ascend.kind]: ascend,
};

export function getAccelerator(kind: string): AcceleratorAdapter | null {
  return registry[kind] ?? null;
}

export function knownAcceleratorKinds(): string[] {
  return Object.keys(registry);
}
