// Provider identifiers supported by the chat API route (src/app/api/chat/route.ts).
// The route uses the raw `openai` client directly, so no AI-SDK provider factory is needed here.
// NanoGPT is OpenAI-compatible. Subscription-selected models are routed through
// /api/subscription/v1 by the server proxy; pay-as-you-go is never implicit.
export type Provider = 'openrouter' | 'openai' | 'anthropic' | 'nanogpt';
