'use client';

import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, FileImage, AlertCircle, CheckCircle, Plus, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { detectImportUrl } from '@/lib/import/url-detector';
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
    const [importUrl, setImportUrl] = useState('');

    const addCharacter = useCharacterStore((state) => state.addCharacter);

    const finishImport = useCallback(
        (character: CharacterCard) => {
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
        },
        [addCharacter, onImported]
    );

    // Import by URL — the local Next server proxies the platform APIs (no CORS, no
    // datacenter IP). JannyAI's API sits behind a Cloudflare challenge that blocks
    // non-browser TLS fingerprints, so when the server gets challenged we retry the API
    // call from THIS browser (real Chrome fingerprint) and only proxy the final PNG.
    const handleUrlImport = useCallback(async () => {
        const url = importUrl.trim();
        if (!url) return;
        const detected = detectImportUrl(url);
        if (!detected) {
            setError(
                'URL non reconnue. Plateformes supportées : JannyAI, Chub.ai / CharacterHub, Pygmalion, RisuAI Realm, AICharacterCards.'
            );
            setStatus('error');
            return;
        }

        setStatus('loading');
        setError(null);
        try {
            let res = await fetch('/api/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            });
            let data = await res.json();

            // Cloudflare fallback (JannyAI): resolve the download URL from the browser
            // itself, then let the server fetch the PNG (CORS-free parse + avatar).
            if (!res.ok && data.kind === 'cloudflare' && detected.platform === 'jannyai') {
                const api = await fetch('https://api.jannyai.com/api/v1/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ characterId: detected.id }),
                });
                const apiData = await api.json();
                if (api.ok && apiData.status === 'ok' && apiData.downloadUrl) {
                    res = await fetch('/api/import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pngUrl: apiData.downloadUrl }),
                    });
                    data = await res.json();
                }
            }

            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

            const character: CharacterCard = {
                ...data.card,
                id: crypto.randomUUID(),
                avatar: data.avatarDataUrl || data.card.avatar || '',
            };
            setImportUrl('');
            finishImport(character);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Erreur lors de l'import");
            setStatus('error');
        }
    }, [importUrl, finishImport]);

    const onDrop = useCallback(
        async (acceptedFiles: File[]) => {
            const file = acceptedFiles[0];
            if (!file) return;

            setStatus('loading');
            setError(null);

            try {
                const character = await importCharacterCard(file);
                finishImport(character);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Erreur lors de l'import");
                setStatus('error');
            }
        },
        [finishImport]
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
                        Collez une URL de carte, ou glissez un fichier Character Card (PNG/JSON).
                    </DialogDescription>
                </DialogHeader>

                {/* Import by URL */}
                <div className="mt-2 space-y-1.5">
                    <div className="flex gap-2">
                        <Input
                            value={importUrl}
                            onChange={(e) => setImportUrl(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void handleUrlImport();
                                }
                            }}
                            placeholder="https://jannyai.com/characters/… ou chub.ai/characters/…"
                            disabled={status === 'loading'}
                            className="h-9"
                        />
                        <Button
                            onClick={() => void handleUrlImport()}
                            disabled={!importUrl.trim() || status === 'loading'}
                            className="h-9 gap-1.5 shrink-0"
                        >
                            <Link2 className="h-4 w-4" />
                            Importer
                        </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        JannyAI (miroir JanitorAI) · Chub.ai / CharacterHub · Pygmalion · RisuAI ·
                        AICharacterCards — ou glissez un fichier ci-dessous.
                    </p>
                </div>

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
