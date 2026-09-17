---
name: verifying-web-apps-headlessly
description: Use when about to check, test, or confirm that a change works in a web app running locally (localhost, a dev server, a static HTML file) — before reaching for browser-automation or screenshot tools.
---

# Verifying web apps headlessly

## Overview

Check a local web app with **one headless script that prints a few lines of text**, not a
sequence of browser-tool calls and screenshots. Every screenshot is an image that stays in the
conversation and is re-read on every later turn; every navigate/click/screenshot step is a
round trip. A script does the whole check in one call and returns only the verdict.

## When to use

- "Does the button work now?", "check the page loads", "confirm the fix", "test the form".
- After changing front-end code in a project with a dev server.

Use a real browser tool (such as claude-in-chrome) **only** when the check needs the user's own
logged-in browser session, a browser extension, or the user asks to watch.

## Workflow

1. Make sure the app is running and note its URL.
2. When this skill loads, Claude Code shows this skill's base directory in the skill listing.
   The verify helper lives at `<skill base directory>/../../scripts/verify.mjs`, with
   `load-playwright.mjs` beside it. Resolve that to an absolute path and write it into the
   import — a literal `${CLAUDE_PLUGIN_ROOT}` inside a JavaScript string never resolves.
3. Write a short script to the scratchpad (or `/tmp`) that imports `verify` from that resolved
   path:

   ```js
   // Replace with the resolved absolute path to this plugin's scripts/verify.mjs
   import { verify } from '/ABSOLUTE/PATH/TO/headless-verify/scripts/verify.mjs';

   await verify('http://localhost:5173', async (page, check) => {
     await page.getByRole('button', { name: 'Load' }).click();
     await check('items appear', async () => (await page.locator('.item').count()) === 3);
   });
   ```

4. Run it with `node script.mjs`. Read the output: `✓`/`✗` per check, console errors, a summary.
   Exit code `0` = passed, `1` = a check failed, `2` = could not run.
5. If a check fails, add a check or print one specific value that explains why
   (`console.log(await page.textContent('#status'))`), re-run, and fix the code.

## Output rules

- Print only what decides the question: pass/fail and the few values that explain a failure.
- Never print page HTML, `page.content()`, or accessibility trees.
- Wait on conditions (`check` retries until true; `waitForSelector`, media events), never fixed
  sleeps.
- Screenshots only for visual questions (layout, overlap, colour, alignment). Use
  `screenshot(page, { selector, path })` from the same module: it crops to the element and caps
  width at 800 px. Then Read the one image. Prefer measuring bounding boxes instead when the
  question is "does X overflow / overlap Y".

## Common mistakes

| Mistake | Instead |
| --- | --- |
| Screenshot after every step to "see what happened" | One `check` per expected outcome; text output |
| Clicking by coordinates from a screenshot | `page.getByRole` / `page.locator` |
| Testing media in a browser tool whose tab is hidden (media won't load) | Headless Chrome: mute, seek, wait for `seeked` |
| `waitForTimeout(3000)` | `check(...)` or an event/selector wait |
| Chromium for mp4/H.264 | Default `channel: 'chrome'` |

See `reference.md` for complete recipes: media playback, hover/drag, forms, console errors,
layout overlap, authenticated pages.
