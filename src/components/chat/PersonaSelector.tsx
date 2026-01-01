import { useState } from 'react';
import { useSettingsStore, Persona } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ChevronUp, Plus, UserCircle, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

export function PersonaSelector() {
    const { personas, activePersonaId, setActivePersonaId } = useSettingsStore();
    const [open, setOpen] = useState(false);

    const activePersona = personas.find((p) => p.id === activePersonaId);

    // Fallback/Default persona display
    const displayName = activePersona?.name || 'Vous';
    const displayAvatar = activePersona?.avatar;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <div className="flex flex-col gap-1 mb-2">
                <span className="text-[10px] font-medium text-muted-foreground ml-1 uppercase tracking-wider">Identité active</span>
                <PopoverTrigger asChild>
                    <Button variant="outline" className="h-12 w-full justify-start gap-3 px-3 bg-card hover:bg-accent/50 border-input rounded-xl shadow-sm transition-all">
                        <Avatar className="h-8 w-8 border border-border/50">
                            <AvatarImage src={displayAvatar} className="object-cover" />
                            <AvatarFallback className="text-xs bg-primary/10 text-primary">
                                {displayName[0].toUpperCase()}
                            </AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col items-start text-left flex-1 min-w-0">
                            <span className="text-sm font-semibold truncate w-full">
                                {displayName}
                            </span>
                            <span className="text-[10px] text-muted-foreground truncate w-full">
                                {activePersona?.bio ? activePersona.bio.substring(0, 40) + '...' : 'Par défaut'}
                            </span>
                        </div>
                        <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0 opacity-50" />
                    </Button>
                </PopoverTrigger>
            </div>
            <PopoverContent className="w-[300px] p-2" align="start" side="top" sideOffset={8}>
                <div className="space-y-1">
                    <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase">
                        Choisir une identité
                    </div>
                    {personas.map((persona) => (
                        <div
                            key={persona.id}
                            className={cn(
                                "flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-muted transition-colors",
                                activePersonaId === persona.id && "bg-muted"
                            )}
                            onClick={() => {
                                setActivePersonaId(persona.id);
                                setOpen(false);
                            }}
                        >
                            <Avatar className="h-6 w-6">
                                <AvatarImage src={persona.avatar} />
                                <AvatarFallback className="text-[10px]">
                                    {persona.name[0].toUpperCase()}
                                </AvatarFallback>
                            </Avatar>
                            <div className="flex flex-col overflow-hidden">
                                <span className="text-sm font-medium truncate">{persona.name}</span>
                            </div>
                        </div>
                    ))}

                    {personas.length === 0 && (
                        <div className="px-2 py-2 text-sm text-muted-foreground italic">
                            Aucune identité créée
                        </div>
                    )}

                    <div className="h-px bg-border my-1" />

                    {/* Since we don't have direct navigation to settings tab from here easy, 
                        we rely on user going to main settings. 
                        Or we could add a simple "New Persona" placeholder that tells them to go to settings.
                    */}
                    <div className="px-2 py-1 text-xs text-muted-foreground">
                        Gérez vos personas dans les réglages
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}
