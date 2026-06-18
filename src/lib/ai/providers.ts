// Provider identifiers supported by the chat API route (src/app/api/chat/route.ts).
// The route uses the raw `openai` client directly, so no AI-SDK provider factory is needed here.
export type Provider = 'openrouter' | 'openai' | 'anthropic';
