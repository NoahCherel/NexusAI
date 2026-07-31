'use client';

import { useState, useEffect } from 'react';
import {
    Save,
    Plus,
    Trash2,
    Sparkles,
    MessageSquare,
    Sliders,
    BookOpen,
    Zap,
    Upload,
    Download,
    FileJson,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSettingsStore } from '@/stores';
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE, DEFAULT_PRESETS, type APIPreset } from '@/types/preset';
import { useNotificationStore } from '@/components/ui/api-notification';
import { useRef } from 'react';

export function PresetEditor() {
    const { addNotification, updateNotification } = useNotificationStore();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const toast = {
        success: (message: string) => {
            const id = addNotification(message);
            updateNotification(id, 'success', message);
        },
        error: (message: string) => {
            const id = addNotification(message);
            updateNotification(id, 'error', message);
        },
    };

    const {
        presets,
        activePresetId,
        addPreset,
        updatePreset,
        deletePreset,
        setActivePreset,
        initializeDefaultPresets,
        lorebookAutoExtract,
        setLorebookAutoExtract,
        enableFactExtraction,
        setEnableFactExtraction,
        enableHierarchicalSummaries,
        setEnableHierarchicalSummaries,
        enableRAGRetrieval,
        setEnableRAGRetrieval,
    } = useSettingsStore();

    // Ensure defaults exist
    useEffect(() => {
        initializeDefaultPresets();
    }, [initializeDefaultPresets]);

    const activePreset = presets.find((p) => p.id === activePresetId);

    const handleCreatePreset = () => {
        const newPreset: APIPreset = {
            ...DEFAULT_PRESETS[0],
            id: crypto.randomUUID(),
            name: 'Nouveau preset',
            createdAt: new Date(),
            isDefault: false,
        };
        addPreset(newPreset);
        setActivePreset(newPreset.id);
        toast.success('Nouveau preset créé');
    };

    const handleDeletePreset = () => {
        if (!activePresetId) return;
        deletePreset(activePresetId);
        if (presets.length > 1) {
            setActivePreset(presets.find((p) => p.id !== activePresetId)?.id || null);
        } else {
            setActivePreset(null);
        }
        toast.success('Preset supprimé');
    };

    const handleExportJSON = () => {
        if (!activePreset) return;
        const dataStr =
            'data:text/json;charset=utf-8,' +
            encodeURIComponent(JSON.stringify(activePreset, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute('href', dataStr);
        downloadAnchorNode.setAttribute(
            'download',
            `${activePreset.name.replace(/\s+/g, '_')}.json`
        );
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        toast.success('Preset exporté');
    };

    const handleImportJSON = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target?.result as string);

                // Map external JSON format to APIPreset
                // We use a base default preset to ensure all fields exist
                const base = DEFAULT_PRESETS[0];

                const importedPreset: APIPreset = {
                    ...base, // Start with defaults
                    id: crypto.randomUUID(),
                    name: json.name || file.name.replace('.json', '') || 'Preset importé',
                    // Generation
                    temperature: json.temperature ?? base.temperature,
                    maxOutputTokens:
                        json.max_tokens ?? json.maxOutputTokens ?? base.maxOutputTokens, // Common alias
                    maxContextTokens:
                        json.context_length ?? json.maxContextTokens ?? base.maxContextTokens,
                    topP: json.top_p ?? base.topP,
                    topK: json.top_k ?? base.topK,
                    minP: json.min_p ?? base.minP,
                    repetitionPenalty: json.repetition_penalty ?? base.repetitionPenalty,
                    frequencyPenalty: json.frequency_penalty ?? base.frequencyPenalty,
                    presencePenalty: json.presence_penalty ?? base.presencePenalty,
                    stoppingStrings: json.stopping_strings ?? base.stoppingStrings,

                    // Prompt Structure (Mapping requested by user)
                    // main_prompt -> systemPromptTemplate
                    systemPromptTemplate:
                        json.main_prompt ?? json.systemPromptTemplate ?? base.systemPromptTemplate,

                    // jailbreak_prompt -> postHistoryInstructions (Driver/Behavior enforcement)
                    // pre_history_instructions / jailbreak -> mapped to post history instructions based on user feedback that jailbreak is usually "Driver"
                    // But standard logic: "Pre-History" is usually jailbreak. User requested jailbreak -> Post-History?
                    // Wait, user said "Post-History Instructions wasn't imported from my JSON".
                    // And in the request "Here is a preset JSON... jailbreak_prompt".
                    // If user wants jailbreak_prompt to be Post-History, I will map it there.

                    preHistoryInstructions:
                        json.pre_history_instructions ?? base.preHistoryInstructions,
                    postHistoryInstructions:
                        json.jailbreak_prompt ??
                        json.post_history_instructions ??
                        base.postHistoryInstructions,

                    impersonationPrompt:
                        json.impersonation_prompt ??
                        json.impersonationPrompt ??
                        base.impersonationPrompt,
                    assistantPrefill:
                        json.assistant_prefill ?? json.assistantPrefill ?? base.assistantPrefill,

                    // Misc
                    enableReasoning: json.enable_reasoning ?? json.enableReasoning ?? base.enableReasoning ?? false,
                    includeNames: json.names_in_completion ?? base.includeNames,
                    useFlexTier: json.use_flex_tier ?? json.useFlexTier ?? base.useFlexTier ?? false,

                    createdAt: new Date(),
                    isDefault: false,
                };

                addPreset(importedPreset);
                setActivePreset(importedPreset.id);
                toast.success('Preset importé avec succès');
            } catch (err) {
                console.error('Import failed', err);
                toast.error('Impossible de lire le JSON du preset');
            }
            // Reset input
            if (fileInputRef.current) fileInputRef.current.value = '';
        };
        reader.readAsText(file);
    };

    if (!activePreset) {
        return (
            <div className="flex flex-col items-center justify-center h-full p-8 text-center text-muted-foreground">
                <Sparkles className="h-12 w-12 mb-4 opacity-20" />
                <p>Aucun preset sélectionné.</p>
                <Button onClick={handleCreatePreset} className="mt-4">
                    Créer votre premier preset
                </Button>
            </div>
        );
    }

    const update = (updates: Partial<APIPreset>) => {
        updatePreset(activePreset.id, updates);
    };

    return (
        <div className="flex flex-col h-full bg-background no-doc-scroll">
            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept=".json"
                onChange={handleImportJSON}
            />

            {/* Header */}
            <div className="flex flex-wrap items-center justify-between p-4 border-b shrink-0 gap-3">
                <div className="flex flex-wrap items-center gap-1 sm:gap-3 flex-1 min-w-0">
                    <Select
                        value={activePresetId || ''}
                        onValueChange={(v: string) => setActivePreset(v)}
                    >
                        <SelectTrigger className="w-[130px] sm:w-[220px] shrink-0">
                            <span className="truncate text-left font-medium">
                                {activePreset.name}
                            </span>
                        </SelectTrigger>
                        <SelectContent>
                            {presets.map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                    {p.name}
                                    {p.isDefault && (
                                        <span className="text-xs text-muted-foreground ml-2">
                                            (Défaut)
                                        </span>
                                    )}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleCreatePreset}
                        title="Nouveau preset"
                    >
                        <Plus className="h-4 w-4" />
                    </Button>

                    <div className="w-px h-6 bg-border/50 mx-1" />

                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => fileInputRef.current?.click()}
                        title="Importer un JSON"
                    >
                        <Upload className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleExportJSON}
                        title="Exporter en JSON"
                    >
                        <Download className="h-4 w-4" />
                    </Button>
                </div>

                {!activePreset.isDefault && (
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleDeletePreset}
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        title="Supprimer le preset"
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                )}
            </div>

            {/* Main Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="p-1 space-y-6 max-w-3xl mx-auto pb-20">
                    {/* Basic Info */}
                    <div className="grid gap-4 p-4">
                        <div className="grid gap-2">
                            <Label>Nom du preset</Label>
                            <Input
                                value={activePreset.name}
                                onChange={(e) => update({ name: e.target.value })}
                                disabled={activePreset.isDefault}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label>Description</Label>
                            <Input
                                value={activePreset.description || ''}
                                onChange={(e) => update({ description: e.target.value })}
                                placeholder="Courte description…"
                            />
                        </div>
                    </div>

                    <Tabs defaultValue="prompt" className="w-full">
                        <div className="px-4 max-sm:px-2">
                            {/* grid-cols-4 overflows 375px — mobile scrolls horizontally. */}
                            <TabsList className="w-full justify-start h-auto p-1 bg-muted/50 rounded-lg grid grid-cols-4 max-sm:flex max-sm:overflow-x-auto no-scrollbar">
                                <TabsTrigger
                                    value="prompt"
                                    className="gap-2 data-[state=active]:bg-background max-sm:shrink-0"
                                >
                                    <MessageSquare className="h-3.5 w-3.5" /> Prompt
                                </TabsTrigger>
                                <TabsTrigger
                                    value="generation"
                                    className="gap-2 data-[state=active]:bg-background max-sm:shrink-0"
                                >
                                    <Sliders className="h-3.5 w-3.5" /> Génération
                                </TabsTrigger>
                                <TabsTrigger
                                    value="lorebook"
                                    className="gap-2 data-[state=active]:bg-background max-sm:shrink-0"
                                >
                                    <BookOpen className="h-3.5 w-3.5" /> Lorebook
                                </TabsTrigger>
                                <TabsTrigger
                                    value="advanced"
                                    className="gap-2 data-[state=active]:bg-background max-sm:shrink-0"
                                >
                                    <Zap className="h-3.5 w-3.5" /> Avancé
                                </TabsTrigger>
                            </TabsList>
                        </div>

                        {/* --- Prompt Tab --- */}
                        <TabsContent value="prompt" className="p-4 space-y-6">
                            <div className="space-y-2">
                                <Label>Instructions pré-historique (note système)</Label>
                                <p className="text-xs text-muted-foreground">
                                    Insérées avant l&apos;historique du chat.
                                </p>
                                <Textarea
                                    value={activePreset.preHistoryInstructions || ''}
                                    onChange={(e) =>
                                        update({ preHistoryInstructions: e.target.value })
                                    }
                                    className="min-h-[100px] font-mono text-sm"
                                    placeholder="[System note: ...]"
                                />
                            </div>

                            <div className="space-y-2">
                                <Label className="flex justify-between">
                                    Template de system prompt
                                    <Button
                                        variant="link"
                                        className="h-auto p-0 text-xs"
                                        onClick={() =>
                                            update({
                                                systemPromptTemplate:
                                                    DEFAULT_SYSTEM_PROMPT_TEMPLATE,
                                            })
                                        }
                                    >
                                        Rétablir le défaut
                                    </Button>
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                    Placeholders disponibles : {'{{character_name}}'},
                                    {'{{lorebook}}'}
                                </p>
                                <Textarea
                                    value={activePreset.systemPromptTemplate}
                                    onChange={(e) =>
                                        update({ systemPromptTemplate: e.target.value })
                                    }
                                    className="min-h-[200px] font-mono text-sm"
                                    placeholder="Le prompt principal…"
                                />
                            </div>

                            <div className="space-y-2">
                                <Label>Instructions post-historique</Label>
                                <p className="text-xs text-muted-foreground">
                                    Ajoutées à la fin du prompt (Driver).
                                </p>
                                <Textarea
                                    value={activePreset.postHistoryInstructions || ''}
                                    onChange={(e) =>
                                        update({ postHistoryInstructions: e.target.value })
                                    }
                                    className="min-h-[100px] font-mono text-sm"
                                    placeholder="Consignes pour la prochaine réponse…"
                                />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="md:col-span-2 space-y-2">
                                    <Label>Note de prompt (note d&apos;auteur)</Label>
                                    <Textarea
                                        value={activePreset.promptNote || ''}
                                        onChange={(e) => update({ promptNote: e.target.value })}
                                        className="min-h-[80px]"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Profondeur d&apos;insertion</Label>
                                    <Input
                                        type="number"
                                        value={activePreset.promptNoteDepth || 4}
                                        onChange={(e) =>
                                            update({
                                                promptNoteDepth: parseInt(e.target.value) || 0,
                                            })
                                        }
                                        min={0}
                                    />
                                    <p className="text-[10px] text-muted-foreground">
                                        Messages depuis la fin
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label>Prompt d&apos;impersonation</Label>
                                <p className="text-xs text-muted-foreground">
                                    Utilisé pour générer un message du joueur (icône robot).
                                </p>
                                <Textarea
                                    value={activePreset.impersonationPrompt || ''}
                                    onChange={(e) =>
                                        update({ impersonationPrompt: e.target.value })
                                    }
                                    className="min-h-[80px] font-mono text-sm"
                                    placeholder="[Write the next message from {{user}}'s perspective...]"
                                />
                            </div>
                        </TabsContent>

                        {/* --- Generation Tab --- */}
                        <TabsContent value="generation" className="p-4 space-y-8">
                            <div className="space-y-4">
                                <Label>Temperature: {activePreset.temperature}</Label>
                                <Input
                                    type="number"
                                    value={activePreset.temperature}
                                    onChange={(e) =>
                                        update({ temperature: parseFloat(e.target.value) })
                                    }
                                    step={0.01}
                                    min={0}
                                    max={2}
                                />
                                <p className="text-xs text-muted-foreground">
                                    Créativité vs logique. Plus haut = plus créatif/aléatoire.
                                </p>
                            </div>

                            <div className="grid grid-cols-2 gap-8">
                                <div className="space-y-4">
                                    <Label>Tokens de sortie max</Label>
                                    <Input
                                        type="number"
                                        value={activePreset.maxOutputTokens}
                                        onChange={(e) =>
                                            update({ maxOutputTokens: parseInt(e.target.value) })
                                        }
                                        min={100}
                                        step={100}
                                    />
                                </div>
                                <div className="space-y-4">
                                    <Label>Taille du contexte</Label>
                                    <Input
                                        type="number"
                                        value={activePreset.maxContextTokens}
                                        onChange={(e) =>
                                            update({ maxContextTokens: parseInt(e.target.value) })
                                        }
                                        min={2048}
                                        step={1024}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-6">
                                <div className="space-y-3">
                                    <Label>Top P</Label>
                                    <Input
                                        type="number"
                                        value={activePreset.topP}
                                        onChange={(e) =>
                                            update({ topP: parseFloat(e.target.value) })
                                        }
                                        step={0.01}
                                        min={0}
                                        max={1}
                                    />
                                </div>
                                <div className="space-y-3">
                                    <Label>Top K</Label>
                                    <Input
                                        type="number"
                                        value={activePreset.topK}
                                        onChange={(e) => update({ topK: parseInt(e.target.value) })}
                                        step={1}
                                        min={0}
                                    />
                                </div>
                                <div className="space-y-3">
                                    <Label>Min P</Label>
                                    <Input
                                        type="number"
                                        value={activePreset.minP || 0}
                                        onChange={(e) =>
                                            update({ minP: parseFloat(e.target.value) })
                                        }
                                        step={0.01}
                                        min={0}
                                        max={1}
                                    />
                                    {(activePreset.minP ?? 0) > 0.3 && (
                                        <p className="text-xs text-amber-500">
                                            ⚠️ Min P élevé : proche d&apos;un décodage glouton, tue la
                                            variété et donne des réponses répétitives. Valeur usuelle
                                            0–0.1 (1 = quasi déterministe).
                                        </p>
                                    )}
                                </div>
                            </div>

                            <div className="space-y-4 border-t pt-4">
                                <Label>Pénalités</Label>
                                <div className="grid grid-cols-1 gap-6">
                                    <div className="space-y-3">
                                        <div className="flex justify-between">
                                            <span className="text-sm">Pénalité de répétition</span>
                                        </div>
                                        <Input
                                            type="number"
                                            value={activePreset.repetitionPenalty}
                                            onChange={(e) =>
                                                update({
                                                    repetitionPenalty: parseFloat(e.target.value),
                                                })
                                            }
                                            step={0.01}
                                            min={0}
                                        />
                                        {activePreset.repetitionPenalty < 1 && (
                                            <p className="text-xs text-amber-500">
                                                ⚠️ Sous 1.0, la repetition penalty <em>encourage</em>{' '}
                                                la répétition (le neutre est 1.0). Pour pénaliser les
                                                redites, vise ~1.05–1.15.
                                            </p>
                                        )}
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-3">
                                            <Label>Fréquence</Label>
                                            <Input
                                                type="number"
                                                value={activePreset.frequencyPenalty}
                                                onChange={(e) =>
                                                    update({
                                                        frequencyPenalty: parseFloat(
                                                            e.target.value
                                                        ),
                                                    })
                                                }
                                                step={0.1}
                                            />
                                        </div>
                                        <div className="space-y-3">
                                            <Label>Présence</Label>
                                            <Input
                                                type="number"
                                                value={activePreset.presencePenalty}
                                                onChange={(e) =>
                                                    update({
                                                        presencePenalty: parseFloat(e.target.value),
                                                    })
                                                }
                                                step={0.1}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </TabsContent>

                        {/* --- Lorebook Tab --- */}
                        <TabsContent value="lorebook" className="p-4 space-y-6">
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <Label>Utiliser les lorebooks</Label>
                                        <p className="text-xs text-muted-foreground">
                                            Active l&apos;injection dynamique de contexte
                                        </p>
                                    </div>
                                    <Button
                                        variant={activePreset.useLorebooks ? 'default' : 'outline'}
                                        onClick={() =>
                                            update({ useLorebooks: !activePreset.useLorebooks })
                                        }
                                    >
                                        {activePreset.useLorebooks ? 'Activé' : 'Désactivé'}
                                    </Button>
                                </div>

                                <div className="space-y-4 pt-4">
                                    <Label>Profondeur de scan</Label>
                                    <Input
                                        type="number"
                                        value={activePreset.lorebookScanDepth || 2}
                                        onChange={(e) =>
                                            update({ lorebookScanDepth: parseInt(e.target.value) })
                                        }
                                        min={1}
                                        step={1}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Nombre de messages récents scannés pour les mots-clés.
                                    </p>
                                </div>

                                <div className="space-y-4">
                                    <Label>Budget de tokens</Label>
                                    <Input
                                        type="number"
                                        value={activePreset.lorebookTokenBudget || 500}
                                        onChange={(e) =>
                                            update({
                                                lorebookTokenBudget: parseInt(e.target.value),
                                            })
                                        }
                                        min={100}
                                        step={100}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Tokens max alloués aux entrées de lorebook.
                                    </p>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <Label>Scan récursif</Label>
                                    <Button
                                        size="sm"
                                        variant={
                                            activePreset.lorebookRecursiveScanning
                                                ? 'default'
                                                : 'secondary'
                                        }
                                        onClick={() =>
                                            update({
                                                lorebookRecursiveScanning:
                                                    !activePreset.lorebookRecursiveScanning,
                                            })
                                        }
                                    >
                                        {activePreset.lorebookRecursiveScanning ? 'On' : 'Off'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <Label>Mots entiers uniquement</Label>
                                    <Button
                                        size="sm"
                                        variant={
                                            activePreset.matchWholeWords ? 'default' : 'secondary'
                                        }
                                        onClick={() =>
                                            update({
                                                matchWholeWords: !activePreset.matchWholeWords,
                                            })
                                        }
                                    >
                                        {activePreset.matchWholeWords ? 'On' : 'Off'}
                                    </Button>
                                </div>
                            </div>
                        </TabsContent>

                        {/* --- Advanced Tab --- */}
                        <TabsContent value="advanced" className="p-4 space-y-6">
                            <div className="space-y-4">
                                <Label>Interrupteurs</Label>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">
                                            Activer le raisonnement (CoT)
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Pour les modèles type DeepSeek R1
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={
                                            activePreset.enableReasoning ? 'default' : 'secondary'
                                        }
                                        onClick={() =>
                                            update({
                                                enableReasoning: !activePreset.enableReasoning,
                                            })
                                        }
                                    >
                                        {activePreset.enableReasoning ? 'On' : 'Off'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">Inclure les noms</p>
                                        <p className="text-xs text-muted-foreground">
                                            Préfixe les messages par les noms
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={
                                            activePreset.includeNames ? 'default' : 'secondary'
                                        }
                                        onClick={() =>
                                            update({ includeNames: !activePreset.includeNames })
                                        }
                                    >
                                        {activePreset.includeNames ? 'Oui' : 'Non'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">Bannir les emojis</p>
                                        <p className="text-xs text-muted-foreground">
                                            Retire les emojis des réponses
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={activePreset.banEmojis ? 'default' : 'secondary'}
                                        onClick={() =>
                                            update({ banEmojis: !activePreset.banEmojis })
                                        }
                                    >
                                        {activePreset.banEmojis ? 'Oui' : 'Non'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">Résumé automatique</p>
                                        <p className="text-xs text-muted-foreground">
                                            Résume périodiquement l&apos;historique
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={
                                            activePreset.useAutoSummarization
                                                ? 'default'
                                                : 'secondary'
                                        }
                                        onClick={() =>
                                            update({
                                                useAutoSummarization:
                                                    !activePreset.useAutoSummarization,
                                            })
                                        }
                                    >
                                        {activePreset.useAutoSummarization ? 'On' : 'Off'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">
                                            Palier Flex OpenRouter
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Route les requêtes via le palier flexible (tarif
                                            réduit) d&apos;OpenRouter quand il est disponible
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={
                                            activePreset.useFlexTier ? 'default' : 'secondary'
                                        }
                                        onClick={() =>
                                            update({
                                                useFlexTier: !activePreset.useFlexTier,
                                            })
                                        }
                                    >
                                        {activePreset.useFlexTier ? 'On' : 'Off'}
                                    </Button>
                                </div>
                            </div>

                            {/* RAG / Memory System */}
                            <div className="space-y-4">
                                <Label>Système de mémoire (RAG)</Label>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">Rappel RAG</p>
                                        <p className="text-xs text-muted-foreground">
                                            Récupère le contexte passé pertinent à chaque message
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={enableRAGRetrieval ? 'default' : 'secondary'}
                                        onClick={() => setEnableRAGRetrieval(!enableRAGRetrieval)}
                                    >
                                        {enableRAGRetrieval ? 'On' : 'Off'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">Extraction de facts</p>
                                        <p className="text-xs text-muted-foreground">
                                            Extrait les faits clés des réponses de l&apos;IA
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={enableFactExtraction ? 'default' : 'secondary'}
                                        onClick={() =>
                                            setEnableFactExtraction(!enableFactExtraction)
                                        }
                                    >
                                        {enableFactExtraction ? 'On' : 'Off'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">
                                            Résumés hiérarchiques
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Crée automatiquement des résumés d&apos;histoire
                                            L0/L1/L2
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={
                                            enableHierarchicalSummaries ? 'default' : 'secondary'
                                        }
                                        onClick={() =>
                                            setEnableHierarchicalSummaries(
                                                !enableHierarchicalSummaries
                                            )
                                        }
                                    >
                                        {enableHierarchicalSummaries ? 'On' : 'Off'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">
                                            Auto-extraction lorebook
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Suggère de nouvelles entrées de lorebook depuis les
                                            réponses de l&apos;IA
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={lorebookAutoExtract ? 'default' : 'secondary'}
                                        onClick={() => setLorebookAutoExtract(!lorebookAutoExtract)}
                                    >
                                        {lorebookAutoExtract ? 'On' : 'Off'}
                                    </Button>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label>Préremplissage assistant</Label>
                                <Input
                                    value={activePreset.assistantPrefill || ''}
                                    onChange={(e) => update({ assistantPrefill: e.target.value })}
                                    placeholder="Commencer la réponse par…"
                                />
                            </div>
                        </TabsContent>
                    </Tabs>
                </div>
            </div>
        </div>
    );
}
