import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

export type Provider = 'openrouter' | 'openai' | 'anthropic';

export function getProvider(providerName: Provider, apiKey: string) {
    switch (providerName) {
        case 'openrouter':
            return createOpenAI({
                apiKey,
                baseURL: 'https://openrouter.ai/api/v1',
                headers: {
                    'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : '',
                    'X-Title': 'NexusAI',
                },
            });
        case 'openai':
            return createOpenAI({ apiKey });
        case 'anthropic':
            return createAnthropic({ apiKey });
        default:
            throw new Error(`Unknown provider: ${providerName}`);
    }
}

// Popular models for each provider
export const MODELS = {
    openrouter: [

        { id: 'google/gemini-3-flash-preview', name: 'Gemini 3.0 Flash (Preview)', free: false },
        { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek v3.2', free: false },
        { id: 'meta-llama/llama-3.1-8b-instruct:free', name: 'Llama 3.1 8B (Free)', free: true },
        { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 (Free)', free: true },
        {
            id: 'deepseek/deepseek-r1-0528:free',
            name: 'DeepSeek R1 0528 (Free)',
            free: true,
        },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', free: false },
        { id: 'openai/gpt-4o', name: 'GPT-4o', free: false },
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', free: false },
        { id: 'mistralai/mistral-large-latest', name: 'Mistral Large', free: false },
    ],
    openai: [
        { id: 'gpt-4o', name: 'GPT-4o', free: false },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', free: false },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', free: false },
        { id: 'o1-mini', name: 'o1 Mini (Reasoning)', free: false },
    ],
    anthropic: [
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', free: false },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', free: false },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', free: false },
    ],
} as const;

// Presets for different roleplay styles
export const PRESETS = {
    creative: {
        temperature: 1.0,
        maxTokens: 2048,
        description: 'Plus créatif et imprévisible',
    },
    balanced: {
        temperature: 0.8,
        maxTokens: 2048,
        description: 'Équilibré entre créativité et cohérence',
    },
    precise: {
        temperature: 0.5,
        maxTokens: 2048,
        description: 'Plus cohérent et prévisible',
    },
    adventure: {
        temperature: 0.9,
        maxTokens: 3000,
        description: "Optimisé pour les scénarios d'aventure",
    },
} as const;
