'use client';
import { useSettingsStore } from '@/stores';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { BUILTIN_ENGINES } from '@/lib/ai/rp-engine';

/** The same controls are used by Settings and the chat's IA shortcut. */
export function ResponseControls() {
    const state = useSettingsStore();
    return (
        <div className="space-y-4 min-w-0">
            <div>
                <p className="text-sm text-muted-foreground mb-1">Modèle actif</p>
                <ModelSelector />
            </div>
            <label className="block space-y-1">
                <span>Preset</span>
                <select
                    className="w-full rounded-md border bg-background p-3"
                    value={state.activePresetId || ''}
                    onChange={(e) => state.setActivePreset(e.target.value)}
                >
                    {!state.activePresetId && <option value="">Aucun preset</option>}
                    {state.presets.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </label>
            <label className="block space-y-1">
                <span>Moteur RP</span>
                <select
                    className="w-full rounded-md border bg-background p-3"
                    value={state.activeEngineId || ''}
                    onChange={(e) => state.setActiveEngineId(e.target.value || null)}
                >
                    <option value="">Désactivé</option>
                    {[...BUILTIN_ENGINES, ...state.customEngines].map((e) => (
                        <option key={e.id} value={e.id}>
                            {e.name}
                        </option>
                    ))}
                </select>
            </label>
        </div>
    );
}
