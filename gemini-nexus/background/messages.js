
// background/messages.js
import { SessionMessageHandler } from './handlers/session.js';
import { UIMessageHandler } from './handlers/ui.js';

/**
 * Sets up the global runtime message listener.
 * @param {GeminiSessionManager} sessionManager 
 * @param {ImageHandler} imageHandler 
 * @param {BrowserControlManager} controlManager
 */
export function setupMessageListener(sessionManager, imageHandler, controlManager) {
    
    const sessionHandler = new SessionMessageHandler(sessionManager, imageHandler, controlManager);
    const uiHandler = new UIMessageHandler(imageHandler);

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        
        // Delegate to Session Handler (Prompt, Context, Quick Ask, Browser Control)
        if (sessionHandler.handle(request, sender, sendResponse)) {
            return true;
        }

        // Delegate to UI Handler (Image, Capture, Sidepanel)
        if (uiHandler.handle(request, sender, sendResponse)) {
            return true;
        }
        
        return false;
    });
}
