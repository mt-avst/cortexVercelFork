import React, { useEffect, useRef, memo, useCallback } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  connections: number[];
}

/**
 * NeuralParticleField Component
 * 
 * Creates a slow-moving neural network visualization with:
 * - Red/orange particles with subtle glow
 * - Dynamic connection lines between nearby particles
 * - Cinematic, atmospheric effect
 */
const NeuralParticleField: React.FC = memo(() => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationRef = useRef<number>(0);
  const mouseRef = useRef({ x: 0, y: 0 });

  const colors = [
    'rgba(255, 78, 80, 0.8)',    // Coral red
    'rgba(255, 122, 51, 0.8)',   // Blood orange
    'rgba(139, 92, 246, 0.6)',   // Electric violet
    'rgba(255, 90, 31, 0.7)',    // Deep orange
  ];

  const initParticles = useCallback((width: number, height: number) => {
    const particleCount = Math.min(80, Math.floor((width * height) / 15000));
    const particles: Particle[] = [];

    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        radius: Math.random() * 2 + 1,
        color: colors[Math.floor(Math.random() * colors.length)],
        connections: [],
      });
    }

    particlesRef.current = particles;
  }, []);

  const drawParticle = useCallback((ctx: CanvasRenderingContext2D, particle: Particle) => {
    // Outer glow
    const gradient = ctx.createRadialGradient(
      particle.x, particle.y, 0,
      particle.x, particle.y, particle.radius * 4
    );
    gradient.addColorStop(0, particle.color);
    gradient.addColorStop(0.5, particle.color.replace('0.8', '0.2').replace('0.6', '0.15').replace('0.7', '0.17'));
    gradient.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius * 4, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Core
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    ctx.fillStyle = particle.color;
    ctx.fill();
  }, []);

  const drawConnections = useCallback((ctx: CanvasRenderingContext2D, particles: Particle[]) => {
    const connectionDistance = 150;
    
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < connectionDistance) {
          const opacity = (1 - distance / connectionDistance) * 0.3;
          
          // Create gradient line
          const gradient = ctx.createLinearGradient(
            particles[i].x, particles[i].y,
            particles[j].x, particles[j].y
          );
          gradient.addColorStop(0, `rgba(255, 78, 80, ${opacity})`);
          gradient.addColorStop(0.5, `rgba(139, 92, 246, ${opacity * 0.7})`);
          gradient.addColorStop(1, `rgba(255, 122, 51, ${opacity})`);

          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = gradient;
          ctx.lineWidth = opacity * 2;
          ctx.stroke();
        }
      }
    }
  }, []);

  const updateParticles = useCallback((width: number, height: number) => {
    const particles = particlesRef.current;
    
    particles.forEach((particle) => {
      // Apply slight attraction to mouse
      const dx = mouseRef.current.x - particle.x;
      const dy = mouseRef.current.y - particle.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < 200 && distance > 0) {
        const force = 0.00005;
        particle.vx += (dx / distance) * force;
        particle.vy += (dy / distance) * force;
      }

      // Update position
      particle.x += particle.vx;
      particle.y += particle.vy;

      // Boundary wrapping
      if (particle.x < 0) particle.x = width;
      if (particle.x > width) particle.x = 0;
      if (particle.y < 0) particle.y = height;
      if (particle.y > height) particle.y = 0;

      // Damping
      particle.vx *= 0.999;
      particle.vy *= 0.999;

      // Random drift
      particle.vx += (Math.random() - 0.5) * 0.01;
      particle.vy += (Math.random() - 0.5) * 0.01;

      // Speed limit
      const speed = Math.sqrt(particle.vx * particle.vx + particle.vy * particle.vy);
      if (speed > 0.5) {
        particle.vx = (particle.vx / speed) * 0.5;
        particle.vy = (particle.vy / speed) * 0.5;
      }
    });
  }, []);

  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear with almost-black background
    ctx.fillStyle = 'rgba(8, 8, 12, 0.15)';
    ctx.fillRect(0, 0, width, height);

    updateParticles(width, height);
    drawConnections(ctx, particlesRef.current);
    
    particlesRef.current.forEach((particle) => {
      drawParticle(ctx, particle);
    });

    animationRef.current = requestAnimationFrame(animate);
  }, [updateParticles, drawConnections, drawParticle]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      initParticles(canvas.width, canvas.height);
    };

    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    window.addEventListener('mousemove', handleMouseMove);

    // Start animation
    animate();

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [initParticles, animate]);

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

