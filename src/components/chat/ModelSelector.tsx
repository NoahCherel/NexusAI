'use client';

import { useState, useEffect } from 'react';
import { ChevronDown, ChevronLeft, Plus, Sparkles, Zap, X, Cpu, Search, Check } from 'lucide-react';
import { useSettingsStore, DEFAULT_MODELS } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export function ModelSelector() {
    const { activeModel, setActiveModel, customModels, addCustomModel, removeCustomModel } =
        useSettingsStore();

    const [open, setOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
    const [isMobile, setIsMobile] = useState(false);

    // Form state for creating a new custom model
    const [isCreatingModel, setIsCreatingModel] = useState(false);
    const [newModelName, setNewModelName] = useState('');
    const [newModelConfigId, setNewModelConfigId] = useState('');
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

    // Combine default and custom models
    const allModels = [...DEFAULT_MODELS, ...customModels];
    const currentActiveModel = allModels.find((m) => m.modelId === activeModel);

    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 1024);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // Reset state when the dialog is closed so the user isn't stuck
    const handleOpenChange = (isOpen: boolean) => {
        setOpen(isOpen);
        if (!isOpen) {
            setSelectedModelId(null);
            setIsCreatingModel(false);
            setSearchQuery('');
        }
    };

    const handleCreateNew = () => {
        setSearchQuery('');
        setSelectedModelId(null);
        setIsCreatingModel(true);
        setNewModelName('');
        setNewModelConfigId('');
    };

    const handleSaveNewModel = () => {
        if (newModelName.trim() && newModelConfigId.trim()) {
            const newId = crypto.randomUUID();
            const configId = newModelConfigId.trim();
            addCustomModel({
                id: newId,
                name: newModelName.trim(),
                modelId: configId,
                provider: 'openrouter',
                isFree: configId.includes(':free'),
            });
            setIsCreatingModel(false);
            setSelectedModelId(configId);
            toast.success('Custom model added successfully');
        }
    };

    const confirmDelete = () => {
        if (selectedModelId) {
            const customModel = customModels.find((m) => m.modelId === selectedModelId);
            if (customModel) {
                removeCustomModel(customModel.id);
                if (activeModel === selectedModelId) {
                    setActiveModel(DEFAULT_MODELS[0].modelId);
                }
                setSelectedModelId(null);
                setConfirmDeleteOpen(false);
                toast.success('Custom model deleted');
            }
        }
    };

    const isCustomModel = (id: string) => customModels.some((m) => m.modelId === id);

    const filteredModels = allModels.filter(
        (m) =>
            m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            m.modelId.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const autoSelectedModel = allModels.find((m) => m.modelId === selectedModelId);
    const showEditorOnMobile = isMobile && (selectedModelId !== null || isCreatingModel);

    // Render grouped lists
    const renderModelGroup = (title: string, models: typeof allModels) => {
        if (models.length === 0) return null;
        return (
            <div className="space-y-1 mb-4">
                <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    {title}
                </div>
                {models.map((model) => (
                    <div
                        key={model.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                            setSelectedModelId(model.modelId);
                            setIsCreatingModel(false);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                setSelectedModelId(model.modelId);
                                setIsCreatingModel(false);
                            }
                        }}
                        className={cn(
                            'text-left p-2 rounded-lg text-xs transition-all flex items-center justify-between group h-11 shrink-0 cursor-pointer',
                            selectedModelId === model.modelId && !isCreatingModel
                                ? 'bg-primary/90 text-primary-foreground shadow-md shadow-primary/20 translate-x-1'
                                : 'hover:bg-muted/80 text-muted-foreground hover:text-foreground'
                        )}
                    >
                        <div className="flex items-center gap-2 min-w-0 flex-1 pl-1">
                            {model.isFree ? (
                                <Sparkles className={cn("w-4 h-4 shrink-0", selectedModelId === model.modelId && !isCreatingModel ? "text-primary-foreground" : "text-green-500")} />
                            ) : (
                                <Zap className={cn("w-4 h-4 shrink-0", selectedModelId === model.modelId && !isCreatingModel ? "text-primary-foreground" : "text-yellow-500")} />
                            )}
                            <span className="font-semibold truncate">
                                {model.name}
                            </span>
                        </div>
                        {activeModel === model.modelId && (
                            <div className="shrink-0 flex items-center mr-2">
                                <Check className={cn("w-4 h-4", selectedModelId === model.modelId && !isCreatingModel ? "text-primary-foreground" : "text-primary")} />
                            </div>
                        )}
                    </div>
                ))}
            </div>
        );
    };

    return (
        <>
            <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(true)}
            >
                {currentActiveModel?.isFree ? (
                    <Sparkles className="w-3 h-3 text-green-500 shrink-0" />
                ) : (
                    <Zap className="w-3 h-3 text-yellow-500 shrink-0" />
                )}
                <span className="max-w-[120px] truncate hidden sm:inline-block">
                    {currentActiveModel?.name || 'Select Model'}
                </span>
                <ChevronDown className="w-3 h-3 opacity-50 hidden sm:block shrink-0" />
            </Button>

            <Dialog open={open} onOpenChange={handleOpenChange}>
                <DialogContent showCloseButton={false} className="max-w-4xl h-[80vh] p-0 flex flex-col overflow-hidden glass-heavy border-primary/20">
                    <DialogTitle className="sr-only">Model Selector</DialogTitle>

                    {/* Header */}
                    <div className="flex items-center justify-between p-3 sm:p-4 border-b bg-muted/30 backdrop-blur-md shrink-0">
                        <div className="flex items-center gap-2 overflow-hidden">
                            {showEditorOnMobile && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => {
                                        setSelectedModelId(null);
                                        setIsCreatingModel(false);
                                    }}
                                    className="mr-1 h-8 w-8 shrink-0"
                                >
                                    <ChevronLeft className="w-5 h-5" />
                                </Button>
                            )}
                            <Cpu className="w-5 h-5 text-primary shrink-0" />
                            <h2 className="font-bold text-sm sm:text-base truncate">
                                {isMobile && autoSelectedModel
                                    ? autoSelectedModel.name
                                    : isMobile && isCreatingModel
                                        ? 'Add Custom Model'
                                        : 'Model Manager'}
                            </h2>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleOpenChange(false)}
                            className="h-8 w-8 text-muted-foreground hover:text-primary"
                        >
                            <X className="w-4 h-4" />
                        </Button>
                    </div>

                    <div className="flex flex-1 min-h-0 relative">
                        {/* Sidebar List */}
                        <div
                            className={cn(
                                'w-full lg:w-72 border-r flex flex-col bg-muted/10 transition-all duration-300',
                                showEditorOnMobile ? 'hidden lg:flex' : 'flex'
                            )}
                        >
                            <div className="p-3 border-b space-y-2 bg-muted/5">
                                <div className="relative">
                                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground outline-none" />
                                    <Input
                                        placeholder="Search models..."
                                        className="pl-9 h-9 text-xs bg-background/50 border-border/50 focus-visible:ring-primary/20"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                    />
                                </div>
                                <Button
                                    onClick={handleCreateNew}
                                    size="sm"
                                    variant={isCreatingModel ? 'default' : 'outline'}
                                    className={cn(
                                        "w-full text-xs gap-2 font-semibold h-9 shadow-sm",
                                        isCreatingModel && "bg-primary text-primary-foreground"
                                    )}
                                >
                                    <Plus className="w-3.5 h-3.5" /> Add Custom Model
                                </Button>
                            </div>

                            <ScrollArea className="flex-1 min-h-0 custom-scrollbar">
                                <div className="flex flex-col p-2 gap-1.5 pt-3 pb-8">
                                    {renderModelGroup('Free Models', filteredModels.filter(m => m.isFree))}
                                    {renderModelGroup('Premium Models', filteredModels.filter(m => !m.isFree && !isCustomModel(m.modelId)))}
                                    {renderModelGroup('Custom Models', filteredModels.filter(m => isCustomModel(m.modelId) && !m.isFree))}

                                    {filteredModels.length === 0 && (
                                        <div className="text-center py-12 px-6">
                                            <div className="bg-muted/20 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                                <Search className="w-6 h-6 opacity-20" />
                                            </div>
                                            <p className="text-muted-foreground text-xs font-medium">
                                                No models found
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </ScrollArea>
                        </div>

                        {/* Editor Area */}
                        <div
                            className={cn(
                                'flex-1 flex flex-col transition-all duration-300 bg-background/50',
                                !showEditorOnMobile && isMobile ? 'hidden' : 'flex'
                            )}
                        >
                            {isCreatingModel ? (
                                <div className="flex-1 flex flex-col p-4 sm:p-6 gap-6 overflow-y-auto custom-scrollbar">
                                    <div className="flex items-center gap-4 border-b border-border/50 pb-6 shrink-0">
                                        <div className="w-16 h-16 sm:h-20 sm:w-20 rounded-2xl bg-primary/10 flex items-center justify-center border-2 border-primary/20 ring-4 ring-muted shrink-0">
                                            <Plus className="w-8 h-8 text-primary" />
                                        </div>
                                        <div className="flex-1 min-w-0 flex flex-col gap-1.5 justify-center">
                                            <h3 className="text-lg sm:text-xl font-bold truncate">
                                                Add Custom Model
                                            </h3>
                                            <p className="text-xs text-muted-foreground">
                                                Add any model available in the OpenRouter API
                                            </p>
                                        </div>
                                    </div>

                                    <div className="space-y-4 shrink-0 max-w-2xl">
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                                Display Name
                                            </label>
                                            <Input
                                                className="bg-muted/5 focus-visible:ring-primary/20 h-10 font-medium"
                                                value={newModelName}
                                                onChange={(e) => setNewModelName(e.target.value)}
                                                placeholder="e.g., My Custom GPT"
                                            />
                                            <p className="text-[10px] text-muted-foreground mt-1">
                                                The name that will be displayed in the UI.
                                            </p>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                                Model ID (OpenRouter)
                                            </label>
                                            <Input
                                                className="bg-muted/5 focus-visible:ring-primary/20 h-10 font-mono text-sm"
                                                value={newModelConfigId}
                                                onChange={(e) => setNewModelConfigId(e.target.value)}
                                                placeholder="e.g., openai/gpt-4-turbo"
                                            />
                                            <p className="text-[10px] text-muted-foreground mt-1 gap-1 flex flex-col">
                                                <span>Use the exact slug from OpenRouter (e.g., <code className="bg-muted/50 px-1 py-0.5 rounded">anthropic/claude-3-opus</code>).</span>
                                                <span className="text-yellow-500/80">Premium custom models will consume your API credits.</span>
                                            </p>
                                        </div>

                                        <div className="pt-4">
                                            <Button
                                                onClick={handleSaveNewModel}
                                                disabled={!newModelName.trim() || !newModelConfigId.trim()}
                                                className="w-full sm:w-auto"
                                            >
                                                Save Model
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            ) : autoSelectedModel ? (
                                <div className="flex-1 flex flex-col p-4 sm:p-6 gap-6 overflow-y-auto custom-scrollbar">
                                    <div className="flex items-center gap-4 border-b border-border/50 pb-6 shrink-0">
                                        <div className="w-16 h-16 sm:h-20 sm:w-20 rounded-2xl bg-muted/30 flex items-center justify-center border-2 border-border/50 ring-4 ring-muted shrink-0">
                                            {autoSelectedModel.isFree ? (
                                                <Sparkles className="w-8 h-8 text-green-500" />
                                            ) : (
                                                <Zap className="w-8 h-8 text-yellow-500" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0 flex flex-col gap-1.5 justify-center">
                                            <h3 className="text-lg sm:text-xl font-bold truncate">
                                                {autoSelectedModel.name}
                                            </h3>
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    size="sm"
                                                    variant={
                                                        activeModel === autoSelectedModel.modelId
                                                            ? 'secondary'
                                                            : 'default'
                                                    }
                                                    className="text-xs h-7 px-3 w-fit"
                                                    onClick={() => {
                                                        setActiveModel(autoSelectedModel.modelId);
                                                        toast.success(
                                                            `Active model set to ${autoSelectedModel.name}`
                                                        );
                                                    }}
                                                    disabled={activeModel === autoSelectedModel.modelId}
                                                >
                                                    {activeModel === autoSelectedModel.modelId ? (
                                                        <>
                                                            <Check className="w-3.5 h-3.5 mr-1" />{' '}
                                                            Active
                                                        </>
                                                    ) : (
                                                        'Set as Active'
                                                    )}
                                                </Button>
                                                {autoSelectedModel.isFree ? (
                                                    <span className="text-[10px] font-bold text-green-500 bg-green-500/10 px-2 py-1 rounded">FREE</span>
                                                ) : (
                                                    <span className="text-[10px] font-bold text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">PREMIUM</span>
                                                )}
                                                {isCustomModel(autoSelectedModel.modelId) && (
                                                    <span className="text-[10px] font-bold text-blue-500 bg-blue-500/10 px-2 py-1 rounded hidden sm:inline-block">CUSTOM</span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="space-y-4 shrink-0 max-w-2xl">
                                        <div className="space-y-2">
                                            <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                                Model ID
                                            </label>
                                            <div className="bg-muted/30 rounded-md px-3 py-2 font-mono text-sm border border-border/50 text-foreground/80">
                                                {autoSelectedModel.modelId}
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <label className="text-[10px] font-bold uppercase tracking-widest text-primary/70">
                                                Provider
                                            </label>
                                            <div className="bg-muted/30 rounded-md px-3 py-2 text-sm border border-border/50 capitalize text-foreground/80">
                                                {autoSelectedModel.provider}
                                                {autoSelectedModel.provider === 'openrouter' && ' (API)'}
                                            </div>
                                        </div>
                                    </div>

                                    {isCustomModel(autoSelectedModel.modelId) && (
                                        <div className="flex items-center justify-between border-t border-border/50 pt-6 mt-4 shrink-0 max-w-2xl">
                                            <div />
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-destructive hover:bg-destructive/10 hover:text-destructive h-9 px-4 font-semibold"
                                                onClick={() => setConfirmDeleteOpen(true)}
                                            >
                                                <X className="w-4 h-4 mr-2" /> Remove Custom Model
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="flex-1 flex items-center justify-center bg-muted/5">
                                    <div className="text-center space-y-4 max-w-xs px-6">
                                        <div className="bg-primary/5 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto rotate-12">
                                            <Cpu className="w-8 h-8 text-primary/40" />
                                        </div>
                                        <div className="space-y-1">
                                            <h3 className="font-bold">No Model Selected</h3>
                                            <p className="text-xs text-muted-foreground leading-relaxed">
                                                Select a model from the list to view its details or add a new custom model.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Delete Confirmation Dialog */}
            <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
                <DialogContent className="sm:max-w-[400px] border-destructive/20 glass-heavy">
                    <DialogHeader>
                        <div className="w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-4">
                            <X className="w-6 h-6 text-destructive" />
                        </div>
                        <DialogTitle className="text-center">Remove Custom Model?</DialogTitle>
                        <DialogDescription className="text-center pt-2">
                            You are about to remove{' '}
                            <span className="font-bold text-foreground">
                                &quot;{autoSelectedModel?.name}&quot;
                            </span>
                            . This action cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="flex-row gap-2 mt-4">
                        <Button
                            variant="ghost"
                            className="flex-1"
                            onClick={() => setConfirmDeleteOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            className="flex-1 shadow-lg shadow-destructive/20"
                            onClick={confirmDelete}
                        >
                            Remove
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
