import type {
  Canvas,
  CreateCanvasRequest,
  CreateCanvasResponse,
  GetCanvasResponse,
  GetNodeResponse,
  Message,
  ModelCatalog,
  ProviderConfigSummary,
  ProviderId,
  SendMessageRequest,
  SendMessageResponse,
  SpawnRequest,
  SpawnResponse,
  StreamEvent,
  UserPreferences,
} from "../../../shared/types";

async function jsonFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(path, { method: init?.method, headers, body });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export async function getMe(): Promise<{ userId: string }> {
  return jsonFetch("/api/me");
}

export async function listCanvases(userId: string): Promise<Canvas[]> {
  return jsonFetch(`/api/users/${userId}/canvases`);
}

export async function getCanvas(
  userId: string,
  canvasId: string,
): Promise<GetCanvasResponse> {
  return jsonFetch(`/api/users/${userId}/canvases/${canvasId}`);
}

export async function createCanvas(
  userId: string,
  input: CreateCanvasRequest,
): Promise<CreateCanvasResponse> {
  return jsonFetch(`/api/users/${userId}/canvases`, {
    method: "POST",
    body: input,
  });
}

export async function getNode(
  userId: string,
  nodeId: string,
): Promise<GetNodeResponse> {
  return jsonFetch(`/api/users/${userId}/nodes/${nodeId}`);
}

export async function sendMessage(
  userId: string,
  nodeId: string,
  input: SendMessageRequest,
): Promise<SendMessageResponse> {
  return jsonFetch(`/api/users/${userId}/nodes/${nodeId}/messages`, {
    method: "POST",
    body: input,
  });
}

export async function spawn(
  userId: string,
  input: SpawnRequest,
): Promise<SpawnResponse> {
  return jsonFetch(`/api/users/${userId}/spawn`, {
    method: "POST",
    body: input,
  });
}

export async function listProviderConfigs(
  userId: string,
): Promise<ProviderConfigSummary[]> {
  return jsonFetch(`/api/users/${userId}/provider-configs`);
}

export async function setProviderKey(
  userId: string,
  provider: ProviderId,
  apiKey: string,
): Promise<ProviderConfigSummary> {
  return jsonFetch(`/api/users/${userId}/provider-configs/${provider}`, {
    method: "PUT",
    body: { apiKey },
  });
}

export async function deleteProviderKey(
  userId: string,
  provider: ProviderId,
): Promise<void> {
  const res = await fetch(`/api/users/${userId}/provider-configs/${provider}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
}

export async function getPreferences(userId: string): Promise<UserPreferences> {
  return jsonFetch(`/api/users/${userId}/preferences`);
}

export async function setPreferences(
  userId: string,
  prefs: UserPreferences,
): Promise<UserPreferences> {
  return jsonFetch(`/api/users/${userId}/preferences`, {
    method: "PUT",
    body: prefs,
  });
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  return jsonFetch("/api/models");
}

// Open an EventSource for an assistant message. Calls handlers as events arrive.
// Returns a cleanup function the caller should invoke on unmount / cancel.
export function subscribeToMessage(
  messageId: string,
  handlers: {
    onEvent: (event: StreamEvent) => void;
    onClose?: () => void;
  },
): () => void {
  const es = new EventSource(`/api/stream/${messageId}`);

  const eventNames: StreamEvent["type"][] = [
    "message_start",
    "content_delta",
    "message_complete",
    "error",
  ];

  for (const name of eventNames) {
    es.addEventListener(name, (e) => {
      try {
        handlers.onEvent(JSON.parse((e as MessageEvent).data) as StreamEvent);
      } catch {
        /* ignore parse errors */
      }
      if (name === "message_complete" || name === "error") {
        es.close();
        handlers.onClose?.();
      }
    });
  }

  es.onerror = () => {
    es.close();
    handlers.onClose?.();
  };

  return () => es.close();
}

export function messageText(message: Pick<Message, "content">): string {
  return message.content.map((p) => p.text).join("");
}
