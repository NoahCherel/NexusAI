'use client';

import { useState } from 'react';
import { Settings, Key, Sliders, Eye, EyeOff, Check, X, UserCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { useSettingsStore } from '@/stores';
import { encryptApiKey, validateApiKey } from '@/lib/crypto';
import { MODELS, PRESETS, type Provider } from '@/lib/ai';

interface SettingsPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
    const {
        apiKeys,
        activeProvider,
        activeModel,
        temperature,
        showThoughts,
        showWorldState,
        enableReasoning,
        personas,
        setApiKey,
        setActiveProvider,
        setActiveModel,
        setTemperature,
        setShowThoughts,
        setShowWorldState,
        setEnableReasoning,
        addPersona,
        deletePersona,
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
                        Paramètres
                    </SheetTitle>
                    <SheetDescription>
                        Configurez vos clés API et préférences de chat.
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
                        <TabsTrigger value="personas" className="flex-1 gap-2">
                            <UserCircle className="h-4 w-4" />
                            Personas
                        </TabsTrigger>
                    </TabsList>

                    {/* API Keys Tab */}
                    <TabsContent value="api" className="space-y-6 mt-4">
                        {/* Provider Selection */}
                        <div className="space-y-3">
                            <label className="text-sm font-medium">Fournisseur</label>
                            <div className="flex gap-2">
                                {(['openrouter', 'openai', 'anthropic'] as Provider[]).map((provider) => {
                                    const key = getKeyForProvider(provider);
                                    return (
                                        <Button
                                            key={provider}
                                            variant={selectedProvider === provider ? 'default' : 'outline'}
                                            size="sm"
                                            onClick={() => setSelectedProvider(provider)}
                                            className="flex-1 gap-1"
                                        >
                                            {provider === 'openrouter' && 'OpenRouter'}
                                            {provider === 'openai' && 'OpenAI'}
                                            {provider === 'anthropic' && 'Anthropic'}
                                            {key && (
                                                key.isValid ? (
                                                    <Check className="h-3 w-3 text-green-500" />
                                                ) : (
                                                    <X className="h-3 w-3 text-red-500" />
                                                )
                                            )}
                                        </Button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* API Key Input */}
                        <div className="space-y-3">
                            <label className="text-sm font-medium">Clé API {selectedProvider}</label>
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Input
                                        type={showKey ? 'text' : 'password'}
                                        value={newKey}
                                        onChange={(e) => setNewKey(e.target.value)}
                                        placeholder={`sk-... ou votre clé ${selectedProvider}`}
                                        className="pr-10"
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="absolute right-0 top-0 h-full"
                                        onClick={() => setShowKey(!showKey)}
                                    >
                                        {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </Button>
                                </div>
                                <Button onClick={handleSaveKey} disabled={!newKey.trim() || isValidating}>
                                    {isValidating ? 'Validation...' : 'Sauvegarder'}
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                🔒 Votre clé est chiffrée localement et jamais envoyée à nos serveurs.
                            </p>
                        </div>

                        <Separator />

                        {/* Model Selection */}
                        <div className="space-y-3">
                            <label className="text-sm font-medium">Modèle actif</label>
                            <div className="grid gap-2">
                                {MODELS[activeProvider]?.map((model) => (
                                    <Button
                                        key={model.id}
                                        variant={activeModel === model.id ? 'secondary' : 'ghost'}
                                        className="justify-between h-auto py-2"
                                        onClick={() => setActiveModel(model.id)}
                                    >
                                        <span>{model.name}</span>
                                        {model.free && (
                                            <Badge variant="outline" className="text-xs">
                                                Gratuit
                                            </Badge>
                                        )}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    </TabsContent>

                    {/* Chat Settings Tab */}
                    <TabsContent value="chat" className="space-y-6 mt-4">
                        {/* Reasoning Mode Toggle */}
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm">Mode Pensée (Reasoning)</p>
                                    <p className="text-xs text-muted-foreground">
                                        Active les tokens de raisonnement (pour modèles compatibles)
                                    </p>
                                </div>
                                <Button
                                    variant={enableReasoning ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => setEnableReasoning(!enableReasoning)}
                                >
                                    {enableReasoning ? 'Activé' : 'Désactivé'}
                                </Button>
                            </div>
                        </div>

                        <Separator />

                        {/* Presets */}
                        <div className="space-y-3">
                            <label className="text-sm font-medium">Preset</label>
                            <div className="grid grid-cols-2 gap-2">
                                {Object.entries(PRESETS).map(([key, preset]) => (
                                    <Button
                                        key={key}
                                        variant={temperature === preset.temperature ? 'secondary' : 'outline'}
                                        className="h-auto py-3 flex-col items-start"
                                        onClick={() => setTemperature(preset.temperature)}
                                    >
                                        <span className="font-medium capitalize">{key}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {preset.description}
                                        </span>
                                    </Button>
                                ))}
                            </div>
                        </div>

                        <Separator />

                        {/* UI Options */}
                        <div className="space-y-4">
                            <label className="text-sm font-medium">Affichage</label>

                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm">Afficher les pensées (CoT)</p>
                                    <p className="text-xs text-muted-foreground">
                                        Montre le raisonnement des modèles avancés
                                    </p>
                                </div>
                                <Button
                                    variant={showThoughts ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => setShowThoughts(!showThoughts)}
                                >
                                    {showThoughts ? 'Activé' : 'Désactivé'}
                                </Button>
                            </div>

                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm">Panneau État du Monde</p>
                                    <p className="text-xs text-muted-foreground">
                                        Inventaire, lieu, relations
                                    </p>
                                </div>
                                <Button
                                    variant={showWorldState ? 'default' : 'outline'}
                                    size="sm"
                                    onClick={() => setShowWorldState(!showWorldState)}
                                >
                                    {showWorldState ? 'Activé' : 'Désactivé'}
                                </Button>
                            </div>
                        </div>
                    </TabsContent>

                    {/* Personas Tab */}
                    <TabsContent value="personas" className="space-y-6 mt-4">
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <label className="text-sm font-medium">Mes Identités</label>
                            </div>

                            {/* Simple Add Form */}
                            <div className="grid gap-3 p-4 border rounded-lg bg-muted/20">
                                <p className="text-sm font-medium">Créer un nouveau persona</p>
                                <Input
                                    placeholder="Nom (ex: Aventurier)"
                                    id="new-persona-name"
                                />
                                <textarea
                                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                    placeholder="Biographie / Description (ex: Je suis un guerrier solitaire...)"
                                    id="new-persona-bio"
                                />
                                <Button
                                    onClick={() => {
                                        const nameInput = document.getElementById('new-persona-name') as HTMLInputElement;
                                        const bioInput = document.getElementById('new-persona-bio') as HTMLTextAreaElement;
                                        if (nameInput.value.trim()) {
                                            addPersona({
                                                id: crypto.randomUUID(),
                                                name: nameInput.value,
                                                bio: bioInput.value,
                                                avatar: '' // TODO: Avatar upload
                                            });
                                            nameInput.value = '';
                                            bioInput.value = '';
                                        }
                                    }}
                                >
                                    Ajouter
                                </Button>
                            </div>

                            <div className="space-y-2">
                                {personas.map((persona) => (
                                    <div key={persona.id} className="flex items-center justify-between p-3 border rounded-lg">
                                        <div>
                                            <p className="font-medium text-sm">{persona.name}</p>
                                            <p className="text-xs text-muted-foreground line-clamp-1">{persona.bio || 'Aucune description'}</p>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="text-destructive hover:bg-destructive/10"
                                            onClick={() => deletePersona(persona.id)}
                                        >
                                            <X className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ))}
                                {personas.length === 0 && (
                                    <p className="text-sm text-muted-foreground text-center py-4">
                                        Aucun persona créé.
                                    </p>
                                )}
                            </div>
                        </div>
                    </TabsContent>
                </Tabs>
            </SheetContent>
        </Sheet>
    );
}
