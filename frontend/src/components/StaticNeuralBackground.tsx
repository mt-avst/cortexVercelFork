import React, { useEffect, useRef } from 'react';

/**
 * StaticNeuralBackground - Light Mode Blueprint/Schematic Background
 * 
 * A static 2D HTML5 Canvas component that renders once on mount.
 * Creates a technical schematic/blueprint aesthetic with:
 * - Subtle grid pattern (graph paper feel)
 * - ~80 nodes biased away from center
 * - Thin connections between nearby nodes
 * - Minimal color palette (light grey + Adaptavist orange)
 */
const StaticNeuralBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Render function
    const render = () => {
      // Set canvas size
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Configuration
      const NODE_COUNT = 80;
      const GRID_SIZE = 20; // 20px x 20px grid
      const NODE_RADIUS = 2.5; // Small filled circles
      const CONNECTION_DISTANCE = 120; // Max distance for connections
      const CENTER_X = canvas.width / 2;
      const CENTER_Y = canvas.height / 2;
      const CENTER_CLEAR_RADIUS = 300; // Keep text area clear

      // Generate nodes with bias away from center
      const nodes: Array<{ x: number; y: number; isOrange: boolean }> = [];
      const maxRadius = Math.min(canvas.width, canvas.height) * 0.45;
      
      for (let i = 0; i < NODE_COUNT; i++) {
        let x: number, y: number;
        let attempts = 0;
        
        // Bias nodes away from center - use polar coordinates with bias
        do {
          // Generate angle
          const angle = Math.random() * Math.PI * 2;
          
          // Bias distance away from center: prefer outer regions
          // Use a power function to bias toward larger distances
          const randomFactor = Math.pow(Math.random(), 0.5); // Square root bias toward 1.0
          const minDistance = CENTER_CLEAR_RADIUS + 20; // Start just outside clear zone
          const distance = minDistance + randomFactor * (maxRadius - minDistance);
          
          // Convert to cartesian
          x = CENTER_X + Math.cos(angle) * distance;
          y = CENTER_Y + Math.sin(angle) * distance;
          
          // Ensure within bounds
          x = Math.max(NODE_RADIUS, Math.min(canvas.width - NODE_RADIUS, x));
          y = Math.max(NODE_RADIUS, Math.min(canvas.height - NODE_RADIUS, y));
          
          attempts++;
        } while (
          attempts < 50 && 
          Math.sqrt(Math.pow(x - CENTER_X, 2) + Math.pow(y - CENTER_Y, 2)) < CENTER_CLEAR_RADIUS
        );

        // 10% chance for orange node
        const isOrange = Math.random() < 0.1;
        nodes.push({ x, y, isOrange });
      }

      // Draw grid (extremely faint)
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)'; // Very subtle slate-300
      ctx.lineWidth = 0.5;
      
      for (let x = 0; x < canvas.width; x += GRID_SIZE) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      
      for (let y = 0; y < canvas.height; y += GRID_SIZE) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Draw connections between nearby nodes
      ctx.strokeStyle = 'rgba(100, 116, 139, 0.1)'; // Very faint grey
      ctx.lineWidth = 0.8;
      
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance < CONNECTION_DISTANCE) {
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      // Draw nodes
      for (const node of nodes) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
        
        if (node.isOrange) {
          ctx.fillStyle = '#FF5500'; // Adaptavist Orange
        } else {
          ctx.fillStyle = '#CBD5E1'; // Light Grey (slate-300)
        }
        
        ctx.fill();
      }
    };

    // Initial render
    render();

    // Handle resize
    const handleResize = () => {
      render();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full -z-10"
      style={{ background: 'transparent' }}
      aria-hidden="true"
    />
  );
};

export default StaticNeuralBackground;
