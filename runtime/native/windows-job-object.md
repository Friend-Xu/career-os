# Windows Job Object — Future Enhancement

> Runtime Safety Layer v1 明确**不实现** Job Object（约束：便携 node、零 native addon、不引入服务安装）。
> 本文档保留方向与参考，供 CodeNarrator / Translate-video-WebUI 桌面化 / 商业发行时启用。

## 为什么 Job Object 是最终形态

当前 v1 的清理链（信号驱动 + 启动自愈）依赖进程收到信号；supervisor 被无信号强杀
（崩溃/蓝屏/任务管理器）时仍有短暂残留窗口——靠下次启动 recovery 兜底，不保证"父死必清"。

Windows Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 是原生保证：
父进程（supervisor）最后一个 job handle 关闭 → Windows 终止 job 内全部进程
（含孙进程、conhost），**不依赖任何 JS 清理代码**。等效于 Unix 进程组。

## 业界参考（生产级实现）

- [vercel/turborepo PR #11829](https://github.com/vercel/turborepo/pull/11829)：每个 spawn 子进程绑
  Job Object 防 conhost/孙进程残留（Rust/napi 实现；job 创建失败仅记录不致命）
- [hashicorp/nomad PR #24214](https://github.com/hashicorp/nomad/pull/24214)（Go raw_exec executor）
- [woodpecker-ci/woodpecker #6717](https://github.com/woodpecker-ci/woodpecker/issues/6717)（Go）

## Node 生态现状（2026-08 调研结论）

npm 无现成的纯 JS / 预编译 Job Object 包（windows-job-object / job-object / win-job / node-job-object 全 404）。
可选路径（均需 native）：

1. **napi-rs / node-gyp addon**：需要编译工具链——违反便携 node 约束
2. **预编译 .node 二进制**：需要 CI 构建管线，v1 不投入
3. **PowerShell P/Invoke**：每次启动运行时编译 C#，脆弱且依赖 PowerShell——不推荐

## 启用条件（满足任一）

- CodeNarrator / Translate-video-WebUI 变成桌面应用（Electron/Tauri）
- 需要"父死必清"的绝对保证（服务化部署、商业发行）
- 项目引入 native 构建管线（napi-rs workspace）

## 架构落位（启用时）

```
runtime/native/windows-job-object/
├── index.node         # napi addon：CreateJobObject + AssignProcessToJobObject + KILL_ON_JOB_CLOSE
└── index.mjs          # 包装：spawn 前创建 job、spawn 后原子绑定（PROC_THREAD_ATTRIBUTE_JOB_LIST）
```

process-manager 的 `spawnTracked` 增加可选 job 绑定，接口不变——v1 代码无需重构。
