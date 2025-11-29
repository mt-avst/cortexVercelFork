import React, { useEffect, useRef, memo, useCallback } from 'react';

interface Neuron {
  x: number;
  y: number;
  radius: number;
  glowIntensity: number;
  pulsePhase: number;
  pulseSpeed: number;
}

interface Dendrite {
  startX: number;
  startY: number;
  segments: { x: number; y: number; thickness: number }[];
  color: string;
  glowColor: string;
}

interface NebulaBurst {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  color: string;
  pulsePhase: number;
}

/**
 * NeuralParticleField Component
 * 
 * Creates organic neural network visualization with:
 * - Branching dendrite structures
 * - Glowing neuron nodes
 * - Nebula burst effects at intersections
 * - All in Adaptavist orange/coral palette
 */
const NeuralParticleField: React.FC = memo(() => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const neuronsRef = useRef<Neuron[]>([]);
  const dendritesRef = useRef<Dendrite[]>([]);
  const nebulasRef = useRef<NebulaBurst[]>([]);
  const animationRef = useRef<number>(0);
  const timeRef = useRef<number>(0);

  // Adaptavist orange/coral palette
  const colors = {
    brightOrange: '#FF5A1F',
    coral: '#FF4E50',
    deepOrange: '#E86C24',
    amber: '#FF7A33',
    darkOrange: '#CC4A15',
    bloodOrange: '#FF6B35',
  };

  const colorArray = Object.values(colors);

  // Generate branching dendrite path
  const generateDendrite = useCallback((startX: number, startY: number, angle: number, length: number, depth: number): Dendrite => {
    const segments: { x: number; y: number; thickness: number }[] = [];
    let x = startX;
    let y = startY;
    const segmentCount = Math.floor(length / 15);
    
    for (let i = 0; i < segmentCount; i++) {
      // Add organic waviness
      const waveOffset = Math.sin(i * 0.5) * 8;
      const angleVariation = (Math.random() - 0.5) * 0.3;
      
      x += Math.cos(angle + angleVariation) * 15 + waveOffset * Math.cos(angle + Math.PI / 2);
      y += Math.sin(angle + angleVariation) * 15 + waveOffset * Math.sin(angle + Math.PI / 2);
      
      // Thickness tapers toward end
      const thickness = Math.max(1, (3 - depth) * (1 - i / segmentCount) * 2);
      
      segments.push({ x, y, thickness });
    }

    const colorIndex = Math.floor(Math.random() * colorArray.length);
    return {
      startX,
      startY,
      segments,
      color: colorArray[colorIndex],
      glowColor: colorArray[(colorIndex + 1) % colorArray.length],
    };
  }, [colorArray]);

  // Initialize neural network
  const initNeuralNetwork = useCallback((width: number, height: number) => {
    const neurons: Neuron[] = [];
    const dendrites: Dendrite[] = [];
    const nebulas: NebulaBurst[] = [];

    // Create main neuron clusters at corners and edges
    const clusterPositions = [
      { x: width * 0.05, y: height * 0.15 },
      { x: width * 0.95, y: height * 0.1 },
      { x: width * 0.08, y: height * 0.85 },
      { x: width * 0.92, y: height * 0.9 },
      { x: width * 0.15, y: height * 0.5 },
      { x: width * 0.85, y: height * 0.45 },
      { x: width * 0.03, y: height * 0.35 },
      { x: width * 0.97, y: height * 0.65 },
    ];

    clusterPositions.forEach((pos, index) => {
      // Create main neuron node
      neurons.push({
        x: pos.x,
        y: pos.y,
        radius: 8 + Math.random() * 12,
        glowIntensity: 0.6 + Math.random() * 0.4,
        pulsePhase: Math.random() * Math.PI * 2,
        pulseSpeed: 0.5 + Math.random() * 0.5,
      });

      // Create nebula burst at main nodes
      nebulas.push({
        x: pos.x,
        y: pos.y,
        radius: 60 + Math.random() * 80,
        opacity: 0.15 + Math.random() * 0.15,
        color: colorArray[index % colorArray.length],
        pulsePhase: Math.random() * Math.PI * 2,
      });

      // Generate dendrites branching from each neuron
      const dendriteCount = 3 + Math.floor(Math.random() * 4);
      for (let d = 0; d < dendriteCount; d++) {
        // Angle pointing toward center of screen with some variation
        const centerAngle = Math.atan2(height / 2 - pos.y, width / 2 - pos.x);
        const spreadAngle = (Math.PI / 2) * (d / dendriteCount - 0.5) + centerAngle;
        const length = 150 + Math.random() * 250;
        
        const dendrite = generateDendrite(pos.x, pos.y, spreadAngle, length, 0);
        dendrites.push(dendrite);

        // Add secondary branches
        if (dendrite.segments.length > 3) {
          const branchPoints = [
            Math.floor(dendrite.segments.length * 0.3),
            Math.floor(dendrite.segments.length * 0.6),
          ];
          
          branchPoints.forEach((branchIdx) => {
            if (dendrite.segments[branchIdx]) {
              const branchAngle = spreadAngle + (Math.random() - 0.5) * Math.PI * 0.6;
              const branchLength = 80 + Math.random() * 120;
              const branch = generateDendrite(
                dendrite.segments[branchIdx].x,
                dendrite.segments[branchIdx].y,
                branchAngle,
                branchLength,
                1
              );
              dendrites.push(branch);

              // Small neuron at branch point
              neurons.push({
                x: dendrite.segments[branchIdx].x,
                y: dendrite.segments[branchIdx].y,
                radius: 3 + Math.random() * 4,
                glowIntensity: 0.4 + Math.random() * 0.3,
                pulsePhase: Math.random() * Math.PI * 2,
                pulseSpeed: 0.8 + Math.random() * 0.4,
              });
            }
          });
        }

        // Small neuron at dendrite end
        const lastSegment = dendrite.segments[dendrite.segments.length - 1];
        if (lastSegment) {
          neurons.push({
            x: lastSegment.x,
            y: lastSegment.y,
            radius: 2 + Math.random() * 3,
            glowIntensity: 0.3 + Math.random() * 0.3,
            pulsePhase: Math.random() * Math.PI * 2,
            pulseSpeed: 1 + Math.random() * 0.5,
          });
        }
      }
    });

    // Add floating smaller nebula effects
    for (let i = 0; i < 6; i++) {
      nebulas.push({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: 40 + Math.random() * 60,
        opacity: 0.08 + Math.random() * 0.1,
        color: colorArray[Math.floor(Math.random() * colorArray.length)],
        pulsePhase: Math.random() * Math.PI * 2,
      });
    }

    neuronsRef.current = neurons;
    dendritesRef.current = dendrites;
    nebulasRef.current = nebulas;
  }, [colorArray, generateDendrite]);

  // Draw nebula burst effect
  const drawNebula = useCallback((ctx: CanvasRenderingContext2D, nebula: NebulaBurst, time: number) => {
    const pulse = Math.sin(time * 0.001 + nebula.pulsePhase) * 0.3 + 0.7;
    const radius = nebula.radius * pulse;
    
    const gradient = ctx.createRadialGradient(
      nebula.x, nebula.y, 0,
      nebula.x, nebula.y, radius
    );
    
    // Parse color and create gradient stops
    gradient.addColorStop(0, nebula.color.replace(')', `, ${nebula.opacity * pulse})`).replace('rgb', 'rgba').replace('#', 'rgba(').replace(/([A-Fa-f0-9]{2})([A-Fa-f0-9]{2})([A-Fa-f0-9]{2})/, (_, r, g, b) => 
      `${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${nebula.opacity * pulse})`
    ));
    gradient.addColorStop(0.4, `rgba(255, 90, 31, ${nebula.opacity * 0.5 * pulse})`);
    gradient.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(nebula.x, nebula.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  }, []);

  // Draw dendrite with glow
  const drawDendrite = useCallback((ctx: CanvasRenderingContext2D, dendrite: Dendrite, time: number) => {
    if (dendrite.segments.length < 2) return;

    // Glow layer
    ctx.save();
    ctx.shadowColor = dendrite.glowColor;
    ctx.shadowBlur = 15;
    ctx.strokeStyle = dendrite.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(dendrite.startX, dendrite.startY);
    
    dendrite.segments.forEach((seg, i) => {
      ctx.lineWidth = seg.thickness + 2;
      ctx.lineTo(seg.x, seg.y);
    });
    
    ctx.stroke();
    ctx.restore();

    // Core line
    ctx.strokeStyle = dendrite.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(dendrite.startX, dendrite.startY);
    
    dendrite.segments.forEach((seg) => {
      ctx.lineWidth = seg.thickness;
      ctx.lineTo(seg.x, seg.y);
    });
    
    ctx.stroke();
  }, []);

  // Draw neuron node with glow
  const drawNeuron = useCallback((ctx: CanvasRenderingContext2D, neuron: Neuron, time: number) => {
    const pulse = Math.sin(time * 0.002 * neuron.pulseSpeed + neuron.pulsePhase) * 0.3 + 0.7;
    const glowRadius = neuron.radius * 3 * pulse;
    
    // Outer glow
    const gradient = ctx.createRadialGradient(
      neuron.x, neuron.y, 0,
      neuron.x, neuron.y, glowRadius
    );
    gradient.addColorStop(0, `rgba(255, 90, 31, ${neuron.glowIntensity * pulse})`);
    gradient.addColorStop(0.3, `rgba(255, 78, 80, ${neuron.glowIntensity * 0.5 * pulse})`);
    gradient.addColorStop(0.6, `rgba(232, 108, 36, ${neuron.glowIntensity * 0.2 * pulse})`);
    gradient.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(neuron.x, neuron.y, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Core with bright center
    const coreGradient = ctx.createRadialGradient(
      neuron.x, neuron.y, 0,
      neuron.x, neuron.y, neuron.radius
    );
    coreGradient.addColorStop(0, '#FFFFFF');
    coreGradient.addColorStop(0.3, '#FF7A33');
    coreGradient.addColorStop(0.7, '#FF5A1F');
    coreGradient.addColorStop(1, '#CC4A15');

    ctx.beginPath();
    ctx.arc(neuron.x, neuron.y, neuron.radius * pulse, 0, Math.PI * 2);
    ctx.fillStyle = coreGradient;
    ctx.fill();
  }, []);

  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    timeRef.current += 16;

    // Clear with very dark background
    ctx.fillStyle = '#08080C';
    ctx.fillRect(0, 0, width, height);

    // Draw nebula bursts first (background)
    nebulasRef.current.forEach((nebula) => {
      drawNebula(ctx, nebula, timeRef.current);
    });

    // Draw dendrites
    dendritesRef.current.forEach((dendrite) => {
      drawDendrite(ctx, dendrite, timeRef.current);
    });

    // Draw neurons on top
    neuronsRef.current.forEach((neuron) => {
      drawNeuron(ctx, neuron, timeRef.current);
    });

    animationRef.current = requestAnimationFrame(animate);
  }, [drawNebula, drawDendrite, drawNeuron]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      initNeuralNetwork(canvas.width, canvas.height);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    // Start animation
    animate();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [initNeuralNetwork, animate]);

  return (
    <canvas
      ref={canvasRef}
      className="neural-particle-field"
      aria-hidden="true"
    />
  );
});

NeuralParticleField.displayName = 'NeuralParticleField';

export default NeuralParticleField;
