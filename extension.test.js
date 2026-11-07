import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

const host = process.env.PI_MONITOR_HOST;

test("Pi loads the extension, renders the viewer, and queues completion", {
  skip: !host && "Set PI_MONITOR_HOST to your installed Pi package directory",
  timeout: 10000,
}, async () => {
  const { loadExtensions } = await import(pathToFileURL(`${host}/dist/core/extensions/loader.js`).href);
  const hostRequire = createRequire(`${host}/package.json`);
  const { getKeybindings, setKeybindings, KeybindingsManager } = await import(hostRequire.resolve("@earendil-works/pi-tui"));
  const result = await loadExtensions([`${process.cwd()}/index.ts`], process.cwd());
  assert.deepEqual(result.errors, []);
  const extension = result.extensions[0];
  const messages = [];
  result.runtime.sendMessage = (message, options) => messages.push({ message, options });
  let widget;
  let interact = async (_component, _isClosed) => {};
  const theme = { fg: (_color, text) => text };
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const ctx = {
    cwd: process.cwd(), mode: "tui",
    ui: {
      notify(message) { throw new Error(message); },
      setWidget(_key, factory) {
        widget?.dispose?.();
        widget = factory?.(tui, theme);
      },
      async custom(factory) {
        let done = false;
        const component = factory(tui, theme, { matches: (data) => data === "escape" }, () => { done = true; });
        for (const width of [1, 4, 30, 80]) {
          const lines = component.render(width).map(stripVTControlCharacters);
          assert.ok(lines.length <= tui.terminal.rows);
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
          if (width >= 4) {
            assert.equal(lines[0], `╭${"─".repeat(width - 2)}╮`);
            assert.equal(lines.at(-1), `╰${"─".repeat(width - 2)}╯`);
            assert.equal(lines[1], `│${" ".repeat(width - 2)}│`);
            assert.equal(lines.at(-2), lines[1]);
            assert.ok(lines.slice(1, -1).every((line) =>
              line.startsWith("│ ") && / [│█░]$/.test(line) && visibleWidth(line) === width));
          }
        }
        await interact(component, () => done);
        if (!done) component.handleInput("escape");
        assert.equal(done, true);
      },
    },
  };
  const dispatch = async (name) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx);
  };
  const tool = extension.tools.get("background").definition;
  assert.equal(extension.tools.get("monitor").definition.defaultActive, false);
  assert.ok(extension.commands.has("jobs"));
  const execute = (params) => tool.execute("test", params, new AbortController().signal, undefined, ctx);
  const checkMessageRendering = (message, output) => {
    const original = message.content;
    const renderer = extension.messageRenderers.get(message.customType);
    assert.ok(renderer);
    const collapsed = renderer(message, { expanded: false, outputPad: 1 }, theme);
    assert.equal(collapsed.render(80).length, 1);
    assert.match(collapsed.render(80)[0], /▸.*Monitor/);
    assert.ok(!collapsed.render(80)[0].includes(output));
    assert.ok(collapsed.render(20).every((line) => visibleWidth(line) <= 20));
    const click = { type: "click", button: "left", y: 0 };
    assert.deepEqual(collapsed.handleMouse(click), { handled: true, render: true });
    assert.ok(collapsed.render(80).join("\n").includes(output));
    const rebuilt = renderer(message, { expanded: false, outputPad: 1 }, theme);
    assert.ok(rebuilt.render(80).join("\n").includes(output));
    assert.equal(rebuilt.handleMouse({ ...click, y: 1 }), undefined);
    assert.equal(rebuilt.handleMouse({ ...click, button: "right" }), undefined);
    assert.equal(rebuilt.handleMouse({ type: "wheel", wheelDelta: 3 }), undefined);
    rebuilt.handleMouse(click);
    assert.equal(rebuilt.render(80).length, 1);
    const expanded = renderer(message, { expanded: true, outputPad: 1 }, theme);
    assert.match(expanded.render(80).join("\n"), /▾.*Monitor/);
    assert.ok(expanded.render(80).join("\n").includes(output));
    assert.equal(message.content, original);
    assert.equal(renderer(message, { expanded: false, outputPad: 1 }, theme).render(80).length, 1);
    const previous = getKeybindings();
    try {
      for (const shortcut of ["ctrl+o", "ctrl+g"]) {
        setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: shortcut } }));
        assert.ok(stripVTControlCharacters(collapsed.render(80)[0]).includes(`(${shortcut} to expand)`));
        const longMessage = { ...message, content: `Monitor ${"long title ".repeat(30)}` };
        const longLine = renderer(longMessage, { expanded: false, outputPad: 1 }, theme).render(80)[0];
        assert.ok(stripVTControlCharacters(longLine).includes(`(${shortcut} to expand)`));
        assert.ok(visibleWidth(longLine) <= 80);
      }
      setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: [] } }));
      assert.ok(!collapsed.render(80)[0].includes("to expand"));
    } finally { setKeybindings(previous); }
  };
  await dispatch("session_start");
  try {
    assert.deepEqual(widget.render(40), []);
    await assert.rejects(execute({ action: "start" }), /exactly one/);
    await assert.rejects(execute({ action: "start", prompt: "review", command: "true" }), /exactly one/);
    await assert.rejects(execute({ action: "start", command: "true", model: "test/model" }), /model requires prompt/);
    await assert.rejects(execute({ action: "start", prompt: " " }), /Prompt must not be empty/);
    await assert.rejects(execute({ action: "status", prompt: "review" }), /only supported for start/);
    const started = await execute({ action: "start", command: "sleep 0.1; printf done", title: "CI 日本語 🚀" });
    assert.match(started.content[0].text, /Started in background/);
    assert.match(widget.render(80)[0], /CI.*running/);
    interact = async (component, isClosed) => {
      assert.ok(!component.render(80).some((line) => line.endsWith("█")));
      component.handleInput("d");
      assert.equal(isClosed(), false);
      assert.match((await execute({ action: "status", id: "1" })).content[0].text, /running/);
    };
    await extension.commands.get("monitors").handler("", ctx);
    while (!messages.length) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages.length, 1);
    assert.match(messages[0].message.content, /completed[\s\S]*done/);
    assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
    checkMessageRendering(messages[0].message, "done");
    assert.deepEqual(widget.render(80), []);
    assert.match((await execute({ action: "status" })).content[0].text, /completed/);
    const finishedCheck = await execute({ action: "status", id: "1", checkAfterSeconds: 1 });
    assert.match(finishedCheck.content[0].text, /No check-in scheduled/);
    await assert.rejects(execute({ action: "status", checkAfterSeconds: 1 }), /id is required/);
    await assert.rejects(execute({ action: "status", id: "missing", checkAfterSeconds: 1 }), /Unknown monitor/);
    await execute({ action: "start", command: "sleep 30" });
    assert.match(widget.render(80)[0], /#2.*running/);
    await execute({ action: "stop", id: "2" });
    assert.deepEqual(widget.render(80), []);
    interact = async (component, isClosed) => {
      component.handleInput("d");
      assert.equal(isClosed(), false);
      assert.match(component.render(80).join("\n"), /#1.*CI/);
      await assert.rejects(execute({ action: "status", id: "2" }), /Unknown monitor/);
      component.handleInput("d");
      assert.equal(isClosed(), true);
      assert.deepEqual(component.render(80), []);
      assert.equal((await execute({ action: "status" })).content[0].text, "No monitors");
    };
    await extension.commands.get("monitors").handler("", ctx);
    assert.equal(messages.length, 1);
    await execute({ action: "start", command: "sleep 30" });
    await dispatch("session_shutdown");
    assert.equal(messages.length, 1);
    await dispatch("session_start");
    assert.equal((await execute({ action: "status" })).content[0].text, "No monitors");
    const scheduled = await execute({
      action: "start", command: "printf 'progress\\n'; printf 'line-%s\\n' {1..40}; sleep 30", title: "Long job", checkAfterSeconds: 1,
    });
    assert.match(scheduled.content[0].text, /check-in scheduled after 1 seconds/);
    while (messages.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages[1].message.customType, "monitor-check");
    assert.match(messages[1].message.content, /Scheduled check-in:[\s\S]*running[\s\S]*progress/);
    assert.deepEqual(messages[1].options, { triggerTurn: true, deliverAs: "followUp" });
    checkMessageRendering(messages[1].message, "progress");
    await assert.rejects(execute({ action: "stop", id: "1", checkAfterSeconds: 1 }), /only supported/);
    await execute({ action: "status", id: "1", checkAfterSeconds: 60 });
    const rearmed = await execute({ action: "status", id: "1", checkAfterSeconds: 1 });
    assert.match(rearmed.content[0].text, /progress[\s\S]*pending reminder was replaced/);
    await execute({ action: "status", id: "1" });
    assert.equal((await execute({ action: "status" })).content[0].text.split("\n").length, 1);
    while (messages.length < 3) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages[2].message.customType, "monitor-check");
    assert.match(messages[2].message.content, /Monitor 1:[\s\S]*progress/);
    assert.deepEqual(messages[2].options, { triggerTurn: true, deliverAs: "followUp" });
    interact = async (component) => {
      const tail = component.render(80);
      assert.match(tail.join("\n"), /line-40/);
      assert.ok(tail.at(-4).endsWith("█"));
      assert.ok(!tail[3].endsWith("█"));
      tui.terminal.rows = 16;
      const resized = component.render(80);
      assert.ok(resized.at(-4).endsWith("█"));
      assert.equal(resized.filter((line) => line.endsWith("█")).length, 1);
      tui.terminal.rows = 24;
      assert.deepEqual(component.handleMouse({ type: "wheel", wheelDelta: -3 }), { handled: true });
      const scrolled = component.render(80);
      assert.notDeepEqual(scrolled, tail);
      assert.ok(!scrolled.join("\n").includes("line-40"));
      component.handleMouse({ type: "wheel", wheelDelta: -1000 });
      const top = component.render(80);
      assert.match(top.join("\n"), /Command:/);
      assert.ok(top[3].endsWith("█"));
      assert.ok(!top.at(-4).endsWith("█"));
      assert.equal(top.filter((line) => line.endsWith("█")).length,
        tail.filter((line) => line.endsWith("█")).length);
      component.handleMouse({ type: "wheel", wheelDelta: -3 });
      assert.deepEqual(component.render(80), top);
      component.handleMouse({ type: "wheel", wheelDelta: 1000 });
      assert.deepEqual(component.render(80), tail);
      component.handleMouse({ type: "wheel", wheelDelta: 3 });
      assert.deepEqual(component.render(80), tail);
      assert.equal(component.handleMouse({ type: "click" }), undefined);
    };
    await extension.commands.get("monitors").handler("", ctx);
    await execute({ action: "stop", id: "1" });
    assert.equal(messages.length, 3);
  } finally { await dispatch("session_shutdown"); }
});
