'use client';

import * as React from 'react';
import type { PopoverProps } from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// Context to share state
interface SelectContextValue {
    value: string;
    onValueChange: (value: string) => void;
    open: boolean;
    setOpen: (open: boolean) => void;
    placeholder?: string;
    labelMap: Map<string, React.ReactNode>;
}

const SelectContext = React.createContext<SelectContextValue | undefined>(undefined);

function useSelect() {
    const context = React.useContext(SelectContext);
    if (!context) {
        throw new Error('Select primitives must be used within a Select provider');
    }
    return context;
}

interface SelectProps {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
    defaultValue?: string;
}

const Select = ({ value, onValueChange, children }: SelectProps) => {
    const [open, setOpen] = React.useState(false);
    // We need a map to store labels for values to display in the trigger
    const labelMap = React.useRef(new Map<string, React.ReactNode>()).current;

    return (
        <SelectContext.Provider value={{ value, onValueChange, open, setOpen, labelMap }}>
            <Popover open={open} onOpenChange={setOpen}>
                {children}
            </Popover>
        </SelectContext.Provider>
    );
};

const SelectTrigger = React.forwardRef<
    React.ElementRef<typeof Button>,
    React.ComponentPropsWithoutRef<typeof Button>
>(({ className, children, ...props }, ref) => {
    // We use a Button as the trigger essentially
    return (
        <PopoverTrigger asChild>
            <Button
                ref={ref}
                variant="outline"
                role="combobox"
                className={cn('w-full justify-between', className)}
                {...props}
            >
                {children}
                <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
        </PopoverTrigger>
    );
});
SelectTrigger.displayName = 'SelectTrigger';

const SelectValue = React.forwardRef<
    HTMLSpanElement,
    React.HTMLAttributes<HTMLSpanElement> & { placeholder?: string }
>(({ className, placeholder, ...props }, ref) => {
    const { value, labelMap } = useSelect();
    const displayValue = labelMap.get(value) || placeholder || value;

    return (
        <span ref={ref} className={cn('block truncate', className)} {...props}>
            {displayValue}
        </span>
    );
});
SelectValue.displayName = 'SelectValue';

const SelectContent = React.forwardRef<
    React.ElementRef<typeof PopoverContent>,
    React.ComponentPropsWithoutRef<typeof PopoverContent>
>(({ className, children, ...props }, ref) => {
    return (
        <PopoverContent ref={ref} className={cn('w-full p-1', className)} align="start" {...props}>
            <div className="max-h-[300px] overflow-y-auto overflow-x-hidden">{children}</div>
        </PopoverContent>
    );
});
SelectContent.displayName = 'SelectContent';

const SelectItem = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & { value: string }
>(({ className, children, value: itemValue, ...props }, ref) => {
    const { value, onValueChange, setOpen, labelMap } = useSelect();

    // Register label
    // This is a bit of a hack in React strict mode / fast refresh but works for basic cases
    if (children) {
        labelMap.set(itemValue, children);
    }

    const isSelected = value === itemValue;

    return (
        <div
            ref={ref}
            className={cn(
                'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 cursor-pointer',
                isSelected && 'bg-accent/50',
                className
            )}
            onClick={() => {
                onValueChange(itemValue);
                setOpen(false);
            }}
            {...props}
        >
            <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                {isSelected && <Check className="h-4 w-4" />}
            </span>
            {children}
        </div>
    );
});
SelectItem.displayName = 'SelectItem';

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
