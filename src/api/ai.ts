import { requestUrl, RequestUrlParam } from "obsidian";
import type { MultilingualNotesSettings } from "../settings";

export interface AIResponse {
    success: boolean;
    text?: string;
    error?: string;
}

export async function streamTranslation(
    sourceText: string,
    targetLangName: string,
    sourceLangName: string | undefined,
    settings: MultilingualNotesSettings,
    onChunk: (text: string) => void,
): Promise<void> {
    const { aiApiBase, aiApiKey, aiModel, aiSystemPrompt } = settings;

    if (!aiApiBase) throw new Error("API Base URL is not configured.");
    if (!aiApiKey) throw new Error("API Key is not configured.");
    if (!aiModel) throw new Error("AI Model is not configured.");

    let endpoint = aiApiBase;
    if (!endpoint.endsWith("/chat/completions")) {
        endpoint = endpoint.replace(/\/$/, "") + "/chat/completions";
    }

    const prompt = `${aiSystemPrompt}\n\nSource language: ${sourceLangName || "Auto-detect"}\nTarget language: ${targetLangName}`;

    const requestParams = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${aiApiKey}`,
        },
        body: JSON.stringify({
            model: aiModel,
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: sourceText },
            ],
            temperature: 0.3,
            stream: true, // Request streaming SSE format from OpenAI compatible endpoints
        }),
    };

    let response: Response;
    try {
        response = await fetch(endpoint, requestParams);
    } catch (err: any) {
        throw new Error(`Network error connecting to API: ${err.message}. If using a local API, ensure it supports CORS from app://obsidian.md.`);
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown network or CORS error");
        throw new Error(`HTTP Error ${response.status}: ${errText}`);
    }

    // Read the stream
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable.");

    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE chunks (data: {...})
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep the last incomplete line in the buffer

        for (const line of lines) {
            const cleanLine = line.trim();
            if (cleanLine.startsWith("data: ")) {
                const dataStr = cleanLine.substring(6);
                if (dataStr === "[DONE]") return; // End of stream

                try {
                    const data = JSON.parse(dataStr);
                    const chunk = data.choices?.[0]?.delta?.content;
                    if (chunk) {
                        onChunk(chunk);
                    }
                } catch (e) {
                    console.debug("Failed to parse stream chunk JSON", dataStr, e);
                }
            }
        }
    }
}
