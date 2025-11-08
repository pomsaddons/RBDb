/**
 * RBDb rating widget content script.
 */

type RatingDistributionEntry = {
  stars: number;
  count: number;
};

type RatingUserEntry = {
  rating: number;
  username: string | null;
  updatedAt: string;
};

type RatingSummary = {
  universeId: string;
  averageRating: number;
  totalRatings: number;
  distribution: RatingDistributionEntry[];
  userRating: RatingUserEntry | null;
};

type AuthenticatedUser = {
  userId: number;
  username: string;
  displayName: string;
};

type WidgetState = {
  summary: RatingSummary | null;
  hovered: number | null;
  status: "idle" | "loading" | "submitting" | "error";
  errorMessage: string | null;
};

const RBDB_WIDGET_ID = "rbdb-rating-card";
const DEFAULT_BACKEND_BASE = "http://localhost:4000";
const logPrefix = "[RBDb]";

type ProxyResponseMessage = {
  ok: boolean;
  status: number;
  statusText: string;
  body?: string;
  error?: string;
};

type ExtensionRuntime = {
  sendMessage(message: unknown): Promise<unknown>;
};

type RGBAColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

function getExtensionRuntime(): ExtensionRuntime | null {
  const anyGlobal = globalThis as typeof globalThis & {
    browser?: { runtime?: { sendMessage(message: unknown): Promise<unknown> } };
    chrome?: {
      runtime?: {
        sendMessage(
          message: unknown,
          responseCallback?: (response: unknown) => void,
        ): void;
        lastError?: { message?: string };
      };
    };
  };

  if (anyGlobal.browser?.runtime?.sendMessage) {
    return {
      sendMessage: (message: unknown) => anyGlobal.browser!.runtime!.sendMessage(message),
    };
  }

  if (anyGlobal.chrome?.runtime?.sendMessage) {
    return {
      sendMessage: (message: unknown) =>
        new Promise((resolve, reject) => {
          anyGlobal.chrome!.runtime!.sendMessage(message, (response: unknown) => {
            const errorMessage = anyGlobal.chrome?.runtime?.lastError?.message;
            if (errorMessage) {
              reject(new Error(errorMessage));
              return;
            }
            resolve(response);
          });
        }),
    };
  }

  return null;
}

async function sendProxyRequest(
  message: unknown,
  runtimeOverride?: ExtensionRuntime | null,
): Promise<ProxyResponseMessage> {
  const runtime = runtimeOverride ?? getExtensionRuntime();
  if (!runtime) {
    throw new Error("Extension messaging runtime is unavailable.");
  }
  const rawResponse = await runtime.sendMessage(message);
  const response = rawResponse as ProxyResponseMessage | undefined;
  if (!response) {
    throw new Error("No response from extension background worker.");
  }
  return response;
}

type BackendRequestOptions = {
  method?: string;
  searchParams?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
};

async function backendRequest<T>(
  pathname: string,
  backendBase: string,
  options: BackendRequestOptions = {},
): Promise<T> {
  const url = new URL(buildUrl(pathname, backendBase));
  if (options.searchParams) {
    for (const [key, value] of Object.entries(options.searchParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }
  }

  const method = options.method ?? (options.body ? "POST" : "GET");
  const headers: Record<string, string> = { ...(options.headers ?? {}) };

  let bodyString: string | undefined;
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === "string") {
      bodyString = options.body;
    } else {
      bodyString = JSON.stringify(options.body);
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
  }

  const runtime = getExtensionRuntime();
  if (runtime) {
    const response = await sendProxyRequest(
      {
        type: "rbdb:proxyRequest",
        payload: {
          url: url.toString(),
          init: {
            method,
            headers: Object.keys(headers).length ? headers : undefined,
            body: bodyString ?? null,
          },
        },
      },
      runtime,
    );

    if (!response.ok) {
      throw new Error(response.error ?? response.body ?? `Request failed with status ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Backend returned an empty response.");
    }

    return JSON.parse(response.body) as T;
  }

  const fetchResponse = await fetch(url.toString(), {
    method,
    headers,
    body: bodyString,
    mode: "cors",
    cache: "no-cache",
  });
  if (!fetchResponse.ok) {
    const text = await fetchResponse.text();
    throw new Error(text || `Request failed with status ${fetchResponse.status}`);
  }

  return (await fetchResponse.json()) as T;
}

function parseCssColor(input: string | null | undefined): RGBAColor | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;

  if (value === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 3) {
      const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
      const a = parts[3] !== undefined ? Number.parseFloat(parts[3]) : 1;
      if ([r, g, b, a].every((component) => Number.isFinite(component))) {
        return { r, g, b, a };
      }
    }
  }

  return null;
}

function rgbaToString(color: RGBAColor, alphaOverride?: number): string {
  const alpha = alphaOverride ?? color.a;
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Math.min(Math.max(alpha, 0), 1)})`;
}

function withAlpha(color: RGBAColor | null, alpha: number, fallback: string): string {
  if (!color) return fallback;
  return rgbaToString(color, alpha);
}

function pickColor(candidate: string | null | undefined, fallback: string): string {
  if (!candidate) return fallback;
  const value = candidate.trim();
  if (!value || value === "transparent" || value === "inherit" || value === "initial") {
    return fallback;
  }
  if (value.startsWith("rgba(0, 0, 0, 0")) {
    return fallback;
  }
  return value;
}

function relativeLuminance(color: RGBAColor | null): number {
  if (!color) return 0;
  const toLinear = (c: number) => {
    const ch = c / 255;
    return ch <= 0.03928 ? ch / 12.92 : Math.pow((ch + 0.055) / 1.055, 2.4);
  };
  const r = toLinear(color.r);
  const g = toLinear(color.g);
  const b = toLinear(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function bestTextColor(background: RGBAColor | null): string {
  if (!background) return "#141414";
  const L = relativeLuminance(background);
  // Simple threshold for contrast; tweakable
  return L > 0.55 ? "#141414" : "#f2f4f5";
}

function applyThemeFromPage(source: HTMLElement, container: HTMLElement) {
  const baseStyles = window.getComputedStyle(source);
  // Try also body as fallback for a more global background
  const bodyStyles = window.getComputedStyle(document.body);
  const backgroundRaw = pickColor(baseStyles.backgroundColor, pickColor(bodyStyles.backgroundColor, "#ffffff"));
  const backgroundRgba = parseCssColor(backgroundRaw) ?? { r: 255, g: 255, b: 255, a: 1 };

  const textRaw = pickColor(baseStyles.color, pickColor(bodyStyles.color, "#141414"));
  const textRgba = parseCssColor(textRaw);
  // Recompute text based on contrast vs actual background
  const computedText = bestTextColor(backgroundRgba);
  const finalText = textRgba ? bestTextColor(backgroundRgba) : computedText;
  const finalTextRgba = parseCssColor(finalText) ?? { r: 20, g: 20, b: 20, a: 1 };

  const borderColor = withAlpha(finalTextRgba, 0.14, "rgba(0,0,0,0.14)");
  const subtleColor = withAlpha(finalTextRgba, 0.55, "rgba(0,0,0,0.55)");

  const accentCandidate = document.querySelector<HTMLElement>(
    ".btn-control-lg, .btn-control-md, .btn-primary-lg, .btn-primary-md, .btn-primary, .game-play-button, .btn-growth-lg, .play-button, #game-details-play-button button",
  );
  const accentStyles = accentCandidate ? window.getComputedStyle(accentCandidate) : null;
  let accentColor = pickColor(accentStyles?.backgroundColor ?? accentStyles?.color, "#00b06f");
  // Ensure accent has sufficient contrast; if not, fallback
  const accentRgba = parseCssColor(accentColor);
  if (accentRgba) {
    const contrast = (() => {
      const L1 = relativeLuminance(accentRgba) + 0.05;
      const L2 = relativeLuminance(backgroundRgba) + 0.05;
      return L1 > L2 ? L1 / L2 : L2 / L1;
    })();
    if (contrast < 2) {
      accentColor = "#00b06f"; // fallback brand-like green
    }
  }

  container.style.setProperty("--rbdb-card-bg", rgbaToString(backgroundRgba));
  container.style.setProperty("--rbdb-text", finalText);
  container.style.setProperty("--rbdb-card-border", borderColor);
  container.style.setProperty("--rbdb-subtle", subtleColor);
  container.style.setProperty("--rbdb-accent", accentColor);
  container.style.setProperty("--rbdb-card-shadow", "0 8px 20px rgba(0,0,0,0.08)");
}

function resolveBackendBase(): string {
  try {
    const globalBase = (globalThis as { RBDB_BACKEND_URL?: unknown }).RBDB_BACKEND_URL;
    if (typeof globalBase === "string" && globalBase.trim().length > 0) {
      return normalizeBase(globalBase);
    }
  } catch {
    // ignore
  }

  const meta = document.querySelector<HTMLMetaElement>("meta[name=\"rbdb-backend\"]");
  if (meta?.content) {
    return normalizeBase(meta.content);
  }

  return normalizeBase(DEFAULT_BACKEND_BASE);
}

function normalizeBase(base: string): string {
  const trimmed = base.trim().replace(/\s+/g, "");
  if (!trimmed) {
    return DEFAULT_BACKEND_BASE;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildUrl(pathname: string, base: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

function waitForElement<T extends Element>(selector: string, timeoutMs = 15_000): Promise<T | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector<T>(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const timer = timeoutMs
      ? window.setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeoutMs)
      : undefined;

    const observer = new MutationObserver(() => {
      const found = document.querySelector<T>(selector);
      if (found) {
        if (timer) window.clearTimeout(timer);
        observer.disconnect();
        resolve(found);
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

function getUniverseId(): number | null {
  const metaElement = document.querySelector<HTMLElement>("#game-detail-meta-data");
  if (!metaElement) return null;
  const dataset = metaElement.dataset;
  if (!dataset.universeId) return null;
  const parsed = Number.parseInt(dataset.universeId, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAuthenticatedUser(): AuthenticatedUser | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="user-data"]');
  if (!meta) return null;
  const data = meta.dataset;
  if (!data.userid || !data.name) return null;
  const userId = Number.parseInt(data.userid, 10);
  if (!Number.isFinite(userId)) return null;
  return {
    userId,
    username: data.name,
    displayName: data.displayname ?? data.name,
  };
}

function ensureDistribution(summary: RatingSummary): RatingDistributionEntry[] {
  const result: RatingDistributionEntry[] = [];
  const distributionMap = new Map<number, number>();
  for (const entry of summary.distribution) {
    distributionMap.set(entry.stars, entry.count);
  }
  for (let stars = 1; stars <= 5; stars += 1) {
    result.push({ stars, count: distributionMap.get(stars) ?? 0 });
  }
  return result.reverse();
}

function formatAverage(summary: RatingSummary | null): string {
  if (!summary || summary.totalRatings === 0) return "--";
  return summary.averageRating.toFixed(2);
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function createWidgetContainer(): {
  root: HTMLElement;
  eyebrow: HTMLElement;
  title: HTMLElement;
  scoreValue: HTMLElement;
  scoreCaption: HTMLElement;
  stars: HTMLButtonElement[];
  hint: HTMLElement;
  distributionWrapper: HTMLElement;
  distributionRows: HTMLElement[];
  distributionEmpty: HTMLElement;
  details: HTMLElement;
  toggleButton: HTMLButtonElement;
  status: HTMLElement;
  error: HTMLElement;
  clearButton: HTMLButtonElement;
  retryButton: HTMLButtonElement;
} {
  const root = createElement("section", "rbdb-card");
  root.id = RBDB_WIDGET_ID;
  root.setAttribute("aria-live", "polite");

  const header = createElement("header", "rbdb-card__header");
  const top = createElement("div", "rbdb-card__top");
  const headerLeft = createElement("div", "rbdb-card__titlewrap");
  const eyebrow = createElement("div", "rbdb-card__eyebrow");
  eyebrow.textContent = "RBDb community";
  const title = createElement("h3", "rbdb-card__title");
  title.textContent = "How do you like this experience?";
  headerLeft.append(eyebrow, title);

  const score = createElement("div", "rbdb-card__score");
  const scoreValue = createElement("span", "rbdb-card__score-value");
  scoreValue.textContent = "--";
  const scoreCaption = createElement("span", "rbdb-card__score-caption");
  scoreCaption.textContent = "No ratings yet";
  score.append(scoreValue, scoreCaption);

  const toggleButton = createElement("button", "rbdb-card__toggle") as HTMLButtonElement;
  toggleButton.type = "button";
  toggleButton.setAttribute("aria-expanded", "false");
  toggleButton.title = "Show details";
  toggleButton.textContent = "Details ▸";

  const starsWrapper = createElement("div", "rbdb-card__stars");
  const stars: HTMLButtonElement[] = [];
  for (let value = 1; value <= 5; value += 1) {
    const button = createElement("button", "rbdb-card__star") as HTMLButtonElement;
    button.type = "button";
    button.dataset.value = `${value}`;
    button.setAttribute("aria-label", `${value} star${value > 1 ? "s" : ""}`);
    button.textContent = `${value}★`;
    stars.push(button);
    starsWrapper.append(button);
  }

  top.append(headerLeft, starsWrapper, score, toggleButton);
  header.append(top);

  const hint = createElement("p", "rbdb-card__hint");
  hint.textContent = "Sign in to Roblox to share your rating.";

  const distributionWrapper = createElement("div", "rbdb-card__distribution");
  const distributionRows: HTMLElement[] = [];
  for (let value = 5; value >= 1; value -= 1) {
    const row = createElement("div", "rbdb-card__distribution-row");
    const label = createElement("div");
    label.textContent = `${value}★`;
    const bar = createElement("div", "rbdb-card__distribution-bar");
    const barFill = createElement("span", "rbdb-card__distribution-bar-fill");
    barFill.style.width = "0%";
    bar.append(barFill);
    const count = createElement("div", "rbdb-card__distribution-count");
    count.textContent = "0";
    row.append(label, bar, count);
    distributionRows.push(row);
    distributionWrapper.append(row);
  }

  const distributionEmpty = createElement("p", "rbdb-card__distribution-empty");
  distributionEmpty.textContent = "No ratings yet. Be the first to vote!";
  distributionWrapper.append(distributionEmpty);

  const actions = createElement("div", "rbdb-card__actions");
  const clearButton = createElement("button", "rbdb-card__clear") as HTMLButtonElement;
  clearButton.type = "button";
  clearButton.textContent = "Remove my rating";
  clearButton.hidden = true;

  const retryButton = createElement("button", "rbdb-card__retry") as HTMLButtonElement;
  retryButton.type = "button";
  retryButton.textContent = "Try again";
  retryButton.hidden = true;
  actions.append(clearButton, retryButton);

  const status = createElement("p", "rbdb-card__status");
  status.textContent = "Loading ratings…";
  const error = createElement("p", "rbdb-card__error");
  error.hidden = true;

  const details = createElement("div", "rbdb-card__details");
  details.append(distributionWrapper, actions);
  details.hidden = true;

  root.append(header, hint, details, status, error);

  return {
    root,
    eyebrow,
    title,
    scoreValue,
    scoreCaption,
    stars,
    hint,
    distributionWrapper,
    distributionRows,
    distributionEmpty,
    details,
    toggleButton,
    status,
    error,
    clearButton,
    retryButton,
  };
}

async function requestSummary(
  universeId: number,
  user: AuthenticatedUser | null,
  backendBase: string,
): Promise<RatingSummary> {
  return backendRequest<RatingSummary>(
    `/api/games/${universeId}/ratings`,
    backendBase,
    user
      ? {
          method: "GET",
          searchParams: { userId: `${user.userId}` },
        }
      : { method: "GET" },
  );
}

async function submitRating(
  universeId: number,
  user: AuthenticatedUser,
  rating: number,
  backendBase: string,
): Promise<RatingSummary> {
  return backendRequest<RatingSummary>(`/api/games/${universeId}/ratings`, backendBase, {
    method: "POST",
    body: { userId: user.userId, rating, username: user.username },
  });
}

async function removeRating(
  universeId: number,
  user: AuthenticatedUser,
  backendBase: string,
): Promise<RatingSummary> {
  return backendRequest<RatingSummary>(
    `/api/games/${universeId}/ratings/${user.userId}`,
    backendBase,
    {
      method: "DELETE",
    },
  );
}

function injectWidget(target: Element, universeId: number, backendBase: string) {
  if (document.getElementById(RBDB_WIDGET_ID)) {
    return;
  }

  const user = getAuthenticatedUser();
  const state: WidgetState = {
    summary: null,
    hovered: null,
    status: "loading",
    errorMessage: null,
  };

  const elements = createWidgetContainer();
  // Position to the right of Roblox main content column when wide enough.
  const placeRightOfContent = () => {
    const vw = window.innerWidth;
    const minInlineWidth = 1024; // below this, keep inline in flow

    // Candidate anchors for the main content area
    const contentAnchor =
      document.querySelector<HTMLElement>("#content.content") ||
      document.getElementById("content") ||
      document.querySelector<HTMLElement>(".page-content, .game-main-content, .btr-game-main-container") ||
      (target.closest<HTMLElement>("#game-detail-page, .page-content, .content") ?? undefined);

    if (!contentAnchor || vw < minInlineWidth) {
      // Fall back near the vote section for small screens or if we can't find anchors
      if (elements.root.parentElement !== target.parentElement) {
        target.insertAdjacentElement("afterend", elements.root);
      }
      elements.root.classList.remove("rbdb-card--right");
      elements.root.classList.remove("rbdb-card--left");
      elements.root.style.left = "";
      elements.root.style.top = "";
      elements.root.style.width = "";
      return;
    }

    // Attach to body so we can position independently from page flow
    if (!elements.root.isConnected || elements.root.parentElement !== document.body) {
      document.body.appendChild(elements.root);
    }

    // Compute desired position to the right of the main content
    const rect = contentAnchor.getBoundingClientRect();
    const gap = 16; // px between content and card
    const headerSafeTop = 88; // keep below Roblox fixed header
    const cardWidth = Math.min(380, Math.max(300, Math.floor(vw * 0.22))); // responsive width

    const left = Math.min(rect.right + gap, vw - cardWidth - gap);
    const top = Math.max(headerSafeTop, Math.round(rect.top));

    elements.root.classList.remove("rbdb-card--left");
    elements.root.classList.add("rbdb-card--right");
    elements.root.style.width = `${cardWidth}px`;
    elements.root.style.left = `${left}px`;
    elements.root.style.top = `${top}px`;
  };

  // Adaptive scale based on viewport width & device pixel ratio.
  const updateScale = () => {
    // Base on visual viewport if available (captures pinch zoom & browser zoom better)
    const vp = (window.visualViewport ?? { width: window.innerWidth }).width;
    const dpr = window.devicePixelRatio || 1;
    // Derive a scale where narrower viewports shrink content slightly and very wide allow slight growth.
    // Also invert a portion of DPR so high zoom (lower effective layout width) reduces scale gracefully.
    const widthFactor = vp / 1400; // 1400px chosen as comfortable baseline
    let scale = widthFactor * (1.05 / Math.min(dpr, 2));
    // Clamp to avoid extremes
    scale = Math.max(0.75, Math.min(scale, 1.15));
    elements.root.style.setProperty("--rbdb-scale", scale.toFixed(3));
  };

  // Initial mount near target; then reposition
  target.insertAdjacentElement("afterend", elements.root);
  placeRightOfContent();
  updateScale();
  window.addEventListener("resize", placeRightOfContent);
  window.addEventListener("scroll", placeRightOfContent, { passive: true });
  window.addEventListener("resize", updateScale);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateScale);
    window.visualViewport.addEventListener("scroll", updateScale); // pinch zoom on mobile can trigger scroll in visualViewport
  }
  let expanded = false;

  function updateExpandedUI() {
    elements.root.dataset.expanded = expanded ? "true" : "false";
    elements.details.hidden = !expanded;
    elements.toggleButton.setAttribute("aria-expanded", expanded ? "true" : "false");
    elements.toggleButton.textContent = expanded ? "Details ▾" : "Details ▸";
  }
  updateExpandedUI();
  elements.toggleButton.addEventListener("click", () => {
    expanded = !expanded;
    updateExpandedUI();
  });

  const themeSource =
    target.closest<HTMLElement>(".game-details-page, .game-layout, .game-info, .game-details") ??
    (target.parentElement as HTMLElement | null) ??
    (target as HTMLElement);
  if (themeSource) {
    applyThemeFromPage(themeSource, elements.root);
    const themeObserver = new MutationObserver(() => {
      applyThemeFromPage(themeSource, elements.root);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    const parentNode = elements.root.parentElement ?? elements.root.parentNode;
    if (parentNode instanceof Element || parentNode === document.body) {
      const removalObserver = new MutationObserver(() => {
        if (!elements.root.isConnected) {
          themeObserver.disconnect();
          removalObserver.disconnect();
        }
      });
      removalObserver.observe(parentNode, { childList: true });
    }
  }

  function setStatus(status: WidgetState["status"], message?: string) {
    state.status = status;
    if (status === "loading") {
      elements.status.hidden = false;
      elements.status.textContent = message ?? "Loading ratings…";
    } else if (status === "submitting") {
      elements.status.hidden = false;
      elements.status.textContent = message ?? "Saving your rating…";
    } else if (status === "error") {
      elements.status.hidden = false;
      elements.status.textContent = "";
    } else {
      elements.status.hidden = true;
    }
  }

  function setError(message: string | null) {
    state.errorMessage = message;
    if (message) {
      elements.error.hidden = false;
      elements.error.textContent = message;
      elements.retryButton.hidden = false;
    } else {
      elements.error.hidden = true;
      elements.error.textContent = "";
      elements.retryButton.hidden = true;
    }
  }

  function updateScore() {
    elements.scoreValue.textContent = formatAverage(state.summary);
    const total = state.summary?.totalRatings ?? 0;
    elements.scoreCaption.textContent = total === 1 ? "1 rating" : `${total} ratings`;
    // Add data attribute to control star display via CSS
    if (total > 0) {
      elements.scoreValue.dataset.hasRating = "true";
    } else {
      delete elements.scoreValue.dataset.hasRating;
    }
  }

  function updateDistribution() {
    if (!state.summary || state.summary.totalRatings === 0) {
      elements.distributionEmpty.hidden = false;
      for (const row of elements.distributionRows) {
        row.hidden = false;
        const barFill = row.querySelector<HTMLElement>(".rbdb-card__distribution-bar-fill");
        if (barFill) barFill.style.width = "0%";
        const count = row.querySelector<HTMLElement>(".rbdb-card__distribution-count");
        if (count) count.textContent = "0";
      }
      return;
    }

    elements.distributionEmpty.hidden = true;
    const distribution = ensureDistribution(state.summary);
    const total = state.summary.totalRatings;
    elements.distributionRows.forEach((row, index) => {
      const entry = distribution[index];
      const percentage = total === 0 ? 0 : Math.round((entry.count / total) * 100);
      const barFill = row.querySelector<HTMLElement>(".rbdb-card__distribution-bar-fill");
      if (barFill) barFill.style.width = `${percentage}%`;
      const count = row.querySelector<HTMLElement>(".rbdb-card__distribution-count");
      if (count) count.textContent = `${entry.count}`;
    });
  }

  function updateStars() {
    const activeValue = state.hovered ?? state.summary?.userRating?.rating ?? 0;
    elements.stars.forEach((button) => {
      const value = Number.parseInt(button.dataset.value ?? "0", 10);
      const isActive = Number.isFinite(value) && value <= activeValue;
      button.dataset.active = isActive ? "true" : "false";
      button.setAttribute("aria-pressed", state.summary?.userRating?.rating === value ? "true" : "false");
      button.disabled = state.status === "submitting";
    });
  }

  function updateControls() {
    elements.hint.hidden = user !== null;
    elements.clearButton.hidden = !state.summary?.userRating || !user;
    elements.clearButton.disabled = state.status === "submitting";
  }

  function render() {
    updateScore();
    updateDistribution();
    updateStars();
    updateControls();
  }

  async function refresh() {
    setError(null);
    setStatus("loading");
    try {
      state.summary = await requestSummary(universeId, user, backendBase);
      setStatus("idle");
      render();
    } catch (error) {
      console.warn(logPrefix, "Failed to load ratings", error);
      setStatus("error");
      setError(error instanceof Error ? error.message : "Unable to load ratings.");
    }
  }

  async function handleRate(value: number) {
    if (!user) {
      setError("Sign in to Roblox to rate experiences.");
      return;
    }
    setError(null);
    setStatus("submitting");
    try {
      state.summary = await submitRating(universeId, user, value, backendBase);
      setStatus("idle");
      state.hovered = null;
      render();
    } catch (error) {
      console.warn(logPrefix, "Failed to submit rating", error);
      setStatus("error");
      setError(error instanceof Error ? error.message : "Unable to save rating.");
    }
  }

  async function handleClear() {
    if (!user) return;
    setError(null);
    setStatus("submitting", "Removing your rating…");
    try {
      state.summary = await removeRating(universeId, user, backendBase);
      setStatus("idle");
      render();
    } catch (error) {
      console.warn(logPrefix, "Failed to remove rating", error);
      setStatus("error");
      setError(error instanceof Error ? error.message : "Unable to remove rating.");
    }
  }

  elements.stars.forEach((button) => {
    const value = Number.parseInt(button.dataset.value ?? "0", 10);
    button.addEventListener("mouseenter", () => {
      if (state.status === "submitting") return;
      state.hovered = value;
      updateStars();
    });
    button.addEventListener("mouseleave", () => {
      if (state.status === "submitting") return;
      state.hovered = null;
      updateStars();
    });
    button.addEventListener("focus", () => {
      if (state.status === "submitting") return;
      state.hovered = value;
      updateStars();
    });
    button.addEventListener("blur", () => {
      if (state.status === "submitting") return;
      state.hovered = null;
      updateStars();
    });
    button.addEventListener("click", () => {
      if (!Number.isFinite(value)) return;
      void handleRate(value);
    });
  });

  elements.clearButton.addEventListener("click", () => {
    void handleClear();
  });

  elements.retryButton.addEventListener("click", () => {
    void refresh();
  });

  void refresh();
}

async function bootstrap() {
  const backendBase = resolveBackendBase();
  const universeId = getUniverseId();
  if (!universeId) {
    console.debug(logPrefix, "Universe ID not found – skipping RBDb widget");
    return;
  }

  const voteSection = await waitForElement<HTMLElement>(".users-vote", 20_000);
  if (!voteSection) {
    console.debug(logPrefix, "Vote section not found – skipping RBDb widget");
    return;
  }

  injectWidget(voteSection, universeId, backendBase);
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  void bootstrap();
} else {
  window.addEventListener("DOMContentLoaded", () => {
    void bootstrap();
  });
}
