import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

export class MeetBrowserBot {
  constructor({
    meetUrl,
    displayName,
    chromeChannel,
    chromeExecutablePath,
    chromeUserDataDir,
    chromeLaunchMode,
    chromeExtraArgs = [],
    headless,
    aloneTimeoutMs = 45_000
  }) {
    this.meetUrl = meetUrl;
    // Every Meet state-detection regex below matches English UI strings, so force the
    // UI language regardless of the bot account/profile locale.
    this.launchUrl = withEnglishUiParam(meetUrl);
    this.displayName = displayName;
    this.chromeChannel = chromeChannel;
    this.chromeExecutablePath = chromeExecutablePath;
    this.chromeUserDataDir = chromeUserDataDir;
    this.chromeLaunchMode = chromeLaunchMode;
    this.chromeExtraArgs = chromeExtraArgs;
    this.headless = headless;
    this.aloneTimeoutMs = Math.max(5000, Number(aloneTimeoutMs) || 45_000);
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromeProcess = null;
    this.remoteDebuggingPort = null;
    this.cdpSocket = null;
    this.cdpPending = new Map();
    this.cdpMessageId = 0;
  }

  async join() {
    if (this.shouldLaunchWithRawCdp()) {
      await this.joinWithRawCdp();
      return;
    }

    if (this.shouldLaunchWithAppleScript()) {
      await this.joinWithAppleScript();
      return;
    }

    const { chromium } = await import("playwright-core");
    if (this.shouldLaunchWithCdp()) {
      await this.launchChromeForCdp();
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.remoteDebuggingPort}`);
      this.context = this.browser.contexts()[0];
      if (!this.context) throw new Error("Chrome DevTools did not expose a browser context.");
      this.page = this.context.pages().find((page) => page.url().includes("meet.google.com")) ||
        (await this.context.newPage());
    } else {
      const launchOptions = {
        headless: this.headless,
        args: [
          "--autoplay-policy=no-user-gesture-required",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--use-fake-ui-for-media-stream",
          "--lang=en-US",
          ...this.chromeExtraArgs
        ]
      };
      if (this.chromeExecutablePath) launchOptions.executablePath = this.chromeExecutablePath;
      if (!this.chromeExecutablePath && this.chromeChannel) launchOptions.channel = this.chromeChannel;

      this.context = await chromium.launchPersistentContext(this.chromeUserDataDir, launchOptions);
      this.page = this.context.pages()[0] || (await this.context.newPage());
    }

    await this.page.bringToFront().catch(() => {});
    if (!this.page.url().startsWith(this.meetUrl)) {
      await this.page.goto(this.launchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await this.page.waitForTimeout(3000);

    await this.fillDisplayNameIfAsked();
    await this.continueWithoutMicAndCameraIfAsked();
    await this.turnOffMicAndCamera();
    await this.clickJoinButton();
  }

  shouldLaunchWithCdp() {
    return this.chromeLaunchMode === "cdp" && Boolean(this.chromeExecutablePath) && !this.headless;
  }

  shouldLaunchWithAppleScript() {
    return this.chromeLaunchMode === "applescript" && !this.headless;
  }

  shouldLaunchWithRawCdp() {
    return this.chromeLaunchMode === "rawcdp" && Boolean(this.chromeExecutablePath) && !this.headless;
  }

  async launchChromeForCdp() {
    this.remoteDebuggingPort = await getFreePort();
    const userDataDir = resolve(this.chromeUserDataDir);
    const args = [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${this.remoteDebuggingPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--lang=en-US",
      ...this.chromeExtraArgs,
      this.launchUrl
    ];

    this.chromeProcess = spawn(this.chromeExecutablePath, args, {
      stdio: "ignore"
    });

    await Promise.race([
      waitForDevTools(this.remoteDebuggingPort, this.chromeProcess),
      new Promise((_, reject) => this.chromeProcess.once("error", reject))
    ]);
  }

  async joinWithRawCdp() {
    await this.launchChromeForCdp();
    await this.connectRawCdp();
    await this.rawCdpCommand("Page.bringToFront");
    await delay(3500);

    const deadline = Date.now() + 45_000;
    let lastState = null;
    while (Date.now() < deadline) {
      lastState = await this.driveRawCdpJoinStep();
      if (lastState.status === "admitted") return;
      if (lastState.status === "asked" || lastState.status === "join_clicked") {
        await this.waitForRawCdpAdmission({
          timeoutMs: lastState.status === "asked" ? 90_000 : 30_000
        });
        return;
      }
      if (lastState.status === "refused") {
        throw new Error(lastState.message);
      }
      await delay(1000);
    }

    throw new Error(`Could not ask Google Meet to admit the bot. Last state: ${lastState?.status || "unknown"}.`);
  }

  async connectRawCdp() {
    const deadline = Date.now() + 20_000;
    let target = null;
    while (Date.now() < deadline && !target) {
      const response = await fetch(`http://127.0.0.1:${this.remoteDebuggingPort}/json/list`);
      const targets = await response.json();
      target = targets.find((item) => item.type === "page" && item.url?.includes("meet.google.com")) ||
        targets.find((item) => item.type === "page");
      if (!target) await delay(500);
    }
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("Chrome DevTools did not expose a controllable Meet tab.");
    }

    this.cdpSocket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => {
      this.cdpSocket.addEventListener("open", resolveOpen, { once: true });
      this.cdpSocket.addEventListener("error", reject, { once: true });
    });

    this.cdpSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.cdpPending.has(message.id)) {
        this.cdpPending.get(message.id)(message);
        this.cdpPending.delete(message.id);
      }
    });
    this.cdpSocket.addEventListener("close", () => {
      for (const resolvePending of this.cdpPending.values()) {
        resolvePending({ error: { message: "Chrome DevTools socket closed." } });
      }
      this.cdpPending.clear();
    });
  }

  async driveRawCdpJoinStep() {
    return this.executeRawCdpJson(this.joinStepScript());
  }

  async waitForRawCdpAdmission({ timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    let lastState = null;
    while (Date.now() < deadline) {
      lastState = await this.inspectRawCdpMeeting();
      if (lastState.status === "admitted") return;
      if (lastState.status === "refused") throw new Error(lastState.message);
      await delay(1500);
    }
    throw new Error(`Timed out waiting for Google Meet to admit the bot account. Last state: ${lastState?.status || "unknown"}.`);
  }

  async inspectRawCdpMeeting() {
    return this.executeRawCdpJson(this.inspectMeetingScript());
  }

  async rawCdpCommand(method, params = {}) {
    if (!this.cdpSocket || this.cdpSocket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome DevTools socket is not connected.");
    }

    const id = ++this.cdpMessageId;
    this.cdpSocket.send(JSON.stringify({ id, method, params }));
    const response = await new Promise((resolveResponse) => this.cdpPending.set(id, resolveResponse));
    if (response.error) {
      throw new Error(response.error.message || `Chrome DevTools command failed: ${method}.`);
    }
    return response.result;
  }

  async executeRawCdpJson(script) {
    const result = await this.rawCdpCommand("Runtime.evaluate", {
      expression: `JSON.stringify(${script})`,
      returnByValue: true,
      awaitPromise: true
    });
    const value = result?.result?.value;
    if (!value) throw new Error("Chrome DevTools returned an empty evaluation result.");
    return JSON.parse(value);
  }

  joinStepScript() {
    return `
      (() => {
        const body = document.body?.innerText || "";
        const normalizedBody = body.toLowerCase();
        const buttons = [...document.querySelectorAll("button")];
        const buttonLabels = buttons.map((button) => button.getAttribute("aria-label") || button.innerText || "");
        const buttonByText = (pattern) => buttons.find((button) => pattern.test(button.innerText || button.getAttribute("aria-label") || ""));
        const visibleInput = [...document.querySelectorAll("input, textarea")]
          .find((input) => !input.disabled && /your name/i.test(input.getAttribute("aria-label") || input.placeholder || ""));
        const setValue = (element, value) => {
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
          descriptor.set.call(element, value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const waitingForAdmission = /please wait until.*host.*bring|host.*bring.*into the call|you asked to join|asking to join|waiting for.*host/i.test(body);
        if (waitingForAdmission) return { status: "waiting_room", body: body.slice(0, 300) };

        const hasLeaveButton = buttonLabels.some((label) => /leave call|end call|hang up/i.test(label));
        const hasInCallControl = /meeting details|show everyone|chat with everyone|activities|turn on captions|raise hand|present now/i.test(body) ||
          buttonLabels.some((label) => /meeting details|show everyone|chat with everyone|activities|turn on captions|raise hand|present now/i.test(label));
        const inMeeting = /you have joined the call/i.test(body) || (hasLeaveButton && hasInCallControl);
        if (inMeeting) return { status: "admitted" };
        if (/you can't join this video call/i.test(body)) {
          return { status: "refused", message: "Google Meet refused this bot session: You can't join this video call." };
        }
        if (/meeting code.*expired|meeting.*doesn't exist|invalid meeting/i.test(normalizedBody)) {
          return { status: "refused", message: "Google Meet refused this bot session: the meeting code is invalid or expired." };
        }

        const gotIt = buttonByText(/got it/i);
        if (gotIt && !gotIt.disabled) gotIt.click();

        if (visibleInput && visibleInput.value !== ${JSON.stringify(this.displayName)}) {
          visibleInput.focus();
          setValue(visibleInput, ${JSON.stringify(this.displayName)});
          return { status: "filled_name" };
        }

        const continueButton = buttonByText(/continue without microphone and camera/i);
        if (continueButton && !continueButton.disabled) {
          continueButton.click();
          return { status: "continued_without_media" };
        }

        const joinButton = buttonByText(/join now|^join$/i);
        if (joinButton && !joinButton.disabled) {
          joinButton.click();
          return { status: "join_clicked" };
        }

        const askButton = buttonByText(/ask to join/i);
        if (askButton && !askButton.disabled) {
          askButton.click();
          return { status: "asked" };
        }

        return {
          status: "waiting",
          body: body.slice(0, 300),
          askDisabled: Boolean(askButton?.disabled)
        };
      })()
    `;
  }

  inspectMeetingScript() {
    return `
      (() => {
        ${this.signalsHelperSnippet()}
        const body = document.body?.innerText || "";
        const lines = body.split("\\n").map((line) => line.trim()).filter(Boolean);
        const buttons = [...document.querySelectorAll("button")];
        const buttonLabels = buttons.map((button) => button.getAttribute("aria-label") || button.innerText || "");
        const signals = collectSignals();
        const participantCount = signals.participantCount ?? (() => {
          // Fallback only: any bare number in the page text (chat messages or badges can
          // false-positive). The roster from collectSignals is the trusted count.
          for (const line of lines) {
            if (/^\\d{1,3}$/.test(line)) return Number(line);
          }
          return null;
        })();
        const waitingForAdmission = /please wait until.*host.*bring|host.*bring.*into the call|you asked to join|asking to join|waiting for.*host/i.test(body);
        if (waitingForAdmission) return { status: "waiting_room", body: body.slice(0, 300) };
        if (/return to home screen|you left the meeting|no one else is here|your call is ending soon|you.?re the only one/i.test(body)) {
          return { status: "ended" };
        }

        const hasLeaveButton = buttonLabels.some((label) => /leave call|end call|hang up/i.test(label));
        const hasInCallControl = /meeting details|show everyone|chat with everyone|activities|turn on captions|raise hand|present now/i.test(body) ||
          buttonLabels.some((label) => /meeting details|show everyone|chat with everyone|activities|turn on captions|raise hand|present now/i.test(label));
        if (hasLeaveButton && hasInCallControl && participantCount === 1) {
          return { status: "alone", participantCount, body: body.slice(0, 300) };
        }
        if (/you have joined the call/i.test(body) || (hasLeaveButton && hasInCallControl)) return { status: "admitted" };
        if (/you can't join this video call/i.test(body)) {
          return { status: "refused", message: "Google Meet refused this bot session: You can't join this video call." };
        }
        if (/you weren'?t allowed to join|no one let you in|couldn'?t join/i.test(body)) {
          return { status: "refused", message: "Google Meet did not admit the bot account." };
        }
        return { status: "waiting", body: body.slice(0, 300) };
      })()
    `;
  }

  signalsHelperSnippet() {
    return `
      const collectSignals = () => {
        const cleanName = (value) => String(value || "")
          .replace(/\\s+/g, " ")
          .replace(/\\((you|meeting host)\\)$/i, "")
          .trim();
        const looksLikeName = (value) => Boolean(value) && value.length >= 2 && value.length <= 80 &&
          !/^(you|meeting host|presentation|devices?|\\d+)$/i.test(value);
        const participants = new Set();
        const activeSpeakers = new Set();

        // People side panel (the bot opens it right after joining): the most reliable
        // roster source, and its size doubles as the trusted participant count.
        for (const list of document.querySelectorAll('[role="list"][aria-label*="articipant" i]')) {
          for (const item of list.querySelectorAll('[role="listitem"]')) {
            const name = cleanName(item.getAttribute("aria-label") || item.querySelector("span")?.textContent);
            if (looksLikeName(name)) participants.add(name);
          }
        }

        // Video tiles carry data-participant-id with the display name nearby.
        for (const tile of document.querySelectorAll("[data-participant-id]")) {
          const name = cleanName(
            tile.getAttribute("data-self-name") ||
            tile.querySelector("[data-self-name]")?.getAttribute("data-self-name") ||
            ""
          );
          if (looksLikeName(name)) {
            participants.add(name);
            // Voice-activity indicator classes are obfuscated by Google and rotate;
            // refresh these selectors from a live meeting when detection goes quiet.
            if (tile.querySelector('.IisKdb, [class*="speaking" i], [data-speaking="true"]')) {
              activeSpeakers.add(name);
            }
          }
        }

        // Captions render the current speaker's display name next to each line: the
        // strongest name-to-speech signal we can get without audio fingerprinting.
        let captionSpeaker = "";
        const captionRegion = document.querySelector('[jsname="dsyhDe"], [aria-label*="aption" i][role="region"], .a4cQT');
        if (captionRegion) {
          const nameNodes = captionRegion.querySelectorAll('[class*="NWpY1d"], [class*="zs7s8d"], [class*="name" i]');
          const lastNode = nameNodes[nameNodes.length - 1];
          const name = cleanName(lastNode?.textContent);
          if (looksLikeName(name)) {
            captionSpeaker = name;
            activeSpeakers.add(name);
          }
        }

        return {
          participants: [...participants],
          activeSpeakers: [...activeSpeakers],
          captionSpeaker,
          participantCount: participants.size || null
        };
      };
    `;
  }

  collectSignalsScript() {
    return `
      (() => {
        ${this.signalsHelperSnippet()}
        return collectSignals();
      })()
    `;
  }

  clickButtonScript(patternSource) {
    return `
      (() => {
        const pattern = new RegExp(${JSON.stringify(patternSource)}, "i");
        const button = [...document.querySelectorAll("button")].find((item) =>
          pattern.test(item.getAttribute("aria-label") || item.innerText || "")
        );
        if (!button || button.disabled) return { clicked: false };
        button.click();
        return { clicked: true };
      })()
    `;
  }

  leaveMeetingScript() {
    return `
      (() => {
        const buttons = [...document.querySelectorAll("button")];
        const leaveButton = buttons.find((button) =>
          /leave call|end call|hang up/i.test(button.getAttribute("aria-label") || button.innerText || "")
        );
        if (!leaveButton || leaveButton.disabled) return { clicked: false };
        leaveButton.click();
        return { clicked: true };
      })()
    `;
  }

  async joinWithAppleScript() {
    await this.launchChromeForAppleScript();
    await delay(3500);

    const deadline = Date.now() + 45_000;
    let lastState = null;
    while (Date.now() < deadline) {
      lastState = await this.driveAppleScriptJoinStep();
      if (lastState.status === "admitted") return;
      if (lastState.status === "asked" || lastState.status === "join_clicked") {
        await this.waitForAppleScriptAdmission({
          timeoutMs: lastState.status === "asked" ? 90_000 : 30_000
        });
        return;
      }
      if (lastState.status === "refused") {
        throw new Error(lastState.message);
      }
      await delay(1000);
    }

    throw new Error(`Could not ask Google Meet to admit the bot. Last state: ${lastState?.status || "unknown"}.`);
  }

  async launchChromeForAppleScript() {
    if (!this.chromeExecutablePath) {
      throw new Error("BOT_CHROME_EXECUTABLE_PATH is required for BOT_CHROME_LAUNCH_MODE=applescript.");
    }

    const userDataDir = resolve(this.chromeUserDataDir);
    await command("open", [
      "-na",
      "Google Chrome",
      "--args",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--lang=en-US",
      this.launchUrl
    ], { timeoutMs: 5000 });
  }

  async driveAppleScriptJoinStep() {
    return this.executeChromeJson(this.joinStepScript());
  }

  async waitForAppleScriptAdmission({ timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    let lastState = null;
    while (Date.now() < deadline) {
      lastState = await this.inspectAppleScriptMeeting();
      if (lastState.status === "admitted") return;
      if (lastState.status === "refused") throw new Error(lastState.message);
      await delay(1500);
    }
    throw new Error(`Timed out waiting for Google Meet to admit the bot account. Last state: ${lastState?.status || "unknown"}.`);
  }

  async inspectAppleScriptMeeting() {
    return this.executeChromeJson(this.inspectMeetingScript());
  }

  async fillDisplayNameIfAsked() {
    const page = this.requirePage();
    const inputs = [
      page.getByLabel(/your name/i),
      page.getByPlaceholder(/your name/i),
      page.locator('input[type="text"]').first()
    ];
    for (const input of inputs) {
      try {
        if ((await input.count()) > 0 && (await input.first().isVisible({ timeout: 1000 }))) {
          await input.first().fill(this.displayName);
          return;
        }
      } catch {
        // Google Meet varies by account state. Continue through the selector fallbacks.
      }
    }
  }

  async turnOffMicAndCamera() {
    const page = this.requirePage();
    for (const name of [/turn off microphone/i, /turn off camera/i]) {
      try {
        const button = page.getByRole("button", { name }).first();
        if ((await button.count()) > 0 && (await button.isVisible({ timeout: 1000 }))) {
          await button.click({ timeout: 2000 });
        }
      } catch {
        // Keyboard shortcuts below are the fallback.
      }
    }
    await page.keyboard.press("Control+D").catch(() => {});
    await page.keyboard.press("Control+E").catch(() => {});
  }

  async continueWithoutMicAndCameraIfAsked() {
    const page = this.requirePage();
    const candidates = [
      page.getByRole("button", { name: /continue without microphone and camera/i }),
      page.locator('button:has-text("Continue without microphone and camera")')
    ];

    for (const candidate of candidates) {
      try {
        if ((await candidate.count()) > 0 && (await candidate.first().isVisible({ timeout: 1500 }))) {
          await candidate.first().click({ timeout: 5000 });
          await page.waitForTimeout(2500);
          return;
        }
      } catch {
        // Try the next candidate.
      }
    }
  }

  async assertMeetIsJoinable() {
    const page = this.requirePage();
    const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (/you can't join this video call/i.test(text)) {
      throw new Error("Google Meet refused this bot session: You can't join this video call.");
    }
    if (/meeting code.*expired|meeting.*doesn't exist|invalid meeting/i.test(text)) {
      throw new Error("Google Meet refused this bot session: the meeting code is invalid or expired.");
    }
  }

  async clickJoinButton() {
    const page = this.requirePage();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidates = [
        { locator: page.getByRole("button", { name: /join now/i }), action: "join" },
        { locator: page.getByRole("button", { name: /ask to join/i }), action: "ask" },
        { locator: page.getByRole("button", { name: /^join$/i }), action: "join" },
        { locator: page.locator('button:has-text("Join now")'), action: "join" },
        { locator: page.locator('button:has-text("Ask to join")'), action: "ask" },
        { locator: page.getByRole("button", { name: /continue without microphone and camera/i }), action: "continue" },
        { locator: page.locator('button:has-text("Continue without microphone and camera")'), action: "continue" }
      ];

      for (const candidate of candidates) {
        try {
          if (
            (await candidate.locator.count()) > 0 &&
            (await candidate.locator.first().isVisible({ timeout: 1200 }))
          ) {
            await candidate.locator.first().click({ timeout: 5000 });
            await page.waitForTimeout(candidate.action === "continue" ? 2500 : 5000);
            if (candidate.action !== "continue") {
              await this.waitForMeetingAdmission({
                timeoutMs: candidate.action === "ask" ? 90_000 : 30_000
              });
              return;
            }
            break;
          }
        } catch {
          // Try the next candidate.
        }
      }

      await page.waitForTimeout(1500);
      const joinableButtonVisible = await page
        .locator('button:has-text("Join now"), button:has-text("Ask to join")')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (!joinableButtonVisible) {
        await this.assertMeetIsJoinable();
      }
    }
    throw new Error("Could not find a Google Meet join button.");
  }

  async waitForMeetingAdmission({ timeoutMs }) {
    const page = this.requirePage();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.assertMeetIsJoinable();
      if (await this.isWaitingForAdmission()) {
        await page.waitForTimeout(1500);
        continue;
      }
      if (await this.isInMeeting()) return;

      const body = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
      if (/you weren'?t allowed to join|no one let you in|couldn'?t join/i.test(body)) {
        throw new Error("Google Meet did not admit the bot account.");
      }

      await page.waitForTimeout(1500);
    }
    throw new Error("Timed out waiting for Google Meet to admit the bot account.");
  }

  async isInMeeting() {
    const page = this.requirePage();
    if (await this.isWaitingForAdmission()) return false;

    const body = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    if (/you have joined the call/i.test(body)) return true;
    if (!/meeting details|show everyone|chat with everyone|activities|turn on captions|raise hand|present now/i.test(body)) {
      return false;
    }

    const controls = [
      page.getByRole("button", { name: /leave call|hang up|end call/i }).first(),
      page.locator('button[aria-label*="Leave call" i], button[aria-label*="End call" i]').first()
    ];

    for (const control of controls) {
      if (await control.isVisible({ timeout: 500 }).catch(() => false)) return true;
    }
    return false;
  }

  async isWaitingForAdmission() {
    const page = this.requirePage();
    const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    return /please wait until.*host.*bring|host.*bring.*into the call|you asked to join|asking to join|waiting for.*host/i.test(text);
  }

  async waitUntilFinished({ maxDurationMs, onHeartbeat }) {
    if (this.shouldLaunchWithRawCdp()) {
      return this.waitWithRawCdp({ maxDurationMs, onHeartbeat });
    }

    if (this.shouldLaunchWithAppleScript()) {
      return this.waitWithAppleScript({ maxDurationMs, onHeartbeat });
    }

    const page = this.requirePage();
    const deadline = Date.now() + maxDurationMs;
    let aloneSince = null;
    while (Date.now() < deadline) {
      if (page.isClosed()) return "page_closed";
      const state = await this.inspectPlaywrightMeeting();
      if (state.status === "ended") return "meeting_ended";
      if (state.status === "refused") throw new Error(state.message);
      if (state.status === "alone") {
        aloneSince ??= Date.now();
        if (Date.now() - aloneSince >= this.aloneTimeoutMs) {
          await this.leavePlaywrightMeeting();
          return "alone_timeout";
        }
      } else {
        aloneSince = null;
      }
      await onHeartbeat?.();
      await page.waitForTimeout(5000);
    }
    return "max_duration";
  }

  async waitWithRawCdp({ maxDurationMs, onHeartbeat }) {
    const deadline = Date.now() + maxDurationMs;
    let aloneSince = null;
    while (Date.now() < deadline) {
      let state;
      try {
        state = await this.inspectRawCdpMeeting();
      } catch (error) {
        if (/socket closed|not connected/i.test(error.message)) return "page_closed";
        throw error;
      }

      if (state.status === "ended") return "meeting_ended";
      if (state.status === "refused") throw new Error(state.message);
      if (state.status === "alone") {
        aloneSince ??= Date.now();
        if (Date.now() - aloneSince >= this.aloneTimeoutMs) {
          await this.leaveRawCdpMeeting();
          return "alone_timeout";
        }
      } else {
        aloneSince = null;
      }

      await onHeartbeat?.();
      await delay(5000);
    }
    return "max_duration";
  }

  async waitWithAppleScript({ maxDurationMs, onHeartbeat }) {
    const deadline = Date.now() + maxDurationMs;
    let aloneSince = null;
    while (Date.now() < deadline) {
      let state;
      try {
        state = await this.inspectAppleScriptMeeting();
      } catch (error) {
        if (/Meet tab not found/i.test(error.message)) return "page_closed";
        throw error;
      }

      if (state.status === "ended") return "meeting_ended";
      if (state.status === "refused") throw new Error(state.message);
      if (state.status === "alone") {
        aloneSince ??= Date.now();
        if (Date.now() - aloneSince >= this.aloneTimeoutMs) {
          await this.leaveAppleScriptMeeting();
          return "alone_timeout";
        }
      } else {
        aloneSince = null;
      }

      await onHeartbeat?.();
      await delay(5000);
    }
    return "max_duration";
  }

  async evalJson(script) {
    if (this.shouldLaunchWithRawCdp()) return this.executeRawCdpJson(script);
    if (this.shouldLaunchWithAppleScript()) return this.executeChromeJson(script);
    return this.requirePage().evaluate(script);
  }

  async collectSignals() {
    return this.evalJson(this.collectSignalsScript());
  }

  async prepareNameSignals() {
    const results = { captionsClicked: false, peoplePanelClicked: false };
    try {
      results.captionsClicked = Boolean((await this.evalJson(this.clickButtonScript("turn on captions"))).clicked);
    } catch {
      // Captions are best-effort; speaker names still come from the roster and tiles.
    }
    await delay(800);
    try {
      results.peoplePanelClicked = Boolean(
        (await this.evalJson(this.clickButtonScript("show everyone|^people$"))).clicked
      );
    } catch {
      // Roster then falls back to video-tile scraping.
    }
    return results;
  }

  async inspectPlaywrightMeeting() {
    const page = this.requirePage();
    return page.evaluate(this.inspectMeetingScript());
  }

  async leavePlaywrightMeeting() {
    const page = this.requirePage();
    return page.evaluate(this.leaveMeetingScript());
  }

  async leaveRawCdpMeeting() {
    return this.executeRawCdpJson(this.leaveMeetingScript());
  }

  async leaveAppleScriptMeeting() {
    return this.executeChromeJson(this.leaveMeetingScript());
  }

  async close() {
    if (this.shouldLaunchWithAppleScript()) {
      await this.closeAppleScriptTab().catch(() => {});
    }
    if (this.cdpSocket && this.cdpSocket.readyState === WebSocket.OPEN) {
      await this.rawCdpCommand("Page.close").catch(() => {});
      this.cdpSocket.close();
    }
    await this.browser?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    if (this.chromeProcess && !this.chromeProcess.killed) {
      this.chromeProcess.kill("SIGTERM");
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.chromeProcess = null;
    this.remoteDebuggingPort = null;
    this.cdpSocket = null;
    this.cdpPending.clear();
    this.cdpMessageId = 0;
  }

  async closeAppleScriptTab() {
    await runAppleScript([
      `set targetUrl to ${appleScriptString(this.meetUrl)}`,
      'tell application "Google Chrome"',
      "  repeat with chromeWindow in windows",
      "    repeat with chromeTab in tabs of chromeWindow",
      "      if (URL of chromeTab) starts with targetUrl then",
      "        close chromeTab",
      "        return",
      "      end if",
      "    end repeat",
      "  end repeat",
      'end tell'
    ]);
  }

  async executeChromeJson(script) {
    const result = await this.executeChromeJavascript(`JSON.stringify(${script})`);
    return JSON.parse(result);
  }

  async executeChromeJavascript(script) {
    return runAppleScript([
      `set targetUrl to ${appleScriptString(this.meetUrl)}`,
      `set scriptSource to ${appleScriptString(script)}`,
      'tell application "Google Chrome"',
      "  repeat with chromeWindow in windows",
      "    repeat with chromeTab in tabs of chromeWindow",
      "      if (URL of chromeTab) starts with targetUrl then",
      "        set active tab index of chromeWindow to index of chromeTab",
      "        set index of chromeWindow to 1",
      "        tell chromeTab to return execute javascript scriptSource",
      "      end if",
      "    end repeat",
      "  end repeat",
      'end tell',
      'error "Meet tab not found."'
    ]);
  }

  requirePage() {
    if (!this.page) throw new Error("Meet page is not initialized.");
    return this.page;
  }
}

function withEnglishUiParam(meetUrl) {
  try {
    const url = new URL(meetUrl);
    url.searchParams.set("hl", "en");
    return url.toString();
  } catch {
    return meetUrl;
  }
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate a local DevTools port."));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForDevTools(port, chromeProcess) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    if (chromeProcess.exitCode !== null) {
      throw new Error(`Chrome exited before DevTools opened with code ${chromeProcess.exitCode}.`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
      lastError = new Error(`DevTools returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Chrome DevTools. ${lastError?.message || ""}`.trim());
}

function command(bin, args, { timeoutMs }) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${bin} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveCommand();
        return;
      }
      reject(new Error(`${bin} exited with code ${code}.`));
    });
  });
}

function runAppleScript(lines) {
  return new Promise((resolveScript, reject) => {
    execFile("osascript", lines.flatMap((line) => ["-e", line]), {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolveScript(stdout.trim());
    });
  });
}

function appleScriptString(value) {
  return String(value)
    .replaceAll("\r", "")
    .split("\n")
    .map((part) => `"${part.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(" & linefeed & ");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
