'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, GitBranch, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores';
import type { Message } from '@/types';
import { cn } from '@/lib/utils';

interface TreeVisualizationProps {
    isOpen: boolean;
    onClose: () => void;
}

// Visual Constants
const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;
const X_SPACING = 240; // Horizontal space between siblings
const Y_SPACING = 140; // Vertical space between generations

interface TreeNode {
    id: string;
    message: Message;
    children: TreeNode[];
    x: number;
    y: number;
    width: number; // Subtree width
}

export function TreeVisualization({ isOpen, onClose }: TreeVisualizationProps) {
    const { conversations, activeConversationId, messages: allMessages, navigateToMessage } = useChatStore();
    const activeConversation = conversations.find(c => c.id === activeConversationId);

    // Viewport State
    const [view, setView] = useState({ x: 0, y: 50, scale: 1 });
    const [isDragging, setIsDragging] = useState(false);
    const dragStart = useRef({ x: 0, y: 0 });
    const svgRef = useRef<SVGSVGElement>(null);

    // Build and Layout Tree
    const treeData = useMemo(() => {
        // Correctly filter messages from the flat store array
        const messages = allMessages.filter(m => m.conversationId === activeConversationId);

        console.log("[TreeVis] Recalculating. Open:", isOpen, "Messages:", messages.length);

        if (!isOpen || messages.length === 0) return null;

        const msgMap = new Map<string, TreeNode>();
        const roots: TreeNode[] = [];

        // 1. Create Nodes
        messages.forEach(msg => {
            msgMap.set(msg.id, {
                id: msg.id,
                message: msg,
                children: [],
                x: 0,
                y: 0,
                width: 0
            });
        });

        // 2. Build Hierarchy
        messages.forEach(msg => {
            const node = msgMap.get(msg.id)!;
            if (msg.parentId && msgMap.has(msg.parentId)) {
                msgMap.get(msg.parentId)!.children.push(node);
            } else {
                roots.push(node);
            }
        });

        if (roots.length === 0) return null;

        // 3. Promote children of 'system' roots to be visual roots (hide system prompt)
        // AND include non-system roots directly.
        let visualRoots: TreeNode[] = [];
        roots.forEach(root => {
            if (root.message.role === 'system') {
                if (root.children.length > 0) {
                    visualRoots.push(...root.children);
                } else {
                    // If system node has no children, maybe show it anyway or skip
                    // Let's hide it if it's empty to keep the tree clean
                }
            } else {
                visualRoots.push(root);
            }
        });

        // Fallback: If everything was system nodes and we have nothing, show original roots
        if (visualRoots.length === 0) {
            visualRoots = roots;
        }

        // 4. Layout Algorithm (Recursive Leaf-Based)
        let currentX = 0;

        const layoutNode = (node: TreeNode, depth: number) => {
            if (node.children.length === 0) {
                node.x = currentX;
                currentX += X_SPACING;
            } else {
                node.children.forEach(child => layoutNode(child, depth + 1));
                const firstChild = node.children[0];
                const lastChild = node.children[node.children.length - 1];
                node.x = (firstChild.x + lastChild.x) / 2;
            }
            node.y = depth * Y_SPACING;
        };

        visualRoots.forEach(root => layoutNode(root, 0));

        // Flatten for rendering
        const finalNodes: TreeNode[] = [];
        const finalEdges: { source: TreeNode; target: TreeNode; active: boolean }[] = [];

        // Find active path (lineage of current activeNodeId)
        // Note: TreeVis might show inactive branches too, but we highlight the active one.
        const activePath = new Set<string>();
        // Find the "active" leaf (most recent message in active branch)
        const activeBranchNodes = messages.filter(m => m.isActiveBranch).map(m => m.id);
        activeBranchNodes.forEach(id => activePath.add(id));

        const traverse = (node: TreeNode) => {
            finalNodes.push(node);
            node.children.forEach(child => {
                finalEdges.push({
                    source: node,
                    target: child,
                    active: activePath.has(child.id) && activePath.has(node.id)
                });
                traverse(child);
            });
        };

        visualRoots.forEach(traverse);

        return { nodes: finalNodes, edges: finalEdges, activePath };
    }, [activeConversationId, allMessages, isOpen]);

    // Pan/Zoom Handlers
    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const zoomSpeed = 0.001;
            const newScale = Math.max(0.1, Math.min(3, view.scale - e.deltaY * zoomSpeed));
            setView(v => ({ ...v, scale: newScale }));
        } else {
            setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
        }
    }, [view.scale]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if ((e.target as Element).tagName === 'svg' || (e.target as Element).tagName === 'g') {
            setIsDragging(true);
            dragStart.current = { x: e.clientX - view.x, y: e.clientY - view.y };
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (isDragging) {
            setView(v => ({
                ...v,
                x: e.clientX - dragStart.current.x,
                y: e.clientY - dragStart.current.y
            }));
        }
    };

    const handleMouseUp = () => setIsDragging(false);

    const hasData = treeData && treeData.nodes.length > 0;

    // Center on first node or active node on open
    useEffect(() => {
        if (isOpen && hasData && svgRef.current) {
            const containerWidth = svgRef.current.clientWidth;
            const containerHeight = svgRef.current.clientHeight;
            // Try to center active node, otherwise first node
            const targetNode = treeData!.nodes[0]; // Simple fallback
            setView({
                x: (containerWidth / 2) - (targetNode.x),
                y: 50,
                scale: 1,
            });
        }
    }, [isOpen, hasData]);


    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col"
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b bg-card/50 z-10 px-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-primary/10 rounded-lg">
                            <GitBranch className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                            <h2 className="font-bold text-lg leading-tight">Conversation Tree</h2>
                            <p className="text-xs text-muted-foreground">Flow chart of all dialogue branches</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="icon" onClick={() => setView(v => ({ ...v, scale: v.scale + 0.1 }))}>
                            <ZoomIn className="h-4 w-4" />
                        </Button>
                        <Button variant="outline" size="icon" onClick={() => setView(v => ({ ...v, scale: Math.max(0.1, v.scale - 0.1) }))}>
                            <ZoomOut className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setView({ x: 0, y: 50, scale: 1 })}>
                            <Maximize className="h-4 w-4" />
                        </Button>
                        <div className="w-px h-6 bg-border mx-2" />
                        <Button variant="ghost" size="icon" onClick={onClose} className="hover:bg-destructive/10 hover:text-destructive">
                            <X className="h-5 w-5" />
                        </Button>
                    </div>
                </div>

                {/* Canvas */}
                <div className="flex-1 w-full h-full relative overflow-hidden bg-dot-pattern cursor-move select-none"
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onWheel={handleWheel}
                >
                    {!hasData ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground opacity-50 select-none pointer-events-none">
                            <GitBranch className="h-16 w-16 mb-4 stroke-[1.5]" />
                            <p className="font-medium text-lg">No visible messages in this tree</p>
                            <p className="text-sm">Technical system messages are hidden by default.</p>
                        </div>
                    ) : (
                        <svg ref={svgRef} className="w-full h-full block">
                            <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
                                {/* Edges */}
                                {treeData?.edges.map((edge, i) => {
                                    const startHeading = edge.active ? 'stroke-primary' : 'stroke-border';
                                    const strokeWidth = edge.active ? 3 : 2;

                                    const start = { x: edge.source.x + NODE_WIDTH / 2, y: edge.source.y + NODE_HEIGHT };
                                    const end = { x: edge.target.x + NODE_WIDTH / 2, y: edge.target.y };
                                    const cp1 = { x: start.x, y: start.y + Y_SPACING / 2 };
                                    const cp2 = { x: end.x, y: end.y - Y_SPACING / 2 };

                                    return (
                                        <path
                                            key={`edge-${i}`}
                                            d={`M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`}
                                            fill="none"
                                            className={cn("transition-colors duration-300 ease-in-out", startHeading)}
                                            strokeWidth={strokeWidth}
                                            opacity={edge.active ? 1 : 0.4}
                                        />
                                    );
                                })}

                                {/* Nodes */}
                                {treeData?.nodes.map((node) => {
                                    const isUser = node.message.role === 'user';
                                    const isActivePath = treeData.activePath.has(node.id);

                                    return (
                                        <foreignObject
                                            key={node.id}
                                            x={node.x}
                                            y={node.y}
                                            width={NODE_WIDTH}
                                            height={NODE_HEIGHT}
                                            className="overflow-visible"
                                        >
                                            <div
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    navigateToMessage(node.id);
                                                }}
                                                className={cn(
                                                    "w-full h-full rounded-xl border-2 p-3 flex flex-col justify-between transition-all duration-200 cursor-pointer shadow-sm hover:scale-105 hover:shadow-md bg-card",
                                                    isActivePath
                                                        ? "border-primary ring-1 ring-primary/20 shadow-primary/10"
                                                        : "border-border opacity-70 hover:opacity-100 hover:border-primary/30"
                                                )}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <span className={cn(
                                                        "text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-sm",
                                                        isUser ? "bg-blue-500/10 text-blue-500" : "bg-green-500/10 text-green-500"
                                                    )}>
                                                        {node.message.role}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-card-foreground line-clamp-2 font-medium leading-relaxed">
                                                    {node.message.content || '...'}
                                                </p>
                                            </div>
                                        </foreignObject>
                                    );
                                })}
                            </g>
                        </svg>
                    )}
                </div>
            </motion.div>
        </AnimatePresence>
    );
}
