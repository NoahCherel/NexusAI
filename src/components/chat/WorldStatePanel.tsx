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

            {!isCollapsed && (
                <div className="p-4 space-y-5">
                    {/* Location */}
                    <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                            <MapPin className="w-3 h-3" />
                            <span>Location</span>
                        </div>
                        <div className="text-sm font-medium leading-relaxed bg-background/50 p-2 rounded-md border border-border/50">
                            {location || 'Unknown location'}
                        </div>
                    </div>

                    {/* Inventory */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                            <Package className="w-3 h-3" />
                            <span>Inventory</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {inventory.length > 0 ? (
                                inventory.map((item, index) => (
                                    <Badge key={index} variant="secondary" className="text-[10px] px-2 py-0.5 bg-secondary/50 hover:bg-secondary border-border/50">
                                        {item}
                                    </Badge>
                                ))
                            ) : (
                                <span className="text-xs text-muted-foreground italic px-1">
                                    Empty inventory
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Relationships */}
                    {relationshipEntries.length > 0 && (
                        <div className="space-y-2.5">
                            <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                                <Heart className="w-3 h-3" />
                                <span>Relationships</span>
                            </div>
                            <div className="space-y-3">
                                {relationshipEntries.map(([name, level]) => {
                                    // Scale -100..100 to 0..100 for width
                                    const percent = Math.max(0, Math.min(100, (level + 100) / 2));

                                    let color = 'bg-gray-500'; // Neutral
                                    if (level >= 30) color = 'bg-green-500';
                                    else if (level >= 10) color = 'bg-emerald-500';
                                    else if (level <= -30) color = 'bg-red-600';
                                    else if (level <= -10) color = 'bg-orange-500';

                                    return (
                                        <div key={name} className="space-y-1.5">
                                            <div className="flex items-center justify-between text-xs font-medium">
                                                <span>{name}</span>
                                                <span className={`${level < 0 ? 'text-red-400' : 'text-green-500'} font-bold`}>
                                                    {level > 0 ? '+' : ''}{level}
                                                </span>
                                            </div>
                                            <div className="h-2 bg-muted/60 rounded-full overflow-hidden relative shadow-inner">
                                                {/* Center marker */}
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
                            </div>
                        </div>
                    )}
                </div>
            )}
        </motion.div>
    );
}
