import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { CodexAppServerAgentClient } from "../codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
  type FakeCodexHistoryOptions,
  type FakeCodexHistoryThread,
  fakeCodexThreadHistory,
} from "./test-utils/fake-app-server.js";

function userItem(id: string, text: string) {
  return { type: "userMessage", id, content: [{ type: "text", text }] };
}

function agentItem(id: string, text: string) {
  return { type: "agentMessage", id, text };
}

async function openCodexThread(
  thread: FakeCodexHistoryThread,
  options?: FakeCodexHistoryOptions,
): Promise<{ appServer: FakeCodexAppServer; session: AgentSession }> {
  const appServer = createFakeCodexAppServer(
    fakeCodexThreadHistory({ "saved-thread": thread }, options),
  );
  const provider = new CodexAppServerAgentClient(
    createTestLogger(),
    {
      command: { mode: "replace", argv: ["codex-must-not-run-in-this-test"] },
    },
    {
      appServerProcess: {
        resolvePrefix: async () => ({ command: "codex", args: [] }),
        spawn: () => appServer.child,
      },
    },
  );
  const internals = provider as unknown as {
    goalsEnabledPromise: Promise<boolean> | null;
    autoReviewEnabledPromise: Promise<boolean> | null;
  };
  internals.goalsEnabledPromise = Promise.resolve(false);
  internals.autoReviewEnabledPromise = Promise.resolve(false);
  const session = await provider.resumeSession({ sessionId: "saved-thread" });
  return { appServer, session };
}

async function readHistory(session: AgentSession): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of session.streamHistory()) events.push(event);
  return events;
}

function timelineItems(events: AgentStreamEvent[]) {
  return events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
}

function historyRequests(appServer: FakeCodexAppServer) {
  return appServer
    .requests()
    .filter(
      (request) =>
        request.method === "thread/read" ||
        request.method === "thread/turns/list" ||
        request.method === "thread/items/list",
    )
    .map((request) => ({ method: request.method, params: request.params }));
}

describe("Codex thread history", () => {
  test("passes explicit native empty pages through the fixture adapter", async () => {
    let itemPageRequests = 0;
    const appServer = createFakeCodexAppServer({
      "thread/read": () => ({ thread: { historyMode: "paginated", turns: [] } }),
      "thread/turns/list": () => ({ data: [], nextCursor: null }),
      "thread/items/list": () => {
        itemPageRequests++;
        return { data: [], nextCursor: null };
      },
    });
    const provider = new CodexAppServerAgentClient(createTestLogger(), undefined, {
      appServerProcess: {
        resolvePrefix: async () => ({ command: "codex", args: [] }),
        spawn: () => appServer.child,
      },
    });
    const internals = provider as unknown as {
      goalsEnabledPromise: Promise<boolean>;
      autoReviewEnabledPromise: Promise<boolean>;
    };
    internals.goalsEnabledPromise = Promise.resolve(false);
    internals.autoReviewEnabledPromise = Promise.resolve(false);
    const session = await provider.resumeSession({ sessionId: "empty" });
    try {
      expect(timelineItems(await readHistory(session))).toEqual([]);
      expect(itemPageRequests).toBe(1);
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });
  test("loads a paginated thread through pages", async () => {
    const answers = Array.from({ length: 150 }, (_, index) =>
      agentItem(`agent-${index}`, `Answer ${index}`),
    );
    const { appServer, session } = await openCodexThread({
      historyMode: "paginated",
      turns: [
        {
          id: "turn-1",
          startedAt: 1_778_832_941,
          completedAt: 1_778_833_000,
          items: [userItem("user-1", "First"), ...answers.slice(0, 120)],
        },
        {
          id: "turn-2",
          startedAt: 1_778_833_094,
          completedAt: 1_778_833_100,
          items: [userItem("user-2", "Second"), ...answers.slice(120)],
        },
      ],
    });
    try {
      const events = await readHistory(session);

      expect(timelineItems(events)).toEqual([
        { type: "user_message", text: "First", messageId: "user-1" },
        ...answers.slice(0, 120).map((answer) => ({
          type: "assistant_message",
          text: answer.text,
          messageId: answer.id,
        })),
        { type: "user_message", text: "Second", messageId: "user-2" },
        ...answers.slice(120).map((answer) => ({
          type: "assistant_message",
          text: answer.text,
          messageId: answer.id,
        })),
      ]);
      const timestamps = events.flatMap((event) =>
        event.type === "timeline" ? [event.timestamp] : [],
      );
      expect(timestamps[0]).toBe("2026-05-15T08:15:41.000Z");
      expect(timestamps[1]).toBe("2026-05-15T08:16:40.000Z");
      expect(timestamps[121]).toBe("2026-05-15T08:18:14.000Z");
      const requests = historyRequests(appServer);
      expect(requests).not.toContainEqual(
        expect.objectContaining({ params: expect.objectContaining({ includeTurns: true }) }),
      );
      const itemPages = requests.filter((request) => request.method === "thread/items/list");
      expect(itemPages.length).toBeGreaterThan(1);
      for (const page of itemPages) {
        expect(page.params).toMatchObject({ threadId: "saved-thread", sortDirection: "desc" });
        expect((page.params as { limit: number }).limit).toBeLessThanOrEqual(40);
      }
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("loads a paginated thread whose full read Codex 0.145 rejects", async () => {
    const { appServer, session } = await openCodexThread({
      historyMode: "paginated",
      turns: [{ id: "turn-1", items: [userItem("user-1", "Hello"), agentItem("agent-1", "Hi")] }],
    });
    try {
      expect(timelineItems(await readHistory(session))).toEqual([
        { type: "user_message", text: "Hello", messageId: "user-1" },
        { type: "assistant_message", text: "Hi", messageId: "agent-1" },
      ]);
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("retries an oversized page with smaller pages without losing or reordering history", async () => {
    const answers = Array.from({ length: 75 }, (_, index) =>
      agentItem(`agent-${index}`, `Answer ${index}`),
    );
    const { appServer, session } = await openCodexThread(
      {
        historyMode: "paginated",
        turns: [{ id: "turn-1", items: [userItem("user-1", "First"), ...answers] }],
      },
      { maxItemsPerPage: 7 },
    );
    try {
      const items = timelineItems(await readHistory(session));
      expect(items).toEqual([
        { type: "user_message", text: "First", messageId: "user-1" },
        ...answers.map((answer) => ({
          type: "assistant_message",
          text: answer.text,
          messageId: answer.id,
        })),
      ]);
      const sizes = historyRequests(appServer)
        .filter((request) => request.method === "thread/items/list")
        .map((request) => (request.params as { limit: number }).limit);
      expect(sizes.slice(0, 4)).toEqual([40, 20, 10, 5]);
      expect(sizes.length).toBeLessThan(25);
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("an irreducibly oversized newest item returns a visible warning", async () => {
    const { appServer, session } = await openCodexThread(
      {
        historyMode: "paginated",
        turns: [
          { id: "turn-1", items: [userItem("older", "Older"), agentItem("huge", "never sent")] },
        ],
      },
      { oversizedItemIds: ["huge"] },
    );
    try {
      expect(timelineItems(await readHistory(session))).toEqual([
        {
          type: "notification",
          level: "warning",
          message: "The rest of this Codex thread's history is too large to load.",
        },
      ]);
      const sizes = historyRequests(appServer)
        .filter((request) => request.method === "thread/items/list")
        .map((request) => (request.params as { limit: number }).limit);
      expect(sizes).toEqual([40, 20, 10, 5, 2, 1]);
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("a page too big to send retries smaller pages, then warns at the item that cannot fit", async () => {
    const answers = Array.from({ length: 120 }, (_, index) =>
      agentItem(`agent-${index}`, `Answer ${index}`),
    );
    const { appServer, session } = await openCodexThread(
      {
        historyMode: "paginated",
        turns: [
          {
            id: "turn-1",
            items: [agentItem("huge", "never sent"), userItem("user-1", "One"), ...answers],
          },
          { id: "turn-2", items: [userItem("user-2", "Two")] },
        ],
      },
      { oversizedItemIds: ["huge"] },
    );
    const loaded = [
      {
        type: "notification",
        level: "warning",
        message: "The rest of this Codex thread's history is too large to load.",
      },
      { type: "user_message", text: "One", messageId: "user-1" },
      ...answers.map((answer) => ({
        type: "assistant_message",
        text: answer.text,
        messageId: answer.id,
      })),
      { type: "user_message", text: "Two", messageId: "user-2" },
    ];
    try {
      expect(timelineItems(await readHistory(session))).toEqual(loaded);
      // Each oversized page retries the same cursor at half the size until it fits.
      expect(
        historyRequests(appServer)
          .filter((request) => request.method === "thread/items/list")
          .map((request) => (request.params as { limit: number }).limit),
      ).toEqual([40, 40, 40, 40, 20, 10, 5, 2, 2, 1]);
      // The oversized reply failed only its own request; a fresh resume recovers the same page.
      const reopened = await openCodexThread(
        {
          historyMode: "paginated",
          turns: [
            {
              id: "turn-1",
              items: [agentItem("huge", "never sent"), userItem("user-1", "One"), ...answers],
            },
            { id: "turn-2", items: [userItem("user-2", "Two")] },
          ],
        },
        { oversizedItemIds: ["huge"] },
      );
      try {
        expect(timelineItems(await readHistory(reopened.session))).toEqual(loaded);
      } finally {
        await reopened.session.close();
      }
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("loads a legacy thread that fits in one read", async () => {
    const { appServer, session } = await openCodexThread({
      historyMode: "legacy",
      turns: [{ id: "turn-1", items: [userItem("user-1", "Hello"), agentItem("agent-1", "Hi")] }],
    });
    try {
      expect(timelineItems(await readHistory(session))).toEqual([
        { type: "user_message", text: "Hello", messageId: "user-1" },
        { type: "assistant_message", text: "Hi", messageId: "agent-1" },
      ]);
      expect(historyRequests(appServer).map((request) => request.method)).not.toContain(
        "thread/items/list",
      );
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });

  test("a legacy thread too big for one read shows the migration command", async () => {
    const { appServer, session } = await openCodexThread(
      {
        historyMode: "legacy",
        turns: [{ id: "turn-1", items: [userItem("user-1", "Hello"), agentItem("huge", "x")] }],
      },
      { oversizedItemIds: ["huge"] },
    );
    const migrationRow = {
      type: "notification",
      level: "warning",
      message: expect.stringContaining("codex migrate-rollouts --apply --thread saved-thread"),
    };
    try {
      expect(timelineItems(await readHistory(session))).toEqual([migrationRow]);
      // A fresh resume returns the same migration guidance.
      const reopened = await openCodexThread(
        {
          historyMode: "legacy",
          turns: [{ id: "turn-1", items: [userItem("user-1", "Hello"), agentItem("huge", "x")] }],
        },
        { oversizedItemIds: ["huge"] },
      );
      try {
        expect(timelineItems(await readHistory(reopened.session))).toEqual([migrationRow]);
      } finally {
        await reopened.session.close();
      }
    } finally {
      await session.close();
    }
    appServer.assertNoErrors();
  });
});
