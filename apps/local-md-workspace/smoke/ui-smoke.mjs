import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SMOKE_URL = process.env.LOCAL_MD_WORKSPACE_SMOKE_URL || "http://127.0.0.1:5173/";
const DROPBOX_CONFIG_KEY = "local-md-workspace:dropbox-config";
const DROPBOX_OAUTH_MESSAGE = "local-md-workspace:dropbox-oauth";
const dropboxAccessToken =
  process.env.LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN || process.env.OPENDAL_DROPBOX_ACCESS_TOKEN;
const dropboxRoot =
  process.env.LOCAL_MD_WORKSPACE_DROPBOX_ROOT || process.env.OPENDAL_DROPBOX_ROOT || "";
const shareRelayOrigin = process.env.VITE_LOCAL_MD_SHARE_RELAY_ORIGIN || "";

let chromePath = findChromePath();
if (!chromePath) {
  throw new Error(
    "Chromium was not found. Set CHROME_PATH or install Playwright's Chromium cache first.",
  );
}

let userDataDir = await mkdtemp(join(tmpdir(), "local-md-workspace-smoke-"));
let chrome = execFile(chromePath, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "--no-default-browser-check",
  "--no-first-run",
  "about:blank",
]);

try {
  let browserWs = await waitForDevToolsEndpoint(chrome);
  let client = await createCdpClient(browserWs);
  let { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  let { sessionId } = await client.send("Target.attachToTarget", {
    flatten: true,
    targetId,
  });

  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await installMockFileSystemAccess(client, sessionId);

  await navigate(client, sessionId, SMOKE_URL);
  await assertLocalWorkspaceFlow(client, sessionId);
  await assertOwnerReconnectSharedFileFlow(client);
  await assertOwnerExternalConflictFlow(client);
  await assertInitialDropboxUi(client, sessionId);
  await assertNoDropboxConfigFields(client, sessionId);

  await client.evaluate(
    `
      localStorage.setItem(${JSON.stringify(DROPBOX_CONFIG_KEY)}, JSON.stringify({
        appKey: "stored-app-key",
        root: "notes/smoke"
      }));
    `,
    sessionId,
  );
  await navigate(client, sessionId, SMOKE_URL);
  await assertSavedDropboxConfigUi(client, sessionId);
  await assertNoDropboxConfigFields(client, sessionId);
  await assertRealDropboxWorkspaceFlow(client, sessionId);
  await assertMockDropboxWorkspaceFlow(client, sessionId);

  await client.send("Browser.close");
  console.log(`Grove workspace UI smoke passed at ${SMOKE_URL}`);
} finally {
  if (!chrome.killed) chrome.kill("SIGTERM");
  await rm(userDataDir, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  });
}

async function navigate(client, sessionId, url) {
  await client.send("Page.navigate", { url }, sessionId);
  await client.waitForEvent("Page.loadEventFired", sessionId);
  await waitForSettledUi();
}

async function attachNewTarget(client, url, { isolated = false, waitForLoad = true } = {}) {
  let browserContextId = null;
  if (isolated) {
    browserContextId = (await client.send("Target.createBrowserContext")).browserContextId;
  }

  let { targetId } = await client.send("Target.createTarget", {
    ...(browserContextId ? { browserContextId } : {}),
    url,
  });
  let { sessionId } = await client.send("Target.attachToTarget", {
    flatten: true,
    targetId,
  });

  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  if (waitForLoad) await client.waitForEvent("Page.loadEventFired", sessionId);
  await waitForSettledUi();
  return { browserContextId, sessionId, targetId };
}

async function attachLocalWorkspaceTarget(client) {
  let target = await attachNewTarget(client, "about:blank", { waitForLoad: false });
  await installMockFileSystemAccess(client, target.sessionId);
  await navigate(client, target.sessionId, SMOKE_URL);
  return target;
}

async function assertInitialDropboxUi(client, sessionId) {
  let state = await client.evaluate(
    `
      (() => ({
        body: document.body.innerText,
        hasRoot: Boolean(document.querySelector("#root")),
        title: document.title
      }))()
    `,
    sessionId,
  );

  if (!state.hasRoot || !state.body.includes("Connect Dropbox mirror")) {
    throw new Error(
      `Initial workspace UI did not render Dropbox controls: ${JSON.stringify(state)}`,
    );
  }
}

async function assertLocalWorkspaceFlow(client, sessionId) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.includes("Open folder") && !item.disabled
        );
        if (!button) throw new Error("Open folder button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );

  await client.waitForPredicate(
    `document.body.innerText.includes("Smoke Workspace") && Array.from(document.querySelectorAll("button")).some((button) => button.textContent.trim() == "New file" && !button.disabled)`,
    sessionId,
  );

  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.trim() == "New file" && !item.disabled
        );
        if (!button) throw new Error("New file button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#markdown-file-name"))`,
    sessionId,
  );

  await client.evaluate(
    `
      (() => {
        let input = document.querySelector("#markdown-file-name");
        let setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "smoke-local");
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        let create = Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent.trim() == "Create"
        );
        if (!create) throw new Error("Create button was not found.");
        create.click();
      })()
    `,
    sessionId,
  );

  await client.waitForPredicate(
    `Boolean(document.querySelector("live-md-editor")?.value?.includes("# smoke local"))`,
    sessionId,
  );

  let nextValue = "# smoke local\\n\\nEdited by local UI smoke.\\n";
  await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        if (!editor) throw new Error("live-md-editor was not found.");
        editor.value = ${JSON.stringify(nextValue)};
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      })()
    `,
    sessionId,
  );

  await client.waitForPredicate(
    `window.__localMdSmokeFiles?.get("smoke-local.md") == ${JSON.stringify(nextValue)}`,
    sessionId,
    3_000,
  );

  let state = await client.evaluate(
    `
      (() => ({
        body: document.body.innerText,
        savedValue: window.__localMdSmokeFiles?.get("smoke-local.md") ?? null
      }))()
    `,
    sessionId,
  );

  if (!state.body.includes("Saved") || state.savedValue != nextValue) {
    throw new Error(
      `Local workspace flow did not save through the backend: ${JSON.stringify(state)}`,
    );
  }

  await assertSharedFileGuestEdit(client, sessionId, {
    expectedInitialValue: nextValue,
    nextValue: "# smoke local\n\nEdited by shared-file UI smoke.\n",
    waitForOwnerSave: () =>
      client.waitForPredicate(
        `window.__localMdSmokeFiles?.get("smoke-local.md") == ${JSON.stringify(
          "# smoke local\n\nEdited by shared-file UI smoke.\n",
        )}`,
        sessionId,
        10_000,
      ),
  });
  await assertSharedFileLifecycle(client, sessionId, {
    expectedValue: "# smoke local\n\nEdited by shared-file UI smoke.\n",
  });
}

async function assertOwnerReconnectSharedFileFlow(client) {
  if (!shareRelayOrigin) {
    console.log(
      "Skipping owner reconnect shared-file UI smoke: VITE_LOCAL_MD_SHARE_RELAY_ORIGIN is not set.",
    );
    return;
  }

  let fileBaseName = `owner-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let fileName = `${fileBaseName}.md`;
  let initialValue = `# Owner reconnect smoke\n\nCreated before the host goes offline.\n`;
  let sharedValue = `# Owner reconnect smoke\n\nGuest edit while the host is offline.\n`;
  let firstOwner = await attachLocalWorkspaceTarget(client);
  let guest = null;
  let secondOwner = null;

  try {
    await openMockLocalWorkspace(client, firstOwner.sessionId);
    await createAndEditLocalFile(client, firstOwner.sessionId, fileBaseName, initialValue);
    let link = await createSharedFileLink(client, firstOwner.sessionId);

    await client.send("Target.closeTarget", { targetId: firstOwner.targetId });
    firstOwner = null;
    await waitForSettledUi(500);

    guest = await attachNewTarget(client, link, { isolated: true });
    await client.waitForPredicate(
      `document.querySelector("live-md-editor")?.value == ${JSON.stringify(initialValue)}`,
      guest.sessionId,
      10_000,
    );
    await client.evaluate(
      `
        (() => {
          let editor = document.querySelector("live-md-editor");
          if (!editor) throw new Error("guest live-md-editor was not found.");
          editor.value = ${JSON.stringify(sharedValue)};
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        })()
      `,
      guest.sessionId,
    );
    await client.waitForPredicate(
      `document.body.innerText.includes("Waiting for host")`,
      guest.sessionId,
      15_000,
    );

    secondOwner = await attachLocalWorkspaceTarget(client);
    await openMockLocalWorkspace(client, secondOwner.sessionId);
    await selectWorkspaceFile(client, secondOwner.sessionId, fileName);
    try {
      await client.waitForPredicate(
        `window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) == ${JSON.stringify(
          sharedValue,
        )}`,
        secondOwner.sessionId,
        15_000,
      );
    } catch (error) {
      let state = await client.evaluate(
        `
          (() => ({
            body: document.body.innerText,
            editorValue: document.querySelector("live-md-editor")?.value ?? null,
            fileValue: window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) ?? null,
            hostSecrets: Object.keys(localStorage).filter((key) =>
              key.startsWith("local-md-workspace:share-host-secret:")
            ),
            files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []).map(([name, value]) => [
              name,
              typeof value == "string" ? value.slice(0, 200) : "<" + value.byteLength + " bytes>"
            ])
          }))()
        `,
        secondOwner.sessionId,
      );
      let guestState = guest
        ? await client
            .evaluate(
              `
                (() => ({
                  body: document.body.innerText,
                  editorValue: document.querySelector("live-md-editor")?.value ?? null
                }))()
              `,
              guest.sessionId,
            )
            .catch(() => null)
        : null;
      throw new Error(
        `${error.message}\n\nOwner reconnect state:\n${JSON.stringify(
          state,
          null,
          2,
        )}\n\nGuest state:\n${JSON.stringify(guestState, null, 2)}`,
      );
    }
    await client.waitForPredicate(
      `document.body.innerText.includes("Saved to host")`,
      guest.sessionId,
      15_000,
    );
  } finally {
    if (guest) {
      await client.send("Target.closeTarget", { targetId: guest.targetId }).catch(() => {});
      if (guest.browserContextId) {
        await client
          .send("Target.disposeBrowserContext", { browserContextId: guest.browserContextId })
          .catch(() => {});
      }
    }
    if (secondOwner) {
      await client.send("Target.closeTarget", { targetId: secondOwner.targetId }).catch(() => {});
    }
    if (firstOwner) {
      await client.send("Target.closeTarget", { targetId: firstOwner.targetId }).catch(() => {});
    }
  }

  console.log("Owner reconnect shared-file UI smoke passed.");
}

async function assertOwnerExternalConflictFlow(client) {
  if (!shareRelayOrigin) {
    console.log(
      "Skipping owner external-conflict shared-file UI smoke: VITE_LOCAL_MD_SHARE_RELAY_ORIGIN is not set.",
    );
    return;
  }

  let fileBaseName = `owner-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let fileName = `${fileBaseName}.md`;
  let initialValue = "# Owner conflict smoke\n\nInitial host version.\n";
  let externalValue = "# Owner conflict smoke\n\nExternal source edit.\n";
  let sharedValue = "# Owner conflict smoke\n\nGuest relay edit while host is offline.\n";
  let firstOwner = await attachLocalWorkspaceTarget(client);
  let guest = null;
  let secondOwner = null;

  try {
    await openMockLocalWorkspace(client, firstOwner.sessionId);
    await createAndEditLocalFile(client, firstOwner.sessionId, fileBaseName, initialValue);
    let link = await createSharedFileLink(client, firstOwner.sessionId);

    await client.send("Target.closeTarget", { targetId: firstOwner.targetId });
    firstOwner = null;
    await waitForSettledUi(500);

    guest = await attachNewTarget(client, link, { isolated: true });
    await client.waitForPredicate(
      `document.querySelector("live-md-editor")?.value == ${JSON.stringify(initialValue)}`,
      guest.sessionId,
      10_000,
    );
    await client.evaluate(
      `
        (() => {
          let editor = document.querySelector("live-md-editor");
          if (!editor) throw new Error("guest live-md-editor was not found.");
          editor.value = ${JSON.stringify(sharedValue)};
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        })()
      `,
      guest.sessionId,
    );
    await client.waitForPredicate(
      `document.body.innerText.includes("Waiting for host")`,
      guest.sessionId,
      15_000,
    );

    secondOwner = await attachLocalWorkspaceTarget(client);
    await client.evaluate(
      `window.__localMdSmokeSetFile(${JSON.stringify(fileName)}, ${JSON.stringify(externalValue)})`,
      secondOwner.sessionId,
    );
    await openMockLocalWorkspace(client, secondOwner.sessionId);
    await selectWorkspaceFile(client, secondOwner.sessionId, fileName, {
      expectedEditorText: "Owner conflict smoke",
    });
    await client.waitForPredicate(
      `document.body.innerText.includes("Shared file conflict") && document.body.innerText.includes("Save shared copy")`,
      secondOwner.sessionId,
      15_000,
    );
    await client.waitForPredicate(
      `window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) == ${JSON.stringify(
        externalValue,
      )}`,
      secondOwner.sessionId,
      3_000,
    );
    let guestBeforeResolution = await client.evaluate("document.body.innerText", guest.sessionId);
    if (guestBeforeResolution.includes("Saved to host")) {
      throw new Error("Guest saw Saved to host before the owner resolved the source conflict.");
    }

    await clickShareDialogButton(client, secondOwner.sessionId, "Save shared copy");
    try {
      await client.waitForPredicate(
        `
          (() => Array.from(window.__localMdSmokeFiles?.entries?.() ?? []).some(([name, value]) =>
            name.includes(".shared-conflict-") && value == ${JSON.stringify(sharedValue)}
          ))()
        `,
        secondOwner.sessionId,
        10_000,
      );
    } catch (error) {
      let state = await client.evaluate(
        `
          (() => ({
            body: document.body.innerText,
            editorValue: document.querySelector("live-md-editor")?.value ?? null,
            fileValue: window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) ?? null,
            files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []).map(([name, value]) => [
              name,
              typeof value == "string" ? value.slice(0, 500) : "<" + value.byteLength + " bytes>"
            ])
          }))()
        `,
        secondOwner.sessionId,
      );
      throw new Error(
        `${error.message}\n\nOwner conflict resolution state:\n${JSON.stringify(state, null, 2)}`,
      );
    }
    await client.waitForPredicate(
      `window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) == ${JSON.stringify(
        externalValue,
      )}`,
      secondOwner.sessionId,
      5_000,
    );
    await client.waitForPredicate(
      `document.body.innerText.includes("Saved to host")`,
      guest.sessionId,
      15_000,
    );
  } finally {
    if (guest) await closeTarget(client, guest);
    if (secondOwner) await closeTarget(client, secondOwner);
    if (firstOwner) await closeTarget(client, firstOwner);
  }

  console.log("Owner external-conflict shared-file UI smoke passed.");
}

async function assertSavedDropboxConfigUi(client, sessionId) {
  let body = await client.evaluate("document.body.innerText", sessionId);
  if (!body.includes("Reconnect Dropbox mirror")) {
    throw new Error("Stored Dropbox config did not expose a reconnect action.");
  }
}

async function assertNoDropboxConfigFields(client, sessionId) {
  let state = await client.evaluate(
    `
      (() => ({
        appKeyInput: Boolean(document.querySelector("#dropbox-app-key")),
        rootInput: Boolean(document.querySelector("#dropbox-root"))
      }))()
    `,
    sessionId,
  );

  if (state.appKeyInput || state.rootInput) {
    throw new Error(`Dropbox config fields should not be exposed: ${JSON.stringify(state)}`);
  }
}

async function assertRealDropboxWorkspaceFlow(client, sessionId) {
  if (!dropboxAccessToken) {
    console.log(
      "Skipping real Dropbox mirror UI smoke: LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN and OPENDAL_DROPBOX_ACCESS_TOKEN are not set.",
    );
    return;
  }

  let fileName = `local-md-workspace-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
  let filePath = dropboxApiPath(fileName);
  let nextValue = `# Dropbox UI smoke\\n\\n${fileName}\\n`;

  try {
    await installDropboxOAuthStub(client, sessionId);
    await navigate(client, sessionId, SMOKE_URL);
    await client.evaluate(
      "localStorage.removeItem(" + JSON.stringify(DROPBOX_CONFIG_KEY) + ")",
      sessionId,
    );
    await navigate(client, sessionId, SMOKE_URL);
    await connectDropboxWorkspace(client, sessionId);
    await createAndEditDropboxFile(client, sessionId, fileName, nextValue);
    await waitForDropboxFileValue(filePath, nextValue);
    await assertSharedFileGuestEdit(client, sessionId, {
      expectedInitialValue: nextValue,
      nextValue: `# Dropbox UI smoke\n\nShared edit for ${fileName}\n`,
      waitForOwnerSave: () =>
        waitForDropboxFileValue(filePath, `# Dropbox UI smoke\n\nShared edit for ${fileName}\n`),
    });
  } finally {
    await deleteDropboxFile(filePath).catch(() => {});
  }
}

async function assertMockDropboxWorkspaceFlow(client, sessionId) {
  let fileName = `mock-dropbox-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
  let nextValue = `# Mock Dropbox UI smoke\\n\\n${fileName}\\n`;
  let sharedValue = `# Mock Dropbox UI smoke\\n\\nShared edit for ${fileName}\\n`;

  await installDropboxOAuthStub(client, sessionId, "mock-dropbox-token");
  await installMockDropboxOperator(client, sessionId);
  await navigate(client, sessionId, SMOKE_URL);
  await client.evaluate(
    "localStorage.removeItem(" + JSON.stringify(DROPBOX_CONFIG_KEY) + ")",
    sessionId,
  );
  await navigate(client, sessionId, SMOKE_URL);
  await connectDropboxWorkspace(client, sessionId);
  await createAndEditDropboxFile(client, sessionId, fileName, nextValue);
  await waitForMockDropboxFileValue(client, sessionId, fileName, nextValue);
  await assertSharedFileGuestEdit(client, sessionId, {
    expectedInitialValue: nextValue,
    nextValue: sharedValue,
    waitForOwnerSave: () => waitForMockDropboxFileValue(client, sessionId, fileName, sharedValue),
  });
  console.log("Mock Dropbox mirror shared-file UI smoke passed.");
}

async function assertSharedFileGuestEdit(
  client,
  ownerSessionId,
  { expectedInitialValue, nextValue, waitForOwnerSave },
) {
  if (!shareRelayOrigin) {
    console.log("Skipping shared-file UI smoke: VITE_LOCAL_MD_SHARE_RELAY_ORIGIN is not set.");
    return;
  }

  let link = await createSharedFileLink(client, ownerSessionId);

  let guest = await attachNewTarget(client, link, { isolated: true });
  try {
    await client.waitForPredicate(
      `Boolean(document.querySelector("live-md-editor"))`,
      guest.sessionId,
    );
    await client.waitForPredicate(
      `document.querySelector("live-md-editor")?.value == ${JSON.stringify(expectedInitialValue)}`,
      guest.sessionId,
      10_000,
    );
    await client.evaluate(
      `
        (() => {
          let editor = document.querySelector("live-md-editor");
          if (!editor) throw new Error("guest live-md-editor was not found.");
          editor.value = ${JSON.stringify(nextValue)};
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        })()
      `,
      guest.sessionId,
    );
    await waitForOwnerSave();
    await client.waitForPredicate(
      `document.body.innerText.includes("Saved to host")`,
      guest.sessionId,
      15_000,
    );
  } finally {
    await client.send("Target.closeTarget", { targetId: guest.targetId }).catch(() => {});
    if (guest.browserContextId) {
      await client
        .send("Target.disposeBrowserContext", { browserContextId: guest.browserContextId })
        .catch(() => {});
    }
  }

  console.log("Shared-file UI smoke passed.");
}

async function assertSharedFileLifecycle(client, ownerSessionId, { expectedValue }) {
  if (!shareRelayOrigin) {
    console.log(
      "Skipping shared-file lifecycle UI smoke: VITE_LOCAL_MD_SHARE_RELAY_ORIGIN is not set.",
    );
    return;
  }

  let oldLink = await sharedFileDialogLink(client, ownerSessionId);
  await clickShareDialogButton(client, ownerSessionId, "Rotate link");
  await client.waitForPredicate(
    `document.querySelector("#shared-file-link")?.value && document.querySelector("#shared-file-link")?.value != ${JSON.stringify(
      oldLink,
    )}`,
    ownerSessionId,
    10_000,
  );
  let newLink = await sharedFileDialogLink(client, ownerSessionId);

  let oldGuest = await attachNewTarget(client, oldLink, { isolated: true });
  try {
    await client.waitForPredicate(
      `document.body.innerText.includes("Could not join shared file") && !document.querySelector("live-md-editor")`,
      oldGuest.sessionId,
      10_000,
    );
  } finally {
    await closeTarget(client, oldGuest);
  }

  let activeGuest = await attachNewTarget(client, newLink, { isolated: true });
  try {
    await client.waitForPredicate(
      `document.querySelector("live-md-editor")?.value == ${JSON.stringify(expectedValue)}`,
      activeGuest.sessionId,
      10_000,
    );
    await clickShareDialogButton(client, ownerSessionId, "Stop sharing");
    await client.waitForPredicate(
      `document.body.innerText.includes("Sharing stopped") || document.body.innerText.includes("Sharing has been stopped") || document.body.innerText.includes("Shared file access was rejected")`,
      activeGuest.sessionId,
      10_000,
    );
  } finally {
    await closeTarget(client, activeGuest);
  }

  console.log("Shared-file lifecycle UI smoke passed.");
}

async function sharedFileDialogLink(client, sessionId) {
  let link = await client.evaluate(
    `document.querySelector("#shared-file-link")?.value ?? ""`,
    sessionId,
  );
  if (!link || !link.includes("/share/") || !link.includes("#key=")) {
    throw new Error(`Shared file link was not available: ${link}`);
  }
  return link;
}

async function clickShareDialogButton(client, sessionId, label) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.trim() == ${JSON.stringify(label)} && !item.disabled
        );
        if (!button) throw new Error(${JSON.stringify(`${label} button was not found.`)});
        button.click();
      })()
    `,
    sessionId,
  );
}

async function closeTarget(client, target) {
  await client.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  if (target.browserContextId) {
    await client
      .send("Target.disposeBrowserContext", { browserContextId: target.browserContextId })
      .catch(() => {});
  }
}

async function createSharedFileLink(client, ownerSessionId) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.includes("Share file") && !item.disabled
        );
        if (!button) throw new Error("Share file button was not found.");
        button.click();
      })()
    `,
    ownerSessionId,
  );
  await client.waitForPredicate(
    `document.body.innerText.includes("Anyone with this link can edit")`,
    ownerSessionId,
  );
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.trim() == "Create link" && !item.disabled
        );
        if (!button) throw new Error("Create link button was not found.");
        button.click();
      })()
    `,
    ownerSessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#shared-file-link")?.value)`,
    ownerSessionId,
    10_000,
  );
  let link = await client.evaluate(
    `document.querySelector("#shared-file-link")?.value ?? ""`,
    ownerSessionId,
  );
  if (!link || !link.includes("/share/") || !link.includes("#key=")) {
    throw new Error(`Shared file link was not generated: ${link}`);
  }
  return link;
}

async function openMockLocalWorkspace(client, sessionId) {
  let hasWorkspace = await client.evaluate(
    `document.body.innerText.includes("Smoke Workspace")`,
    sessionId,
  );
  if (!hasWorkspace) {
    await client.evaluate(
      `
        (() => {
          let button = Array.from(document.querySelectorAll("button")).find((item) =>
            item.textContent.includes("Open folder") && !item.disabled
          );
          if (!button) throw new Error("Open folder button was not found.");
          button.click();
        })()
      `,
      sessionId,
    );
  }
  await client.waitForPredicate(`document.body.innerText.includes("Smoke Workspace")`, sessionId);
}

async function createAndEditLocalFile(client, sessionId, fileBaseName, nextValue) {
  let fileName = fileBaseName.endsWith(".md") ? fileBaseName : `${fileBaseName}.md`;
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.trim() == "New file" && !item.disabled
        );
        if (!button) throw new Error("New file button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#markdown-file-name"))`,
    sessionId,
  );
  await client.evaluate(
    `
      (() => {
        let input = document.querySelector("#markdown-file-name");
        let setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(fileBaseName)});
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        let create = Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent.trim() == "Create"
        );
        if (!create) throw new Error("Create button was not found.");
        create.click();
      })()
    `,
    sessionId,
  );
  try {
    await client.waitForPredicate(`Boolean(document.querySelector("live-md-editor"))`, sessionId);
  } catch (error) {
    let state = await client.evaluate(
      `
        (() => ({
          body: document.body.innerText,
          files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []).map(([name, value]) => [
            name,
            typeof value == "string" ? value.slice(0, 200) : "<" + value.byteLength + " bytes>"
          ]),
          treeHtml: document.querySelector(".local-md-file-tree")?.innerHTML ?? ""
        }))()
      `,
      sessionId,
    );
    throw new Error(`${error.message}\n\nLocal create state:\n${JSON.stringify(state, null, 2)}`);
  }

  await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        if (!editor) throw new Error("live-md-editor was not found.");
        editor.value = ${JSON.stringify(nextValue)};
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `window.__localMdSmokeFiles?.get(${JSON.stringify(fileName)}) == ${JSON.stringify(nextValue)}`,
    sessionId,
    5_000,
  );
}

async function selectWorkspaceFile(
  client,
  sessionId,
  fileName,
  { expectedEditorText = "Owner reconnect smoke" } = {},
) {
  await client.waitForPredicate(
    `window.__localMdSmokeFiles?.has(${JSON.stringify(
      fileName,
    )}) && Boolean(document.querySelector(".local-md-file-tree"))`,
    sessionId,
  );
  let clicked = await clickWorkspaceFileRow(client, sessionId, fileName);
  if (!clicked) {
    let state = await localFileTreeState(client, sessionId);
    throw new Error(
      `Could not click file ${fileName} in workspace tree.\n\nCurrent state:\n${JSON.stringify(
        state,
        null,
        2,
      )}`,
    );
  }
  await client.waitForPredicate(
    `document.querySelector("live-md-editor")?.value?.includes(${JSON.stringify(
      expectedEditorText,
    )})`,
    sessionId,
    10_000,
  );
}

async function clickWorkspaceFileRow(client, sessionId, fileName) {
  let target = await client.evaluate(
    `
      (() => {
        let files = Array.from(window.__localMdSmokeFiles?.keys?.() ?? [])
          .filter((name) => name.endsWith(".md"))
          .sort((left, right) => left.localeCompare(right, undefined, {
            numeric: true,
            sensitivity: "base"
          }));
        let index = files.indexOf(${JSON.stringify(fileName)});
        let tree = document.querySelector(".local-md-file-tree");
        if (index == -1 || !tree) return null;
        let rect = tree.getBoundingClientRect();
        return {
          x: Math.floor(rect.left + Math.min(120, Math.max(24, rect.width / 2))),
          y: Math.floor(rect.top + 12 + index * 24)
        };
      })()
    `,
    sessionId,
  );
  if (!target) return false;

  await client.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      x: target.x,
      y: target.y,
    },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    {
      button: "left",
      clickCount: 1,
      type: "mousePressed",
      x: target.x,
      y: target.y,
    },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      x: target.x,
      y: target.y,
    },
    sessionId,
  );
  return true;
}

async function localFileTreeState(client, sessionId) {
  return client.evaluate(
    `
      (() => ({
        body: document.body.innerText,
        files: Array.from(window.__localMdSmokeFiles?.entries?.() ?? []).map(([name, value]) => [
          name,
          typeof value == "string" ? value.slice(0, 200) : "<" + value.byteLength + " bytes>"
        ]),
        treeHtml: document.querySelector(".local-md-file-tree")?.innerHTML ?? ""
      }))()
    `,
    sessionId,
  );
}

async function connectDropboxWorkspace(client, sessionId) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.includes("Connect Dropbox mirror") && !item.disabled
        );
        if (!button) throw new Error("Connect Dropbox mirror button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );

  try {
    await client.waitForPredicate(
      `document.body.innerText.includes("Dropbox mirror connected") || document.body.innerText.includes("Dropbox mirror ·") || (document.body.innerText.includes("Dropbox mirror") && document.body.innerText.includes("No markdown files") && Array.from(document.querySelectorAll("button")).some((button) => button.textContent.trim() == "New file" && !button.disabled))`,
      sessionId,
      20_000,
    );
  } catch (error) {
    let body = await client.evaluate("document.body.innerText", sessionId).catch(() => "");
    throw new Error(`${error.message}\n\nCurrent body:\n${body}`);
  }
}

async function createAndEditDropboxFile(client, sessionId, fileName, nextValue) {
  await client.evaluate(
    `
      (() => {
        let button = Array.from(document.querySelectorAll("button")).find((item) =>
          item.textContent.trim() == "New file" && !item.disabled
        );
        if (!button) throw new Error("New file button was not found.");
        button.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(
    `Boolean(document.querySelector("#markdown-file-name"))`,
    sessionId,
  );
  await client.evaluate(
    `
      (() => {
        let input = document.querySelector("#markdown-file-name");
        let setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(fileName)});
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        let create = Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent.trim() == "Create"
        );
        if (!create) throw new Error("Create button was not found.");
        create.click();
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(`Boolean(document.querySelector("live-md-editor"))`, sessionId);

  await client.evaluate(
    `
      (() => {
        let editor = document.querySelector("live-md-editor");
        if (!editor) throw new Error("live-md-editor was not found.");
        editor.value = ${JSON.stringify(nextValue)};
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      })()
    `,
    sessionId,
  );
  await client.waitForPredicate(`document.body.innerText.includes("Saved")`, sessionId, 20_000);
}

async function createCdpClient(browserWs) {
  let ws = new WebSocket(browserWs);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let events = [];
  let nextId = 1;
  let pending = new Map();

  ws.addEventListener("message", (event) => {
    let message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      let { reject, resolve } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    events.push(message);
  });

  return {
    evaluate(expression, sessionId) {
      return this.send(
        "Runtime.evaluate",
        {
          awaitPromise: true,
          expression,
          returnByValue: true,
        },
        sessionId,
      ).then((result) => {
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ||
              result.exceptionDetails.exception?.value ||
              result.exceptionDetails.text ||
              "Runtime evaluation failed.",
          );
        }
        return result.result.value;
      });
    },
    send(method, params = {}, sessionId) {
      let id = nextId++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { reject, resolve }));
    },
    waitForEvent(method, sessionId, timeout = 10_000) {
      return new Promise((resolve, reject) => {
        let timer = setTimeout(() => {
          clearInterval(interval);
          reject(new Error(`Timed out waiting for ${method}.`));
        }, timeout);
        let interval = setInterval(() => {
          let index = events.findIndex(
            (event) => event.method == method && (!sessionId || event.sessionId == sessionId),
          );
          if (index == -1) return;
          clearInterval(interval);
          clearTimeout(timer);
          resolve(events.splice(index, 1)[0]);
        }, 25);
      });
    },
    async waitForPredicate(expression, sessionId, timeout = 10_000) {
      let started = Date.now();
      while (Date.now() - started < timeout) {
        if (await this.evaluate(`Boolean(${expression})`, sessionId)) return;
        await waitForSettledUi(50);
      }
      throw new Error(`Timed out waiting for predicate: ${expression}`);
    },
  };
}

async function installMockFileSystemAccess(client, sessionId) {
  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        (() => {
          let smokeStorageKey = "local-md-workspace:smoke-files";
          let smokeDirectoriesKey = "local-md-workspace:smoke-directories";
          try {
            Object.defineProperty(window, "indexedDB", {
              configurable: true,
              value: undefined
            });
          } catch {}

          function encodeBytes(bytes) {
            let binary = "";
            for (let byte of bytes) binary += String.fromCharCode(byte);
            return btoa(binary);
          }

          function decodeBytes(value) {
            let binary = atob(value);
            let bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
              bytes[index] = binary.charCodeAt(index);
            }
            return bytes;
          }

          function serializeValue(value) {
            if (typeof value == "string") return { kind: "text", value };
            return { kind: "bytes", value: encodeBytes(value) };
          }

          function deserializeValue(value) {
            if (value?.kind == "text" && typeof value.value == "string") return value.value;
            if (value?.kind == "bytes" && typeof value.value == "string") {
              return decodeBytes(value.value);
            }
            return "";
          }

          function loadSmokeFiles() {
            try {
              let raw = localStorage.getItem(smokeStorageKey);
              if (raw) {
                return new Map(JSON.parse(raw).map(([name, value]) => [name, deserializeValue(value)]));
              }
            } catch {}

            let files = new Map([["welcome.md", "# Welcome\\n"]]);
            persistSmokeFiles(files);
            return files;
          }

          function loadSmokeDirectories(files) {
            let directories = new Set();
            try {
              let raw = localStorage.getItem(smokeDirectoriesKey);
              if (raw) {
                for (let path of JSON.parse(raw)) directories.add(String(path));
              }
            } catch {}

            for (let path of files.keys()) ensureParents(directories, path);
            return directories;
          }

          function persistSmokeFiles(files) {
            localStorage.setItem(
              smokeStorageKey,
              JSON.stringify(Array.from(files.entries()).map(([name, value]) => [name, serializeValue(value)]))
            );
          }

          function persistSmokeDirectories(directories) {
            localStorage.setItem(smokeDirectoriesKey, JSON.stringify(Array.from(directories)));
          }

          function normalize(path) {
            return String(path || "").trim().replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "");
          }

          function joinPath(parent, name) {
            let normalizedName = normalize(name);
            return parent ? parent + "/" + normalizedName : normalizedName;
          }

          function parentPath(path) {
            let normalized = normalize(path);
            let index = normalized.lastIndexOf("/");
            return index == -1 ? "" : normalized.slice(0, index);
          }

          function ensureParents(directories, path) {
            let current = "";
            for (let part of parentPath(path).split("/").filter(Boolean)) {
              current = current ? current + "/" + part : part;
              directories.add(current);
            }
          }

          function directoryExists(files, directories, path) {
            let normalized = normalize(path);
            if (!normalized) return true;
            if (directories.has(normalized)) return true;
            for (let filePath of files.keys()) {
              if (filePath.startsWith(normalized + "/")) return true;
            }
            return false;
          }

          function bytesFromBufferSource(data) {
            if (data instanceof Uint8Array) return new Uint8Array(data);
            if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
            if (ArrayBuffer.isView(data)) {
              return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
            }
            return null;
          }

          function concatBytes(chunks) {
            let encoder = new TextEncoder();
            let byteChunks = chunks.map((chunk) =>
              typeof chunk == "string" ? encoder.encode(chunk) : chunk
            );
            let length = byteChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
            let result = new Uint8Array(length);
            let offset = 0;
            for (let chunk of byteChunks) {
              result.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return result;
          }

          class SmokeFileHandle {
            kind = "file";
            constructor(name, files, path = name) {
              this.name = name;
              this.files = files;
              this.path = path;
            }
            async getFile() {
              let value = this.files.get(this.path) ?? "";
              return new File([value], this.name, {
                type: this.name.endsWith(".md") ? "text/markdown" : "application/octet-stream"
              });
            }
            async createWritable() {
              let chunks = [];
              return {
                abort: async () => {
                  chunks = [];
                },
                close: async () => {
                  this.files.set(
                    this.path,
                    chunks.every((chunk) => typeof chunk == "string")
                      ? chunks.join("")
                      : concatBytes(chunks)
                  );
                  persistSmokeFiles(this.files);
                },
                write: async (data) => {
                  if (typeof data == "string") {
                    chunks.push(data);
                  } else if (data instanceof Blob) {
                    chunks.push(new Uint8Array(await data.arrayBuffer()));
                  } else {
                    chunks.push(bytesFromBufferSource(data) ?? new TextEncoder().encode(String(data)));
                  }
                }
              };
            }
          }

          class SmokeDirectoryHandle {
            kind = "directory";
            constructor(name, files = new Map(), directories = new Set(), path = "") {
              this.name = name;
              this.files = files;
              this.directories = directories;
              this.path = path;
            }
            async queryPermission() {
              return "granted";
            }
            async requestPermission() {
              return "granted";
            }
            async getDirectoryHandle(name, options = {}) {
              let path = joinPath(this.path, name);
              if (this.files.has(path)) throw new DOMException("Entry is a file.", "TypeMismatchError");
              if (options.create) {
                ensureParents(this.directories, path);
                this.directories.add(path);
                persistSmokeDirectories(this.directories);
              } else if (!directoryExists(this.files, this.directories, path)) {
                throw new DOMException("Directory not found.", "NotFoundError");
              }
              return new SmokeDirectoryHandle(name, this.files, this.directories, path);
            }
            async getFileHandle(name, options = {}) {
              let path = joinPath(this.path, name);
              if (directoryExists(this.files, this.directories, path)) {
                throw new DOMException("Entry is a directory.", "TypeMismatchError");
              }
              if (!this.files.has(path)) {
                if (!options.create) throw new DOMException("File not found.", "NotFoundError");
                ensureParents(this.directories, path);
                this.files.set(path, "");
                persistSmokeFiles(this.files);
                persistSmokeDirectories(this.directories);
              }
              return new SmokeFileHandle(name, this.files, path);
            }
            async removeEntry(name, options = {}) {
              let path = joinPath(this.path, name);
              if (this.files.delete(path)) {
                persistSmokeFiles(this.files);
                return;
              }
              if (!directoryExists(this.files, this.directories, path)) {
                throw new DOMException("Entry not found.", "NotFoundError");
              }
              if (!options.recursive && Array.from(this.files.keys()).some((key) => key.startsWith(path + "/"))) {
                throw new DOMException("Directory is not empty.", "InvalidModificationError");
              }
              for (let key of Array.from(this.files.keys())) {
                if (key.startsWith(path + "/")) this.files.delete(key);
              }
              for (let key of Array.from(this.directories)) {
                if (key == path || key.startsWith(path + "/")) this.directories.delete(key);
              }
              persistSmokeFiles(this.files);
              persistSmokeDirectories(this.directories);
            }
            async *values() {
              let prefix = this.path ? this.path + "/" : "";
              let emitted = new Set();
              for (let directory of Array.from(this.directories).sort()) {
                if (!directory.startsWith(prefix)) continue;
                let rest = directory.slice(prefix.length);
                if (!rest || rest.includes("/")) continue;
                emitted.add(rest);
                yield new SmokeDirectoryHandle(rest, this.files, this.directories, directory);
              }
              for (let path of Array.from(this.files.keys()).sort()) {
                if (!path.startsWith(prefix)) continue;
                let rest = path.slice(prefix.length);
                if (!rest || rest.includes("/") || emitted.has(rest)) continue;
                yield new SmokeFileHandle(rest, this.files, path);
              }
            }
          }

          let files = loadSmokeFiles();
          let directories = loadSmokeDirectories(files);
          window.__localMdSmokeFiles = files;
          window.__localMdSmokeSetFile = (name, value) => {
            let path = normalize(name);
            ensureParents(directories, path);
            files.set(path, String(value));
            persistSmokeFiles(files);
            persistSmokeDirectories(directories);
          };
          window.showDirectoryPicker = async () => new SmokeDirectoryHandle("Smoke Workspace", files, directories);
        })();
      `,
    },
    sessionId,
  );
}

async function installDropboxOAuthStub(client, sessionId, accessToken = dropboxAccessToken) {
  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        (() => {
          let originalFetch = window.fetch.bind(window);
          window.fetch = (input, init) => {
            let url = typeof input == "string" ? input : input?.url ?? "";
            if (url == "https://api.dropboxapi.com/oauth2/token") {
              return Promise.resolve(new Response(JSON.stringify({
                access_token: ${JSON.stringify(accessToken)},
                expires_in: 3600
              }), {
                headers: { "Content-Type": "application/json" },
                status: 200
              }));
            }
            return originalFetch(input, init);
          };

          window.open = () => {
            let popup = {
              closed: false,
              close() {
                this.closed = true;
              },
              document: { title: "" },
              focus() {},
              location: {
                set href(value) {
                  let state = new URL(value).searchParams.get("state");
                  setTimeout(() => {
                    window.dispatchEvent(new MessageEvent("message", {
                      data: {
                        code: "dropbox-smoke-code",
                        state,
                        type: ${JSON.stringify(DROPBOX_OAUTH_MESSAGE)}
                      },
                      origin: window.location.origin
                    }));
                  }, 0);
                }
              }
            };
            return popup;
          };
        })();
      `,
    },
    sessionId,
  );
}

async function installMockDropboxOperator(client, sessionId) {
  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        (() => {
          let files = new Map();
          let directories = new Set();

          function normalize(path) {
            return String(path || "").trim().replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "");
          }

          function parent(path) {
            let normalized = normalize(path);
            let index = normalized.lastIndexOf("/");
            return index == -1 ? "" : normalized.slice(0, index);
          }

          function ensureParents(path) {
            let current = "";
            for (let part of parent(path).split("/").filter(Boolean)) {
              current = current ? current + "/" + part : part;
              directories.add(current);
            }
          }

          function entries(prefix = "") {
            let normalizedPrefix = normalize(prefix);
            let result = [];
            let directorySet = new Set(directories);
            for (let path of files.keys()) {
              let current = "";
              for (let part of parent(path).split("/").filter(Boolean)) {
                current = current ? current + "/" + part : part;
                directorySet.add(current);
              }
            }

            for (let path of directorySet) {
              if (normalizedPrefix && path != normalizedPrefix && !path.startsWith(normalizedPrefix + "/")) continue;
              result.push({ isDirectory: true, isFile: false, path });
            }
            for (let path of files.keys()) {
              if (normalizedPrefix && path != normalizedPrefix && !path.startsWith(normalizedPrefix + "/")) continue;
              result.push({ isDirectory: false, isFile: true, path });
            }
            return result.sort((left, right) => left.path.localeCompare(right.path));
          }

          window.__localMdMockDropboxFiles = files;
          window.__localMdWorkspaceTestDropboxOperatorFactory = async () => ({
            capabilities() {
              return {
                nativeCopy: true,
                nativeCreateDir: true,
                nativeDelete: true,
                nativeList: true,
                nativeRead: true,
                nativeRename: true,
                nativeStat: true,
                nativeWrite: true
              };
            },
            async createDir(path) {
              let normalized = normalize(path);
              if (normalized) {
                ensureParents(normalized);
                directories.add(normalized);
              }
            },
            async delete(path) {
              let normalized = normalize(path);
              if (files.delete(normalized)) return;
              let removed = false;
              for (let key of Array.from(files.keys())) {
                if (key.startsWith(normalized + "/")) {
                  files.delete(key);
                  removed = true;
                }
              }
              for (let key of Array.from(directories)) {
                if (key == normalized || key.startsWith(normalized + "/")) {
                  directories.delete(key);
                  removed = true;
                }
              }
              if (!removed) throw new Error("not_found");
            },
            async list(prefix) {
              return entries(prefix);
            },
            async readText(path) {
              let normalized = normalize(path);
              if (!files.has(normalized)) throw new Error("not_found");
              return files.get(normalized);
            },
            async rename(from, to) {
              let source = normalize(from);
              let target = normalize(to);
              if (files.has(source)) {
                let value = files.get(source);
                files.delete(source);
                ensureParents(target);
                files.set(target, value);
                return;
              }
              if (!directories.has(source)) throw new Error("not_found");
              directories.delete(source);
              directories.add(target);
              for (let key of Array.from(files.keys())) {
                if (!key.startsWith(source + "/")) continue;
                let value = files.get(key);
                files.delete(key);
                files.set(target + key.slice(source.length), value);
              }
            },
            async stat(path) {
              let normalized = normalize(path);
              if (files.has(normalized)) return { isDirectory: false, isFile: true, path: normalized };
              if (directories.has(normalized)) return { isDirectory: true, isFile: false, path: normalized };
              throw new Error("not_found");
            },
            async writeText(path, value) {
              let normalized = normalize(path);
              ensureParents(normalized);
              files.set(normalized, String(value));
            }
          });
        })();
      `,
    },
    sessionId,
  );
}

async function waitForMockDropboxFileValue(client, sessionId, path, expectedValue) {
  try {
    await client.waitForPredicate(
      `window.__localMdMockDropboxFiles?.get(${JSON.stringify(path)}) == ${JSON.stringify(
        expectedValue,
      )}`,
      sessionId,
      20_000,
    );
  } catch (error) {
    let state = await client.evaluate(
      `
        (() => ({
          body: document.body.innerText,
          files: Array.from(window.__localMdMockDropboxFiles?.entries?.() ?? []),
          value: window.__localMdMockDropboxFiles?.get(${JSON.stringify(path)}) ?? null
        }))()
      `,
      sessionId,
    );
    throw new Error(`${error.message}\n\nMock Dropbox state:\n${JSON.stringify(state, null, 2)}`);
  }
}

async function waitForDropboxFileValue(path, expectedValue) {
  let started = Date.now();
  while (Date.now() - started < 20_000) {
    let value = await downloadDropboxFile(path).catch(() => null);
    if (value == expectedValue) return;
    await waitForSettledUi(500);
  }
  throw new Error(`Timed out waiting for Dropbox file ${path} to contain the smoke value.`);
}

async function downloadDropboxFile(path) {
  let response = await fetch("https://content.dropboxapi.com/2/files/download", {
    headers: {
      Authorization: `Bearer ${dropboxAccessToken}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
    method: "POST",
  });
  if (!response.ok) throw new Error(`Dropbox download failed (${response.status}).`);
  return response.text();
}

async function deleteDropboxFile(path) {
  let response = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    body: JSON.stringify({ path }),
    headers: {
      Authorization: `Bearer ${dropboxAccessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok && response.status != 409) {
    throw new Error(`Dropbox cleanup failed (${response.status}).`);
  }
}

function dropboxApiPath(fileName) {
  let root = dropboxRoot
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return `/${root ? `${root}/` : ""}${fileName}`;
}

function waitForDevToolsEndpoint(child) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error("Timed out waiting for Chromium.")), 10_000);
    child.stderr.on("data", (chunk) => {
      let match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.on("exit", (code) => {
      reject(new Error(`Chromium exited before DevTools was ready: ${code}`));
    });
  });
}

function waitForSettledUi(delay = 350) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function findChromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  for (let candidate of chromePathCandidates()) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function chromePathCandidates() {
  let home = homedir();
  let candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  let cacheRoot = join(home, "Library/Caches/ms-playwright");
  for (let entry of newestPlaywrightCacheEntries(cacheRoot, "chromium-")) {
    candidates.push(
      join(
        cacheRoot,
        entry,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
    );
  }
  for (let entry of newestPlaywrightCacheEntries(cacheRoot, "chromium_headless_shell-")) {
    candidates.push(
      join(cacheRoot, entry, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    );
  }

  return candidates;
}

function newestPlaywrightCacheEntries(cacheRoot, prefix) {
  try {
    return readdirSync(cacheRoot)
      .filter((entry) => entry.startsWith(prefix))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}
