# Baseline notes: verifying-web-apps-headlessly skill

## RED: without the skill

From the controller's recorded RED run (captions task, bug variant, no skill; subagent,
sonnet, 2026-09-16):

- Tools: claude-in-chrome, 12 calls (tabs_context 1, navigate 2, computer/screenshot 1,
  javascript_tool 4, get_page_text 1, tabs_create 1, tabs_close 2); Bash 1 (curl of the page
  HTML)
- Screenshots viewed: 1
- Dead ends: 1 (in-page fetch of app.js blocked by the extension; opened the script in a
  second tab instead)
- Approach: mostly read the served JavaScript and inspected the DOM, then forced a
  `timeupdate` event from the page
- Answer: correct (works=false, cause correctly identified as a listener bound to a null
  element before the video is inserted)
- Harness usage: 60,360 subagent tokens, 17 tool uses, 104 s

## GREEN: with the skill

Pending — the controller runs this after the skill is committed and will fill in this
section.
