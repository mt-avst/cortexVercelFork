import React, { useEffect, useRef, useCallback, useState } from 'react';

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
 * StaticNeuralBackground - Light Mode "Blueprint" Aesthetic
 * 
 * A sophisticated, technical visualization for light mode:
 * 
 * VISUAL DESIGN:
 * - Links (Lines): Slate-500 (#64748B) at 0.4 opacity, 1px width
 *   Creates a crisp, technical structure like architectural blueprints
 * - Particles (Dots): Brand Orange (#F97316) at 0.8 opacity, 3-4px
 *   Represents "active data" or "energy" flowing through the system
 * 
 * STRUCTURE:
 * - Donut/Ring shape: particles only in outer 30% of screen
 * - Center is 100% clear for the "CORTEX" text
 * - Ring positioned 7% higher to clear footer buttons
 * - Dense connectivity within the ring (continuous circuit)
 * 
 * ANIMATION:
 * - ORGANIC FLOW: Speed variance creates parallax (particles overtake each other)
 * - SUBTLE SPARKLE: Gentle opacity animation for living feel
 * - WOBBLE: Brownian micro-motion for biological feel
 * - Mouse repulse interaction for "clean" feeling
 */
const StaticNeuralBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const mouseRef = useRef({ x: -1000, y: -1000, active: false });
  const animationRef = useRef<number>(0);
  const centerRef = useRef({ x: 0, y: 0 }); // Store center for orbit calculations
  const lastFrameTimeRef = useRef<number>(0);
  
  // Performance: Detect reduced motion preference
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  
  // Performance: Frame-rate throttling targets
  const TARGET_FPS_REDUCED = 30;
  const FRAME_INTERVAL_REDUCED = 1000 / TARGET_FPS_REDUCED;

  // Configuration - "Blueprint" Aesthetic for Light Mode
  // Creates a crisp, technical structure with orange "active data" points
  // Adjusted for reduced motion preference
  const CONFIG = {
    // Ring structure - "Moat" design keeps particles away from center text
    nodeCount: prefersReducedMotion ? 60 : 180, // Reduced node count for reduced motion
    innerRingRadius: 0.38, // Inner edge - INCREASED for larger exclusion zone ("moat")
    outerRingRadius: 0.52, // Outer edge - slightly larger to maintain ring width
    ringLayers: prefersReducedMotion ? 2 : 3, // Fewer layers for reduced motion
    verticalOffset: -0.05, // Shift ring UP by 5% of height for optical centering
    
    // Connectivity
    connectionDistance: 65, // Tight connections within ring
    maxConnections: 6, // Max connections per node
    
    // === BLUEPRINT AESTHETIC ===
    // Lines: Slate-500, crisp technical structure
    lineWidth: 1, // 1px - crisp, technical lines
    lineColor: '#64748B', // Slate-500 - technical blueprint feel
    lineOpacity: 0.4, // Visible but subtle
    
    // Particles: Brand Orange - represents "active data/energy"
    nodeRadiusMin: 3, // 3px minimum - larger, more visible
    nodeRadiusMax: 4, // 4px maximum - uniform, deliberate sizing
    nodeColor: '#F97316', // Brand Orange - ALL particles are orange
    nodeOpacity: 0.8, // High visibility
    
    // Size pulsing animation (breathing effect)
    pulseAmount: 0.15, // Subtle size variation (±15%)
    pulseSpeed: 0.0008, // Slow, organic breathing
    
    // Orbital rotation - BASE speed (individual nodes vary)
    // Reduced motion: Much slower, almost static
    orbitSpeed: prefersReducedMotion ? 0.000005 : 0.00004,
    
    // Speed Variance (Parallax Effect) - disabled for reduced motion
    orbitSpeedMin: prefersReducedMotion ? 0.9 : 0.5, // Minimal variance for reduced motion
    orbitSpeedMax: prefersReducedMotion ? 1.1 : 1.5, // Minimal variance for reduced motion
    
    // Subtle opacity variation (sparkle - stronger visibility for light mode)
    opacityMin: 0.75, // Minimum opacity (always clearly visible)
    opacityMax: 1.0, // Maximum opacity (full brightness)
    opacitySpeedMin: prefersReducedMotion ? 0.00005 : 0.0003, // Much slower for reduced motion
    opacitySpeedMax: prefersReducedMotion ? 0.0002 : 0.0012, // Much slower for reduced motion
    
    // Wobble (Brownian Micro-Motion) - minimal for reduced motion
    wobbleAmount: prefersReducedMotion ? 0.3 : 1.5, // Almost no wobble for reduced motion
    wobbleSpeedMin: prefersReducedMotion ? 0.0005 : 0.002,
    wobbleSpeedMax: prefersReducedMotion ? 0.001 : 0.006,
    
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
        
        // Blueprint aesthetic: ALL particles are Brand Orange (active data points)
        const isOrange = true; // All nodes are now orange
        
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
        isOrange: true, // Blueprint: all nodes are orange (active data points)
        angle: Math.atan2(y - centerY, x - centerX),
        // Organic flow properties (edge nodes have slower, subtler animation)
        orbitSpeedMultiplier: 0.3 + Math.random() * 0.4, // Slower for edge nodes
        opacity: CONFIG.opacityMin + Math.random() * (CONFIG.opacityMax - CONFIG.opacityMin) * 0.85, // Visible but slightly softer
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
          // Blueprint aesthetic: Slate-500 lines with fixed opacity
          ctx.strokeStyle = `rgba(100, 116, 139, ${CONFIG.lineOpacity})`; // #64748B at 0.4 opacity
          
          ctx.beginPath();
          ctx.moveTo(nodeA.x, nodeA.y);
          ctx.lineTo(nodeB.x, nodeB.y);
          ctx.stroke();
          
          connectionCounts.set(i, (connectionCounts.get(i) || 0) + 1);
          connectionCounts.set(j, (connectionCounts.get(j) || 0) + 1);
        }
      }
    }
    
    // Draw nodes on top - Blueprint aesthetic: Brand Orange "active data" points
    for (const node of nodes) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      
      // Blueprint aesthetic: All nodes are Brand Orange with subtle opacity variation
      ctx.fillStyle = hexToRgba(CONFIG.nodeColor, node.opacity);
      
      ctx.fill();
    }
  }, []);

  // Animation loop with frame-rate throttling for reduced motion
  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const time = performance.now();
    
    // Frame-rate throttling for reduced motion preference
    if (prefersReducedMotion && time - lastFrameTimeRef.current < FRAME_INTERVAL_REDUCED) {
      animationRef.current = requestAnimationFrame(animate);
      return;
    }
    lastFrameTimeRef.current = time;
    
    updateNodes(time);
    draw(ctx, canvas.width, canvas.height);
    
    animationRef.current = requestAnimationFrame(animate);
  }, [updateNodes, draw, prefersReducedMotion]);

  // Detect and respond to reduced motion preference
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);
    
    const handleChange = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };
    
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

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
  }, [initNodes, animate, prefersReducedMotion]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ 
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          background: 'transparent',
        }}
        aria-hidden="true"
      />
    </div>
  );
};

export default StaticNeuralBackground;
