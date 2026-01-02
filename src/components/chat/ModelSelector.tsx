'use client';

import { useState } from 'react';
import { ChevronDown, Plus, Sparkles, Zap, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSettingsStore, DEFAULT_MODELS, type CustomModel } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';

export function ModelSelector() {
    const { activeModel, setActiveModel, customModels, addCustomModel, removeCustomModel } = useSettingsStore();
    const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
    const [newModelName, setNewModelName] = useState('');
    const [newModelId, setNewModelId] = useState('');

    // Combine default and custom models
    const allModels = [...DEFAULT_MODELS, ...customModels];
    const currentModel = allModels.find(m => m.modelId === activeModel);

    const handleAddModel = () => {
        if (newModelName.trim() && newModelId.trim()) {
            addCustomModel({
                id: crypto.randomUUID(),
                name: newModelName.trim(),
                modelId: newModelId.trim(),
                provider: 'openrouter',
                isFree: newModelId.includes(':free'),
            });
            setNewModelName('');
            setNewModelId('');
            setIsAddDialogOpen(false);
        }
    };

    const isCustomModel = (id: string) => customModels.some(m => m.id === id);

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                        {currentModel?.isFree ? (
                            <Sparkles className="w-3 h-3 text-green-500" />
                        ) : (
                            <Zap className="w-3 h-3 text-yellow-500" />
                        )}
                        <span className="max-w-[120px] truncate hidden sm:inline-block">
                            {currentModel?.name || 'Select Model'}
                        </span>
                        <ChevronDown className="w-3 h-3 opacity-50 hidden sm:block" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56 max-h-[300px] overflow-y-auto">
                    {/* Free Models */}
                    <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Free Models
                    </div>
                    {allModels.filter(m => m.isFree).map(model => (
                        <DropdownMenuItem
                            key={model.id}
                            onClick={() => setActiveModel(model.modelId)}
                            className="flex items-center justify-between"
                        >
                            <span className="flex items-center gap-2">
                                <Sparkles className="w-3 h-3 text-green-500" />
                                {model.name}
                            </span>
                            {activeModel === model.modelId && (
                                <span className="w-1.5 h-1.5 bg-primary rounded-full" />
                            )}
                        </DropdownMenuItem>
                    ))}

                    <DropdownMenuSeparator />

                    {/* Paid Models */}
                    <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Premium Models
                    </div>
                    {allModels.filter(m => !m.isFree).map(model => (
                        <DropdownMenuItem
                            key={model.id}
                            onClick={() => setActiveModel(model.modelId)}
                            className="flex items-center justify-between"
                        >
                            <span className="flex items-center gap-2">
                                <Zap className="w-3 h-3 text-yellow-500" />
                                {model.name}
                                {isCustomModel(model.id) && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            removeCustomModel(model.id);
                                        }}
                                        className="ml-auto p-0.5 hover:bg-destructive/20 rounded"
                                    >
                                        <X className="w-3 h-3 text-destructive" />
                                    </button>
                                )}
                            </span>
                            {activeModel === model.modelId && (
                                <span className="w-1.5 h-1.5 bg-primary rounded-full" />
                            )}
                        </DropdownMenuItem>
                    ))}

                    <DropdownMenuSeparator />

                    {/* Add Custom Model */}
                    <DropdownMenuItem onClick={() => setIsAddDialogOpen(true)}>
                        <Plus className="w-3 h-3 mr-2" />
                        Add Custom Model
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            {/* Add Model Dialog */}
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Add Custom Model</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Display Name</label>
                            <Input
                                placeholder="e.g., My Custom GPT"
                                value={newModelName}
                                onChange={(e) => setNewModelName(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Model ID</label>
                            <Input
                                placeholder="e.g., openai/gpt-4-turbo"
                                value={newModelId}
                                onChange={(e) => setNewModelId(e.target.value)}
                            />
                            <p className="text-xs text-muted-foreground">
                                Use the format from OpenRouter (e.g., anthropic/claude-3-opus)
                            </p>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleAddModel} disabled={!newModelName.trim() || !newModelId.trim()}>
                            Add Model
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
