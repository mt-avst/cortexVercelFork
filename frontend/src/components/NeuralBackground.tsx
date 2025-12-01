'use client';

import React, { useEffect, useRef, useCallback } from 'react';

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  baseRadius: number;
  color: string;
  glowColor: string;
  brightness: number;
  baseBrightness: number;
  isViolet: boolean;
}

interface Pulse {
  fromNode: number;
  toNode: number;
  progress: number;
  speed: number;
  intensity: number;
}

/**
 * NeuralBackground Component
 * 
 * A cinematic neural network animation with:
 * - Neuralink meets JARVIS aesthetic
 * - Blood Orange & Deep Red particles with Electric Violet accents
 * - Glowing neon effect using shadowBlur and composite operations
 * - Mouse influence field (repulsion/excitation)
 * - Synapse pulse signals traveling between nodes
 * - Slow, organic "floating in heavy liquid" movement
 */
const NeuralBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const pulsesRef = useRef<Pulse[]>([]);
  const mouseRef = useRef({ x: -1000, y: -1000, active: false });
  const animationRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  // Color palette
  const COLORS = {
    background: '#030305',
    bloodOrange: '#FF4500',
    deepRed: '#8B0000',
    electricViolet: '#8A2BE2',
    orangeGlow: '#FF6B35',
    redGlow: '#CC0000',
    violetGlow: '#9945FF',
  };

  // Configuration
  const CONFIG = {
    nodeCount: 120,
    connectionDistance: 180,
    mouseInfluenceRadius: 200,
    mouseRepulsionStrength: 0.8,
    baseDriftSpeed: 0.15,
    dampening: 0.98,
    pulseChance: 0.008,
    pulseSpeed: 0.015,
    violetChance: 0.08,
  };

  // Initialize nodes
  const initNodes = useCallback((width: number, height: number) => {
    const nodes: Node[] = [];
    const nodeCount = Math.floor(CONFIG.nodeCount * Math.min(1, (width * height) / (1920 * 1080)));

    for (let i = 0; i < nodeCount; i++) {
      const isViolet = Math.random() < CONFIG.violetChance;
      const baseRadius = 2 + Math.random() * 3;
      
      let color: string;
      let glowColor: string;
      
      if (isViolet) {
        color = COLORS.electricViolet;
        glowColor = COLORS.violetGlow;
      } else if (Math.random() > 0.5) {
        color = COLORS.bloodOrange;
        glowColor = COLORS.orangeGlow;
      } else {
        color = COLORS.deepRed;
        glowColor = COLORS.redGlow;
      }

      nodes.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * CONFIG.baseDriftSpeed,
        vy: (Math.random() - 0.5) * CONFIG.baseDriftSpeed,
        radius: baseRadius,
        baseRadius,
        color,
        glowColor,
        brightness: 0.6 + Math.random() * 0.4,
        baseBrightness: 0.6 + Math.random() * 0.4,
        isViolet,
      });
    }

    nodesRef.current = nodes;
    pulsesRef.current = [];
  }, []);

  // Update node positions with mouse influence
  const updateNodes = useCallback((width: number, height: number, deltaTime: number) => {
    const nodes = nodesRef.current;
    const mouse = mouseRef.current;
    const timeFactor = Math.min(deltaTime / 16.67, 2); // Normalize to 60fps

    nodes.forEach((node) => {
      // Apply organic drift with subtle noise
      const driftAngle = Math.sin(Date.now() * 0.0001 + node.x * 0.01) * 0.02;
      node.vx += Math.cos(driftAngle) * 0.005 * timeFactor;
      node.vy += Math.sin(driftAngle) * 0.005 * timeFactor;

      // Mouse influence
      if (mouse.active) {
        const dx = node.x - mouse.x;
        const dy = node.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < CONFIG.mouseInfluenceRadius && dist > 0) {
          const influence = 1 - (dist / CONFIG.mouseInfluenceRadius);
          const force = influence * influence * CONFIG.mouseRepulsionStrength;
          
          // Repulsion
          node.vx += (dx / dist) * force * timeFactor;
          node.vy += (dy / dist) * force * timeFactor;
          
          // Excitation - increase brightness
          node.brightness = Math.min(1.5, node.baseBrightness + influence * 0.8);
          node.radius = node.baseRadius * (1 + influence * 0.5);
        } else {
          // Gradually return to base state
          node.brightness += (node.baseBrightness - node.brightness) * 0.02 * timeFactor;
          node.radius += (node.baseRadius - node.radius) * 0.02 * timeFactor;
        }
      } else {
        node.brightness += (node.baseBrightness - node.brightness) * 0.01 * timeFactor;
        node.radius += (node.baseRadius - node.radius) * 0.01 * timeFactor;
      }

      // Apply velocity with dampening (heavy liquid feel)
      node.x += node.vx * timeFactor;
      node.y += node.vy * timeFactor;
      node.vx *= CONFIG.dampening;
      node.vy *= CONFIG.dampening;

      // Soft boundary wrapping
      const margin = 50;
      if (node.x < -margin) node.x = width + margin;
      if (node.x > width + margin) node.x = -margin;
      if (node.y < -margin) node.y = height + margin;
      if (node.y > height + margin) node.y = -margin;
    });
  }, []);

  // Update and spawn pulses
  const updatePulses = useCallback((deltaTime: number) => {
    const nodes = nodesRef.current;
    const pulses = pulsesRef.current;
    const timeFactor = Math.min(deltaTime / 16.67, 2);

    // Spawn new pulses occasionally
    if (Math.random() < CONFIG.pulseChance && nodes.length > 1) {
      // Find a pair of connected nodes
      for (let attempts = 0; attempts < 10; attempts++) {
        const fromIdx = Math.floor(Math.random() * nodes.length);
        const from = nodes[fromIdx];
        
        for (let j = 0; j < nodes.length; j++) {
          if (j === fromIdx) continue;
          const to = nodes[j];
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist < CONFIG.connectionDistance) {
            pulses.push({
              fromNode: fromIdx,
              toNode: j,
              progress: 0,
              speed: CONFIG.pulseSpeed + Math.random() * 0.01,
              intensity: 0.8 + Math.random() * 0.2,
            });
            break;
          }
        }
        break;
      }
    }

    // Update existing pulses
    pulsesRef.current = pulses.filter((pulse) => {
      pulse.progress += pulse.speed * timeFactor;
      return pulse.progress < 1;
    });
  }, []);

  // Draw everything
  const draw = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const nodes = nodesRef.current;
    const pulses = pulsesRef.current;

    // Clear with dark background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    // Use 'lighter' composite for glow accumulation
    ctx.globalCompositeOperation = 'lighter';

    // Draw connections first (underneath)
    ctx.lineCap = 'round';
    
    for (let i = 0; i < nodes.length; i++) {
      const nodeA = nodes[i];
      
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeB = nodes[j];
        const dx = nodeB.x - nodeA.x;
        const dy = nodeB.y - nodeA.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < CONFIG.connectionDistance) {
          const opacity = Math.pow(1 - dist / CONFIG.connectionDistance, 2) * 0.4;
          const avgBrightness = (nodeA.brightness + nodeB.brightness) / 2;
          
          // Determine line color based on connected nodes
          let lineColor: string;
          if (nodeA.isViolet || nodeB.isViolet) {
            lineColor = COLORS.electricViolet;
          } else {
            lineColor = COLORS.bloodOrange;
          }

          // Draw glowing line
          ctx.save();
          ctx.shadowBlur = 8;
          ctx.shadowColor = lineColor;
          ctx.strokeStyle = hexToRgba(lineColor, opacity * avgBrightness);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(nodeA.x, nodeA.y);
          ctx.lineTo(nodeB.x, nodeB.y);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // Draw pulses (synapse signals)
    pulses.forEach((pulse) => {
      const from = nodes[pulse.fromNode];
      const to = nodes[pulse.toNode];
      if (!from || !to) return;

      const x = from.x + (to.x - from.x) * pulse.progress;
      const y = from.y + (to.y - from.y) * pulse.progress;
      
      // Fade in/out at edges
      const fadeIn = Math.min(1, pulse.progress * 4);
      const fadeOut = Math.min(1, (1 - pulse.progress) * 4);
      const alpha = fadeIn * fadeOut * pulse.intensity;

      // Bright pulse core
      ctx.save();
      ctx.shadowBlur = 20;
      ctx.shadowColor = '#FFFFFF';
      
      const pulseGradient = ctx.createRadialGradient(x, y, 0, x, y, 8);
      pulseGradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      pulseGradient.addColorStop(0.3, `rgba(255, 150, 50, ${alpha * 0.8})`);
      pulseGradient.addColorStop(0.6, `rgba(255, 69, 0, ${alpha * 0.4})`);
      pulseGradient.addColorStop(1, 'transparent');
      
      ctx.fillStyle = pulseGradient;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      
      // Inner white core
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    // Draw nodes
    nodes.forEach((node) => {
      const glowRadius = node.radius * 6 * node.brightness;

      // Outer glow
      ctx.save();
      ctx.shadowBlur = 25;
      ctx.shadowColor = node.glowColor;
      
      const outerGlow = ctx.createRadialGradient(
        node.x, node.y, 0,
        node.x, node.y, glowRadius
      );
      outerGlow.addColorStop(0, hexToRgba(node.color, 0.6 * node.brightness));
      outerGlow.addColorStop(0.4, hexToRgba(node.glowColor, 0.2 * node.brightness));
      outerGlow.addColorStop(1, 'transparent');

      ctx.fillStyle = outerGlow;
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Node core with bright center
      ctx.save();
      ctx.shadowBlur = 15;
      ctx.shadowColor = node.color;

      const coreGradient = ctx.createRadialGradient(
        node.x - node.radius * 0.3, node.y - node.radius * 0.3, 0,
        node.x, node.y, node.radius
      );
      coreGradient.addColorStop(0, `rgba(255, 255, 255, ${node.brightness})`);
      coreGradient.addColorStop(0.3, hexToRgba(node.color, node.brightness));
      coreGradient.addColorStop(1, hexToRgba(node.glowColor, node.brightness * 0.8));

      ctx.fillStyle = coreGradient;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    // Reset composite operation
    ctx.globalCompositeOperation = 'source-over';
  }, []);

  // Helper: Convert hex to rgba
  const hexToRgba = (hex: string, alpha: number): string => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return `rgba(255, 69, 0, ${alpha})`;
    return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`;
  };

  // Animation loop
  const animate = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const deltaTime = timestamp - lastTimeRef.current;
    lastTimeRef.current = timestamp;

    const width = canvas.width;
    const height = canvas.height;

    updateNodes(width, height, deltaTime);
    updatePulses(deltaTime);
    draw(ctx, width, height);

    animationRef.current = requestAnimationFrame(animate);
  }, [updateNodes, updatePulses, draw]);

  // Setup and event handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(dpr, dpr);
      }
      
      initNodes(window.innerWidth, window.innerHeight);
    };

    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY, active: true };
    };

    const handleMouseLeave = () => {
      mouseRef.current = { ...mouseRef.current, active: false };
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        mouseRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, active: true };
      }
    };

    const handleTouchEnd = () => {
      mouseRef.current = { ...mouseRef.current, active: false };
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('touchmove', handleTouchMove);
    window.addEventListener('touchend', handleTouchEnd);

    // Start animation
    lastTimeRef.current = performance.now();
    animationRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [initNodes, animate]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 -z-10"
      style={{ background: COLORS.background }}
      aria-hidden="true"
    />
  );
};

export default NeuralBackground;


