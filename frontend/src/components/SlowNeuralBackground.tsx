import React, { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';

// ============================================================================
// Configuration - "Neural Deep" ambient background
// Further dimmed (50%) and slowed (50%) for distraction-free dark mode
// ============================================================================

const CONFIG = {
  // Volumetric cloud topology - full screen random distribution
  nodeCount: 350, // Reduced for subtler effect
  innerRadius: 28,
  outerRadius: 55,
  
  // Node sizing - smaller for ambient feel
  hotspotPercentage: 0.03,
  hotspotScale: { min: 0.08, max: 0.18 },
  nodeScale: { min: 0.02, max: 0.05 },
  
  // Sparse connections for cleaner look
  connectionThreshold: 12,
  maxConnectionsPerNode: 4,
  
  // Signal packets - very subtle
  signalCount: 15, // Fewer signals
  signalSpeed: 0.003, // 75% slower than original (25% speed)
  
  // Animation - very slow, ambient wallpaper feel
  rotationSpeed: 0.003, // 25% of original speed
  breatheSpeed: 0.045,  // 25% of original speed
  breatheAmount: 0.25,
  
  // Camera
  cameraZ: 70,
};

// ============================================================================
// Fire Color Palette (NO PURPLE)
// ============================================================================

const COLORS = {
  // Primary glow
  safetyOrange: new THREE.Color('#FF5500'),
  fireOrange: new THREE.Color('#FF6B00'),
  
  // Core hotspots
  whiteYellow: new THREE.Color('#FFDD00'),
  hotYellow: new THREE.Color('#FFAA00'),
  
  // Deep connections
  darkRed: new THREE.Color('#8B0000'),
  rust: new THREE.Color('#A52A2A'),
  bloodOrange: new THREE.Color('#CC3300'),
  
  // Signal packets
  signalWhite: new THREE.Color('#FFFFFF'),
  signalYellow: new THREE.Color('#FFEE88'),
};

// Ember particle colors - amber/gold hue, NO white stars
const getNodeColorHSL = (): THREE.Color => {
  const color = new THREE.Color();
  
  // Hue: strict amber/gold (0.08)
  const hue = 0.07 + Math.random() * 0.02;
  
  // Saturation: high for warm glow
  const saturation = 0.9 + Math.random() * 0.1;
  
  // Lightness: capped at 0.6 - glowing embers, not white stars
  const rand = Math.random();
  let lightness: number;
  
  if (rand < 0.55) {
    lightness = 0.1 + Math.random() * 0.1;
  } else if (rand < 0.85) {
    lightness = 0.25 + Math.random() * 0.15;
  } else {
    lightness = 0.45 + Math.random() * 0.15;
  }
  
  color.setHSL(hue, saturation, lightness);
  return color;
};

// ============================================================================
// Simplex-like 3D Noise
// ============================================================================

const noise3D = (x: number, y: number, z: number, seed: number = 0): number => {
  const n = Math.sin(x * 1.2 + seed) * Math.cos(y * 0.9 + seed * 0.7) * Math.sin(z * 1.1 + seed * 0.3);
  const m = Math.cos(x * 0.8 + y * 0.6 + z * 0.4 + seed);
  return (n + m) * 0.5;
};

// ============================================================================
// Volumetric Cloud Node Generation
// ============================================================================

interface NodeData {
  positions: Float32Array;
  basePositions: Float32Array;
  colors: Float32Array;
  scales: Float32Array;
  isHotspot: boolean[];
  noiseSeeds: Float32Array;
}

const generateVolumetricNodes = (count: number): NodeData => {
  const positions = new Float32Array(count * 3);
  const basePositions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const isHotspot: boolean[] = [];
  const noiseSeeds = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    
    const t = Math.random();
    const radius = CONFIG.innerRadius + t * (CONFIG.outerRadius - CONFIG.innerRadius);
    
    const noiseScale = 0.08;
    const noiseSeed = Math.random() * 100;
    noiseSeeds[i] = noiseSeed;
    
    const baseX = radius * Math.sin(phi) * Math.cos(theta);
    const baseY = radius * Math.sin(phi) * Math.sin(theta);
    const baseZ = radius * Math.cos(phi);
    
    const noiseOffset = noise3D(baseX * noiseScale, baseY * noiseScale, baseZ * noiseScale, noiseSeed) * 8;
    
    const x = baseX + noiseOffset * Math.sin(theta);
    const y = baseY + noiseOffset * Math.cos(phi);
    const z = baseZ + noiseOffset * Math.sin(phi);

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    
    basePositions[i * 3] = x;
    basePositions[i * 3 + 1] = y;
    basePositions[i * 3 + 2] = z;

    const hotspot = Math.random() < CONFIG.hotspotPercentage;
    isHotspot.push(hotspot);

    if (hotspot) {
      scales[i] = CONFIG.hotspotScale.min + Math.random() * (CONFIG.hotspotScale.max - CONFIG.hotspotScale.min);
    } else {
      scales[i] = CONFIG.nodeScale.min + Math.random() * (CONFIG.nodeScale.max - CONFIG.nodeScale.min);
    }

    let color: THREE.Color;
    if (hotspot) {
      color = new THREE.Color();
      color.setHSL(0.08, 1.0, 0.5 + Math.random() * 0.1);
    } else {
      color = getNodeColorHSL();
    }
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  return { positions, basePositions, colors, scales, isHotspot, noiseSeeds };
};

// ============================================================================
// Dense Connections with Distance Fade
// ============================================================================

interface ConnectionData {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

const generateConnections = (nodeData: NodeData): ConnectionData => {
  const { positions: nodePositions, colors: nodeColors, isHotspot } = nodeData;
  const nodeCount = nodePositions.length / 3;
  
  const linePositions: number[] = [];
  const lineColors: number[] = [];
  const connectionIndices: number[] = [];
  
  const connectionCounts = new Array(nodeCount).fill(0);

  for (let i = 0; i < nodeCount; i++) {
    const x1 = nodePositions[i * 3];
    const y1 = nodePositions[i * 3 + 1];
    const z1 = nodePositions[i * 3 + 2];
    
    const distFromCenter1 = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1);

    const maxConns = isHotspot[i] ? CONFIG.maxConnectionsPerNode + 4 : CONFIG.maxConnectionsPerNode;

    for (let j = i + 1; j < nodeCount; j++) {
      if (connectionCounts[i] >= maxConns) break;
      
      const jMaxConns = isHotspot[j] ? CONFIG.maxConnectionsPerNode + 4 : CONFIG.maxConnectionsPerNode;
      if (connectionCounts[j] >= jMaxConns) continue;

      const x2 = nodePositions[j * 3];
      const y2 = nodePositions[j * 3 + 1];
      const z2 = nodePositions[j * 3 + 2];

      const dx = x2 - x1;
      const dy = y2 - y1;
      const dz = z2 - z1;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const threshold = (isHotspot[i] || isHotspot[j]) 
        ? CONFIG.connectionThreshold * 1.4 
        : CONFIG.connectionThreshold;

      if (dist < threshold) {
        linePositions.push(x1, y1, z1, x2, y2, z2);
        
        connectionIndices.push(i, j);

        const distFromCenter2 = Math.sqrt(x2 * x2 + y2 * y2 + z2 * z2);
        const avgDist = (distFromCenter1 + distFromCenter2) / 2;
        const fadeFactor = Math.max(0.3, 1 - (avgDist - CONFIG.innerRadius) / (CONFIG.outerRadius - CONFIG.innerRadius) * 0.7);

        const c1r = nodeColors[i * 3] * fadeFactor;
        const c1g = nodeColors[i * 3 + 1] * fadeFactor;
        const c1b = nodeColors[i * 3 + 2] * fadeFactor;
        const c2r = nodeColors[j * 3] * fadeFactor;
        const c2g = nodeColors[j * 3 + 1] * fadeFactor;
        const c2b = nodeColors[j * 3 + 2] * fadeFactor;

        lineColors.push(c1r, c1g, c1b, c2r, c2g, c2b);

        connectionCounts[i]++;
        connectionCounts[j]++;
      }
    }
  }

  return {
    positions: new Float32Array(linePositions),
    colors: new Float32Array(lineColors),
    indices: new Uint32Array(connectionIndices),
  };
};

// ============================================================================
// Animated Nodes with Breathing
// ============================================================================

interface NodesProps {
  nodeData: NodeData;
}

const Nodes: React.FC<NodesProps> = ({ nodeData }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useMemo(() => {
    if (!meshRef.current) return;

    const { positions, colors, scales } = nodeData;
    const count = positions.length / 3;

    for (let i = 0; i < count; i++) {
      dummy.position.set(
        positions[i * 3],
        positions[i * 3 + 1],
        positions[i * 3 + 2]
      );
      dummy.scale.setScalar(scales[i]);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);

      const color = new THREE.Color(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
      meshRef.current.setColorAt(i, color);
    }

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  }, [nodeData, dummy]);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    
    const time = clock.getElapsedTime();
    const { basePositions, scales, noiseSeeds } = nodeData;
    const count = basePositions.length / 3;

    for (let i = 0; i < count; i++) {
      const seed = noiseSeeds[i];
      const breathe = Math.sin(time * CONFIG.breatheSpeed + seed) * CONFIG.breatheAmount;
      
      const bx = basePositions[i * 3];
      const by = basePositions[i * 3 + 1];
      const bz = basePositions[i * 3 + 2];
      
      const dist = Math.sqrt(bx * bx + by * by + bz * bz);
      const nx = bx / dist;
      const ny = by / dist;
      const nz = bz / dist;

      dummy.position.set(
        bx + nx * breathe,
        by + ny * breathe,
        bz + nz * breathe
      );
      dummy.scale.setScalar(scales[i] * (1 + Math.sin(time * 2 + seed) * 0.1));
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    }

    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  const count = nodeData.positions.length / 3;

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial toneMapped={false} transparent opacity={0.25} />
    </instancedMesh>
  );
};

// ============================================================================
// Connections with Additive Blending
// ============================================================================

interface ConnectionsProps {
  connectionData: ConnectionData;
}

const Connections: React.FC<ConnectionsProps> = ({ connectionData }) => {
  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(connectionData.positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(connectionData.colors, 3));
    return geom;
  }, [connectionData]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial 
        vertexColors 
        transparent 
        opacity={0.1}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </lineSegments>
  );
};

// ============================================================================
// Signal Packets (Data Transmission Effect)
// ============================================================================

interface SignalPacketsProps {
  connectionData: ConnectionData;
  nodeData: NodeData;
}

const SignalPackets: React.FC<SignalPacketsProps> = ({ connectionData, nodeData }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  
  const signalState = useRef<{ connIdx: number; progress: number; speed: number }[]>([]);
  
  useMemo(() => {
    const connectionCount = connectionData.indices.length / 2;
    signalState.current = [];
    
    for (let i = 0; i < CONFIG.signalCount; i++) {
      signalState.current.push({
        connIdx: Math.floor(Math.random() * connectionCount),
        progress: Math.random(),
        speed: CONFIG.signalSpeed * (0.7 + Math.random() * 0.6),
      });
    }
  }, [connectionData]);

  useFrame(() => {
    if (!meshRef.current) return;
    
    const { positions: nodePositions } = nodeData;
    const { indices } = connectionData;
    const connectionCount = indices.length / 2;

    signalState.current.forEach((signal, i) => {
      signal.progress += signal.speed;
      
      if (signal.progress >= 1) {
        signal.connIdx = Math.floor(Math.random() * connectionCount);
        signal.progress = 0;
        signal.speed = CONFIG.signalSpeed * (0.7 + Math.random() * 0.6);
      }

      const nodeA = indices[signal.connIdx * 2];
      const nodeB = indices[signal.connIdx * 2 + 1];
      
      const x1 = nodePositions[nodeA * 3];
      const y1 = nodePositions[nodeA * 3 + 1];
      const z1 = nodePositions[nodeA * 3 + 2];
      const x2 = nodePositions[nodeB * 3];
      const y2 = nodePositions[nodeB * 3 + 1];
      const z2 = nodePositions[nodeB * 3 + 2];

      const t = signal.progress;
      dummy.position.set(
        x1 + (x2 - x1) * t,
        y1 + (y2 - y1) * t,
        z1 + (z2 - z1) * t
      );
      
      const pulseScale = 0.18 + Math.sin(t * Math.PI) * 0.1;
      dummy.scale.setScalar(pulseScale);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
    });

    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, CONFIG.signalCount]}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial 
        color={COLORS.hotYellow} 
        toneMapped={false}
        transparent
        opacity={0.45}
      />
    </instancedMesh>
  );
};

// ============================================================================
// Neural Cloud (Main Scene)
// ============================================================================

const NeuralCloud: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);

  const { nodeData, connectionData } = useMemo(() => {
    const nodeData = generateVolumetricNodes(CONFIG.nodeCount);
    const connectionData = generateConnections(nodeData);
    return { nodeData, connectionData };
  }, []);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      const time = clock.getElapsedTime();
      groupRef.current.rotation.y = time * CONFIG.rotationSpeed;
      groupRef.current.rotation.x = Math.sin(time * 0.04) * 0.08;
    }
  });

  return (
    <group ref={groupRef}>
      <Nodes nodeData={nodeData} />
      <Connections connectionData={connectionData} />
      <SignalPackets connectionData={connectionData} nodeData={nodeData} />
    </group>
  );
};

// ============================================================================
// Ambient Glow Particles
// ============================================================================

const AmbientGlow: React.FC = () => {
  const pointsRef = useRef<THREE.Points>(null);

  const geometry = useMemo(() => {
    const count = 150;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 60 + Math.random() * 40;

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);

      const brightness = 0.15 + Math.random() * 0.25;
      colors[i * 3] = brightness * 1.5;
      colors[i * 3 + 1] = brightness * 0.6;
      colors[i * 3 + 2] = brightness * 0.1;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geom;
  }, []);

  useFrame(({ clock }) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y = clock.getElapsedTime() * 0.0025; // 50% slower
    }
  });

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial
        size={1}
        vertexColors
        transparent
        opacity={0.2}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
};

// ============================================================================
// Main Component - Slow Neural Background for Study Listing
// ============================================================================

const SlowNeuralBackground: React.FC = () => {
  return (
    <div 
      className="slow-neural-background"
      style={{ 
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        background: '#030305',
        pointerEvents: 'none',
      }}
    >
      {/* Subtle vignette - very light edge darkening for depth */}
      <div 
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 10,
          background: 'radial-gradient(circle at center, transparent 60%, rgba(3,3,5,0.3) 85%, rgba(3,3,5,0.5) 100%)',
        }}
      />
      <Canvas
        camera={{ 
          position: [0, 0, CONFIG.cameraZ], 
          fov: 60,
          near: 0.1,
          far: 300,
        }}
        dpr={[1, 1.5]}
        gl={{ 
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
        }}
      >
        <color attach="background" args={['#030305']} />

        <AmbientGlow />
        <NeuralCloud />

        <EffectComposer>
          <Bloom
            intensity={0.9}
            luminanceThreshold={0.2}
            luminanceSmoothing={0.9}
            radius={0.6}
            mipmapBlur
          />
        </EffectComposer>
      </Canvas>
    </div>
  );
};

export default SlowNeuralBackground;

