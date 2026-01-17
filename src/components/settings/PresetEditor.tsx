'use client';

import { useState, useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
} from '@/components/ui/select';
import { Save, Plus, Trash2, ChevronDown, Settings2, Sparkles } from 'lucide-react';
import type { APIPreset } from '@/types/preset';
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/types/preset';
import { cn } from '@/lib/utils';

interface PresetEditorProps {
    onClose?: () => void;
}

export function PresetEditor({ onClose }: PresetEditorProps) {
    const {
        presets,
        activePresetId,
        addPreset,
        updatePreset,
        deletePreset,
        setActivePreset,
        initializeDefaultPresets,
    } = useSettingsStore();

    // Initialize default presets if none exist
    useEffect(() => {
        if (presets.length === 0) {
            initializeDefaultPresets();
        }
    }, [presets.length, initializeDefaultPresets]);

    const activePreset = presets.find((p) => p.id === activePresetId);
    const [advancedOpen, setAdvancedOpen] = useState(false);

    // Local state for editing (to avoid updating on every keystroke)
    const [localPreset, setLocalPreset] = useState<APIPreset | null>(null);

    useEffect(() => {
        if (activePreset) {
            setLocalPreset({ ...activePreset });
        }
    }, [activePreset]);

    const handleSave = () => {
        if (localPreset && activePresetId) {
            updatePreset(activePresetId, localPreset);
        }
    };

    const handleCreateNew = () => {
        const newPreset: APIPreset = {
            id: crypto.randomUUID(),
            name: 'New Preset',
            description: 'Custom preset',
            temperature: 0.8,
            maxOutputTokens: 2048,
            maxContextTokens: 8192,
            topP: 0.95,
            systemPromptTemplate: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
            enableReasoning: false,
            createdAt: new Date(),
        };
        addPreset(newPreset);
        setActivePreset(newPreset.id);
    };

    const handleDelete = () => {
        if (activePresetId && !activePreset?.isDefault) {
            deletePreset(activePresetId);
        }
    };

    if (!localPreset) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-muted-foreground">Loading presets...</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-background">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b">
                <div className="flex items-center gap-3">
                    <Settings2 className="w-5 h-5 text-primary" />
                    <h2 className="font-bold text-lg">API Presets</h2>
                </div>
                <div className="flex items-center gap-2">
                    <Select
                        value={activePresetId || ''}
                        onValueChange={(v: string) => setActivePreset(v)}
                    >
                        <SelectTrigger className="w-48">
                            <span className="truncate">
                                {activePreset ? activePreset.name : 'Select preset'}
                            </span>
                        </SelectTrigger>
                        <SelectContent>
                            {presets.map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                    {p.name}
                                    {p.isDefault && (
                                        <span className="text-xs text-muted-foreground ml-2">
                                            (default)
                                        </span>
                                    )}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button variant="outline" size="icon" onClick={handleCreateNew}>
                        <Plus className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            <ScrollArea className="flex-1">
                <div className="p-4 space-y-6">
                    {/* Preset Name & Description */}
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label>Preset Name</Label>
                            <Input
                                value={localPreset.name}
                                onChange={(e) =>
                                    setLocalPreset({ ...localPreset, name: e.target.value })
                                }
                                placeholder="My Preset"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Description</Label>
                            <Input
                                value={localPreset.description || ''}
                                onChange={(e) =>
                                    setLocalPreset({ ...localPreset, description: e.target.value })
                                }
                                placeholder="What this preset is for..."
                            />
                        </div>
                    </div>

                    {/* System Prompt Template */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label className="text-base font-semibold">System Prompt Template</Label>
                            <span className="text-xs text-muted-foreground">
                                {localPreset.systemPromptTemplate.length} chars
                            </span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">
                            Use placeholders: <code className="bg-muted px-1 rounded">{'{{character_name}}'}</code>,{' '}
                            <code className="bg-muted px-1 rounded">{'{{character_description}}'}</code>,{' '}
                            <code className="bg-muted px-1 rounded">{'{{world_state}}'}</code>,{' '}
                            <code className="bg-muted px-1 rounded">{'{{lorebook}}'}</code>
                        </p>
                        <Textarea
                            value={localPreset.systemPromptTemplate}
                            onChange={(e) =>
                                setLocalPreset({
                                    ...localPreset,
                                    systemPromptTemplate: e.target.value,
                                })
                            }
                            className="min-h-[200px] font-mono text-sm"
                            placeholder="You are {{character_name}}..."
                        />
                    </div>

                    {/* Basic Parameters */}
                    <div className="grid gap-4 sm:grid-cols-3">
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <Label>Temperature</Label>
                                <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded">
                                    {localPreset.temperature.toFixed(2)}
                                </span>
                            </div>
                            <Slider
                                value={[localPreset.temperature]}
                                min={0}
                                max={2}
                                step={0.05}
                                onValueChange={([v]) =>
                                    setLocalPreset({ ...localPreset, temperature: v })
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Max Output Tokens</Label>
                            <Input
                                type="number"
                                value={localPreset.maxOutputTokens}
                                onChange={(e) =>
                                    setLocalPreset({
                                        ...localPreset,
                                        maxOutputTokens: parseInt(e.target.value) || 2048,
                                    })
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Max Context Tokens</Label>
                            <Input
                                type="number"
                                value={localPreset.maxContextTokens}
                                onChange={(e) =>
                                    setLocalPreset({
                                        ...localPreset,
                                        maxContextTokens: parseInt(e.target.value) || 8192,
                                    })
                                }
                            />
                        </div>
                    </div>

                    {/* Feature Toggles */}
                    <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={localPreset.enableReasoning}
                                onChange={(e) =>
                                    setLocalPreset({
                                        ...localPreset,
                                        enableReasoning: e.target.checked,
                                    })
                                }
                                className="w-4 h-4 rounded border-border"
                            />
                            <span className="text-sm font-medium">Enable Reasoning (CoT)</span>
                            <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                        </label>
                    </div>

                    {/* Advanced Parameters */}
                    <div className="border rounded-lg">
                        <Button
                            variant="ghost"
                            className="w-full justify-between"
                            onClick={() => setAdvancedOpen(!advancedOpen)}
                        >
                            <span>Advanced Parameters</span>
                            <ChevronDown
                                className={cn(
                                    'w-4 h-4 transition-transform',
                                    advancedOpen && 'rotate-180'
                                )}
                            />
                        </Button>
                        {advancedOpen && (
                            <div className="p-4 border-t">
                                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                    <div className="space-y-2">
                                        <Label>Top P</Label>
                                        <Input
                                            type="number"
                                            value={localPreset.topP || 0.95}
                                            onChange={(e) =>
                                                setLocalPreset({
                                                    ...localPreset,
                                                    topP: parseFloat(e.target.value) || 0.95,
                                                })
                                            }
                                            min={0}
                                            max={1}
                                            step={0.05}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Top K</Label>
                                        <Input
                                            type="number"
                                            value={localPreset.topK || 40}
                                            onChange={(e) =>
                                                setLocalPreset({
                                                    ...localPreset,
                                                    topK: parseInt(e.target.value) || 40,
                                                })
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Frequency Penalty</Label>
                                        <Input
                                            type="number"
                                            value={localPreset.frequencyPenalty || 0}
                                            onChange={(e) =>
                                                setLocalPreset({
                                                    ...localPreset,
                                                    frequencyPenalty: parseFloat(e.target.value) || 0,
                                                })
                                            }
                                            min={-2}
                                            max={2}
                                            step={0.1}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Presence Penalty</Label>
                                        <Input
                                            type="number"
                                            value={localPreset.presencePenalty || 0}
                                            onChange={(e) =>
                                                setLocalPreset({
                                                    ...localPreset,
                                                    presencePenalty: parseFloat(e.target.value) || 0,
                                                })
                                            }
                                            min={-2}
                                            max={2}
                                            step={0.1}
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </ScrollArea>

            {/* Footer */}
            <div className="flex items-center justify-between p-4 border-t">
                <div>
                    {!activePreset?.isDefault && (
                        <Button variant="ghost" size="sm" onClick={handleDelete} className="text-destructive">
                            <Trash2 className="w-4 h-4 mr-2" />
                            Delete
                        </Button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {onClose && (
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                    )}
                    <Button onClick={handleSave}>
                        <Save className="w-4 h-4 mr-2" />
                        Save Preset
                    </Button>
                </div>
            </div>
        </div>
    );
}
