import { mkdir, writeFile } from "node:fs/promises";

const devtoolsUrl = process.env.CHROME_DEVTOOLS_URL ?? "http://127.0.0.1:9223";
const appUrl = process.env.WORKSPACE_URL ?? "http://127.0.0.1:3000";
const initialRequirement = "我们刚上线一个主播 1v1 PK 功能，但现在平台主播数量和观众数量都比较少。我想做一个活动促进主播使用 PK，也希望顺便验证 PK 是否能够带动礼物流水。";
const capabilityAnswer = "本次主要目标主播是已有稳定开播行为、但尚未或很少使用 1v1 PK 的主播。主播从对方资料页或直播间发起邀请，对方接受后进入 5 分钟 PK，目前没有随机匹配。双方直播间观众会直接看到 PK 状态，可以正常互动和送礼。现在能记录 PK 发起、接受、完成、参与主播数、场次、时长，以及按主播、场次和时间段关联的礼物流水，也能查同一主播非 PK 时段流水。已观察到同时在线主播少、找对手困难和功能认知低，但上线仅 7 天，暂不能判断哪个阻力最大。";
const assumptionAnswer = "目前没有足够证据判断主要原因。我明确决定本轮先按‘找对手困难是主播低参与的主要原因’这一未验证假设推进，以‘提升对手可得性和组局成功率’作为 Experiment Direction。Evidence 状态为 UNVALIDATED。后续通过实验组与对照组，验证有可用对手曝光时的邀请接受率、PK 成局率和参与主播数是否提升。请把这个决定、假设和 Validation Intent 记录进 Product Spec。";
const targetUserAnswer = "本次活动的主要目标主播明确为：已有稳定开播行为、但尚未或很少使用 1v1 PK 的主播。";
const resumeExisting = process.env.WORKSPACE_RESUME === "1";
const confirmOnly = process.env.WORKSPACE_CONFIRM_ONLY === "1";
const captureOnlyProjectId = process.env.WORKSPACE_CAPTURE_ONLY_PROJECT_ID;

async function waitForDevtools() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${devtoolsUrl}/json/version`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Chrome DevTools was not available at ${devtoolsUrl}`);
}

await waitForDevtools();
let target;
if (resumeExisting) {
  const targets = await fetch(`${devtoolsUrl}/json/list`).then(response => response.json());
  target = targets.find(item => item.type === "page" && item.url === `${appUrl}/`);
  if (!target) throw new Error("No existing Discovery Workspace browser target was found");
} else {
  const targetResponse = await fetch(`${devtoolsUrl}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" });
  if (!targetResponse.ok) throw new Error(`Unable to create browser target: ${targetResponse.status}`);
  target = await targetResponse.json();
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let commandId = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

function command(method, params = {}) {
  const id = ++commandId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return result.result.value;
}

async function waitFor(label, expression, timeoutMs = 480_000) {
  const startedAt = Date.now();
  let nextProgressAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsed >= nextProgressAt) {
      console.log(`[ui-e2e] ${label}: waiting ${elapsed}s`);
      nextProgressAt = elapsed + 15;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`${label} timed out after ${Math.floor(timeoutMs / 1000)}s`);
}

async function snapshot(label) {
  return evaluate(`(() => ({
    label: ${JSON.stringify(label)},
    status: document.querySelector('#status-badge')?.textContent?.trim(),
    revision: document.querySelector('#revision-badge')?.textContent?.trim(),
    activityVisible: !document.querySelector('#activity')?.hidden,
    error: document.querySelector('#error-panel')?.hidden ? '' : document.querySelector('#error-message')?.textContent?.trim(),
    messages: [...document.querySelectorAll('#messages .message')].map(item => ({
      role: item.querySelector('.message-role')?.textContent?.trim(),
      content: item.querySelector('.message-body')?.textContent?.trim()
    })),
    blockers: [...document.querySelectorAll('#blocking-questions .question-card')].map(item => item.textContent?.trim()),
    nonBlocking: [...document.querySelectorAll('#nonblocking-questions .question-card')].map(item => item.textContent?.trim()),
    decisions: [...document.querySelectorAll('#active-decisions .decision-card')].map(item => item.textContent?.trim()),
    spec: [...document.querySelectorAll('#spec-content .spec-section')].map(item => ({
      title: item.querySelector('h3')?.textContent?.trim(),
      content: [...item.querySelectorAll('p, li')].map(value => value.textContent?.trim()).filter(Boolean)
    })),
    confirmationVisible: !document.querySelector('#confirmation-panel')?.hidden,
    confirmedVisible: !document.querySelector('#confirmed-panel')?.hidden,
    layout: {
      conversationWidth: Math.round(document.querySelector('.conversation-panel')?.getBoundingClientRect().width || 0),
      specWidth: Math.round(document.querySelector('.spec-panel')?.getBoundingClientRect().width || 0)
    }
  }))()`);
}

async function submitMessage(text) {
  await evaluate(`(() => {
    const input = document.querySelector('#message-input');
    input.value = ${JSON.stringify(text)};
    document.querySelector('#message-form').requestSubmit();
    return true;
  })()`);
  await waitFor("message response", `(() => {
    const activity = document.querySelector('#activity');
    const error = document.querySelector('#error-panel');
    return Boolean(activity?.hidden && (error?.hidden || document.querySelector('#error-message')?.textContent));
  })()`);
}

await command("Runtime.enable");
await command("Page.enable");
await command("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await waitFor("workspace load", "document.readyState === 'complete' && Boolean(document.querySelector('#create-form'))", 30_000);

if (captureOnlyProjectId) {
  await evaluate(`(() => {
    localStorage.setItem('discoveryProjectId', ${JSON.stringify(captureOnlyProjectId)});
    location.href = '/?project=' + encodeURIComponent(${JSON.stringify(captureOnlyProjectId)});
    return true;
  })()`);
  await waitFor("confirmed project restore", "document.querySelector('#status-badge')?.textContent?.trim() === 'DISCOVERY_CONFIRMED'", 30_000);
  const restored = await snapshot("confirmed project restored from server");
  if (restored.activityVisible || restored.confirmationVisible || !restored.confirmedVisible) {
    throw new Error("Confirmed UI visibility is inconsistent after server restore");
  }
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await mkdir("reports", { recursive: true });
  await writeFile("reports/creator-pk-workspace-confirmed.png", Buffer.from(screenshot.data, "base64"));
  console.log(`[ui-e2e] PASS: restored=${restored.status}; confirmedVisible=${restored.confirmedVisible}; confirmationVisible=${restored.confirmationVisible}; activityVisible=${restored.activityVisible}`);
  socket.close();
  process.exit(0);
}

if (resumeExisting) {
  const observations = [];
  if (!confirmOnly) {
    observations.push(await snapshot("accepted assumption, target user still blocking"));
    await submitMessage(targetUserAnswer);
  }
  const ready = await snapshot("target user clarified");
  observations.push(ready);
  if (ready.status !== "READY_FOR_CONFIRMATION" || !ready.confirmationVisible) {
    throw new Error(`Expected READY_FOR_CONFIRMATION after target user clarification, received ${ready.status}; error=${ready.error}`);
  }
  await evaluate("document.querySelector('#confirm-button').click(); true");
  await waitFor("user confirmation", "document.querySelector('#status-badge')?.textContent?.trim() === 'DISCOVERY_CONFIRMED'", 30_000);
  const confirmed = await snapshot("user confirmed Discovery");
  observations.push(confirmed);
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await mkdir("reports", { recursive: true });
  await writeFile("reports/creator-pk-workspace-confirmed.png", Buffer.from(screenshot.data, "base64"));
  await writeFile("reports/creator-pk-workspace-ui-e2e.json", JSON.stringify({
    runAt: new Date().toISOString(),
    appUrl,
    resumedExistingSession: true,
    initialRequirement,
    answers: [capabilityAnswer, assumptionAnswer, targetUserAnswer],
    observations
  }, null, 2));
  console.log(`[ui-e2e] PASS: ${observations.map(item => `${item.label}=${item.status}`).join(" | ")}`);
  socket.close();
  process.exit(0);
}

const observations = [await snapshot("initial workspace")];
await evaluate(`(() => {
  document.querySelector('#project-name-input').value = 'Creator PK Discovery';
  document.querySelector('#initial-requirement').value = ${JSON.stringify(initialRequirement)};
  document.querySelector('#create-form').requestSubmit();
  return true;
})()`);
await waitFor("initial Discovery turn", `(() => {
  const activity = document.querySelector('#activity');
  return Boolean(!document.querySelector('#conversation-view')?.hidden && activity?.hidden && document.querySelectorAll('#messages .message-assistant').length >= 1);
})()`);
observations.push(await snapshot("AI asked first question"));

await submitMessage(capabilityAnswer);
const unresolved = await snapshot("friction remains unknown");
observations.push(unresolved);
if (unresolved.status !== "IN_PROGRESS") throw new Error(`Expected IN_PROGRESS before assumption acceptance, received ${unresolved.status}`);
if (unresolved.blockers.length === 0) throw new Error("Expected a visible blocking Open Question before assumption acceptance");

await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }).then(async result => {
  await mkdir("reports", { recursive: true });
  await writeFile("reports/creator-pk-workspace-blocked.png", Buffer.from(result.data, "base64"));
});

await submitMessage(assumptionAnswer);
let ready = await snapshot("assumption accepted");
if (ready.status !== "READY_FOR_CONFIRMATION") {
  await submitMessage("我确认上述假设、Evidence 状态、Experiment Direction 和 Validation Intent。本轮 Discovery 不再等待主要原因的确定性证据。请按该明确决策完成 Ready 评估。 ");
  ready = await snapshot("assumption explicitly reconfirmed");
}
observations.push(ready);
if (ready.status !== "READY_FOR_CONFIRMATION" || !ready.confirmationVisible) {
  throw new Error(`Expected a visible READY_FOR_CONFIRMATION state, received ${ready.status}; error=${ready.error}`);
}

await evaluate("document.querySelector('#confirm-button').click(); true");
await waitFor("user confirmation", "document.querySelector('#status-badge')?.textContent?.trim() === 'DISCOVERY_CONFIRMED'", 30_000);
const confirmed = await snapshot("user confirmed Discovery");
observations.push(confirmed);
if (!confirmed.confirmedVisible) throw new Error("Confirmed state was not visible in the Workspace");

const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await mkdir("reports", { recursive: true });
await writeFile("reports/creator-pk-workspace-confirmed.png", Buffer.from(screenshot.data, "base64"));
await writeFile("reports/creator-pk-workspace-ui-e2e.json", JSON.stringify({
  runAt: new Date().toISOString(),
  appUrl,
  initialRequirement,
  answers: [capabilityAnswer, assumptionAnswer],
  observations
}, null, 2));

console.log(`[ui-e2e] PASS: ${observations.map(item => `${item.label}=${item.status}`).join(" | ")}`);
socket.close();
