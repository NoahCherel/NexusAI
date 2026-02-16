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
            name: 'New Components Preset',
            createdAt: new Date(),
            isDefault: false,
        };
        addPreset(newPreset);
        setActivePreset(newPreset.id);
        toast.success('New preset created');
    };

    const handleDeletePreset = () => {
        if (!activePresetId) return;
        deletePreset(activePresetId);
        if (presets.length > 1) {
            setActivePreset(presets.find((p) => p.id !== activePresetId)?.id || null);
        } else {
            setActivePreset(null);
        }
        toast.success('Preset deleted');
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
        toast.success('Preset exported');
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
                    name: json.name || file.name.replace('.json', '') || 'Imported Preset',
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
                    enableReasoning: false, // Default to false unless specific
                    includeNames: json.names_in_completion ?? base.includeNames,

                    createdAt: new Date(),
                    isDefault: false,
                };

                addPreset(importedPreset);
                setActivePreset(importedPreset.id);
                toast.success('Preset imported successfully');
            } catch (err) {
                console.error('Import failed', err);
                toast.error('Failed to parse preset JSON');
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
                <p>No preset selected.</p>
                <Button onClick={handleCreatePreset} className="mt-4">
                    Create your first preset
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
            <div className="flex items-center justify-between p-4 border-b shrink-0">
                <div className="flex items-center gap-3">
                    <Select
                        value={activePresetId || ''}
                        onValueChange={(v: string) => setActivePreset(v)}
                    >
                        <SelectTrigger className="w-56">
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
                                            (Default)
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
                        title="New Preset"
                    >
                        <Plus className="h-4 w-4" />
                    </Button>

                    <div className="w-px h-6 bg-border/50 mx-1" />

                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => fileInputRef.current?.click()}
                        title="Import JSON"
                    >
                        <Upload className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleExportJSON}
                        title="Export JSON"
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
                        title="Delete Preset"
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
                            <Label>Preset Name</Label>
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
                                placeholder="Short description..."
                            />
                        </div>
                    </div>

                    <Tabs defaultValue="prompt" className="w-full">
                        <div className="px-4">
                            <TabsList className="w-full justify-start h-auto p-1 bg-muted/50 rounded-lg grid grid-cols-4">
                                <TabsTrigger
                                    value="prompt"
                                    className="gap-2 data-[state=active]:bg-background"
                                >
                                    <MessageSquare className="h-3.5 w-3.5" /> Prompt
                                </TabsTrigger>
                                <TabsTrigger
                                    value="generation"
                                    className="gap-2 data-[state=active]:bg-background"
                                >
                                    <Sliders className="h-3.5 w-3.5" /> Generation
                                </TabsTrigger>
                                <TabsTrigger
                                    value="lorebook"
                                    className="gap-2 data-[state=active]:bg-background"
                                >
                                    <BookOpen className="h-3.5 w-3.5" /> Lorebook
                                </TabsTrigger>
                                <TabsTrigger
                                    value="advanced"
                                    className="gap-2 data-[state=active]:bg-background"
                                >
                                    <Zap className="h-3.5 w-3.5" /> Advanced
                                </TabsTrigger>
                            </TabsList>
                        </div>

                        {/* --- Prompt Tab --- */}
                        <TabsContent value="prompt" className="p-4 space-y-6">
                            <div className="space-y-2">
                                <Label>Pre-History Instructions (System Note)</Label>
                                <p className="text-xs text-muted-foreground">
                                    Inserted before the chat history.
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
                                    System Prompt Template
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
                                        Reset to Default
                                    </Button>
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                    Use placeholders: {'{{character_name}}'}, {'{{world_state}}'},{' '}
                                    {'{{lorebook}}'}
                                </p>
                                <Textarea
                                    value={activePreset.systemPromptTemplate}
                                    onChange={(e) =>
                                        update({ systemPromptTemplate: e.target.value })
                                    }
                                    className="min-h-[200px] font-mono text-sm"
                                    placeholder="The main prompt..."
                                />
                            </div>

                            <div className="space-y-2">
                                <Label>Post-History Instructions</Label>
                                <p className="text-xs text-muted-foreground">
                                    Appended at the end of the prompt (Driver).
                                </p>
                                <Textarea
                                    value={activePreset.postHistoryInstructions || ''}
                                    onChange={(e) =>
                                        update({ postHistoryInstructions: e.target.value })
                                    }
                                    className="min-h-[100px] font-mono text-sm"
                                    placeholder="Guidance for the next response..."
                                />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="md:col-span-2 space-y-2">
                                    <Label>Prompt Note (Author&apos;s Note)</Label>
                                    <Textarea
                                        value={activePreset.promptNote || ''}
                                        onChange={(e) => update({ promptNote: e.target.value })}
                                        className="min-h-[80px]"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Insertion Depth</Label>
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
                                        Messages from bottom
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label>Impersonation Prompt</Label>
                                <p className="text-xs text-muted-foreground">
                                    Used when generating a user message (Robot icon).
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
                                    Creativity vs Logic. Higher = more creative/random.
                                </p>
                            </div>

                            <div className="grid grid-cols-2 gap-8">
                                <div className="space-y-4">
                                    <Label>Max Output Tokens</Label>
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
                                    <Label>Context Size</Label>
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
                                </div>
                            </div>

                            <div className="space-y-4 border-t pt-4">
                                <Label>Penalties</Label>
                                <div className="grid grid-cols-1 gap-6">
                                    <div className="space-y-3">
                                        <div className="flex justify-between">
                                            <span className="text-sm">Repetition Penalty</span>
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
                                            min={1}
                                        />
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-3">
                                            <Label>Frequency</Label>
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
                                            <Label>Presence</Label>
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
                                        <Label>Use Lorebooks</Label>
                                        <p className="text-xs text-muted-foreground">
                                            Enable dynamic context injection
                                        </p>
                                    </div>
                                    <Button
                                        variant={activePreset.useLorebooks ? 'default' : 'outline'}
                                        onClick={() =>
                                            update({ useLorebooks: !activePreset.useLorebooks })
                                        }
                                    >
                                        {activePreset.useLorebooks ? 'Enabled' : 'Disabled'}
                                    </Button>
                                </div>

                                <div className="space-y-4 pt-4">
                                    <Label>Scan Depth</Label>
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
                                        Number of recent messages to scan for keywords.
                                    </p>
                                </div>

                                <div className="space-y-4">
                                    <Label>Token Budget</Label>
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
                                        Max tokens allocated to lorebook entries.
                                    </p>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <Label>Recursive Scanning</Label>
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
                                    <Label>Match Whole Words</Label>
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
                                <Label>Toggles</Label>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">
                                            Enable Reasoning (CoT)
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            For models like DeepSeek R1
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
                                        <p className="text-sm font-medium">Include Names</p>
                                        <p className="text-xs text-muted-foreground">
                                            Prepend names to messages
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
                                        {activePreset.includeNames ? 'Yes' : 'No'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">Ban Emojis</p>
                                        <p className="text-xs text-muted-foreground">
                                            Strip emojis from response
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant={activePreset.banEmojis ? 'default' : 'secondary'}
                                        onClick={() =>
                                            update({ banEmojis: !activePreset.banEmojis })
                                        }
                                    >
                                        {activePreset.banEmojis ? 'Yes' : 'No'}
                                    </Button>
                                </div>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">Auto Summarization</p>
                                        <p className="text-xs text-muted-foreground">
                                            Periodically summarize history
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
                            </div>

                            {/* RAG / Memory System */}
                            <div className="space-y-4">
                                <Label>Memory System (RAG)</Label>

                                <div className="flex items-center justify-between p-2 border rounded">
                                    <div>
                                        <p className="text-sm font-medium">RAG Retrieval</p>
                                        <p className="text-xs text-muted-foreground">
                                            Retrieve relevant past context for each message
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
                                        <p className="text-sm font-medium">Fact Extraction</p>
                                        <p className="text-xs text-muted-foreground">
                                            Extract key facts from AI responses
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
                                            Hierarchical Summaries
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Auto-create L0/L1/L2 story summaries
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
                                        <p className="text-sm font-medium">Lorebook Auto-Extract</p>
                                        <p className="text-xs text-muted-foreground">
                                            Suggest new lorebook entries from AI responses
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
                                <Label>Assistant Prefill</Label>
                                <Input
                                    value={activePreset.assistantPrefill || ''}
                                    onChange={(e) => update({ assistantPrefill: e.target.value })}
                                    placeholder="Start the response with..."
                                />
                            </div>
                        </TabsContent>
                    </Tabs>
                </div>
            </div>
        </div>
    );
}
