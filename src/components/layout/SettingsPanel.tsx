import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
    Settings,
    Key,
    Sliders,
    Eye,
    EyeOff,
    Check,
    X,
    Settings2,
    Bot,
    ChevronDown,
    RefreshCw,
} from 'lucide-react';
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
import { DEFAULT_MODELS, type CustomModel } from '@/stores/settings-store';
import { encryptApiKey, decryptApiKey, validateApiKey } from '@/lib/crypto';
import { type Provider } from '@/lib/ai';
import { NanoGPTUsagePanel } from '@/components/layout/NanoGPTUsage';
import { PresetEditor } from '@/components/settings/PresetEditor';
import { BUILTIN_ENGINES } from '@/lib/ai/rp-engine';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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
        useFlexTier,
        immersiveMode,
        backgroundModel,
        customModels,
        setApiKey,
        setActiveProvider,
        setTemperature,
        setShowThoughts,
        setShowWorldState,
        setEnableReasoning,
        setUseFlexTier,
        setImmersiveMode,
        setBackgroundModel,
        lorebookAutoExtract,
        setLorebookAutoExtract,
        useCanonCodex,
        setUseCanonCodex,
        useCanonAutoFetch,
        setUseCanonAutoFetch,
        activeProvider,
        nanogptModels,
        setNanogptModels,
        activeEngineId,
        setActiveEngineId,
        customEngines,
    } = useSettingsStore();

    const allModels = [...DEFAULT_MODELS, ...customModels];
    const allEngines = [...BUILTIN_ENGINES, ...customEngines];
    const activeEngine = allEngines.find((e) => e.id === activeEngineId) || null;

    const [newKey, setNewKey] = useState('');
    const [selectedProvider, setSelectedProvider] = useState<Provider>('openrouter');
    const [isValidating, setIsValidating] = useState(false);
    const [showKey, setShowKey] = useState(false);
    const [isFetchingModels, setIsFetchingModels] = useState(false);

    // Fetch the models included in the user's NanoGPT subscription and store them.
    const fetchNanogptModels = async (apiKey: string) => {
        setIsFetchingModels(true);
        try {
            const res = await fetch('/api/nanogpt/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey }),
            });
            if (!res.ok) return;
            const data = await res.json();
            if (Array.isArray(data.models)) {
                setNanogptModels(data.models as CustomModel[]);
            }
        } catch (error) {
            console.error('Failed to fetch NanoGPT models:', error);
        } finally {
            setIsFetchingModels(false);
        }
    };

    // Manual refresh: decrypt the stored NanoGPT key and refetch the subscription model list.
    const refreshNanogptModels = async () => {
        const cfg = apiKeys.find((k) => k.provider === 'nanogpt');
        if (!cfg) return;
        try {
            const apiKey = await decryptApiKey(cfg.encryptedKey);
            if (apiKey) await fetchNanogptModels(apiKey);
        } catch (error) {
            console.error('Failed to decrypt NanoGPT key:', error);
        }
    };

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
                // For NanoGPT, populate the subscription model list right away (we still have the
                // plaintext key here, before it's cleared).
                if (selectedProvider === 'nanogpt') {
                    void fetchNanogptModels(newKey);
                }
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
                                    <div className="flex flex-wrap gap-3">
                                        {(
                                            [
                                                'openrouter',
                                                'openai',
                                                'anthropic',
                                                'nanogpt',
                                            ] as Provider[]
                                        ).map((provider) => {
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
                                                    className="flex-1 min-w-[120px] gap-2 h-10"
                                                >
                                                    {provider === 'openrouter' && 'OpenRouter'}
                                                    {provider === 'openai' && 'OpenAI'}
                                                    {provider === 'anthropic' && 'Anthropic'}
                                                    {provider === 'nanogpt' && 'NanoGPT'}
                                                    {key &&
                                                        (key.isValid ? (
                                                            <Check className="h-3 w-3 text-green-500" />
                                                        ) : (
                                                            <X className="h-3 w-3 text-red-500" />
                                                        ))}
                                                </Button>
                                            );
                                        })}
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

                                {/* NanoGPT subscription: model list + monthly/weekly quota */}
                                {selectedProvider === 'nanogpt' && (
                                    <div className="space-y-4">
                                        <div className="flex items-center justify-between">
                                            <label className="text-sm font-medium">
                                                Modèles d&apos;abonnement
                                            </label>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-8 gap-2"
                                                onClick={refreshNanogptModels}
                                                disabled={
                                                    isFetchingModels ||
                                                    !getKeyForProvider('nanogpt')
                                                }
                                            >
                                                <RefreshCw
                                                    className={`h-3.5 w-3.5 ${isFetchingModels ? 'animate-spin' : ''}`}
                                                />
                                                Rafraîchir
                                            </Button>
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {nanogptModels.length > 0
                                                ? `${nanogptModels.length} modèles inclus, disponibles dans le sélecteur (groupe « NanoGPT (Abonnement) »).`
                                                : 'Aucun modèle chargé. Enregistrez une clé NanoGPT valide, ou cliquez sur Rafraîchir.'}
                                        </p>
                                        <NanoGPTUsagePanel />
                                    </div>
                                )}
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
                                
                                {/* OpenRouter Flex Tier Toggle */}
                                {activeProvider === 'openrouter' && (
                                    <div className="space-y-4">
                                        <div className="flex items-center justify-between p-4 border rounded-lg bg-card/50">
                                            <div>
                                                <p className="text-sm font-medium">
                                                    OpenRouter Flex Tier
                                                </p>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    Routes requests through OpenRouter&apos;s flexible (discounted) tier when available for supported models (e.g. Gemini 3.5 Flash)
                                                </p>
                                            </div>
                                            <Button
                                                variant={useFlexTier ? 'default' : 'secondary'}
                                                size="sm"
                                                onClick={() => setUseFlexTier(!useFlexTier)}
                                                className="w-16"
                                            >
                                                {useFlexTier ? 'On' : 'Off'}
                                            </Button>
                                        </div>
                                    </div>
                                )}

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

                                {/* Canon Codex master switch */}
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between p-4 border rounded-lg bg-card/50">
                                        <div>
                                            <p className="text-sm font-medium">Canon Codex</p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                Master toggle for the Arc Compass, casting canon, and
                                                Director system. Off ⇒ no canon/arc/casting injection
                                                in the prompt at all.
                                            </p>
                                        </div>
                                        <Button
                                            variant={useCanonCodex ? 'default' : 'secondary'}
                                            size="sm"
                                            onClick={() => setUseCanonCodex(!useCanonCodex)}
                                            className="w-16"
                                        >
                                            {useCanonCodex ? 'On' : 'Off'}
                                        </Button>
                                    </div>

                                    {/* Sub-toggle: web auto-fetch */}
                                    <div
                                        className={cn(
                                            'flex items-center justify-between p-4 border rounded-lg bg-card/50',
                                            !useCanonCodex && 'opacity-50 pointer-events-none'
                                        )}
                                    >
                                        <div>
                                            <p className="text-sm font-medium">
                                                Canon — Web Auto-Fetch
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                When off, no API calls are made for canon (no roster
                                                populate, no dossier fetch, no arc map fetch).
                                                Dossiers and arc map you wrote manually are still
                                                injected. Use this for custom universes.
                                            </p>
                                        </div>
                                        <Button
                                            variant={useCanonAutoFetch ? 'default' : 'secondary'}
                                            size="sm"
                                            onClick={() =>
                                                setUseCanonAutoFetch(!useCanonAutoFetch)
                                            }
                                            className="w-16"
                                        >
                                            {useCanonAutoFetch ? 'On' : 'Off'}
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
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    className="w-full h-9 justify-between font-normal"
                                                >
                                                    <span className="truncate">
                                                        {backgroundModel
                                                            ? (allModels.find(
                                                                  (m) =>
                                                                      m.modelId === backgroundModel
                                                              )?.name ?? backgroundModel)
                                                            : 'Auto (Free Models)'}
                                                    </span>
                                                    <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent
                                                align="start"
                                                className="w-[var(--radix-dropdown-menu-trigger-width)] max-h-[300px] overflow-y-auto"
                                            >
                                                <DropdownMenuItem
                                                    onClick={() => setBackgroundModel(null)}
                                                    className="flex items-center justify-between"
                                                >
                                                    Auto (Free Models)
                                                    {!backgroundModel && (
                                                        <span className="w-1.5 h-1.5 bg-primary rounded-full" />
                                                    )}
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                                    Free Models
                                                </div>
                                                {allModels
                                                    .filter((m) => m.isFree)
                                                    .map((model) => (
                                                        <DropdownMenuItem
                                                            key={model.modelId}
                                                            onClick={() =>
                                                                setBackgroundModel(model.modelId)
                                                            }
                                                            className="flex items-center justify-between"
                                                        >
                                                            {model.name}
                                                            {backgroundModel === model.modelId && (
                                                                <span className="w-1.5 h-1.5 bg-primary rounded-full" />
                                                            )}
                                                        </DropdownMenuItem>
                                                    ))}
                                                {allModels.filter((m) => !m.isFree).length > 0 && (
                                                    <>
                                                        <DropdownMenuSeparator />
                                                        <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                                            Premium Models
                                                        </div>
                                                        {allModels
                                                            .filter((m) => !m.isFree)
                                                            .map((model) => (
                                                                <DropdownMenuItem
                                                                    key={model.modelId}
                                                                    onClick={() =>
                                                                        setBackgroundModel(
                                                                            model.modelId
                                                                        )
                                                                    }
                                                                    className="flex items-center justify-between"
                                                                >
                                                                    {model.name}
                                                                    {backgroundModel ===
                                                                        model.modelId && (
                                                                        <span className="w-1.5 h-1.5 bg-primary rounded-full" />
                                                                    )}
                                                                </DropdownMenuItem>
                                                            ))}
                                                    </>
                                                )}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </div>

                                <Separator />

                                {/* RP Engine */}
                                <div className="space-y-4">
                                    <div>
                                        <label className="text-sm font-medium">RP Engine</label>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            Behavioral rules that shape how the AI writes — player
                                            autonomy, NPC knowledge limits, natural dialogue,
                                            disciplined prose, anti-cliché. Chosen independently of
                                            the API preset.
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <Button
                                            variant={
                                                activeEngineId === null ? 'default' : 'secondary'
                                            }
                                            size="sm"
                                            onClick={() => setActiveEngineId(null)}
                                        >
                                            Off
                                        </Button>
                                        {allEngines.map((engine) => (
                                            <Button
                                                key={engine.id}
                                                variant={
                                                    activeEngineId === engine.id
                                                        ? 'default'
                                                        : 'secondary'
                                                }
                                                size="sm"
                                                onClick={() => setActiveEngineId(engine.id)}
                                            >
                                                {engine.name}
                                                {engine.experimental ? ' (exp.)' : ''}
                                            </Button>
                                        ))}
                                    </div>
                                    {activeEngine && (
                                        <p className="text-xs text-muted-foreground p-3 border rounded-lg bg-card/50">
                                            {activeEngine.description}
                                        </p>
                                    )}
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
