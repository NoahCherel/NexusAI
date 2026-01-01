'use client';

import { motion } from 'framer-motion';
import { Package, MapPin, Heart, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

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
    const relationshipEntries = Object.entries(relationships);

    return (
        <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="bg-card border border-border rounded-lg overflow-hidden"
        >
            {/* Header */}
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
            >
                <span className="font-semibold text-sm">🌍 World State</span>
                <ChevronUp
                    className={`w-4 h-4 transition-transform ${isCollapsed ? 'rotate-180' : ''
                        }`}
                />
            </button>

            {!isCollapsed && (
                <div className="p-3 pt-0 space-y-4">
                    <Separator />

                    {/* Location */}
                    <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <MapPin className="w-3 h-3" />
                            <span>Location</span>
                        </div>
                        <p className="text-sm font-medium">
                            {location || 'Unknown location'}
                        </p>
                    </div>

                    {/* Inventory */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Package className="w-3 h-3" />
                            <span>Inventory ({inventory.length})</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                            {inventory.length > 0 ? (
                                inventory.map((item, index) => (
                                    <Badge key={index} variant="secondary" className="text-xs">
                                        {item}
                                    </Badge>
                                ))
                            ) : (
                                <span className="text-xs text-muted-foreground italic">
                                    Empty inventory
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Relationships */}
                    {relationshipEntries.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Heart className="w-3 h-3" />
                                <span>Relationships</span>
                            </div>
                            <div className="space-y-2">
                                {relationshipEntries.map(([name, level]) => {
                                    // Scale -100..100 to 0..100 for width
                                    const percent = Math.max(0, Math.min(100, (level + 100) / 2));

                                    let color = 'bg-gray-500'; // Neutral
                                    if (level >= 30) color = 'bg-green-500';
                                    else if (level >= 10) color = 'bg-emerald-500';
                                    else if (level <= -30) color = 'bg-red-600';
                                    else if (level <= -10) color = 'bg-orange-500';

                                    return (
                                        <div key={name} className="space-y-1">
                                            <div className="flex items-center justify-between text-xs">
                                                <span>{name}</span>
                                                <span className={`${level < 0 ? 'text-red-400' : 'text-green-400'}`}>{level > 0 ? '+' : ''}{level}</span>
                                            </div>
                                            <div className="h-1.5 bg-muted rounded-full overflow-hidden relative">
                                                {/* Center marker */}
                                                <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-background/50 z-10" />
                                                <motion.div
                                                    initial={{ width: '50%' }}
                                                    animate={{ width: `${percent}%` }}
                                                    transition={{ duration: 0.5, ease: 'easeOut' }}
                                                    className={`h-full rounded-full ${color}`}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )
            }
        </motion.div >
    );
}
