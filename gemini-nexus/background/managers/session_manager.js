
// background/managers/session_manager.js
import { sendGeminiMessage } from '../../services/gemini_api.js';
import { AuthManager } from './auth_manager.js';

export class GeminiSessionManager {
    constructor() {
        this.auth = new AuthManager();
        this.abortController = null;
    }

    async ensureInitialized() {
        await this.auth.ensureInitialized();
    }

    async handleSendPrompt(request, onUpdate) {
        // Cancel previous if exists
        this.cancelCurrentRequest();
        
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            await this.ensureInitialized();

            // Construct files array
            let files = [];
            if (request.files && Array.isArray(request.files)) {
                files = request.files;
            } else if (request.image) {
                files = [{
                    base64: request.image, 
                    type: request.imageType,
                    name: request.imageName || "image.png"
                }];
            }

            let attemptCount = 0;
            // Retry once with rotation if multiple accounts configured
            const maxAttempts = this.auth.accountIndices.length > 1 ? 2 : 1; 

            while (attemptCount < maxAttempts) {
                attemptCount++;
                
                try {
                    this.auth.checkModelChange(request.model);
                    const context = await this.auth.getOrFetchContext();
                    
                    const response = await sendGeminiMessage(
                        request.text, 
                        context, 
                        request.model, 
                        files, 
                        signal,
                        onUpdate
                    );

                    // Success!
                    await this.auth.updateContext(response.newContext, request.model);

                    return {
                        action: "GEMINI_REPLY",
                        text: response.text,
                        thoughts: response.thoughts,
                        images: response.images,
                        status: "success",
                        context: response.newContext 
                    };

                } catch (err) {
                    const isLoginError = err.message && (
                        err.message.includes("未登录") || 
                        err.message.includes("Not logged in") || 
                        err.message.includes("Sign in") || 
                        err.message.includes("401") || 
                        err.message.includes("403")
                    );
                    
                    if (isLoginError && attemptCount < maxAttempts) {
                        console.warn("[Gemini Nexus] Auth error, rotating account and retrying...");
                        await this.auth.rotateAccount();
                        this.auth.forceContextRefresh();
                        continue; // Retry loop
                    }
                    
                    throw err; // Throw to outer catch
                }
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                return null;
            }

            console.error("Gemini Error:", error);
            
            let errorMessage = error.message || "Unknown error";
            const isZh = chrome.i18n.getUILanguage().startsWith('zh');

            if(errorMessage.includes("未登录") || errorMessage.includes("Not logged in")) {
                // If we exhausted retries and still failed
                this.auth.forceContextRefresh();
                await chrome.storage.local.remove(['geminiContext']);
                
                const currentIndex = this.auth.getCurrentIndex();
                
                if (isZh) {
                    errorMessage = `账号 (Index: ${currentIndex}) 未登录或会话已过期。请前往 <a href="https://gemini.google.com/u/${currentIndex}/" target="_blank" style="color: inherit; text-decoration: underline;">gemini.google.com/u/${currentIndex}/</a> 登录。`;
                } else {
                    errorMessage = `Account (Index: ${currentIndex}) not logged in. Please log in at <a href="https://gemini.google.com/u/${currentIndex}/" target="_blank" style="color: inherit; text-decoration: underline;">gemini.google.com/u/${currentIndex}/</a>.`;
                }
            }
            
            return {
                action: "GEMINI_REPLY",
                text: "Error: " + errorMessage,
                status: "error"
            };
        } finally {
            this.abortController = null;
        }
    }

    cancelCurrentRequest() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            return true;
        }
        return false;
    }

    async setContext(context, model) {
        await this.auth.updateContext(context, model);
    }

    async resetContext() {
        await this.auth.resetContext();
    }
}
