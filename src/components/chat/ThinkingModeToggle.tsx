'use client';

import { Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings-store';
import { ActionTooltip } from '@/components/ui/action-tooltip';

export function ThinkingModeToggle() {
    const { enableReasoning, setEnableReasoning } = useSettingsStore();

    return (
        <ActionTooltip label={enableReasoning ? 'Thinking Mode: ON' : 'Thinking Mode: OFF'}>
            <Button
                variant="ghost"
                size="sm"
                className={`h-8 w-8 p-0 ${enableReasoning ? 'text-primary' : 'text-muted-foreground'}`}
                onClick={() => setEnableReasoning(!enableReasoning)}
            >
                <Brain className={`h-4 w-4 ${enableReasoning ? 'animate-pulse' : ''}`} />
            </Button>
        </ActionTooltip>
    );
}
