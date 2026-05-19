export const RUNS_EVENT_LABELS = {
  createSubmitting: "正在提交任务...",
  createAcceptedProcessBar: "Run 已创建，等待事件流...",
  createAcceptedTimeline: "任务已创建，准备执行",
  eventsConnectedTimeline: "已连接执行事件流",
  eventsReceiving: "正在接收执行结果...",
  queueWaitingSeconds: (seconds: number) => `模型排队中，已等待 ${seconds} 秒...`,
  queueWaitingMinutes: (minutes: number) => `模型排队中，已等待 ${minutes} 分钟...`,
  generatingReply: "模型正在生成回复...",
  resultReturned: "模型已返回结果...",
  reasoningProcessBar: "模型思考中...",
  reasoningTimeline: "模型正在分析问题",
  toolRunningProcessBar: (tool: string, label?: string) =>
    label && label.trim().length > 0
      ? `工具 ${tool} 调用中: ${label}`
      : `工具 ${tool} 调用中...`,
  toolStartedTimeline: (tool: string, preview?: string) =>
    preview && preview.trim().length > 0
      ? `调用工具：${tool}（${preview}）`
      : `调用工具：${tool}`,
  toolCompletedProcessBar: (tool: string, error?: boolean) =>
    `工具 ${tool} ${error ? "失败" : "已完成"}`,
  toolCompletedTimeline: (tool: string, error?: boolean) =>
    error ? `工具失败：${tool}` : `工具完成：${tool}`,
  approvalRequest: "等待你确认操作权限",
  approvalResponded: "已收到权限确认，继续执行",
  runCompletedTimeline: "回复生成完成",
  runFailedTimeline: "任务执行失败",
  runCancelledTimeline: "任务已取消",
  terminalOk: "执行结束",
  terminalStopped: "已停止执行",
  terminalInterrupted: "连接中断，正在恢复",
  recoveredFromPoll: "已从任务结果恢复回复内容",
  fallbackToChat: "Runs 通道异常，切换到 Chat 流式回复",
  unknownEvent: (eventName: string) => `收到事件：${eventName}`,
} as const;

export function formatRunsQueueWait(elapsedSeconds: number): string {
  return elapsedSeconds < 60
    ? RUNS_EVENT_LABELS.queueWaitingSeconds(elapsedSeconds)
    : RUNS_EVENT_LABELS.queueWaitingMinutes(Math.round(elapsedSeconds / 60));
}
