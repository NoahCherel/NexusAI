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
            <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-between px-3 h-10 bg-card hover:bg-accent/50 border-input rounded-xl shadow-sm transition-all mb-2">
                    <div className="flex items-center gap-3 min-w-0">
                        <Avatar className="h-6 w-6 border border-border/50">
                            <AvatarImage src={displayAvatar} className="object-cover" />
                            <AvatarFallback className="text-[10px] bg-primary/10 text-primary">
                                {displayName[0].toUpperCase()}
                            </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium truncate">
                            {displayName}
                        </span>
                    </div>
                    <ChevronUp className="h-4 w-4 text-muted-foreground opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-2" align="start" side="top" sideOffset={8}>
                <div className="space-y-1">
                    <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase">
                        Select Persona
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
                            No personas found
                        </div>
                    )}

                    <div className="h-px bg-border my-1" />

                    {/* Since we don't have direct navigation to settings tab from here easy, 
                        we rely on user going to main settings. 
                        Or we could add a simple "New Persona" placeholder that tells them to go to settings.
                    */}
                    <div className="px-2 py-1 text-xs text-muted-foreground">
                        Manage personas in Settings
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}
