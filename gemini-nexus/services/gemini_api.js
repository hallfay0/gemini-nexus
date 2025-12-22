
// services/gemini_api.js
import { fetchRequestParams } from './auth.js';
import { uploadFile } from './upload.js';
import { parseGeminiLine } from './parser.js';

const MODEL_CONFIGS = {
    // Fast: Gemini 3 Flash
    'gemini-2.5-flash': {
        header: '[1,null,null,null,"9ec249fc9ad08861",null,null,0,[4]]'
    },
    // Thinking: Gemini 3 Flash Thinking
    'gemini-2.5-pro': {
        header: '[1,null,null,null,"4af6c7f5da75d65d",null,null,0,[4]]'
    },
    // 3 Pro: Gemini 3 Pro
    'gemini-3.0-pro': {
        header: '[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4]]'
    }
};

export async function sendGeminiMessage(prompt, context, model, files, signal, onUpdate) {
    // 1. Ensure Auth
    if (!context || !context.atValue) {
        // Fallback: If no context, use '0' (this path usually handled by SessionManager)
        const params = await fetchRequestParams('0');
        context = {
            atValue: params.atValue,
            blValue: params.blValue,
            authUser: params.authUserIndex || '0', 
            contextIds: ['', '', ''] 
        };
    }

    const modelConfig = MODEL_CONFIGS[model] || MODEL_CONFIGS['gemini-2.5-flash'];

    // 2. Handle File Uploads (Multimodal)
    // Structure: [[[url], filename], [[url], filename], ...]
    let fileList = [];
    if (files && files.length > 0) {
        try {
            // Upload in parallel
            const uploadPromises = files.map(file => uploadFile(file, signal)
                .then(url => [[url], file.name])
            );
            fileList = await Promise.all(uploadPromises);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.error("File upload failed:", e);
            throw e;
        }
    }

    // 3. Construct Payload (Inlined)
    // Structure aligned with Python Gemini-API (v3.0):
    // If files: [prompt, 0, null, fileList]
    // If no files: [prompt]
    
    let messageStruct;
    if (fileList.length > 0) {
        messageStruct = [
            prompt,
            0,
            null,
            fileList
        ];
    } else {
        messageStruct = [prompt];
    }

    const data = [
        messageStruct,
        null,
        context.contextIds // [conversationId, responseId, choiceId]
    ];

    // The API expects: f.req = JSON.stringify([null, JSON.stringify(data)])
    // This wrapper is still required for Batchexecute-style endpoints like StreamGenerate
    const fReq = JSON.stringify([null, JSON.stringify(data)]);

    const queryParams = new URLSearchParams({
        bl: context.blValue || 'boq_assistant-bard-web-server_20230713.13_p0',
        _reqid: Math.floor(Math.random() * 900000) + 100000,
        rt: 'c'
    });

    // 4. Headers
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1',
        'X-Goog-AuthUser': context.authUser, 
        // Critical: Use this header for model selection instead of Payload ID
        'x-goog-ext-525001261-jspb': modelConfig.header
    };

    // 5. Send Request
    // IMPORTANT: Include /u/{index}/ in URL to ensure cookies match the requested authUser
    const endpoint = `https://gemini.google.com/u/${context.authUser}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${queryParams.toString()}`;

    const response = await fetch(endpoint, {
            method: 'POST',
            signal: signal, 
            headers: headers,
            body: new URLSearchParams({
                at: context.atValue,
                'f.req': fReq
            })
        }
    );

    if (!response.ok) {
        throw new Error(`Network Error: ${response.status}`);
    }

    // 6. Handle Stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalResult = null;
    let isFirstChunk = true;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            
            // Validate Login Session on first chunk
            if (isFirstChunk) {
                if (chunk.includes('<!DOCTYPE html>') || chunk.includes('<html') || chunk.includes('Sign in')) {
                    throw new Error("未登录 (Session expired)");
                }
                isFirstChunk = false;
            }

            buffer += chunk;

            // Parse Lines
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);

                const parsed = parseGeminiLine(line);
                if (parsed) {
                    finalResult = parsed;
                    if (onUpdate) {
                        onUpdate(parsed.text, parsed.thoughts);
                    }
                }
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e.message.includes("未登录")) throw e;
        console.error("Stream reading error:", e);
    }

    if (buffer.length > 0) {
        const parsed = parseGeminiLine(buffer);
        if (parsed) finalResult = parsed;
    }

    if (!finalResult) {
        if (buffer.includes('<!DOCTYPE html>')) {
             throw new Error("未登录 (Session expired)");
        }
        throw new Error("No valid response found. Check network.");
    }

    // Update context
    context.contextIds = finalResult.ids;

    return {
        text: finalResult.text,
        thoughts: finalResult.thoughts,
        images: finalResult.images || [],
        newContext: context
    };
}