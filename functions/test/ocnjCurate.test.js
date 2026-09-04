"use strict";

// Exercises lib/ocnjCurate.js against a stubbed Anthropic call (callImpl)
// -- no live call to the Anthropic API, same injectable-impl convention as
// imagen.js's generateImpl (see that file's own comment for why).

const assert = require("assert");
const { curate, MAX_PER_DAY } = require("../lib/ocnjCurate");

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL - " + name);
    console.log("    " + err.message);
  }
}

function stubResponse(text) {
  return { content: [{ text }] };
}

(async () => {
  await test("parses a well-formed JSON response into {days: [...]}", async () => {
    const body = JSON.stringify({ days: [{ date: "2026-07-08", events: [{ title: "Farmers Market", time: "8:00 AM", location: "Ocean City Tabernacle" }] }] });
    const result = await curate([], null, async () => stubResponse(body));
    assert.strictEqual(result.days.length, 1);
    assert.strictEqual(result.days[0].events[0].title, "Farmers Market");
  });

  await test("strips accidental ```json code fences even though the prompt forbids them", async () => {
    const body = "```json\n" + JSON.stringify({ days: [] }) + "\n```";
    const result = await curate([], null, async () => stubResponse(body));
    assert.deepStrictEqual(result.days, []);
  });

  await test("strips a plain ``` fence with no language tag too", async () => {
    const body = "```\n" + JSON.stringify({ days: [] }) + "\n```";
    const result = await curate([], null, async () => stubResponse(body));
    assert.deepStrictEqual(result.days, []);
  });

  await test("malformed JSON throws a clear error rather than reaching the device", async () => {
    await assert.rejects(
      () => curate([], null, async () => stubResponse("not json at all")),
      /LLM did not return valid JSON/
    );
  });

  await test("a day with more than MAX_PER_DAY events is hard-capped, even if the model didn't obey the cap", async () => {
    const events = Array.from({ length: 9 }, (_, i) => ({ title: "Event " + i, time: null, location: null }));
    const body = JSON.stringify({ days: [{ date: "2026-07-08", events }] });
    const result = await curate([], null, async () => stubResponse(body));
    assert.strictEqual(result.days[0].events.length, MAX_PER_DAY);
  });

  await test("passes the merged events through as the user message content", async () => {
    const merged = [{ date: "2026-07-08", title: "Test Event" }];
    let seenBody = null;
    await curate(merged, null, async (body) => {
      seenBody = body;
      return stubResponse(JSON.stringify({ days: [] }));
    });
    assert.ok(seenBody.messages[0].content.includes("Test Event"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
