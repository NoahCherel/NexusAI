'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface SliderProps {
    value?: number[];
    defaultValue?: number[];
    min?: number;
    max?: number;
    step?: number;
    onValueChange?: (value: number[]) => void;
    className?: string;
    disabled?: boolean;
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
    (
        {
            value,
            defaultValue,
            min = 0,
            max = 100,
            step = 1,
            onValueChange,
            className,
            disabled,
        },
        ref
    ) => {
        const currentValue = value?.[0] ?? defaultValue?.[0] ?? min;

        const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
            const newValue = parseFloat(e.target.value);
            onValueChange?.([newValue]);
        };

        // Calculate percentage for gradient styling
        const percentage = ((currentValue - min) / (max - min)) * 100;

        return (
            <input
                ref={ref}
                type="range"
                min={min}
                max={max}
                step={step}
                value={currentValue}
                onChange={handleChange}
                disabled={disabled}
                className={cn(
                    'w-full h-2 rounded-full appearance-none cursor-pointer',
                    'bg-muted [&::-webkit-slider-thumb]:appearance-none',
                    '[&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4',
                    '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary',
                    '[&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer',
                    '[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110',
                    '[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4',
                    '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-primary',
                    '[&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:cursor-pointer',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    className
                )}
                style={{
                    background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${percentage}%, hsl(var(--muted)) ${percentage}%, hsl(var(--muted)) 100%)`,
                }}
            />
        );
    }
);

Slider.displayName = 'Slider';

export { Slider };
