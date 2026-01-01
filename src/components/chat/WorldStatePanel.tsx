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
                <span className="font-semibold text-sm">🌍 État du Monde</span>
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
                            <span>Lieu</span>
                        </div>
                        <p className="text-sm font-medium">
                            {location || 'Lieu inconnu'}
                        </p>
                    </div>

                    {/* Inventory */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Package className="w-3 h-3" />
                            <span>Inventaire ({inventory.length})</span>
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
                                    Inventaire vide
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Relationships */}
                    {relationshipEntries.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Heart className="w-3 h-3" />
                                <span>Relations</span>
                            </div>
                            <div className="space-y-2">
                                {relationshipEntries.map(([name, level]) => (
                                    <div key={name} className="space-y-1">
                                        <div className="flex items-center justify-between text-xs">
                                            <span>{name}</span>
                                            <span className="text-muted-foreground">{level}%</span>
                                        </div>
                                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                            <motion.div
                                                initial={{ width: 0 }}
                                                animate={{ width: `${level}%` }}
                                                transition={{ duration: 0.5, ease: 'easeOut' }}
                                                className={`h-full rounded-full ${level < 30
                                                        ? 'bg-red-500'
                                                        : level < 60
                                                            ? 'bg-yellow-500'
                                                            : 'bg-green-500'
                                                    }`}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </motion.div>
    );
}
