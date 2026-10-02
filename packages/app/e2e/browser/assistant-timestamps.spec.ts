import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

for (const width of [1100, 390]) {
  test(`assistant timestamps preserve Markdown and original message content at width ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "assistant-timestamps-",
      title: "Assistant timestamps",
      featureValues: { mockAssistantResponse: "```ts\nconst value = 1;\n```\n\nSecond paragraph." },
    });
    try {
      await openAgentRoute(page, agent);
      await agent.client.sendAgentMessage(agent.agentId, "Show a code example");
      await agent.client.waitForFinish(agent.agentId, 15_000);
      const verify = async () => {
        await expect(page.getByTestId("assistant-timestamp")).toHaveCount(1);
        await expect(page.getByTestId("assistant-timestamp")).toContainText("UTC:");
        await expect(page.getByTestId("assistant-message")).toHaveCount(2);
        await expect(page.getByTestId("assistant-message").first()).toContainText(
          "const value = 1;",
        );
        await expect(page.getByTestId("assistant-message").last()).toHaveText("Second paragraph.");
        await expect(page.getByTestId("assistant-message").first()).not.toContainText("UTC:");
      };
      await verify();
      await page.reload({ waitUntil: "domcontentloaded" });
      await verify();
      await page.screenshot({ path: testInfo.outputPath("assistant-timestamps.png") });
    } finally {
      await agent.cleanup();
    }
  });
}
