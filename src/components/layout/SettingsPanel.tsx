'use client';

import { useState } from 'react';
import { Settings, Key, Sliders, Eye, EyeOff, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { useSettingsStore } from '@/stores';
import { encryptApiKey, validateApiKey } from '@/lib/crypto';
import { PRESETS, type Provider } from '@/lib/ai';

interface SettingsPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
    const {
        apiKeys,
        temperature,
        showThoughts,
        showWorldState,
        enableReasoning,
        immersiveMode,
        setApiKey,
        setActiveProvider,
        setTemperature,
        setShowThoughts,
        setShowWorldState,
        setEnableReasoning,
        setImmersiveMode,
    } = useSettingsStore();

    const [newKey, setNewKey] = useState('');
    const [selectedProvider, setSelectedProvider] = useState<Provider>('openrouter');
    const [isValidating, setIsValidating] = useState(false);
    const [showKey, setShowKey] = useState(false);

    const handleSaveKey = async () => {
        if (!newKey.trim()) return;

        setIsValidating(true);
        try {
            const isValid = await validateApiKey(selectedProvider, newKey);
            const encrypted = await encryptApiKey(newKey);

            setApiKey({
                provider: selectedProvider,
                encryptedKey: encrypted,
                isValid,
            });

            setNewKey('');
            if (isValid) {
                setActiveProvider(selectedProvider);
            }
        } catch (error) {
            console.error('Failed to save API key:', error);
        } finally {
            setIsValidating(false);
        }
    };

    const getKeyForProvider = (provider: Provider) => {
        return apiKeys.find((k) => k.provider === provider);
    };

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent className="w-[400px] sm:w-[540px] overflow-y-auto">
                <SheetHeader>
                    <SheetTitle className="flex items-center gap-2">
                        <Settings className="h-5 w-5" />
                        Settings
                    </SheetTitle>
                    <SheetDescription>
                        Configure your API keys and chat preferences.
                    </SheetDescription>
                </SheetHeader>

                <Tabs defaultValue="api" className="mt-6">
                    <TabsList className="w-full">
                        <TabsTrigger value="api" className="flex-1 gap-2">
                            <Key className="h-4 w-4" />
                            API
                        </TabsTrigger>
                        <TabsTrigger value="chat" className="flex-1 gap-2">
                            <Sliders className="h-4 w-4" />
                            Chat
                        </TabsTrigger>
                    </TabsList>

                    {/* API Keys Tab */}
                    <TabsContent value="api" className="space-y-8 mt-6 px-1 pb-10">
                        {/* Provider Selection */}
                        <div className="space-y-4">
                            <label className="text-sm font-medium">Provider</label>
                            <div className="flex gap-3">
                                {(['openrouter', 'openai', 'anthropic'] as Provider[]).map(
                                    (provider) => {
                                        const key = getKeyForProvider(provider);
                                        return (
                                            <Button
                                                key={provider}
                                                variant={
                                                    selectedProvider === provider
                                                        ? 'default'
                                                        : 'outline'
                                                }
                                                size="sm"
                                                onClick={() => setSelectedProvider(provider)}
                                                className="flex-1 gap-2 h-10"
                                            >
                                                {provider === 'openrouter' && 'OpenRouter'}
                                                {provider === 'openai' && 'OpenAI'}
                                                {provider === 'anthropic' && 'Anthropic'}
                                                {key &&
                                                    (key.isValid ? (
                                                        <Check className="h-3 w-3 text-green-500" />
                                                    ) : (
                                                        <X className="h-3 w-3 text-red-500" />
                                                    ))}
                                            </Button>
                                        );
                                    }
                                )}
                            </div>
                        </div>

                        {/* API Key Input */}
                        <div className="space-y-4">
                            <label className="text-sm font-medium">
                                {selectedProvider} API Key
                            </label>
                            <div className="flex gap-3">
                                <div className="relative flex-1">
                                    <Input
                                        type={showKey ? 'text' : 'password'}
                                        value={newKey}
                                        onChange={(e) => setNewKey(e.target.value)}
                                        placeholder={`sk-... or your ${selectedProvider} key`}
                                        className="pr-10 h-10"
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="absolute right-0 top-0 h-full hover:bg-transparent"
                                        onClick={() => setShowKey(!showKey)}
                                    >
                                        {showKey ? (
                                            <EyeOff className="h-4 w-4 text-muted-foreground" />
                                        ) : (
                                            <Eye className="h-4 w-4 text-muted-foreground" />
                                        )}
                                    </Button>
                                </div>
                                <Button
                                    onClick={handleSaveKey}
                                    disabled={!newKey.trim() || isValidating}
                                    className="h-10 px-6"
                                >
                                    {isValidating ? 'Validating...' : 'Save'}
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                🔒 Your key is encrypted locally using AES-256-GCM and stored only
                                in your browser&apos;s LocalStorage. It is never sent to our servers.
                            </p>
                        </div>
                    </TabsContent>

                    {/* Chat Settings Tab */}
                    <TabsContent value="chat" className="space-y-8 mt-6 px-1 pb-10">
                        {/* Reasoning Mode Toggle */}
                        <div className="space-y-4">
                            <div className="flex items-center justify-between p-1">
                                <div>
                                    <p className="text-sm font-medium">Thinking Mode (Reasoning)</p>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        Enables reasoning tokens for compatible models (e.g.
                                        DeepSeek R1)
                                    </p>
                                </div>
                                <Button
                                    variant={enableReasoning ? 'default' : 'secondary'}
                                    size="sm"
                                    onClick={() => setEnableReasoning(!enableReasoning)}
                                    className="w-16"
                                >
                                    {enableReasoning ? 'On' : 'Off'}
                                </Button>
                            </div>
                        </div>

                        <Separator />

                        {/* Presets */}
                        <div className="space-y-4">
                            <label className="text-sm font-medium">Creativity Preset</label>
                            <div className="grid grid-cols-2 gap-3">
                                {Object.entries(PRESETS).map(([key, preset]) => (
                                    <Button
                                        key={key}
                                        variant={
                                            temperature === preset.temperature
                                                ? 'default'
                                                : 'outline'
                                        }
                                        className={`h-auto py-4 px-4 flex-col items-start gap-1 transition-all ${temperature === preset.temperature ? 'border-primary' : ''}`}
                                        onClick={() => setTemperature(preset.temperature)}
                                    >
                                        <div className="flex items-center justify-between w-full">
                                            <span className="font-semibold capitalize text-sm">
                                                {key}
                                            </span>
                                            {temperature === preset.temperature && (
                                                <Check className="h-3 w-3" />
                                            )}
                                        </div>
                                        <span className="text-[10px] text-muted-foreground text-left leading-tight opacity-90">
                                            {preset.description}
                                        </span>
                                    </Button>
                                ))}
                            </div>
                        </div>

                        <Separator />

                        {/* UI Options */}
                        <div className="space-y-5">
                            <label className="text-sm font-medium">Interface Preferences</label>

                            <div className="flex items-center justify-between p-1">
                                <div>
                                    <p className="text-sm">Show Thoughts (CoT)</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        Expand/collapse AI reasoning chains
                                    </p>
                                </div>
                                <Button
                                    variant={showThoughts ? 'default' : 'secondary'}
                                    size="sm"
                                    onClick={() => setShowThoughts(!showThoughts)}
                                    className="w-16"
                                >
                                    {showThoughts ? 'On' : 'Off'}
                                </Button>
                            </div>

                            <div className="flex items-center justify-between p-1">
                                <div>
                                    <p className="text-sm">World State Panel</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        Show Inventory, Location & Relationships
                                    </p>
                                </div>
                                <Button
                                    variant={showWorldState ? 'default' : 'secondary'}
                                    size="sm"
                                    onClick={() => setShowWorldState(!showWorldState)}
                                    className="w-16"
                                >
                                    {showWorldState ? 'On' : 'Off'}
                                </Button>
                            </div>

                            <div className="flex items-center justify-between p-1">
                                <div>
                                    <p className="text-sm">Immersive Mode</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        Hide headers/sidebars for focused reading
                                    </p>
                                </div>
                                <Button
                                    variant={immersiveMode ? 'default' : 'secondary'}
                                    size="sm"
                                    onClick={() => setImmersiveMode(!immersiveMode)}
                                    className="w-16"
                                >
                                    {immersiveMode ? 'On' : 'Off'}
                                </Button>
                            </div>
                        </div>
                    </TabsContent>
                </Tabs>
            </SheetContent>
        </Sheet>
    );
}
