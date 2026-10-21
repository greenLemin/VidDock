import type { BgRequest, BgResponse, ContentReport, PopupState } from '@viddock/shared';
import { lifecycle } from './lifecycle.ts';
import { mediaStore } from './media_store.ts';
import { nativeClient } from './native_client.ts';
import { sniffer } from './sniffer.ts';
import { taskCoordinator } from './task_coordinator.ts';

// 1. Initialize subsystems
taskCoordinator.init().catch(() => {});

// 2. Synchronous Top-Level Event Listeners (Manifest V3 Compliance)
chrome.runtime.onInstalled.addListener(lifecycle.onInstalled);
chrome.runtime.onStartup.addListener(lifecycle.onStartup);
chrome.alarms.onAlarm.addListener(lifecycle.onAlarm);

chrome.tabs.onUpdated.addListener(sniffer.onTabUpdated);
chrome.tabs.onRemoved.addListener(sniffer.onTabRemoved);
chrome.tabs.onActivated.addListener(sniffer.onTabActivated);

chrome.webRequest.onBeforeRequest.addListener(sniffer.onBeforeRequest, { urls: ['<all_urls>'] });

chrome.webRequest.onHeadersReceived.addListener(sniffer.onHeadersReceived, { urls: ['<all_urls>'] }, [
  'responseHeaders',
]);

// Streaming UI Port Connections
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'viddock-ui') {
    taskCoordinator.registerUiPort(port);
  }
});

// Internal Request-Response Messaging
chrome.runtime.onMessage.addListener(
  (
    message: BgRequest | ContentReport,
    sender: chrome.runtime.MessageSender,
    sendResponse: (res: BgResponse | { ok: true }) => void,
  ): boolean => {
    // 1. Content Script Reports
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      (message.type === 'domMedia' || message.type === 'mediasiteOptions')
    ) {
      const tabId = sender.tab?.id ?? -1;
      sniffer.handleContentReport(tabId, message as ContentReport).then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    // 2. Background Requests from Popup, Dashboard, Settings
    const req = message as BgRequest;
    (async () => {
      try {
        switch (req.type) {
          case 'getState': {
            let tabId = req.tabId;
            let tabTitle = 'Current Page';
            let tabUrl = '';

            if (tabId === undefined) {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (tab) {
                tabId = tab.id ?? -1;
                tabTitle = tab.title ?? tabTitle;
                tabUrl = tab.url ?? tabUrl;
              } else {
                tabId = -1;
              }
            } else {
              try {
                const tab = await chrome.tabs.get(tabId);
                tabTitle = tab.title ?? tabTitle;
                tabUrl = tab.url ?? tabUrl;
              } catch {}
            }

            const items = tabId >= 0 ? await mediaStore.getTabMedia(tabId) : [];
            const tasks = taskCoordinator.getTasks();
            const settings = await taskCoordinator.getSettings();
            const native = nativeClient.getStatus();

            const state: PopupState = {
              tabId: tabId ?? -1,
              tabTitle,
              tabUrl,
              items,
              tasks,
              settings,
              native,
              scanning: false,
            };
            sendResponse({ ok: true, data: state });
            break;
          }

          case 'refresh': {
            await mediaStore.clearTabMedia(req.tabId);
            try {
              await chrome.scripting.executeScript({
                target: { tabId: req.tabId },
                files: ['content_video.js', 'content_mediasite.js'],
              });
            } catch {}
            sendResponse({ ok: true, data: undefined });
            break;
          }

          case 'startDownload': {
            const result = await taskCoordinator.startDownload(req.params);
            sendResponse({ ok: true, data: result });
            break;
          }

          case 'taskAction': {
            await taskCoordinator.handleTaskAction(req.taskId, req.action);
            sendResponse({ ok: true, data: undefined });
            break;
          }

          case 'clearCompleted': {
            await taskCoordinator.clearCompleted();
            sendResponse({ ok: true, data: undefined });
            break;
          }

          case 'getSettings': {
            const settings = await taskCoordinator.getSettings();
            sendResponse({ ok: true, data: settings });
            break;
          }

          case 'setSettings': {
            const updated = await taskCoordinator.setSettings(req.settings);
            sendResponse({ ok: true, data: updated });
            break;
          }

          case 'nativeStatus': {
            const status = nativeClient.getStatus();
            sendResponse({ ok: true, data: status });
            break;
          }

          case 'diagnostics': {
            const diag = await nativeClient.sendRequest({ type: 'diagnostics' });
            sendResponse({ ok: true, data: diag });
            break;
          }

          default: {
            const fallbackReq = req as { type?: string };
            sendResponse({ ok: false, error: `Unhandled request type: ${fallbackReq.type ?? 'unknown'}` });
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error: message || 'Operation failed' });
      }
    })();

    return true; // Keeps async response channel open
  },
);
