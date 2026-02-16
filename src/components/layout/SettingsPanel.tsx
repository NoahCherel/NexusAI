import { useState } from 'react';
import { Settings, Key, Sliders, Eye, EyeOff, Check, X, Settings2, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { useSettingsStore } from '@/stores';
import { DEFAULT_MODELS } from '@/stores/settings-store';
import { encryptApiKey, validateApiKey } from '@/lib/crypto';
import { type Provider } from '@/lib/ai';
import { PresetEditor } from '@/components/settings/PresetEditor';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';

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
        backgroundModel,
        customModels,
        setApiKey,
        setActiveProvider,
        setTemperature,
        setShowThoughts,
        setShowWorldState,
        setEnableReasoning,
        setImmersiveMode,
        setBackgroundModel,
        lorebookAutoExtract,
        setLorebookAutoExtract,
    } = useSettingsStore();

    const allModels = [...DEFAULT_MODELS, ...customModels];

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
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-5xl w-[95vw] h-[90vh] flex flex-col p-0 gap-0 overflow-hidden bg-background/95 backdrop-blur-xl border-border/50">
                <DialogHeader className="p-6 pb-2 border-b shrink-0">
                    <DialogTitle className="flex items-center gap-2 text-xl">
                        <Settings className="h-5 w-5" />
                        Settings
                    </DialogTitle>
                    <DialogDescription>
                        Configure your API keys, chat preferences, and generation presets.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex-1 overflow-hidden">
                    <Tabs defaultValue="api" className="h-full flex flex-col">
                        <div className="px-6 py-2 border-b shrink-0 bg-muted/20">
                            <TabsList className="w-full max-w-md grid grid-cols-3">
                                <TabsTrigger value="api" className="gap-2">
                                    <Key className="h-4 w-4" />
                                    API
                                </TabsTrigger>
                                <TabsTrigger value="chat" className="gap-2">
                                    <Sliders className="h-4 w-4" />
                                    Chat
                                </TabsTrigger>
                                <TabsTrigger value="presets" className="gap-2">
                                    <Settings2 className="h-4 w-4" />
                                    Presets
                                </TabsTrigger>
                            </TabsList>
                        </div>

                        {/* API Keys Tab */}
                        <TabsContent
                            value="api"
                            className="flex-1 overflow-y-auto p-6 space-y-8 m-0 outline-none"
                        >
                            <div className="max-w-2xl mx-auto space-y-8">
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
                                                        onClick={() =>
                                                            setSelectedProvider(provider)
                                                        }
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
                                        🔒 Your key is encrypted locally using AES-256-GCM and
                                        stored only in your browser&apos;s LocalStorage. It is never
                                        sent to our servers.
                                    </p>
                                </div>
                            </div>
                        </TabsContent>

                        {/* Chat Settings Tab */}
                        <TabsContent
                            value="chat"
                            className="flex-1 overflow-y-auto p-6 space-y-8 m-0 outline-none"
                        >
                            <div className="max-w-2xl mx-auto space-y-8">
                                {/* Reasoning Mode Toggle */}
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between p-4 border rounded-lg bg-card/50">
                                        <div>
                                            <p className="text-sm font-medium">
                                                Thinking Mode (Reasoning)
                                            </p>
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

                                <div className="space-y-4">
                                    <div className="flex items-center justify-between p-4 border rounded-lg bg-card/50">
                                        <div>
                                            <p className="text-sm font-medium">
                                                Auto-Extract Lorebook
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                Automatically analyze chat to suggest new lorebook
                                                entries or append to existing ones (Suggestions
                                                Queue)
                                            </p>
                                        </div>
                                        <Button
                                            variant={lorebookAutoExtract ? 'default' : 'secondary'}
                                            size="sm"
                                            onClick={() =>
                                                setLorebookAutoExtract(!lorebookAutoExtract)
                                            }
                                            className="w-16"
                                        >
                                            {lorebookAutoExtract ? 'On' : 'Off'}
                                        </Button>
                                    </div>
                                </div>

                                {/* Background AI Model */}
                                <div className="space-y-4">
                                    <div className="p-4 border rounded-lg bg-card/50 space-y-3">
                                        <div>
                                            <p className="text-sm font-medium flex items-center gap-2">
                                                <Bot className="h-4 w-4" />
                                                Background AI Model
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                Model used for summaries, fact extraction, world
                                                state analysis, and lorebook suggestions. &quot;Auto
                                                (Free)&quot; rotates between free models with
                                                fallback.
                                            </p>
                                        </div>
                                        <Select
                                            value={backgroundModel ?? '__auto__'}
                                            onValueChange={(v) =>
                                                setBackgroundModel(v === '__auto__' ? null : v)
                                            }
                                        >
                                            <SelectTrigger className="w-full h-9">
                                                <span className="block truncate">
                                                    {backgroundModel
                                                        ? (allModels.find(
                                                              (m) => m.modelId === backgroundModel
                                                          )?.name ?? backgroundModel)
                                                        : 'Auto (Free Models)'}
                                                </span>
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="__auto__">
                                                    Auto (Free Models)
                                                </SelectItem>
                                                {allModels
                                                    .filter((m) => m.isFree)
                                                    .map((model) => (
                                                        <SelectItem
                                                            key={model.modelId}
                                                            value={model.modelId}
                                                        >
                                                            {model.name}
                                                        </SelectItem>
                                                    ))}
                                                {allModels.filter((m) => !m.isFree).length > 0 && (
                                                    <>
                                                        {allModels
                                                            .filter((m) => !m.isFree)
                                                            .map((model) => (
                                                                <SelectItem
                                                                    key={model.modelId}
                                                                    value={model.modelId}
                                                                >
                                                                    {model.name}
                                                                </SelectItem>
                                                            ))}
                                                    </>
                                                )}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                <Separator />

                                {/* UI Options */}
                                <div className="space-y-5">
                                    <label className="text-sm font-medium">
                                        Interface Preferences
                                    </label>

                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between p-3 border rounded-lg bg-card/50">
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

                                        <div className="flex items-center justify-between p-3 border rounded-lg bg-card/50">
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

                                        <div className="flex items-center justify-between p-3 border rounded-lg bg-card/50">
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
                                </div>
                            </div>
                        </TabsContent>

                        {/* Presets Tab */}
                        <TabsContent
                            value="presets"
                            className="flex-1 overflow-hidden m-0 data-[state=inactive]:hidden"
                        >
                            <PresetEditor />
                        </TabsContent>
                    </Tabs>
                </div>
            </DialogContent>
        </Dialog>
    );
}
