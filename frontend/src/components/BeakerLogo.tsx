import React, { memo } from 'react';

/**
 * BeakerLogo Component
 * 
 * A large animated beaker with neurons/neural connections inside
 * featuring bubbling liquid animation in electric violet and blood-orange.
 */
const BeakerLogo: React.FC = memo(() => {
  return (
    <div className="beaker-logo-container" aria-hidden="true">
      <svg 
        viewBox="0 0 200 280" 
        className="beaker-logo-svg"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Liquid gradient - Adaptavist orange palette */}
          <linearGradient id="liquidGradient" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#CC4A15" stopOpacity="0.95" />
            <stop offset="40%" stopColor="#FF5A1F" stopOpacity="0.85" />
            <stop offset="70%" stopColor="#FF7A33" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#FFAA66" stopOpacity="0.5" />
          </linearGradient>
          
          {/* Glow filter */}
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          
          {/* Bubble glow */}
          <filter id="bubbleGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>

          {/* Neural glow */}
          <filter id="neuralGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="glow"/>
            <feMerge>
              <feMergeNode in="glow"/>
              <feMergeNode in="glow"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>

          {/* Clip path for liquid */}
          <clipPath id="beakerClip">
            <path d="M55 80 L55 220 Q55 250 80 260 L120 260 Q145 250 145 220 L145 80 Z" />
          </clipPath>
        </defs>

        {/* Beaker body - glass effect */}
        <g className="beaker-glass">
          {/* Outer beaker shape */}
          <path 
            d="M50 75 L50 220 Q50 255 85 265 L115 265 Q150 255 150 220 L150 75" 
            fill="none" 
            stroke="rgba(255, 255, 255, 0.3)"
            strokeWidth="3"
            strokeLinecap="round"
          />
          
          {/* Beaker neck */}
          <path 
            d="M60 75 L60 50 L140 50 L140 75" 
            fill="none" 
            stroke="rgba(255, 255, 255, 0.25)"
            strokeWidth="2"
          />
          
          {/* Top rim */}
          <ellipse cx="100" cy="50" rx="42" ry="5" fill="none" stroke="rgba(255, 255, 255, 0.35)" strokeWidth="2" />
        </g>

        {/* Animated liquid */}
        <g clipPath="url(#beakerClip)">
          {/* Liquid base */}
          <rect 
            x="55" y="120" width="90" height="150" 
            fill="url(#liquidGradient)"
            className="liquid-body"
          />
          
          {/* Liquid surface wave */}
          <path 
            className="liquid-wave"
            d="M55 120 Q75 115 100 120 T145 120 L145 270 L55 270 Z"
            fill="url(#liquidGradient)"
          />
          
          {/* Bubbles */}
          <g className="bubbles-container">
            <circle className="bubble bubble-1" cx="70" cy="220" r="4" fill="rgba(255, 255, 255, 0.6)" filter="url(#bubbleGlow)" />
            <circle className="bubble bubble-2" cx="90" cy="240" r="3" fill="rgba(255, 255, 255, 0.5)" filter="url(#bubbleGlow)" />
            <circle className="bubble bubble-3" cx="110" cy="230" r="5" fill="rgba(255, 255, 255, 0.4)" filter="url(#bubbleGlow)" />
            <circle className="bubble bubble-4" cx="130" cy="250" r="3" fill="rgba(255, 255, 255, 0.5)" filter="url(#bubbleGlow)" />
            <circle className="bubble bubble-5" cx="80" cy="200" r="4" fill="rgba(255, 255, 255, 0.6)" filter="url(#bubbleGlow)" />
            <circle className="bubble bubble-6" cx="120" cy="210" r="3" fill="rgba(255, 255, 255, 0.5)" filter="url(#bubbleGlow)" />
            <circle className="bubble bubble-7" cx="100" cy="245" r="2" fill="rgba(255, 255, 255, 0.4)" filter="url(#bubbleGlow)" />
            <circle className="bubble bubble-8" cx="75" cy="235" r="3" fill="rgba(255, 255, 255, 0.5)" filter="url(#bubbleGlow)" />
          </g>
        </g>

        {/* Neural network inside beaker - orange palette */}
        <g className="neural-network" filter="url(#neuralGlow)">
          {/* Neural connections */}
          <line className="neural-connection nc-1" x1="75" y1="160" x2="100" y2="140" stroke="#FF5A1F" strokeWidth="1.5" opacity="0.7" />
          <line className="neural-connection nc-2" x1="100" y1="140" x2="125" y2="155" stroke="#FF7A33" strokeWidth="1.5" opacity="0.7" />
          <line className="neural-connection nc-3" x1="100" y1="140" x2="85" y2="180" stroke="#FF4E50" strokeWidth="1.5" opacity="0.6" />
          <line className="neural-connection nc-4" x1="125" y1="155" x2="110" y2="190" stroke="#E86C24" strokeWidth="1.5" opacity="0.7" />
          <line className="neural-connection nc-5" x1="85" y1="180" x2="110" y2="190" stroke="#FF5A1F" strokeWidth="1.5" opacity="0.6" />
          <line className="neural-connection nc-6" x1="75" y1="160" x2="65" y2="195" stroke="#CC4A15" strokeWidth="1" opacity="0.5" />
          <line className="neural-connection nc-7" x1="65" y1="195" x2="85" y2="180" stroke="#FF7A45" strokeWidth="1" opacity="0.5" />
          <line className="neural-connection nc-8" x1="125" y1="155" x2="135" y2="185" stroke="#FF6B35" strokeWidth="1" opacity="0.5" />
          
          {/* Neural nodes */}
          <circle className="neural-node nn-1" cx="75" cy="160" r="6" fill="#FF5A1F" />
          <circle className="neural-node nn-2" cx="100" cy="140" r="8" fill="#FF4E50" />
          <circle className="neural-node nn-3" cx="125" cy="155" r="6" fill="#FF7A33" />
          <circle className="neural-node nn-4" cx="85" cy="180" r="5" fill="#FF7A45" />
          <circle className="neural-node nn-5" cx="110" cy="190" r="7" fill="#E86C24" />
          <circle className="neural-node nn-6" cx="65" cy="195" r="4" fill="#CC4A15" />
          <circle className="neural-node nn-7" cx="135" cy="185" r="4" fill="#FF6B35" />
        </g>

        {/* Glass highlight */}
        <path 
          d="M58 85 L58 200 Q58 235 75 245" 
          fill="none" 
          stroke="rgba(255, 255, 255, 0.15)"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
      
      {/* Ambient glow behind beaker - orange */}
      <div className="beaker-ambient-glow beaker-ambient-orange" />
    </div>
  );
});

BeakerLogo.displayName = 'BeakerLogo';

export default BeakerLogo;

