
// background/handlers/session/prompt_handler.js
import { appendAiMessage, appendUserMessage } from '../../managers/history_manager.js';
import { parseToolCommand, getActiveTabContent } from './utils.js';

export class PromptHandler {
    constructor(sessionManager, controlManager) {
        this.sessionManager = sessionManager;
        this.controlManager = controlManager;
    }

    handle(request, sendResponse) {
        (async () => {
            const onUpdate = (partialText, partialThoughts) => {
                // Catch errors if receiver (UI) is closed/unavailable
                chrome.runtime.sendMessage({
                    action: "GEMINI_STREAM_UPDATE",
                    text: partialText,
                    thoughts: partialThoughts
                }).catch(() => {}); 
            };

            try {
                // 1. Prepare Initial Context (System Prompt & Page Content)
                let systemPreamble = "";
                
                if (request.includePageContext) {
                     const pageContent = await getActiveTabContent();
                     if (pageContent) {
                         systemPreamble += `Webpage Context:\n\`\`\`text\n${pageContent}\n\`\`\`\n\n`;
                     }
                }

                if (request.enableBrowserControl) {
                    systemPreamble += `[System: Browser Control Enabled]
You are a browser automation assistant using the Chrome DevTools MCP protocol.
Your goal is to fulfill the user's request by manipulating the browser page.

**CRITICAL RULE: "LOOK BEFORE YOU LEAP"**
You **cannot** interact with elements (click, fill, hover, drag) without knowing their UIDs.
1. If you need to find an element, your **FIRST action** MUST be \`take_snapshot\`.
2. Analyze the snapshot to find the \`uid\` of the target element (e.g., uid=1_5).
3. Only THEN call interaction tools like \`click\` or \`fill\` using that \`uid\`.

**Output Format:**
To use a tool, output a **single** JSON block at the end of your response:
\`\`\`json
{
  "tool": "tool_name",
  "args": { ... }
}
\`\`\`

**Available Tools:**

1. **take_snapshot**: Returns the Accessibility Tree with UIDs.
   - args: {}
   - Use this whenever you need to see the page structure or find an element ID.

2. **click**: Click an element using its UID.
   - args: { "uid": "string" }

3. **fill**: Type text into an input field.
   - args: { "uid": "string", "value": "string" }
   
4. **fill_form**: Batch fill multiple fields at once.
   - args: { "elements": [{ "uid": "string", "value": "string" }, ...] }

5. **hover**: Hover over an element.
   - args: { "uid": "string" }

6. **press_key**: Press a keyboard key.
   - args: { "key": "string" }
   - Keys: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, etc.

7. **navigate_page**: Go to a URL or navigate history.
   - args: { "url": "https://...", "type": "url" }
   - args: { "type": "back" } | { "type": "reload" }

8. **wait_for**: Wait for specific text to appear.
   - args: { "text": "string", "timeout": 5000 }

9. **evaluate_script**: Execute JavaScript.
   - args: { "script": "return document.title;" }

10. **take_screenshot**: Capture the visible viewport.
   - args: {}

11. **attach_file**: Upload files to a file input.
    - args: { "uid": "string", "paths": ["path/to/file"] }

12. **new_page**: Create a new page (tab).
    - args: { "url": "https://..." }

13. **close_page**: Close a page by its index in the page list.
    - args: { "index": number }
    - Use \`list_pages\` first to see indices.

14. **list_pages**: List all open pages with their indices and titles.
    - args: {}

15. **select_page**: Switch focus to a page by index.
    - args: { "index": number }

16. **resize_page**: Resize the viewport for responsive testing.
    - args: { "width": number, "height": number }

17. **drag_element**: Drag an element to another element.
    - args: { "from_uid": "string", "to_uid": "string" }

18. **performance_start_trace**: Start recording performance profile.
    - args: { "reload": boolean }

19. **performance_stop_trace**: Stop recording and get summary metrics (LCP, FCP, CLS).
    - args: {}

20. **list_network_requests**: List network activity with filtering.
    - args: { "resourceTypes": ["Fetch", "XHR"], "limit": 20 }
    - Types: Document, Stylesheet, Image, Media, Font, Script, XHR, Fetch, etc.

21. **get_network_request**: Get full headers and body of a request.
    - args: { "requestId": "string" }
    - Use this to inspect API responses or debug errors found in list_network_requests.

**Example Workflow:**
User: "Search for 'Gemini' on Google"
Model: "I need to find the search box."
\`\`\`json
{ "tool": "take_snapshot", "args": {} }
\`\`\`
(System returns snapshot with search box uid=1_2)
Model: "I found the search box (uid=1_2). I will type 'Gemini'."
\`\`\`json
{ "tool": "fill", "args": { "uid": "1_2", "value": "Gemini" } }
\`\`\`
(System returns success)
Model: "Now I press Enter."
\`\`\`json
{ "tool": "press_key", "args": { "key": "Enter" } }
\`\`\`
\n`;
                }

                // Apply preamble to the first prompt text
                let currentPromptText = request.text;
                if (systemPreamble) {
                    currentPromptText = systemPreamble + "Question: " + currentPromptText;
                }

                // Loop Variables
                let currentFiles = request.files; // Files only sent on first turn usually
                let loopCount = 0;
                const MAX_LOOPS = 10; // Prevent infinite loops
                let keepLooping = true;

                // --- AUTOMATED FEEDBACK LOOP ---
                while (keepLooping && loopCount < MAX_LOOPS) {
                    
                    // 2. Send to Gemini
                    const result = await this.sessionManager.handleSendPrompt({
                        ...request,
                        text: currentPromptText,
                        files: currentFiles
                    }, onUpdate);

                    if (!result || result.status !== 'success') {
                        // If error, notify UI and break loop
                        if (result) chrome.runtime.sendMessage(result).catch(() => {});
                        break;
                    }

                    // 3. Save AI Response to History
                    if (request.sessionId) {
                        await appendAiMessage(request.sessionId, result);
                    }
                    
                    // Notify UI of the result (replaces streaming bubble)
                    chrome.runtime.sendMessage(result).catch(() => {});

                    // 4. Process Browser Control (Tool Execution)
                    let toolOutput = null;
                    let toolFiles = null;

                    if (request.enableBrowserControl && result.text && this.controlManager) {
                        // Detect tool call
                        const toolCommand = parseToolCommand(result.text);
                        
                        if (toolCommand) {
                            // Inform UI that we are executing
                            onUpdate(`Executing tool: ${toolCommand.name}...`, "Processing tool execution...");
                            
                            try {
                                const execResult = await this.controlManager.execute({
                                    name: toolCommand.name,
                                    args: toolCommand.args || {}
                                });

                                // Check if result contains structured image data (e.g. from take_screenshot)
                                if (execResult && typeof execResult === 'object' && execResult.image) {
                                    toolOutput = execResult.text;
                                    toolFiles = [{
                                        base64: execResult.image,
                                        type: "image/png",
                                        name: "screenshot.png"
                                    }];
                                } else {
                                    toolOutput = execResult;
                                }

                            } catch (err) {
                                toolOutput = `Error executing tool: ${err.message}`;
                            }
                        }
                    }

                    // 5. Decide Next Step
                    if (toolOutput) {
                        // Tool executed, feed back to model (Loop continues)
                        loopCount++;
                        currentFiles = toolFiles || []; // Send new files if any, or clear previous files
                        
                        // Format observation for the model
                        currentPromptText = `[Tool Output from ${parseToolCommand(result.text)?.name}]:\n\`\`\`\n${toolOutput}\n\`\`\`\n\n(Proceed with the next step or confirm completion)`;
                        
                        // Save "User" message (Tool Output) to history to keep context in sync
                        if (request.sessionId) {
                            const userMsg = `🛠️ **Tool Output:**\n\`\`\`\n${toolOutput}\n\`\`\`\n\n*(Proceeding to step ${loopCount + 1})*`;
                            
                            let historyImages = null;
                            if (toolFiles) {
                                historyImages = toolFiles.map(f => f.base64);
                            }
                            
                            await appendUserMessage(request.sessionId, userMsg, historyImages);
                        }
                        
                        // Update UI status
                        onUpdate("Gemini is thinking...", `Observed output from tool. Planning next step (${loopCount}/${MAX_LOOPS})...`);
                        
                    } else {
                        // No tool execution, final answer reached
                        keepLooping = false;
                    }
                }

            } catch (e) {
                console.error("Prompt loop error:", e);
                chrome.runtime.sendMessage({
                    action: "GEMINI_REPLY",
                    text: "Error: " + e.message,
                    status: "error"
                }).catch(() => {});
            } finally {
                sendResponse({ status: "completed" });
            }
        })();
        return true;
    }
}
