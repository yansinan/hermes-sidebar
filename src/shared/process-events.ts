import type { Message } from "./types/message";

export interface ActivityTimelineItem {
  text: string;
  at: number;
}

export function formatProcessTimestamp(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function stripStampedTimelineText(content: string): string {
  return content.replace(/^\d{2}:\d{2}:\d{2}\s+/, "").trim();
}

export function normalizeProcessStatus(statusText: unknown): string {
  if (typeof statusText === "string" && statusText.trim()) {
    return statusText.trim();
  }
  return "处理中...";
}

export function appendTimelineEvent(
  prev: ActivityTimelineItem[],
  statusText: unknown,
  at: number = Date.now(),
): ActivityTimelineItem[] {
  const text = normalizeProcessStatus(statusText);
  const last = prev[prev.length - 1];
  if (last?.text === text) return prev;
  return [...prev, { text, at }];
}

export function toSystemTimelineMessages(
  timeline: ActivityTimelineItem[],
  createId: () => string,
): Message[] {
  return timeline.flatMap((item) => {
    const text = (item?.text ?? "").trim();
    if (!text) return [];
    const createdAt =
      typeof item.at === "number" && Number.isFinite(item.at)
        ? item.at
        : Date.now();
    return [
      {
        id: createId(),
        role: "system" as const,
        createdAt,
        content: `${formatProcessTimestamp(createdAt)}  ${text}`,
      },
    ];
  });
}

export function resolveProcessBarText(args: {
  extractionActive: boolean;
  extractionStatusText: string;
  latestSystemText: string;
  activePhase: "idle" | "sending" | "queued" | "running" | "waiting-approval" | "streaming";
  extractionPhase?: "idle" | "extracting" | "processing";
}): string {
  const {
    extractionActive,
    extractionStatusText,
    latestSystemText,
    activePhase,
    extractionPhase,
  } = args;
  return (
    (extractionActive ? extractionStatusText : "") ||
    latestSystemText ||
    (activePhase === "sending"
      ? "请求已发送，等待模型响应..."
      : activePhase === "queued"
        ? "模型排队中..."
        : activePhase === "running"
          ? "任务执行中..."
          : activePhase === "waiting-approval"
            ? "等待你确认操作权限..."
          : activePhase === "streaming"
            ? "正在接收模型流式响应..."
            : extractionPhase === "extracting"
              ? "提取页面内容中..."
              : "处理中...")
  );
}

export function resolveProcessBarTransport(args: {
  extractionActive: boolean;
  extractionTransport: string;
  responseChannel: string;
  responseTrying: string;
}): string {
  const { extractionActive, extractionTransport, responseChannel, responseTrying } = args;
  if (extractionActive && extractionTransport) {
    return `trying ${extractionTransport}`;
  }
  if (responseChannel) {
    return `from ${responseChannel}`;
  }
  if (responseTrying) {
    return `trying ${responseTrying}`;
  }
  return "";
}
