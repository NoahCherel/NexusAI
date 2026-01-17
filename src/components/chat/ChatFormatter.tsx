import React, { memo, useCallback } from 'react';

interface ChatFormatterProps {
    content: string;
}

export const ChatFormatter = memo(function ChatFormatter({ content }: ChatFormatterProps) {
    if (!content) return null;

    // 1. Handle Code Blocks first (they are distinct blocks)
    // We split by ``` to separate code/text
    const parts = content.split(/(```[\s\S]*?```)/g);

    return (
        <div className="text-[15px] leading-relaxed break-words space-y-2">
            {parts.map((part, index) => {
                if (part.startsWith('```') && part.endsWith('```')) {
                    // It's a code block
                    const content = part.slice(3, -3).replace(/^\w+\n/, ''); // remove lang tag if present
                    const langMatch = part.match(/^```(\w+)/);
                    const lang = langMatch ? langMatch[1] : '';

                    return (
                        <div key={index} className="rounded-md overflow-hidden my-2 border border-border/50 bg-muted/50">
                            {lang && (
                                <div className="px-3 py-1.5 border-b border-border/50 text-xs text-muted-foreground bg-muted/80">
                                    {lang}
                                </div>
                            )}
                            <div className="p-3 overflow-x-auto text-sm font-mono bg-[#1e1e1e] text-gray-200">
                                <pre>{content}</pre>
                            </div>
                        </div>
                    );
                }

                // It's regular text, process lines
                return part.split('\n').map((line, lineIdx) => (
                    <FormattedLine key={`${index}-${lineIdx}`} text={line} />
                ));
            })}
        </div>
    );
});

const FormattedLine = memo(({ text }: { text: string }) => {
    if (!text.trim()) return <div className="h-2" />; // Empty line spacing

    // Check for "Name:" prefix
    let prefixNode: React.ReactNode = null;
    let actualText = text;

    // Default styling
    let className = "block mb-1";

    // Check for "Name:" pattern at start
    const nameMatch = text.match(/^([A-Za-z0-9 _'-]+):(\s+)/);
    if (nameMatch) {
        // Create the bold name prefix
        prefixNode = (
            <span className="font-bold text-foreground/90 tabular-nums">
                {nameMatch[1]}:
            </span>
        );
        // Keep the whitespace but don't bold it, or just just rely on the span spacing
        actualText = text.slice(nameMatch[0].length);

        // Add the whitespace back to the rendering, usually just a space
        // We can put it after the prefix
    }

    return (
        <div className={className}>
            {prefixNode}
            {nameMatch ? ' ' : ''}
            <FormattedText text={actualText} />
        </div>
    );
});

const FormattedText = memo(({ text }: { text: string }) => {
    // Parser for inline styles: **bold** and *italics*
    // We scan the string and build nodes

    const nodes: React.ReactNode[] = [];
    let currentText = "";
    let i = 0;

    // Use a separate counter for keys to avoid collisions
    // (e.g. flushText uses i, then bold block uses i)
    let keyIndex = 0;

    const flushText = () => {
        if (currentText) {
            nodes.push(<span key={keyIndex++}>{currentText}</span>);
            currentText = "";
        }
    };

    while (i < text.length) {
        // Check for Bold (**...)
        if (text.startsWith('**', i)) {
            const endIdx = text.indexOf('**', i + 2);
            if (endIdx !== -1) {
                flushText();
                const boldContent = text.slice(i + 2, endIdx);
                nodes.push(<strong key={keyIndex++} className="font-semibold text-foreground">{boldContent}</strong>);
                i = endIdx + 2;
                continue;
            }
        }

        // Check for Italics (*...) - Note: also handles actions in RP
        if (text[i] === '*') {
            const endIdx = text.indexOf('*', i + 1);
            if (endIdx !== -1) {
                flushText();
                const italicContent = text.slice(i + 1, endIdx);
                // Standard visual style for RP actions: italic + slightly muted color
                nodes.push(<em key={keyIndex++} className="italic text-muted-foreground">{italicContent}</em>);
                i = endIdx + 1;
                continue;
            }
        }

        // Check for Italics (_...)
        if (text[i] === '_') {
            const endIdx = text.indexOf('_', i + 1);
            if (endIdx !== -1) {
                flushText();
                const italicContent = text.slice(i + 1, endIdx);
                nodes.push(<em key={keyIndex++} className="italic text-muted-foreground">{italicContent}</em>);
                i = endIdx + 1;
                continue;
            }
        }

        currentText += text[i];
        i++;
    }

    flushText();

    return <>{nodes}</>;
});
