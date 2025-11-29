import React, { useEffect, useRef, memo, useCallback } from 'react';

interface Vector2 {
  x: number;
  y: number;
}

interface Neuron {
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  radius: number;
  glowIntensity: number;
  pulsePhase: number;
  pulseSpeed: number;
  swayPhase: number;
  swaySpeed: number;
  color: string;
  connections: number[];
}

interface DendriteSegment {
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  thickness: number;
  swayPhase: number;
  swayAmount: number;
}

interface Dendrite {
  startNeuronIdx: number;
  segments: DendriteSegment[];
  color: string;
  glowColor: string;
  swayPhase: number;
  swaySpeed: number;
}

interface SignalPulse {
  dendriteIdx: number;
  progress: number;
  speed: number;
  intensity: number;
}

interface FloatingParticle {
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  radius: number;
  opacity: number;
  driftPhase: number;
  driftSpeed: number;
  twinklePhase: number;
}

interface NebulaBurst {
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  radius: number;
  opacity: number;
  color: string;
  pulsePhase: number;
  driftPhase: number;
}

/**
 * NeuralParticleField Component - Enhanced
 * 
 * Creates organic neural network visualization with:
 * - Gently swaying dendrite structures
 * - Multiple levels of branching
 * - Glowing neuron nodes with connection pulses
 * - Floating atmospheric particles
 * - Nebula burst effects
 * - Smooth bezier curve rendering
 */
const NeuralParticleField: React.FC = memo(() => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const neuronsRef = useRef<Neuron[]>([]);
  const dendritesRef = useRef<Dendrite[]>([]);
  const particlesRef = useRef<FloatingParticle[]>([]);
  const nebulasRef = useRef<NebulaBurst[]>([]);
  const signalsRef = useRef<SignalPulse[]>([]);
  const animationRef = useRef<number>(0);
  const timeRef = useRef<number>(0);

  // Rich orange/coral palette with purple accents
  const colors = {
    brightOrange: '#FF5A1F',
    coral: '#FF4E50',
    deepOrange: '#E86C24',
    amber: '#FF7A33',
    darkOrange: '#CC4A15',
    bloodOrange: '#FF6B35',
    crimson: '#DC2626',
    magenta: '#9333EA',
    violet: '#7C3AED',
  };

  const colorArray = [colors.brightOrange, colors.coral, colors.deepOrange, colors.amber, colors.bloodOrange, colors.crimson];
  const glowColors = [colors.amber, colors.coral, colors.magenta, colors.violet];

  // Smooth easing function
  const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;

  // Generate bezier control points for smooth curves
  const generateBezierPath = useCallback((
    start: Vector2,
    end: Vector2,
    curvature: number = 0.3
  ): { cp1: Vector2; cp2: Vector2 } => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // Perpendicular offset for curve
    const perpX = -dy / dist * curvature * dist * (Math.random() - 0.5);
    const perpY = dx / dist * curvature * dist * (Math.random() - 0.5);
    
    return {
      cp1: { x: start.x + dx * 0.3 + perpX, y: start.y + dy * 0.3 + perpY },
      cp2: { x: start.x + dx * 0.7 + perpX * 0.5, y: start.y + dy * 0.7 + perpY * 0.5 }
    };
  }, []);

  // Generate organic branching dendrite
  const generateDendrite = useCallback((
    startX: number,
    startY: number,
    angle: number,
    length: number,
    depth: number,
    parentSwayPhase: number
  ): { segments: DendriteSegment[]; endPos: Vector2 } => {
    const segments: DendriteSegment[] = [];
    let x = startX;
    let y = startY;
    const segmentLength = 8 + Math.random() * 6;
    const segmentCount = Math.floor(length / segmentLength);
    let currentAngle = angle;
    
    for (let i = 0; i < segmentCount; i++) {
      const progress = i / segmentCount;
      
      // Organic curvature - more pronounced at the start, tapering off
      const curveFactor = Math.sin(progress * Math.PI) * 0.15;
      const waveOffset = Math.sin(progress * Math.PI * 2 + parentSwayPhase) * 15 * (1 - progress * 0.5);
      
      // Angle variation - gentle curves
      currentAngle += (Math.random() - 0.5) * 0.2 + curveFactor * (Math.random() - 0.5);
      
      const stepX = Math.cos(currentAngle) * segmentLength;
      const stepY = Math.sin(currentAngle) * segmentLength;
      
      x += stepX + waveOffset * Math.cos(currentAngle + Math.PI / 2) * 0.1;
      y += stepY + waveOffset * Math.sin(currentAngle + Math.PI / 2) * 0.1;
      
      // Thickness tapers organically
      const baseTaper = 1 - Math.pow(progress, 0.7);
      const thickness = Math.max(0.5, (3.5 - depth * 0.8) * baseTaper);
      
      // Each segment has its own sway properties
      const segmentSwayPhase = parentSwayPhase + i * 0.1;
      const swayAmount = 2 + (i / segmentCount) * 6 * (1 + depth * 0.3);
      
      segments.push({
        x,
        y,
        baseX: x,
        baseY: y,
        thickness,
        swayPhase: segmentSwayPhase,
        swayAmount
      });
    }
    
    const lastSeg = segments[segments.length - 1];
    return {
      segments,
      endPos: lastSeg ? { x: lastSeg.x, y: lastSeg.y } : { x: startX, y: startY }
    };
  }, []);

  // Initialize the neural network
  const initNeuralNetwork = useCallback((width: number, height: number) => {
    const neurons: Neuron[] = [];
    const dendrites: Dendrite[] = [];
    const particles: FloatingParticle[] = [];
    const nebulas: NebulaBurst[] = [];

    // Create major neuron clusters positioned around edges
    const clusterPositions = [
      // Left side clusters
      { x: width * 0.02, y: height * 0.15, size: 'large' },
      { x: width * 0.06, y: height * 0.45, size: 'medium' },
      { x: width * 0.04, y: height * 0.75, size: 'large' },
      { x: width * 0.08, y: height * 0.9, size: 'medium' },
      // Right side clusters  
      { x: width * 0.94, y: height * 0.1, size: 'large' },
      { x: width * 0.98, y: height * 0.35, size: 'medium' },
      { x: width * 0.96, y: height * 0.6, size: 'large' },
      { x: width * 0.92, y: height * 0.85, size: 'medium' },
      // Additional corner accents
      { x: width * 0.15, y: height * 0.05, size: 'small' },
      { x: width * 0.85, y: height * 0.95, size: 'small' },
    ];

    // Create neurons at cluster positions
    clusterPositions.forEach((pos, idx) => {
      const sizeMultiplier = pos.size === 'large' ? 1.5 : pos.size === 'medium' ? 1 : 0.7;
      
      neurons.push({
        x: pos.x,
        y: pos.y,
        baseX: pos.x,
        baseY: pos.y,
        radius: (12 + Math.random() * 8) * sizeMultiplier,
        glowIntensity: 0.7 + Math.random() * 0.3,
        pulsePhase: Math.random() * Math.PI * 2,
        pulseSpeed: 0.4 + Math.random() * 0.3,
        swayPhase: Math.random() * Math.PI * 2,
        swaySpeed: 0.3 + Math.random() * 0.2,
        color: colorArray[idx % colorArray.length],
        connections: []
      });

      // Nebula effect at each major neuron
      nebulas.push({
        x: pos.x,
        y: pos.y,
        baseX: pos.x,
        baseY: pos.y,
        radius: (80 + Math.random() * 60) * sizeMultiplier,
        opacity: 0.12 + Math.random() * 0.08,
        color: colorArray[idx % colorArray.length],
        pulsePhase: Math.random() * Math.PI * 2,
        driftPhase: Math.random() * Math.PI * 2
      });
    });

    // Generate dendrites from each neuron
    neurons.forEach((neuron, neuronIdx) => {
      const dendriteCount = 4 + Math.floor(Math.random() * 4);
      
      for (let d = 0; d < dendriteCount; d++) {
        // Calculate angle pointing generally toward screen center
        const centerAngle = Math.atan2(height / 2 - neuron.y, width / 2 - neuron.x);
        const spreadRange = Math.PI * 0.8;
        const baseAngle = centerAngle + (d / dendriteCount - 0.5) * spreadRange + (Math.random() - 0.5) * 0.4;
        
        const primaryLength = 200 + Math.random() * 300;
        const swayPhase = Math.random() * Math.PI * 2;
        
        const { segments, endPos } = generateDendrite(
          neuron.x,
          neuron.y,
          baseAngle,
          primaryLength,
          0,
          swayPhase
        );

        if (segments.length > 0) {
          dendrites.push({
            startNeuronIdx: neuronIdx,
            segments,
            color: colorArray[(neuronIdx + d) % colorArray.length],
            glowColor: glowColors[(neuronIdx + d) % glowColors.length],
            swayPhase,
            swaySpeed: 0.3 + Math.random() * 0.3
          });

          // Add secondary branches
          const branchCount = 2 + Math.floor(Math.random() * 3);
          for (let b = 0; b < branchCount; b++) {
            const branchPoint = Math.floor(segments.length * (0.2 + b * 0.25 + Math.random() * 0.15));
            if (branchPoint < segments.length) {
              const branchSeg = segments[branchPoint];
              const branchAngle = baseAngle + (Math.random() - 0.5) * Math.PI * 0.7;
              const branchLength = 80 + Math.random() * 120;
              
              const { segments: branchSegments, endPos: branchEnd } = generateDendrite(
                branchSeg.baseX,
                branchSeg.baseY,
                branchAngle,
                branchLength,
                1,
                swayPhase + b * 0.5
              );

              if (branchSegments.length > 0) {
                dendrites.push({
                  startNeuronIdx: neuronIdx,
                  segments: branchSegments,
                  color: colorArray[(neuronIdx + d + b) % colorArray.length],
                  glowColor: glowColors[(neuronIdx + d + b) % glowColors.length],
                  swayPhase: swayPhase + b * 0.5,
                  swaySpeed: 0.4 + Math.random() * 0.3
                });

                // Add tiny neurons at branch points
                neurons.push({
                  x: branchSeg.baseX,
                  y: branchSeg.baseY,
                  baseX: branchSeg.baseX,
                  baseY: branchSeg.baseY,
                  radius: 3 + Math.random() * 3,
                  glowIntensity: 0.4 + Math.random() * 0.3,
                  pulsePhase: Math.random() * Math.PI * 2,
                  pulseSpeed: 0.8 + Math.random() * 0.4,
                  swayPhase: swayPhase + b * 0.5,
                  swaySpeed: 0.4 + Math.random() * 0.2,
                  color: colorArray[(neuronIdx + d + b) % colorArray.length],
                  connections: []
                });

                // Tertiary micro-branches
                if (Math.random() > 0.4) {
                  const microBranchCount = 1 + Math.floor(Math.random() * 2);
                  for (let m = 0; m < microBranchCount; m++) {
                    const microPoint = Math.floor(branchSegments.length * (0.3 + Math.random() * 0.4));
                    if (microPoint < branchSegments.length) {
                      const microSeg = branchSegments[microPoint];
                      const microAngle = branchAngle + (Math.random() - 0.5) * Math.PI * 0.8;
                      const microLength = 40 + Math.random() * 60;
                      
                      const { segments: microSegments } = generateDendrite(
                        microSeg.baseX,
                        microSeg.baseY,
                        microAngle,
                        microLength,
                        2,
                        swayPhase + b * 0.5 + m * 0.3
                      );

                      if (microSegments.length > 0) {
                        dendrites.push({
                          startNeuronIdx: neuronIdx,
                          segments: microSegments,
                          color: colorArray[(neuronIdx + d + b + m) % colorArray.length],
                          glowColor: glowColors[(neuronIdx + d + b + m) % glowColors.length],
                          swayPhase: swayPhase + b * 0.5 + m * 0.3,
                          swaySpeed: 0.5 + Math.random() * 0.3
                        });

                        // Tiny terminal neurons
                        const lastMicro = microSegments[microSegments.length - 1];
                        if (lastMicro) {
                          neurons.push({
                            x: lastMicro.baseX,
                            y: lastMicro.baseY,
                            baseX: lastMicro.baseX,
                            baseY: lastMicro.baseY,
                            radius: 1.5 + Math.random() * 2,
                            glowIntensity: 0.3 + Math.random() * 0.2,
                            pulsePhase: Math.random() * Math.PI * 2,
                            pulseSpeed: 1 + Math.random() * 0.5,
                            swayPhase: swayPhase + b * 0.5 + m * 0.3,
                            swaySpeed: 0.5 + Math.random() * 0.2,
                            color: colorArray[(neuronIdx + d + b + m) % colorArray.length],
                            connections: []
                          });
                        }
                      }
                    }
                  }
                }

                // Terminal neuron at branch end
                neurons.push({
                  x: branchEnd.x,
                  y: branchEnd.y,
                  baseX: branchEnd.x,
                  baseY: branchEnd.y,
                  radius: 2 + Math.random() * 2.5,
                  glowIntensity: 0.35 + Math.random() * 0.25,
                  pulsePhase: Math.random() * Math.PI * 2,
                  pulseSpeed: 0.9 + Math.random() * 0.4,
                  swayPhase: swayPhase + b * 0.5,
                  swaySpeed: 0.45 + Math.random() * 0.2,
                  color: colorArray[(neuronIdx + d + b) % colorArray.length],
                  connections: []
                });
              }
            }
          }

          // Terminal neuron at primary dendrite end
          neurons.push({
            x: endPos.x,
            y: endPos.y,
            baseX: endPos.x,
            baseY: endPos.y,
            radius: 3 + Math.random() * 3,
            glowIntensity: 0.4 + Math.random() * 0.3,
            pulsePhase: Math.random() * Math.PI * 2,
            pulseSpeed: 0.7 + Math.random() * 0.4,
            swayPhase,
            swaySpeed: 0.35 + Math.random() * 0.2,
            color: colorArray[(neuronIdx + d) % colorArray.length],
            connections: []
          });
        }
      }
    });

    // Create floating atmospheric particles
    const particleCount = Math.floor((width * height) / 8000);
    for (let i = 0; i < particleCount; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      particles.push({
        x,
        y,
        baseX: x,
        baseY: y,
        radius: 0.5 + Math.random() * 1.5,
        opacity: 0.1 + Math.random() * 0.25,
        driftPhase: Math.random() * Math.PI * 2,
        driftSpeed: 0.2 + Math.random() * 0.3,
        twinklePhase: Math.random() * Math.PI * 2
      });
    }

    // Add more scattered nebulas for atmosphere
    for (let i = 0; i < 8; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      nebulas.push({
        x,
        y,
        baseX: x,
        baseY: y,
        radius: 50 + Math.random() * 80,
        opacity: 0.05 + Math.random() * 0.07,
        color: colorArray[Math.floor(Math.random() * colorArray.length)],
        pulsePhase: Math.random() * Math.PI * 2,
        driftPhase: Math.random() * Math.PI * 2
      });
    }

    neuronsRef.current = neurons;
    dendritesRef.current = dendrites;
    particlesRef.current = particles;
    nebulasRef.current = nebulas;
    signalsRef.current = [];
  }, [generateDendrite, colorArray, glowColors]);

  // Update positions based on sway
  const updateSwayPositions = useCallback((time: number) => {
    // Update neuron positions
    neuronsRef.current.forEach((neuron) => {
      const swayX = Math.sin(time * 0.0008 * neuron.swaySpeed + neuron.swayPhase) * 3;
      const swayY = Math.cos(time * 0.0006 * neuron.swaySpeed + neuron.swayPhase * 1.3) * 2;
      neuron.x = neuron.baseX + swayX;
      neuron.y = neuron.baseY + swayY;
    });

    // Update dendrite segment positions
    dendritesRef.current.forEach((dendrite) => {
      dendrite.segments.forEach((seg, i) => {
        const progressFactor = (i + 1) / dendrite.segments.length;
        const swayMultiplier = easeInOutSine(progressFactor) * seg.swayAmount;
        
        const swayX = Math.sin(time * 0.0007 * dendrite.swaySpeed + seg.swayPhase) * swayMultiplier;
        const swayY = Math.cos(time * 0.0005 * dendrite.swaySpeed + seg.swayPhase * 1.2) * swayMultiplier * 0.7;
        
        seg.x = seg.baseX + swayX;
        seg.y = seg.baseY + swayY;
      });
    });

    // Update particle positions
    particlesRef.current.forEach((particle) => {
      const driftX = Math.sin(time * 0.0003 * particle.driftSpeed + particle.driftPhase) * 8;
      const driftY = Math.cos(time * 0.0002 * particle.driftSpeed + particle.driftPhase * 1.5) * 6;
      particle.x = particle.baseX + driftX;
      particle.y = particle.baseY + driftY;
    });

    // Update nebula positions
    nebulasRef.current.forEach((nebula) => {
      const driftX = Math.sin(time * 0.0002 + nebula.driftPhase) * 5;
      const driftY = Math.cos(time * 0.00015 + nebula.driftPhase * 1.3) * 4;
      nebula.x = nebula.baseX + driftX;
      nebula.y = nebula.baseY + driftY;
    });

    // Spawn occasional signal pulses
    if (Math.random() < 0.02 && dendritesRef.current.length > 0) {
      const dendriteIdx = Math.floor(Math.random() * dendritesRef.current.length);
      signalsRef.current.push({
        dendriteIdx,
        progress: 0,
        speed: 0.008 + Math.random() * 0.012,
        intensity: 0.6 + Math.random() * 0.4
      });
    }

    // Update signal positions and remove completed ones
    signalsRef.current = signalsRef.current.filter((signal) => {
      signal.progress += signal.speed;
      return signal.progress < 1;
    });
  }, [easeInOutSine]);

  // Draw nebula effect
  const drawNebula = useCallback((ctx: CanvasRenderingContext2D, nebula: NebulaBurst, time: number) => {
    const pulse = Math.sin(time * 0.0008 + nebula.pulsePhase) * 0.25 + 0.75;
    const radius = nebula.radius * pulse;
    
    const gradient = ctx.createRadialGradient(
      nebula.x, nebula.y, 0,
      nebula.x, nebula.y, radius
    );
    
    // Parse hex color to RGB
    const hex = nebula.color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${nebula.opacity * pulse})`);
    gradient.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, ${nebula.opacity * 0.4 * pulse})`);
    gradient.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, ${nebula.opacity * 0.15 * pulse})`);
    gradient.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(nebula.x, nebula.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  }, []);

  // Draw floating particles
  const drawParticles = useCallback((ctx: CanvasRenderingContext2D, time: number) => {
    particlesRef.current.forEach((particle) => {
      const twinkle = Math.sin(time * 0.003 + particle.twinklePhase) * 0.3 + 0.7;
      const opacity = particle.opacity * twinkle;
      
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 120, 50, ${opacity})`;
      ctx.fill();
      
      // Soft glow
      if (particle.radius > 1) {
        const glowGradient = ctx.createRadialGradient(
          particle.x, particle.y, 0,
          particle.x, particle.y, particle.radius * 3
        );
        glowGradient.addColorStop(0, `rgba(255, 90, 31, ${opacity * 0.5})`);
        glowGradient.addColorStop(1, 'transparent');
        
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.radius * 3, 0, Math.PI * 2);
        ctx.fillStyle = glowGradient;
        ctx.fill();
      }
    });
  }, []);

  // Draw dendrite with smooth bezier curves and glow
  const drawDendrite = useCallback((ctx: CanvasRenderingContext2D, dendrite: Dendrite, neuron: Neuron, time: number) => {
    if (dendrite.segments.length < 2) return;

    const segments = dendrite.segments;
    
    // Draw glow layer
    ctx.save();
    ctx.shadowColor = dendrite.glowColor;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = dendrite.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.6;

    // Draw as smooth quadratic bezier curves
    ctx.beginPath();
    ctx.moveTo(neuron.x, neuron.y);
    
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const prevSeg = i > 0 ? segments[i - 1] : { x: neuron.x, y: neuron.y };
      
      // Use quadratic curve for smoothness
      const cpX = (prevSeg.x + seg.x) / 2;
      const cpY = (prevSeg.y + seg.y) / 2;
      
      if (i === 0) {
        ctx.quadraticCurveTo(neuron.x, neuron.y, cpX, cpY);
      } else {
        ctx.lineTo(seg.x, seg.y);
      }
      
      ctx.lineWidth = seg.thickness + 3;
    }
    ctx.stroke();
    ctx.restore();

    // Draw core line with gradient
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Create gradient along the path
    const startSeg = segments[0];
    const endSeg = segments[segments.length - 1];
    const lineGradient = ctx.createLinearGradient(neuron.x, neuron.y, endSeg.x, endSeg.y);
    lineGradient.addColorStop(0, dendrite.color);
    lineGradient.addColorStop(0.5, dendrite.glowColor);
    lineGradient.addColorStop(1, dendrite.color);
    
    ctx.strokeStyle = lineGradient;
    ctx.beginPath();
    ctx.moveTo(neuron.x, neuron.y);
    
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      ctx.lineTo(seg.x, seg.y);
      ctx.lineWidth = seg.thickness;
    }
    ctx.stroke();
  }, []);

  // Draw signal pulse traveling along dendrite
  const drawSignalPulse = useCallback((ctx: CanvasRenderingContext2D, signal: SignalPulse) => {
    const dendrite = dendritesRef.current[signal.dendriteIdx];
    if (!dendrite || dendrite.segments.length < 2) return;

    const neuron = neuronsRef.current[dendrite.startNeuronIdx];
    if (!neuron) return;

    const segmentIdx = Math.floor(signal.progress * dendrite.segments.length);
    if (segmentIdx >= dendrite.segments.length) return;

    const seg = dendrite.segments[segmentIdx];
    const prevSeg = segmentIdx > 0 ? dendrite.segments[segmentIdx - 1] : { x: neuron.x, y: neuron.y };
    
    const localProgress = (signal.progress * dendrite.segments.length) % 1;
    const x = prevSeg.x + (seg.x - prevSeg.x) * localProgress;
    const y = prevSeg.y + (seg.y - prevSeg.y) * localProgress;

    const pulseRadius = 4 + seg.thickness;
    const fadeIn = Math.min(1, signal.progress * 5);
    const fadeOut = Math.min(1, (1 - signal.progress) * 5);
    const alpha = fadeIn * fadeOut * signal.intensity;

    // Bright pulse glow
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, pulseRadius * 3);
    gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    gradient.addColorStop(0.3, `rgba(255, 150, 50, ${alpha * 0.7})`);
    gradient.addColorStop(0.6, `rgba(255, 90, 31, ${alpha * 0.3})`);
    gradient.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(x, y, pulseRadius * 3, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Bright center
    ctx.beginPath();
    ctx.arc(x, y, pulseRadius * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.fill();
  }, []);

  // Draw neuron node with enhanced glow
  const drawNeuron = useCallback((ctx: CanvasRenderingContext2D, neuron: Neuron, time: number) => {
    const pulse = Math.sin(time * 0.0015 * neuron.pulseSpeed + neuron.pulsePhase) * 0.25 + 0.75;
    const glowRadius = neuron.radius * 4 * pulse;
    
    // Parse hex color
    const hex = neuron.color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    
    // Outer atmospheric glow
    const outerGlow = ctx.createRadialGradient(
      neuron.x, neuron.y, 0,
      neuron.x, neuron.y, glowRadius * 1.5
    );
    outerGlow.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${neuron.glowIntensity * 0.4 * pulse})`);
    outerGlow.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${neuron.glowIntensity * 0.15 * pulse})`);
    outerGlow.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(neuron.x, neuron.y, glowRadius * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = outerGlow;
    ctx.fill();

    // Main glow
    const mainGlow = ctx.createRadialGradient(
      neuron.x, neuron.y, 0,
      neuron.x, neuron.y, glowRadius
    );
    mainGlow.addColorStop(0, `rgba(255, 200, 150, ${neuron.glowIntensity * pulse})`);
    mainGlow.addColorStop(0.2, `rgba(${r}, ${g}, ${b}, ${neuron.glowIntensity * 0.8 * pulse})`);
    mainGlow.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${neuron.glowIntensity * 0.4 * pulse})`);
    mainGlow.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(neuron.x, neuron.y, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = mainGlow;
    ctx.fill();

    // Core with bright center
    const coreGradient = ctx.createRadialGradient(
      neuron.x - neuron.radius * 0.2, neuron.y - neuron.radius * 0.2, 0,
      neuron.x, neuron.y, neuron.radius * pulse
    );
    coreGradient.addColorStop(0, '#FFFFFF');
    coreGradient.addColorStop(0.15, '#FFF5E6');
    coreGradient.addColorStop(0.4, `rgb(${Math.min(255, r + 50)}, ${Math.min(255, g + 30)}, ${b})`);
    coreGradient.addColorStop(0.7, neuron.color);
    coreGradient.addColorStop(1, `rgb(${Math.floor(r * 0.7)}, ${Math.floor(g * 0.7)}, ${Math.floor(b * 0.7)})`);

    ctx.beginPath();
    ctx.arc(neuron.x, neuron.y, neuron.radius * pulse, 0, Math.PI * 2);
    ctx.fillStyle = coreGradient;
    ctx.fill();
  }, []);

  // Main animation loop
  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    timeRef.current += 16.67; // ~60fps

    // Update all swaying positions
    updateSwayPositions(timeRef.current);

    // Clear with dark background
    ctx.fillStyle = '#08080C';
    ctx.fillRect(0, 0, width, height);

    // Draw nebula bursts (background layer)
    nebulasRef.current.forEach((nebula) => {
      drawNebula(ctx, nebula, timeRef.current);
    });

    // Draw floating particles
    drawParticles(ctx, timeRef.current);

    // Draw dendrites
    dendritesRef.current.forEach((dendrite) => {
      const neuron = neuronsRef.current[dendrite.startNeuronIdx];
      if (neuron) {
        drawDendrite(ctx, dendrite, neuron, timeRef.current);
      }
    });

    // Draw signal pulses
    signalsRef.current.forEach((signal) => {
      drawSignalPulse(ctx, signal);
    });

    // Draw neurons on top
    neuronsRef.current.forEach((neuron) => {
      drawNeuron(ctx, neuron, timeRef.current);
    });

    animationRef.current = requestAnimationFrame(animate);
  }, [updateSwayPositions, drawNebula, drawParticles, drawDendrite, drawSignalPulse, drawNeuron]);

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
