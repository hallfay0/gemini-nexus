
// background/control/actions/observation.js
import { BaseActionHandler } from './base.js';

export class ObservationActions extends BaseActionHandler {
    
    async takeScreenshot() {
        try {
            const dataUrl = await new Promise(resolve => {
                chrome.tabs.captureVisibleTab(null, { format: 'png' }, (data) => {
                    if (chrome.runtime.lastError) {
                        console.error("Screenshot failed:", chrome.runtime.lastError);
                        resolve(null);
                    } else {
                        resolve(data);
                    }
                });
            });

            if (!dataUrl) return "Error: Failed to capture screenshot.";

            return {
                text: `Screenshot taken (Base64 length: ${dataUrl.length}). [Internal: Image attached to chat history]`,
                image: dataUrl
            };
        } catch (e) {
            return `Error taking screenshot: ${e.message}`;
        }
    }

    async evaluateScript({ script }) {
        const res = await this.cmd("Runtime.evaluate", {
            expression: script,
            returnByValue: true
        });
        return res.result ? JSON.stringify(res.result.value) : "undefined";
    }

    async waitFor({ text, timeout = 5000 }) {
        try {
            // Poll for text presence in the DOM
            const res = await this.cmd("Runtime.evaluate", {
                expression: `
                    (async () => {
                        const start = Date.now();
                        const target = "${String(text).replace(/"/g, '\\"')}";
                        while (Date.now() - start < ${timeout}) {
                            if (document.body && document.body.innerText.includes(target)) {
                                return true;
                            }
                            await new Promise(r => setTimeout(r, 200));
                        }
                        return false;
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });
            
            if (res.result && res.result.value === true) {
                return `Found text "${text}".`;
            } else {
                return `Timeout waiting for text "${text}" after ${timeout}ms.`;
            }
        } catch (e) {
            return `Error waiting for text: ${e.message}`;
        }
    }

    async getLogs() {
        const logs = this.connection.collectors.logs.getFormatted();
        return logs || "No logs captured.";
    }

    async getNetworkActivity() {
        const net = this.connection.collectors.network.getFormatted();
        return net || "No network activity captured.";
    }

    async listNetworkRequests({ resourceTypes, limit = 20 }) {
        const collector = this.connection.collectors.network;
        const requests = collector.getList(resourceTypes, limit);
        
        if (requests.length === 0) return "No matching network requests found.";

        return requests.map(r => 
            `ID: ${r.id} | ${r.method} ${r.url} | Status: ${r.status} | Type: ${r.type}`
        ).join('\n');
    }

    async getNetworkRequest({ requestId }) {
        const req = this.connection.collectors.network.getRequest(requestId);
        if (!req) return `Error: Request ID ${requestId} not found. Use list_network_requests first.`;

        let body = "Not available (Request might be incomplete or garbage collected)";
        
        // Try to fetch body from CDP if request completed
        if (req.completed) {
            try {
                const res = await this.cmd("Network.getResponseBody", { requestId });
                body = res.body;
                
                if (res.base64Encoded) {
                     // Attempt to decode if it looks like text
                     if (req.mimeType && (req.mimeType.includes('json') || req.mimeType.includes('text') || req.mimeType.includes('xml'))) {
                         try {
                            body = atob(res.body);
                         } catch (e) {
                            body = "<Base64 Encoded Binary>";
                         }
                     } else {
                         body = "<Base64 Encoded Binary>";
                     }
                }
            } catch (e) {
                // Ignore, body might be gone or not available
                body = `Body fetch failed: ${e.message}`;
            }
        }

        return JSON.stringify({
            url: req.url,
            method: req.method,
            type: req.type,
            status: req.status,
            requestHeaders: req.requestHeaders,
            responseHeaders: req.responseHeaders,
            postData: req.postData,
            responseBody: body
        }, null, 2);
    }
}
