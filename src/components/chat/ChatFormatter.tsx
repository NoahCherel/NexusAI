import React from 'react';

interface ChatFormatterProps {
    content: string;
}

export function ChatFormatter({ content }: ChatFormatterProps) {
    if (!content) return null;

    // Split by newlines to handle line-based formatting (like "Name:") properly
    const lines = content.split('\n');

    return (
        <div className="space-y-1">
            {lines.map((line, i) => (
                <div key={i} className="min-h-[1.2em]">
                    <FormattedLine text={line} />
                </div>
            ))}
        </div>
    );
}

function FormattedLine({ text }: { text: string }) {
    if (!text.trim()) return <br />;

    // Regex to match:
    // 1. **bold**
    // 2. *italic/action*
    // 3. Name: at start of line (approximated by checking start of string)

    // We need to tokenize the string.
    // Let's use a simpler approach: process bold, then italics.
    // Note: Nested formatting is complex with simple regex split, but for MVP:
    // We typically want *actions* to be distinct.

    // Check for "Name:" prefix at start
    let prefixNode: React.ReactNode = null;
    let remainingText = text;

    const nameMatch = text.match(/^([A-Za-z0-9 _'-]+):(\s+)/);
    if (nameMatch) {
        prefixNode = <strong className="font-bold text-foreground/90">{nameMatch[1]}:</strong>;
        remainingText = text.slice(nameMatch[0].length); // Keep the space? No, usually allow it to be separate or just appended-space.
        // Actually nameMatch[2] is the whitespace.
        // Let's render the whitespace in the following text or after prefix.
        prefixNode = <><strong className="font-bold text-foreground/90">{nameMatch[1]}:</strong>{nameMatch[2]}</>;
        remainingText = text.substring(nameMatch[0].length);
    }

    return (
        <span>
            {prefixNode}
            <FormattedContent text={remainingText} />
        </span>
    );
}

function FormattedContent({ text }: { text: string }) {
    // 1. Split for **bold**
    // 2. Split for *italic*

    // We can use a parser loop or nested splitting.
    // Let's use a combined regex.
    // (\*\*.*?\*\*)|(\*.*?\*)

    const parts = text.split(/(\*\*.*?\*\*|\*.*?\*)/g);

    return (
        <>
            {parts.map((part, index) => {
                if (part.startsWith('**') && part.endsWith('**')) {
                    return <strong key={index} className="font-bold">{part.slice(2, -2)}</strong>;
                }
                if (part.startsWith('*') && part.endsWith('*')) {
                    // Actions usually look better slightly grayed out or distinct color in RPG context
                    return <em key={index} className="italic text-muted-foreground/90">{part.slice(1, -1)}</em>;
                }
                return <span key={index}>{part}</span>;
            })}
        </>
    );
}
