const API_BASE_URL = "";

export const authQueryKey = ["auth", "me"] as const;

export type AuthUser = {
  id: number;
  username: string;
};

export type AuthResponse = {
  user: AuthUser | null;
};

export type LoginResponse = {
  user: AuthUser;
};

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type ApiRequestInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | undefined;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { body, headers, ...rest } = init;

  const requestHeaders = new Headers(headers);
  let requestBody: BodyInit | undefined;

  if (body !== undefined) {
    if (isBodyInit(body)) {
      requestBody = body;
    } else if (isPlainObject(body)) {
      requestHeaders.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    } else {
      requestBody = String(body);
    }
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    body: requestBody,
    credentials: "include",
    headers: requestHeaders,
  });

  const responseBody = await readResponseBody(response);
  if (!response.ok) {
    const message =
      isPlainObject(responseBody) && typeof responseBody.error === "string"
        ? responseBody.error
        : response.statusText || "Request failed";
    throw new ApiError(message, response.status, responseBody);
  }

  return responseBody as T;
}

export function fetchCurrentUser() {
  return apiFetch<AuthResponse>("/api/auth/me");
}

export function login(username: string, password: string) {
  return apiFetch<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: { username, password },
  });
}
