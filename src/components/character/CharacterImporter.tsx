'use client';

import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, FileImage, AlertCircle, CheckCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { importCharacterCard } from '@/lib/character-parser';
import { useCharacterStore } from '@/stores';
import type { CharacterCard } from '@/types';
import { cn } from '@/lib/utils';

interface CharacterImporterProps {
    trigger?: React.ReactNode;
    onImported?: (character: CharacterCard) => void;
    isCollapsed?: boolean;
}

export function CharacterImporter({ trigger, onImported, isCollapsed }: CharacterImporterProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [importedChar, setImportedChar] = useState<CharacterCard | null>(null);

    const addCharacter = useCharacterStore((state) => state.addCharacter);

    const onDrop = useCallback(
        async (acceptedFiles: File[]) => {
            const file = acceptedFiles[0];
            if (!file) return;

            setStatus('loading');
            setError(null);

            try {
                const character = await importCharacterCard(file);
                setImportedChar(character);
                addCharacter(character);
                setStatus('success');
                onImported?.(character);

                // Auto-close after success
                setTimeout(() => {
                    setIsOpen(false);
                    setStatus('idle');
                    setImportedChar(null);
                }, 2000);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Erreur lors de l'import");
                setStatus('error');
            }
        },
        [addCharacter, onImported]
    );

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept: {
            'image/png': ['.png'],
            'application/json': ['.json'],
        },
        maxFiles: 1,
        disabled: status === 'loading',
    });

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                {trigger ||
                    (isCollapsed ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 text-primary bg-primary/10 hover:bg-primary/20"
                        >
                            <Plus className="w-5 h-5" />
                        </Button>
                    ) : (
                        <Button
                            variant="outline"
                            className="w-full gap-2 border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 h-10"
                        >
                            <Upload className="h-4 w-4" />
                            <span className="text-sm font-medium">Import Character</span>
                        </Button>
                    ))}
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Import Character</DialogTitle>
                    <DialogDescription>
                        Drag & drop a Character Card V2 (PNG or JSON) from Chub, JanitorAI, or
                        SillyTavern.
                    </DialogDescription>
                </DialogHeader>

                <div
                    {...getRootProps()}
                    className={cn(
                        'relative mt-4 p-8 border-2 border-dashed rounded-xl transition-all cursor-pointer',
                        isDragActive
                            ? 'border-primary bg-primary/5'
                            : 'border-muted-foreground/25 hover:border-primary/50',
                        status === 'loading' ? 'opacity-50 pointer-events-none' : ''
                    )}
                >
                    <input {...getInputProps()} />

                    <AnimatePresence mode="wait">
                        {status === 'idle' && (
                            <motion.div
                                key="idle"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex flex-col items-center gap-3 text-center"
                            >
                                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                                    <FileImage className="w-8 h-8 text-muted-foreground" />
                                </div>
                                <div>
                                    <p className="font-medium">
                                        {isDragActive ? 'Drop file here' : 'Drag file here'}
                                    </p>
                                    <p className="text-sm text-muted-foreground mt-1">
                                        or click to browse
                                    </p>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    PNG (Character Card V2) or JSON
                                </p>
                            </motion.div>
                        )}

                        {status === 'loading' && (
                            <motion.div
                                key="loading"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex flex-col items-center gap-3"
                            >
                                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                                    <motion.div
                                        animate={{ rotate: 360 }}
                                        transition={{
                                            duration: 1,
                                            repeat: Infinity,
                                            ease: 'linear',
                                        }}
                                    >
                                        <Upload className="w-8 h-8 text-muted-foreground" />
                                    </motion.div>
                                </div>
                                <p className="font-medium">Importing...</p>
                            </motion.div>
                        )}

                        {status === 'success' && importedChar && (
                            <motion.div
                                key="success"
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex flex-col items-center gap-3"
                            >
                                <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
                                    <CheckCircle className="w-8 h-8 text-green-500" />
                                </div>
                                <div className="text-center">
                                    <p className="font-medium">{importedChar.name}</p>
                                    <p className="text-sm text-muted-foreground">
                                        Imported successfully!
                                    </p>
                                </div>
                            </motion.div>
                        )}

                        {status === 'error' && (
                            <motion.div
                                key="error"
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex flex-col items-center gap-3"
                            >
                                <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
                                    <AlertCircle className="w-8 h-8 text-destructive" />
                                </div>
                                <div className="text-center">
                                    <p className="font-medium text-destructive">Error</p>
                                    <p className="text-sm text-muted-foreground">{error}</p>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setStatus('idle');
                                        setError(null);
                                    }}
                                >
                                    Retry
                                </Button>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </DialogContent>
        </Dialog>
    );
}
