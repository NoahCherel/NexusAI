// Provider identifiers supported by the chat API route (src/app/api/chat/route.ts).
// The route uses the raw `openai` client directly, so no AI-SDK provider factory is needed here.
// NanoGPT is an OpenAI-compatible endpoint (https://nano-gpt.com/api/v1) used for foreground RP
// against the user's NanoGPT subscription; background tasks stay on OpenRouter.
export type Provider = 'openrouter' | 'openai' | 'anthropic' | 'nanogpt';
