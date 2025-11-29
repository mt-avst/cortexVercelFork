import React, { useEffect, useRef, useCallback } from 'react';

interface Node {
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  baseAngle: number; // Original angle in ring (for orbit)
  baseRadius: number; // Distance from center (for orbit)
  vx: number;
  vy: number;
  radius: number;
  baseNodeRadius: number; // Base size for pulsing
  pulsePhase: number; // Phase offset for size animation
  isOrange: boolean;
  angle: number; // Current position in the ring (radians)
  // NEW: Organic flow properties
  orbitSpeedMultiplier: number; // Individual speed variance (0.5-1.5x)
  opacity: number; // Current opacity for sparkle effect
  opacityPhase: number; // Phase for opacity animation
  opacitySpeed: number; // Individual opacity animation speed
  wobblePhaseX: number; // Phase for X wobble
  wobblePhaseY: number; // Phase for Y wobble
  wobbleSpeed: number; // Individual wobble speed
}

/**
 * StaticNeuralBackground - Light Mode "Blueprint Halo"
 * 
 * A structured ring of nodes that frames the center content:
 * - Donut/Ring shape: particles only in outer 30% of screen
 * - Center is 100% clear for the "CORTEX" text
 * - Ring positioned 7% higher to clear footer buttons
 * - Dense connectivity within the ring (continuous circuit)
 * - Size variation with gentle pulsing animation (breathing)
 * - ORGANIC FLOW: Speed variance creates parallax (particles overtake each other)
 * - SPARKLE: Asynchronous opacity animation (living light/energy feel)
 * - WOBBLE: Brownian micro-motion for biological feel
 * - Mouse repulse interaction for "clean" feeling
 * - Orange accent nodes evenly distributed
 */
const StaticNeuralBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const mouseRef = useRef({ x: -1000, y: -1000, active: false });
  const animationRef = useRef<number>(0);
  const centerRef = useRef({ x: 0, y: 0 }); // Store center for orbit calculations

  // Configuration - "Blueprint Halo" with Organic Flow
  const CONFIG = {
    // Ring structure
    nodeCount: 180, // Dense ring of nodes
    innerRingRadius: 0.32, // Inner edge of ring (as % of min dimension)
    outerRingRadius: 0.48, // Outer edge of ring (as % of min dimension)
    ringLayers: 3, // Number of concentric layers in the ring
    verticalOffset: -0.07, // Shift ring UP by 7% of height to clear footer
    
    // Connectivity
    connectionDistance: 65, // Tight connections within ring
    maxConnections: 6, // Max connections per node
    
    // Visual styling - with size variation
    nodeRadiusMin: 1.5, // Minimum node size
    nodeRadiusMax: 3.5, // Maximum node size (random variation)
    lineWidth: 0.5, // Very thin, sharp lines
    lineColor: 'rgb(148, 163, 184)', // Slate-400, not transparent
    greyNodeColor: '#94a3b8', // Slate-400
    orangeNodeColor: '#FF5500', // Adaptavist Orange
    orangeDistribution: 0.12, // 12% orange nodes, evenly distributed
    
    // Size pulsing animation (breathing effect)
    pulseAmount: 0.4, // How much size varies (±40% of base)
    pulseSpeed: 0.0008, // Slow, organic breathing
    
    // Orbital rotation - BASE speed (individual nodes vary)
    orbitSpeed: 0.00004, // Base orbital speed
    
    // NEW: Speed Variance (Parallax Effect)
    orbitSpeedMin: 0.5, // Slowest particles at 50% of base speed
    orbitSpeedMax: 1.5, // Fastest particles at 150% of base speed
    
    // NEW: Opacity Animation (Sparkle Effect)
    opacityMin: 0.15, // Minimum opacity (don't disappear, just dim)
    opacityMax: 1.0, // Maximum opacity (full brightness)
    opacitySpeedMin: 0.0003, // Slowest fade speed
    opacitySpeedMax: 0.0012, // Fastest fade speed
    
    // NEW: Wobble (Brownian Micro-Motion)
    wobbleAmount: 1.5, // Max wobble distance in pixels (1-2px range)
    wobbleSpeedMin: 0.002, // Slowest wobble
    wobbleSpeedMax: 0.006, // Fastest wobble
    
    // Interaction
    repulseRadius: 100, // Mouse influence radius
    repulseStrength: 0.4, // How strongly particles push away
    returnSpeed: 0.03, // How fast particles return to position
    
    // Animation
    driftAmount: 2, // Subtle position drift
    driftSpeed: 0.0005,
  };

  // Initialize nodes in ring formation
  const initNodes = useCallback((width: number, height: number) => {
    const nodes: Node[] = [];
    const centerX = width / 2;
    // Apply vertical offset - shift ring UP to clear footer
    const centerY = height / 2 + (height * CONFIG.verticalOffset);
    const minDim = Math.min(width, height);
    
    // Store center for orbit calculations
    centerRef.current = { x: centerX, y: centerY };
    
    const innerRadius = minDim * CONFIG.innerRingRadius;
    const outerRadius = minDim * CONFIG.outerRingRadius;
    const ringWidth = outerRadius - innerRadius;
    
    // Distribute nodes evenly in the ring
    const nodesPerLayer = Math.floor(CONFIG.nodeCount / CONFIG.ringLayers);
    
    for (let layer = 0; layer < CONFIG.ringLayers; layer++) {
      // Calculate radius for this layer
      const layerProgress = (layer + 0.5) / CONFIG.ringLayers;
      const layerRadius = innerRadius + ringWidth * layerProgress;
      
      // Calculate circumference-based node count for even spacing
      const circumference = 2 * Math.PI * layerRadius;
      const nodeSpacing = circumference / nodesPerLayer;
      const actualNodes = Math.floor(circumference / nodeSpacing);
      
      for (let i = 0; i < actualNodes; i++) {
        // Even angular distribution with slight randomization
        const baseAngle = (i / actualNodes) * Math.PI * 2;
        const angleJitter = (Math.random() - 0.5) * (Math.PI * 2 / actualNodes) * 0.3;
        const angle = baseAngle + angleJitter;
        
        // Slight radial jitter within layer
        const radialJitter = (Math.random() - 0.5) * (ringWidth / CONFIG.ringLayers) * 0.6;
        const nodeRadius = layerRadius + radialJitter;
        
        const x = centerX + Math.cos(angle) * nodeRadius;
        const y = centerY + Math.sin(angle) * nodeRadius;
        
        // Evenly distribute orange nodes (every ~8th node)
        const orangeInterval = Math.floor(1 / CONFIG.orangeDistribution);
        const isOrange = (nodes.length % orangeInterval) === Math.floor(orangeInterval / 2);
        
        // Random size variation for organic depth
        const baseNodeRadius = CONFIG.nodeRadiusMin + 
          Math.random() * (CONFIG.nodeRadiusMax - CONFIG.nodeRadiusMin);
        
        // Individual speed variance for parallax effect (0.5x to 1.5x)
        const orbitSpeedMultiplier = CONFIG.orbitSpeedMin + 
          Math.random() * (CONFIG.orbitSpeedMax - CONFIG.orbitSpeedMin);
        
        // Individual opacity animation for sparkle effect
        const opacitySpeed = CONFIG.opacitySpeedMin + 
          Math.random() * (CONFIG.opacitySpeedMax - CONFIG.opacitySpeedMin);
        
        // Individual wobble for Brownian motion
        const wobbleSpeed = CONFIG.wobbleSpeedMin + 
          Math.random() * (CONFIG.wobbleSpeedMax - CONFIG.wobbleSpeedMin);
        
        nodes.push({
          x,
          y,
          baseX: x,
          baseY: y,
          baseAngle: angle, // Store for orbit
          baseRadius: nodeRadius, // Store distance from center for orbit
          vx: 0,
          vy: 0,
          radius: baseNodeRadius,
          baseNodeRadius, // Store base size for pulsing
          pulsePhase: Math.random() * Math.PI * 2, // Random phase for unsync'd breathing
          isOrange,
          angle,
          // Organic flow properties
          orbitSpeedMultiplier,
          opacity: CONFIG.opacityMin + Math.random() * (CONFIG.opacityMax - CONFIG.opacityMin),
          opacityPhase: Math.random() * Math.PI * 2, // Random start phase
          opacitySpeed,
          wobblePhaseX: Math.random() * Math.PI * 2,
          wobblePhaseY: Math.random() * Math.PI * 2,
          wobbleSpeed,
        });
      }
    }
    
    // Add some nodes in the corners/edges to extend the network
    // Position these higher too (only top and sides, skip bottom to keep footer clear)
    const edgePadding = 40;
    const edgeNodes = 18; // Fewer edge nodes, skip bottom
    
    for (let i = 0; i < edgeNodes; i++) {
      let x: number, y: number;
      const side = i % 3; // Only 3 sides: top, left, right (skip bottom)
      const progress = ((i / 3) % 1) * 0.8 + 0.1; // 10-90% along edge
      
      switch (side) {
        case 0: // Top edge
          x = width * progress;
          y = edgePadding + Math.random() * 30;
          break;
        case 1: // Right edge
          x = width - edgePadding - Math.random() * 30;
          y = height * 0.1 + height * progress * 0.6; // Only top 70% of right edge
          break;
        default: // Left edge
          x = edgePadding + Math.random() * 30;
          y = height * 0.1 + height * progress * 0.6; // Only top 70% of left edge
          break;
      }
      
      const baseNodeRadius = CONFIG.nodeRadiusMin + 
        Math.random() * (CONFIG.nodeRadiusMax - CONFIG.nodeRadiusMin) * 0.7; // Slightly smaller
      
      nodes.push({
        x,
        y,
        baseX: x,
        baseY: y,
        baseAngle: Math.atan2(y - centerY, x - centerX),
        baseRadius: Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2)),
        vx: 0,
        vy: 0,
        radius: baseNodeRadius,
        baseNodeRadius,
        pulsePhase: Math.random() * Math.PI * 2,
        isOrange: false, // Edge nodes are always grey
        angle: Math.atan2(y - centerY, x - centerX),
        // Organic flow properties (edge nodes have slower, subtler animation)
        orbitSpeedMultiplier: 0.3 + Math.random() * 0.4, // Slower for edge nodes
        opacity: 0.4 + Math.random() * 0.4, // Dimmer for edge nodes
        opacityPhase: Math.random() * Math.PI * 2,
        opacitySpeed: CONFIG.opacitySpeedMin + Math.random() * (CONFIG.opacitySpeedMax - CONFIG.opacitySpeedMin) * 0.5,
        wobblePhaseX: Math.random() * Math.PI * 2,
        wobblePhaseY: Math.random() * Math.PI * 2,
        wobbleSpeed: CONFIG.wobbleSpeedMin + Math.random() * (CONFIG.wobbleSpeedMax - CONFIG.wobbleSpeedMin) * 0.5,
      });
    }
    
    nodesRef.current = nodes;
  }, []);

  // Update node positions (orbit + drift + wobble + mouse repulse + size pulse + opacity)
  const updateNodes = useCallback((time: number) => {
    const mouse = mouseRef.current;
    const center = centerRef.current;
    
    nodesRef.current.forEach((node) => {
      // PARALLAX: Individual orbit speed creates flowing stream effect
      // Faster particles overtake slower ones, breaking the lockstep rotation
      const orbitAngle = node.baseAngle + (time * CONFIG.orbitSpeed * node.orbitSpeedMultiplier);
      const orbitX = center.x + Math.cos(orbitAngle) * node.baseRadius;
      const orbitY = center.y + Math.sin(orbitAngle) * node.baseRadius;
      
      // Subtle organic drift on top of orbit
      const driftX = Math.sin(time * CONFIG.driftSpeed + node.baseAngle * 3) * CONFIG.driftAmount;
      const driftY = Math.cos(time * CONFIG.driftSpeed * 1.3 + node.baseAngle * 2) * CONFIG.driftAmount;
      
      // WOBBLE: Brownian micro-motion for biological feel
      const wobbleX = Math.sin(time * node.wobbleSpeed + node.wobblePhaseX) * CONFIG.wobbleAmount;
      const wobbleY = Math.cos(time * node.wobbleSpeed * 1.3 + node.wobblePhaseY) * CONFIG.wobbleAmount;
      
      // Target position with orbit + drift + wobble
      let targetX = orbitX + driftX + wobbleX;
      let targetY = orbitY + driftY + wobbleY;
      
      // Mouse repulse effect
      if (mouse.active) {
        const dx = node.x - mouse.x;
        const dy = node.y - mouse.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < CONFIG.repulseRadius && distance > 0) {
          const force = (1 - distance / CONFIG.repulseRadius) * CONFIG.repulseStrength;
          const pushX = (dx / distance) * force * CONFIG.repulseRadius;
          const pushY = (dy / distance) * force * CONFIG.repulseRadius;
          targetX += pushX;
          targetY += pushY;
        }
      }
      
      // Smooth movement toward target
      node.vx = (targetX - node.x) * CONFIG.returnSpeed;
      node.vy = (targetY - node.y) * CONFIG.returnSpeed;
      node.x += node.vx;
      node.y += node.vy;
      
      // Update current angle (for drawing/calculations)
      node.angle = orbitAngle;
      
      // Size pulsing - gentle breathing animation (unsynchronized)
      const pulseValue = Math.sin(time * CONFIG.pulseSpeed + node.pulsePhase);
      node.radius = node.baseNodeRadius * (1 + pulseValue * CONFIG.pulseAmount);
      
      // SPARKLE: Asynchronous opacity animation
      // Particles fade in and out independently, creating living light/energy feel
      const opacityValue = Math.sin(time * node.opacitySpeed + node.opacityPhase);
      const opacityRange = CONFIG.opacityMax - CONFIG.opacityMin;
      node.opacity = CONFIG.opacityMin + (opacityValue * 0.5 + 0.5) * opacityRange;
    });
  }, []);

  // Helper to convert hex to rgba
  const hexToRgba = (hex: string, alpha: number): string => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  // Draw the network
  const draw = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    const nodes = nodesRef.current;
    
    // Draw connections first (behind nodes)
    // Lines inherit opacity from the nodes they connect
    ctx.lineWidth = CONFIG.lineWidth;
    ctx.lineCap = 'round';
    
    // Build connection map to limit connections per node
    const connectionCounts = new Map<number, number>();
    
    for (let i = 0; i < nodes.length; i++) {
      const nodeA = nodes[i];
      const connectionsA = connectionCounts.get(i) || 0;
      
      if (connectionsA >= CONFIG.maxConnections) continue;
      
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeB = nodes[j];
        const connectionsB = connectionCounts.get(j) || 0;
        
        if (connectionsB >= CONFIG.maxConnections) continue;
        
        const dx = nodeA.x - nodeB.x;
        const dy = nodeA.y - nodeB.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < CONFIG.connectionDistance) {
          // Line opacity is the average of the two connected nodes
          const lineOpacity = (nodeA.opacity + nodeB.opacity) / 2;
          ctx.strokeStyle = `rgba(148, 163, 184, ${lineOpacity * 0.8})`; // Slightly dimmer than nodes
          
          ctx.beginPath();
          ctx.moveTo(nodeA.x, nodeA.y);
          ctx.lineTo(nodeB.x, nodeB.y);
          ctx.stroke();
          
          connectionCounts.set(i, (connectionCounts.get(i) || 0) + 1);
          connectionCounts.set(j, (connectionCounts.get(j) || 0) + 1);
        }
      }
    }
    
    // Draw nodes on top with individual opacity (sparkle effect)
    for (const node of nodes) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      
      // Apply node's individual opacity for sparkle effect
      if (node.isOrange) {
        ctx.fillStyle = hexToRgba(CONFIG.orangeNodeColor, node.opacity);
      } else {
        ctx.fillStyle = hexToRgba(CONFIG.greyNodeColor, node.opacity);
      }
      
      ctx.fill();
    }
  }, []);

  // Animation loop
  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const time = performance.now();
    
    updateNodes(time);
    draw(ctx, canvas.width, canvas.height);
    
    animationRef.current = requestAnimationFrame(animate);
  }, [updateNodes, draw]);

  // Setup and event handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle resize
    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      initNodes(canvas.width, canvas.height);
    };

    // Handle mouse movement
    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
      mouseRef.current.active = true;
    };

    const handleMouseLeave = () => {
      mouseRef.current.active = false;
      mouseRef.current.x = -1000;
      mouseRef.current.y = -1000;
    };

    // Initialize
    handleResize();
    
    // Start animation
    animate();

    // Add event listeners
    window.addEventListener('resize', handleResize);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      window.removeEventListener('resize', handleResize);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [initNodes, animate]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ background: 'transparent', zIndex: 1 }}
      aria-hidden="true"
    />
  );
};

export default StaticNeuralBackground;
