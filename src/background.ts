type ProxyResponsePayload = {
  ok: boolean;
  status: number;
  statusText: string;
  body?: string;
  headers?: Record<string, string>;
  error?: string;
};
type ProxyRequestMessage = {
  type: "rbdb:proxyRequest";
  payload: {
    url: string;
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | null;
    };
  };
};

type RuntimeLike = {
  onMessage: {
    addListener(
      callback: (
        message: unknown,
        sender: unknown,
        sendResponse: (payload: ProxyResponsePayload) => void,
      ) => void | boolean,
    ): void;
  };
};

function getRuntime(): RuntimeLike {
  const anyGlobal = globalThis as typeof globalThis & {
    browser?: { runtime?: RuntimeLike };
    chrome?: { runtime?: RuntimeLike };
  };
  if (anyGlobal.browser?.runtime?.onMessage) {
    return anyGlobal.browser.runtime;
  }
  if (anyGlobal.chrome?.runtime?.onMessage) {
    return anyGlobal.chrome.runtime;
  }
  throw new Error("Extension runtime unavailable");
}

getRuntime().onMessage.addListener((message: unknown, _sender: unknown, sendResponse) => {
  const payload = message as ProxyRequestMessage;
  if (payload?.type !== "rbdb:proxyRequest") {
    return false;
  }

  (async () => {
    try {
      const init: RequestInit = {
        method: payload.payload.init?.method ?? "GET",
        headers: payload.payload.init?.headers,
        body: payload.payload.init?.body ?? undefined,
        credentials: "omit",
        cache: "no-cache",
      };
      const response = await fetch(payload.payload.url, init);
      const text = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      sendResponse({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: text,
        headers,
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unexpected error";
      sendResponse({
        ok: false,
        status: 0,
        statusText: "NETWORK_ERROR",
        error: messageText,
      });
    }
  })();

  return true;
});
