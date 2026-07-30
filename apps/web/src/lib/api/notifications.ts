/**
 * Notification-channel endpoints (N channels per type: several Slack/Teams
 * webhooks, each its own row) + the send-a-test-message call.
 */
import { getBearerToken } from "../firebase-lazy";
import { BASE, getActiveEnvironment, getActiveWorkspace, http } from "./http";
import type { NotificationChannel, NotificationChannelType } from "./types";

export const notificationsApi = {
  // --- Notifications (N channels per type: several Slack/Teams webhooks, each its own row) ---
  listNotificationChannels(tenantId: string): Promise<NotificationChannel[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/notifications`);
  },
  // Add a new channel of the given type (a workspace can have several per type).
  createNotificationChannel(
    tenantId: string,
    body: { type: NotificationChannelType } & Partial<
      Omit<NotificationChannel, "id" | "type">
    >,
  ): Promise<NotificationChannel> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/notifications`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  // Patch ONE channel (by id); other channels are untouched.
  saveNotificationChannel(
    tenantId: string,
    channelId: string,
    patch: Partial<Omit<NotificationChannel, "id" | "type">>,
  ): Promise<NotificationChannel> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/notifications/${encodeURIComponent(channelId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  },
  // Delete ONE channel (by id; idempotent).
  deleteNotificationChannel(
    tenantId: string,
    channelId: string,
  ): Promise<{ ok: boolean }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/notifications/${encodeURIComponent(channelId)}`,
      { method: "DELETE" },
    );
  },
  // Send a test message to ONE channel's webhook. Returns a result (not a throw) so the
  // UI can show the server's specific failure reason (bad URL, non-2xx, unreachable).
  async testNotificationChannel(
    tenantId: string,
    channelId: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const token = await getBearerToken();
    const activeWorkspaceId = getActiveWorkspace();
    const activeEnvironmentId = getActiveEnvironment();
    const res = await fetch(
      `${BASE}/tenants/${encodeURIComponent(tenantId)}/notifications/${encodeURIComponent(channelId)}/test`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
          ...(activeEnvironmentId
            ? { "x-environment-id": activeEnvironmentId }
            : {}),
        },
      },
    );
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    return {
      ok: false,
      message: body?.message ?? `Request failed (${res.status}).`,
    };
  },
};
