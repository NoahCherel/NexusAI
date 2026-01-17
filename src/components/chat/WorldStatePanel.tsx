'use client';

import { motion } from 'framer-motion';
import { Package, MapPin, Heart, ChevronUp, Edit2, X, Check, Trash2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useChatStore } from '@/stores/chat-store';

interface WorldStatePanelProps {
    inventory: string[];
    location: string;
    relationships: Record<string, number>;
    isCollapsed?: boolean;
    onToggle?: () => void;
}

export function WorldStatePanel({
    inventory,
    location,
    relationships,
    isCollapsed = false,
    onToggle,
}: WorldStatePanelProps) {
    const { activeConversationId, updateWorldState } = useChatStore();
    const relationshipEntries = Object.entries(relationships);

    // Edit states
    const [isEditingLocation, setIsEditingLocation] = useState(false);
    const [editLocation, setEditLocation] = useState(location);
    const [isAddingItem, setIsAddingItem] = useState(false);
    const [newItem, setNewItem] = useState('');
    const [isAddingRelation, setIsAddingRelation] = useState(false);
    const [newRelationName, setNewRelationName] = useState('');
    const [newRelationValue, setNewRelationValue] = useState(0);

    const handleSaveLocation = () => {
        if (activeConversationId) {
            updateWorldState(activeConversationId, { location: editLocation });
        }
        setIsEditingLocation(false);
    };

    const handleRemoveItem = (item: string) => {
        if (activeConversationId) {
            updateWorldState(activeConversationId, {
                inventory: inventory.filter((i) => i !== item),
            });
        }
    };

    const handleAddItem = () => {
        if (newItem.trim() && activeConversationId) {
            updateWorldState(activeConversationId, {
                inventory: [...inventory, newItem.trim()],
            });
            setNewItem('');
            setIsAddingItem(false);
        }
    };

    const handleRemoveRelation = (name: string) => {
        if (activeConversationId) {
            const newRelationships = { ...relationships };
            delete newRelationships[name];
            updateWorldState(activeConversationId, { relationships: newRelationships });
        }
    };

    const handleAddRelation = () => {
        if (newRelationName.trim() && activeConversationId) {
            updateWorldState(activeConversationId, {
                relationships: { ...relationships, [newRelationName.trim()]: newRelationValue },
            });
            setNewRelationName('');
            setNewRelationValue(0);
            setIsAddingRelation(false);
        }
    };

    const handleUpdateRelationValue = (name: string, value: number) => {
        if (activeConversationId) {
            updateWorldState(activeConversationId, {
                relationships: { ...relationships, [name]: value },
            });
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="backdrop-blur-md bg-card/60 border border-border/50 rounded-xl overflow-hidden shadow-sm transition-all hover:shadow-md"
        >
            {/* Header */}
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between p-3.5 bg-muted/20 hover:bg-muted/40 transition-colors"
            >
                <span className="font-semibold text-sm tracking-tight flex items-center gap-2">
                    <span className="text-base">🌍</span> World Context
                </span>
                <ChevronUp
                    className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${isCollapsed ? 'rotate-180' : ''
                        }`}
                />
            </button>

            {!isCollapsed ? (
                <div className="p-4 space-y-5">
                    {/* Location */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                                <MapPin className="w-3 h-3" />
                                <span>Location</span>
                            </div>
                            {!isEditingLocation && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-5 w-5 opacity-50 hover:opacity-100"
                                    onClick={() => {
                                        setEditLocation(location);
                                        setIsEditingLocation(true);
                                    }}
                                >
                                    <Edit2 className="w-3 h-3" />
                                </Button>
                            )}
                        </div>
                        {isEditingLocation ? (
                            <div className="flex gap-1">
                                <Input
                                    value={editLocation}
                                    onChange={(e) => setEditLocation(e.target.value)}
                                    className="h-8 text-sm"
                                    autoFocus
                                    onKeyDown={(e) => e.key === 'Enter' && handleSaveLocation()}
                                />
                                <Button
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={handleSaveLocation}
                                >
                                    <Check className="w-3 h-3" />
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8"
                                    onClick={() => setIsEditingLocation(false)}
                                >
                                    <X className="w-3 h-3" />
                                </Button>
                            </div>
                        ) : (
                            <div className="text-sm font-medium leading-relaxed bg-background/50 p-2 rounded-md border border-border/50">
                                {location || 'Unknown location'}
                            </div>
                        )}
                    </div>

                    {/* Inventory */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                                <Package className="w-3 h-3" />
                                <span>Inventory</span>
                            </div>
                            {!isAddingItem && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-5 w-5 opacity-50 hover:opacity-100"
                                    onClick={() => setIsAddingItem(true)}
                                >
                                    <Plus className="w-3 h-3" />
                                </Button>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {inventory.length > 0 ? (
                                inventory.map((item, index) => (
                                    <Badge
                                        key={index}
                                        variant="secondary"
                                        className="text-[10px] px-2 py-0.5 bg-secondary/50 hover:bg-secondary border-border/50 group cursor-pointer"
                                        onClick={() => handleRemoveItem(item)}
                                    >
                                        {item}
                                        <X className="w-2.5 h-2.5 ml-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </Badge>
                                ))
                            ) : (
                                <span className="text-xs text-muted-foreground italic px-1">
                                    Empty inventory
                                </span>
                            )}
                        </div>
                        {isAddingItem && (
                            <div className="flex gap-1 mt-2">
                                <Input
                                    value={newItem}
                                    onChange={(e) => setNewItem(e.target.value)}
                                    placeholder="New item..."
                                    className="h-7 text-xs"
                                    autoFocus
                                    onKeyDown={(e) => e.key === 'Enter' && handleAddItem()}
                                />
                                <Button size="icon" className="h-7 w-7" onClick={handleAddItem}>
                                    <Check className="w-3 h-3" />
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    onClick={() => {
                                        setIsAddingItem(false);
                                        setNewItem('');
                                    }}
                                >
                                    <X className="w-3 h-3" />
                                </Button>
                            </div>
                        )}
                    </div>

                    {/* Relationships */}
                    <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                                <Heart className="w-3 h-3" />
                                <span>Relationships</span>
                            </div>
                            {!isAddingRelation && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-5 w-5 opacity-50 hover:opacity-100"
                                    onClick={() => setIsAddingRelation(true)}
                                >
                                    <Plus className="w-3 h-3" />
                                </Button>
                            )}
                        </div>
                        <div className="space-y-3">
                            {relationshipEntries.map(([name, level]) => {
                                const percent = Math.max(0, Math.min(100, (level + 100) / 2));
                                let color = 'bg-gray-500';
                                if (level >= 30) color = 'bg-green-500';
                                else if (level >= 10) color = 'bg-emerald-500';
                                else if (level <= -30) color = 'bg-red-600';
                                else if (level <= -10) color = 'bg-orange-500';

                                return (
                                    <div key={name} className="space-y-1.5 group">
                                        <div className="flex items-center justify-between text-xs font-medium">
                                            <span className="flex items-center gap-1">
                                                {name}
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity"
                                                    onClick={() => handleRemoveRelation(name)}
                                                >
                                                    <Trash2 className="w-2.5 h-2.5 text-destructive" />
                                                </Button>
                                            </span>
                                            <input
                                                type="number"
                                                value={level}
                                                onChange={(e) =>
                                                    handleUpdateRelationValue(
                                                        name,
                                                        parseInt(e.target.value) || 0
                                                    )
                                                }
                                                className={`w-12 text-right bg-transparent border-none outline-none appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${level < 0 ? 'text-red-400' : 'text-green-500'} font-bold`}
                                                min={-100}
                                                max={100}
                                            />
                                        </div>
                                        <div className="h-2 bg-muted/60 rounded-full overflow-hidden relative shadow-inner">
                                            <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-foreground/20 z-10" />
                                            <motion.div
                                                initial={{ width: '50%' }}
                                                animate={{ width: `${percent}%` }}
                                                transition={{ duration: 0.8, ease: 'easeOut' }}
                                                className={`h-full rounded-full ${color} shadow-sm`}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                            {relationshipEntries.length === 0 && !isAddingRelation && (
                                <span className="text-xs text-muted-foreground italic">
                                    No relationships
                                </span>
                            )}
                        </div>
                        {isAddingRelation && (
                            <div className="flex gap-1 mt-2">
                                <Input
                                    value={newRelationName}
                                    onChange={(e) => setNewRelationName(e.target.value)}
                                    placeholder="Name..."
                                    className="h-7 text-xs flex-1"
                                    autoFocus
                                />
                                <Input
                                    type="number"
                                    value={newRelationValue}
                                    onChange={(e) =>
                                        setNewRelationValue(parseInt(e.target.value) || 0)
                                    }
                                    className="h-7 text-xs w-16"
                                    min={-100}
                                    max={100}
                                />
                                <Button size="icon" className="h-7 w-7" onClick={handleAddRelation}>
                                    <Check className="w-3 h-3" />
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    onClick={() => {
                                        setIsAddingRelation(false);
                                        setNewRelationName('');
                                    }}
                                >
                                    <X className="w-3 h-3" />
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="p-3 space-y-2 bg-background/30 min-h-[60px]">
                    <div className="flex items-center gap-2 text-xs text-foreground/70">
                        <MapPin className="w-3 h-3 shrink-0" />
                        <span className="truncate">{location || 'Unknown'}</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5 text-xs text-foreground">
                            <Package className="w-3 h-3 text-muted-foreground" />
                            <span className="font-medium">{inventory.length}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-foreground">
                            <Heart className="w-3 h-3 text-muted-foreground" />
                            <span className="font-medium">{relationshipEntries.length}</span>
                        </div>
                    </div>
                </div>
            )}
        </motion.div >
    );
}
