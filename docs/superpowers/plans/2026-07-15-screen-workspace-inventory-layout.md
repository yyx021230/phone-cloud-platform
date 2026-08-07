# Screen Workspace and Inventory Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn real-time control into a polished screen-plus-control-rail workspace and show four phone cards per row on wide desktop inventory views.

**Architecture:** The change is presentation-only. Existing screen session, gallery import, text input, and navigation DOM ids remain unchanged; HTML gains semantic control-rail grouping and CSS supplies hierarchy and responsive grid rules. No server, API, Agent, or device-control behavior changes.

**Tech Stack:** Static HTML, CSS Grid, existing browser UI tests with Node test.

## Global Constraints

- Keep the phone video and three system navigation buttons in the left viewer column.
- Keep all control ids and existing event bindings unchanged.
- Use no gradients, no new icon library, and no nested floating cards.
- Show four phone cards per row on desktop layouts; preserve the existing narrow one-column fallback.

---

### Task 1: Encode the approved screen-control composition in tests

**Files:**
- Modify: `screen-client/screen-ui.test.mjs`

**Interfaces:**
- Consumes: `public/index.html`, `public/styles.css`.
- Produces: assertions for a semantic control-rail header, sectioned session controls, and wide inventory grid rules.

- [ ] **Step 1: Write failing layout assertions**

Add assertions that require the session section to contain a control heading and a connection-status summary, and require the stylesheet to contain a four-column wide-screen inventory grid:

```js
test("uses a sectioned control rail and a four-card desktop inventory grid", () => {
  assert.match(html, /class="screen-operation-heading"/);
  assert.match(html, /class="screen-session-summary"/);
  assert.match(css, /@media \(min-width: 1500px\)[\s\S]*?\.user-device-grid[\s\S]*?repeat\(4, minmax\(0, 1fr\)\)/);
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `node --test screen-client/screen-ui.test.mjs`

Expected: FAIL because the control-rail semantic classes and four-card breakpoint do not exist.

### Task 2: Build the screen-plus-control-rail desktop composition

**Files:**
- Modify: `public/index.html:294-326`
- Modify: `public/styles.css:2102-2319`
- Test: `screen-client/screen-ui.test.mjs`

**Interfaces:**
- Consumes: existing ids `userScreenStartButton`, `userScreenWakeButton`, `userScreenStopButton`, `userScreenHint`, `userScreenGalleryFileInput`, and `userScreenTextForm`.
- Produces: `screen-operation-heading`, `screen-session-summary`, an emphasized primary session action, a dashed gallery target, and non-card control sections.

- [ ] **Step 1: Add semantic heading and session summary markup**

Inside `.screen-session-section`, wrap the label in:

```html
<div class="screen-operation-heading">
  <span class="screen-operation-label">控制会话</span>
  <span class="screen-session-summary">实时控制</span>
</div>
```

Keep `#userScreenHint` as the runtime message and preserve every button id.

- [ ] **Step 2: Apply the approved visual hierarchy**

Use a wider left viewer and fixed readable right rail:

```css
.screen-control-layout { grid-template-columns: minmax(500px, 1fr) minmax(390px, 0.72fr); gap: 40px; }
.screen-operations-column { padding-left: 32px; }
.screen-operation-heading { display:flex; justify-content:space-between; align-items:center; }
.screen-gallery-import { padding: 16px; border: 1px dashed var(--line); border-radius: 8px; }
```

Retain the right rail divider and section dividers. Make only the start button full width; keep wake and disconnect side-by-side. On widths below 1180px, stack the screen and rail and remove the vertical divider.

- [ ] **Step 3: Run the focused test and verify green**

Run: `node --test screen-client/screen-ui.test.mjs`

Expected: PASS.

### Task 3: Make wide inventory views consistently show four phones

**Files:**
- Modify: `public/styles.css:1010-1014`, responsive rules near `@media (max-width: 1180px)`
- Test: `screen-client/screen-ui.test.mjs`

**Interfaces:**
- Consumes: `.user-device-grid` and existing `.user-phone-card` layout.
- Produces: four equal columns on desktop and one at the current narrow breakpoint.

- [ ] **Step 1: Add wide-screen grid rules**

Use:

```css
.user-device-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
```

Keep the existing one-column narrow breakpoint. Do not reduce phone-card content or font size just to force four cards at narrow widths.

- [ ] **Step 2: Verify all UI behavior still passes**

Run: `npm run check && npm run build:screen && npm run test:screen`

Expected: all checks and tests pass.

### Task 4: Release the static UI

**Files:**
- Modify: `public/index.html` cache version query strings.

- [ ] **Step 1: Deploy static assets**

Deploy `public/index.html` and `public/styles.css` to `/opt/phone-cloud-platform/public/` and `/app/public/` in the `phone-cloud-platform` container. Commit the live container image as `phone-cloud-platform-phone-cloud:latest`.

- [ ] **Step 2: Verify production response**

Run: `curl -fsS http://127.0.0.1:8787/ | grep -q "screen-workspace-v5"` and `curl -fsS http://127.0.0.1:8787/readyz`.

Expected: cache marker and ready response both succeed.

## Self-review

- Spec coverage: desktop control hierarchy, unchanged interaction bindings, responsive behavior, and four-card inventory layout are each covered.
- Placeholder scan: no deferred implementation items remain.
- Type consistency: all existing DOM ids are retained; only semantic CSS classes are added.
