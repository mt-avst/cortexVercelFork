import React, { useMemo } from 'react';

interface SparklineProps {
  data?: number[] | null;
  height?: number;
  className?: string;
}

const Sparkline: React.FC<SparklineProps> = ({ 
  data = [], 
  height = 60,
  className = '' 
}) => {
  // 1. Handle Empty/Zero Data with a "Heartbeat" fallback
  const finalData = useMemo(() => {
    if (!data || data.length === 0 || data.every(n => n === 0)) {
      return [5, 20, 10, 40, 25, 60, 45]; // Fake "alive" pattern
    }
    return data;
  }, [data]);

  const width = 100;
  const svgHeight = 50;
  const max = Math.max(...finalData, 1); // Avoid divide by zero

  // 2. Coordinate Conversion
  const points = useMemo(() => {
    return finalData.map((val, i) => {
      const x = (i / (finalData.length - 1)) * width;
      const y = svgHeight - (val / max) * svgHeight * 0.9; // 90% height to leave padding
      return { x, y };
    });
  }, [finalData, max]);

  // 3. Create Path Commands
  const linePath = useMemo(() => {
    return points.map((p, i) => (i === 0 ? `M ${p.x},${p.y}` : `L ${p.x},${p.y}`)).join(' ');
  }, [points]);

  const areaPath = useMemo(() => {
    return `${linePath} L ${width},${svgHeight} L 0,${svgHeight} Z`;
  }, [linePath]);

  // Unique gradient ID
  const gradientId = useMemo(
    () => `sparkline-area-${Math.random().toString(36).substr(2, 9)}`,
    []
  );

  return (
    <div 
      className={className}
      style={{ 
        width: '100%', 
        height: `${height}px`, 
        overflow: 'hidden' 
      }}
    >
      <svg 
        viewBox={`0 0 ${width} ${svgHeight}`} 
        preserveAspectRatio="none" 
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FF7A33" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#FF7A33" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* The Area Fill */}
        <path 
          d={areaPath} 
          fill={`url(#${gradientId})`} 
          stroke="none" 
        />
        {/* The Stroke Line */}
        <path 
          d={linePath} 
          fill="none" 
          stroke="#FF7A33" 
          strokeWidth="2" 
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke" 
        />
        {/* End marker dot */}
        <circle
          cx={points[points.length - 1]?.x || 0}
          cy={points[points.length - 1]?.y || 0}
          r="3"
          fill="#FF7A33"
          stroke="rgba(15, 15, 18, 0.8)"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
};

export default Sparkline;
