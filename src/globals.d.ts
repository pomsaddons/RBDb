declare const browser:
  | {
      runtime?: {
        sendMessage(message: unknown): Promise<unknown>;
        onMessage?: {
          addListener(
            callback: (
              message: unknown,
              sender: unknown,
              sendResponse: (response: unknown) => void,
            ) => void | boolean,
          ): void;
        };
        lastError?: { message?: string };
      };
    }
  | undefined;

declare const chrome:
  | {
      runtime?: {
        sendMessage(
          message: unknown,
          responseCallback?: (response: unknown) => void,
        ): void;
        lastError?: { message?: string };
        onMessage?: {
          addListener(
            callback: (
              message: unknown,
              sender: unknown,
              sendResponse: (response: unknown) => void,
            ) => void | boolean,
          ): void;
        };
      };
    }
  | undefined;
