import React, { memo, useCallback } from 'react';

interface ChatFormatterProps {
    content: string;
    isUser?: boolean;
}

export const ChatFormatter = memo(function ChatFormatter({ content, isUser }: ChatFormatterProps) {
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
                        <div
                            key={index}
                            className="rounded-md overflow-hidden my-2 border border-border/50 bg-muted/50"
                        >
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
                return part
                    .split('\n')
                    .map((line, lineIdx) => (
                        <FormattedLine key={`${index}-${lineIdx}`} text={line} isUser={isUser} />
                    ));
            })}
        </div>
    );
});

const FormattedLine = memo(function FormattedLine({
    text,
    isUser,
}: {
    text: string;
    isUser?: boolean;
}) {
    if (!text.trim()) return <div className="h-2" />; // Empty line spacing

    // Check for "Name:" prefix
    let prefixNode: React.ReactNode = null;
    let actualText = text;

    const className = 'block mb-1';

    // Check for "Name:" pattern at start
    const nameMatch = text.match(/^([A-Za-z0-9 _'-]+):(\s+)/);
    if (nameMatch) {
        // Create the bold name prefix
        prefixNode = (
            <span className="font-bold text-foreground/90 tabular-nums">{nameMatch[1]}:</span>
        );
        // Keep the whitespace but don't bold it, or just just rely on the span spacing
        actualText = text.slice(nameMatch[0].length);
    }

    return (
        <div className={className}>
            {prefixNode}
            {nameMatch ? ' ' : ''}
            <FormattedText text={actualText} isUser={isUser} />
        </div>
    );
});

const FormattedText = memo(function FormattedText({
    text,
    isUser,
}: {
    text: string;
    isUser?: boolean;
}) {
    // Parser for inline styles: **bold** and *italics*
    // We scan the string and build nodes

    const nodes: React.ReactNode[] = [];
    let i = 0;
    let keyIndex = 0;

    // Strict Mode: If it's a User, render strictly without implicit narration.
    if (isUser) {
        let currentText = '';
        const flushUserText = () => {
            if (currentText) {
                nodes.push(
                    <span key={keyIndex++} className="text-foreground">
                        {currentText}
                    </span>
                );
                currentText = '';
            }
        };

        while (i < text.length) {
            // Bold (**...**)
            if (text.startsWith('**', i)) {
                const endIdx = text.indexOf('**', i + 2);
                if (endIdx !== -1) {
                    flushUserText();
                    nodes.push(
                        <strong key={keyIndex++} className="font-bold text-foreground">
                            {text.slice(i + 2, endIdx)}
                        </strong>
                    );
                    i = endIdx + 2;
                    continue;
                }
            }
            // Italic (*...* or _..._)
            if ((text[i] === '*' || text[i] === '_') && text.indexOf(text[i], i + 1) !== -1) {
                const char = text[i];
                const startIdx = i;
                // Find closing char
                const endIdx = text.indexOf(char, i + 1);
                // Ensure valid slice
                if (endIdx !== -1) {
                    flushUserText();
                    nodes.push(
                        <em key={keyIndex++} className="italic opacity-80">
                            {text.slice(startIdx + 1, endIdx)}
                        </em>
                    );
                    i = endIdx + 1;
                    continue;
                }
            }

            currentText += text[i];
            i++;
        }
        flushUserText();
        return <>{nodes}</>;
    }

    // AI Logic: Implicit Narration + Markdown
    const parts = text.split(/(".*?")/g);

    parts.forEach((part, idx) => {
        if (idx % 2 === 1) {
            // Quoted Text -> Dialogue
            nodes.push(
                <span key={`quote-${keyIndex++}`} className="text-foreground">
                    {part}
                </span>
            );
        } else {
            // Unquoted -> Narration
            if (!part) return;
            nodes.push(
                <span key={`narr-${keyIndex++}`} className="font-medium text-foreground/80 italic">
                    {part}
                </span>
            );
        }
    });

    return <>{nodes}</>;
});
