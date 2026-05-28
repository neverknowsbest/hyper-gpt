// Shared types used by both backend and frontend.
// Mirrors docs/data-model.md.

export type ProviderId = "anthropic" | "openai";

export type ContentPart = { type: "text"; text: string };
// Future: image, tool_use, tool_result — see docs/future-features.md.

export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "errored";

export interface User {
  id: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface Canvas {
  id: string;
  userId: string;
  title: string;
  seedNodeId: string;
  defaultProvider: ProviderId;
  defaultModel: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface Node {
  id: string;
  canvasId: string;
  title: string;
  providerOverride: ProviderId | null;
  modelOverride: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface Message {
  id: string;
  nodeId: string;
  role: MessageRole;
  content: ContentPart[];
  provider: ProviderId | null;
  model: string | null;
  orderIndex: number;
  status: MessageStatus;
  createdAt: string;
  completedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface Edge {
  id: string;
  sourceNodeId: string;
  sourceMessageId: string;
  targetNodeId: string;
  citationStart: number;
  citationEnd: number;
  citationText: string;
  kind: "spawn";
  createdAt: string;
  metadata: Record<string, unknown>;
}

// SSE event envelope sent from backend to frontend during a streaming response.
export type StreamEvent =
  | { type: "message_start"; messageId: string }
  | { type: "content_delta"; messageId: string; delta: ContentPart }
  | { type: "message_complete"; messageId: string; completedAt: string }
  | { type: "error"; messageId: string; error: { code: string; message: string } };

// API request/response shapes.
export interface CreateCanvasRequest {
  title?: string;
  defaultProvider: ProviderId;
  defaultModel: string;
  seedUserMessage: ContentPart[];
}

export interface CreateCanvasResponse {
  canvas: Canvas;
  seedNode: Node;
  userMessage: Message;
  assistantMessageId: string; // open EventSource at /api/stream/:assistantMessageId
}

export interface SendMessageRequest {
  content: ContentPart[];
}

export interface SendMessageResponse {
  userMessage: Message;
  assistantMessageId: string;
}

export interface GetNodeResponse {
  node: Node;
  messages: Message[];
  inboundEdge: Edge | null;
  outboundEdges: Edge[];
}

export interface GetCanvasResponse {
  canvas: Canvas;
  nodes: Node[];
  edges: Edge[];
}

export interface SpawnRequest {
  sourceNodeId: string;
  sourceMessageId: string;
  citation: { start: number; end: number; text: string };
  firstUserMessage: ContentPart[];
}

export interface SpawnResponse {
  node: Node;
  edge: Edge;
  userMessage: Message;
  assistantMessageId: string;
}

export interface ProviderConfigSummary {
  provider: ProviderId;
  hasKey: boolean;
  masked: string | null;
}

export interface UserPreferences {
  defaultProvider: ProviderId;
  defaultModel: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
}

export type ModelCatalog = Record<ProviderId, ModelInfo[]>;
